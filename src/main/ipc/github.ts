/**
 * GitHub 集成的 IPC 层：认证（Device Flow）、配置、同步编排。
 *
 * 红线（DEVELOPER_GUIDE.md）：
 * - ADR-3：Token 只在主进程出现，用 safeStorage 加密后进 meta 表；渲染层只看打码信息。
 * - ADR-4：所有网络请求走主进程 `net.fetch`（这里是唯一实现）。
 * - ADR-6：通道注册集中在 ipc/index.ts，事件通道要登记 preload 白名单。
 */
import { net, safeStorage, shell, BrowserWindow } from 'electron';
import {
  GITHUB_AUTH_TIMEOUT_MS,
  GITHUB_DEFAULT_API_BASE,
  GITHUB_DEFAULT_CLIENT_ID,
  GITHUB_DEFAULT_OAUTH_BASE,
  GITHUB_PROGRESS_CHANNEL,
  GITHUB_SYNC_PAGE_SIZE,
  formatSyncProgress,
  githubIssueKey,
  normalizeRepoName,
  parseRepoList,
  type GithubDeviceCode,
  type GithubRepoMeta,
  type GithubStatus,
  type GithubSyncProgress,
  type GithubSyncResult
} from '../../shared/github';
import * as db from '../db';
import {
  GithubError,
  describeGithubError,
  fetchAuthenticatedUser,
  fetchRepoIssues,
  pollAccessToken,
  requestDeviceCode,
  type GithubFetcher,
  type GithubIssue
} from '../github';
import { syncGithubIssues } from '../github-sync';
import type { Handle } from './common';

const KEY_TOKEN_ENC = 'github.tokenEnc';
const KEY_TOKEN_PLAIN = 'github.token';
const KEY_LOGIN = 'github.login';
const KEY_AVATAR = 'github.avatar';
const KEY_REPOS = 'github.repos';
const KEY_CLIENT_ID = 'github.clientId';
const KEY_LAST_SYNC = 'github.lastSyncAt';

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

function repos(): string[] {
  return parseRepoList(db.getSetting(KEY_REPOS) || '');
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
    repos: repos(),
    lastSyncAt: db.getSetting(KEY_LAST_SYNC) || null,
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

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

function emitProgress(progress: GithubSyncProgress): void {
  broadcast(GITHUB_PROGRESS_CHANNEL, progress);
}

// ---------------------------------------------------------------- 同步锁

let isSyncing = false;

async function runSync(): Promise<GithubSyncResult> {
  if (isSyncing) throw new Error('同步正在进行中，请稍候');
  const token = readToken();
  if (!token) throw new Error('还没连接 GitHub：请到设置页点「连接 GitHub」');
  const list = repos();
  if (list.length === 0) throw new Error('还没配置仓库：请到设置页填 owner/repo');

  isSyncing = true;
  const startedAt = new Date().toISOString();
  let lastProgress: GithubSyncProgress = {
    phase: 'start',
    repoIndex: 0,
    repoTotal: list.length,
    repo: null,
    fetched: 0
  };
  emitProgress(lastProgress);
  try {
    const result = await syncGithubIssues(
      {
        fetchIssues: async (repo, since) => {
          const client = { fetcher: netFetcher, token, apiBase: apiBase(), timeoutMs: 25_000 };
          return fetchRepoIssues(client, {
            repo,
            since,
            perPage: GITHUB_SYNC_PAGE_SIZE,
            onPage: (info) => {
              lastProgress = {
                phase: 'repo',
                repoIndex: lastProgress.repoIndex,
                repoTotal: list.length,
                repo,
                fetched: info.fetched
              };
              emitProgress(lastProgress);
            }
          });
        },
        getMeta: (repo) => db.githubRepoMeta(repo),
        transaction: (fn) => db.runInTransaction(fn),
        upsertTask: (issue: GithubIssue, repo: string) => db.upsertGithubTask(issue, repo),
        saveMeta: (repo, patch) => db.saveGithubRepoMeta(repo, patch),
        now: () => new Date(),
        onProgress: (progress) => {
          lastProgress = progress;
          emitProgress(progress);
        }
      },
      list
    );

    if (result.succeeded > 0) {
      db.setSetting(KEY_LAST_SYNC, new Date().toISOString());
    } else if (result.failed.length > 0 && result.failed.every((f) => f.kind === 'unauthorized')) {
      // 所有仓库都是 401：Token 已经不认了，通知前端回设置页重新连接（保留本地任务）。
      throw new GithubError('unauthorized', 'GitHub 授权已失效（HTTP 401），请重新连接 GitHub', 401);
    }
    emitProgress({ phase: 'done', repoIndex: list.length, repoTotal: list.length, repo: null, fetched: 0 });
    return result;
  } finally {
    isSyncing = false;
    void startedAt;
  }
}

// ---------------------------------------------------------------- 注册

export function registerGithub(handle: Handle): void {
  handle('github:status', () => githubStatus());

  handle('github:config:set', (payload: { repos?: string[] | string; clientId?: string }) => {
    if (payload.repos !== undefined) {
      const list = parseRepoList(payload.repos);
      db.setSetting(KEY_REPOS, list.join('\n'));
    }
    if (payload.clientId !== undefined) {
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
    // 本地任务保留：单向同步的语义是「断开连接，不回删已经落下来的待办」。
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
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com') {
      throw new Error('只能打开 github.com 的链接');
    }
    await shell.openExternal(url);
    return true;
  });

  handle('github:sync', async (): Promise<GithubSyncResult> => {
    try {
      return await runSync();
    } catch (err) {
      if (err instanceof GithubError) {
        const wrapped = new Error(err.message);
        (wrapped as Error & { kind?: string }).kind = err.kind;
        throw wrapped;
      }
      throw err;
    }
  });

  handle('github:repos', () => db.githubRepoMetaAll());
}

/** 预留给单测/排障：把当前进度文案打出来。 */
export function describeProgress(progress: GithubSyncProgress): string {
  return formatSyncProgress(progress);
}

/** 供后续版本清理：把某仓库的同步游标重置（下拉刷新语义）。 */
export function resetRepoCursor(repo: string): GithubRepoMeta {
  const clean = normalizeRepoName(repo);
  db.saveGithubRepoMeta(clean, { lastSyncedAt: null, lastError: null });
  return db.githubRepoMeta(clean) ?? { repo: clean, lastSyncedAt: null, lastError: null };
}

/** 导出给单测用：从 issue 生成唯一键。 */
export { githubIssueKey };
