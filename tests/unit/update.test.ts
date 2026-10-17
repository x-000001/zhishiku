import { describe, expect, it } from 'vitest';
import {
  checkUpdate,
  compareVersion,
  isInstallerName,
  parseRelease,
  pickInstallerAsset,
  UPDATE_TIMEOUT_MS,
  UPDATE_URL,
  type UpdateFetcher
} from '../../src/main/update';
import type { UpdateAsset } from '../../src/shared/types';

/** 造一个假的网络层，顺便把调用参数记下来，验证 URL / 头 / 超时信号都传对了。 */
function fakeFetcher(
  status: number,
  body: unknown,
  options: { reject?: Error } = {}
): { fetcher: UpdateFetcher; calls: { url: string; headers: Record<string, string>; signal: AbortSignal }[] } {
  const calls: { url: string; headers: Record<string, string>; signal: AbortSignal }[] = [];
  const fetcher: UpdateFetcher = async (url, init) => {
    calls.push({ url, headers: init.headers, signal: init.signal });
    if (options.reject) throw options.reject;
    return { status, json: async () => body };
  };
  return { fetcher, calls };
}

const release = {
  tag_name: 'v0.3.1',
  html_url: 'https://github.com/x-000001/zhishiku/releases/tag/v0.3.1',
  body: '修了三个问题，加了设置页的检查更新。',
  published_at: '2026-10-18T10:00:00Z'
};

/** 一个像真实 Release 的附件列表：安装包 + blockmap + 绿色版压缩包 */
const assets = [
  {
    name: 'JwKB-Setup-0.5.0.exe',
    browser_download_url: 'https://github.com/x-000001/zhishiku/releases/download/v0.5.0/JwKB-Setup-0.5.0.exe',
    size: 112505769,
    digest: 'sha256:ABCDEF'
  },
  {
    name: 'JwKB-Setup-0.5.0.exe.blockmap',
    browser_download_url: 'https://github.com/x-000001/zhishiku/releases/download/v0.5.0/JwKB-Setup-0.5.0.exe.blockmap',
    size: 120000
  },
  {
    name: 'JwKB-Portable-0.5.0.zip',
    browser_download_url: 'https://github.com/x-000001/zhishiku/releases/download/v0.5.0/JwKB-Portable-0.5.0.zip',
    size: 247033856
  }
];

describe('版本号比较', () => {
  it('按数字段比，不是按字符串比', () => {
    expect(compareVersion('0.3.0', '0.3.1')).toBe(-1);
    expect(compareVersion('0.10.0', '0.9.9')).toBe(1);
    expect(compareVersion('0.3.0', '0.3.0')).toBe(0);
  });

  it('v 前缀、位数不同、预发布后缀都能处理', () => {
    expect(compareVersion('v0.3.0', '0.3.0')).toBe(0);
    expect(compareVersion('1.0', '1.0.0')).toBe(0);
    // 预发布版本当「不比自己新」处理，避免天天提示升级到 beta
    expect(compareVersion('0.3.0-beta.1', '0.3.0')).toBe(0);
  });
});

describe('解析 GitHub Release', () => {
  it('正常字段收拾成界面要的形状', () => {
    const parsed = parseRelease(release);
    expect(parsed.version).toBe('0.3.1');
    expect(parsed.tag).toBe('v0.3.1');
    expect(parsed.url).toContain('/releases/tag/v0.3.1');
    expect(parsed.notes).toContain('检查更新');
    expect(parsed.publishedAt).toBe('2026-10-18T10:00:00Z');
  });

  it('更新说明太长会截断', () => {
    const parsed = parseRelease({ ...release, body: 'x'.repeat(900) });
    expect(parsed.notes.length).toBe(601);
    expect(parsed.notes.endsWith('…')).toBe(true);
  });

  it('缺字段 / 格式不对时抛中文错误', () => {
    expect(() => parseRelease(null)).toThrow('不是对象');
    expect(() => parseRelease({})).toThrow('没有版本号');
    expect(() => parseRelease({ tag_name: '最新版' })).toThrow('版本号格式看不懂');
  });
});

describe('挑安装包（附件里混着 blockmap、绿色版压缩包）', () => {
  it('只认 .exe，且排除 blockmap / 更新元数据', () => {
    expect(isInstallerName('Jw知识库-安装包-0.5.0.exe')).toBe(true);
    expect(isInstallerName('JwKB-Setup-0.5.0.exe')).toBe(true);
    expect(isInstallerName('JwKB-Setup-0.5.0.exe.blockmap')).toBe(false);
    expect(isInstallerName('latest.yml')).toBe(false);
    expect(isInstallerName('portable.zip')).toBe(false);
  });

  it('优先名字像安装包的那个，其次挑最大的', () => {
    const picked = pickInstallerAsset(parseRelease({ ...release, assets }).assets);
    expect(picked?.name).toBe('JwKB-Setup-0.5.0.exe');
    expect(picked?.size).toBe(112505769);
    // digest 的 sha256: 前缀会去掉，比较时直接比十六进制
    expect(picked?.sha256).toBe('abcdef');

    const notNamed: UpdateAsset[] = [
      { name: 'a.exe', url: 'https://x', size: 10, sha256: '' },
      { name: 'b.exe', url: 'https://x', size: 20, sha256: '' }
    ];
    expect(pickInstallerAsset(notNamed)?.name).toBe('b.exe');
  });

  it('没有安装包时返回 null（界面就只给下载页链接）', () => {
    expect(pickInstallerAsset([])).toBeNull();
    expect(parseRelease({ ...release, assets: [{ name: 'a.zip', browser_download_url: 'https://x', size: 1 }] }).installer).toBeNull();
  });

  it('只有没发 Release 时才 404；检查结果里带着挑好的安装包', async () => {
    const result = await checkUpdate('0.4.0', { fetcher: fakeFetcher(200, { ...release, assets }).fetcher });
    expect(result.latest?.installer?.name).toBe('JwKB-Setup-0.5.0.exe');
    expect(result.latest?.assets).toHaveLength(3);
  });
});

describe('检查更新（注入假网络层，不真联网）', () => {
  it('GitHub 上有更新的版本：返回 newer + 最新版本信息', async () => {
    const { fetcher, calls } = fakeFetcher(200, release);
    const result = await checkUpdate('0.3.0', { fetcher });
    expect(result.status).toBe('newer');
    expect(result.current).toBe('0.3.0');
    expect(result.latest?.version).toBe('0.3.1');
    // URL 写死成 GitHub 官方接口；GitHub 要求带 User-Agent
    expect(calls[0].url).toBe(UPDATE_URL);
    expect(calls[0].headers['User-Agent']).toBeTruthy();
    expect(calls[0].headers.Accept).toContain('github');
    expect(calls[0].signal).toBeInstanceOf(AbortSignal);
  });

  it('版本一样或更旧：返回 latest，不提示升级', async () => {
    const same = await checkUpdate('0.3.1', { fetcher: fakeFetcher(200, release).fetcher });
    expect(same.status).toBe('latest');
    const newerLocal = await checkUpdate('0.3.2', { fetcher: fakeFetcher(200, release).fetcher });
    expect(newerLocal.status).toBe('latest');
  });

  it('仓库还没发过 Release（404）：当成「已是最新」，不算错误', async () => {
    const result = await checkUpdate('0.3.0', { fetcher: fakeFetcher(404, {}).fetcher });
    expect(result.status).toBe('no-release');
    expect(result.latest).toBeNull();
  });

  it('被限流（403/429）和服务器错误（500）都翻译成中文错误', async () => {
    await expect(checkUpdate('0.3.0', { fetcher: fakeFetcher(403, {}).fetcher })).rejects.toThrow('请求太频繁');
    await expect(checkUpdate('0.3.0', { fetcher: fakeFetcher(429, {}).fetcher })).rejects.toThrow('请求太频繁');
    await expect(checkUpdate('0.3.0', { fetcher: fakeFetcher(500, {}).fetcher })).rejects.toThrow('GitHub 返回了 500');
  });

  it('返回的不是 JSON：给出明确提示', async () => {
    const fetcher: UpdateFetcher = async () => ({
      status: 200,
      json: async () => {
        throw new Error('Unexpected token <');
      }
    });
    await expect(checkUpdate('0.3.0', { fetcher })).rejects.toThrow('不是有效 JSON');
  });

  it('超时：5 秒没响应就报「网络连接超时」，不会一直转圈', async () => {
    const abort = new Error('The operation was aborted');
    abort.name = 'AbortError';
    await expect(checkUpdate('0.3.0', { fetcher: fakeFetcher(0, {}, { reject: abort }).fetcher })).rejects.toThrow(
      `网络连接超时（${Math.round(UPDATE_TIMEOUT_MS / 1000)} 秒内没有响应），请检查网络后重试`
    );
    const timeout = new Error('The operation was aborted due to timeout');
    timeout.name = 'TimeoutError';
    await expect(checkUpdate('0.3.0', { fetcher: fakeFetcher(0, {}, { reject: timeout }).fetcher })).rejects.toThrow(
      '网络连接超时'
    );
  });

  it('连不上网（DNS/连接被拒）：提示检查网络，并且不影响本地功能', async () => {
    await expect(
      checkUpdate('0.3.0', { fetcher: fakeFetcher(0, {}, { reject: new Error('fetch failed') }).fetcher })
    ).rejects.toThrow('连不上网，请检查网络后重试（本地功能不受影响）');
    await expect(
      checkUpdate('0.3.0', { fetcher: fakeFetcher(0, {}, { reject: new Error('connect ECONNREFUSED 127.0.0.1:9') }).fetcher })
    ).rejects.toThrow('连不上网');
  });

  it('测试专用：可以指向别的地址（生产默认仍是 GitHub 官方接口）', async () => {
    const { fetcher, calls } = fakeFetcher(200, release);
    await checkUpdate('0.3.0', { fetcher, url: 'http://127.0.0.1:12345/releases/latest' });
    expect(calls[0].url).toBe('http://127.0.0.1:12345/releases/latest');
  });
});
