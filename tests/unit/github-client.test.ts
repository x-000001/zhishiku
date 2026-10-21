import { describe, expect, it } from 'vitest';
import { GITHUB_README_LIMIT } from '../../src/shared/github';
import {
  GithubError,
  describeGithubError,
  fetchAuthenticatedUser,
  fetchRepoInfo,
  githubErrorKind,
  pollAccessToken,
  requestDeviceCode,
  type GithubFetcher,
  type GithubResponse
} from '../../src/main/github';
import type { GithubClient } from '../../src/main/github';

/* ------------------------------------------------------------------ */
/* 测试道具：可注入的假 fetcher（永不联网）                              */
/* ------------------------------------------------------------------ */

interface FakeCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function fakeFetcher(handler: (call: FakeCall) => GithubResponse | Promise<GithubResponse>): {
  fetcher: GithubFetcher;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];
  const fetcher: GithubFetcher = async (url, init) => {
    const call: FakeCall = {
      url,
      method: init.method ?? 'GET',
      headers: init.headers,
      body: init.body
    };
    calls.push(call);
    return handler(call);
  };
  return { fetcher, calls };
}

function res(status: number, body: string, headers: Record<string, string> = {}): GithubResponse {
  const lower: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) lower[key.toLowerCase()] = value;
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name: string) => lower[name.toLowerCase()] ?? null },
    text: async () => body
  };
}

function client(overrides: Partial<GithubClient> = {}): GithubClient {
  return {
    fetcher: fakeFetcher(() => res(200, '{}')).fetcher,
    token: 'gho_test',
    apiBase: 'https://api.github.test',
    ...overrides
  };
}

function repoJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    full_name: 'owner/repo',
    description: '一个测试仓库',
    stargazers_count: 1234,
    forks_count: 7,
    language: 'TypeScript',
    topics: ['cli', 'tools', ''],
    license: { spdx_id: 'MIT' },
    homepage: 'https://example.com',
    updated_at: '2026-10-01T00:00:00Z',
    html_url: 'https://github.com/owner/repo',
    default_branch: 'main',
    archived: false,
    ...overrides
  });
}

/* ------------------------------------------------------------------ */
/* 错误分类                                                             */
/* ------------------------------------------------------------------ */

describe('GitHub 错误分类（401 / 403 限流 / 404 / 429 / 5xx）', () => {
  it('401 → unauthorized，文案让用户回设置页重新连接', async () => {
    const err = await fetchRepoInfo(client({ fetcher: fakeFetcher(() => res(401, '{"message":"Bad credentials"}')).fetcher }), {
      url: 'owner/repo'
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GithubError);
    expect((err as GithubError).kind).toBe('unauthorized');
    expect((err as Error).message).toContain('授权已失效');
    expect((err as Error).message).toContain('设置页');
  });

  it('403 且额度为 0 → rate_limited，提示几分钟后再试', async () => {
    const err = await fetchRepoInfo(
      client({
        fetcher: fakeFetcher(() =>
          res(403, '{"message":"API rate limit exceeded"}', { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 600) })
        ).fetcher
      }),
      { url: 'owner/repo' }
    ).catch((e: unknown) => e);
    expect((err as GithubError).kind).toBe('rate_limited');
    expect((err as Error).message).toMatch(/请求太频繁|限流/);
    expect((err as Error).message).toMatch(/分钟/);
  });

  it('403 但没有限流特征 → forbidden（权限问题）', async () => {
    const err = await fetchRepoInfo(
      client({ fetcher: fakeFetcher(() => res(403, '{"message":"Resource not accessible"}')).fetcher }),
      { url: 'owner/repo' }
    ).catch((e: unknown) => e);
    expect((err as GithubError).kind).toBe('forbidden');
    expect((err as Error).message).toContain('HTTP 403');
  });

  it('404 → not_found（不存在或没权限）', async () => {
    const err = await fetchRepoInfo(client({ fetcher: fakeFetcher(() => res(404, '{"message":"Not Found"}')).fetcher }), {
      url: 'owner/repo'
    }).catch((e: unknown) => e);
    expect((err as GithubError).kind).toBe('not_found');
    expect((err as Error).message).toContain('HTTP 404');
  });

  it('429 → rate_limited；500 → bad_response', async () => {
    const e429 = await fetchRepoInfo(client({ fetcher: fakeFetcher(() => res(429, 'slow down')).fetcher }), {
      url: 'owner/repo'
    }).catch((e: unknown) => e);
    expect((e429 as GithubError).kind).toBe('rate_limited');

    const e500 = await fetchRepoInfo(client({ fetcher: fakeFetcher(() => res(500, 'boom')).fetcher }), {
      url: 'owner/repo'
    }).catch((e: unknown) => e);
    expect((e500 as GithubError).kind).toBe('bad_response');
    expect((e500 as Error).message).toContain('HTTP 500');
  });

  it('网络错误 → network 中文；超时 → timeout 中文', async () => {
    const netErr = await fetchRepoInfo(
      client({
        fetcher: async () => {
          throw new Error('net::ERR_INTERNET_DISCONNECTED');
        }
      }),
      { url: 'owner/repo' }
    ).catch((e: unknown) => e);
    expect((netErr as GithubError).kind).toBe('network');
    expect((netErr as Error).message).toContain('连不上 GitHub');

    const timeoutErr = await fetchRepoInfo(
      client({
        timeoutMs: 5,
        fetcher: (_url, init) =>
          new Promise<GithubResponse>((resolve, reject) => {
            const timer = setTimeout(() => resolve(res(200, repoJson())), 200);
            init.signal?.addEventListener('abort', () => {
              clearTimeout(timer);
              reject(new Error('AbortError: The operation was aborted'));
            });
          })
      }),
      { url: 'owner/repo' }
    ).catch((e: unknown) => e);
    expect((timeoutErr as GithubError).kind).toBe('timeout');
    expect((timeoutErr as Error).message).toContain('超时');
  });

  it('describeGithubError / githubErrorKind 给中文兜底', () => {
    expect(describeGithubError(new GithubError('network', '连不上 GitHub'))).toContain('连不上 GitHub');
    expect(describeGithubError(new Error('随便什么'))).toContain('随便什么');
    expect(githubErrorKind(new GithubError('timeout', 'x'))).toBe('timeout');
    expect(githubErrorKind(new Error('x'))).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* 拉取仓库信息（README 截断 / 脏 URL / 无 README）                      */
/* ------------------------------------------------------------------ */

describe('fetchRepoInfo', () => {
  it('脏 URL 也能清洗并带上正确请求路径与鉴权头', async () => {
    const fake = fakeFetcher((call) => {
      if (call.url.endsWith('/readme')) return res(200, '# Hello');
      return res(200, repoJson());
    });
    const info = await fetchRepoInfo(client({ fetcher: fake.fetcher }), {
      url: 'https://github.com/owner/repo.git/tree/main?tab=readme#top'
    });
    expect(info.repo).toBe('owner/repo');
    expect(info.stars).toBe(1234);
    expect(info.language).toBe('TypeScript');
    expect(info.topics).toEqual(['cli', 'tools']);
    expect(info.license).toBe('MIT');
    expect(fake.calls.some((c) => c.url === 'https://api.github.test/repos/owner/repo')).toBe(true);
    expect(fake.calls.every((c) => c.headers.Authorization === 'Bearer gho_test')).toBe(true);
    expect(fake.calls.every((c) => c.headers['X-GitHub-Api-Version'] === '2022-11-28')).toBe(true);
  });

  it('README 只保留前 8000 字并标记 truncated', async () => {
    const longReadme = 'x'.repeat(GITHUB_README_LIMIT + 2000);
    const fake = fakeFetcher((call) => (call.url.endsWith('/readme') ? res(200, longReadme) : res(200, repoJson())));
    const info = await fetchRepoInfo(client({ fetcher: fake.fetcher }), { url: 'owner/repo' });
    expect(info.readme?.length).toBe(GITHUB_README_LIMIT);
    expect(info.readmeTruncated).toBe(true);
  });

  it('README 接口 404 不算失败（有些仓库没有 README）', async () => {
    const fake = fakeFetcher((call) => (call.url.endsWith('/readme') ? res(404, '{"message":"Not Found"}') : res(200, repoJson())));
    const info = await fetchRepoInfo(client({ fetcher: fake.fetcher }), { url: 'owner/repo' });
    expect(info.readme).toBeNull();
    expect(info.readmeTruncated).toBe(false);
  });

  it('README 返回 base64 JSON 也能解码', async () => {
    const encoded = Buffer.from('# 解码成功', 'utf8').toString('base64');
    const fake = fakeFetcher((call) =>
      call.url.endsWith('/readme')
        ? res(200, JSON.stringify({ content: encoded.replace(/(.{8})/g, '$1\n'), encoding: 'base64' }))
        : res(200, repoJson())
    );
    const info = await fetchRepoInfo(client({ fetcher: fake.fetcher }), { url: 'owner/repo' });
    expect(info.readme).toBe('# 解码成功');
  });

  it('元信息缺字段时有默认值（不炸）', async () => {
    const fake = fakeFetcher((call) => (call.url.endsWith('/readme') ? res(404, '') : res(200, '{}')));
    const info = await fetchRepoInfo(client({ fetcher: fake.fetcher }), { url: 'owner/repo' });
    expect(info.stars).toBe(0);
    expect(info.language).toBeNull();
    expect(info.topics).toEqual([]);
    expect(info.defaultBranch).toBe('main');
    expect(info.htmlUrl).toBe('https://github.com/owner/repo');
  });
});

/* ------------------------------------------------------------------ */
/* Device Flow                                                          */
/* ------------------------------------------------------------------ */

describe('OAuth Device Flow', () => {
  it('requestDeviceCode：POST 到 /login/device/code 并解析字段', async () => {
    const fake = fakeFetcher(() =>
      res(
        200,
        JSON.stringify({
          device_code: 'dev-123',
          user_code: 'ABCD-1234',
          verification_uri: 'https://github.com/login/device',
          expires_in: 900,
          interval: 5
        })
      )
    );
    const code = await requestDeviceCode({ fetcher: fake.fetcher, clientId: 'lv1.abc', oauthBase: 'https://github.test' });
    expect(code.deviceCode).toBe('dev-123');
    expect(code.userCode).toBe('ABCD-1234');
    expect(code.interval).toBe(5);
    expect(code.verificationUri).toBe('https://github.com/login/device');
    expect(fake.calls[0].url).toBe('https://github.test/login/device/code');
    expect(fake.calls[0].method).toBe('POST');
    expect(fake.calls[0].body).toContain('client_id=lv1.abc');
    expect(fake.calls[0].body).toContain('scope=repo');
    expect(fake.calls[0].body).not.toContain('device_code');
  });

  it('pollAccessToken：authorization_pending 后拿到 token', async () => {
    let round = 0;
    const fake = fakeFetcher(() => {
      round += 1;
      if (round === 1) return res(200, JSON.stringify({ error: 'authorization_pending' }));
      if (round === 2) return res(200, JSON.stringify({ error: 'slow_down' }));
      return res(200, JSON.stringify({ access_token: 'gho_ok', token_type: 'bearer', scope: 'repo' }));
    });
    const token = await pollAccessToken({
      fetcher: fake.fetcher,
      clientId: 'lv1.abc',
      deviceCode: 'dev-123',
      interval: 0,
      expiresIn: 900,
      oauthBase: 'https://github.test',
      sleep: async () => undefined
    });
    expect(token).toBe('gho_ok');
    expect(fake.calls.length).toBe(3);
  });

  it('access_denied / expired_token 抛中文错误', async () => {
    const denied = await pollAccessToken({
      fetcher: fakeFetcher(() => res(200, JSON.stringify({ error: 'access_denied' }))).fetcher,
      clientId: 'lv1.abc',
      deviceCode: 'dev-123',
      interval: 0,
      expiresIn: 900,
      oauthBase: 'https://github.test',
      sleep: async () => undefined
    }).catch((e: unknown) => e);
    expect((denied as Error).message).toMatch(/拒绝|取消/);

    const expired = await pollAccessToken({
      fetcher: fakeFetcher(() => res(200, JSON.stringify({ error: 'expired_token' }))).fetcher,
      clientId: 'lv1.abc',
      deviceCode: 'dev-123',
      interval: 0,
      expiresIn: 900,
      oauthBase: 'https://github.test',
      sleep: async () => undefined
    }).catch((e: unknown) => e);
    expect((expired as Error).message).toMatch(/过期/);
  });

  it('fetchAuthenticatedUser 解析 login/头像', async () => {
    const fake = fakeFetcher(() =>
      res(200, JSON.stringify({ login: 'octocat', name: 'Octo', avatar_url: 'https://avatars.test/u.png' }))
    );
    const user = await fetchAuthenticatedUser({ fetcher: fake.fetcher, token: 'gho_x', apiBase: 'https://api.github.test' });
    expect(user).toEqual({ login: 'octocat', name: 'Octo', avatarUrl: 'https://avatars.test/u.png' });
    expect(fake.calls[0].url).toBe('https://api.github.test/user');
  });
});
