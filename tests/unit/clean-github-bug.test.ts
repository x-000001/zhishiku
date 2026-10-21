import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  cleanGithubBugRows,
  runCleanGithubBugMigration,
  GITHUB_ECHO_MARKERS,
  type GithubBugDb
} from '../../src/main/migrations/cleanGithubBug';

/** 历史脏数据清理的回归测试（把指令回显的条目标记成 ai_failed）。 */

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE inbox_item (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      extract_status TEXT,
      extract_meta TEXT,
      updated_at TEXT NOT NULL
    )
  `);
  return db;
}

function insert(
  db: DatabaseSync,
  row: { content: string; extractStatus: string | null; meta?: string | null; updatedAt?: string }
): void {
  db.prepare(
    'insert into inbox_item (content, extract_status, extract_meta, updated_at) values (?, ?, ?, ?)'
  ).run(row.content, row.extractStatus, row.meta ?? null, row.updatedAt ?? '2026-10-21T00:00:00.000Z');
}

function statusOf(db: DatabaseSync, id: number): string | null {
  const row = db.prepare('select extract_status as s from inbox_item where id = ?').get(id) as
    | { s: string | null }
    | undefined;
  return row?.s ?? null;
}

describe('cleanGithubBug：历史脏数据无痛清理', () => {
  it('命中回显长串的 done 条目改判 ai_failed，正常条目不碰', () => {
    const db = makeDb();
    insert(db, { content: `${GITHUB_ECHO_MARKERS[0]}：把 README 提炼成三段`, extractStatus: 'done' });
    insert(db, { content: '一个批量处理文件的命令行工具。', extractStatus: 'done' });
    insert(db, { content: '仅保存链接，没提炼过。', extractStatus: 'link_only' });
    insert(db, { content: `${GITHUB_ECHO_MARKERS[0]}：残留`, extractStatus: 'ai_failed' });

    expect(cleanGithubBugRows(db)).toBe(1);
    expect(statusOf(db, 1)).toBe('ai_failed');
    expect(statusOf(db, 2)).toBe('done');
    expect(statusOf(db, 3)).toBe('link_only');
    expect(statusOf(db, 4)).toBe('ai_failed');
  });

  it('回显串藏在 extract_meta 里也算命中（老版本解析把模板写进了 JSON）', () => {
    const db = makeDb();
    insert(db, {
      content: '看起来正常的外壳',
      extractStatus: 'done',
      meta: JSON.stringify({ summary: '我们需要回答用户：根据 README 提炼成三段' })
    });
    expect(cleanGithubBugRows(db)).toBe(1);
    expect(statusOf(db, 1)).toBe('ai_failed');
  });

  it('幂等：清理过的再跑一次返回 0，不会反复写库', () => {
    const db = makeDb();
    insert(db, { content: `${GITHUB_ECHO_MARKERS[0]}：脏数据`, extractStatus: 'done' });
    expect(cleanGithubBugRows(db)).toBe(1);
    expect(cleanGithubBugRows(db)).toBe(0);
  });

  it('整体失败也只打日志、不抛错（绝不阻断软件启动）', () => {
    const broken = {
      prepare() {
        throw new Error('database is locked');
      },
      exec() {
        throw new Error('database is locked');
      }
    } as unknown as GithubBugDb;
    expect(() => runCleanGithubBugMigration(broken)).not.toThrow();
    expect(runCleanGithubBugMigration(broken)).toBe(0);
  });
});
