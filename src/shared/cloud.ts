/* 云端灾备（0.12.0 阶段5）的共享约定与纯函数：WebDAV / GitHub 单向备份。 */

/** WebDAV 每个请求的硬超时（需求红线：AbortSignal.timeout(30000)）。 */
export const CLOUD_WEBDAV_TIMEOUT_MS = 30_000;
/** 高危恢复必须输入的确认词。 */
export const RESTORE_CONFIRM_WORD = 'CONFIRM';
/** 云端备份的固定目录（只保留最近一份，覆盖式；「单向备份」不需要版本树）。 */
export const CLOUD_BACKUP_DIR = 'jwkb-backup';
export const CLOUD_DB_NAME = 'kb.db';
export const CLOUD_MANIFEST_NAME = 'manifest.json';
export const CLOUD_ATTACHMENTS_DIR = 'attachments';
/** GitHub 灾备固定用同一个 Release（tag 固定，资产覆盖）。 */
export const CLOUD_GITHUB_TAG = 'jwkb-cloud-backup';

export type CloudProvider = 'webdav' | 'github';

export interface CloudConfigInput {
  provider?: CloudProvider;
  webdavUrl?: string;
  webdavUser?: string;
  /** 留空 = 不修改；传空串 = 清除 */
  webdavPassword?: string;
  githubRepo?: string;
}

/** 渲染层能看到的配置：永远不包含明文密码。 */
export interface CloudConfigPublic {
  provider: CloudProvider;
  webdavUrl: string;
  webdavUser: string;
  hasPassword: boolean;
  passwordEncrypted: boolean;
  githubRepo: string;
  configured: boolean;
}

export interface CloudBackupInfo {
  provider: CloudProvider;
  createdAt: string;
  dbBytes: number;
  attachmentCount: number;
  attachmentBytes: number;
}

export interface CloudTestResult {
  ok: true;
  detail: string;
}

export interface CloudRestoreResult {
  provider: CloudProvider;
  createdAt: string;
  /** 恢复前自动给当前数据做的快照名 */
  preRestore: string;
  attachmentCount: number;
}

export interface CloudManifest {
  version: 1;
  provider: CloudProvider;
  createdAt: string;
  dbBytes: number;
  attachments: Array<{ rel: string; name: string; bytes: number }>;
}

/** WebDAV 地址规范化：去首尾空白、必须 http(s)、去掉多余结尾斜杠。 */
export function normalizeWebdavUrl(raw: string): string {
  const value = String(raw ?? '').trim();
  if (!value) return '';
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('WebDAV 地址格式不对，形如 https://dav.example.com/remote.php/dav/files/用户名/');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('WebDAV 地址只支持 http / https');
  }
  return value.replace(/\/+$/, '') + '/';
}

/** 拼 WebDAV 子路径（每段单独 encode，保留层级 '/'）。 */
export function joinWebdavUrl(base: string, ...parts: string[]): string {
  const root = String(base ?? '').replace(/\/+$/, '');
  const tail = parts
    .filter((part) => String(part ?? '').length > 0)
    .map((part) => String(part).replace(/^\/+|\/+$/g, ''))
    .join('/');
  return tail ? `${root}/${tail}` : `${root}/`;
}

/** 恢复的高危闸门：必须输入 CONFIRM 或勾选「我已了解数据将被覆盖」。 */
export function canConfirmRestore(input: { typed?: unknown; checked?: unknown } | null | undefined): boolean {
  if (!input) return false;
  const typed = typeof input.typed === 'string' ? input.typed.trim() : '';
  return typed === RESTORE_CONFIRM_WORD || input.checked === true;
}

/** 附件相对路径消毒：禁止绝对路径与 ..，统一用 '/' 分隔。 */
export function sanitizeAttachmentPath(rel: unknown): string {
  const value = String(rel ?? '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .trim();
  if (!value || value.includes('..') || value.includes('\u0000')) {
    throw new Error('备份里的附件路径不合法');
  }
  return value;
}

/** 附件在云端用扁平文件名：a/b.png → a%2Fb.png 不能再有 '/'，避免建目录。 */
export function attachmentCloudName(rel: string): string {
  return encodeURIComponent(sanitizeAttachmentPath(rel)).replace(/%2F/gi, '_');
}

/** 主进程/渲染层共用的人话错误：SQLITE_BUSY、磁盘满、网络超时。 */
export function describeCloudError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err ?? '');
  if (/SQLITE_BUSY|database is locked/i.test(raw)) {
    return '数据库正忙（可能有另一个窗口或程序正在读写），请稍后重试';
  }
  if (/SQLITE_FULL|ENOSPC|disk is full/i.test(raw)) {
    return '磁盘空间不够了，清理一下再备份';
  }
  if (/timeout|aborted|AbortError/i.test(raw)) {
    return `云服务 ${Math.round(CLOUD_WEBDAV_TIMEOUT_MS / 1000)} 秒内没有响应，请检查网络或地址`;
  }
  return raw || '云端操作失败，请稍后重试';
}

/** 把毫秒时间戳写成文件名里用的 UTC 时间：2026-10-22-2230。 */
export function backupStamp(now = Date.now()): string {
  const d = new Date(now);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    d.getUTCFullYear() +
    '-' +
    pad(d.getUTCMonth() + 1) +
    '-' +
    pad(d.getUTCDate()) +
    '-' +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes())
  );
}
