/**
 * GitHub 集成的共享协议（主进程 / 渲染层 / 单测共用）。
 *
 * 用途：在收集箱里搜集优秀的 GitHub 开源项目，并借助 AI 提炼知识点。
 *
 * 设计约束（见 DEVELOPER_GUIDE.md 的 ADR-3 / ADR-4 / ADR-6）：
 * - 网络请求只在主进程发生，这里只放类型、校验与文案，不 import electron / fetch；
 * - Token 只在主进程出现，渲染层拿到的永远是「是否已连接 + 打码信息」；
 * - 通道命名沿用 `域:动作`，事件通道必须同时登记到 preload 白名单。
 */

/** 固定请求头版本，GitHub 要求带 User-Agent 才给 200。 */
export const GITHUB_API_VERSION = '2022-11-28';
/** 0.11.0 起统一用应用名：部分网关按 UA 区分客户端，裸 `JwKB` 会被当成脚本拦掉。 */
export const GITHUB_USER_AGENT = 'JwKB-App';
/** 每次轮询单独超时：网络卡住时不能把 15 分钟的授权窗口白白占死。 */
export const GITHUB_DEVICE_POLL_TIMEOUT_MS = 10 * 1000;

/** 生产环境的默认地址；测试通过环境变量换成本地 stub。 */
export const GITHUB_DEFAULT_API_BASE = 'https://api.github.com';
export const GITHUB_DEFAULT_OAUTH_BASE = 'https://github.com';

/** Device Flow 需要的 OAuth App Client ID（公开值，不是 secret）。 */
export const GITHUB_DEFAULT_CLIENT_ID = '';
export const GITHUB_DEFAULT_SCOPE = 'repo';

/** Device Flow 总等待上限：15 分钟（GitHub 的设备码有效期也是 15 分钟）。 */
export const GITHUB_AUTH_TIMEOUT_MS = 15 * 60 * 1000;
/** 单次 HTTP 请求的超时。 */
export const GITHUB_REQUEST_TIMEOUT_MS = 20 * 1000;
/** README 只取前这么多字符发给 AI，避免超大仓库烧额度。 */
export const GITHUB_README_LIMIT = 8000;
/** AI 提炼是静默非流式的一次性请求，超时放宽到 60 秒。 */
export const GITHUB_EXTRACT_TIMEOUT_MS = 60 * 1000;
/** 同时进行的「保存并 AI 提炼」最多 2 个，超出的直接拒绝。 */
export const GITHUB_MAX_EXTRACT_JOBS = 2;

export type GithubErrorKind =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'rate_limited'
  | 'timeout'
  | 'network'
  | 'bad_response'
  | 'canceled';

/** 设置页看到的 GitHub 连接状态（永远不带 Token 原文）。 */
export interface GithubStatus {
  connected: boolean;
  login: string | null;
  avatarUrl: string | null;
  tokenHint: string | null;
  encrypted: boolean;
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

/**
 * 给渲染层看的设备码：**不含 device_code**（那只留在主进程内存里）。
 * `expiresAt` 是绝对时间戳（收到响应的那一刻 + expires_in），渲染层用它算倒计时。
 */
export interface GithubAuthCode {
  userCode: string;
  verificationUri: string;
  interval: number;
  expiresAt: number;
}

/**
 * 主进程 → 渲染层的授权事件（事件通道 `github:auth`，已在 preload 白名单登记）。
 *
 * 0.11.0 的 Device Flow 改成「主进程后台轮询 + 事件推送」：
 * 渲染层不再自己开定时器调 IPC 轮询，所以浏览器里点完授权后能立刻收到结果。
 */
export type GithubAuthEvent =
  | { type: 'code'; code: GithubAuthCode }
  | { type: 'authorized'; status: GithubStatus }
  | { type: 'expired'; message: string }
  | { type: 'denied'; message: string }
  | { type: 'error'; message: string };

/** Device Flow 轮询失败时抛给前端的稳定文案。 */
export const GITHUB_AUTH_ERRORS = {
  denied: '你取消了 GitHub 授权，可以重新点「连接 GitHub」',
  expired: '验证码已过期，请重新获取',
  clientId: 'GitHub OAuth App 的 Client ID 没配置：请让开发者在设置里填，或用 JWKB_GITHUB_CLIENT_ID 启动'
} as const;

/** 收集箱里一条 GitHub 项目的提炼状态。 */
export type RepoExtractStatus = 'pending' | 'ai_failed' | 'done' | 'link_only';

/** 提炼结果（存在 inbox_item.extract_meta 这个 JSON 列里）。 */
export interface RepoExtractMeta {
  summary?: string;
  highlights?: string[];
  scenes?: string;
  topics?: string[];
  language?: string | null;
  stars?: number;
  source?: 'ai' | 'fallback';
  error?: string;
  readmeChars?: number;
  extractedAt?: string;
}

export interface RepoImportInput {
  url: string;
  /** true = 保存并 AI 提炼；false = 仅保存链接。 */
  extract: boolean;
}

export interface RepoImportResult {
  itemId: number;
  repo: string;
  status: RepoExtractStatus;
  warning: string | null;
}

/** 转成知识库笔记时的请求体。 */
export interface RepoConvertInput {
  itemId: number;
  /** 可选：指定放进哪个分类。 */
  categoryId?: number | null;
}

/** GitHub 仓库的元信息（拉 README 时一并取回）。 */
export interface GithubRepoInfo {
  repo: string;
  owner: string;
  name: string;
  description: string | null;
  stars: number;
  forks: number;
  language: string | null;
  topics: string[];
  license: string | null;
  homepage: string | null;
  updatedAt: string | null;
  htmlUrl: string;
  defaultBranch: string;
  archived: boolean;
  readme: string | null;
  readmeTruncated: boolean;
}

/** 渲染层展示卡片用的解析结果（从 content 里的 YAML + Markdown 反解）。 */
export interface ParsedRepoNote {
  repo: string;
  url: string;
  stars: number;
  language: string;
  topics: string[];
  summary: string;
  highlights: string[];
  scenes: string;
}

/** GitHub 仓库名里每一段的合法字符。 */
const REPO_PART = '[A-Za-z0-9_.-]+';
export const REPO_NAME_RE = new RegExp(`^${REPO_PART}/${REPO_PART}$`);

/**
 * 严格清洗用户粘贴的地址，只保留干净的 `owner/repo`。
 *
 * 兼容：
 * - `https://github.com/owner/repo`
 * - `https://github.com/owner/repo.git`
 * - `https://github.com/owner/repo/tree/main/src`、`.../blob/...`、`?tab=readme`、`#readme`
 * - `http://www.github.com/owner/repo`
 * - 直接输入 `owner/repo`
 *
 * 解析失败抛中文错误（渲染层直接 toast 给用户）。
 */
export function parseRepoUrl(raw: unknown): string {
  const input = String(raw ?? '').trim();
  if (!input) throw new Error('请先粘贴 GitHub 项目地址，比如 https://github.com/facebook/react');
  if (input.length > 500) throw new Error('这个地址太长了，应该不是 GitHub 仓库链接');
  if (/\s/.test(input)) throw new Error('地址里不能有空格，检查一下是不是复制多了');

  // github.com/onlyowner 这种少一段的地址不能被当成「owner/repo」接受
  if (/^(?:https?:\/\/)?(?:www\.)?github\.com\/[^/?#]+\/?(?:[?#].*)?$/i.test(input)) {
    throw new Error('只支持 github.com 的仓库地址（https://github.com/owner/repo）');
  }
  const short = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(input);
  if (short) return assertRepoParts(short[1], short[2]);

  const url = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/?#]+)\/([^/?#]+)/i.exec(input);
  if (!url) {
    throw new Error('只支持 github.com 的仓库地址（https://github.com/owner/repo）');
  }
  const repo = url[2].replace(/\.git$/i, '');
  return assertRepoParts(url[1], repo);
}

function assertRepoParts(owner: string, repo: string): string {
  const o = owner.replace(/\.git$/i, '');
  const r = repo.replace(/\.git$/i, '');
  if (/github\.com$/i.test(o)) {
    throw new Error('只支持 github.com 的仓库地址（https://github.com/owner/repo）');
  }
  const validPart = (value: string): boolean =>
    !!value && value.length <= 100 && value !== '.' && value !== '..' && /^[A-Za-z0-9_.-]+$/.test(value);
  if (!validPart(o) || !validPart(r)) {
    throw new Error('没看懂这个仓库地址，正确格式是 github.com/owner/repo');
  }
  return `${o}/${r}`;
}

export function isValidRepoName(raw: string): boolean {
  const value = String(raw ?? '').trim();
  if (!value || value.length > 140) return false;
  return REPO_NAME_RE.test(value);
}

/** 拆出 owner / repo（调用前先过 isValidRepoName）。 */
export function splitRepo(repo: string): { owner: string; name: string } | null {
  if (!isValidRepoName(repo)) return null;
  const [owner, name] = repo.split('/');
  return { owner, name };
}

/** 笔记开头的 YAML frontmatter（固定字段顺序，方便人和机器读）。 */
export function buildRepoFrontmatter(info: {
  repo: string;
  url: string;
  stars: number;
  language: string | null;
  topics: string[];
}): string {
  const topics = (info.topics ?? []).slice(0, 8).join(', ');
  const lines = [
    '---',
    `repo: ${info.repo}`,
    `url: ${info.url}`,
    `stars: ${Number.isFinite(info.stars) ? Math.max(0, Math.round(info.stars)) : 0}`,
    `language: ${(info.language ?? '').trim() || '未知'}`,
    `topics: ${topics}`
  ];
  return lines.join('\n') + '\n---';
}

/**
 * 把「元信息 + AI 提炼结果」拼成存进 content 的 Markdown（YAML + 引用块正文）。
 *
 * 渲染层会把 `---` 解析成徽章而不是显示原文；转成知识库笔记后原文仍完整保留。
 */
export function buildRepoNoteMarkdown(input: {
  repo: string;
  url: string;
  stars: number;
  language: string | null;
  topics: string[];
  summary: string;
  highlights: string[];
  scenes: string;
}): string {
  const summary = String(input.summary ?? '').trim() || '暂时没提炼出总结。';
  const highlights = (input.highlights ?? [])
    .map((item) => String(item ?? '').trim())
    .filter(Boolean)
    .slice(0, 5);
  const scenes = String(input.scenes ?? '').trim() || '暂时没提炼出适用场景。';
  const body: string[] = [
    `> 💡 **项目总结**：${summary}`,
    '> 🎯 **核心亮点**：',
    ...(highlights.length ? highlights.map((item) => `> - ${item}`) : ['> - 暂时没有提炼出亮点']),
    `> ⚠️ **适用场景**：${scenes}`
  ];
  return `${buildRepoFrontmatter(input)}\n\n${body.join('\n')}\n`;
}

/** 从 content 里反解 YAML + 引用块；缺字段也返回可用结果（卡片容错展示）。 */
export function parseRepoNoteMarkdown(markdown: string): ParsedRepoNote {
  const text = String(markdown ?? '');
  const meta: Record<string, string> = {};
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (fm) {
    for (const line of fm[1].split(/\r?\n/)) {
      const index = line.indexOf(':');
      if (index <= 0) continue;
      meta[line.slice(0, index).trim()] = line.slice(index + 1).trim();
    }
  }
  const take = (label: string): string => {
    const match = new RegExp(`${label}[^：:]*[：:]\\s*(.+)`).exec(text);
    return match ? match[1].trim() : '';
  };
  const summary = /项目总结[^：:]*[：:]\s*(.+)/.exec(text)?.[1]?.trim() ?? '';
  const scenes = /适用场景[^：:]*[：:]\s*(.+)/.exec(text)?.[1]?.trim() ?? '';
  const highlights: string[] = [];
  const highlightBlock = /核心亮点[^：:]*[：:]\s*([\s\S]*?)(?:\n\s*>\s*⚠️|$)/.exec(text);
  if (highlightBlock) {
    for (const line of highlightBlock[1].split(/\r?\n/)) {
      const item = /^\s*>\s*-\s*(.+?)\s*$/.exec(line);
      if (item) highlights.push(item[1].trim());
    }
  }
  const stars = Number(meta.stars);
  return {
    repo: meta.repo || take('repo') || '',
    url: meta.url || '',
    stars: Number.isFinite(stars) ? stars : 0,
    language: meta.language && meta.language !== '未知' ? meta.language : '',
    topics: (meta.topics ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
    summary,
    highlights: highlights.slice(0, 5),
    scenes
  };
}

/** 卡片上的状态文案。 */
export function extractStatusText(status: RepoExtractStatus): string {
  switch (status) {
    case 'done':
      return '已提炼';
    case 'ai_failed':
      return 'AI 提炼失败，可重试';
    case 'link_only':
      return '仅保存链接';
    default:
      return '等待提炼';
  }
}

/** 导入完成后的 Toast 文案。 */
export function formatImportResult(result: { repo: string; status: RepoExtractStatus; warning: string | null }): string {
  if (result.status === 'done') return `已导入并提炼：${result.repo}（已收进收集箱）`;
  if (result.status === 'ai_failed') {
    return `已导入：${result.repo}，但 AI 提炼没成功${result.warning ? '：' + result.warning : ''}（可在卡片上重试）`;
  }
  return `已导入：${result.repo}（仅保存链接）`;
}

/** 提炼失败时给用户的兜底提示（不吞掉真实错误）。 */
export function describeExtractFailure(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err ?? '');
  return String(text || 'AI 提炼失败').trim().slice(0, 200);
}
