import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as db from '../../src/main/db';
import { ensureDirs, type DataPaths } from '../../src/main/paths';

let root = '';
let paths: DataPaths;

function resetData(): void {
  const raw = db.getRawDb();
  raw.exec('PRAGMA foreign_keys = OFF');
  for (const t of ['note_tag', 'note_version', 'attachment', 'note']) raw.exec(`delete from ${t}`);
  raw.exec('delete from note_fts');
  raw.exec('delete from category');
  raw.exec('PRAGMA foreign_keys = ON');
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'jwkb-cat-'));
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

function names(parentId: number | null = null): string[] {
  return db
    .categoryTree()
    .filter((c) => c.parent_id === parentId)
    .map((c) => c.name);
}

describe('分类：新建与层级（优化项 7）', () => {
  it('能建二三级子分类，树里各排各的', () => {
    const study = db.createCategory(null, '学习');
    const work = db.createCategory(null, '工作');
    const english = db.createCategory(study, '英语');
    db.createCategory(english, '单词');

    expect(names(null)).toEqual(['学习', '工作']);
    expect(names(study)).toEqual(['英语']);
    expect(names(english)).toEqual(['单词']);

    const tree = db.categoryTree();
    const nested = tree.find((c) => c.name === '单词');
    expect(nested?.parent_id).toBe(english);
    expect(tree.find((c) => c.id === work)?.parent_id).toBe(null);
  });

  it('分类上的 note_count 只数这个分类自己的笔记（不含子分类）', () => {
    const study = db.createCategory(null, '学习');
    const english = db.createCategory(study, '英语');
    db.createNote({ categoryId: study, title: '总纲', html: '<p>甲</p>' });
    db.createNote({ categoryId: english, title: '单词表', html: '<p>乙</p>' });

    const tree = db.categoryTree();
    expect(tree.find((c) => c.id === study)?.note_count).toBe(1);
    expect(tree.find((c) => c.id === english)?.note_count).toBe(1);
  });
});

describe('分类排序（优化项 7）', () => {
  it('上移/下移只动同一层，子分类之间互不影响', () => {
    const a = db.createCategory(null, '甲');
    const b = db.createCategory(null, '乙');
    const c = db.createCategory(null, '丙');
    db.createCategory(b, '乙一');
    db.createCategory(b, '乙二');
    expect(names(null)).toEqual(['甲', '乙', '丙']);
    expect(names(b)).toEqual(['乙一', '乙二']);

    db.moveCategory(c, 'up');
    expect(names(null)).toEqual(['甲', '丙', '乙']);
    db.moveCategory(c, 'up');
    expect(names(null)).toEqual(['丙', '甲', '乙']);
    // 根分类换了位置，乙的子分类顺序不受影响
    expect(names(b)).toEqual(['乙一', '乙二']);

    const b2 = db.categoryTree().find((c) => c.name === '乙二')!;
    db.moveCategory(b2.id, 'up');
    expect(names(b)).toEqual(['乙二', '乙一']);
    expect(names(a)).toEqual([]);
  });

  it('已经在头/尾时再移也不报错，顺序不变', () => {
    const a = db.createCategory(null, '甲');
    db.createCategory(null, '乙');
    db.moveCategory(a, 'up');
    expect(names(null)).toEqual(['甲', '乙']);
    db.moveCategory(a, 'down');
    db.moveCategory(a, 'down');
    expect(names(null)).toEqual(['乙', '甲']);
  });

  it('排完序重开分类树还是这个顺序（顺序真的写进 sort_order 了）', () => {
    const a = db.createCategory(null, '甲');
    const b = db.createCategory(null, '乙');
    db.moveCategory(b, 'up');
    const orders = db.categoryTree().map((c) => [c.name, c.sort_order]);
    expect(orders).toEqual([
      ['乙', 1],
      ['甲', 2]
    ]);
    expect(a).toBeGreaterThan(0);
  });
});

describe('删除分类：非空拦截（优化项 7）', () => {
  it('分类下有自己的笔记就不许删，给一句人话', () => {
    const study = db.createCategory(null, '学习');
    db.createNote({ categoryId: study, title: '一篇', html: '<p>x</p>' });
    expect(() => db.deleteCategory(study)).toThrow('该分类下还有笔记，请先移动或删除笔记');
    expect(names(null)).toEqual(['学习']);
  });

  it('笔记在子分类里，父分类也不许删（递归检查）', () => {
    const study = db.createCategory(null, '学习');
    const english = db.createCategory(study, '英语');
    db.createNote({ categoryId: english, title: '单词表', html: '<p>y</p>' });
    expect(() => db.deleteCategory(study)).toThrow('该分类下还有笔记，请先移动或删除笔记');
    // 子分类自己也不能删
    expect(() => db.deleteCategory(english)).toThrow('该分类下还有笔记，请先移动或删除笔记');
  });

  it('笔记进了回收站就不算数了，这时分类能删', () => {
    const study = db.createCategory(null, '学习');
    const note = db.createNote({ categoryId: study, title: '一篇', html: '<p>x</p>' });
    db.trashNote(note);
    db.deleteCategory(study);
    expect(names(null)).toEqual([]);
  });

  it('空分类能删，子分类上提一级而不是一起消失', () => {
    const study = db.createCategory(null, '学习');
    const work = db.createCategory(null, '工作');
    const english = db.createCategory(study, '英语');
    db.deleteCategory(study);

    const tree = db.categoryTree();
    expect(tree.some((c) => c.name === '学习')).toBe(false);
    // 子分类还在，并且挂到了原来父分类的位置（这里是根）
    expect(tree.find((c) => c.id === english)?.parent_id).toBe(null);
    expect(names(null)).toEqual(['工作', '英语']);
    expect(work).toBeGreaterThan(0);
  });

  it('删掉的分类不再出现在树里，也不会被再删一次搞崩', () => {
    const study = db.createCategory(null, '学习');
    db.deleteCategory(study);
    expect(db.categoryTree().map((c) => c.name)).toEqual([]);
    db.deleteCategory(study);
    expect(db.categoryTree().map((c) => c.name)).toEqual([]);
  });
});
