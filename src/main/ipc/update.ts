import { spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { app, BrowserWindow, net, shell } from 'electron';
import { checkUpdate, UPDATE_URL, type UpdateFetcher } from '../update';
import { downloadFile, portableFromEnv, sanitizeFileName, type StreamOpener } from '../updater';
import type {
  UpdateCheck,
  UpdateDownload,
  UpdateInstallResult,
  UpdateProgress,
  UpdateRelease
} from '../../shared/types';
import type { Handle } from './common';

/**
 * 真实的网络请求：走主进程的 net.fetch，不把任何网络库交给渲染层。
 * 5 秒超时由 checkUpdate 传进来的 AbortSignal 控制。
 */
const netFetcher: UpdateFetcher = async (url, init) => {
  const res = await net.fetch(url, { signal: init.signal, headers: init.headers });
  return { status: res.status, json: () => res.json() as Promise<unknown> };
};

const GITHUB_HOSTS = /^https:\/\/(api\.github\.com|github\.com|codeload\.github\.com|objects\.githubusercontent\.com)\//i;

/**
 * 下载地址白名单：生产环境只认 GitHub 的域名（地址是主进程自己从 Release 里取的，渲染层传不进来）。
 * 测试时 JWKB_UPDATE_URL 指向本地 stub，同一个源下的下载地址也放行。
 */
function assertDownloadUrl(url: string): void {
  const stub = process.env.JWKB_UPDATE_URL?.trim();
  if (stub) {
    try {
      if (url.startsWith(new URL(stub).origin + '/')) return;
    } catch {
      /* stub 地址不合法就按生产规则处理 */
    }
  }
  if (!GITHUB_HOSTS.test(url)) throw new Error('下载地址不是 GitHub 的，已拒绝');
}

/** 下载安装包用：GitHub 的下载地址会 302 到 objects.githubusercontent.com，net.fetch 自动跟跳。 */
const netStreamOpener: StreamOpener = async (url, signal) => {
  assertDownloadUrl(url);
  const res = await net.fetch(url, {
    signal,
    redirect: 'follow',
    headers: {
      Accept: 'application/octet-stream',
      'User-Agent': 'jw-knowledge-base-updater'
    }
  });
  if (!res.ok || !res.body) throw new Error('下载失败：GitHub 返回了 ' + res.status);
  const total = Number(res.headers.get('content-length') ?? 0) || 0;
  return {
    total,
    body: Readable.fromWeb(res.body as unknown as Parameters<typeof Readable.fromWeb>[0]) as AsyncIterable<Uint8Array>
  };
};

/**
 * 安装包放哪：默认系统临时目录下的独立子目录（装完可清，不占用户「下载」文件夹）。
 * 测试里用 JWKB_UPDATE_DIR 指到 e2e 数据目录，方便断言文件真的落盘。
 */
function updateDir(): string {
  return process.env.JWKB_UPDATE_DIR?.trim() || path.join(os.tmpdir(), 'jw-kb-update');
}

/** 测试模式：只走到「下载 + 校验」为止，不真的运行安装程序。 */
function isDryRun(): boolean {
  return process.env.JWKB_UPDATE_DRYRUN === '1';
}

/** 最近一次「检查更新」拿到的 Release：下载只认这里缓存的附件，渲染层传不进任意 URL。 */
let latestRelease: UpdateRelease | null = null;
/** 正在下载时的中断控制器；一次只允许一个下载。 */
let downloading: AbortController | null = null;
/** 最近一次下载好的安装包路径，供「立即安装」用。 */
let downloadedPath = '';

/** 进度只推给窗口，不写库：断网/关闭窗口都不影响本地数据。 */
function broadcastProgress(progress: UpdateProgress): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('update:progress', progress);
  }
}

/** 安装包必须落在我们自己的临时目录里（防渲染层传任意路径过来执行）。 */
async function assertInstallerPath(target: string): Promise<string> {
  const dir = path.resolve(updateDir());
  const file = path.resolve(target || downloadedPath);
  if (!file || path.dirname(file) !== dir) throw new Error('安装包路径不对，已拒绝');
  await fsp.access(file);
  return file;
}

/** 「检查更新 / 下载并安装」全部只在设置页手动触发：不轮询、不常驻、不碰数据库。 */
export function registerUpdate(handle: Handle): void {
  handle('update:check', async (): Promise<UpdateCheck> => {
    // 测试启动时会用 JWKB_UPDATE_URL 指向本地 stub 服务器；生产环境永远是 GitHub 官方接口。
    const url = process.env.JWKB_UPDATE_URL?.trim() || UPDATE_URL;
    const result = await checkUpdate(app.getVersion(), { fetcher: netFetcher, url });
    latestRelease = result.latest;
    return result;
  });

  handle('update:download', async (): Promise<UpdateDownload> => {
    const release = latestRelease;
    const asset = release?.installer;
    if (!release || !asset) throw new Error('这个版本没有上传安装包，只能去下载页手动下载');
    if (downloading) throw new Error('已经在下载了，稍等一下');
    const dir = updateDir();
    await fsp.mkdir(dir, { recursive: true });
    const dest = path.join(dir, sanitizeFileName(asset.name));
    const controller = new AbortController();
    downloading = controller;
    try {
      const { size } = await downloadFile({
        url: asset.url,
        dest,
        open: netStreamOpener,
        signal: controller.signal,
        expectedSize: asset.size,
        expectedSha256: asset.sha256,
        onProgress: broadcastProgress
      });
      downloadedPath = dest;
      return { path: dest, size, version: release.version };
    } finally {
      downloading = null;
    }
  });

  handle('update:cancel', (): boolean => {
    if (!downloading) return false;
    downloading.abort();
    return true;
  });

  handle('update:install', async (payload: { path?: string }): Promise<UpdateInstallResult> => {
    const file = await assertInstallerPath(String(payload?.path ?? ''));
    const portable = portableFromEnv(process.env);
    // 便携版是绿色运行，安装包会装到另一个位置，覆盖不了正在跑的 exe：只打开文件夹让用户手动替换
    if (portable) {
      shell.showItemInFolder(file);
      return { started: false, dryRun: false, portable: true, path: file };
    }
    if (isDryRun()) return { started: false, dryRun: true, portable: false, path: file };
    // /S = NSIS 静默安装：不弹向导，装完自动启动新版本（electron-builder 默认 runAfterFinish）
    const child = spawn(file, ['/S'], { detached: true, stdio: 'ignore' });
    child.unref();
    return { started: true, dryRun: false, portable: false, path: file };
  });

  handle('update:reveal', async (payload: { path?: string }): Promise<boolean> => {
    const file = await assertInstallerPath(String(payload?.path ?? ''));
    shell.showItemInFolder(file);
    return true;
  });

  /** 安装程序起来之后由渲染层调用：先把 toast 显示完再关应用。 */
  handle('update:quit', (): boolean => {
    setTimeout(() => app.quit(), 200);
    return true;
  });
}
