/**
 * AI 辅助功能的共享约定：动作清单、翻译目标语言、配置/结果的形状。
 * 主进程（拼请求、解析流）和渲染层（菜单、弹窗、气泡）都从这里拿同一套名字，
 * 避免两边字符串各写一遍对不上。
 */

/** 划词类动作：只处理选中的一段文字，结果替换回选区。 */
export type AiTextAction = 'polish' | 'expand' | 'shorten' | 'translate';

/** 全文类动作：把整篇笔记发给 AI，结果进弹窗（摘要会插到笔记开头）。 */
export type AiFullAction = 'summary' | 'tags' | 'related';

export type AiAction = AiTextAction | AiFullAction;

export const AI_TEXT_ACTIONS: AiTextAction[] = ['polish', 'expand', 'shorten', 'translate'];
export const AI_FULL_ACTIONS: AiFullAction[] = ['summary', 'tags', 'related'];

/** 界面上显示的动作名，和动作一一对应。 */
export const AI_ACTION_LABELS: Record<AiAction, string> = {
  polish: '润色',
  expand: '扩写',
  shorten: '缩写',
  translate: '翻译',
  summary: '摘要',
  tags: '分类整理',
  related: '知识联想'
};

/** 划词气泡上的动作顺序（翻译单独有语言下拉，放最后）。 */
export const AI_QUICK_ACTIONS: AiTextAction[] = ['polish', 'expand', 'shorten', 'translate'];

/** 翻译的目标语言。auto 表示让模型自己判断：中文→英文，其他→中文。 */
export const AI_TARGET_LANGS = [
  { value: 'auto', label: '自动识别' },
  { value: 'zh-CN', label: '中文' },
  { value: 'en', label: '英文' },
  { value: 'ja', label: '日文' },
  { value: 'ko', label: '韩文' },
  { value: 'fr', label: '法文' },
  { value: 'de', label: '德文' },
  { value: 'es', label: '西班牙文' }
] as const;

export type AiLangValue = (typeof AI_TARGET_LANGS)[number]['value'];

/** 默认目标语言：自动识别。 */
export const AI_DEFAULT_LANG: AiLangValue = 'auto';

/** 摘要插入正文时套的引用块，渲染层和 e2e 都认这个 class。 */
export const AI_SUMMARY_CLASS = 'ai-summary';

/** 一次最多发给 AI 的字符数，太长就截断，防止把整本书塞进去烧钱。 */
export const AI_MAX_INPUT_CHARS = 20000;

/** 单个请求最多让 AI 吐多少 token（按动作给，摘要/标签不用太长）。 */
export function aiMaxTokens(action: AiAction): number {
  switch (action) {
    case 'summary':
      return 700;
    case 'tags':
      return 400;
    case 'related':
      return 800;
    default:
      return 1300;
  }
}

/** 把要发出去的文字掐到上限，顺便去掉首尾空白。 */
export function clampAiText(text: string, max = AI_MAX_INPUT_CHARS): string {
  const value = String(text ?? '').trim();
  return value.length > max ? value.slice(0, max) : value;
}

/** 设置页需要看到的配置形状（永远不带完整 Key）。 */
export interface AiConfigPublic {
  baseUrl: string;
  model: string;
  /** 有没有存过 Key */
  hasKey: boolean;
  /** 打码后的 Key，例如 sk-…a1b2；没配就是空串 */
  keyHint: string;
  /** Key 是不是用系统加密存的（false 说明系统不支持，退成了明文+提示） */
  encrypted: boolean;
  /** 用户有没有确认过「会把内容发给第三方」 */
  privacyAck: boolean;
}

/** 渲染层保存配置时传的补丁：不传的字段保持不变。 */
export interface AiConfigInput {
  baseUrl?: string;
  model?: string;
  /** 空串表示清除已存的 Key */
  apiKey?: string;
  privacyAck?: boolean;
}

/** 发起一次 AI 请求需要的全部输入。 */
export interface AiRunPayload {
  action: AiAction;
  /** 划词动作：选中的那段文字 */
  text?: string;
  /** 全文动作：整篇笔记的纯文字 */
  noteText?: string;
  /** 笔记标题（全文动作用，给模型一点上下文） */
  title?: string;
  /** 翻译目标语言；缺省 auto */
  targetLang?: string;
  /** 笔记已有的标签，让模型优先复用 */
  tags?: string[];
  /** 笔记已有的分类名，让模型从中挑一个 */
  categories?: string[];
}

/** ai:run 的立即回包：真正的文字随后通过 ai:stream 事件推来。 */
export interface AiRunResult {
  requestId: number;
}

/** 主进程推给渲染层的流事件。 */
export type AiStreamEvent =
  | { type: 'chunk'; delta: string }
  | { type: 'done'; text: string }
  | { type: 'error'; message: string };

export type AiStreamEventWithId = AiStreamEvent & { requestId: number };

/** 分类整理的结果：标签建议 + 一个分类建议。 */
export interface AiTagSuggestion {
  tags: string[];
  /** 从已有分类里挑的；都不合适就是 null */
  category: string | null;
  reason: string;
}

/** 知识联想的一条。 */
export interface AiRelatedItem {
  title: string;
  detail: string;
}

/**
 * 从模型回的话里抠出 JSON：模型经常多包一层 ```json 代码块，
 * 或者在前后加一句「好的，这是结果」。这里尽量宽容，抠不出来返回 null。
 */
export function extractAiJson(text: string): Record<string, unknown> | null {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : raw;
  const direct = tryJson(candidate) ?? tryJson(raw);
  if (direct) return direct;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start >= 0 && end > start) return tryJson(candidate.slice(start, end + 1));
  return null;
}

function tryJson(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    return null;
  } catch {
    return null;
  }
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** 解析「分类整理」的 JSON；字段不全就尽量补全，宁可少给也不报错。 */
export function parseTagSuggestion(text: string): AiTagSuggestion {
  const json = extractAiJson(text);
  if (!json) throw new Error('AI 没有返回能看的标签结果，再试一次吧');
  const rawTags = Array.isArray(json.tags) ? json.tags : [];
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const item of rawTags) {
    const name = asText(item).replace(/^#/, '').slice(0, 24);
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    tags.push(name);
    if (tags.length >= 6) break;
  }
  const category = asText(json.category);
  return {
    tags,
    category: category && category !== 'null' ? category.slice(0, 24) : null,
    reason: asText(json.reason).slice(0, 200)
  };
}

/** 解析「知识联想」的 JSON。 */
export function parseRelatedItems(text: string): AiRelatedItem[] {
  const json = extractAiJson(text);
  if (!json) throw new Error('AI 没有返回能看的联想结果，再试一次吧');
  const raw = Array.isArray(json.items) ? json.items : [];
  const items: AiRelatedItem[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const obj = entry as Record<string, unknown>;
    const title = asText(obj.title).slice(0, 40);
    if (!title) continue;
    items.push({ title, detail: asText(obj.detail).slice(0, 300) });
    if (items.length >= 5) break;
  }
  if (!items.length) throw new Error('AI 没有返回能看的联想结果，再试一次吧');
  return items;
}

