import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as db from '../../src/main/db';
import { ensureDirs } from '../../src/main/paths';

/**
 * 第一版的老库（user_version = 1）里没有 task.remind_at、goal_pool.priority 等列。
 * 这个用例把那种老库手工造出来，再用新代码打开，确认能自动补列且旧数据不丢。
 */

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

const V1_SCHEMA = `
create table task (
  id integer primary key autoincrement,
  title text not null,
  note text not null default '',
  status text not null default 'todo',
  priority integer not null default 2,
  due_at text,
  repeat_rule text not null default 'none',
  goal_id integer,
  plan_id integer,
  completed_at text,
  sort_order integer not null default 0,
  created_at text not null,
  updated_at text not null,
  deleted_at text
);
create table goal (
  id integer primary key autoincrement,
  title text not null,
  description text not null default '',
  status text not null default 'active',
  target_date text,
  started_at text,
  archived_at text,
  sort_order integer not null default 0,
  created_at text not null,
  updated_at text not null,
  deleted_at text
);
create table goal_pool (
  id integer primary key autoincrement,
  title text not null,
  description text not null default '',
  why text not null default '',
  start_condition text not null default '',
  status text not null default 'pool',
  sort_order integer not null default 0,
  created_at text not null,
  updated_at text not null
);
create table plan (
  id integer primary key autoincrement,
  title text not null,
  direction text not null default '',
  start_date text,
  end_date text,
  status text not null default 'active',
  goal_id integer,
  created_at text not null,
  updated_at text not null,
  deleted_at text
);
create table plan_item (
  id integer primary key autoincrement,
  plan_id integer not null,
  date text,
  title text not null,
  minutes integer not null default 0,
  done integer not null default 0,
  note_id integer,
  created_at text not null,
  updated_at text not null
);
create table review_card (
  id integer primary key autoincrement,
  note_id integer,
  front text not null,
  back text not null default '',
  source text not null default 'note',
  ease_level integer not null default 0,
  interval_days integer not null default 0,
  next_review_at text,
  review_count integer not null default 0,
  last_reviewed_at text,
  created_at text not null,
  updated_at text not null,
  deleted_at text
);
insert into task(title, note, due_at, created_at, updated_at)
  values('老版本留下的任务', '老备注', '2026-01-02', '2026-01-01T09:00:00+08:00', '2026-01-01T09:00:00+08:00');
insert into goal(title, created_at, updated_at)
  values('老目标', '2026-01-01T09:00:00+08:00', '2026-01-01T09:00:00+08:00');
pragma user_version = 1;
`;

function columnNames(table: string): string[] {
  return db
    .getRawDb()
    .prepare(`select name from pragma_table_info('${table}')`)
    .all()
    .map((r) => String((r as { name: string }).name));
}

describe('老库自动升级', () => {
  it('老库能打开、自动补齐第二版需要的列、旧数据不丢', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'jwkb-mig-'));
    const paths = ensureDirs(root);
    const raw = new DatabaseSync(paths.db);
    raw.exec(V1_SCHEMA);
    raw.close();

    db.openDatabase(paths);

    expect(columnNames('task')).toContain('remind_at');
    expect(columnNames('goal_pool')).toEqual(
      expect.arrayContaining(['priority', 'horizon', 'est_start', 'goal_id'])
    );
    expect(columnNames('plan')).toContain('rhythm');
    expect(columnNames('plan_item')).toContain('done_at');
    expect(columnNames('review_card')).toContain('lapses');

    const version = db.getRawDb().prepare('pragma user_version').get() as { user_version: number };
    expect(Number(version.user_version)).toBe(2);

    // 第二版新增的三张表都在
    for (const t of ['milestone', 'review_log', 'retrospective']) {
      expect(
        db.getRawDb().prepare(`select count(*) as c from ${t}`).get() as { c: number }
      ).toEqual({ c: 0 });
    }

    // 老数据还在，而且新列是空值（不是被清表重建）
    const old = db.listTasks({ view: 'all' }).find((t) => t.title === '老版本留下的任务');
    expect(old).toBeDefined();
    expect(old!.remind_at).toBeNull();
    expect(old!.note).toBe('老备注');
    expect(old!.due_at).toBe('2026-01-02');
    expect(db.listGoals().map((g) => g.title)).toContain('老目标');
    expect(db.integrityCheck()).toBe('ok');
  });

  it('重复打开同一个库不会再改结构（幂等）', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'jwkb-mig2-'));
    const paths = ensureDirs(root);
    const raw = new DatabaseSync(paths.db);
    raw.exec(V1_SCHEMA);
    raw.close();

    db.openDatabase(paths);
    const before = columnNames('task').join(',');
    db.closeDatabase();
    db.openDatabase(paths);
    expect(columnNames('task').join(',')).toBe(before);
    expect(db.integrityCheck()).toBe('ok');
  });
});
