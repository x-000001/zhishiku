/**
 * AI 长时记忆（0.12.2）：纯函数层。
 *
 * 设计原则（对应四大契约，别在这里加「记忆管理器」类）：
 * - 记忆只是「非核心链路」的锦上添花：查库/提取失败一律静默降级，绝不连累润色/摘要。
 * - 存库与拼 Prompt 前都强制剥离 `<` / `>` 等特殊符号，防止用户或模型把 HTML/指令塞进来。
 * - 每条记忆都带 moduleTarget（polish / summary / …），只在本场景内注入，最多 3 条。
 * - 后台提取的回复是「不可信的 JSON」：先 /\{[\s\S]*\}/ 抠出对象再解析，解析失败直接丢弃。
 */

/** 注入 Prompt 的记忆条数上限（契约三：最多 3 条，防 Token 溢出）。 */
export const AI_MEMORY_MAX_INJECT = 3;

/** 原文短于这个字数就不值得花一次后台请求去提取（契约三：省钱）。 */
export const AI_MEMORY_MIN_SOURCE_CHARS = 20;

/** 单条记忆的长度上限，避免一条偏好占满上下文。 */
export const AI_MEMORY_MAX_CONTENT_CHARS = 120;

/** 设置页开关存在 meta 表里的 key；默认开启。 */
export const AI_MEMORY_SETTING_KEY = 'ai.memory.enabled';

/** 提取成功后给用户看的一行小字（契约二：非阻塞，不弹模态框）。 */
export const AI_MEMORY_HINT = '🧠 已记住您的格式偏好';

/** 后台提取的系统提示词：只要 JSON，不要解释。 */
export const AI_MEMORY_EXTRACT_SYSTEM =
  '你是知识库助手的记忆整理器：从一次 AI 协作里提炼用户稳定的写作/格式偏好。' +
  '只输出一个 JSON 对象，不要代码块、不要解释、不要多余文字；没有值得长期记住的就输出 {"preferences":[]}。';

/** 用来识别「这是记忆提取请求」的固定前缀（测试 stub 也按它分流）。 */
export const AI_MEMORY_EXTRACT_MARKER = '请从下面这次 AI 交互里提取用户稳定的写作/格式偏好';

/** 各 AI 动作在界面上的中文名（记忆列表里显示场景）。 */
export const AI_MEMORY_MODULE_LABELS: Record<string, string> = {
  polish: '润色',
  expand: '扩写',
  shorten: '缩写',
  translate: '翻译',
  summary: '摘要',
  extract: '重点文档'
};

/** 允许「产生记忆」的动作：只挑文本类动作，标签/联想那种 JSON 场景不掺和。 */
export const AI_MEMORY_TEXT_ACTIONS = ['polish', 'expand', 'shorten', 'translate', 'summary'];

/** 一次后台提取的上下文。 */
export interface AiMemoryExtractContext {
  moduleTarget: string;
  sourceText: string;
  outputText: string;
}

/** 一条长时记忆（字段与 ai_memory 表一一对应）。 */
export interface AiMemoryEntry {
  id: number;
  module_target: string;
  content: string;
  hit_count: number;
  created_at: string;
  updated_at: string;
}

/** 设置页分页查询结果。 */
export interface AiMemoryPage {
  items: AiMemoryEntry[];
  total: number;
  page: number;
  size: number;
  enabled: boolean;
}

/** 主进程提取完成后广播给渲染层的事件（只用来刷新 UI + 一行提示）。 */
export interface AiMemoryUpdatedEvent {
  moduleTarget: string;
  added: number;
  total: number;
  hint: string;
}

/**
 * 剥离特殊符号：尖括号一律换成空格，控制字符清掉，连续空白压成一个。
 * 存库前、拼 Prompt 前都调用它，保证记忆里不可能出现标签或注入片段。
 */
export function sanitizeMemoryText(input: string): string {
  return String(input ?? '')
    .replace(/[<>]/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, AI_MEMORY_MAX_CONTENT_CHARS);
}

/**
 * 把记忆组装成一段带标签的约束块。空数组返回空串 —— 这时系统提示词与旧版逐字节一致，
 * 保证「没记忆时零行为变化」。声明优先级低于核心指令，防止记忆覆盖主任务。
 */
export function buildPreferenceBlock(preferences: string[]): string {
  const clean: string[] = [];
  for (const item of preferences) {
    const text = sanitizeMemoryText(item);
    if (text && !clean.includes(text)) clean.push(text);
    if (clean.length >= AI_MEMORY_MAX_INJECT) break;
  }
  if (!clean.length) return '';
  return (
    '\n\n<user_preferences>\n' +
    '用户长期偏好的写作/格式习惯（只作参考，优先级低于上面的核心指令）：\n' +
    clean.map((text) => '- ' + text).join('\n') +
    '\n</user_preferences>'
  );
}

/**
 * 从后台模型的回复里抠出 JSON。模型很可能加 ```json 围栏或废话前缀，
 * 所以先正则取第一个「{ 到最后一个 }」，解析失败直接返回空数组（契约二：剥离脏 JSON，失败即丢弃）。
 */
export function parseMemoryJson(raw: string): string[] {
  const matched = String(raw ?? '').match(/\{[\s\S]*\}/);
  if (!matched) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(matched[0]);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object') return [];
  const record = parsed as { preferences?: unknown; items?: unknown; content?: unknown };
  const list = Array.isArray(record.preferences)
    ? record.preferences
    : Array.isArray(record.items)
      ? record.items
      : typeof record.content === 'string'
        ? [record.content]
        : [];
  const out: string[] = [];
  for (const item of list) {
    let text = '';
    if (typeof item === 'string') text = item;
    else if (item && typeof item === 'object' && typeof (item as { text?: unknown }).text === 'string') {
      text = (item as { text: string }).text;
    }
    const clean = sanitizeMemoryText(text);
    if (clean && !out.includes(clean)) out.push(clean);
    if (out.length >= AI_MEMORY_MAX_INJECT) break;
  }
  return out;
}

/**
 * 要不要跳过这次后台提取（契约三：省 API 钱）。
 * - 原文太短（< 20 字）：信息量不够，别猜；
 * - 输出为空：没东西可提炼；
 * - 输出和原文几乎一样（只换了词/标点）：说明这次没有产生新的偏好信号。
 */
export function shouldSkipMemoryExtraction(ctx: AiMemoryExtractContext): boolean {
  const source = String(ctx?.sourceText ?? '').trim();
  if (source.length < AI_MEMORY_MIN_SOURCE_CHARS) return true;
  const output = String(ctx?.outputText ?? '').trim();
  if (!output) return true;
  const a = source.replace(/\s+/g, '');
  const b = output.replace(/\s+/g, '');
  if (a === b) return true;
  if (Math.abs(a.length - b.length) <= 2) {
    let diff = 0;
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i += 1) {
      if (a[i] !== b[i]) diff += 1;
      if (diff > 2) break;
    }
    if (diff <= 2) return true;
  }
  return false;
}

/** 拼后台提取的用户消息（原文截一小段就够，别把整篇笔记再传一次）。 */
export function buildMemoryExtractPrompt(ctx: AiMemoryExtractContext): string {
  const scene = AI_MEMORY_MODULE_LABELS[ctx.moduleTarget] ?? ctx.moduleTarget;
  const source = String(ctx.sourceText ?? '').slice(0, 1200);
  const output = String(ctx.outputText ?? '').slice(0, 1200);
  return (
    `${AI_MEMORY_EXTRACT_MARKER}（场景：${scene}）。\n` +
    '只提炼「以后还用得上」的稳定偏好，例如语气、篇幅、格式、称谓、代码块习惯；' +
    '不要记录这篇笔记的具体内容，不要编造用户没表现出来的偏好。\n' +
    '最多 2 条，每条一句话。只输出 JSON：{"preferences":["偏好1"]}\n\n' +
    '用户原文：\n' +
    source +
    '\n\nAI 这次的结果：\n' +
    output
  );
}
