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
create table note (
  id integer primary key autoincrement,
  category_id integer,
  title text not null default '',
  content text not null default '',
  draft_title text,
  draft_content text,
  draft_at text,
  excerpt text not null default '',
  word_count integer not null default 0,
  is_pinned integer not null default 0,
  created_at text not null,
  updated_at text not null,
  deleted_at text
);
create table note_version (
  id integer primary key autoincrement,
  note_id integer not null,
  title text not null,
  content text not null,
  word_count integer not null default 0,
  reason text not null default '手动保存',
  created_at text not null
);
insert into task(title, note, due_at, created_at, updated_at)
  values('老版本留下的任务', '老备注', '2026-01-02', '2026-01-01T09:00:00+08:00', '2026-01-01T09:00:00+08:00');
insert into goal(title, created_at, updated_at)
  values('老目标', '2026-01-01T09:00:00+08:00', '2026-01-01T09:00:00+08:00');
insert into note(category_id, title, content, created_at, updated_at)
  values(1, '最老的笔记', '# 一级标题

这是**重点**。', '2026-01-01T09:00:00+08:00', '2026-01-01T09:00:00+08:00');
insert into note(category_id, title, content, draft_title, draft_content, draft_at, created_at, updated_at)
  values(1, '带草稿的笔记', '普通一句话', '改过的标题', '- 草稿第一条
- 草稿第二条', '2026-01-03T09:00:00+08:00', '2026-01-02T09:00:00+08:00', '2026-01-02T09:00:00+08:00');
insert into note(category_id, title, content, created_at, updated_at)
  values(1, '最新改过的笔记', '**收尾**', '2026-01-01T09:00:00+08:00', '2026-01-05T09:00:00+08:00');
insert into note(category_id, title, content, created_at, updated_at)
  values(2, '另一个分类的笔记', '只有这一句', '2026-01-04T09:00:00+08:00', '2026-01-04T09:00:00+08:00');
insert into note_version(note_id, title, content, created_at)
  values(1, '最老的笔记', '# 一级标题', '2026-01-01T09:00:00+08:00');
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
    expect(Number(version.user_version)).toBe(7);

    // v5：标签管理只加了按标签反查的索引，表结构没动
    const tagIndexes = db
      .getRawDb()
      .prepare("select name from sqlite_master where type = 'index' and name = ?")
      .all('idx_note_tag_tag') as { name: string }[];
    expect(tagIndexes.map((r) => r.name)).toEqual(['idx_note_tag_tag']);

    // v3：笔记多了富文本正文和分类内排序位
    expect(columnNames('note')).toEqual(expect.arrayContaining(['content_html', 'sort_order']));
    expect(columnNames('note_version')).toContain('content_html');

    // 老笔记的 Markdown 被转成富文本，纯文字那份原样保留
    const oldest = db.getNote(1);
    expect(oldest).toBeDefined();
    expect(oldest!.content).toBe('# 一级标题\n\n这是**重点**。');
    expect(oldest!.content_html).toContain('<h1');
    expect(oldest!.content_html).toContain('<strong>重点</strong>');
    expect(db.getNote(3)!.content_html).toContain('<strong>收尾</strong>');

    // 草稿也从 Markdown 转成富文本，恢复草稿时编辑器才认识
    expect(db.getNote(2)!.draft_content ?? '').toContain('<li>');

    // 分类内按「最近改过的排前面」铺位次，另一个分类各算各的
    expect(db.listNotes({ categoryId: 1 }).map((n) => n.title)).toEqual([
      '最新改过的笔记',
      '带草稿的笔记',
      '最老的笔记'
    ]);
    expect(db.listNotes({ categoryId: 1 }).map((n) => n.sort_order)).toEqual([1, 2, 3]);
    expect(db.listNotes({ categoryId: 2 }).map((n) => n.sort_order)).toEqual([1]);

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
    // v4：老库里的数字优先级（默认 2 = 中）转成三档文字，而且真的按文本存进库里
    expect(old!.priority).toBe('important');
    const rawPriority = db
      .getRawDb()
      .prepare('select priority, typeof(priority) as t from task where id = ?')
      .get(old!.id) as { priority: string; t: string };
    expect(rawPriority.priority).toBe('important');
    expect(rawPriority.t).toBe('text');
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
    const beforeNote = columnNames('note').join(',');
    const htmlBefore = db.getNote(1)!.content_html;
    db.closeDatabase();
    db.openDatabase(paths);
    expect(columnNames('task').join(',')).toBe(before);
    expect(columnNames('note').join(',')).toBe(beforeNote);
    // 富文本不会被二次转换（转两遍会把 <h1> 转义成 &lt;h1&gt;）
    expect(db.getNote(1)!.content_html).toBe(htmlBefore);
    expect(db.getNote(1)!.content_html).toContain('<h1');
    expect(db.integrityCheck()).toBe('ok');
  });

  it('第二版的库升到最新：只补富文本与排序，已有内容不动', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'jwkb-mig3-'));
    const paths = ensureDirs(root);
    db.openDatabase(paths);
    const id = db.createNote({ title: '第二版时代的笔记', content: '**老内容**' });
    // 把它伪装成「第二版写下的笔记」：v3 的两列回到空，版本号退回 2
    db.getRawDb().exec(`update note set content_html = '', sort_order = 0 where id = ${id}`);
    db.getRawDb().exec('pragma user_version = 2');
    db.closeDatabase();

    db.openDatabase(paths);

    const note = db.getNote(id)!;
    expect(note.title).toBe('第二版时代的笔记');
    expect(note.content).toBe('**老内容**');
    expect(note.content_html).toContain('<strong>老内容</strong>');
    expect(note.sort_order).toBeGreaterThanOrEqual(1);
    const version = db.getRawDb().prepare('pragma user_version').get() as { user_version: number };
    expect(Number(version.user_version)).toBe(7);
    expect(db.integrityCheck()).toBe('ok');
  });

  it('第三版的库升到第四版：数字优先级转成三档文字，重开不会降回去', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'jwkb-mig4-'));
    const paths = ensureDirs(root);
    db.openDatabase(paths);
    const urgent = db.createTask({ title: '高优先级的老任务', priority: 'urgent' });
    const normal = db.createTask({ title: '低优先级的老任务', priority: 'normal' });
    // 伪装成「第三版写下的任务」：优先级塞回数字，版本号退回 3
    db.getRawDb().exec(`update task set priority = 3 where id = ${urgent}`);
    db.getRawDb().exec(`update task set priority = 1 where id = ${normal}`);
    db.getRawDb().exec('pragma user_version = 3');
    db.closeDatabase();

    db.openDatabase(paths);

    expect(db.listTasks({ view: 'all' }).find((t) => t.id === urgent)!.priority).toBe('urgent');
    expect(db.listTasks({ view: 'all' }).find((t) => t.id === normal)!.priority).toBe('normal');
    const version3 = db.getRawDb().prepare('pragma user_version').get() as { user_version: number };
    expect(Number(version3.user_version)).toBe(7);

    // 再开一次：已经转成文字的不会被 cast() 当 0 降成 normal
    db.closeDatabase();
    db.openDatabase(paths);
    expect(db.listTasks({ view: 'all' }).find((t) => t.id === urgent)!.priority).toBe('urgent');
    expect(db.integrityCheck()).toBe('ok');
  });

  it('第五版（0.5.0 用户）升到第六版：只补标签索引，标签和关联一篇不少', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'jwkb-mig5-'));
    const paths = ensureDirs(root);
    db.openDatabase(paths);

    // 造出真实使用中的数据：两篇笔记 + 两个标签，其中「工作」挂两篇
    const a = db.createNote({ title: '第五版时代的笔记甲', content: '一' });
    const b = db.createNote({ title: '第五版时代的笔记乙', content: '二' });
    db.setNoteTags(a, ['学习', '工作']);
    db.setNoteTags(b, ['工作']);

    // 伪装成「0.5.0 写下的库」：第六版只加了一个索引，把索引删掉、版本号退回 5
    db.getRawDb().exec('drop index if exists idx_note_tag_tag');
    db.getRawDb().exec('pragma user_version = 4');
    db.closeDatabase();

    db.openDatabase(paths);

    const version = db.getRawDb().prepare('pragma user_version').get() as { user_version: number };
    expect(Number(version.user_version)).toBe(7);
    const index = db
      .getRawDb()
      .prepare(`select name from sqlite_master where type = 'index' and name = 'idx_note_tag_tag'`)
      .get() as { name: string } | undefined;
    expect(index?.name).toBe('idx_note_tag_tag');

    // 数据没被迁移碰过：标签、引用数、笔记都还在
    const tags = db.listTags();
    expect(tags.find((t) => t.name === '学习')!.note_count).toBe(1);
    expect(tags.find((t) => t.name === '工作')!.note_count).toBe(2);
    expect(db.getNote(a)!.title).toBe('第五版时代的笔记甲');
    expect(db.getNote(b)!.title).toBe('第五版时代的笔记乙');
    expect(db.integrityCheck()).toBe('ok');
  });
});
