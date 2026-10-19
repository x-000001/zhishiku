import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as db from '../../src/main/db';
import { ensureDirs } from '../../src/main/paths';
import { GithubError, mapIssueToTask, type GithubIssue } from '../../src/main/github';
import { describeSyncResult, syncGithubIssues, type GithubSyncDeps } from '../../src/main/github-sync';
import type { GithubSyncProgress, GithubRepoMeta } from '../../src/shared/github';

/* ------------------------------------------------------------------ */
/* 假依赖：网络/事务/落库全用内存实现，跑起来不碰真库、不联网            */
/* ------------------------------------------------------------------ */

function issue(number: number, over: Partial<GithubIssue> = {}): GithubIssue {
  return {
    number,
    title: `issue ${number}`,
    body: '正文',
    state: 'open',
    html_url: `https://github.com/o/r/issues/${number}`,
    updated_at: '2026-10-01T00:00:00Z',
    closed_at: null,
    labels: [],
    milestone: null,
    ...over
  };
}

interface Harness {
  deps: GithubSyncDeps;
  progress: GithubSyncProgress[];
  metaPatches: Array<{ repo: string; patch: { lastSyncedAt?: string | null; lastError?: string | null } }>;
  transactions: number;
  upserts: Array<{ repo: string; number: number }>;
}

function makeHarness(options: {
  meta?: Record<string, GithubRepoMeta>;
  repos?: Record<string, Array<GithubIssue> | Error>;
  pruned?: Record<string, number>;
  upsert?: (issue: GithubIssue, repo: string) => 'created' | 'updated' | 'skipped';
}): Harness {
  const meta = new Map(Object.entries(options.meta ?? {}));
  const progress: GithubSyncProgress[] = [];
  const metaPatches: Harness['metaPatches'] = [];
  const upserts: Harness['upserts'] = [];
  const harness: Harness = {
    progress,
    metaPatches,
    upserts,
    transactions: 0,
    deps: {
      fetchIssues: async (repo) => {
        const rows = options.repos?.[repo];
        if (!rows) return { issues: [], pruned: 0, pages: 1 };
        if (rows instanceof Error) throw rows;
        return { issues: rows, pruned: options.pruned?.[repo] ?? 0, pages: 1 };
      },
      getMeta: (repo) => meta.get(repo) ?? null,
      transaction: (fn) => {
        harness.transactions += 1;
        const snapshot = new Map(meta);
        try {
          return fn();
        } catch (err) {
          // 模拟 SQLite 回滚：meta 回到事务前
          meta.clear();
          for (const [key, value] of snapshot) meta.set(key, value);
          throw err;
        }
      },
      upsertTask: (row, repo) => {
        upserts.push({ repo, number: row.number });
        return options.upsert ? options.upsert(row, repo) : 'created';
      },
      saveMeta: (repo, patch) => {
        metaPatches.push({ repo, patch });
        const before = meta.get(repo) ?? { repo, lastSyncedAt: null, lastError: null };
        meta.set(repo, {
          repo,
          lastSyncedAt: patch.lastSyncedAt !== undefined ? patch.lastSyncedAt : before.lastSyncedAt,
          lastError: patch.lastError !== undefined ? patch.lastError : before.lastError
        });
      },
      now: () => new Date('2026-10-19T12:00:00Z'),
      onProgress: (p) => progress.push(p)
    }
  };
  return harness;
}

/* ------------------------------------------------------------------ */
/* 同步编排                                                            */
/* ------------------------------------------------------------------ */

describe('GitHub 同步：多仓库串行与容错', () => {
  it('一个仓库失败不影响后面的仓库；成功仓库才推进增量游标', async () => {
    const harness = makeHarness({
      repos: {
        'bad/repo': new GithubError('network', '连不上 GitHub，请检查网络或代理设置'),
        'good/repo': [issue(1), issue(2)]
      }
    });
    const result = await syncGithubIssues(harness.deps, ['bad/repo', 'good/repo']);

    expect(result.repoTotal).toBe(2);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].repo).toBe('bad/repo');
    expect(result.failed[0].kind).toBe('network');
    expect(result.created).toBe(2);
    expect(harness.transactions).toBe(1);
    expect(harness.metaPatches.some((p) => p.repo === 'bad/repo' && p.patch.lastError)).toBe(true);
    expect(harness.metaPatches.some((p) => p.repo === 'good/repo' && p.patch.lastSyncedAt)).toBe(true);
  });

  it('进度按 开始 → 每仓库 → 完成 推送，序号从 1 起', async () => {
    const harness = makeHarness({ repos: { 'a/b': [issue(1)], 'c/d': [issue(2)] } });
    await syncGithubIssues(harness.deps, ['a/b', 'c/d']);
    expect(harness.progress.map((p) => p.phase)).toEqual(['start', 'repo', 'repo', 'done']);
    expect(harness.progress[1].repoIndex).toBe(1);
    expect(harness.progress[1].repoTotal).toBe(2);
    expect(harness.progress[2].repoIndex).toBe(2);
  });

  it('游标用上次成功时间作为 since；没有游标时传 null（全量）', async () => {
    const harness = makeHarness({
      meta: { 'a/b': { repo: 'a/b', lastSyncedAt: '2026-09-01T00:00:00Z', lastError: null } },
      repos: { 'a/b': [], 'c/d': [] }
    });
    const seen: Array<string | null> = [];
    const deps: GithubSyncDeps = {
      ...harness.deps,
      fetchIssues: async (_repo, since) => {
        seen.push(since);
        return { issues: [], pruned: 0, pages: 1 };
      }
    };
    await syncGithubIssues(deps, ['a/b', 'c/d']);
    expect(seen).toEqual(['2026-09-01T00:00:00Z', null]);
  });

  it('401 会把 authExpired 标记出来（渲染层据此回设置页）', async () => {
    const harness = makeHarness({
      repos: { 'a/b': new GithubError('unauthorized', 'GitHub 授权已失效（HTTP 401）') }
    });
    const result = await syncGithubIssues(harness.deps, ['a/b']);
    expect(result.authExpired).toBe(true);
    expect(result.failed[0].kind).toBe('unauthorized');
  });

  it('事务里抛错：这个仓库算失败，数据回滚，游标不推进', async () => {
    const harness = makeHarness({
      repos: { 'a/b': [issue(1)] },
      upsert: () => {
        throw new Error('数据库写坏了');
      }
    });
    const result = await syncGithubIssues(harness.deps, ['a/b']);
    expect(result.succeeded).toBe(0);
    expect(result.failed[0].error).toContain('数据库写坏了');
    expect(harness.metaPatches.some((p) => p.patch.lastSyncedAt)).toBe(false);
    expect(harness.metaPatches.some((p) => p.patch.lastError?.includes('数据库写坏了'))).toBe(true);
  });

  it('空仓库列表直接返回，不发请求、不推进度', async () => {
    const harness = makeHarness({});
    const result = await syncGithubIssues(harness.deps, []);
    expect(result.repoTotal).toBe(0);
    expect(harness.progress).toHaveLength(0);
    expect(harness.transactions).toBe(0);
  });

  it('PR 过滤数量会汇总进 pruned，汇总文案带数字', async () => {
    const harness = makeHarness({
      repos: { 'a/b': [issue(1), issue(2)] },
      pruned: { 'a/b': 3 },
      upsert: () => 'updated'
    });
    const result = await syncGithubIssues(harness.deps, ['a/b']);
    expect(result.pruned).toBe(3);
    expect(result.updated).toBe(2);
    expect(describeSyncResult(result)).toContain('过滤掉 3 个 PR');
  });
});

/* ------------------------------------------------------------------ */
/* 真库集成：迁移 + upsert 去重 + 游标表                                */
/* ------------------------------------------------------------------ */

let root = '';

afterEach(() => {
  try {
    db.closeDatabase();
  } catch {
    /* 没打开 */
  }
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = '';
});

function openFresh(): void {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'jwkb-gh-'));
  const paths = ensureDirs(root);
  db.openDatabase(paths);
}

describe('GitHub 同步：数据库层', () => {
  it('迁移到 v7：task 有两个新列和部分唯一索引，github_sync_meta 存在', () => {
    openFresh();
    const raw = db.getRawDb();
    const version = raw.prepare('pragma user_version').get() as { user_version: number };
    expect(Number(version.user_version)).toBe(7);
    const cols = raw.prepare('pragma table_info(task)').all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toEqual(expect.arrayContaining(['github_issue_id', 'github_updated_at']));
    const indexes = raw.prepare('pragma index_list(task)').all() as Array<{ name: string }>;
    expect(indexes.map((i) => i.name)).toContain('idx_task_github_issue');
    const tables = raw
      .prepare("select name from sqlite_master where type = 'table' and name = 'github_sync_meta'")
      .all();
    expect(tables).toHaveLength(1);
  });

  it('同一个 issue 同步两次：第一次 created、第二次 skipped（updated_at 没变）', () => {
    openFresh();
    const row = issue(7);
    expect(db.upsertGithubTask(row, 'foo/bar')).toBe('created');
    expect(db.upsertGithubTask(row, 'foo/bar')).toBe('skipped');
    const tasks = db.listTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe('issue 7');
  });

  it('issue 更新后变成 modified：标题/状态/完成时间都会覆盖', () => {
    openFresh();
    db.upsertGithubTask(issue(7), 'foo/bar');
    const changed = issue(7, {
      title: '换个标题',
      state: 'closed',
      closed_at: '2026-10-02T00:00:00Z',
      updated_at: '2026-10-02T00:00:00Z',
      labels: [{ name: 'bug' }]
    });
    expect(db.upsertGithubTask(changed, 'foo/bar')).toBe('updated');
    const task = db.listTasks()[0];
    expect(task.title).toBe('换个标题');
    expect(task.status).toBe('done');
    expect(task.priority).toBe('important');
    expect(task.completed_at).toBe('2026-10-02T00:00:00Z');
  });

  it('本地手动删掉的同步任务不会被重新复活', () => {
    openFresh();
    db.upsertGithubTask(issue(7), 'foo/bar');
    const task = db.listTasks()[0];
    db.deleteTask(task.id);
    const changed = issue(7, { title: '远端改了', updated_at: '2026-10-03T00:00:00Z' });
    expect(db.upsertGithubTask(changed, 'foo/bar')).toBe('skipped');
    expect(db.listTasks()).toHaveLength(0);
  });

  it('github_sync_meta：只更新传进来的字段，全表按仓库名排序', () => {
    openFresh();
    expect(db.githubRepoMeta('a/b')).toBeNull();
    db.saveGithubRepoMeta('a/b', { lastSyncedAt: '2026-10-01T00:00:00Z' });
    db.saveGithubRepoMeta('c/d', { lastError: '网络超时' });
    expect(db.githubRepoMeta('a/b')).toEqual({
      repo: 'a/b',
      lastSyncedAt: '2026-10-01T00:00:00Z',
      lastError: null
    });
    db.saveGithubRepoMeta('a/b', { lastError: '限流' });
    expect(db.githubRepoMeta('a/b')?.lastSyncedAt).toBe('2026-10-01T00:00:00Z');
    expect(db.githubRepoMeta('a/b')?.lastError).toBe('限流');
    db.saveGithubRepoMeta('a/b', { lastSyncedAt: '2026-10-05T00:00:00Z', lastError: null });
    expect(db.githubRepoMeta('a/b')).toEqual({
      repo: 'a/b',
      lastSyncedAt: '2026-10-05T00:00:00Z',
      lastError: null
    });
    expect(db.githubRepoMetaAll().map((m) => m.repo)).toEqual(['a/b', 'c/d']);
  });

  it('runInTransaction 抛错会整体回滚，不留下半条数据', () => {
    openFresh();
    expect(() =>
      db.runInTransaction(() => {
        db.upsertGithubTask(issue(1), 'foo/bar');
        throw new Error('中途失败');
      })
    ).toThrow('中途失败');
    expect(db.listTasks()).toHaveLength(0);
  });

  it('数据库里的行能和同步引擎的映射对得上（github_issue_id 是 owner/repo#number）', () => {
    openFresh();
    db.upsertGithubTask(issue(9), 'foo/bar');
    const raw = db.getRawDb();
    const stored = raw
      .prepare('select github_issue_id, github_updated_at from task where github_issue_id is not null')
      .get() as { github_issue_id: string; github_updated_at: string };
    const mapped = mapIssueToTask(issue(9), 'foo/bar');
    expect(stored.github_issue_id).toBe('foo/bar#9');
    expect(stored.github_updated_at).toBe(mapped.githubUpdatedAt);
  });
});
