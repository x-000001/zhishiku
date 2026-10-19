/**
 * GitHub Issues 增量同步引擎（纯编排：数据库与网络都靠注入，不 import electron）。
 *
 * 阶段 2 的四个硬要求都在这里落地：
 * 1. 多仓库 **串行**（for...of），一个仓库失败只记录、不中断后面的仓库；
 * 2. 每个仓库一个 SQLite 事务：issue 行的写入要么全成、要么全退；
 * 3. 增量游标来自 `github_sync_meta.last_synced_at`（转成 ISO 8601 传给 since）；
 * 4. 进度通过 onProgress 回调往外抛，IPC 层再广播成 `github:progress` 事件。
 */
import {
  formatSyncSummary,
  type GithubRepoMeta,
  type GithubSyncFailure,
  type GithubSyncProgress,
  type GithubSyncResult
} from '../shared/github';
import { describeGithubError, githubErrorKind, type GithubIssue } from './github';

export interface FetchIssuesOutcome {
  issues: GithubIssue[];
  pruned: number;
  pages: number;
}

export interface GithubSyncDeps {
  /** 拉某个仓库的全部 issues（内部自己翻页 + 过滤 PR）。since 为 null 表示全量。 */
  fetchIssues(repo: string, since: string | null): Promise<FetchIssuesOutcome>;
  /** 读增量游标；没有记录返回 null。 */
  getMeta(repo: string): GithubRepoMeta | null;
  /** 在一个事务里执行：仓库级原子性。 */
  transaction<T>(fn: () => T): T;
  /** 按 github_issue_id upsert。 */
  upsertTask(issue: GithubIssue, repo: string): 'created' | 'updated' | 'skipped';
  saveMeta(repo: string, patch: { lastSyncedAt?: string | null; lastError?: string | null }): void;
  now(): Date;
  onProgress?(progress: GithubSyncProgress): void;
}

/** 同步结果里的「新增+更新+跳过」只统计这个仓库真正处理过的行。 */
export async function syncGithubIssues(
  deps: GithubSyncDeps,
  repos: string[]
): Promise<GithubSyncResult> {
  const list = repos.map((repo) => repo.trim()).filter(Boolean);
  const result: GithubSyncResult = {
    repoTotal: list.length,
    succeeded: 0,
    failed: [],
    fetched: 0,
    created: 0,
    updated: 0,
    skipped: 0,
    pruned: 0,
    authExpired: false
  };
  if (list.length === 0) return result;

  deps.onProgress?.({ phase: 'start', repoIndex: 0, repoTotal: list.length, repo: null, fetched: 0 });

  for (let index = 0; index < list.length; index += 1) {
    const repo = list[index];
    const position = index + 1;
    deps.onProgress?.({ phase: 'repo', repoIndex: position, repoTotal: list.length, repo, fetched: result.fetched });

    try {
      const meta = deps.getMeta(repo);
      // 只有「上次成功」才推进游标；失败过的仓库下次仍然从旧游标重试。
      const since = meta?.lastSyncedAt ?? null;
      const fetched = await deps.fetchIssues(repo, since);
      result.fetched += fetched.issues.length;
      result.pruned += fetched.pruned;

      const syncedAt = deps.now().toISOString();
      let created = 0;
      let updated = 0;
      let skipped = 0;
      deps.transaction(() => {
        for (const issue of fetched.issues) {
          const outcome = deps.upsertTask(issue, repo);
          if (outcome === 'created') created += 1;
          else if (outcome === 'updated') updated += 1;
          else skipped += 1;
        }
        // 游标与数据在同一个事务里推进：中途崩了不会出现「数据没写完但游标前进了」。
        deps.saveMeta(repo, { lastSyncedAt: syncedAt, lastError: null });
      });
      result.created += created;
      result.updated += updated;
      result.skipped += skipped;
      result.succeeded += 1;
    } catch (err) {
      const failure: GithubSyncFailure = {
        repo,
        error: describeGithubError(err),
        kind: githubErrorKind(err)
      };
      if (failure.kind === 'unauthorized') result.authExpired = true;
      result.failed.push(failure);
      try {
        deps.saveMeta(repo, { lastError: failure.error });
      } catch {
        /* 记录失败原因失败也不该打断整轮同步 */
      }
    }
  }

  deps.onProgress?.({ phase: 'done', repoIndex: list.length, repoTotal: list.length, repo: null, fetched: result.fetched });
  return result;
}

/** 同步结束后给用户看的一句话（IPC 层原样返回给渲染层做 Toast）。 */
export function describeSyncResult(result: GithubSyncResult): string {
  return formatSyncSummary(result);
}
