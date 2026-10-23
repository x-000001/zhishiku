/**
 * 「AI 提取笔记重点并整理成文档」的共享纯函数。
 *
 * 主进程用这些规则拼 Prompt、校验 AI 结果、清洗标题、拼正文 HTML；渲染层用同一套
 * 截断与校验来显示提示。放在 shared 里是为了让 vitest 直接测，不用起 Electron。
 */
import { escapeHtml } from './html';
import { renderMarkdown } from './markdown';

/** 送给 AI 的纯文本上限（按 JS 码元计）。 */
export const EXTRACT_MAX_CHARS = 8000;
/** 超长截断时弹窗顶部的提示文案。 */
export const EXTRACT_TRUNCATED_HINT = '⚠️ 原文过长，已截取前 8000 字';
/** 新笔记正文末尾溯源块的 class，样式与 e2e 都依赖它。 */
export const EXTRACT_SOURCE_CLASS = 'ai-extract-source';
/** Prompt 的固定开头，同时是 e2e stub 识别 extract 动作的关键词。 */
export const EXTRACT_PROMPT_MARKER = '请把下面这篇笔记提炼成一份结构化的重点文档';
/** 标题最长字符数，防止 AI 把整段话当标题。 */
export const EXTRACT_TITLE_MAX = 80;

/**
 * extract 专用的系统提示词。
 * 不能复用 main/ai.ts 的 SYSTEM_PROMPT：那个明确要求「不要用 Markdown 标题」，
 * 而整理文档恰恰需要小标题，否则正文层级全丢。
 */
export const EXTRACT_SYSTEM_PROMPT = [
  '你是一个中文知识库编辑助手。你的任务是把用户给的一篇笔记提炼成一份结构化的重点文档。',
  '必须遵守：',
  '1. 第一行只输出纯文本标题：不要 #、*、反引号、引号，也不要「标题：」前缀。',
  '2. 严禁开场白（例如「好的」「以下是」），严禁把整篇文档包进代码块，严禁结尾客套话。',
  '3. 只能依据原文提炼，严禁脑补原文没有的事实、数字或结论；原文信息不足就写得短一点。',
  '4. 标题之后用 Markdown 小标题、列表、表格、代码块组织内容，原文有的表格和代码要保留。',
  '5. 直接输出文档本身，不要解释你做了什么。'
].join('\n');

/** 纯文本超长时按最近的换行截断；没有换行就硬截断，但绝不把 emoji 代理对劈开。 */
export function truncateForExtraction(
  raw: string,
  max = EXTRACT_MAX_CHARS
): { text: string; truncated: boolean } {
  const normalized = String(raw ?? '').replace(/\r\n?/g, '\n');
  if (normalized.length <= max) return { text: normalized, truncated: false };
  const head = normalized.slice(0, max);
  const lastBreak = head.lastIndexOf('\n');
  let kept = lastBreak > 0 ? head.slice(0, lastBreak) : head;
  const tailCode = kept.charCodeAt(kept.length - 1);
  if (tailCode >= 0xd800 && tailCode <= 0xdbff) kept = kept.slice(0, -1);
  return { text: kept.replace(/\s+$/, ''), truncated: true };
}

/** 拼给模型的 user 消息：四条硬性要求 + 标题 + 已截断的原文。 */
export function buildExtractPrompt(title: string, text: string): string {
  return [
    `${EXTRACT_PROMPT_MARKER}，输出 Markdown 文档。`,
    '',
    '硬性要求：',
    '1. 第一行只写纯文本标题：不要 #、*、反引号、引号或「标题：」前缀。',
    '2. 直接从标题开始，严禁任何开场白（例如「好的」「以下是」），严禁用代码块包裹整篇文档，严禁结尾客套话。',
    '3. 只能依据下面这篇笔记的原文提炼，严禁脑补原文里没有的事实、数字或结论；原文信息不足就写短一点。',
    '4. 标题之后可以用 Markdown 小标题和列表组织；原文有表格、代码、步骤就保留下来。',
    '',
    `笔记标题：${title.trim() || '（无标题）'}`,
    '',
    '笔记原文：',
    text
  ].join('\n');
}

/** 去掉模型偶尔包在整篇文档外面的代码围栏。 */
function stripOuterCodeFence(text: string): string {
  const match = text.match(/^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```$/);
  return match ? match[1].trim() : text;
}

/**
 * 清洗标题：去掉 Markdown 标题符、列表符、数字前缀、强调符和包裹引号。
 * 标题行取第一行非空文本；清洗后为空则用 fallback。
 */
export function normalizeExtractTitle(raw: string, fallback = '未命名笔记'): string {
  const lines = String(raw ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n');
  const first = lines.find((line) => line.trim().length > 0) ?? '';
  let title = first
    .trim()
    .replace(/^#+\s*/, '')
    .replace(/^[-*+]\s+/, '')
    .replace(/^\d+[.)、]\s*/, '')
    .replace(/[*_`~#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  title = title.replace(/^["'“”‘’]+/, '').replace(/["'“”‘’]+$/, '').trim();
  if (!title) title = String(fallback ?? '').trim() || '未命名笔记';
  return title.slice(0, EXTRACT_TITLE_MAX);
}

/** 与现有标题集合比对，重名时追加 " (2)"、" (3)"，绝不覆盖已有笔记。 */
export function uniqueExtractTitle(title: string, existing: string[]): string {
  const taken = new Set(existing.map((item) => String(item ?? '').trim()));
  const base = title.trim() || '未命名笔记';
  if (!taken.has(base)) return base;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base} (${index})`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base} (${taken.size + 1})`;
}

export interface ExtractedDoc {
  title: string;
  body: string;
}

/** 把模型输出拆成「首行标题 + 其余正文」；整篇被代码围栏包住时先剥掉围栏。 */
export function splitExtractionOutput(
  markdown: string,
  fallbackTitle = '未命名笔记'
): ExtractedDoc {
  const raw = stripOuterCodeFence(
    String(markdown ?? '')
      .replace(/\r\n?/g, '\n')
      .trim()
  );
  const lines = raw.split('\n');
  const titleIndex = lines.findIndex((line) => line.trim().length > 0);
  if (titleIndex < 0) return { title: normalizeExtractTitle('', fallbackTitle), body: '' };
  const title = normalizeExtractTitle(lines[titleIndex], fallbackTitle);
  const body = lines.slice(titleIndex + 1).join('\n').trim();
  return { title, body };
}

/**
 * 校验 AI 结果：空串/纯空白/只有标点符号都视为无效，返回中文错误；有效返回 null。
 * 渲染层拦截保存、主进程 handler 再拦一次，双保险保证「空结果绝不落库」。
 */
export function extractResultError(text: string): string | null {
  const value = String(text ?? '').trim();
  if (!value) return 'AI 没有返回内容（可能是网络中断或模型限流），本次不会保存。';
  if (!/[\p{L}\p{N}]/u.test(value)) return 'AI 返回的内容里没有有效文字，本次不会保存。';
  return null;
}

/** 正文转 HTML（表格/代码/列表都走 renderMarkdown），末尾追加可追溯的引用块。 */
export function buildExtractHtml(body: string, sourceTitle: string): string {
  const rendered = body.trim() ? renderMarkdown(body) : '';
  const source = escapeHtml(sourceTitle.trim() || '未命名笔记');
  return `${rendered}<blockquote class="${EXTRACT_SOURCE_CLASS}">本文由《${source}》经 AI 提炼生成。</blockquote>`;
}
