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
        const messages = buildMessages(input.action, input);
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
