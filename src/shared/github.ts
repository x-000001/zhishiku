/**
 * GitHub 集成的共享协议（主进程 / 渲染层 / 单测共用）。
 *
 * 设计约束（见 DEVELOPER_GUIDE.md 的 ADR-3 / ADR-4 / ADR-6）：
 * - 网络请求只在主进程发生，这里只放类型、校验与文案，不 import electron / fetch；
 * - Token 只在主进程出现，渲染层拿到的永远是「是否已连接 + 打码信息」；
 * - 通道命名沿用 `域:动作`，事件通道必须同时登记到 preload 白名单。
 */

/** 固定请求头版本，GitHub 要求带 User-Agent 才给 200。 */
export const GITHUB_API_VERSION = '2022-11-28';
export const GITHUB_USER_AGENT = 'JwKB';

/** 生产环境的默认地址；测试通过环境变量换成本地 stub。 */
export const GITHUB_DEFAULT_API_BASE = 'https://api.github.com';
export const GITHUB_DEFAULT_OAUTH_BASE = 'https://github.com';

/** Device Flow 需要的 OAuth App Client ID（公开值，不是 secret）。 */
export const GITHUB_DEFAULT_CLIENT_ID = '';
export const GITHUB_DEFAULT_SCOPE = 'repo';

/** 一页 100 条是 GitHub 的上限；同步按页循环直到拉空。 */
export const GITHUB_SYNC_PAGE_SIZE = 100;
/** Device Flow 总等待上限：15 分钟（GitHub 的设备码有效期也是 15 分钟）。 */
export const GITHUB_AUTH_TIMEOUT_MS = 15 * 60 * 1000;
/** 单次 HTTP 请求的超时。 */
export const GITHUB_REQUEST_TIMEOUT_MS = 20 * 1000;

/** 主进程 → 渲染层的进度事件通道（记得加到 preload 的 ALLOWED_EVENTS）。 */
export const GITHUB_PROGRESS_CHANNEL = 'github:progress';

export type GithubErrorKind =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'rate_limited'
  | 'timeout'
  | 'network'
  | 'bad_response'
  | 'canceled';

/** 设置里保存的仓库配置：`owner/repo`，大小写按 GitHub 原样保留。 */
export interface GithubStatus {
  connected: boolean;
  login: string | null;
  avatarUrl: string | null;
  tokenHint: string | null;
  encrypted: boolean;
  repos: string[];
  lastSyncAt: string | null;
  /** OAuth App 的 Client ID 是否可用（没配好时设置页会提示）。 */
  clientId: string | null;
  clientIdSource: 'env' | 'setting' | 'none';
}

export interface GithubDeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

export interface GithubRepoMeta {
  repo: string;
  lastSyncedAt: string | null;
  lastError: string | null;
}

export type GithubSyncPhase = 'start' | 'repo' | 'done';

export interface GithubSyncProgress {
  phase: GithubSyncPhase;
  repoIndex: number;
  repoTotal: number;
  repo: string | null;
  fetched: number;
}

export interface GithubSyncFailure {
  repo: string;
  error: string;
  kind?: GithubErrorKind;
}

export interface GithubSyncResult {
  repoTotal: number;
  succeeded: number;
  failed: GithubSyncFailure[];
  fetched: number;
  created: number;
  updated: number;
  skipped: number;
  pruned: number;
  /** 任一次请求返回 401 时置真：渲染层据此跳回设置页提示重新连接。 */
  authExpired: boolean;
}

/** Device Flow 轮询失败时抛给前端的稳定文案。 */
export const GITHUB_AUTH_ERRORS = {
  denied: '你取消了 GitHub 授权，可以重新点「连接 GitHub」',
  expired: '这次授权码过期了，请重新点「连接 GitHub」',
  clientId: 'GitHub OAuth App 的 Client ID 没配置：请让开发者在设置里填，或用 JWKB_GITHUB_CLIENT_ID 启动'
} as const;

/** GitHub 仓库名：`owner/repo`，只允许字母、数字、下划线、点、连字符，不能有空格。 */
const REPO_PART = '[A-Za-z0-9_.-]+';
export const REPO_NAME_RE = new RegExp(`^${REPO_PART}/${REPO_PART}$`);

export function isValidRepoName(raw: string): boolean {
  const value = String(raw ?? '').trim();
  if (!value || value.length > 140) return false;
  return REPO_NAME_RE.test(value);
}

export function normalizeRepoName(raw: string): string {
  return String(raw ?? '').trim()
    .replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//i, '')
    .replace(/\.git$/i, '');
}

/** 把「多行文本 / 数组」整理成仓库列表：去空行、去重、非法项丢弃。 */
export function parseRepoList(raw: string | string[] | null | undefined): string[] {
  const parts = Array.isArray(raw) ? raw : String(raw ?? '').split(/[\s,，;；]+/);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of parts) {
    const repo = normalizeRepoName(part);
    if (!isValidRepoName(repo)) continue;
    const key = repo.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(repo);
  }
  return out;
}

/** 拆出 owner / repo（调用前先过 isValidRepoName）。 */
export function splitRepo(repo: string): { owner: string; name: string } | null {
  if (!isValidRepoName(repo)) return null;
  const [owner, name] = normalizeRepoName(repo).split('/');
  return { owner, name };
}

/** 本地任务里用的唯一键：仓库 + issue 编号（跨仓库不冲突）。 */
export function githubIssueKey(repo: string, number: number): string {
  return `${normalizeRepoName(repo)}#${number}`;
}

/** 渲染层显示用的「同步中 (1/3)…」文案。 */
export function formatSyncProgress(p: GithubSyncProgress): string {
  if (p.phase === 'done') return '同步完成，正在刷新任务…';
  if (p.repoTotal <= 0) return '正在同步…';
  const where = p.repo ? `：${p.repo}` : '';
  return `正在同步 (${p.repoIndex}/${p.repoTotal})${where}${p.fetched > 0 ? ` · 已拉取 ${p.fetched} 条` : ''}`;
}

/** 同步完成后的 Toast 汇总文案（成功/失败/新增/更新 都有数字）。 */
export function formatSyncSummary(result: GithubSyncResult): string {
  const parts = [
    `同步完成：成功 ${result.succeeded} 个仓库，失败 ${result.failed.length} 个，新增 ${result.created} 条任务`
  ];
  if (result.updated > 0) parts.push(`更新 ${result.updated} 条`);
  if (result.pruned > 0) parts.push(`过滤掉 ${result.pruned} 个 PR`);
  return parts.join('，').replace('，更新', '，更新');
}
