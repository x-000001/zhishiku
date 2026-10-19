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
  GITHUB_DEFAULT_CLIENT_ID,
  GITHUB_DEFAULT_OAUTH_BASE,
  GITHUB_DEFAULT_SCOPE,
  GITHUB_REQUEST_TIMEOUT_MS,
  GITHUB_SYNC_PAGE_SIZE,
  GITHUB_USER_AGENT,
  GITHUB_AUTH_ERRORS,
  githubIssueKey,
  isValidRepoName,
  normalizeRepoName,
  splitRepo,
  type GithubDeviceCode,
  type GithubErrorKind
} from '../shared/github';
import type { TaskPriority, TaskStatus } from '../shared/types';

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
    remaining === '0' ||
    Boolean(retryAfter) ||
    /rate limit|secondary rate/i.test(bodyText);
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
  return 'GitHub 说请求太频繁了（API 限流），请过一会儿再同步';
}

// ---------------------------------------------------------------- 基础请求

async function requestJson(
  client: GithubClient,
  path: string,
  options: { method?: 'GET' | 'POST'; body?: string; accept?: string; timeoutMs?: number } = {}
): Promise<unknown> {
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

  let bodyText = '';
  try {
    bodyText = await res.text();
  } catch {
    bodyText = '';
  }

  if (res.status === 401) {
    throw new GithubError('unauthorized', 'GitHub 授权已失效（HTTP 401），请到设置页重新连接 GitHub', 401);
  }
  if (res.status === 403) {
    const rate = rateLimitMessage(res, bodyText);
    if (rate) throw new GithubError('rate_limited', rate, 403);
    throw new GithubError(
      'forbidden',
      `这个 Token 没有权限访问它（HTTP 403）。确认仓库名对不对、Token 有没有 repo 权限`,
      403
    );
  }
  if (res.status === 404 || res.status === 410) {
    throw new GithubError(
      'not_found',
      '仓库或 Issue 不存在，或者当前 Token 没有访问权限（HTTP 404）',
      res.status
    );
  }
  if (res.status === 429) {
    throw new GithubError('rate_limited', 'GitHub 说请求太频繁了（HTTP 429），请过一会儿再同步', 429);
  }
  if (!res.ok) {
    throw new GithubError(
      res.status >= 500 ? 'bad_response' : 'bad_response',
      `GitHub 请求失败（HTTP ${res.status}）：${trimBody(bodyText) || '没有返回内容'}`,
      res.status
    );
  }

  if (!bodyText.trim()) return null;
  try {
    return JSON.parse(bodyText) as unknown;
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
      typeof data.verification_uri === 'string'
        ? data.verification_uri
        : 'https://github.com/login/device',
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

// ---------------------------------------------------------------- Issues

export interface GithubIssue {
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  html_url: string;
  updated_at: string;
  closed_at: string | null;
  labels: Array<{ name?: string } | string>;
  milestone: { due_on?: string | null } | null;
  /** 有值说明这是 PR——GitHub 的 issues 接口会把 PR 也塞进来，必须过滤。 */
  pull_request?: unknown;
}

function normalizeIssue(raw: unknown): GithubIssue | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  if (typeof item.number !== 'number' || typeof item.title !== 'string') return null;
  const labels = Array.isArray(item.labels)
    ? (item.labels as Array<{ name?: string } | string>)
    : [];
  const state = item.state === 'closed' ? 'closed' : 'open';
  return {
    number: item.number,
    title: item.title,
    body: typeof item.body === 'string' ? item.body : null,
    state,
    html_url: typeof item.html_url === 'string' ? item.html_url : '',
    updated_at: typeof item.updated_at === 'string' ? item.updated_at : new Date(0).toISOString(),
    closed_at: typeof item.closed_at === 'string' ? item.closed_at : null,
    labels,
    milestone:
      item.milestone && typeof item.milestone === 'object'
        ? (item.milestone as { due_on?: string | null })
        : null,
    pull_request: item.pull_request
  };
}

/** `since` 必须是 ISO 8601；传空/非法一律当作「全量」。 */
export function toSinceIso(since: string | number | Date | null | undefined): string | undefined {
  if (since === null || since === undefined || since === '') return undefined;
  const value = since instanceof Date ? since.getTime() : typeof since === 'number' ? since : Date.parse(String(since));
  if (!Number.isFinite(value)) return undefined;
  return new Date(value).toISOString();
}

export interface ListIssuesOptions {
  repo: string;
  page?: number;
  perPage?: number;
  since?: string | number | Date | null;
  /** 增量基线：每个仓库上次同步成功的时间。 */
  fetchFrom?: string | null;
}

/** 拉一页 issues（已按 per_page=100、state=all 组装）。 */
export async function listIssuesPage(
  client: GithubClient,
  options: ListIssuesOptions
): Promise<GithubIssue[]> {
  const parts = splitRepo(options.repo);
  if (!parts) throw new GithubError('bad_response', `仓库名不合法：${options.repo}（要 owner/repo 格式）`);
  const page = Math.max(1, options.page ?? 1);
  const perPage = Math.min(100, Math.max(1, options.perPage ?? GITHUB_SYNC_PAGE_SIZE));
  const params = new URLSearchParams({
    state: 'all',
    per_page: String(perPage),
    page: String(page),
    sort: 'updated',
    direction: 'asc'
  });
  const since = toSinceIso(options.since ?? options.fetchFrom ?? null);
  if (since) params.set('since', since);

  const raw = await requestJson(
    client,
    `/repos/${encodeURIComponent(parts.owner)}/${encodeURIComponent(parts.name)}/issues?${params.toString()}`
  );
  if (!Array.isArray(raw)) {
    throw new GithubError('bad_response', 'GitHub 返回的 issues 不是列表，可能接口地址不对');
  }
  return raw.map(normalizeIssue).filter((issue): issue is GithubIssue => issue !== null);
}

export interface FetchRepoIssuesResult {
  issues: GithubIssue[];
  pruned: number;
  pages: number;
}

/**
 * 循环翻页直到拉空（或不足一页），并顺手过滤 PR。
 * 为什么不用 `until page.length === 0`：不足一页说明到底了，少发一次空请求。
 */
export async function fetchRepoIssues(
  client: GithubClient,
  options: {
    repo: string;
    since?: string | number | Date | null;
    perPage?: number;
    maxPages?: number;
    onPage?: (info: { page: number; count: number; fetched: number }) => void;
  }
): Promise<FetchRepoIssuesResult> {
  const perPage = Math.min(100, Math.max(1, options.perPage ?? GITHUB_SYNC_PAGE_SIZE));
  const maxPages = Math.max(1, options.maxPages ?? 100);
  const issues: GithubIssue[] = [];
  let pruned = 0;
  let fetched = 0;
  let page = 1;
  for (;;) {
    if (page > maxPages) break;
    const rows = await listIssuesPage(client, {
      repo: options.repo,
      page,
      perPage,
      since: options.since
    });
    if (rows.length === 0) {
      options.onPage?.({ page, count: 0, fetched });
      break;
    }
    fetched += rows.length;
    for (const issue of rows) {
      if (issue.pull_request !== undefined) {
        pruned += 1;
        continue;
      }
      issues.push(issue);
    }
    options.onPage?.({ page, count: rows.length, fetched });
    if (rows.length < perPage) break;
    page += 1;
  }
  return { issues, pruned, pages: page };
}

// ---------------------------------------------------------------- Issue → Task 映射

export interface GithubTaskFields {
  githubIssueId: string;
  githubIssueKey: string;
  githubUpdatedAt: string;
  repo: string;
  number: number;
  title: string;
  note: string;
  status: TaskStatus;
  priority: TaskPriority;
  dueAt: string | null;
  completedAt: string | null;
}

export function issueLabelNames(issue: GithubIssue): string[] {
  return issue.labels
    .map((label) => (typeof label === 'string' ? label : label.name ?? ''))
    .map((name) => name.trim())
    .filter(Boolean);
}

export function hasBugLabel(issue: GithubIssue): boolean {
  return issueLabelNames(issue).some((name) => /^bug$/i.test(name) || /^bug[/:]/.test(name.toLowerCase()));
}

/**
 * 字段映射规则（阶段 2 验收点）：
 * - state === 'closed' → 任务完成（done + completed_at）
 * - labels 含 bug → 高优先级（项目里 highest 可用档位是 important）
 * - milestone.due_on → due_at（GitHub 给的是 UTC 日期时间，只取日期部分）
 * - 正文放 note（纯文本字段，UI 按文本渲染，不注入 HTML）
 */
export function mapIssueToTask(issue: GithubIssue, repo: string): GithubTaskFields {
  const cleanRepo = normalizeRepoName(repo);
  const dueOn = issue.milestone?.due_on;
  const dueAt = typeof dueOn === 'string' && /^\d{4}-\d{2}-\d{2}/.test(dueOn) ? dueOn.slice(0, 10) : null;
  const closed = issue.state === 'closed';
  const body = (issue.body ?? '').trim();
  const header = `来自 GitHub：${cleanRepo} #${issue.number}`;
  const link = issue.html_url ? `\n${issue.html_url}` : '';
  return {
    githubIssueId: githubIssueKey(cleanRepo, issue.number),
    githubIssueKey: githubIssueKey(cleanRepo, issue.number),
    githubUpdatedAt: issue.updated_at,
    repo: cleanRepo,
    number: issue.number,
    title: issue.title.trim() || `#${issue.number}`,
    note: body ? `${header}${link}\n\n${body}` : `${header}${link}`,
    status: closed ? 'done' : 'todo',
    priority: hasBugLabel(issue) ? 'important' : 'normal',
    dueAt,
    completedAt: closed ? issue.closed_at : null
  };
}

export function assertRepoUsable(repo: string): string {
  if (!isValidRepoName(repo)) {
    throw new GithubError('bad_response', `仓库名不合法：${repo}（要 owner/repo 格式，不能有空格）`);
  }
  return normalizeRepoName(repo);
}
