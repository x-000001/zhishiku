/**
 * 搜索直达（0.12.3）的纯函数层：把"用户在搜索框里敲的词 / AI 返回的引文"
 * 换算成原文里的字符区间。这里不碰 DOM，主进程与渲染层共用，方便单测。
 *
 * 关键约定：所有区间都是**原始字符串**的下标（不是 NFC 归一化后的下标），
 * 见 extractCoreChars 的 map/ends 映射。
 */

/** 一次定位最多返回多少个命中区间：高亮太多反而看不清。 */
export const LOCATE_MAX_SPANS = 12;

/** 核心字符少于这个数时走原始字符串匹配（一个字的 Query 也要能定位）。 */
export const LOCATE_MIN_CORE = 2;

/** 引文完全匹配失败时，退而求其次用前 N 个核心字符。 */
export const LOCATE_PREFIX_CORE = 15;

/** 多词联合匹配允许的最大跨度：超过说明这些词只是碰巧都出现，不算同一处。 */
export const LOCATE_MAX_JOINT_SPAN = 360;

/** AI 定位只回一句引文，上限 120 字，防止模型把整段原文抄回来。 */
export const LOCATE_MAX_QUOTE_CHARS = 120;

/** 发给 AI 的原文窗口大小（以命中词为中心，前后各约一半）。 */
export const LOCATE_WINDOW_RADIUS = 2400;

export interface CoreText {
  /** 只保留字母 / 数字 / 汉字（含其它文字系统），全半角与大小写已折叠 */
  text: string;
  /** text[i] 在原文里的起始下标 */
  map: number[];
  /** text[i] 对应原文那个字符的结束下标（含代理对） */
  ends: number[];
}

export interface LocateSpan {
  /** 原始字符串起始下标（含） */
  start: number;
  /** 原始字符串结束下标（不含） */
  end: number;
}

export interface AroundResult extends LocateSpan {
  text: string;
  /** 是否因为窗口限制被裁过（两侧任意一侧裁过都为 true） */
  truncated: boolean;
}

export interface AiLocateRequest {
  /** 渲染层自增的请求号；取消时按它精准 abort，避免和别的笔记串台 */
  requestId: number;
  /** 用户原始搜索词（可能是多词） */
  query: string;
  /** 已截好的原文窗口 */
  text: string;
}

export interface AiLocateResult {
  /** AI 找到的原文引文；空串表示"没把握 / 找不到" */
  quote: string;
}

export interface LocateMessage {
  role: 'system' | 'user';
  content: string;
}

/** 标点 / 符号 / 空白：定位时全部剥掉，避免 AI 抄回来的中文标点和原文对不上。 */
const CORE_STRIP_RE = /[\p{P}\p{S}\s]/u;

function foldChar(ch: string): string {
  // NFKC 能把全角字母数字折成半角；极少数字符会 1→多，按多字符展开并复用同一个源下标
  const normalized = ch.normalize('NFKC');
  return (normalized.length >= 1 ? normalized : ch).toLowerCase();
}

/**
 * 抽取"核心字符"：去掉全半角标点、符号、空白，大小写折叠。
 * 同时返回 map/ends，调用方可以 100% 无损地映射回原文区间。
 */
export function extractCoreChars(input: string): CoreText {
  const raw = String(input ?? '');
  let text = '';
  const map: number[] = [];
  const ends: number[] = [];
  let index = 0;
  for (const ch of raw) {
    const start = index;
    index += ch.length;
    if (CORE_STRIP_RE.test(ch)) continue;
    const folded = foldChar(ch);
    for (let i = 0; i < folded.length; i += 1) {
      text += folded[i];
      map.push(start);
      ends.push(index);
    }
  }
  return { text, map, ends };
}

/** 把核心字符区间换算成原文区间。 */
function spanFromCore(core: CoreText, start: number, length: number): LocateSpan {
  const endCore = start + length - 1;
  return { start: core.map[start], end: core.ends[endCore] };
}

/** 在核心文本里找出 needle 的全部出现位置（返回核心下标）。 */
function coreHits(haystack: string, needle: string, limit: number): number[] {
  const hits: number[] = [];
  if (!needle) return hits;
  let from = 0;
  while (hits.length < limit) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) break;
    hits.push(at);
    from = at + Math.max(1, needle.length);
  }
  return hits;
}

/** 多词容错：按顺序找到所有词，拼成一段联合区间；找不到 / 跨度过大返回 null。 */
function jointSpan(core: CoreText, tokens: string[]): LocateSpan | null {
  let from = 0;
  let first = -1;
  let last = -1;
  for (const token of tokens) {
    const at = core.text.indexOf(token, from);
    if (at < 0) return null;
    if (first < 0) first = at;
    last = at + token.length - 1;
    from = at + token.length;
  }
  if (first < 0 || last < first) return null;
  const span = spanFromCore(core, first, last - first + 1);
  return span.end - span.start <= LOCATE_MAX_JOINT_SPAN ? span : null;
}

/**
 * 在原文里定位一段引文 / 搜索词，返回原文区间（可能多处）。
 *
 * 匹配顺序：
 * 1. 核心字符完全匹配（剥标点、折叠全半角与大小写）；
 * 2. 多词联合匹配（按空白拆分，顺序出现且跨度合理）；
 * 3. 前 15 个核心字符匹配（AI 引文多抄了一个标点也能命中）。
 *
 * 单字 Query 走原始字符串小写匹配，避免核心字符阈值把它拦住。
 */
export function findQuoteRanges(text: string, quote: string, limit = LOCATE_MAX_SPANS): LocateSpan[] {
  const source = String(text ?? '');
  const target = String(quote ?? '').trim();
  if (!source || !target) return [];
  const core = extractCoreChars(source);
  const targetCore = extractCoreChars(target).text;

  if (targetCore.length < LOCATE_MIN_CORE) {
    const haystack = source.toLowerCase();
    const needle = target.toLowerCase();
    if (!needle) return [];
    const spans: LocateSpan[] = [];
    let from = 0;
    while (spans.length < limit) {
      const at = haystack.indexOf(needle, from);
      if (at < 0) break;
      spans.push({ start: at, end: at + needle.length });
      from = at + Math.max(1, needle.length);
    }
    return spans;
  }

  const exact = coreHits(core.text, targetCore, limit).map((at) => spanFromCore(core, at, targetCore.length));
  if (exact.length) return exact;

  const tokens = target
    .split(/\s+/)
    .map((token) => extractCoreChars(token).text)
    .filter((token) => token.length >= LOCATE_MIN_CORE);
  if (tokens.length > 1) {
    const joint = jointSpan(core, tokens);
    if (joint) return [joint];
  }

  const prefix = targetCore.slice(0, LOCATE_PREFIX_CORE);
  if (prefix.length >= LOCATE_MIN_CORE) {
    return coreHits(core.text, prefix, limit).map((at) => spanFromCore(core, at, prefix.length));
  }
  return [];
}

/**
 * 从原文中间截取一段窗口发给 AI（按"锚点"居中，而不是永远取开头）。
 * 起点/终点会尽量对齐到换行，避免把一行字劈成两半。
 */
export function takeAround(text: string, anchor: string, radius = LOCATE_WINDOW_RADIUS): AroundResult {
  const raw = String(text ?? '');
  const size = Math.max(200, radius) * 2;
  if (raw.length <= size) return { text: raw, start: 0, end: raw.length, truncated: false };

  const core = extractCoreChars(raw);
  const needle = extractCoreChars(String(anchor ?? '')).text;
  const hit = needle ? core.text.indexOf(needle) : -1;
  const center = hit >= 0 ? core.map[hit] : 0;

  let start = Math.max(0, center - Math.floor(size / 2));
  let end = Math.min(raw.length, start + size);
  start = Math.max(0, Math.min(start, raw.length - (end - start)));

  // 向后找换行作为起点（最多让出 200 字，避免窗口缩水太多）
  const lineStart = raw.indexOf('\n', start);
  if (lineStart >= 0 && lineStart - start <= 200) start = lineStart + 1;
  const lineEnd = raw.lastIndexOf('\n', end);
  if (lineEnd > start && end - lineEnd <= 200) end = lineEnd;

  return {
    text: raw.slice(start, end),
    start,
    end,
    truncated: start > 0 || end < raw.length
  };
}

export const LOCATE_SYSTEM_PROMPT =
  '你是中文知识库的检索定位助手。用户会给出一个关键词和一段笔记原文，' +
  '你只负责找出原文里最匹配关键词的**一小句连续原文**（10~40 个字符），要求：' +
  '1) 必须逐字来自给定原文，不要改写、不要补字；' +
  '2) 不要输出解释、不要使用 Markdown；' +
  '3) 只输出一个 JSON 对象：{"quote":"原文片段"}；' +
  '4) 实在找不到就输出 {"quote":""}。';

/** AI 定位请求的 messages（纯函数，方便单测直接断言提示词）。 */
export function buildLocateMessages(query: string, text: string): LocateMessage[] {
  const keyword = String(query ?? '').trim();
  const windowText = String(text ?? '').slice(0, LOCATE_WINDOW_RADIUS * 2);
  return [
    { role: 'system', content: LOCATE_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `关键词：${keyword}\n\n原文窗口：\n${windowText}\n\n请只回 JSON：{"quote":"原文里最匹配的一句话"}`
    }
  ];
}

/** 清洗 AI 返回的引文：剥代码围栏/引号/多余空白，并做长度上限。 */
function cleanQuote(input: string): string {
  return input
    .replace(/```[a-zA-Z]*/g, ' ')
    .replace(/^[\s"'“”‘’「」『』]+|[\s"'“”‘’「」『』]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, LOCATE_MAX_QUOTE_CHARS);
}

/**
 * 解析 AI 定位结果：模型可能裹 ```json、带解释前缀，先用正则抠整个 JSON；
 * 解析失败就丢弃（返回空串），绝不把解释文字当成原文引文。
 */
export function parseLocateQuote(reply: string): string {
  const raw = String(reply ?? '');
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return '';
  try {
    const parsed = JSON.parse(match[0]) as { quote?: unknown };
    const value = parsed && typeof parsed.quote === 'string' ? parsed.quote : '';
    return cleanQuote(value);
  } catch {
    return '';
  }
}
