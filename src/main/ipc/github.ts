/**
 * GitHub 集成的 IPC 层：认证（Device Flow）+ 「收集箱导入开源项目」编排。
 *
 * 红线（DEVELOPER_GUIDE.md）：
 * - ADR-3：Token 只在主进程出现，用 safeStorage 加密后进 meta 表；渲染层只看打码信息。
 * - ADR-4：所有网络请求走主进程 `net.fetch`（这里是唯一实现）。
 * - ADR-6：通道注册集中在 ipc/index.ts，事件通道要登记 preload 白名单。
 *
 * 和 0.10.0 的区别：不再同步 Issues 到待办，而是「一个仓库 → 一条收集箱条目 + AI 提炼」。
 */
import { net, safeStorage, shell } from 'electron';
import {
  GITHUB_AUTH_TIMEOUT_MS,
  GITHUB_DEFAULT_API_BASE,
  GITHUB_DEFAULT_CLIENT_ID,
  GITHUB_DEFAULT_OAUTH_BASE,
  GITHUB_MAX_EXTRACT_JOBS,
  formatImportResult,
  parseRepoUrl,
  type GithubDeviceCode,
  type GithubRepoInfo,
  type GithubStatus,
  type RepoConvertInput,
  type RepoImportInput
} from '../../shared/github';
import * as db from '../db';
import {
  describeGithubError,
  fetchAuthenticatedUser,
  fetchRepoInfo,
  pollAccessToken,
  requestDeviceCode,
  type GithubFetcher
} from '../github';
import { aiChatOnce } from './ai';
import {
  RepoExtractLimiter,
  buildLinkOnlyNote,
  extractRepoNote,
  renderRepoNoteHtml,
  type RepoExtractDeps
} from '../repo-extract';
import type { Handle } from './common';

const KEY_TOKEN_ENC = 'github.tokenEnc';
const KEY_TOKEN_PLAIN = 'github.token';
const KEY_LOGIN = 'github.login';
const KEY_AVATAR = 'github.avatar';
const KEY_CLIENT_ID = 'github.clientId';

// ---------------------------------------------------------------- 环境与网络

function apiBase(): string {
  return (process.env.JWKB_GITHUB_API_BASE || GITHUB_DEFAULT_API_BASE).replace(/\/+$/, '');
}

function oauthBase(): string {
  return (process.env.JWKB_GITHUB_OAUTH_BASE || GITHUB_DEFAULT_OAUTH_BASE).replace(/\/+$/, '');
}

function clientIdOf(): { value: string; source: 'env' | 'setting' | 'none' } {
  const env = (process.env.JWKB_GITHUB_CLIENT_ID || '').trim();
  if (env) return { value: env, source: 'env' };
  const saved = (db.getSetting(KEY_CLIENT_ID) || '').trim();
  if (saved) return { value: saved, source: 'setting' };
  return { value: GITHUB_DEFAULT_CLIENT_ID, source: 'none' };
}

/** electron net.fetch → 客户端要求的响应形状（只取用得到的字段）。 */
const netFetcher: GithubFetcher = async (url, init) => {
  const res = await net.fetch(url, {
    method: init.method ?? 'GET',
    headers: init.headers,
    body: init.body,
    signal: init.signal
  });
  return {
    status: res.status,
    ok: res.ok,
    headers: { get: (name: string) => res.headers.get(name) },
    text: () => res.text()
  };
};

/** 主进程里唯一的并发闸：同时最多 2 个 AI 提炼（超出直接中文报错）。 */
const extractLimiter = new RepoExtractLimiter(GITHUB_MAX_EXTRACT_JOBS);

// ---------------------------------------------------------------- Token 存取

function writeToken(token: string): boolean {
  db.setSetting(KEY_TOKEN_ENC, '');
  db.setSetting(KEY_TOKEN_PLAIN, '');
  if (!token) return false;
  if (safeStorage.isEncryptionAvailable()) {
    db.setSetting(KEY_TOKEN_ENC, safeStorage.encryptString(token).toString('base64'));
    return true;
  }
  // 没法加密时退化成明文（设置页会明确提示「未加密」）——与 AI Key 的做法一致。
  db.setSetting(KEY_TOKEN_PLAIN, token);
  return false;
}

function readToken(): string {
  const encrypted = db.getSetting(KEY_TOKEN_ENC);
  if (encrypted) {
    try {
      return safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
    } catch {
      return '';
    }
  }
  return db.getSetting(KEY_TOKEN_PLAIN) || '';
}

export function maskToken(token: string): string | null {
  if (!token) return null;
  if (token.length <= 8) return '…';
  return `${token.slice(0, 3)}…${token.slice(-4)}`;
}

function clearToken(): void {
  db.setSetting(KEY_TOKEN_ENC, '');
  db.setSetting(KEY_TOKEN_PLAIN, '');
  db.setSetting(KEY_LOGIN, '');
  db.setSetting(KEY_AVATAR, '');
}

export function githubStatus(): GithubStatus {
  const token = readToken();
  const clientId = clientIdOf();
  return {
    connected: Boolean(token),
    login: db.getSetting(KEY_LOGIN) || null,
    avatarUrl: db.getSetting(KEY_AVATAR) || null,
    tokenHint: maskToken(token),
    encrypted: Boolean(db.getSetting(KEY_TOKEN_ENC)),
    clientId: clientId.source === 'none' ? null : clientId.value,
    clientIdSource: clientId.source
  };
}

// ---------------------------------------------------------------- 授权会话

interface PendingAuth {
  deviceCode: string;
  interval: number;
  expiresIn: number;
  controller: AbortController;
}

let pendingAuth: PendingAuth | null = null;

function cancelPendingAuth(): void {
  if (!pendingAuth) return;
  try {
    pendingAuth.controller.abort();
  } catch {
    /* 忽略 */
  }
  pendingAuth = null;
}

// ---------------------------------------------------------------- 拉取 + 提炼

/**
 * 拉一个仓库的元信息与 README。公开仓库不带 Token 也能拉（但限流很低），
 * 所以「仅保存链接」在未授权时也能用；Token 失效（401）会如实报错。
 */
async function loadRepoInfo(url: string): Promise<GithubRepoInfo> {
  return fetchRepoInfo(
    {
      fetcher: netFetcher,
      token: readToken(),
      apiBase: apiBase(),
      timeoutMs: 25_000
    },
    { url }
  );
}

function extractDeps(): RepoExtractDeps {
  return {
    chat: (messages, options) => aiChatOnce(messages, options.maxTokens)
  };
}

/** 把一个条目替换成「AI 提炼后的内容」，返回给前端的统一形状。 */
async function runExtract(url: string): Promise<{ repo: string; status: 'done' | 'ai_failed'; items: ReturnType<typeof buildLinkOnlyNote> }> {
  const info = await loadRepoInfo(url);
  const outcome = await extractRepoNote(extractDeps(), info);
  return {
    repo: info.repo,
    status: outcome.status === 'done' ? 'done' : 'ai_failed',
    items: outcome
  };
}

// ---------------------------------------------------------------- 注册

export function registerGithub(handle: Handle): void {
  handle('github:status', () => githubStatus());

  handle('github:config:set', (payload: { clientId?: string }) => {
    if (payload?.clientId !== undefined) {
      db.setSetting(KEY_CLIENT_ID, String(payload.clientId ?? '').trim());
    }
    return githubStatus();
  });

  handle('github:request-code', async (): Promise<GithubDeviceCode> => {
    const clientId = clientIdOf();
    if (clientId.source === 'none') {
      throw new Error(
        '还没配置 GitHub OAuth App 的 Client ID：让开发者用 JWKB_GITHUB_CLIENT_ID 启动，或在这里填写'
      );
    }
    cancelPendingAuth();
    const controller = new AbortController();
    const code = await requestDeviceCode({
      fetcher: netFetcher,
      oauthBase: oauthBase(),
      clientId: clientId.value,
      signal: controller.signal,
      timeoutMs: 20_000
    });
    pendingAuth = {
      deviceCode: code.deviceCode,
      interval: code.interval,
      expiresIn: code.expiresIn,
      controller
    };
    return code;
  });

  handle('github:poll-token', async (): Promise<GithubStatus> => {
    const pending = pendingAuth;
    if (!pending) throw new Error('这次授权已经结束，请重新点「连接 GitHub」');
    const clientId = clientIdOf();
    try {
      const token = await pollAccessToken({
        fetcher: netFetcher,
        oauthBase: oauthBase(),
        clientId: clientId.value,
        deviceCode: pending.deviceCode,
        interval: pending.interval,
        expiresIn: pending.expiresIn,
        signal: pending.controller.signal,
        maxWaitMs: GITHUB_AUTH_TIMEOUT_MS
      });
      const user = await fetchAuthenticatedUser({
        fetcher: netFetcher,
        token,
        apiBase: apiBase(),
        timeoutMs: 20_000
      });
      writeToken(token);
      db.setSetting(KEY_LOGIN, user.login);
      db.setSetting(KEY_AVATAR, user.avatarUrl || '');
      pendingAuth = null;
      return githubStatus();
    } catch (err) {
      pendingAuth = null;
      throw new Error(describeGithubError(err));
    }
  });

  handle('github:cancel-auth', () => {
    cancelPendingAuth();
    return true;
  });

  handle('github:logout', () => {
    cancelPendingAuth();
    clearToken();
    // 收集箱里已经导入的条目保留：断开的是授权，不是本地数据。
    return githubStatus();
  });

  handle('github:open-url', async (payload: { url: string }) => {
    const url = String(payload?.url ?? '');
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error('这个链接不合法');
    }
    if (parsed.protocol !== 'https:' || (parsed.hostname !== 'github.com' && parsed.hostname !== 'www.github.com')) {
      throw new Error('只能打开 github.com 的链接');
    }
    await shell.openExternal(url);
    return true;
  });

  /** 导入一个 GitHub 项目到收集箱：仅保存链接 / 保存并 AI 提炼。 */
  handle('github:import', async (payload: RepoImportInput) => {
    const url = String(payload?.url ?? '');
    const repo = parseRepoUrl(url); // 严格清洗：非法地址这里就抛中文错误
    if (!payload?.extract) {
      const info = await loadRepoInfo(repo);
      const outcome = buildLinkOnlyNote(info);
      const itemId = db.addGithubInbox({
        content: outcome.markdown,
        repo: info.repo,
        url: info.htmlUrl,
        stars: info.stars,
        language: info.language,
        status: 'link_only',
        meta: outcome.meta
      });
      return { itemId, repo: info.repo, status: 'link_only' as const, warning: null };
    }

    const release = extractLimiter.acquire(); // 满了直接抛「请等待当前任务完成」
    try {
      const { repo: cleanRepo, status, items } = await runExtract(repo);
      const itemId = db.addGithubInbox({
        content: items.markdown,
        repo: cleanRepo,
        url: `https://github.com/${cleanRepo}`,
        stars: items.meta.stars ?? 0,
        language: items.meta.language ?? null,
        status,
        meta: items.meta
      });
      return {
        itemId,
        repo: cleanRepo,
        status,
        warning: status === 'ai_failed' ? (items.meta.error ?? 'AI 提炼失败') : null
      };
    } finally {
      release();
    }
  });

  /** 重试提炼（卡片上的「重试提炼」按钮）。 */
  handle('github:retry-extract', async (payload: { itemId: number }) => {
    const item = db.inboxItem(Number(payload?.itemId ?? 0));
    if (!item) throw new Error('这条收集箱条目已经不在了');
    if (item.kind !== 'github') throw new Error('这条不是 GitHub 项目，不能提炼');
    const url = item.github_url || item.github_repo;
    if (!url) throw new Error('这条条目没有保存仓库地址，删掉重新导入吧');
    if (item.extract_status === 'done') {
      return { itemId: item.id, repo: item.github_repo ?? '', status: 'done' as const, warning: null };
    }
    const release = extractLimiter.acquire();
    try {
      const { repo: cleanRepo, status, items } = await runExtract(url);
      db.updateGithubInboxExtract(item.id, {
        content: items.markdown,
        status,
        meta: items.meta
      });
      return {
        itemId: item.id,
        repo: cleanRepo,
        status,
        warning: status === 'ai_failed' ? (items.meta.error ?? 'AI 提炼失败') : null
      };
    } finally {
      release();
    }
  });

  /** 转成知识库笔记：内容里 YAML 原文完整进 content（plain），富文本只做展示。 */
  handle('github:convert-note', (payload: RepoConvertInput) => {
    const id = Number(payload?.itemId ?? 0);
    const item = db.inboxItem(id);
    if (!item) throw new Error('这条收集箱条目已经不在了');
    if (item.kind !== 'github') throw new Error('这条不是 GitHub 项目，不能用这个按钮转笔记');
    const title = (item.github_repo || 'GitHub 项目').trim();
    const noteId = db.createNote({
      categoryId: payload?.categoryId ?? null,
      title,
      plain: item.content,
      html: renderRepoNoteHtml(item.content)
    });
    db.setInboxStatus(item.id, 'processed', `note:${noteId}`);
    return { noteId };
  });
}

/** 给设置页/排障用：导入结果文案（避免前端各处重复拼）。 */
export function describeImport(repo: string, status: 'done' | 'ai_failed' | 'link_only', warning: string | null): string {
  return formatImportResult({ repo, status, warning });
}
