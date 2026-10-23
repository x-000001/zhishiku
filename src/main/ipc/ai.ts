import { BrowserWindow, net, safeStorage } from 'electron';
import * as db from '../db';
import {
  AI_MAX_INPUT_CHARS,
  aiMaxTokens,
  type AiConfigInput,
  type AiConfigPublic,
  type AiRunPayload,
  type AiStreamEventWithId
} from '../../shared/ai';
import {
  AI_CHAT_MAX_TOKENS,
  buildAiChatMessages,
  type AiChatRequest,
  type AiChatStreamEvent
} from '../../shared/ai-chat';
import {
  assertAiConfig,
  buildMemoryExtractionMessages,
  buildMessages,
  chatOnce,
  maskAiKey,
  normalizeBaseUrl,
  normalizeModelName,
  streamChat,
  type AiConfig,
  type AiFetcher,
  type AiMessage
} from '../ai';
import {
  AI_MEMORY_HINT,
  AI_MEMORY_MAX_INJECT,
  AI_MEMORY_TEXT_ACTIONS,
  parseMemoryJson,
  shouldSkipMemoryExtraction,
  type AiMemoryExtractContext,
  type AiMemoryUpdatedEvent
} from '../../shared/ai-memory';
import {
  buildLocateMessages,
  parseLocateQuote,
  type AiLocateRequest,
  type AiLocateResult
} from '../../shared/locate';
import type { Handle } from './common';

/**
 * AI 功能的 Electron 接线层：Key 的存取/加密、请求调度、流事件广播都在这里。
 * 渲染层只拿到「有没有配 Key / 打码后的 Key」，永远拿不到明文 Key，
 * 也永远不会自己去请求外部地址。
 */

const KEY_BASE_URL = 'ai.baseUrl';
const KEY_MODEL = 'ai.model';
const KEY_API_KEY = 'ai.apiKey';
const KEY_API_KEY_ENC = 'ai.apiKeyEnc';
const KEY_PRIVACY_ACK = 'ai.privacyAck';

function encryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

function readApiKey(): string {
  const stored = db.getSetting(KEY_API_KEY) ?? '';
  if (!stored) return '';
  const encrypted = (db.getSetting(KEY_API_KEY_ENC) ?? '0') === '1';
  if (!encrypted) return stored;
  try {
    return safeStorage.decryptString(Buffer.from(stored, 'base64'));
  } catch {
    // 换机器/换系统用户后旧密文解不开，当成没配，让用户重填，别让整个功能崩
    return '';
  }
}

function writeApiKey(plain: string): void {
  const value = String(plain ?? '').trim();
  if (!value) {
    db.setSetting(KEY_API_KEY, '');
    db.setSetting(KEY_API_KEY_ENC, '0');
    return;
  }
  if (encryptionAvailable()) {
    db.setSetting(KEY_API_KEY, safeStorage.encryptString(value).toString('base64'));
    db.setSetting(KEY_API_KEY_ENC, '1');
  } else {
    // 系统不支持加密存储时退成明文，设置页会显示提示，让用户自己决定要不要填
    db.setSetting(KEY_API_KEY, value);
    db.setSetting(KEY_API_KEY_ENC, '0');
  }
}

function readConfig(): AiConfig {
  return {
    baseUrl: db.getSetting(KEY_BASE_URL) ?? '',
    model: db.getSetting(KEY_MODEL) ?? '',
    apiKey: readApiKey()
  };
}

function publicConfig(): AiConfigPublic {
  const config = readConfig();
  return {
    baseUrl: config.baseUrl,
    model: config.model,
    hasKey: Boolean(config.apiKey),
    keyHint: maskAiKey(config.apiKey),
    encrypted: Boolean(config.apiKey) ? (db.getSetting(KEY_API_KEY_ENC) ?? '0') === '1' : encryptionAvailable(),
    privacyAck: (db.getSetting(KEY_PRIVACY_ACK) ?? '0') === '1'
  };
}

/** 真实网络实现：走 Electron 的 net（尊重系统代理），并且交给调用方掐时间。 */
const netFetcher: AiFetcher = async (url, init) => {
  const response = await net.fetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
    signal: init.signal
  });
  return {
    status: response.status,
    ok: response.ok,
    body: response.body as ReadableStream<Uint8Array> | null,
    text: () => response.text()
  };
};

interface Job {
  controller: AbortController;
}

const jobs = new Map<number, Job>();
let nextRequestId = 1;

/* 0.12.3 搜索直达：定位请求是"可取消的一次性短请求"，单独一张表；
   渲染层切换笔记 / 发起新搜索时会立刻 ai:locate:cancel，防止旧结果串台。 */
const locateJobs = new Map<number, AbortController>();

/**
 * 0.12.1「整理成重点文档」的单任务活跃锁：这是重请求，同一时刻只允许一个，
 * 防止连点/重复点把额度刷爆。按 requestId 归属，生成结束（含失败/取消）在 finally 释放。
 */
let extractJobRequestId: number | null = null;

function broadcast(event: AiStreamEventWithId): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('ai:stream', event);
  }
}

/* ---------------- 0.12.0 阶段4：AI 对话（独立请求域，不与划词共用） ----------------
   chatJobs 与 jobs 是两张表：聊天用自己的 requestId 命名空间、自己的 AbortController，
   推事件走 ai:chat:stream（另一个通道）。划词那边取消不影响聊天，反之亦然。 */
const chatJobs = new Map<number, Job>();

function broadcastChat(event: AiChatStreamEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('ai:chat:stream', event);
  }
}

/* ---------------- 0.12.2：AI 长时记忆（非核心链路，全程静默降级） ----------------
   两条铁律：
   1. 读记忆失败/超时 = 不注入，主流程照常跑；
   2. 后台提取排在用户请求结束之后的防抖队列里，绝不和润色/摘要并发抢额度。
   这里没有 MemoryManager 类：就是本文件里的几个函数 + db.ts 里的几条 SQL。 */

const AI_MEMORY_BUDGET_MS = 80;
const AI_MEMORY_DEBOUNCE_MS = 1500;
const AI_MEMORY_RETRY_MS = 1200;

let memoryTimer: ReturnType<typeof setTimeout> | null = null;
let memoryPending: AiMemoryExtractContext | null = null;
let memoryBusy = false;

function broadcastMemory(event: AiMemoryUpdatedEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('ai:memory:updated', event);
  }
}

function memorySourceOf(input: AiRunPayload): string {
  return String(input.noteText ?? input.text ?? '');
}

/**
 * 注入用：按当前动作查最多 3 条记忆。任何异常（表不存在 / 库忙 / 超预算）
 * 都静默降级为不注入 —— 记忆是锦上添花，不能把润色/摘要带崩。
 */
function loadPreferencesSafely(moduleTarget: string): string[] {
  try {
    if (!db.aiMemoryEnabled()) return [];
    if (!AI_MEMORY_TEXT_ACTIONS.includes(moduleTarget)) return [];
    const startedAt = Date.now();
    const rows = db.listAiMemory(moduleTarget, AI_MEMORY_MAX_INJECT);
    if (Date.now() - startedAt > AI_MEMORY_BUDGET_MS) {
      // SQLite 是同步调用，这里主要是防极端卡顿：宁可这次不注入，也不拖慢主请求。
      console.warn('[AI] 长时记忆查询超过 ' + AI_MEMORY_BUDGET_MS + 'ms，本次跳过注入');
      return [];
    }
    return rows.map((row) => row.content);
  } catch (err) {
    console.warn(
      '[AI] 读取长时记忆失败，本次不注入（不影响主流程）：',
      err instanceof Error ? err.message : String(err)
    );
    return [];
  }
}

function armMemoryTimer(delay: number): void {
  if (memoryTimer) clearTimeout(memoryTimer);
  memoryTimer = setTimeout(() => {
    memoryTimer = null;
    void runPendingMemoryExtraction();
  }, delay);
  // 后台任务不阻止应用退出
  memoryTimer.unref?.();
}

/** 请求结束后安排一次「空闲时提取」：先本地拦截，再防抖。 */
function scheduleMemoryExtraction(input: AiRunPayload, outputText: string): void {
  try {
    if (!db.aiMemoryEnabled()) return;
    if (!AI_MEMORY_TEXT_ACTIONS.includes(input.action)) return;
    const ctx: AiMemoryExtractContext = {
      moduleTarget: input.action,
      sourceText: memorySourceOf(input),
      outputText
    };
    // 契约三：< 20 字 / 只是换了个词 → 直接跳过，省一次 API 钱。
    if (shouldSkipMemoryExtraction(ctx)) return;
    memoryPending = ctx;
    armMemoryTimer(AI_MEMORY_DEBOUNCE_MS);
  } catch (err) {
    console.warn('[AI] 安排长时记忆提取失败（已忽略）：', err instanceof Error ? err.message : String(err));
  }
}

/** 真正发后台提取请求：用户空闲、没有别的 AI 任务时才跑。 */
async function runPendingMemoryExtraction(): Promise<void> {
  if (memoryBusy) {
    armMemoryTimer(AI_MEMORY_RETRY_MS);
    return;
  }
  // 错峰：用户主动的润色/摘要/对话还在跑时，后台提取往后排队。
  if (jobs.size > 0 || chatJobs.size > 0) {
    armMemoryTimer(AI_MEMORY_RETRY_MS);
    return;
  }
  const ctx = memoryPending;
  if (!ctx) return;
  memoryPending = null;
  memoryBusy = true;
  try {
    const config = assertAiConfig(readConfig());
    const reply = await chatOnce({
      fetcher: netFetcher,
      config,
      messages: buildMemoryExtractionMessages(ctx),
      maxTokens: 300,
      timeouts: { headersMs: 5000, idleMs: 8000, totalMs: 15_000 }
    });
    // 契约二：模型回复可能裹 ```json 或废话，先抠 JSON；解析失败就丢，不报错。
    const preferences = parseMemoryJson(reply);
    if (!preferences.length) return;
    const added = db.addAiMemory(ctx.moduleTarget, preferences);
    broadcastMemory({
      moduleTarget: ctx.moduleTarget,
      added,
      total: db.aiMemoryCount(),
      hint: AI_MEMORY_HINT
    });
  } catch (err) {
    // 契约一：提取失败只打日志，用户完全无感。
    console.warn(
      '[AI] 后台提取长时记忆失败（已静默忽略）：',
      err instanceof Error ? err.message : String(err)
    );
  } finally {
    memoryBusy = false;
    if (memoryPending) armMemoryTimer(AI_MEMORY_RETRY_MS);
  }
}

export function registerAi(handle: Handle): void {
  handle('ai:config:get', () => publicConfig());

  handle('ai:config:set', (payload: AiConfigInput) => {
    const input = payload ?? {};
    if (typeof input.baseUrl === 'string') {
      const next = input.baseUrl.trim();
      // 空串 = 清空；非空必须先过规范化，避免存进一个拼不出 URL 的字符串
      db.setSetting(KEY_BASE_URL, next ? normalizeBaseUrl(next) : '');
    }
    if (typeof input.model === 'string') {
      const next = input.model.trim();
      // 空串 = 清空；非空同样先校验，模型名格式错误别等到点「测试连接」才报
      db.setSetting(KEY_MODEL, next ? normalizeModelName(next) : '');
    }
    if (typeof input.apiKey === 'string') writeApiKey(input.apiKey);
    if (typeof input.privacyAck === 'boolean') db.setSetting(KEY_PRIVACY_ACK, input.privacyAck ? '1' : '0');
    return publicConfig();
  });

  handle('ai:config:test', async () => {
    const config = assertAiConfig(readConfig());
    // 非流式（stream:false）+ 够用的 max_tokens：
    // 推理模型（如 deepseek-v4-pro / deepseek-reasoner）先产 reasoning 再产 content，
    // 16 个 token 会被推理过程吃光、正文为空，看起来就像「接口不兼容」。
    const text = await chatOnce({
      fetcher: netFetcher,
      config,
      messages: [{ role: 'user', content: '请只回复两个字：可用' }],
      maxTokens: 200,
      timeouts: { headersMs: 10_000, idleMs: 20_000, totalMs: 40_000 }
    });
    return { ok: true as const, model: config.model, reply: text.trim().slice(0, 60) };
  });

  handle('ai:run', async (payload: AiRunPayload) => {
    const input = payload ?? ({} as AiRunPayload);
    const config = assertAiConfig(readConfig());
    const noteText = String(input.noteText ?? '');
    const text = String(input.text ?? '');
    if (
      input.action === 'summary' ||
      input.action === 'tags' ||
      input.action === 'related' ||
      input.action === 'extract'
    ) {
      if (!noteText.trim()) throw new Error('这篇笔记还是空的，先写点内容再让 AI 帮忙');
    } else if (!text.trim()) {
      throw new Error('没有选中任何文字');
    }
    if (noteText.length > AI_MAX_INPUT_CHARS) {
      throw new Error('这篇笔记太长了，先拆成几篇再让 AI 读');
    }
    // 提炼成文档是重操作：上一单没结束就直接拒绝，别让两个请求同时写库/烧额度。
    if (input.action === 'extract' && extractJobRequestId != null) {
      throw new Error('上一轮「整理成重点文档」还没结束，等它完成或先停止再试。');
    }

    const requestId = nextRequestId;
    nextRequestId += 1;
    const controller = new AbortController();
    jobs.set(requestId, { controller });
    if (input.action === 'extract') extractJobRequestId = requestId;

    void (async (): Promise<void> => {
      try {
        const messages = buildMessages(input.action, input, loadPreferencesSafely(input.action));
        // 标签/联想要的是完整 JSON，流式没意义；其余动作边生成边推，界面有打字机效果
        const streaming = input.action !== 'tags' && input.action !== 'related';
        if (streaming) {
          const result = await streamChat({
            fetcher: netFetcher,
            config,
            messages,
            signal: controller.signal,
            maxTokens: aiMaxTokens(input.action),
            onDelta: (delta) => broadcast({ requestId, type: 'chunk', delta })
          });
          broadcast({ requestId, type: 'done', text: result });
          // 主请求已经结束，才开始「空闲时静默提取偏好」，绝不和它并发抢额度。
          scheduleMemoryExtraction(input, result);
        } else {
          const result = await chatOnce({
            fetcher: netFetcher,
            config,
            messages,
            signal: controller.signal,
            maxTokens: input.action === 'tags' ? 400 : 800
          });
          broadcast({ requestId, type: 'done', text: result });
        }
      } catch (err) {
        const message = controller.signal.aborted
          ? '已取消'
          : err instanceof Error
            ? err.message
            : 'AI 请求失败了，再试一次吧';
        broadcast({ requestId, type: 'error', message });
      } finally {
        jobs.delete(requestId);
        if (input.action === 'extract' && extractJobRequestId === requestId) {
          extractJobRequestId = null;
        }
      }
    })();

    return { requestId };
  });

  handle('ai:cancel', (payload: { requestId?: number }) => {
    const id = Number(payload?.requestId ?? 0);
    const job = jobs.get(id);
    if (!job) return false;
    job.controller.abort();
    return true;
  });

  /* ---------------- 0.12.3：搜索直达（AI 纠偏）----------------
     本地 Query 已经先高亮过一遍，这一步只是"如果 AI 更准就替换"：
     短超时（总 8s）+ 可取消 + 出错静默降级，绝不阻塞用户看笔记。 */
  handle('ai:locate', async (payload: AiLocateRequest) => {
    const input = payload ?? ({} as AiLocateRequest);
    const requestId = Number(input.requestId ?? 0);
    const query = String(input.query ?? '').trim();
    const text = String(input.text ?? '').trim();
    if (!query) throw new Error('没有要定位的关键词');
    if (!text) return { quote: '' } as AiLocateResult;
    const config = assertAiConfig(readConfig());
    const controller = new AbortController();
    if (Number.isFinite(requestId) && requestId > 0) locateJobs.set(requestId, controller);
    try {
      const reply = await chatOnce({
        fetcher: netFetcher,
        config,
        messages: buildLocateMessages(query, text),
        signal: controller.signal,
        maxTokens: 160,
        timeouts: { headersMs: 4000, idleMs: 6000, totalMs: 8000 }
      });
      return { quote: parseLocateQuote(reply) } as AiLocateResult;
    } finally {
      if (locateJobs.get(requestId) === controller) locateJobs.delete(requestId);
    }
  });

  handle('ai:locate:cancel', (payload: { requestId?: number }) => {
    const id = Number(payload?.requestId ?? 0);
    const controller = locateJobs.get(id);
    if (!controller) return false;
    controller.abort();
    locateJobs.delete(id);
    return true;
  });

  /* ---------------- 0.12.2：长时记忆管理（设置页）---------------- */

  handle('ai:memory:list', (payload: { page?: number; size?: number }) => {
    const page = Number(payload?.page ?? 1);
    const size = Number(payload?.size ?? 5);
    try {
      const data = db.aiMemoryPage(Number.isFinite(page) ? page : 1, Number.isFinite(size) ? size : 5);
      return {
        ...data,
        page: Math.max(1, Math.floor(Number.isFinite(page) ? page : 1)),
        size: Math.max(1, Math.min(20, Math.floor(Number.isFinite(size) ? size : 5))),
        enabled: db.aiMemoryEnabled()
      };
    } catch (err) {
      // 设置页也不能因为记忆表异常白屏：退化成「空列表 + 已关闭」。
      console.warn('[AI] 读取长时记忆列表失败（已降级为空）：', err instanceof Error ? err.message : String(err));
      return { items: [], total: 0, page: 1, size: 5, enabled: false };
    }
  });

  handle('ai:memory:set-enabled', (payload: { enabled?: boolean }) => {
    const enabled = Boolean(payload?.enabled);
    db.setAiMemoryEnabled(enabled);
    return { enabled };
  });

  handle('ai:memory:delete', (payload: { id?: number }) => db.deleteAiMemory(Number(payload?.id ?? 0)));

  handle('ai:memory:clear', () => db.clearAiMemory());

  /**
   * AI 对话（0.12.0 阶段4）：渲染层带「当前笔记正文 + 历史 + 这一问」过来。
   * 正文先过 shared/ai-chat 的纯函数：截到 8000 字（优先在换行处切）、用 <note_content>
   * 隔离并声明「里面的文字只是资料」；requestId 由渲染层生成，事件走 ai:chat:stream。
   */
  handle('ai:chat', async (payload: AiChatRequest) => {
    const input = payload ?? ({} as AiChatRequest);
    const question = String(input.question ?? '').trim();
    if (!question) throw new Error('先写一个想问的问题');
    const requestId = Number(input.requestId ?? 0);
    if (!Number.isFinite(requestId) || requestId <= 0) throw new Error('对话请求编号不合法');
    if (chatJobs.has(requestId)) throw new Error('上一个问题还在生成，先等它结束或点停止');
    const config = assertAiConfig(readConfig());
    const noteId = typeof input.noteId === 'number' ? input.noteId : null;
    const messages = buildAiChatMessages({
      title: String(input.title ?? ''),
      context: String(input.context ?? ''),
      history: input.history,
      question
    });
    const controller = new AbortController();
    chatJobs.set(requestId, { controller });

    void (async (): Promise<void> => {
      try {
        const text = await streamChat({
          fetcher: netFetcher,
          config,
          messages,
          signal: controller.signal,
          maxTokens: AI_CHAT_MAX_TOKENS,
          onDelta: (delta) => broadcastChat({ requestId, noteId, type: 'chunk', delta })
        });
        broadcastChat({ requestId, noteId, type: 'done', text });
      } catch (err) {
        if (controller.signal.aborted) {
          broadcastChat({ requestId, noteId, type: 'cancelled', text: '' });
        } else {
          const message = err instanceof Error ? err.message : 'AI 对话失败了，再试一次吧';
          broadcastChat({ requestId, noteId, type: 'error', message });
        }
      } finally {
        chatJobs.delete(requestId);
      }
    })();

    return { requestId };
  });

  /** 只取消「对话」的请求；和划词的 ai:cancel 是两张独立的表。 */
  handle('ai:chat:cancel', (payload: { requestId?: number }) => {
    const id = Number(payload?.requestId ?? 0);
    const job = chatJobs.get(id);
    if (!job) return false;
    job.controller.abort();
    return true;
  });
}

/**
 * 供 GitHub 项目提炼复用：拿一份已校验的 AI 配置（缺 Key 时抛中文错误）。
 * 单测不会走到这里（单测直接测 repo-extract 的纯函数），所以不抽得更细。
 */
export function aiConfigOrThrow(): AiConfig {
  return assertAiConfig(readConfig());
}

/** 供 GitHub 项目提炼复用：一次性非流式调用（静默，不广播流事件）。 */
export async function aiChatOnce(messages: AiMessage[], maxTokens: number): Promise<string> {
  return chatOnce({
    fetcher: netFetcher,
    config: aiConfigOrThrow(),
    messages,
    maxTokens,
    timeouts: { headersMs: 10_000, idleMs: 25_000, totalMs: 60_000 }
  });
}
