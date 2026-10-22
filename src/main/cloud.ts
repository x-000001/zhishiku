/* 云端灾备（0.12.0 阶段5）：WebDAV / GitHub 单向备份。
 *
 * 关键约束：
 *  - 数据库快照必须用 VACUUM INTO（WAL 里的内容也一致），SQLITE_BUSY 翻译成人话；
 *  - WebDAV 凭据用 safeStorage 加密（和 AI Key 同一套 DPAPI 方案），渲染层永远拿不到明文；
 *  - 所有 WebDAV 请求都带 AbortSignal.timeout(30000)；
 *  - 大附件用文件流上传（createReadStream + Content-Length），不整块读进内存；
 *  - 从云端恢复是高危操作，IPC 层只接受 CONFIRM / 勾选确认（再叠加 UI 的红色确认框）。 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { net, safeStorage } from 'electron';
import * as db from './db';
import * as backup from './backup';
import { stampLocal, type DataPaths } from './paths';
import { readGithubToken } from './ipc/github';
import { takeSnapshot } from './snapshot';
import {
  CLOUD_ATTACHMENTS_DIR,
  CLOUD_BACKUP_DIR,
  CLOUD_DB_NAME,
  CLOUD_GITHUB_TAG,
  CLOUD_MANIFEST_NAME,
  CLOUD_WEBDAV_TIMEOUT_MS,
  attachmentCloudName,
  backupStamp,
  describeCloudError,
  joinWebdavUrl,
  normalizeWebdavUrl,
  sanitizeAttachmentPath,
  type CloudBackupInfo,
  type CloudConfigInput,
  type CloudConfigPublic,
  type CloudManifest,
  type CloudProvider,
  type CloudRestoreResult,
  type CloudTestResult
} from '../shared/cloud';

const KEY_PROVIDER = 'cloud.provider';
const KEY_WEBDAV_URL = 'cloud.webdavUrl';
const KEY_WEBDAV_USER = 'cloud.webdavUser';
const KEY_WEBDAV_PASS = 'cloud.webdavPassword';
const KEY_WEBDAV_PASS_ENC = 'cloud.webdavPasswordEnc';
const KEY_GITHUB_REPO = 'cloud.githubRepo';

function encryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

function readPassword(): string {
  const stored = db.getSetting(KEY_WEBDAV_PASS) ?? '';
  if (!stored) return '';
  if ((db.getSetting(KEY_WEBDAV_PASS_ENC) ?? '0') !== '1') return stored;
  try {
    return safeStorage.decryptString(Buffer.from(stored, 'base64'));
  } catch {
    return '';
  }
}

function writePassword(plain: string): void {
  const value = String(plain ?? '').trim();
  if (!value) {
    db.setSetting(KEY_WEBDAV_PASS, '');
    db.setSetting(KEY_WEBDAV_PASS_ENC, '0');
    return;
  }
  if (encryptionAvailable()) {
    db.setSetting(KEY_WEBDAV_PASS, safeStorage.encryptString(value).toString('base64'));
    db.setSetting(KEY_WEBDAV_PASS_ENC, '1');
  } else {
    db.setSetting(KEY_WEBDAV_PASS, value);
    db.setSetting(KEY_WEBDAV_PASS_ENC, '0');
  }
}

export function publicCloudConfig(): CloudConfigPublic {
  const provider = (db.getSetting(KEY_PROVIDER) === 'github' ? 'github' : 'webdav') as CloudProvider;
  const webdavUrl = db.getSetting(KEY_WEBDAV_URL) ?? '';
  const webdavUser = db.getSetting(KEY_WEBDAV_USER) ?? '';
  const password = readPassword();
  const githubRepo = db.getSetting(KEY_GITHUB_REPO) ?? '';
  return {
    provider,
    webdavUrl,
    webdavUser,
    hasPassword: Boolean(password),
    passwordEncrypted: Boolean(password) ? (db.getSetting(KEY_WEBDAV_PASS_ENC) ?? '0') === '1' : encryptionAvailable(),
    githubRepo,
    configured:
      provider === 'webdav' ? Boolean(webdavUrl) : /^[\w.-]+\/[\w.-]+$/.test(githubRepo) && Boolean(readGithubToken())
  };
}

export function setCloudConfig(patch: CloudConfigInput): CloudConfigPublic {
  const input = patch ?? {};
  if (input.provider === 'webdav' || input.provider === 'github') db.setSetting(KEY_PROVIDER, input.provider);
  if (typeof input.webdavUrl === 'string') {
    const next = input.webdavUrl.trim();
    db.setSetting(KEY_WEBDAV_URL, next ? normalizeWebdavUrl(next) : '');
  }
  if (typeof input.webdavUser === 'string') db.setSetting(KEY_WEBDAV_USER, input.webdavUser.trim());
  if (typeof input.webdavPassword === 'string') writePassword(input.webdavPassword);
  if (typeof input.githubRepo === 'string') db.setSetting(KEY_GITHUB_REPO, input.githubRepo.trim());
  return publicCloudConfig();
}

/* ---------------- 数据库快照（VACUUM INTO，见 ./snapshot.ts） ---------------- */

/* ---------------- WebDAV 传输层 ---------------- */

export interface WebdavRequest {
  method: string;
  headers: Record<string, string>;
  body?: Buffer;
  /** 有它就是流式上传（大附件） */
  filePath?: string;
  /** 有它就是流式下载到文件 */
  saveTo?: string;
  timeoutMs?: number;
}

export interface WebdavResponse {
  status: number;
  text: string;
}

export interface WebdavTransport {
  request(url: string, init: WebdavRequest): Promise<WebdavResponse>;
}

function basicAuth(user: string, password: string): string {
  return 'Basic ' + Buffer.from(`${user}:${password}`, 'utf8').toString('base64');
}

/** 真实传输：node http/https + AbortSignal.timeout（硬超时），大文件走流。 */
export const nodeWebdavTransport: WebdavTransport = {
  request(url, init) {
    return new Promise<WebdavResponse>((resolve, reject) => {
      let target: URL;
      try {
        target = new URL(url);
      } catch {
        reject(new Error('WebDAV 地址格式不对'));
        return;
      }
      const mod = target.protocol === 'https:' ? https : http;
      const headers: Record<string, string> = { ...init.headers };
      const req = mod.request(
        target,
        {
          method: init.method,
          headers,
          // 红线：30 秒硬超时（streaming 上传期间也受它约束）
          signal: AbortSignal.timeout(init.timeoutMs ?? CLOUD_WEBDAV_TIMEOUT_MS)
        },
        (res) => {
          if (init.saveTo) {
            const out = fs.createWriteStream(init.saveTo);
            res.pipe(out);
            out.on('finish', () => resolve({ status: res.statusCode ?? 0, text: '' }));
            out.on('error', reject);
            return;
          }
          const chunks: Buffer[] = [];
          res.on('data', (chunk) => chunks.push(chunk as Buffer));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
        }
      );
      req.on('error', reject);
      if (init.filePath) {
        const size = fs.statSync(init.filePath).size;
        req.setHeader('Content-Length', String(size));
        const stream = fs.createReadStream(init.filePath);
        stream.on('error', reject);
        stream.pipe(req);
        return;
      }
      if (init.body) {
        req.setHeader('Content-Length', String(init.body.length));
        req.end(init.body);
        return;
      }
      req.end();
    });
  }
};

function requireWebdav(): { url: string; auth: string } {
  const url = db.getSetting(KEY_WEBDAV_URL) ?? '';
  if (!url) throw new Error('还没填 WebDAV 地址（设置 → 云端灾备）');
  const user = db.getSetting(KEY_WEBDAV_USER) ?? '';
  const password = readPassword();
  if (!user) throw new Error('还没填 WebDAV 用户名');
  return { url: normalizeWebdavUrl(url), auth: basicAuth(user, password) };
}

async function dav(
  transport: WebdavTransport,
  url: string,
  init: Omit<WebdavRequest, 'headers'> & { headers?: Record<string, string> }
): Promise<WebdavResponse> {
  const res = await transport.request(url, {
    ...init,
    headers: { ...(init.headers ?? {}) }
  });
  if (res.status >= 400 && res.status !== 404) {
    throw new Error(`WebDAV 返回 HTTP ${res.status}`);
  }
  return res;
}

async function ensureCollection(transport: WebdavTransport, url: string, auth: string): Promise<void> {
  const res = await dav(transport, url, { method: 'MKCOL', headers: { Authorization: auth } });
  if (res.status !== 200 && res.status !== 201 && res.status !== 301 && res.status !== 405) {
    throw new Error(`WebDAV 建目录失败（HTTP ${res.status}）`);
  }
}

function walkAttachments(root: string): Array<{ rel: string; abs: string; bytes: number }> {
  const out: Array<{ rel: string; abs: string; bytes: number }> = [];
  const walk = (dir: string, prefix: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(abs, rel);
      else out.push({ rel, abs, bytes: fs.statSync(abs).size });
    }
  };
  walk(root, '');
  return out;
}

export async function webdavTest(transport: WebdavTransport = nodeWebdavTransport): Promise<CloudTestResult> {
  const { url, auth } = requireWebdav();
  await ensureCollection(transport, url, auth);
  const info = await dav(transport, joinWebdavUrl(url, CLOUD_BACKUP_DIR), { method: 'PROPFIND', headers: { Authorization: auth, Depth: '0' } });
  return { ok: true, detail: info.status === 404 ? '地址可用（还没有备份，可以开始备份）' : '连接正常' };
}

export async function webdavBackup(paths: DataPaths, transport: WebdavTransport = nodeWebdavTransport): Promise<CloudBackupInfo> {
  const { url, auth } = requireWebdav();
  const createdAt = new Date().toISOString();
  const work = fs.mkdtempSync(path.join(paths.root, '.cloud-work-'));
  try {
    const snapshot = path.join(work, 'snapshot.db');
    const dbBytes = takeSnapshot((sql) => db.getRawDb().exec(sql), snapshot);
    const attachments = walkAttachments(paths.attachments);
    const backupDir = joinWebdavUrl(url, CLOUD_BACKUP_DIR);
    await ensureCollection(transport, url, auth);
    await ensureCollection(transport, backupDir, auth);
    await ensureCollection(transport, joinWebdavUrl(backupDir, CLOUD_ATTACHMENTS_DIR), auth);
    // 1) 数据库快照
    let res = await dav(transport, joinWebdavUrl(backupDir, CLOUD_DB_NAME), {
      method: 'PUT',
      headers: { Authorization: auth, 'Content-Type': 'application/octet-stream' },
      filePath: snapshot
    });
    if (res.status >= 300) throw new Error(`上传数据库快照失败（HTTP ${res.status}）`);
    // 2) 附件逐个流式上传
    for (const att of attachments) {
      res = await dav(transport, joinWebdavUrl(backupDir, CLOUD_ATTACHMENTS_DIR, attachmentCloudName(att.rel)), {
        method: 'PUT',
        headers: { Authorization: auth, 'Content-Type': 'application/octet-stream' },
        filePath: att.abs
      });
      if (res.status >= 300) throw new Error(`上传附件失败：${att.rel}（HTTP ${res.status}）`);
    }
    // 3) 清单最后写：它存在 = 这次备份完整
    const manifest: CloudManifest = {
      version: 1,
      provider: 'webdav',
      createdAt,
      dbBytes,
      attachments: attachments.map((a) => ({ rel: a.rel, name: attachmentCloudName(a.rel), bytes: a.bytes }))
    };
    res = await dav(transport, joinWebdavUrl(backupDir, CLOUD_MANIFEST_NAME), {
      method: 'PUT',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: Buffer.from(JSON.stringify(manifest), 'utf8')
    });
    if (res.status >= 300) throw new Error(`上传清单失败（HTTP ${res.status}）`);
    return {
      provider: 'webdav',
      createdAt,
      dbBytes,
      attachmentCount: attachments.length,
      attachmentBytes: attachments.reduce((sum, a) => sum + a.bytes, 0)
    };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

export async function webdavInfo(transport: WebdavTransport = nodeWebdavTransport): Promise<CloudBackupInfo | null> {
  const { url, auth } = requireWebdav();
  const res = await dav(transport, joinWebdavUrl(url, CLOUD_BACKUP_DIR, CLOUD_MANIFEST_NAME), {
    method: 'GET',
    headers: { Authorization: auth }
  });
  if (res.status === 404) return null;
  try {
    const manifest = JSON.parse(res.text) as CloudManifest;
    return {
      provider: 'webdav',
      createdAt: manifest.createdAt,
      dbBytes: manifest.dbBytes,
      attachmentCount: manifest.attachments.length,
      attachmentBytes: manifest.attachments.reduce((sum, a) => sum + a.bytes, 0)
    };
  } catch {
    throw new Error('云端清单损坏，无法解析');
  }
}

export async function webdavRestore(paths: DataPaths, transport: WebdavTransport = nodeWebdavTransport): Promise<CloudRestoreResult> {
  const { url, auth } = requireWebdav();
  const backupDir = joinWebdavUrl(url, CLOUD_BACKUP_DIR);
  const manifestRes = await dav(transport, joinWebdavUrl(backupDir, CLOUD_MANIFEST_NAME), { method: 'GET', headers: { Authorization: auth } });
  if (manifestRes.status === 404) throw new Error('云端还没有备份，先备份一次再来恢复');
  const manifest = JSON.parse(manifestRes.text) as CloudManifest;
  const work = fs.mkdtempSync(path.join(paths.root, '.cloud-restore-'));
  try {
    const dbFile = path.join(work, 'kb.db');
    const dbRes = await dav(transport, joinWebdavUrl(backupDir, CLOUD_DB_NAME), {
      method: 'GET',
      headers: { Authorization: auth },
      saveTo: dbFile
    });
    if (dbRes.status === 404) throw new Error('云端备份里缺少数据库文件');
    const attachments: Array<{ rel: string; file: string }> = [];
    for (const item of manifest.attachments) {
      const rel = sanitizeAttachmentPath(item.rel);
      const file = path.join(work, attachmentCloudName(rel));
      const res = await dav(transport, joinWebdavUrl(backupDir, CLOUD_ATTACHMENTS_DIR, item.name), {
        method: 'GET',
        headers: { Authorization: auth },
        saveTo: file
      });
      if (res.status === 404) continue;
      attachments.push({ rel, file });
    }
    const applied = applyRestore(paths, dbFile, attachments);
    return { provider: 'webdav', createdAt: manifest.createdAt, preRestore: applied.preRestore, attachmentCount: attachments.length };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/* ---------------- GitHub（复用设备流授权得到的 Token） ---------------- */

export interface CloudFetchResponse {
  status: number;
  ok: boolean;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type CloudFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: Buffer; signal?: AbortSignal }
) => Promise<CloudFetchResponse>;

const netCloudFetch: CloudFetch = async (url, init) => {
  const res = await net.fetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body as never,
    signal: init.signal
  });
  return { status: res.status, ok: res.ok, text: () => res.text(), arrayBuffer: () => res.arrayBuffer() };
};

function githubHeaders(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    Authorization: 'Bearer ' + token,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'JwKB-App',
    ...extra
  };
}

function requireGithub(): { token: string; repo: string } {
  const token = readGithubToken();
  if (!token) throw new Error('GitHub 还没连接（设置 → GitHub）');
  const repo = (db.getSetting(KEY_GITHUB_REPO) ?? '').trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('GitHub 备份仓库要写成 owner/repo');
  return { token, repo };
}

async function githubRelease(token: string, repo: string, fetch: CloudFetch, create?: { body: string; assetName: string }): Promise<{ id: number; uploadUrl: string; body: string; assets: Array<{ id: number; name: string; url: string }> }> {
  const base = `https://api.github.com/repos/${repo}/releases`;
  const getRes = await fetch(`${base}/tags/${CLOUD_GITHUB_TAG}`, { method: 'GET', headers: githubHeaders(token), signal: AbortSignal.timeout(CLOUD_WEBDAV_TIMEOUT_MS) });
  if (getRes.status === 200) {
    const data = (await getRes.text()).trim();
    const parsed = JSON.parse(data) as { id: number; upload_url: string; body: string; assets: Array<{ id: number; name: string; url: string }> };
    return { id: parsed.id, uploadUrl: parsed.upload_url, body: parsed.body ?? '', assets: parsed.assets ?? [] };
  }
  if (getRes.status !== 404) throw new Error(`GitHub 查询备份 Release 失败（HTTP ${getRes.status}）`);
  if (!create) throw new Error('GitHub 上还没有云端备份');
  const createRes = await fetch(base, {
    method: 'POST',
    headers: githubHeaders(token, { 'Content-Type': 'application/json' }),
    body: Buffer.from(JSON.stringify({ tag_name: CLOUD_GITHUB_TAG, name: 'Jw 知识库云端备份', body: create.body }), 'utf8'),
    signal: AbortSignal.timeout(CLOUD_WEBDAV_TIMEOUT_MS)
  });
  if (!createRes.ok) throw new Error(`GitHub 建备份 Release 失败（HTTP ${createRes.status}）`);
  const parsed = JSON.parse(await createRes.text()) as { id: number; upload_url: string; body: string; assets: Array<{ id: number; name: string; url: string }> };
  return { id: parsed.id, uploadUrl: parsed.upload_url, body: parsed.body ?? '', assets: parsed.assets ?? [] };
}

export async function githubBackup(workRoot: string, fetch: CloudFetch = netCloudFetch): Promise<CloudBackupInfo> {
  const { token, repo } = requireGithub();
  const createdAt = new Date().toISOString();
  const work = fs.mkdtempSync(path.join(workRoot, '.cloud-gh-'));
  try {
    const snapshot = path.join(work, 'snapshot.db');
    const dbBytes = takeSnapshot((sql) => db.getRawDb().exec(sql), snapshot);
    const manifest: CloudManifest = { version: 1, provider: 'github', createdAt, dbBytes, attachments: [] };
    const body = JSON.stringify(manifest);
    const release = await githubRelease(token, repo, fetch, { body, assetName: 'jwkb-db-latest.db' });
    // 同名的旧资产先删，保证「只保留最近一份」
    for (const asset of release.assets) {
      if (asset.name !== 'jwkb-db-latest.db') continue;
      await fetch(asset.url, { method: 'DELETE', headers: githubHeaders(token), signal: AbortSignal.timeout(CLOUD_WEBDAV_TIMEOUT_MS) });
    }
    const upload = await fetch(`${release.uploadUrl.split('{')[0]}?name=jwkb-db-latest.db`, {
      method: 'POST',
      headers: githubHeaders(token, { 'Content-Type': 'application/octet-stream' }),
      body: fs.readFileSync(snapshot),
      signal: AbortSignal.timeout(CLOUD_WEBDAV_TIMEOUT_MS)
    });
    if (!upload.ok) throw new Error(`GitHub 上传备份失败（HTTP ${upload.status}）`);
    return { provider: 'github', createdAt, dbBytes, attachmentCount: 0, attachmentBytes: 0 };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

export async function githubInfo(fetch: CloudFetch = netCloudFetch): Promise<CloudBackupInfo | null> {
  const { token, repo } = requireGithub();
  try {
    const release = await githubRelease(token, repo, fetch);
    const manifest = JSON.parse(release.body) as CloudManifest;
    return {
      provider: 'github',
      createdAt: manifest.createdAt,
      dbBytes: manifest.dbBytes,
      attachmentCount: 0,
      attachmentBytes: 0
    };
  } catch (err) {
    if (/还没有云端备份/.test(describeCloudError(err))) return null;
    throw err;
  }
}

export async function githubRestore(paths: DataPaths, fetch: CloudFetch = netCloudFetch): Promise<CloudRestoreResult> {
  const { token, repo } = requireGithub();
  const release = await githubRelease(token, repo, fetch);
  const asset = release.assets.find((a) => a.name === 'jwkb-db-latest.db');
  if (!asset) throw new Error('GitHub 备份里缺少数据库文件');
  const manifest = JSON.parse(release.body) as CloudManifest;
  const download = await fetch(asset.url, {
    method: 'GET',
    headers: githubHeaders(token, { Accept: 'application/octet-stream' }),
    signal: AbortSignal.timeout(CLOUD_WEBDAV_TIMEOUT_MS)
  });
  if (!download.ok) throw new Error(`GitHub 下载备份失败（HTTP ${download.status}）`);
  const work = fs.mkdtempSync(path.join(paths.root, '.cloud-gh-restore-'));
  try {
    const dbFile = path.join(work, 'kb.db');
    fs.writeFileSync(dbFile, Buffer.from(await download.arrayBuffer()));
    const applied = applyRestore(paths, dbFile, []);
    return { provider: 'github', createdAt: manifest.createdAt, preRestore: applied.preRestore, attachmentCount: 0 };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/* ---------------- 统一入口 ---------------- */

export async function runCloudBackup(
  paths: DataPaths,
  transport: WebdavTransport = nodeWebdavTransport,
  fetch: CloudFetch = netCloudFetch
): Promise<CloudBackupInfo> {
  const provider = publicCloudConfig().provider;
  try {
    return provider === 'github' ? await githubBackup(paths.root, fetch) : await webdavBackup(paths, transport);
  } catch (err) {
    throw new Error(describeCloudError(err));
  }
}

export async function cloudTest(transport: WebdavTransport = nodeWebdavTransport): Promise<CloudTestResult> {
  const cfg = publicCloudConfig();
  if (cfg.provider === 'github') {
    requireGithub();
    return { ok: true, detail: 'GitHub 备份仓库已配置，且当前授权可用' };
  }
  return webdavTest(transport);
}

export async function cloudBackupInfo(
  transport: WebdavTransport = nodeWebdavTransport,
  fetch: CloudFetch = netCloudFetch
): Promise<CloudBackupInfo | null> {
  const provider = publicCloudConfig().provider;
  try {
    return provider === 'github' ? await githubInfo(fetch) : await webdavInfo(transport);
  } catch (err) {
    throw new Error(describeCloudError(err));
  }
}

/** 恢复：调用方（IPC）必须已经校验 CONFIRM / 勾选，这里再执行不可逆替换。 */
export async function runCloudRestore(
  paths: DataPaths,
  transport: WebdavTransport = nodeWebdavTransport,
  fetch: CloudFetch = netCloudFetch
): Promise<CloudRestoreResult> {
  const provider = publicCloudConfig().provider;
  try {
    return provider === 'github' ? await githubRestore(paths, fetch) : await webdavRestore(paths, transport);
  } catch (err) {
    throw new Error(describeCloudError(err));
  }
}

/** 应用恢复：先把当前数据另存「恢复前_」快照，再替换数据库，最后覆盖附件。 */
function applyRestore(paths: DataPaths, dbFile: string, attachments: Array<{ rel: string; file: string }>): { preRestore: string } {
  const name = `云端_${stampLocal()}`;
  const dir = path.join(paths.backups, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(dbFile, path.join(dir, CLOUD_DB_NAME));
  const result = backup.restoreBackup(paths, name);
  for (const item of attachments) {
    const dest = path.join(paths.attachments, item.rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(item.file, dest);
  }
  db.rebuildSearchIndex();
  return result;
}

/** 给设置页显示「已加密」用（不暴露明文）。 */
export function cloudPasswordEncrypted(): boolean {
  return Boolean(readPassword()) ? (db.getSetting(KEY_WEBDAV_PASS_ENC) ?? '0') === '1' : encryptionAvailable();
}

export { backupStamp };
