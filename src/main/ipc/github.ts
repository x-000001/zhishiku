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
import { net, safeStorage, shell, type BrowserWindow } from 'electron';
import {
  GITHUB_DEFAULT_API_BASE,
  GITHUB_DEFAULT_CLIENT_ID,
  GITHUB_DEFAULT_OAUTH_BASE,
  GITHUB_DEVICE_POLL_TIMEOUT_MS,
  GITHUB_MAX_EXTRACT_JOBS,
  formatImportResult,
  parseRepoUrl,
  type GithubAuthCode,
  type GithubAuthEvent,
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
import { authFailureEvent, deviceCodeDeadline, maskSecret } from '../github-auth';
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
    try {
      db.setSetting(KEY_TOKEN_ENC, safeStorage.encryptString(token).toString('base64'));
      return true;
    } catch (err) {
      // 系统加密偶尔会抽风（比如钥匙串没解锁）：降级成明文，也不能让授权流程直接崩。
      logAuth('系统加密失败，Token 改为明文保存：', describeGithubError(err));
    }
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
      // 换了电脑/换了系统用户，旧的 DPAPI 密文解不开：清掉 Token，静默回到未连接，绝不闪退。
      logAuth('旧 Token 解密失败（可能换了电脑），已自动清空，按未连接处理');
      clearToken();
      return '';
    }
  }
  return db.getSetting(KEY_TOKEN_PLAIN) || '';
}

export function maskToken(token: string): string | null {
  return maskSecret(token);
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

/** 主进程里的唯一授权会话（同一时间只允许一个，防并发轮询）。 */
interface AuthSession {
  deviceCode: string;
  interval: number;
  /** 绝对截止时间：收到设备码响应那一刻 + expires_in。 */
  expiresAt: number;
  controller: AbortController;
  polling: boolean;
}

let authSession: AuthSession | null = null;
/** 设置页所在的窗口：授权事件与启动恢复都推给它。 */
let authWindow: BrowserWindow | null = null;

/** 日志统一前缀；Token/设备码只允许打码后出现。 */
function logAuth(...args: unknown[]): void {
  console.log('[GitHub 授权]', ...args);
}

function pushAuthEvent(event: GithubAuthEvent): void {
  const win = authWindow;
  if (!win || win.isDestroyed()) return;
  win.webContents.send('github:auth', event);
}

/**
 * 窗口创建后登记（由 src/main/index.ts 调用）。
 *
 * 顺手做「启动自动恢复登录态」：页面加载完推一次当前状态，渲染层不用额外等待；
 * 加密数据解不开时 githubStatus() 内部已经静默清空并按未连接返回，不会白屏。
 */
export function attachGithubWindow(win: BrowserWindow | null): void {
  authWindow = win;
  if (!win) return;
  win.webContents.on('did-finish-load', () => {
    const status = githubStatus();
    logAuth(
      status.connected
        ? `启动恢复：已读到加密 Token（${status.tokenHint ?? ''}），登录态 @${status.login ?? '未知用户'}`
        : '启动恢复：没有已保存的 Token，按未连接处理'
    );
    pushAuthEvent({ type: 'authorized', status });
  });
}

/** app.whenReady 时调用：读一遍 meta 表恢复登录态（失败只记日志，不影响启动）。 */
export function restoreGithubLoginState(): void {
  try {
    const status = githubStatus();
    logAuth(status.connected ? `登录态可恢复：@${status.login ?? '未知用户'}` : '当前未连接 GitHub');
  } catch (err) {
    logAuth('恢复登录态失败（已忽略，不影响启动）：', describeGithubError(err));
    clearToken();
  }
}

/** 取消当前会话：清内存 + abort 网络请求（sleep 里的定时器随 abort 一起销毁）。 */
function cancelPendingAuth(): void {
  const session = authSession;
  authSession = null;
  if (!session) return;
  try {
    session.controller.abort();
  } catch {
    /* 忽略 */
  }
  logAuth('已中止当前授权会话：轮询与网络请求一起取消');
}

/**
 * 发起授权：拿设备码 → 立刻把验证码推给渲染层 → 主进程自己在后台轮询。
 *
 * 这样渲染层点完按钮马上就能看到验证码（不阻塞），浏览器里授权完成后又能立刻收到结果事件。
 */
async function startAuth(): Promise<GithubAuthCode> {
  if (authSession?.polling) throw new Error('授权正在进行中，请等待当前验证码过期或取消');
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
  // 有效期以「收到响应的瞬间」为基准，而不是发起请求时。
  const expiresAt = deviceCodeDeadline(Date.now(), code.expiresIn);
  const session: AuthSession = {
    deviceCode: code.deviceCode,
    interval: code.interval,
    expiresAt,
    controller,
    polling: true
  };
  authSession = session;
  const publicCode: GithubAuthCode = {
    userCode: code.userCode,
    verificationUri: code.verificationUri,
    interval: code.interval,
    expiresAt
  };
  logAuth(
    `设备码已获取：${code.userCode}（有效期约 ${Math.max(1, Math.round((expiresAt - Date.now()) / 1000))} 秒），开始轮询`
  );
  pushAuthEvent({ type: 'code', code: publicCode });
  void runPollLoop(session);
  return publicCode;
}

/** 后台轮询直到成功 / 过期 / 拒绝；整个过程不占用渲染层的任何调用。 */
async function runPollLoop(session: AuthSession): Promise<void> {
  const clientId = clientIdOf();
  try {
    const token = await pollAccessToken({
      fetcher: netFetcher,
      oauthBase: oauthBase(),
      clientId: clientId.value,
      deviceCode: session.deviceCode,
      interval: session.interval,
      deadline: session.expiresAt,
      signal: session.controller.signal,
      timeoutMs: GITHUB_DEVICE_POLL_TIMEOUT_MS
    });
    logAuth(`Token 到手（已打码：${maskSecret(token)}），正在验证用户`);
    const user = await fetchAuthenticatedUser({
      fetcher: netFetcher,
      token,
      apiBase: apiBase(),
      timeoutMs: 20_000
    });
    logAuth(`验证用户成功：@${user.login}`);
    writeToken(token);
    db.setSetting(KEY_LOGIN, user.login);
    db.setSetting(KEY_AVATAR, user.avatarUrl || '');
    logAuth(`Token 已加密入库（${githubStatus().encrypted ? 'DPAPI' : '未加密'}），通知前端：已连接`);
    pushAuthEvent({ type: 'authorized', status: githubStatus() });
  } catch (err) {
    // 用户取消 / 登出 / 新会话会先把 authSession 换掉：这种情况不再打扰前端。
    if (authSession !== session) return;
    const event = authFailureEvent(err);
    if (event) {
      logAuth('授权失败：', event.type === 'error' ? event.message : event.type);
      pushAuthEvent(event);
    }
  } finally {
    session.polling = false;
    if (authSession === session) authSession = null;
  }
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

  // 0.11.0：发起授权后主进程自己后台轮询，渲染层只等 `github:auth` 事件；
  // 轮询中再发起会抛「授权正在进行中」，防止开多个会话互相踩。
  handle('github:request-code', () => startAuth());

  handle('github:cancel-auth', () => {
    cancelPendingAuth();
    return true;
  });

  handle('github:logout', () => {
    cancelPendingAuth();
    clearToken();
    logAuth('已登出：数据库里的 Token/用户名已清空，内存会话与定时器已清理');
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
