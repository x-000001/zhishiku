/**
 * AI 请求的纯逻辑：拼请求、读流式响应、超时控制、把各种故障翻成中文。
 * 网络通过注入的 fetcher 走（真实实现是主进程的 net.fetch），单测里换成假的，
 * 不启动 Electron、不真联网。渲染层永远拿不到 Key，也永远不直接发请求。
 */
import {
  AI_ACTION_LABELS,
  clampAiText,
  type AiAction,
  type AiRelatedItem,
  type AiRunPayload,
  type AiTagSuggestion
} from '../shared/ai';

/** 三道时间闸：等响应头、两次流式分片之间、整个请求。任何一道到点都掐掉，拒绝无限转圈。 */
export interface AiTimeouts {
  headersMs: number;
  idleMs: number;
  totalMs: number;
}

export const AI_TIMEOUTS: AiTimeouts = {
  headersMs: 10_000,
  idleMs: 60_000,
  totalMs: 180_000
};

/** 网络请求的最小抽象：真实实现是主进程的 net.fetch，单测里换成假的。 */
export interface AiHttpResponse {
  status: number;
  ok: boolean;
  body: ReadableStream<Uint8Array> | null;
  text(): Promise<string>;
}

export type AiFetcher = (
  url: string,
  init: {
    method: 'POST';
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  }
) => Promise<AiHttpResponse>;

export interface AiConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
}

export interface AiMessage {
  role: 'system' | 'user';
  content: string;
}

/**
 * 配置类错误的文案前缀。
 * 渲染层靠这几个前缀区分「要去改设置」和「网络/服务出问题」，
 * 不能把所有错误都塞进「连接失败」里（那会让人以为是网络断）。
 */
export const MODEL_NAME_ERROR_PREFIX = '模型名格式错误：';
export const BASE_URL_ERROR_PREFIX = '接口地址格式错误：';
export const AI_CONFIG_MISSING_PREFIX = 'AI 设置不完整：';

/**
 * HTTP 200 但正文是空的时候用的提示。
 * 能走到这里说明地址、Key、网络都通了，问题在模型名/接口结构，别让用户以为是断网。
 */
export const AI_EMPTY_REPLY_MESSAGE = 'AI 接口已连通，但返回了空内容，请检查模型名是否正确';

/**
 * 已经写成中文、能照着处理的错误（配置错 / 接口结构错），
 * 打上标记后不再被 describeAiNetworkError 包一层「AI 请求失败：」，免得误导成网络问题。
 */
function userError(message: string): Error {
  const error = new Error(message);
  error.name = 'AiUserError';
  return error;
}

/** 配置不全时给一句能照着做的提示，而不是 TypeError。 */
export function assertAiConfig(config: AiConfig): AiConfig {
  if (!config.apiKey) throw userError(AI_CONFIG_MISSING_PREFIX + '还没填 API Key，请先到「设置 → AI 模型」里配置');
  if (!config.model) throw userError(AI_CONFIG_MISSING_PREFIX + '还没填模型名，请先到「设置 → AI 模型」里配置');
  if (!config.baseUrl) throw userError(AI_CONFIG_MISSING_PREFIX + '还没填接口地址，请先到「设置 → AI 模型」里配置');
  return config;
}

/**
 * 接口地址规范化：允许用户填 `https://api.openai.com/v1`、结尾带 `/`、
 * 或者直接把完整的 `/chat/completions` 贴进来；统一成可以拼的基址，其他协议一律拒绝。
 */
export function normalizeBaseUrl(raw: string): string {
  const value = String(raw ?? '').trim();
  if (!value) throw userError(BASE_URL_ERROR_PREFIX + '不能为空');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw userError(BASE_URL_ERROR_PREFIX + '不像一个网址，应以 https:// 开头（例如 https://api.openai.com/v1）');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw userError(BASE_URL_ERROR_PREFIX + '只支持 http/https');
  }
  let path = url.pathname.replace(/\/+$/, '');
  path = path.replace(/\/chat\/completions$/i, '');
  const suffix = path ? path : '';
  return url.origin + suffix;
}

/** 拼出真正的对话接口地址。 */
export function chatEndpoint(baseUrl: string): string {
  const base = normalizeBaseUrl(baseUrl);
  return base + '/chat/completions';
}

/**
 * 模型名规范化 + 校验。
 * 只允许：字母、数字、连字符(-)、下划线(_)、点(.)、冒号(:)、斜杠(/)。
 * 常见写法 `deepseek-v4-pro`、`gpt-4o-mini`、`Qwen/Qwen2.5-7B-Instruct`、`deepseek-r1:7b` 都要放行，
 * 拒绝空格/中文/引号/分号等会被拼进请求体搞出花样的字符。
 */
export function normalizeModelName(raw: string): string {
  const value = String(raw ?? '').trim();
  if (!value) {
    throw userError(MODEL_NAME_ERROR_PREFIX + '不能为空，请填服务商给的模型名（例如 deepseek-chat、gpt-4o-mini）');
  }
  if (!/^[A-Za-z0-9._:\-/]+$/.test(value)) {
    // 把第一个不认识的字符点出来：多半是复制粘贴带进来的全角空格/中文逗号，用户自己看不出来
    const offending = value.match(/[^A-Za-z0-9._:\-/]/)?.[0];
    let where = '';
    if (offending !== undefined) {
      where =
        offending === ' '
          ? '，问题出在一个空格上'
          : offending === '\t' || offending === '\n'
            ? '，问题出在换行或制表符上'
            : '，问题出在「' + offending + '」这个字符上';
    }
    throw userError(
      MODEL_NAME_ERROR_PREFIX + '只能包含字母、数字、连字符（-）、下划线（_）、点（.）、冒号（:）和斜杠（/）' + where
    );
  }
  return value;
}

function langLabel(target?: string): string {
  const value = String(target ?? 'auto').trim();
  switch (value) {
    case 'zh-CN':
      return '简体中文';
    case 'en':
      return '英文';
    case 'ja':
      return '日文';
    case 'ko':
      return '韩文';
    case 'fr':
      return '法文';
    case 'de':
      return '德文';
    case 'es':
      return '西班牙文';
    default:
      return 'auto';
  }
}

const SYSTEM_PROMPT =
  '你是一个中文知识库写作助手。你的输出会直接写进用户的笔记，所以：只输出要写进笔记的正文，' +
  '不要解释你在做什么，不要加“好的/以下是”这类开场白，不要用 Markdown 标题。';

/** 全文动作发给模型的正文最多这么多字，避免一篇长文烧掉整月额度。 */
const FULL_TEXT_LIMIT = 8000;

/** 按动作拼出对话消息。标签/联想会额外要求「只输出 JSON」。 */
export function buildMessages(action: AiAction, payload: AiRunPayload): AiMessage[] {
  const messages: AiMessage[] = [{ role: 'system', content: SYSTEM_PROMPT }];
  const text = String(payload.text ?? '').trim();
  const noteText = clampAiText(payload.noteText ?? '', FULL_TEXT_LIMIT);
  const title = String(payload.title ?? '').trim();

  switch (action) {
    case 'polish':
      messages.push({
        role: 'user',
        content:
          '请润色下面这段文字：保持原意、语气自然、别加新内容、别删关键信息。只输出润色后的文字。\n\n' +
          clampAiText(text)
      });
      break;
    case 'expand':
      messages.push({
        role: 'user',
        content:
          '请把下面这段文字扩写到大约原来的 1.5 倍：补充细节和过渡，但不要改变原意，也不要编造事实。只输出扩写后的文字。\n\n' +
          clampAiText(text)
      });
      break;
    case 'shorten':
      messages.push({
        role: 'user',
        content:
          '请把下面这段文字压缩到大约原来的一半：保留关键信息，去掉重复和客套。只输出缩写后的文字。\n\n' +
          clampAiText(text)
      });
      break;
    case 'translate': {
      const target = langLabel(payload.targetLang);
      const instruction =
        target === 'auto'
          ? '请把下面这段文字翻译成另一种常用语言：原文是中文就翻成英文，原文不是中文就翻成简体中文。'
          : `请把下面这段文字翻译成${target}：保留原意和语气，人名、代码、专有名词保持原样。`;
      messages.push({ role: 'user', content: instruction + '只输出译文。\n\n' + clampAiText(text) });
      break;
    }
    case 'summary':
      messages.push({
        role: 'user',
        content:
          '请为下面这篇笔记写一段摘要：100 到 180 字，直接说笔记讲了什么，不要分点、不要评价好坏、不要复述标题。只输出摘要正文。\n\n标题：' +
          (title || '（无）') +
          '\n正文：\n' +
          noteText
      });
      break;
    case 'tags': {
      const tags = (payload.tags ?? []).filter(Boolean).slice(0, 60);
      const categories = (payload.categories ?? []).filter(Boolean).slice(0, 60);
      messages.push({
        role: 'user',
        content:
          '下面是一篇笔记的标题和正文。请推荐 3 到 5 个标签（能复用已有标签就复用），并给出 1 个最合适的分类（只能从已有分类里挑，都不合适就用 null）。\n' +
          '已有标签：' +
          (tags.length ? tags.join('、') : '（无）') +
          '\n已有分类：' +
          (categories.length ? categories.join('、') : '（无）') +
          '\n只输出一个 JSON 对象，不要代码块，不要解释：\n' +
          '{"tags":["标签1","标签2"],"category":"分类名或null","reason":"一句话理由"}\n\n' +
          '标题：' +
          (title || '（无）') +
          '\n正文：\n' +
          noteText
      });
      break;
    }
    case 'related':
      messages.push({
        role: 'user',
        content:
          '请阅读下面这篇笔记，提出 3 个值得继续深入的问题或相关知识点。每条给一个 16 字以内的标题和一句说明。\n' +
          '只输出一个 JSON 对象，不要代码块，不要解释：\n' +
          '{"items":[{"title":"标题","detail":"一句说明"}]}\n\n' +
          '标题：' +
          (title || '（无）') +
          '\n正文：\n' +
          noteText
      });
      break;
    default:
      throw new Error('不认识的 AI 动作：' + String(action));
  }
  return messages;
}

export interface BuiltRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

export interface BuildChatOptions {
  stream: boolean;
  maxTokens?: number;
  temperature?: number;
}

/** 把配置 + 消息拼成一次 POST /chat/completions。 */
export function buildChatRequest(config: AiConfig, messages: AiMessage[], options: BuildChatOptions): BuiltRequest {
  assertAiConfig(config);
  const body = {
    model: normalizeModelName(config.model),
    messages,
    stream: options.stream,
    temperature: options.temperature ?? 0.3,
    max_tokens: options.maxTokens ?? 1024
  };
  return {
    url: chatEndpoint(config.baseUrl),
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + config.apiKey
    },
    body: JSON.stringify(body)
  };
}

/** 从一条 SSE data 里取增量文字；[DONE] 返回 null，表示结束。 */
export function parseSseDataLine(line: string): { done: boolean; delta: string } | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) return null;
  const data = trimmed.slice(5).trim();
  if (!data) return null;
  if (data === '[DONE]') return { done: true, delta: '' };
  try {
    const parsed = JSON.parse(data) as Record<string, unknown>;
    return { done: false, delta: pickDelta(parsed) };
  } catch {
    return null;
  }
}

/** 统一取「内容」字段：标准接口给字符串，个别网关给分段数组。 */
function contentOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  const parts: string[] = [];
  for (const part of value) {
    if (typeof part === 'string') {
      parts.push(part);
      continue;
    }
    if (part && typeof part === 'object') {
      const item = part as Record<string, unknown>;
      const piece = contentOf(item.text) || contentOf(item.content) || contentOf(item.value);
      if (piece) parts.push(piece);
    }
  }
  return parts.join('');
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

function firstChoice(parsed: Record<string, unknown>): Record<string, unknown> | null {
  const choices = parsed.choices;
  if (!Array.isArray(choices) || !choices.length) return null;
  return asRecord(choices[0]) ?? null;
}

/**
 * 流式增量：只认正文（content / text）。
 * 推理模型的 reasoning_content 是「思考过程」，不能当正文塞进编辑器。
 */
function pickDelta(parsed: Record<string, unknown>): string {
  const error = asRecord(parsed.error);
  if (error && typeof error.message === 'string') throw new Error('AI 服务返回错误：' + error.message);
  const first = firstChoice(parsed);
  if (!first) return '';
  const delta = asRecord(first.delta);
  const fromDelta = delta ? contentOf(delta.content) : '';
  if (fromDelta) return fromDelta;
  const message = asRecord(first.message);
  const fromMessage = message ? contentOf(message.content) : '';
  if (fromMessage) return fromMessage;
  return contentOf(first.text);
}

interface ParsedReply {
  content: string;
  reasoning: string;
  finishReason: string;
  errorMessage: string;
}

/**
 * 非流式：不同厂商/网关的返回结构不完全一样，按优先级全部试一遍。
 * 1. choices[0].message.content（OpenAI / DeepSeek 标准）
 * 2. choices[0].delta.content（有的网关把非流式也包成 delta）
 * 3. choices[0].text（补全接口的老写法）
 * 4. content 为空时退到 reasoning_content / reasoning（推理模型只回思考过程）
 */
function pickReply(parsed: Record<string, unknown>): ParsedReply {
  const reply: ParsedReply = { content: '', reasoning: '', finishReason: '', errorMessage: '' };
  const first = firstChoice(parsed);
  if (first) {
    const message = asRecord(first.message);
    const delta = asRecord(first.delta);
    reply.content = message ? contentOf(message.content) : '';
    if (!reply.content && delta) reply.content = contentOf(delta.content);
    if (!reply.content) reply.content = contentOf(first.text);
    const fromMessage = message ? contentOf(message.reasoning_content) || contentOf(message.reasoning) : '';
    const fromDelta = delta ? contentOf(delta.reasoning_content) || contentOf(delta.reasoning) : '';
    reply.reasoning = fromMessage || fromDelta;
    const finish = first.finish_reason ?? first.finishReason;
    reply.finishReason = typeof finish === 'string' ? finish : '';
  }
  const error = asRecord(parsed.error);
  if (error && typeof error.message === 'string') reply.errorMessage = error.message;
  return reply;
}

/**
 * 排查用：把失败的原始响应打到主进程控制台（设置页测试连接失败时最有用）。
 * Key 会被打码，正文截断到 2000 字，既能看清真实 JSON 结构又不至于刷爆日志。
 */
export function logRawAiResponse(label: string, bodyText: string, apiKey = ''): void {
  const safe = redactSecret(String(bodyText ?? ''), apiKey);
  const clipped =
    safe.length > 2000 ? safe.slice(0, 2000) + '…（已截断，原文共 ' + safe.length + ' 字）' : safe;
  console.warn('[AI] ' + label + ' 原始响应（已隐藏 Key）：' + clipped);
}

/** 网关无视 stream:false 仍回 SSE 时，把 data 行里的增量拼成完整正文。 */
function collectSseText(raw: string): string {
  let text = '';
  for (const line of raw.split(/\r?\n/)) {
    const parsed = parseSseDataLine(line);
    if (!parsed) continue;
    if (parsed.done) break;
    text += parsed.delta;
  }
  return text;
}

/** 把 HTTP 状态码翻成用户能照着处理的中文。 */
export function describeAiHttpError(status: number, bodyText = '', apiKey = ''): Error {
  const snippet = redactSecret(String(bodyText ?? '').replace(/\s+/g, ' ').trim(), apiKey).slice(0, 180);
  const tail = snippet ? '（' + snippet + '）' : '';
  switch (status) {
    case 401:
      return userError('API Key 不对或已失效（HTTP 401），请到设置里重新填');
    case 402:
      return userError('账号余额不足（HTTP 402），请先充值或换个 Key');
    case 403:
      return userError('这个 Key 没有调用权限（HTTP 403），请检查 Key 的权限设置');
    case 404:
      return userError('接口地址不对（HTTP 404），Base URL 一般是 https://…/v1 这种结尾');
    case 400:
      return userError('请求被 AI 服务拒绝了（HTTP 400），多半是模型名不对' + tail);
    case 413:
      return userError('发给 AI 的内容太长了（HTTP 413），换一段短的试试');
    case 429:
      return userError('请求太频繁，被 AI 服务限流了（HTTP 429），过一会儿再试');
    default:
      if (status >= 500) return userError('AI 服务端出错了（HTTP ' + status + '），稍后再试' + tail);
      return userError('AI 请求失败（HTTP ' + status + '）' + tail);
  }
}

/** 把网络异常翻成中文；超时在调用方按三道闸分别处理。 */
export function describeAiNetworkError(err: unknown): Error {
  const e = err instanceof Error ? err : new Error(String(err));
  if (e.name === 'AiTimeout' || e.name === 'AiUserError') return e;
  const lower = e.message.toLowerCase();
  if (e.name === 'AbortError' || lower.includes('aborted') || lower.includes('abort')) {
    return new Error('这次请求已经取消');
  }
  if (
    lower.includes('fetch failed') ||
    lower.includes('econnrefused') ||
    lower.includes('enotfound') ||
    lower.includes('eai_again') ||
    lower.includes('etimedout') ||
    lower.includes('network') ||
    lower.includes('certificate') ||
    lower.includes('socket') ||
    lower.includes('proxy') ||
    // Electron 的 net.fetch 失败时抛的是 Chromium 的错误串，不是 Node 的 errno：
    // net::ERR_CONNECTION_REFUSED / ERR_INTERNET_DISCONNECTED / ERR_NAME_NOT_RESOLVED
    lower.includes('net::err_') ||
    lower.includes('connection_refused') ||
    lower.includes('internet_disconnected') ||
    lower.includes('name_not_resolved') ||
    lower.includes('connection_reset') ||
    lower.includes('timed_out')
  ) {
    return new Error('连不上 AI 服务，请检查网络或代理设置（本地功能不受影响）');
  }
  return new Error('AI 请求失败：' + (e.message || '未知错误'));
}

function timeoutError(kind: 'headers' | 'idle' | 'total', timeouts: AiTimeouts): Error {
  const seconds = (ms: number): number => Math.round(ms / 1000);
  const error = new Error(
    kind === 'headers'
      ? `AI 服务 ${seconds(timeouts.headersMs)} 秒没有响应，请检查网络或接口地址`
      : kind === 'idle'
        ? `AI 服务 ${seconds(timeouts.idleMs)} 秒没有新内容，已经停下来（点“继续”可以再试）`
        : `这次 AI 请求超过 ${seconds(timeouts.totalMs)} 秒还没完，已经停下来`
  );
  error.name = 'AiTimeout';
  return error;
}

/** 把可能在报错里出现的 Key 打码，避免日志/弹窗泄露。 */
export function redactSecret(text: string, secret: string): string {
  if (!secret || secret.length < 6) return text;
  return text.split(secret).join(maskAiKey(secret));
}

/** sk-abcdef123456 → sk-…3456 */
export function maskAiKey(key: string): string {
  const value = String(key ?? '').trim();
  if (!value) return '';
  if (value.length <= 8) return '…' + value.slice(-2);
  return value.slice(0, 3) + '…' + value.slice(-4);
}

interface StreamOptions {
  signal?: AbortSignal;
  timeouts?: Partial<AiTimeouts>;
  maxTokens?: number;
  fetcher: AiFetcher;
  config: AiConfig;
  messages: AiMessage[];
  onDelta?: (delta: string) => void;
}

function mergeTimeouts(partial?: Partial<AiTimeouts>): AiTimeouts {
  return { ...AI_TIMEOUTS, ...(partial ?? {}) };
}

/** 读完整流，边读边把增量交给 onDelta，最后返回拼好的全文。 */
export async function streamChat(options: StreamOptions): Promise<string> {
  const timeouts = mergeTimeouts(options.timeouts);
  const request = buildChatRequest(options.config, options.messages, {
    stream: true,
    maxTokens: options.maxTokens
  });
  const controller = new AbortController();
  let abortKind: 'headers' | 'idle' | 'total' | null = null;
  const abortWith = (kind: 'headers' | 'idle' | 'total'): void => {
    if (abortKind) return;
    abortKind = kind;
    controller.abort();
  };
  const onExternalAbort = (): void => controller.abort();
  options.signal?.addEventListener('abort', onExternalAbort, { once: true });

  let headersTimer: ReturnType<typeof setTimeout> | null = setTimeout(
    () => abortWith('headers'),
    timeouts.headersMs
  );
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const totalTimer = setTimeout(() => abortWith('total'), timeouts.totalMs);
  const resetIdle = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => abortWith('idle'), timeouts.idleMs);
  };
  const clearTimers = (): void => {
    if (headersTimer) clearTimeout(headersTimer);
    if (idleTimer) clearTimeout(idleTimer);
    clearTimeout(totalTimer);
    headersTimer = null;
    idleTimer = null;
  };

  let text = '';
  let rawAll = '';
  const decoder = new TextDecoder();
  let buffer = '';

  const handleLine = (line: string): boolean => {
    const parsed = parseSseDataLine(line);
    if (!parsed) return false;
    if (parsed.done) return true;
    if (parsed.delta) {
      text += parsed.delta;
      options.onDelta?.(parsed.delta);
    }
    return false;
  };

  try {
    const response = await options.fetcher(request.url, {
      method: 'POST',
      headers: request.headers,
      body: request.body,
      signal: controller.signal
    });
    if (headersTimer) {
      clearTimeout(headersTimer);
      headersTimer = null;
    }
    if (!response.ok) {
      const bodyText = await safeReadText(response);
      logRawAiResponse('HTTP ' + response.status, bodyText, options.config.apiKey);
      throw describeAiHttpError(response.status, bodyText, options.config.apiKey);
    }
    resetIdle();

    if (!response.body) {
      const bodyText = await safeReadText(response);
      const fromJson = readNonStreamBody(bodyText, options.config.apiKey);
      if (fromJson) options.onDelta?.(fromJson);
      return fromJson;
    }

    const reader = response.body.getReader();
    let finished = false;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      resetIdle();
      const piece = decoder.decode(chunk.value, { stream: true });
      rawAll += piece;
      buffer += piece;
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, '');
        buffer = buffer.slice(index + 1);
        if (handleLine(line)) {
          finished = true;
          break;
        }
        index = buffer.indexOf('\n');
      }
      if (finished) break;
    }
    if (!finished && buffer.trim()) handleLine(buffer);
    // 有的网关会无视 stream:true 直接回整段 JSON：流里没有 data: 行，兜底解析整段
    if (!text && rawAll.trim().startsWith('{')) {
      const fromJson = readNonStreamBody(rawAll);
      if (fromJson) options.onDelta?.(fromJson);
      return fromJson;
    }
    return text;
  } catch (err) {
    if (abortKind) throw timeoutError(abortKind, timeouts);
    if (options.signal?.aborted) throw new Error('已取消');
    throw describeAiNetworkError(err);
  } finally {
    clearTimers();
    options.signal?.removeEventListener('abort', onExternalAbort);
  }
}

/** 非流式：一次请求拿到完整文字（标签/联想/测试连接用）。 */
export async function chatOnce(options: StreamOptions): Promise<string> {
  const timeouts = mergeTimeouts(options.timeouts);
  const request = buildChatRequest(options.config, options.messages, {
    stream: false,
    maxTokens: options.maxTokens
  });
  const controller = new AbortController();
  let abortKind: 'headers' | 'idle' | 'total' | null = null;
  const abortWith = (kind: 'headers' | 'idle' | 'total'): void => {
    if (abortKind) return;
    abortKind = kind;
    controller.abort();
  };
  const onExternalAbort = (): void => controller.abort();
  options.signal?.addEventListener('abort', onExternalAbort, { once: true });
  let headersTimer: ReturnType<typeof setTimeout> | null = setTimeout(
    () => abortWith('headers'),
    timeouts.headersMs
  );
  const totalTimer = setTimeout(() => abortWith('total'), timeouts.totalMs);
  try {
    const response = await options.fetcher(request.url, {
      method: 'POST',
      headers: request.headers,
      body: request.body,
      signal: controller.signal
    });
    if (headersTimer) {
      clearTimeout(headersTimer);
      headersTimer = null;
    }
    if (!response.ok) {
      const bodyText = await safeReadText(response);
      throw describeAiHttpError(response.status, bodyText, options.config.apiKey);
    }
    const bodyText = await safeReadText(response);
    return readNonStreamBody(bodyText, options.config.apiKey);
  } catch (err) {
    if (abortKind) throw timeoutError(abortKind, timeouts);
    if (options.signal?.aborted) throw new Error('已取消');
    throw describeAiNetworkError(err);
  } finally {
    if (headersTimer) clearTimeout(headersTimer);
    clearTimeout(totalTimer);
    options.signal?.removeEventListener('abort', onExternalAbort);
  }
}

async function safeReadText(response: AiHttpResponse): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

/**
 * 非流式响应体 → 正文。
 * 解析失败/空内容都会把原始响应打到控制台（隐去 Key），方便直接看出接口真实结构。
 */
function readNonStreamBody(bodyText: string, apiKey = ''): string {
  const trimmed = String(bodyText ?? '').trim();
  if (!trimmed) {
    logRawAiResponse('非流式（正文为空）', bodyText, apiKey);
    throw userError(AI_EMPTY_REPLY_MESSAGE);
  }
  // 有的网关无视 stream:false，仍然回 data: {...} 的流式格式；拼起来比报「接口不兼容」有用
  if (/^data:/m.test(trimmed)) {
    const joined = collectSseText(trimmed);
    if (joined) return joined;
    logRawAiResponse('非流式（SSE 兜底后仍为空）', bodyText, apiKey);
    throw userError(AI_EMPTY_REPLY_MESSAGE);
  }
  if (!trimmed.startsWith('{')) {
    logRawAiResponse('非流式（不是 JSON）', bodyText, apiKey);
    throw userError('AI 返回的内容不是 JSON，可能接口地址不对（也要确认这个接口支持 OpenAI 兼容格式）');
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    logRawAiResponse('非流式（JSON 解析失败）', bodyText, apiKey);
    throw userError('AI 返回的内容不是有效 JSON，可能接口地址不对');
  }
  const reply = pickReply(parsed);
  if (reply.errorMessage && !reply.content) throw userError('AI 服务返回错误：' + reply.errorMessage);
  const text = reply.content || reply.reasoning;
  if (!text) {
    logRawAiResponse('非流式（解析出来没有文字）', bodyText, apiKey);
    const lengthHint =
      reply.finishReason === 'length' ? '（这一次被长度上限截断了，可以再点一次试试）' : '';
    throw userError(AI_EMPTY_REPLY_MESSAGE + lengthHint);
  }
  if (!reply.content && reply.reasoning) {
    console.warn('[AI] 模型只返回了推理过程（reasoning_content），已当作正文使用');
  }
  return text;
}

/** 动作名给人看的中文（日志/提示用）。 */
export function actionLabel(action: AiAction): string {
  return AI_ACTION_LABELS[action] ?? String(action);
}

/** 全文动作只发普通文字，这里统一收口，防止渲染层误传 HTML。 */
export function plainForAi(text: string): string {
  return clampAiText(text);
}

export type { AiTagSuggestion, AiRelatedItem };
