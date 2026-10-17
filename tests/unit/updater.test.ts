import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  downloadFile,
  portableFromEnv,
  sanitizeFileName,
  sha256File,
  type DownloadStream,
  type StreamOpener
} from '../../src/main/updater';

let dir = '';

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'jwkb-updater-'));
});

afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

/** 把一段内容切成若干块，造出「网络流」。 */
function chunksOf(content: Buffer, chunkSize = 7): Uint8Array[] {
  const list: Uint8Array[] = [];
  for (let offset = 0; offset < content.length; offset += chunkSize) {
    list.push(content.subarray(offset, offset + chunkSize));
  }
  return list;
}

function fakeOpen(chunks: Uint8Array[], options: { total?: number; failAfter?: number } = {}): StreamOpener {
  return async (): Promise<DownloadStream> => ({
    total: options.total ?? chunks.reduce((sum, chunk) => sum + chunk.length, 0),
    body: (async function* () {
      let sent = 0;
      for (const chunk of chunks) {
        if (options.failAfter !== undefined && sent >= options.failAfter) throw new Error('socket hang up');
        sent += chunk.length;
        yield chunk;
      }
    })()
  });
}

const sha256 = (content: Buffer): string => createHash('sha256').update(content).digest('hex');

describe('文件名净化', () => {
  it('只留最后一段，去掉 Windows 不允许的字符', () => {
    expect(sanitizeFileName('C:\\Users\\a\\JwKB-Setup-0.5.0.exe')).toBe('JwKB-Setup-0.5.0.exe');
    expect(sanitizeFileName('../../evil.exe')).toBe('evil.exe');
    expect(sanitizeFileName('a<b>c:"d|e?f*g.exe')).toBe('abcdefg.exe');
  });

  it('空名字 / 只有点：退回默认名，绝不返回空串', () => {
    expect(sanitizeFileName('')).toBe('JwKB-Setup.exe');
    expect(sanitizeFileName('..')).toBe('JwKB-Setup.exe');
    expect(sanitizeFileName('...')).toBe('JwKB-Setup.exe');
  });
});

describe('便携版识别', () => {
  it('electron-builder 注入的 PORTABLE_* 环境变量才算便携版', () => {
    expect(portableFromEnv({})).toBeNull();
    expect(portableFromEnv({ PORTABLE_EXECUTABLE_FILE: 'D:\\Jw\\Jw知识库.exe' })).toBe('D:\\Jw\\Jw知识库.exe');
    expect(portableFromEnv({ PORTABLE_EXECUTABLE_DIR: 'D:\\Jw' })).toBe('D:\\Jw');
  });
});

describe('下载安装包', () => {
  it('按块落盘、报进度、算 SHA256；进度里 total 和 percent 都对', async () => {
    const content = Buffer.alloc(300, 7);
    const dest = path.join(dir, 'setup.exe');
    const progress: { received: number; total: number; percent: number; phase: string }[] = [];
    const result = await downloadFile({
      url: 'https://github.com/x/y/releases/download/v1/setup.exe',
      dest,
      open: fakeOpen(chunksOf(content)),
      signal: new AbortController().signal,
      expectedSize: content.length,
      expectedSha256: sha256(content),
      onProgress: (item) => progress.push({ ...item })
    });

    expect(result.size).toBe(300);
    expect(result.sha256).toBe(sha256(content));
    expect(await fsp.readFile(dest)).toEqual(content);
    // 第一次一定报（还是 0），最后一次报满 100
    expect(progress[0].phase).toBe('downloading');
    expect(progress.some((item) => item.phase === 'verifying')).toBe(true);
    expect(Math.max(...progress.map((item) => item.percent))).toBe(100);
  });

  it('大小对不上：报中文错误 + 删掉半成品', async () => {
    const dest = path.join(dir, 'size-mismatch.exe');
    await expect(
      downloadFile({
        url: 'https://github.com/x/y/setup.exe',
        dest,
        open: fakeOpen(chunksOf(Buffer.alloc(10, 1))),
        signal: new AbortController().signal,
        expectedSize: 999
      })
    ).rejects.toThrow('安装包大小不对');
    await expect(fsp.access(dest)).rejects.toThrow();
  });

  it('SHA256 对不上（文件被改过）：拒绝安装并删掉', async () => {
    const content = Buffer.from('hello updater');
    const dest = path.join(dir, 'sha-mismatch.exe');
    await expect(
      downloadFile({
        url: 'https://github.com/x/y/setup.exe',
        dest,
        open: fakeOpen(chunksOf(content)),
        signal: new AbortController().signal,
        expectedSize: content.length,
        expectedSha256: 'deadbeef'
      })
    ).rejects.toThrow('校验没通过');
    await expect(fsp.access(dest)).rejects.toThrow();
  });

  it('用户点取消：抛 AbortError（调用方据此不弹错误提示）+ 删掉半成品', async () => {
    const controller = new AbortController();
    const chunks = chunksOf(Buffer.alloc(50, 1), 5);
    const opener: StreamOpener = async () => ({
      total: 50,
      body: (async function* () {
        yield chunks[0];
        controller.abort();
        yield chunks[1];
      })()
    });
    const dest = path.join(dir, 'cancelled.exe');
    await expect(
      downloadFile({ url: 'https://github.com/x/y/setup.exe', dest, open: opener, signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' });
    await expect(fsp.access(dest)).rejects.toThrow();
  });

  it('网络中途断开：报「下载安装包失败」+ 删掉半成品', async () => {
    const dest = path.join(dir, 'broken.exe');
    await expect(
      downloadFile({
        url: 'https://github.com/x/y/setup.exe',
        dest,
        open: fakeOpen(chunksOf(Buffer.alloc(40, 1), 5), { failAfter: 10 }),
        signal: new AbortController().signal
      })
    ).rejects.toThrow('下载安装包失败');
    await expect(fsp.access(dest)).rejects.toThrow();
  });
});

describe('文件哈希', () => {
  it('sha256File 跟 node:crypto 算的一致', async () => {
    const content = Buffer.from('安装包内容');
    const file = path.join(dir, 'hash.bin');
    await fsp.writeFile(file, content);
    expect(await sha256File(file)).toBe(sha256(content));
  });
});
