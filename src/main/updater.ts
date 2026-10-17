/**
 * 「下载并安装」的纯逻辑：把安装包从网络流式写到磁盘、边写边报进度、写完校验大小和 SHA256。
 * 网络和磁盘都通过注入的函数走，单测里换成假流 + 临时目录即可，不用启动 Electron、不用真联网。
 */
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream, createWriteStream, promises as fsp } from 'node:fs';

/** 网络流的最小抽象：真实实现是主进程的 net.fetch，单测里换成假的。 */
export interface DownloadStream {
  /** 响应头里的总字节数；拿不到就是 0 */
  total: number;
  body: AsyncIterable<Uint8Array>;
}

export type StreamOpener = (url: string, signal: AbortSignal) => Promise<DownloadStream>;

export interface DownloadProgress {
  phase: 'downloading' | 'verifying';
  received: number;
  total: number;
  percent: number;
}

export interface DownloadOptions {
  url: string;
  /** 安装包写到哪个文件 */
  dest: string;
  open: StreamOpener;
  signal: AbortSignal;
  /** GitHub 给的附件大小，用来校验；0 表示不校验 */
  expectedSize?: number;
  /** GitHub 给的 sha256（不带前缀），空串表示不校验 */
  expectedSha256?: string;
  onProgress?: (progress: DownloadProgress) => void;
  /** 测试用：替换 Date.now，方便断言节流 */
  now?: () => number;
}

/** 关掉写流并且等它真的关完：Windows 上文件句柄没释放时 unlink 会失败。 */
async function closeWriteStream(stream: ReturnType<typeof createWriteStream>): Promise<void> {
  if (stream.closed) return;
  stream.destroy();
  await once(stream, 'close').catch(() => undefined);
}

/** 下载失败时把半成品删掉，别在磁盘上留一个看着像安装包的残废文件。 */
async function removeQuietly(file: string): Promise<void> {
  await fsp.unlink(file).catch(() => undefined);
}

/** 文件名净化：只留最后一段、去掉 Windows 不允许的字符。 */
export function sanitizeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[<>:"|?*\u0000-\u001f]/g, '').trim();
  // 空名、'.'、'..'、'...' 这类只有点的名字都不可用（Windows 会把结尾的点吃掉）
  if (!cleaned || /^\.+$/.test(cleaned)) return 'JwKB-Setup.exe';
  return cleaned;
}

/** 算文件的 SHA256（小写、不带前缀）。 */
export async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(file);
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** 便携版（绿色版）启动时 electron-builder 会注入这两个环境变量；有就不是安装版。 */
export function portableFromEnv(env: NodeJS.ProcessEnv): string | null {
  return env.PORTABLE_EXECUTABLE_FILE?.trim() || env.PORTABLE_EXECUTABLE_DIR?.trim() || null;
}

/**
 * 流式下载到 dest，并做进度回报 + 大小/SHA256 校验。任何失败都会删掉半成品再抛中文错误。
 * 取消（signal.aborted）抛 name='AbortError' 的错误，调用方据此区分「用户取消」和「真的失败」。
 */
export async function downloadFile(options: DownloadOptions): Promise<{ size: number; sha256: string }> {
  const { url, dest, open, signal, onProgress } = options;
  const expectedSize = options.expectedSize && options.expectedSize > 0 ? options.expectedSize : 0;
  const expectedSha256 = (options.expectedSha256 ?? '').trim().toLowerCase();
  const now = options.now ?? Date.now;

  const stream = await open(url, signal);
  const total = expectedSize || stream.total || 0;
  let received = 0;
  let lastTick = 0;

  const report = (phase: 'downloading' | 'verifying', force = false): void => {
    if (!onProgress) return;
    const nowMs = now();
    if (!force && nowMs - lastTick < 100) return;
    lastTick = nowMs;
    const percent = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0;
    onProgress({ phase, received, total, percent });
  };

  const out = createWriteStream(dest);
  try {
    report('downloading', true);
    for await (const chunk of stream.body) {
      if (signal.aborted) {
        const err = new Error('下载已取消');
        err.name = 'AbortError';
        throw err;
      }
      const buffer = Buffer.from(chunk);
      received += buffer.length;
      if (!out.write(buffer)) await once(out, 'drain');
      report('downloading');
    }
    out.end();
    // 磁盘满这类错误只会从 write stream 冒出来，finish 永远不会到：两个事件都要等
    await new Promise<void>((resolve, reject) => {
      out.once('finish', resolve);
      out.once('error', reject);
    });
  } catch (err) {
    await closeWriteStream(out);
    await removeQuietly(dest);
    if (err instanceof Error && err.name === 'AbortError') throw err;
    if (signal.aborted) {
      const aborted = new Error('下载已取消');
      aborted.name = 'AbortError';
      throw aborted;
    }
    throw new Error('下载安装包失败：' + (err instanceof Error ? err.message : String(err)));
  }

  if (expectedSize > 0 && received !== expectedSize) {
    await removeQuietly(dest);
    throw new Error(`安装包大小不对（应为 ${expectedSize} 字节，实际 ${received} 字节），已删除，请重试`);
  }

  report('verifying', true);
  const sha256 = await sha256File(dest);
  if (expectedSha256 && sha256 !== expectedSha256) {
    await removeQuietly(dest);
    throw new Error('安装包校验没通过（SHA256 对不上），已删除；请重试或去下载页手动下载');
  }
  report('verifying', true);
  return { size: received, sha256 };
}
