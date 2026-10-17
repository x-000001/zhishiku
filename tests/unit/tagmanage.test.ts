import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as db from '../../src/main/db';
import { ensureDirs } from '../../src/main/paths';

/**
 * 标签全局管理（第六版 / 阶段1）：改标签名、撞名合并、删标签。
 * 三件事都必须在主进程事务里完成 —— 中途出错要整体回滚，不能改一半。
 */

let root = '';
let noteA = 0;
let noteB = 0;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'jwkb-tagman-'));
  db.openDatabase(ensureDirs(root));
  noteA = db.createNote({ title: '笔记甲', content: '甲' });
  noteB = db.createNote({ title: '笔记乙', content: '乙' });
  db.setNoteTags(noteA, ['学习', '工作']);
  db.setNoteTags(noteB, ['学习']);
});

afterEach(() => {
  try {
    db.closeDatabase();
  } catch {
    /* 没打开 */
  }
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = '';
});

function tagByName(name: string): { id: number; name: string; note_count?: number } {
  const found = db.listTags().find((t) => t.name === name);
  if (!found) throw new Error(`标签 ${name} 不存在`);
  return found as { id: number; name: string; note_count?: number };
}

describe('标签引用数', () => {
  it('listTags 只算未删除的笔记', () => {
    expect(tagByName('学习').note_count).toBe(2);
    expect(tagByName('工作').note_count).toBe(1);

    db.trashNote(noteB);

    expect(tagByName('学习').note_count).toBe(1);
    // 回收站里的关联还在（还原回来标签不丢），只是不算引用数
    expect(db.getRawDb().prepare('select count(*) as c from note_tag').get()).toEqual({ c: 3 });
    db.restoreNote(noteB);
    expect(tagByName('学习').note_count).toBe(2);
  });
});

describe('改标签名', () => {
  it('普通改名：标签 id 不变，笔记关联保留，返回影响篇数', () => {
    const before = tagByName('工作');
    const res = db.renameTag(before.id, '  职场  ');

    expect(res.merged).toBe(false);
    expect(res.affected).toBe(1);
    expect(res.tag.id).toBe(before.id);
    expect(res.tag.name).toBe('职场');
    expect(db.getNote(noteA)!.tags.map((t) => t.name).sort()).toEqual(['学习', '职场']);
    expect(db.listTags().map((t) => t.name)).toEqual(['学习', '职场']);
  });

  it('撞名自动合并：两条并一条，关联不重复、不丢', () => {
    const work = tagByName('工作');
    const study = tagByName('学习');
    const res = db.renameTag(work.id, '学习');

    expect(res.merged).toBe(true);
    expect(res.affected).toBe(1);
    expect(res.tag.id).toBe(study.id);
    expect(db.listTags().map((t) => t.name)).toEqual(['学习']);
    // 甲本来同时有 学习 + 工作，合并后只留一条关联；乙还是那条
    expect(db.getNote(noteA)!.tags.map((t) => t.name)).toEqual(['学习']);
    expect(db.getNote(noteB)!.tags.map((t) => t.name)).toEqual(['学习']);
    const rows = db
      .getRawDb()
      .prepare('select note_id, tag_id from note_tag order by note_id')
      .all() as { note_id: number; tag_id: number }[];
    expect(rows).toEqual([
      { note_id: noteA, tag_id: study.id },
      { note_id: noteB, tag_id: study.id }
    ]);
  });

  it('标签名不合法时直接拒绝，且不动数据库', () => {
    const work = tagByName('工作').id;
    expect(() => db.renameTag(work, '   ')).toThrow('标签名不能为空');
    expect(() => db.renameTag(work, 'a,b')).toThrow('不能有逗号');
    expect(() => db.renameTag(work, 'x'.repeat(41))).toThrow('最多 40 个字符');
    expect(db.listTags().map((t) => t.name).sort()).toEqual(['学习', '工作']);
  });

  it('改不存在的标签会报错，不会凭空建一个', () => {
    expect(() => db.renameTag(99999, '幽灵')).toThrow('这个标签已经不在了');
    expect(db.listTags().map((t) => t.name).sort()).toEqual(['学习', '工作']);
  });

  it('中途出错整体回滚：名字没改、关联没少', () => {
    const work = tagByName('工作').id;
    db.getRawDb().exec("create trigger t_boom before update on tag begin select raise(abort, 'boom'); end;");
    expect(() => db.renameTag(work, '职场')).toThrow();
    db.getRawDb().exec('drop trigger t_boom');

    expect(db.listTags().map((t) => t.name).sort()).toEqual(['学习', '工作']);
    expect(db.getNote(noteA)!.tags.map((t) => t.name).sort()).toEqual(['学习', '工作']);
    expect(db.integrityCheck()).toBe('ok');
  });
});

describe('删标签', () => {
  it('只拆关联，笔记一条不动', () => {
    const study = tagByName('学习');
    const res = db.deleteTagById(study.id);

    expect(res.affected).toBe(2);
    expect(res.name).toBe('学习');
    expect(db.listTags().map((t) => t.name)).toEqual(['工作']);
    expect(db.listNotes({}).length).toBe(2);
    expect(db.getNote(noteA)!.tags.map((t) => t.name)).toEqual(['工作']);
    expect(db.getNote(noteB)!.tags).toEqual([]);
    const orphan = db
      .getRawDb()
      .prepare('select count(*) as c from note_tag where tag_id = ?')
      .get(study.id) as { c: number };
    expect(orphan.c).toBe(0);
  });

  it('回收站里的笔记也一并解除关联', () => {
    const study = tagByName('学习');
    db.trashNote(noteB);
    const res = db.deleteTagById(study.id);
    expect(res.affected).toBe(2);
    expect(db.getRawDb().prepare('select count(*) as c from note_tag').get()).toEqual({ c: 1 });
  });

  it('删不存在的标签会报错', () => {
    expect(() => db.deleteTagById(99999)).toThrow('这个标签已经不在了');
  });

  it('中途出错整体回滚：标签还在、关联也还在', () => {
    const work = tagByName('工作').id;
    db.getRawDb().exec("create trigger t_boom before delete on tag begin select raise(abort, 'boom'); end;");
    expect(() => db.deleteTagById(work)).toThrow();
    db.getRawDb().exec('drop trigger t_boom');

    expect(db.listTags().map((t) => t.name).sort()).toEqual(['学习', '工作']);
    expect(db.getRawDb().prepare('select count(*) as c from note_tag').get()).toEqual({ c: 3 });
    expect(db.integrityCheck()).toBe('ok');
  });
});
