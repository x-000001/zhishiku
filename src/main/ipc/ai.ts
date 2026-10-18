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
  assertAiConfig,
  buildMessages,
  chatOnce,
  maskAiKey,
  normalizeBaseUrl,
  normalizeModelName,
  streamChat,
  type AiConfig,
  type AiFetcher
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

function broadcast(event: AiStreamEventWithId): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('ai:stream', event);
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
    const text = await chatOnce({
      fetcher: netFetcher,
      config,
      messages: [{ role: 'user', content: '请只回复两个字：可用' }],
      maxTokens: 16,
      timeouts: { headersMs: 10_000, idleMs: 20_000, totalMs: 40_000 }
    });
    return { ok: true as const, model: config.model, reply: text.slice(0, 60) };
  });

  handle('ai:run', async (payload: AiRunPayload) => {
    const input = payload ?? ({} as AiRunPayload);
    const config = assertAiConfig(readConfig());
    const noteText = String(input.noteText ?? '');
    const text = String(input.text ?? '');
    if (input.action === 'summary' || input.action === 'tags' || input.action === 'related') {
      if (!noteText.trim()) throw new Error('这篇笔记还是空的，先写点内容再让 AI 帮忙');
    } else if (!text.trim()) {
      throw new Error('没有选中任何文字');
    }
    if (noteText.length > AI_MAX_INPUT_CHARS) {
      throw new Error('这篇笔记太长了，先拆成几篇再让 AI 读');
    }

    const requestId = nextRequestId;
    nextRequestId += 1;
    const controller = new AbortController();
    jobs.set(requestId, { controller });

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
}
