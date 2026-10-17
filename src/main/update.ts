/**
 * 设置页「检查更新」的纯逻辑：拼 URL、解析 GitHub Release、比版本号、把各种网络故障
 * 翻译成用户看得懂的中文。网络通过注入的 fetcher 走，单测里换成一个假的即可，
 * 不需要真联网、也不需要启动 Electron。
 */
import type { UpdateAsset, UpdateCheck, UpdateRelease } from '../shared/types';

/** 固定查这个仓库的 latest Release。渲染层不能指定 URL，避免被拿来当代理发任意请求。 */
export const UPDATE_REPO = 'x-000001/zhishiku';
export const UPDATE_URL = `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`;
/** 说好 5 秒：超时就当断网处理，给一句能看懂的提示，不能一直转圈。 */
export const UPDATE_TIMEOUT_MS = 5000;

/** 网络请求的最小抽象：真实实现是主进程的 net.fetch，单测里换成假的。 */
export interface UpdateResponse {
  status: number;
  json(): Promise<unknown>;
}

export type UpdateFetcher = (
  url: string,
  init: { signal: AbortSignal; headers: Record<string, string> }
) => Promise<UpdateResponse>;

export interface CheckUpdateOptions {
  fetcher: UpdateFetcher;
  /** 默认 UPDATE_URL；只有测试用本地 stub 服务器时才传别的 */
  url?: string;
  timeoutMs?: number;
}

/**
 * 版本号比较：a > b 返回 1，相等 0，a < b 返回 -1。
 * 0.10.0 比 0.9.9 新（按数字段比，不是按字符串比）；v 前缀和 -beta.1 这类预发布后缀忽略，
 * 等于保守处理：预发布版本不提醒升级。
 */
export function compareVersion(a: string, b: string): number {
  const segments = (value: string): number[] =>
    value
      .trim()
      .replace(/^v/i, '')
      .split('-')[0]
      .split('.')
      .map((part) => Number.parseInt(part, 10) || 0);
  const left = segments(a);
  const right = segments(b);
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

/** 一个附件是不是 Windows 安装包：.exe，排除 blockmap / 更新元数据这类附属文件。 */
export function isInstallerName(name: string): boolean {
  const lower = name.toLowerCase();
  if (!lower.endsWith('.exe')) return false;
  return !lower.endsWith('.blockmap') && !lower.includes('.nsis.');
}

/** 从 Release 附件里挑出「要下载安装的那个 exe」；优先名字像安装包的，其次挑最大的。 */
export function pickInstallerAsset(assets: UpdateAsset[]): UpdateAsset | null {
  const candidates = assets.filter((asset) => isInstallerName(asset.name));
  if (!candidates.length) return null;
  const named = candidates.filter((asset) => /setup|安装包|install/i.test(asset.name));
  const pool = named.length ? named : candidates;
  return pool.reduce((best, item) => (item.size > best.size ? item : best), pool[0]);
}

/** 把 GitHub 的 assets 数组收拾成界面要的形状；不认识的字段直接跳过。 */
function parseAssets(raw: unknown): UpdateAsset[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item): UpdateAsset[] => {
    if (!item || typeof item !== 'object') return [];
    const obj = item as Record<string, unknown>;
    const name = typeof obj.name === 'string' ? obj.name.trim() : '';
    const url = typeof obj.browser_download_url === 'string' ? obj.browser_download_url.trim() : '';
    if (!name || !url) return [];
    const size = typeof obj.size === 'number' && Number.isFinite(obj.size) ? obj.size : 0;
    // GitHub 在 2024 年之后会给 digest（sha256:…）；老接口没有就让它是空串，校验时只比大小
    const digest = typeof obj.digest === 'string' ? obj.digest.trim().toLowerCase() : '';
    const sha256 = digest.startsWith('sha256:') ? digest.slice('sha256:'.length) : '';
    return [{ name, url, size, sha256 }];
  });
}

/** 把 GitHub 的 Release JSON 收拾成界面要的形状；字段不对就抛中文错误。 */
export function parseRelease(raw: unknown): UpdateRelease {
  if (!raw || typeof raw !== 'object') throw new Error('GitHub 返回的数据看不懂（不是对象）');
  const obj = raw as Record<string, unknown>;
  const tag = typeof obj.tag_name === 'string' ? obj.tag_name.trim() : '';
  if (!tag) throw new Error('GitHub 返回的数据里没有版本号（tag_name）');
  const version = tag.replace(/^v/i, '');
  if (!/^\d+(\.\d+)*/.test(version)) throw new Error('GitHub 上的版本号格式看不懂：' + tag);
  const body = typeof obj.body === 'string' ? obj.body.trim() : '';
  const assets = parseAssets(obj.assets);
  return {
    version,
    tag,
    url: typeof obj.html_url === 'string' ? obj.html_url.trim() : '',
    notes: body.length > 600 ? body.slice(0, 600) + '…' : body,
    publishedAt: typeof obj.published_at === 'string' ? obj.published_at : '',
    assets,
    installer: pickInstallerAsset(assets)
  };
}

/** 网络层的异常统一翻译成中文：用户点一下按钮，不该看到 ECONNREFUSED。 */
function describeFetchError(err: unknown, timeoutMs: number): Error {
  const e = err instanceof Error ? err : new Error(String(err));
  const lower = e.message.toLowerCase();
  if (e.name === 'AbortError' || e.name === 'TimeoutError' || lower.includes('aborted') || lower.includes('timeout')) {
    return new Error(`网络连接超时（${Math.round(timeoutMs / 1000)} 秒内没有响应），请检查网络后重试`);
  }
  if (
    lower.includes('fetch failed') ||
    lower.includes('econnrefused') ||
    lower.includes('enotfound') ||
    lower.includes('eai_again') ||
    lower.includes('etimedout') ||
    lower.includes('network') ||
    lower.includes('certificate') ||
    lower.includes('socket')
  ) {
    return new Error('连不上网，请检查网络后重试（本地功能不受影响）');
  }
  return new Error('联网检查失败：' + (e.message || '未知错误'));
}

/** 查一次 GitHub Release，返回「有没有新版本」。任何异常都带中文提示抛出，由 IPC 层包成 ok:false。 */
export async function checkUpdate(current: string, options: CheckUpdateOptions): Promise<UpdateCheck> {
  const url = options.url ?? UPDATE_URL;
  const timeoutMs = options.timeoutMs ?? UPDATE_TIMEOUT_MS;
  let response: UpdateResponse;
  try {
    response = await options.fetcher(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        Accept: 'application/vnd.github+json',
        // GitHub 的 API 要求带 User-Agent，不带会 403
        'User-Agent': 'jw-knowledge-base-updater'
      }
    });
  } catch (err) {
    throw describeFetchError(err, timeoutMs);
  }
  const checkedAt = Date.now();
  // 仓库还没发过 Release 时 GitHub 回 404：这不是错误，按「已是最新」处理
  if (response.status === 404) return { status: 'no-release', current, latest: null, checkedAt };
  if (response.status === 403 || response.status === 429) throw new Error('GitHub 说请求太频繁了，过一会儿再试');
  if (response.status !== 200) throw new Error('检查更新失败：GitHub 返回了 ' + response.status);

  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    throw new Error('GitHub 返回的内容不是有效 JSON，可能接口变了');
  }
  const latest = parseRelease(raw);
  return {
    status: compareVersion(latest.version, current) > 0 ? 'newer' : 'latest',
    current,
    latest,
    checkedAt
  };
}
