/**
 * GitHub API 客户端（纯逻辑：不 import electron，所有网络能力由 GithubFetcher 注入）。
 *
 * 为什么这样拆：DEVELOPER_GUIDE.md 的 ADR-4 要求「网络只在主进程」，而单测要能
 * 在 Node 里跑、不真联网。所以这里只依赖一个 fetch 形状的函数，electron 侧用
 * `net.fetch` 实现（见 ipc/github.ts），测试侧用假响应。
 *
 * 错误一律抛 GithubError，带 kind，渲染层据此决定「回设置页重新授权」还是「提示限流」。
 */
import {
  GITHUB_API_VERSION,
  GITHUB_AUTH_ERRORS,
  GITHUB_DEFAULT_CLIENT_ID,
  GITHUB_DEFAULT_OAUTH_BASE,
  GITHUB_DEFAULT_SCOPE,
  GITHUB_README_LIMIT,
  GITHUB_REQUEST_TIMEOUT_MS,
  GITHUB_USER_AGENT,
  parseRepoUrl,
  splitRepo,
  type GithubDeviceCode,
  type GithubErrorKind,
  type GithubRepoInfo
} from '../shared/github';

// ---------------------------------------------------------------- 错误

export class GithubError extends Error {
  readonly kind: GithubErrorKind;
  readonly status?: number;

  constructor(kind: GithubErrorKind, message: string, status?: number) {
    super(message);
    this.name = 'GithubError';
    this.kind = kind;
    if (status !== undefined) this.status = status;
  }
}

/** 把任意异常转成给用户看的中文（IPC 层统一走这里）。 */
export function describeGithubError(err: unknown): string {
  if (err instanceof GithubError) return err.message;
  if (err instanceof Error) return err.message || 'GitHub 请求失败';
  return 'GitHub 请求失败（未知原因）';
}

export function githubErrorKind(err: unknown): GithubErrorKind | undefined {
  return err instanceof GithubError ? err.kind : undefined;
}

// ---------------------------------------------------------------- 网络抽象

export interface GithubResponse {
  status: number;
  ok: boolean;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export interface GithubRequestInit {
  method?: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

/** 主进程注入的真实实现用 electron `net.fetch`；单测注入假函数。 */
export type GithubFetcher = (url: string, init: GithubRequestInit) => Promise<GithubResponse>;

export interface GithubClient {
  fetcher: GithubFetcher;
  token: string;
  apiBase?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

// ---------------------------------------------------------------- 内部工具

const TIMEOUT_MESSAGE = (ms: number): string =>
  `GitHub 请求超时（${Math.max(1, Math.round(ms / 1000))} 秒没有响应），请检查网络后重试`;

function looksLikeNetworkError(err: unknown): boolean {
  const text = err instanceof Error ? `${err.name} ${err.message}` : String(err);
  return /ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|socket hang up|fetch failed|Failed to fetch|net::ERR|internet_disconnected|name_not_resolved|connection_refused/i.test(
    text
  );
}

interface SignalBundle {
  signal: AbortSignal;
  timedOut: () => boolean;
  cleanup: () => void;
}

/** 外部取消 + 本地超时合成一个 signal，并保证定时器被清掉（单测不留 handle）。 */
function linkSignal(external: AbortSignal | undefined, timeoutMs: number): SignalBundle {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  if (timer && typeof timer.unref === 'function') timer.unref();
  const onAbort = (): void => controller.abort();
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup: () => {
      clearTimeout(timer);
      external?.removeEventListener('abort', onAbort);
    }
  };
}

function apiBaseOf(client: GithubClient): string {
  return (client.apiBase || 'https://api.github.com').replace(/\/+$/, '');
}

function authHeaders(token: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
    'User-Agent': GITHUB_USER_AGENT
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function trimBody(text: string, max = 160): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

/** 403 的两种含义：限流（可恢复）vs 无权限（要换 Token/仓库）。 */
function rateLimitMessage(res: GithubResponse, bodyText: string): string | null {
  const remaining = res.headers.get('x-ratelimit-remaining');
  const retryAfter = res.headers.get('retry-after');
  const reset = res.headers.get('x-ratelimit-reset');
  const isRate =
    remaining === '0' || Boolean(retryAfter) || /rate limit|secondary rate/i.test(bodyText);
  if (!isRate) return null;
  if (retryAfter && /^\d+$/.test(retryAfter.trim())) {
    const mins = Math.max(1, Math.ceil(Number(retryAfter.trim()) / 60));
    return `GitHub 说请求太频繁了（API 限流），约 ${mins} 分钟后再试`;
  }
  if (reset && /^\d+$/.test(reset.trim())) {
    const when = new Date(Number(reset.trim()) * 1000);
    const mins = Math.max(1, Math.ceil((when.getTime() - Date.now()) / 60000));
    return `GitHub 说请求太频繁了（这个 Token 的额度用完了），约 ${mins} 分钟后再试`;
  }
  return 'GitHub 说请求太频繁了（API 限流），请过一会儿再试';
}

/** 把 HTTP 状态码翻译成带 kind 的中文错误（401/403/404/429/5xx）。 */
function httpError(status: number, bodyText: string, res: GithubResponse, subject: string): GithubError {
  if (status === 401) {
    return new GithubError('unauthorized', 'GitHub 授权已失效（HTTP 401），请到设置页重新连接 GitHub', 401);
  }
  if (status === 403) {
    const rate = rateLimitMessage(res, bodyText);
    if (rate) return new GithubError('rate_limited', rate, 403);
    return new GithubError(
      'forbidden',
      `这个 Token 没有权限访问${subject}（HTTP 403）。确认地址对不对、Token 有没有 repo 权限`,
      403
    );
  }
  if (status === 404 || status === 410) {
    return new GithubError(
      'not_found',
      `${subject}不存在，或者当前 Token 没有访问权限（HTTP 404）`,
      status
    );
  }
  if (status === 429) {
    return new GithubError('rate_limited', 'GitHub 说请求太频繁了（HTTP 429），请过一会儿再试', 429);
  }
  return new GithubError(
    'bad_response',
    `GitHub 请求失败（HTTP ${status}）：${trimBody(bodyText) || '没有返回内容'}`,
    status
  );
}

interface RawResponse {
  text: string;
  headers: GithubResponse['headers'];
}

/** 发一次带鉴权的 GET/POST，返回原始文本（不做 JSON 解析）。 */
async function requestRaw(
  client: GithubClient,
  path: string,
  options: { method?: 'GET' | 'POST'; body?: string; accept?: string; timeoutMs?: number } = {}
): Promise<RawResponse> {
  const timeoutMs = options.timeoutMs ?? client.timeoutMs ?? GITHUB_REQUEST_TIMEOUT_MS;
  const box = linkSignal(client.signal, timeoutMs);
  const headers = authHeaders(client.token);
  if (options.accept) headers.Accept = options.accept;
  if (options.body) headers['Content-Type'] = 'application/x-www-form-urlencoded';
  const url = `${apiBaseOf(client)}${path}`;
  let res: GithubResponse;
  try {
    res = await client.fetcher(url, {
      method: options.method ?? 'GET',
      headers,
      body: options.body,
      signal: box.signal
    });
  } catch (err) {
    if (box.timedOut()) throw new GithubError('timeout', TIMEOUT_MESSAGE(timeoutMs));
    if (client.signal?.aborted) throw new GithubError('canceled', '已取消这次 GitHub 请求');
    if (looksLikeNetworkError(err)) {
      throw new GithubError('network', '连不上 GitHub，请检查网络或代理设置（本地功能不受影响）');
    }
    throw new GithubError('network', `GitHub 请求失败：${describeGithubError(err)}`);
  } finally {
    box.cleanup();
  }
  const bodyText = await res.text().catch(() => '');
  if (res.status === 401 || res.status === 403 || res.status === 404 || res.status === 410 || res.status === 429) {
    throw httpError(res.status, bodyText, res, '这个仓库');
  }
  if (!res.ok) throw httpError(res.status, bodyText, res, '这个仓库');
  return { text: bodyText, headers: res.headers };
}

async function requestJson(
  client: GithubClient,
  path: string,
  options: { method?: 'GET' | 'POST'; body?: string; accept?: string; timeoutMs?: number } = {}
): Promise<unknown> {
  const { text } = await requestRaw(client, path, options);
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new GithubError('bad_response', 'GitHub 返回的内容不是 JSON，可能接口地址被代理改了');
  }
}

// ---------------------------------------------------------------- 认证

export async function fetchAuthenticatedUser(
  client: GithubClient
): Promise<{ login: string; name: string | null; avatarUrl: string | null }> {
  const raw = await requestJson(client, '/user');
  const data = raw as { login?: unknown; name?: unknown; avatar_url?: unknown } | null;
  if (!data || typeof data.login !== 'string' || !data.login) {
    throw new GithubError('bad_response', 'GitHub 没有返回用户信息，Token 可能不完整');
  }
  return {
    login: data.login,
    name: typeof data.name === 'string' ? data.name : null,
    avatarUrl: typeof data.avatar_url === 'string' ? data.avatar_url : null
  };
}

export interface DeviceCodeOptions {
  fetcher: GithubFetcher;
  clientId?: string;
  oauthBase?: string;
  scope?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export function oauthBaseOf(oauthBase?: string): string {
  return (oauthBase || GITHUB_DEFAULT_OAUTH_BASE).replace(/\/+$/, '');
}

/** 第一步：向 GitHub 要设备码（用户拿去网页输）。 */
export async function requestDeviceCode(options: DeviceCodeOptions): Promise<GithubDeviceCode> {
  const clientId = (options.clientId || GITHUB_DEFAULT_CLIENT_ID).trim();
  if (!clientId) throw new GithubError('bad_response', GITHUB_AUTH_ERRORS.clientId);
  const timeoutMs = options.timeoutMs ?? GITHUB_REQUEST_TIMEOUT_MS;
  const box = linkSignal(options.signal, timeoutMs);
  const body = new URLSearchParams({
    client_id: clientId,
    scope: options.scope || GITHUB_DEFAULT_SCOPE
  }).toString();
  let res: GithubResponse;
  try {
    res = await options.fetcher(`${oauthBaseOf(options.oauthBase)}/login/device/code`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': GITHUB_USER_AGENT
      },
      body,
      signal: box.signal
    });
  } catch (err) {
    if (box.timedOut()) throw new GithubError('timeout', TIMEOUT_MESSAGE(timeoutMs));
    if (options.signal?.aborted) throw new GithubError('canceled', '已取消 GitHub 授权');
    throw new GithubError('network', '连不上 GitHub，请检查网络后重试');
  } finally {
    box.cleanup();
  }

  const text = await res.text().catch(() => '');
  if (res.status === 404 || res.status === 400 || res.status === 401) {
    throw new GithubError('bad_response', GITHUB_AUTH_ERRORS.clientId, res.status);
  }
  if (!res.ok) {
    throw new GithubError('bad_response', `GitHub 设备码请求失败（HTTP ${res.status}）`, res.status);
  }
  let data: {
    device_code?: unknown;
    user_code?: unknown;
    verification_uri?: unknown;
    expires_in?: unknown;
    interval?: unknown;
  };
  try {
    data = JSON.parse(text) as typeof data;
  } catch {
    throw new GithubError('bad_response', 'GitHub 设备码响应不是 JSON，可能被代理改了');
  }
  if (typeof data.device_code !== 'string' || typeof data.user_code !== 'string') {
    throw new GithubError('bad_response', 'GitHub 没有返回设备码，稍后重试');
  }
  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri:
      typeof data.verification_uri === 'string' ? data.verification_uri : 'https://github.com/login/device',
    expiresIn: typeof data.expires_in === 'number' ? data.expires_in : 900,
    interval: typeof data.interval === 'number' ? Math.max(1, data.interval) : 5
  };
}

export interface PollTokenOptions {
  fetcher: GithubFetcher;
  clientId?: string;
  deviceCode: string;
  interval: number;
  expiresIn?: number;
  oauthBase?: string;
  signal?: AbortSignal;
  /** 单次轮询请求的超时。 */
  timeoutMs?: number;
  /** 总等待上限，默认 15 分钟。 */
  maxWaitMs?: number;
  /** 注入时钟与睡眠，单测用假实现。 */
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new GithubError('canceled', '已取消 GitHub 授权'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new GithubError('canceled', '已取消 GitHub 授权'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** 第二步：轮询直到用户授权 / 取消 / 过期。 */
export async function pollAccessToken(options: PollTokenOptions): Promise<string> {
  const clientId = (options.clientId || GITHUB_DEFAULT_CLIENT_ID).trim();
  if (!clientId) throw new GithubError('bad_response', GITHUB_AUTH_ERRORS.clientId);
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? defaultSleep;
  const timeoutMs = options.timeoutMs ?? GITHUB_REQUEST_TIMEOUT_MS;
  const deadline = now() + Math.min((options.expiresIn ?? 900) * 1000, options.maxWaitMs ?? 15 * 60 * 1000);
  let interval = Math.max(1, options.interval);

  for (;;) {
    if (options.signal?.aborted) throw new GithubError('canceled', '已取消 GitHub 授权');
    if (now() >= deadline) {
      throw new GithubError('timeout', '等了 15 分钟还没完成 GitHub 授权，请重新点「连接 GitHub」');
    }
    const box = linkSignal(options.signal, timeoutMs);
    const body = new URLSearchParams({
      client_id: clientId,
      device_code: options.deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
    }).toString();
    let res: GithubResponse;
    try {
      res = await options.fetcher(`${oauthBaseOf(options.oauthBase)}/login/oauth/access_token`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': GITHUB_USER_AGENT
        },
        body,
        signal: box.signal
      });
    } catch (err) {
      if (box.timedOut()) {
        // 单次轮询超时不代表授权失败，等下一轮。
        await sleep(interval * 1000, options.signal);
        continue;
      }
      if (options.signal?.aborted) throw new GithubError('canceled', '已取消 GitHub 授权');
      throw new GithubError('network', '连不上 GitHub，请检查网络后重试');
    } finally {
      box.cleanup();
    }

    const text = await res.text().catch(() => '');
    let data: { access_token?: unknown; error?: unknown; interval?: unknown };
    try {
      data = JSON.parse(text) as typeof data;
    } catch {
      throw new GithubError('bad_response', 'GitHub 授权响应不是 JSON，稍后重试');
    }
    if (typeof data.access_token === 'string' && data.access_token) return data.access_token;

    const code = typeof data.error === 'string' ? data.error : '';
    if (code === 'authorization_pending') {
      await sleep(interval * 1000, options.signal);
      continue;
    }
    if (code === 'slow_down') {
      interval = typeof data.interval === 'number' ? Math.max(1, data.interval) : interval + 5;
      await sleep(interval * 1000, options.signal);
      continue;
    }
    if (code === 'expired_token') throw new GithubError('canceled', GITHUB_AUTH_ERRORS.expired);
    if (code === 'access_denied') throw new GithubError('canceled', GITHUB_AUTH_ERRORS.denied);
    if (code === 'device_flow_disabled') {
      throw new GithubError(
        'bad_response',
        '这个 GitHub OAuth App 没开启 Device Flow：请到 GitHub → Settings → Developer settings → OAuth Apps 里勾选 Enable Device Flow'
      );
    }
    if (code === 'incorrect_client_credentials' || code === 'unauthorized_client') {
      throw new GithubError('bad_response', GITHUB_AUTH_ERRORS.clientId);
    }
    if (!res.ok) {
      throw new GithubError('bad_response', `GitHub 授权轮询失败（HTTP ${res.status}）`, res.status);
    }
    throw new GithubError('bad_response', `GitHub 授权失败：${code || '未知原因'}`);
  }
}

// ---------------------------------------------------------------- 仓库信息

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** README 可能是 raw 文本，也可能是被代理包成 JSON（content 是 base64）。 */
function decodeReadme(raw: string): string {
  const text = String(raw ?? '');
  if (!text.trim()) return '';
  if (text.trim().startsWith('{')) {
    try {
      const data = JSON.parse(text) as { content?: unknown; encoding?: unknown };
      if (typeof data.content === 'string' && data.content.trim()) {
        const decoded =
          data.encoding === 'base64'
            ? Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf8')
            : data.content;
        return decoded;
      }
    } catch {
      /* 不是 JSON，就当普通文本 */
    }
  }
  return text;
}

export interface FetchRepoInfoOptions {
  /** 用户粘贴的任意 GitHub 地址（脏 URL 也接受，内部会严格清洗）。 */
  url: string;
  /** 读取 README 时最多保留多少字符，默认 {@link GITHUB_README_LIMIT}。 */
  readmeLimit?: number;
}

/**
 * 严格清洗地址 + 拉取仓库元信息 + 拉 README（截断到 8000 字符）。
 *
 * - 地址不合法直接抛中文错误（parseRepoUrl）；
 * - 仓库不存在 / 无权限 → GithubError('not_found' / 'forbidden')；
 * - README 拉不到不算失败（有些仓库没有 README），只是 `readme = null`。
 */
export async function fetchRepoInfo(
  client: GithubClient,
  options: FetchRepoInfoOptions
): Promise<GithubRepoInfo> {
  const repo = parseRepoUrl(options.url);
  const parts = splitRepo(repo);
  if (!parts) throw new GithubError('bad_response', '没看懂这个仓库地址，正确格式是 github.com/owner/repo');
  const { owner, name } = parts;

  const raw = await requestJson(client, `/repos/${owner}/${name}`);
  const data = (raw ?? {}) as Record<string, unknown>;
  if (!raw || typeof data !== 'object') {
    throw new GithubError('bad_response', 'GitHub 没有返回这个仓库的信息');
  }
  const license = (data.license ?? {}) as Record<string, unknown>;
  const topics = Array.isArray(data.topics)
    ? data.topics.filter((item): item is string => typeof item === 'string' && !!item.trim()).slice(0, 12)
    : [];

  const limit = options.readmeLimit ?? GITHUB_README_LIMIT;
  let readme: string | null = null;
  let readmeTruncated = false;
  try {
    const res = await requestRaw(client, `/repos/${owner}/${name}/readme`, {
      accept: 'application/vnd.github.raw'
    });
    const decoded = decodeReadme(res.text).trim();
    if (decoded) {
      readme = decoded.length > limit ? decoded.slice(0, limit) : decoded;
      readmeTruncated = decoded.length > limit;
    }
  } catch (err) {
    // README 404 视为「没有 README」，其它错误（401/超时）照常抛出。
    if (!(err instanceof GithubError && err.kind === 'not_found')) throw err;
  }

  return {
    repo,
    owner,
    name,
    description: readString(data.description),
    stars: readNumber(data.stargazers_count),
    forks: readNumber(data.forks_count),
    language: readString(data.language),
    topics,
    license: readString(license.spdx_id) ?? readString(license.name),
    homepage: readString(data.homepage),
    updatedAt: readString(data.updated_at),
    htmlUrl: readString(data.html_url) ?? `https://github.com/${repo}`,
    defaultBranch: readString(data.default_branch) ?? 'main',
    archived: data.archived === true,
    readme,
    readmeTruncated
  };
}
