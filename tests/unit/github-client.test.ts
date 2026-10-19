import { describe, expect, it } from 'vitest';
import {
  GITHUB_AUTH_ERRORS,
  formatSyncProgress,
  formatSyncSummary,
  githubIssueKey,
  isValidRepoName,
  normalizeRepoName,
  parseRepoList,
  splitRepo
} from '../../src/shared/github';
import {
  GithubError,
  describeGithubError,
  fetchAuthenticatedUser,
  fetchRepoIssues,
  githubErrorKind,
  listIssuesPage,
  mapIssueToTask,
  pollAccessToken,
  requestDeviceCode,
  toSinceIso,
  type GithubFetcher,
  type GithubIssue,
  type GithubResponse
} from '../../src/main/github';

/* ------------------------------------------------------------------ */
/* 测试道具                                                             */
/* ------------------------------------------------------------------ */

function response(
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): GithubResponse {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    text: async () => text
  };
}

/** 按顺序返回预置响应，并把每次请求的 url / body 记下来。 */
function scriptedFetcher(steps: Array<GithubResponse | Error>): {
  fetcher: GithubFetcher;
  calls: Array<{ url: string; method: string; body?: string; headers: Record<string, string> }>;
} {
  const calls: Array<{ url: string; method: string; body?: string; headers: Record<string, string> }> = [];
  let index = 0;
  const fetcher: GithubFetcher = async (url, init) => {
    calls.push({ url, method: init.method ?? 'GET', body: init.body, headers: init.headers });
    const step = steps[index];
    index += 1;
    if (!step) throw new Error('测试里没有给第 ' + index + ' 个响应');
    if (step instanceof Error) throw step;
    return step;
  };
  return { fetcher, calls };
}

function issue(over: Partial<GithubIssue> = {}): GithubIssue {
  return {
    number: 1,
    title: '修一个 bug',
    body: '正文',
    state: 'open',
    html_url: 'https://github.com/o/r/issues/1',
    updated_at: '2026-10-01T00:00:00Z',
    closed_at: null,
    labels: [],
    milestone: null,
    ...over
  };
}

/* ------------------------------------------------------------------ */
/* 仓库名校验（阶段 1 前端保存前也会用到）                              */
/* ------------------------------------------------------------------ */

describe('GitHub：仓库名与配置整理', () => {
  it('接受 owner/repo，拒绝空格、缺斜杠和超长', () => {
    expect(isValidRepoName('x-000001/zhishiku')).toBe(true);
    expect(isValidRepoName('foo/bar.baz_qux-1')).toBe(true);
    expect(isValidRepoName('foo bar/x')).toBe(false);
    expect(isValidRepoName('foo')).toBe(false);
    expect(isValidRepoName('foo/')).toBe(false);
    expect(isValidRepoName('')).toBe(false);
    expect(normalizeRepoName('https://github.com/foo/bar.git')).toBe('foo/bar');
    expect(normalizeRepoName('github.com/foo/bar')).toBe('foo/bar');
  });

  it('parseRepoList 去空、去重、丢掉非法项，并保留大小写', () => {
    expect(parseRepoList('owner/Repo, other/repo\n\thello world\n')).toEqual(['owner/Repo', 'other/repo']);
    expect(parseRepoList(['a/b', 'a/b', 'nope'])).toEqual(['a/b']);
    expect(parseRepoList('')).toEqual([]);
  });

  it('splitRepo / githubIssueKey 用 GitHub 序号拼接跨仓库唯一键', () => {
    expect(splitRepo('foo/bar')).toEqual({ owner: 'foo', name: 'bar' });
    expect(splitRepo('nope')).toBeNull();
    expect(githubIssueKey('foo/bar', 12)).toBe('foo/bar#12');
    expect(githubIssueKey(' foo/bar ', 12)).toBe('foo/bar#12');
  });

  it('进度与结果文案带仓库序号和数字', () => {
    expect(formatSyncProgress({ phase: 'repo', repoIndex: 2, repoTotal: 3, repo: 'a/b', fetched: 40 })).toContain(
      '(2/3)：a/b'
    );
    expect(
      formatSyncSummary({
        repoTotal: 3,
        succeeded: 2,
        failed: [{ repo: 'a/c', error: '超时' }],
        fetched: 120,
        created: 5,
        updated: 2,
        skipped: 1,
        pruned: 3,
        authExpired: false
      })
    ).toContain('成功 2 个仓库，失败 1 个，新增 5 条任务');
  });
});

/* ------------------------------------------------------------------ */
/* HTTP 状态码 → 中文与错误分类                                         */
/* ------------------------------------------------------------------ */

describe('GitHub：API 错误分类', () => {
  it('401 抛 unauthorized，前端据此回设置页重新授权', async () => {
    const { fetcher } = scriptedFetcher([response(401, { message: 'Bad credentials' })]);
    await expect(fetchAuthenticatedUser({ fetcher, token: 'bad' })).rejects.toMatchObject({
      kind: 'unauthorized'
    });
  });

  it('403 + x-ratelimit-remaining=0 报限流；403 无额度信息报权限不足', async () => {
    const limited = scriptedFetcher([
      response(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0' })
    ]);
    await expect(fetchAuthenticatedUser({ fetcher: limited.fetcher, token: 't' })).rejects.toMatchObject({
      kind: 'rate_limited'
    });

    const denied = scriptedFetcher([response(403, { message: 'Forbidden' })]);
    await expect(fetchAuthenticatedUser({ fetcher: denied.fetcher, token: 't' })).rejects.toMatchObject({
      kind: 'forbidden'
    });
  });

  it('403 + retry-after 把秒数换算成中文等待时间', async () => {
    const { fetcher } = scriptedFetcher([response(403, { message: 'slow down' }, { 'retry-after': '120' })]);
    await expect(fetchAuthenticatedUser({ fetcher, token: 't' })).rejects.toThrow(/2 分钟/);
  });

  it('404 报「仓库或 Issue 不存在，或没有权限」', async () => {
    const { fetcher } = scriptedFetcher([response(404, { message: 'Not Found' })]);
    await expect(fetchAuthenticatedUser({ fetcher, token: 't' })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('429 与 5xx 都有中文文案', async () => {
    const tooMany = scriptedFetcher([response(429, { message: 'too many' })]);
    await expect(fetchAuthenticatedUser({ fetcher: tooMany.fetcher, token: 't' })).rejects.toThrow(/429/);

    const boom = scriptedFetcher([response(502, '<html>bad gateway</html>')]);
    await expect(fetchAuthenticatedUser({ fetcher: boom.fetcher, token: 't' })).rejects.toThrow(/HTTP 502/);
  });

  it('网络错误/超时/取消分别归类', async () => {
    const offline = scriptedFetcher([new Error('net::ERR_INTERNET_DISCONNECTED')]);
    await expect(fetchAuthenticatedUser({ fetcher: offline.fetcher, token: 't' })).rejects.toMatchObject({
      kind: 'network'
    });
    const offline2 = scriptedFetcher([new Error('net::ERR_INTERNET_DISCONNECTED')]);
    await expect(fetchAuthenticatedUser({ fetcher: offline2.fetcher, token: 't' })).rejects.toThrow(
      /连不上 GitHub/
    );

    const controller = new AbortController();
    controller.abort();
    const pending = scriptedFetcher([new Error('aborted')]);
    await expect(
      fetchAuthenticatedUser({ fetcher: pending.fetcher, token: 't', signal: controller.signal })
    ).rejects.toMatchObject({ kind: 'canceled' });
  });

  it('超时会被翻译成「N 秒没有响应」', async () => {
    const hang: GithubFetcher = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('AbortError')), { once: true });
      });
    await expect(
      fetchAuthenticatedUser({ fetcher: hang, token: 't', timeoutMs: 5 })
    ).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('describeGithubError / githubErrorKind 对普通错误也安全', () => {
    expect(describeGithubError(new GithubError('network', '连不上'))).toBe('连不上');
    expect(describeGithubError(new Error('普通错误'))).toBe('普通错误');
    expect(describeGithubError('字符串')).toBe('GitHub 请求失败（未知原因）');
    expect(githubErrorKind(new Error('x'))).toBeUndefined();
    expect(githubErrorKind(new GithubError('not_found', 'x'))).toBe('not_found');
  });
});

/* ------------------------------------------------------------------ */
/* Device Flow                                                         */
/* ------------------------------------------------------------------ */

describe('GitHub：OAuth Device Flow', () => {
  it('没配 Client ID 时直接报可操作的提示', async () => {
    await expect(
      requestDeviceCode({ fetcher: async () => response(200, {}), clientId: '' })
    ).rejects.toThrow(GITHUB_AUTH_ERRORS.clientId);
  });

  it('requestDeviceCode 解析设备码并给出可复制的用户码', async () => {
    const { fetcher, calls } = scriptedFetcher([
      response(200, {
        device_code: 'dev-123',
        user_code: 'WXYZ-1234',
        verification_uri: 'https://github.com/login/device',
        expires_in: 900,
        interval: 5
      })
    ]);
    const code = await requestDeviceCode({ fetcher, clientId: 'client-1' });
    expect(code).toEqual({
      deviceCode: 'dev-123',
      userCode: 'WXYZ-1234',
      verificationUri: 'https://github.com/login/device',
      expiresIn: 900,
      interval: 5
    });
    expect(calls[0].url).toBe('https://github.com/login/device/code');
    expect(calls[0].body).toContain('client_id=client-1');
  });

  it('pollAccessToken：authorization_pending → 授权成功后返回 token', async () => {
    const { fetcher, calls } = scriptedFetcher([
      response(200, { error: 'authorization_pending' }),
      response(200, { access_token: 'gho_test_token' })
    ]);
    const token = await pollAccessToken({
      fetcher,
      clientId: 'client-1',
      deviceCode: 'dev-123',
      interval: 1,
      sleep: async () => {}
    });
    expect(token).toBe('gho_test_token');
    expect(calls).toHaveLength(2);
  });

  it('pollAccessToken：慢速轮询会拉长间隔；expired_token/access_denied 有中文文案', async () => {
    const slow = scriptedFetcher([
      response(200, { error: 'slow_down', interval: 10 }),
      response(200, { access_token: 'gho_x' })
    ]);
    const token = await pollAccessToken({
      fetcher: slow.fetcher,
      clientId: 'c',
      deviceCode: 'd',
      interval: 1,
      sleep: async () => {}
    });
    expect(token).toBe('gho_x');

    const expired = scriptedFetcher([response(200, { error: 'expired_token' })]);
    await expect(
      pollAccessToken({ fetcher: expired.fetcher, clientId: 'c', deviceCode: 'd', interval: 1, sleep: async () => {} })
    ).rejects.toThrow(GITHUB_AUTH_ERRORS.expired);

    const denied = scriptedFetcher([response(200, { error: 'access_denied' })]);
    await expect(
      pollAccessToken({ fetcher: denied.fetcher, clientId: 'c', deviceCode: 'd', interval: 1, sleep: async () => {} })
    ).rejects.toThrow(GITHUB_AUTH_ERRORS.denied);
  });

  it('pollAccessToken：15 分钟到期会自己停下（不无限轮询）', async () => {
    let clock = 0;
    let calls = 0;
    const fetcher: GithubFetcher = async () => {
      calls += 1;
      return response(200, { error: 'authorization_pending' });
    };
    await expect(
      pollAccessToken({
        fetcher,
        clientId: 'c',
        deviceCode: 'd',
        interval: 1,
        now: () => clock,
        sleep: async (ms) => {
          clock += Math.max(ms, 60_000);
        }
      })
    ).rejects.toThrow(/15 分钟/);
    // 时钟被假 sleep 推着走，到 15 分钟就自己停：请求次数是个小常数
    expect(calls).toBeLessThan(20);
  });
});

/* ------------------------------------------------------------------ */
/* Issues 分页 + PR 过滤                                                */
/* ------------------------------------------------------------------ */

describe('GitHub：issues 分页与 PR 过滤', () => {
  it('listIssuesPage 带 per_page=100 / state=all / since 的 ISO 8601', async () => {
    const { fetcher, calls } = scriptedFetcher([response(200, [issue()])]);
    const rows = await listIssuesPage(
      { fetcher, token: 't', apiBase: 'https://api.github.com' },
      { repo: 'foo/bar', since: '2026-10-01T00:00:00Z' }
    );
    expect(rows).toHaveLength(1);
    expect(calls[0].url).toContain('/repos/foo/bar/issues?');
    expect(calls[0].url).toContain('per_page=100');
    expect(calls[0].url).toContain('state=all');
    expect(calls[0].url).toContain('since=2026-10-01T00%3A00%3A00.000Z');
    expect(calls[0].headers.Authorization).toBe('Bearer t');
  });

  it('非法 since 当作全量（不带 since 参数）', async () => {
    const { fetcher, calls } = scriptedFetcher([response(200, [])]);
    await listIssuesPage({ fetcher, token: 't' }, { repo: 'foo/bar', since: 'not-a-date' });
    expect(calls[0].url).not.toContain('since=');
    expect(toSinceIso('not-a-date')).toBeUndefined();
    expect(toSinceIso('2026-10-01T08:00:00+08:00')).toBe('2026-10-01T00:00:00.000Z');
  });

  it('第一页 100 条 + 第二页 10 条：正好发两次请求就停', async () => {
    const page1 = Array.from({ length: 100 }, (_v, i) => issue({ number: i + 1 }));
    const page2 = Array.from({ length: 10 }, (_v, i) => issue({ number: 101 + i }));
    const { fetcher, calls } = scriptedFetcher([response(200, page1), response(200, page2)]);
    const out = await fetchRepoIssues({ fetcher, token: 't' }, { repo: 'foo/bar' });
    expect(out.issues).toHaveLength(110);
    expect(out.pages).toBe(2);
    expect(calls).toHaveLength(2);
    expect(calls[1].url).toContain('page=2');
  });

  it('PR 会被过滤掉并计入 pruned', async () => {
    const { fetcher } = scriptedFetcher([
      response(200, [issue({ number: 1 }), issue({ number: 2, pull_request: { url: 'x' } }), issue({ number: 3 })])
    ]);
    const out = await fetchRepoIssues({ fetcher, token: 't' }, { repo: 'foo/bar' });
    expect(out.issues.map((i) => i.number)).toEqual([1, 3]);
    expect(out.pruned).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* Issue → Task 字段映射                                               */
/* ------------------------------------------------------------------ */

describe('GitHub：Issue 映射成本地任务', () => {
  it('closed → done + completed_at；bug 标签 → important；milestone 日期 → due_at', () => {
    const mapped = mapIssueToTask(
      issue({
        number: 7,
        title: '  登录页崩了  ',
        state: 'closed',
        closed_at: '2026-09-30T12:00:00Z',
        labels: [{ name: 'bug' }, { name: 'P1' }],
        milestone: { due_on: '2026-10-20T00:00:00Z' }
      }),
      'foo/bar'
    );
    expect(mapped.githubIssueId).toBe('foo/bar#7');
    expect(mapped.title).toBe('登录页崩了');
    expect(mapped.status).toBe('done');
    expect(mapped.completedAt).toBe('2026-09-30T12:00:00Z');
    expect(mapped.priority).toBe('important');
    expect(mapped.dueAt).toBe('2026-10-20');
    expect(mapped.note).toContain('来自 GitHub：foo/bar #7');
    expect(mapped.note).toContain('https://github.com/o/r/issues/1');
  });

  it('普通 label 不会误判成 bug；空标题有兜底', () => {
    const mapped = mapIssueToTask(issue({ title: '   ', labels: [{ name: 'documentation' }] }), 'foo/bar');
    expect(mapped.priority).toBe('normal');
    expect(mapped.title).toBe('#1');
    expect(mapped.status).toBe('todo');
    expect(mapped.completedAt).toBeNull();
  });
});
