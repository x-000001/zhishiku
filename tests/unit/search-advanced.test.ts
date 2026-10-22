import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as db from '../../src/main/db';
import { ensureDirs, type DataPaths } from '../../src/main/paths';
import { parseSearchQuery } from '../../src/shared/search-query';

/* 高级检索的数据层（0.12.0 阶段2）：语法剔除 + 精准索引过滤 + 防呆所需元信息。 */

let root = '';
let paths: DataPaths;

function resetData(): void {
  const raw = db.getRawDb();
  raw.exec('PRAGMA foreign_keys = OFF');
  for (const t of ['note_tag', 'note_version', 'attachment', 'note']) {
    raw.exec(`delete from ${t}`);
  }
  raw.exec('delete from tag');
  raw.exec('delete from note_fts');
  raw.exec('PRAGMA foreign_keys = ON');
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'jwkb-search-'));
  paths = ensureDirs(root);
  db.openDatabase(paths);
});

afterAll(() => {
  try {
    db.closeDatabase();
  } catch {
    /* 已关闭 */
  }
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  resetData();
});

describe('searchNotesAdvanced：语法剔除后只按正文/标签精准匹配', () => {
  it('tag: 从 MATCH 词里剔除：正文写死「tag:工作」的笔记不会因为语法词被误命中', () => {
    const tagged = db.createNote({ title: '带标签的笔记', content: '阶段2关键词 命中目标' });
    db.setNoteTags(tagged, ['工作']);
    // 干扰项：正文里出现字面量 tag:工作，但没有真的打标签
    const literal = db.createNote({ title: '字面量笔记', content: 'tag:工作 阶段2关键词' });

    const parsed = parseSearchQuery('tag:工作 阶段2关键词');
    expect(parsed.text).toBe('阶段2关键词');

    const hits = db.searchNotesAdvanced(parsed.text, 30, { tags: parsed.tags });
    const ids = hits.map((h) => h.note_id);
    expect(ids).toEqual([tagged]);
    expect(ids).not.toContain(literal);
  });

  it('只有 tag: 时退回数据查询（不用 FTS MATCH），并且能精准过滤', () => {
    const a = db.createNote({ title: 'A', content: '普通正文' });
    db.setNoteTags(a, ['工作']);
    const b = db.createNote({ title: 'B', content: '工作 也在正文里' });

    const parsed = parseSearchQuery('tag:工作');
    expect(parsed.text).toBe('');
    const hits = db.searchNotesAdvanced(parsed.text, 30, { tags: parsed.tags });
    expect(hits.map((h) => h.note_id)).toEqual([a]);
    expect(hits.map((h) => h.note_id)).not.toContain(b);
  });

  it('is:pinned 只返回置顶笔记', () => {
    const a = db.createNote({ title: '置顶', content: '复习' });
    const b = db.createNote({ title: '普通', content: '复习' });
    db.togglePin(a);

    const hits = db.searchNotesAdvanced('复习', 30, { pinned: true });
    expect(hits.map((h) => h.note_id)).toEqual([a]);
    expect(hits.map((h) => h.note_id)).not.toContain(b);
  });

  it('is:trash 只在回收站里搜；默认检索永远排除回收站', () => {
    const active = db.createNote({ title: '正常', content: '归档检索词' });
    const trashed = db.createNote({ title: '已删', content: '归档检索词' });
    db.trashNote(trashed);

    const normal = db.searchNotesAdvanced('归档检索词', 30, {});
    expect(normal.map((h) => h.note_id)).toEqual([active]);

    const trashOnly = db.searchNotesAdvanced('归档检索词', 30, { trash: true });
    expect(trashOnly.map((h) => h.note_id)).toEqual([trashed]);
  });

  it('不存在的标签：结果为空，且 tagNamesIn 只回报真实存在的标签', () => {
    const a = db.createNote({ title: 'A', content: '正文' });
    db.setNoteTags(a, ['工作']);

    expect(db.tagNamesIn(['工作', '不存在的标签zz'])).toEqual(['工作']);
    const parsed = parseSearchQuery('tag:不存在的标签zz');
    expect(db.searchNotesAdvanced(parsed.text, 30, { tags: parsed.tags })).toEqual([]);
  });
});

describe('精准索引：标签过滤不靠 LIKE 全表扫', () => {
  function plan(sql: string, ...args: unknown[]): string {
    const rows = db.getRawDb().prepare('explain query plan ' + sql).all(...(args as never[])) as Array<{ detail?: string }>;
    return rows.map((r) => String(r.detail ?? '')).join(' | ');
  }

  it('tag.name 查找走唯一索引（SEARCH … tag），不是 SCAN tag', () => {
    const text = plan('select name from tag where name = ?', '工作');
    expect(/SEARCH .*tag/i.test(text) || /USING (COVERING )?INDEX/i.test(text)).toBe(true);
    expect(/SCAN tag/i.test(text)).toBe(false);
  });

  it('标签过滤的 exists 子查询走 note_tag 主键 / tag 唯一索引', () => {
    const text = plan(
      `select n.id from note n
       where exists (
         select 1 from note_tag nt join tag t on t.id = nt.tag_id
         where nt.note_id = n.id and t.name = ?
       )`,
      '工作'
    );
    expect(/SEARCH .*note_tag/i.test(text)).toBe(true);
    expect(/SEARCH .*tag/i.test(text)).toBe(true);
    expect(/SCAN note_tag/i.test(text)).toBe(false);
    // 不允许退化成整表扫描 + LIKE
    expect(/LIKE/i.test(text)).toBe(false);
  });
});
