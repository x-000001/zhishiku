import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as db from '../../src/main/db';
import { ensureDirs, type DataPaths } from '../../src/main/paths';
import { BACKLINK_MAX_TERMS, extractBacklinkKeywords } from '../../src/shared/backlinks';

/* 智能上下文关联（0.12.0 阶段3）：停用词过滤 + 相关笔记检索（必须排除当前笔记）。 */

describe('extractBacklinkKeywords：提取前过滤停用词', () => {
  it('「的 / 了 / 是 / 因为 / 所以」这类停用词一条都不会进关键词', () => {
    const terms = extractBacklinkKeywords({ title: '', text: '的了 是在 因为 所以 但是 我们 这个 已经' });
    expect(terms).toEqual([]);
    for (const stop of ['的', '了', '是', '因为', '所以', '我们', '这个']) {
      expect(terms).not.toContain(stop);
    }
  });

  it('保留真实内容词（中文二元词），并且不会把「与 / 和」这类连接字带出来', () => {
    const terms = extractBacklinkKeywords({ title: '', text: '间隔重复与主动回忆是一套复习方法' });
    expect(terms).toContain('间隔');
    expect(terms).toContain('重复');
    expect(terms).toContain('回忆');
    expect(terms).not.toContain('与主');
    expect(terms).not.toContain('的是');
  });

  it('标题里的词权重更高，排在正文词前面', () => {
    const terms = extractBacklinkKeywords({
      title: '回溯算法',
      text: '数组 哈希 链表 栈 队列'
    });
    expect(terms).toContain('回溯');
    // 标题词（权重 3）在正文词（权重 1）前面
    expect(terms.indexOf('回溯')).toBeLessThan(terms.indexOf('数组'));
  });

  it('去掉 Markdown 标记、代码块与链接，不把符号/URL 当关键词', () => {
    const terms = extractBacklinkKeywords({
      title: '## 标题',
      text: '```ts\nconst xxx = 1;\n```\n[链接](https://example.com/abc) 正文内容在这里'
    });
    expect(terms).not.toContain('https');
    expect(terms).not.toContain('example');
    expect(terms).not.toContain('const');
    expect(terms).toContain('正文');
  });

  it('英文词转小写、按权重排序；上限生效', () => {
    const terms = extractBacklinkKeywords({ title: 'Electron', text: 'electron react electron vue angular svelte solid' });
    expect(terms[0]).toBe('electron');
    const capped = extractBacklinkKeywords({ title: '甲乙丙丁戊己庚辛壬癸', text: '一二三四五六七八九十' }, 3);
    expect(capped.length).toBe(3);
    expect(capped.length).toBeLessThanOrEqual(BACKLINK_MAX_TERMS);
  });

  it('全空/全是停用词时返回空数组（调用方据此显示「还没有找到相关笔记」）', () => {
    expect(extractBacklinkKeywords({ title: '', text: '' })).toEqual([]);
    expect(extractBacklinkKeywords({ title: '', text: '    ' })).toEqual([]);
  });
});

/* ---------------- 数据层：相关笔记必须排除当前笔记 ---------------- */

let root = '';
let paths: DataPaths;

function resetData(): void {
  const raw = db.getRawDb();
  raw.exec('PRAGMA foreign_keys = OFF');
  for (const t of ['note_tag', 'note_version', 'attachment', 'note']) raw.exec(`delete from ${t}`);
  raw.exec('delete from note_fts');
  raw.exec('PRAGMA foreign_keys = ON');
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'jwkb-backlinks-'));
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

describe('searchRelatedNotes：FTS5 检索排除当前笔记', () => {
  it('相关结果包含同主题笔记，但绝不包含当前笔记自己', () => {
    const current = db.createNote({
      title: '复习方法',
      content: '间隔重复与主动回忆是高效的复习方法，配合测试效应。'
    });
    const related = db.createNote({
      title: '间隔重复实践',
      content: '间隔重复与主动回忆的实践记录：每天十分钟。'
    });
    const unrelated = db.createNote({ title: '购物清单', content: '牛奶 面包 鸡蛋 购物。' });

    const terms = extractBacklinkKeywords({ title: '复习方法', text: '间隔重复与主动回忆是高效的复习方法，配合测试效应。' });
    expect(terms.length).toBeGreaterThan(0);

    const hits = db.searchRelatedNotes(current, terms, 6);
    const ids = hits.map((h) => h.note_id);
    expect(ids).toContain(related);
    expect(ids).not.toContain(current);
    expect(ids).not.toContain(unrelated);
    expect(hits.every((h) => h.note_id !== current)).toBe(true);
  });

  it('停用词提取不到关键词时返回空结果（不会退化成全库推荐）', () => {
    const current = db.createNote({ title: '', content: '的了 是在 因为 所以' });
    const other = db.createNote({ title: '随便', content: '间隔重复' });
    const terms = extractBacklinkKeywords({ title: '', text: '的了 是在 因为 所以' });
    expect(terms).toEqual([]);
    expect(db.searchRelatedNotes(current, terms, 6)).toEqual([]);
    expect(db.searchRelatedNotes(current, [], 6)).toEqual([]);
    expect(other).toBeGreaterThan(0);
  });

  it('回收站里的笔记不会出现在相关笔记里', () => {
    const current = db.createNote({ title: '主线', content: '向量数据库与检索增强。' });
    const related = db.createNote({ title: '关联', content: '向量数据库的检索增强实践。' });
    const deleted = db.createNote({ title: '已删', content: '向量数据库 检索增强 笔记。' });
    db.trashNote(deleted);

    const terms = extractBacklinkKeywords({ title: '主线', text: '向量数据库与检索增强。' });
    const ids = db.searchRelatedNotes(current, terms, 6).map((h) => h.note_id);
    expect(ids).toContain(related);
    expect(ids).not.toContain(deleted);
  });
});
