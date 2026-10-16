import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as db from '../../src/main/db';
import { ensureDirs, todayLocal, type DataPaths } from '../../src/main/paths';

/**
 * PRD 第 10 章的性能验收：
 *   G1 首页总览打开时间 —— 目标 1 秒内
 *   G2 全文搜索 —— 目标 300 毫秒内
 * 数据量按「用了一年多」的规模铺：1000 篇笔记 + 5000 条任务。
 */

let root = '';
let paths: DataPaths;

const NOTE_COUNT = 1000;
const TASK_COUNT = 5000;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'jwkb-perf-'));
  paths = ensureDirs(root);
  db.openDatabase(paths);

  const raw = db.getRawDb();
  const today = todayLocal();
  const tomorrow = (() => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  })();

  // 一个分类，笔记都挂进去，贴近真实使用
  const catId = db.createCategory(null, '性能测试分类');

  raw.exec('begin');
  for (let i = 0; i < NOTE_COUNT; i++) {
    const id = db.createNote({
      categoryId: catId,
      title: `第 ${i} 篇笔记`,
      content:
        `这是第 ${i} 篇笔记的内容。\n\n` +
        `今天学习了间隔重复的调度方式，记住了「忘记」和「记得」两档的区别。\n` +
        `关键词：知识库 ${i} 复习 任务 目标 笔记。\n`.repeat(6)
    });
    if (i % 50 === 0) db.setNoteTags(id, ['性能', `组${i % 7}`]);
  }
  for (let i = 0; i < TASK_COUNT; i++) {
    db.createTask({
      title: `第 ${i} 条任务`,
      // 一半是今天的（首页要汇总），一半散在后面
      due_at: i % 2 === 0 ? today : tomorrow,
      priority: (['urgent', 'important', 'normal'] as const)[i % 3],
      status: i % 10 === 0 ? 'done' : 'todo'
    });
  }
  raw.exec('commit');
}, 120000);

afterAll(() => {
  db.closeDatabase();
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    // 清理不掉不影响测试结论
  }
});

describe('大数量下的性能', () => {
  it('铺进去的数据量是对的', () => {
    const raw = db.getRawDb();
    const notes = raw.prepare('select count(*) as c from note where deleted_at is null').get() as { c: number };
    const tasks = raw.prepare('select count(*) as c from task where deleted_at is null').get() as { c: number };
    expect(Number(notes.c)).toBe(NOTE_COUNT);
    expect(Number(tasks.c)).toBe(TASK_COUNT);
  });

  it('G1：首页总览 1 秒内打开', () => {
    const t0 = performance.now();
    const data = db.dashboard();
    const cost = performance.now() - t0;
    expect(data.tasks.length).toBe(50);
    // 铺的数据里最早也就是今天，所以「逾期」应为 0，今天要做的都列出来了
    expect(data.overdueCount).toBe(0);
    // eslint-disable-next-line no-console
    console.log(`[性能] 首页总览 ${cost.toFixed(0)} ms`);
    expect(cost).toBeLessThan(1000);
  });

  it('G2：全文搜索 300 毫秒内返回', () => {
    let cost = 0;
    let hits: ReturnType<typeof db.searchNotes> = [];
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      hits = db.searchNotes('间隔重复', 30);
      cost = performance.now() - t0;
    }
    // eslint-disable-next-line no-console
    console.log(`[性能] 全文搜索 ${cost.toFixed(0)} ms，命中 ${hits.length} 条`);
    expect(hits.length).toBeGreaterThan(0);
    expect(cost).toBeLessThan(300);
  });

  it('两字中文词也能搜到（unicode61 + 逐字展开的意义）', () => {
    expect(db.searchNotes('复习', 10).length).toBeGreaterThan(0);
  });

  it('切换任务视图（今天/全部）在 300 毫秒内', () => {
    const t0 = performance.now();
    const today = db.listTasks({ view: 'today', limit: 500 });
    const all = db.listTasks({ view: 'all', limit: 500 });
    const cost = performance.now() - t0;
    // eslint-disable-next-line no-console
    console.log(`[性能] 任务视图切换 ${cost.toFixed(0)} ms`);
    expect(today.length).toBeGreaterThan(0);
    expect(all.length).toBe(500);
    expect(cost).toBeLessThan(300);
  });

  it('任务列表默认只取 500 条，最多 2000 条（不会把几万行塞给界面）', () => {
    expect(db.listTasks({ view: 'all' }).length).toBe(500);
    expect(db.listTasks({ view: 'all', limit: 999999 }).length).toBe(2000);
  });

  it('左侧各视图角标用的是真实条数，不受 500 条上限影响', () => {
    const counts = db.taskCounts();
    expect(counts.all).toBe(TASK_COUNT);
    expect(counts.done).toBe(TASK_COUNT / 10);
    const raw = db.getRawDb();
    const row = raw
      .prepare(
        "select count(*) as c from task where deleted_at is null and due_at is not null and substr(due_at,1,10) <= ?"
      )
      .get(todayLocal()) as { c: number };
    expect(counts.today).toBe(Number(row.c));
  });
});
