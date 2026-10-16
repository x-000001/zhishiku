import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as db from '../../src/main/db';
import { ensureDirs, isoLocal, todayLocal, type DataPaths } from '../../src/main/paths';

let root = '';
let paths: DataPaths;

const pad = (n: number) => String(n).padStart(2, '0');
function dayOffset(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 每个用例开始前把业务表清空，保留 meta（设置）与默认分类由用例自行处理。 */
function resetData(): void {
  const raw = db.getRawDb();
  raw.exec('PRAGMA foreign_keys = OFF');
  for (const t of [
    'note_tag',
    'note_version',
    'attachment',
    'review_card',
    'task',
    'goal_key_result',
    'goal_pool',
    'plan_item',
    'plan',
    'goal',
    'note',
    'tag',
    'inbox_item'
  ]) {
    raw.exec(`delete from ${t}`);
  }
  raw.exec('delete from note_fts');
  raw.exec('PRAGMA foreign_keys = ON');
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'jwkb-db-'));
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

describe('数据库底座', () => {
  it('能用 node:sqlite 打开并读到版本号', () => {
    expect(db.sqliteVersion()).toMatch(/^\d+\.\d+/);
  });

  it('完整性检查返回 ok', () => {
    expect(db.integrityCheck()).toBe('ok');
  });

  it('数据库文件落在数据目录里，并且开了 WAL', () => {
    expect(fs.existsSync(paths.db)).toBe(true);
    const row = db.getRawDb().prepare('pragma journal_mode').get() as { journal_mode: string };
    expect(String(row.journal_mode).toLowerCase()).toBe('wal');
  });

  it('表结构齐全', () => {
    const rows = db.getRawDb().prepare("select name from sqlite_master where type = 'table'").all() as {
      name: string;
    }[];
    const names = rows.map((r) => r.name);
    for (const t of [
      'meta',
      'category',
      'note',
      'note_fts',
      'tag',
      'note_tag',
      'attachment',
      'note_version',
      'inbox_item',
      'task',
      'goal',
      'goal_key_result',
      'goal_pool',
      'plan',
      'plan_item',
      'review_card'
    ]) {
      expect(names, `缺少表 ${t}`).toContain(t);
    }
  });
});

describe('分类', () => {
  it('首次启动会建好五个默认分类', () => {
    // openDatabase 时已建过，这里重新触发一次确认不会重复
    const tree = db.categoryTree();
    const names = tree.map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(['工作', '学习', '生活', '项目', '资料收藏']));
  });

  it('能建子分类、改名、删除', () => {
    const parent = db.createCategory(null, '父分类');
    const child = db.createCategory(parent, '子分类');
    let tree = db.categoryTree();
    expect(tree.find((c) => c.id === parent)?.name).toBe('父分类');
    // categoryTree 返回的是平铺列表，层级靠 parent_id 表达
    expect(tree.find((c) => c.id === child)?.parent_id).toBe(parent);
    db.renameCategory(child, '改过名的子分类');
    tree = db.categoryTree();
    expect(tree.find((c) => c.id === child)?.name).toBe('改过名的子分类');
    db.deleteCategory(child);
    expect(db.categoryTree().some((c) => c.id === child)).toBe(false);
  });

  it('删分类时：分类下有笔记就先拦下来；笔记清空后子分类上提一级', () => {
    const parent = db.createCategory(null, '父分类2');
    const child = db.createCategory(parent, '子分类2');
    const noteId = db.createNote({ title: '在父分类下的笔记', categoryId: parent });

    // 优化项 7：非空分类不许删，提示先搬走笔记
    expect(() => db.deleteCategory(parent)).toThrow('该分类下还有笔记，请先移动或删除笔记');
    expect(db.categoryTree().some((c) => c.id === parent)).toBe(true);

    // 把笔记移走（这里直接丢进回收站）之后就能删了，子分类挂到原来父分类的位置
    db.trashNote(noteId);
    db.deleteCategory(parent);
    expect(db.categoryTree().find((c) => c.id === child)?.parent_id).toBeNull();
  });
});

describe('收集箱', () => {
  it('存一条、读一条、待处理计数跟着变', () => {
    const id = db.addInbox('  想到一个点子  ', 'idea');
    const open = db.listInbox('open');
    expect(open).toHaveLength(1);
    expect(open[0].content).toBe('想到一个点子');
    expect(open[0].kind).toBe('idea');
    expect(db.inboxOpenCount()).toBe(1);
    expect(id).toBeGreaterThan(0);
  });

  it('能改内容、转成笔记后从待处理里消失并记下去向', () => {
    const id = db.addInbox('待读的文章', 'read');
    db.updateInbox(id, { content: '待读的文章（已核对）', kind: 'organize' });
    let item = db.listInbox('open')[0];
    expect(item.content).toBe('待读的文章（已核对）');
    expect(item.kind).toBe('organize');

    const noteId = db.createNote({ title: '待读的文章', content: '正文' });
    db.setInboxStatus(id, 'processed', `note:${noteId}`);
    expect(db.listInbox('open')).toHaveLength(0);
    item = db.listInbox('processed')[0];
    expect(item.converted_to).toBe(`note:${noteId}`);
    expect(db.inboxOpenCount()).toBe(0);
  });

  it('丢弃与彻底删除', () => {
    const a = db.addInbox('要丢弃的');
    const b = db.addInbox('要删掉的');
    db.setInboxStatus(a, 'discarded');
    expect(db.listInbox('discarded')).toHaveLength(1);
    db.deleteInbox(b);
    expect(db.listInbox('all')).toHaveLength(1);
  });
});

describe('笔记与版本点', () => {
  it('新建笔记后能读回，字数会被算出来', () => {
    const id = db.createNote({ title: '测试笔记', content: '间隔重复的记忆方法' });
    const note = db.getNote(id);
    expect(note?.title).toBe('测试笔记');
    expect(note?.word_count).toBeGreaterThan(0);
  });

  it('手动保存会留一个版本点，正文跟着更新', () => {
    const id = db.createNote({ title: '初稿', content: '第一版内容' });
    const v = db.saveNote(id, '第二稿', '第二版内容');
    expect(v).not.toBeNull();
    expect(db.getNote(id)?.content).toBe('第二版内容');
    const versions = db.listVersions(id);
    expect(versions).toHaveLength(1);
    // 版本点就是「这一次保存下来的样子」，以后可以回滚到它
    expect(versions[0].content).toBe('第二版内容');
    expect(versions[0].title).toBe('第二稿');
    expect(versions[0].word_count).toBe(db.countWords('第二版内容'));
  });

  it('内容没变时再保存不会堆出一堆一样的版本点', () => {
    const id = db.createNote({ title: 'A', content: '同样的内容' });
    expect(db.saveNote(id, 'A', '同样的内容')).toBeNull();
    expect(db.listVersions(id)).toHaveLength(0);
    db.saveNote(id, 'A', '改过的内容');
    expect(db.listVersions(id)).toHaveLength(1);
  });

  it('自动草稿只进草稿字段，不动正文', () => {
    const id = db.createNote({ title: '原标题', content: '原正文' });
    db.saveDraft(id, '草稿标题', '草稿正文');
    let note = db.getNote(id);
    expect(note?.title).toBe('原标题');
    expect(note?.content).toBe('原正文');
    expect(note?.draft_title).toBe('草稿标题');
    db.discardDraft(id);
    note = db.getNote(id);
    expect(note?.draft_title).toBeNull();
  });

  it('版本点按设置的数量裁剪', () => {
    db.setSetting('versionKeep', '2');
    const id = db.createNote({ title: 'A', content: '0' });
    for (let i = 1; i <= 5; i += 1) db.saveNote(id, 'A', `第${i}版`);
    expect(db.listVersions(id).length).toBe(2);
    expect(db.getNote(id)?.content).toBe('第5版');
  });

  it('versionKeep = 0 时不留版本点', () => {
    db.setSetting('versionKeep', '0');
    const id = db.createNote({ title: 'A', content: '0' });
    db.saveNote(id, 'A', '1');
    db.saveNote(id, 'A', '2');
    expect(db.listVersions(id)).toHaveLength(0);
    db.setSetting('versionKeep', '20');
  });

  it('能回滚到某个版本点，并且回滚前会先把当前内容存成新版本点', () => {
    const id = db.createNote({ title: 'A', content: 'v1' });
    db.saveNote(id, 'A', 'v2');
    db.saveNote(id, 'A', 'v3');
    const toV2 = db.listVersions(id).find((v) => v.content === 'v2');
    expect(toV2).toBeTruthy();
    db.rollbackVersion(toV2!.id);
    expect(db.getNote(id)?.content).toBe('v2');
    // 回滚也能反悔：v3 被存成了新版本点
    expect(db.listVersions(id).some((v) => v.content === 'v3')).toBe(true);
  });

  it('置顶、改分类、进回收站、还原、彻底删除', () => {
    const cat = db.createCategory(null, '临时分类');
    const id = db.createNote({ title: '要移动的', categoryId: cat });
    db.togglePin(id);
    expect(db.listNotes().find((n) => n.id === id)?.is_pinned).toBe(1);
    db.moveNote(id, null);
    expect(db.getNote(id)?.category_id).toBeNull();

    db.trashNote(id);
    expect(db.listNotes().some((n) => n.id === id)).toBe(false);
    expect(db.listNotes({ trash: true }).some((n) => n.id === id)).toBe(true);

    db.restoreNote(id);
    expect(db.listNotes().some((n) => n.id === id)).toBe(true);

    db.trashNote(id);
    db.purgeNote(id);
    expect(db.getNote(id)).toBeNull();
  });

  it('回收站里超过 30 天的会被清掉，没到的留着', () => {
    const oldOne = db.createNote({ title: '很久以前删的' });
    const recent = db.createNote({ title: '刚删的' });
    db.trashNote(oldOne);
    db.trashNote(recent);
    db.getRawDb()
      .prepare('update note set deleted_at = ? where id = ?')
      .run(isoLocal(new Date(Date.now() - 31 * 24 * 3600 * 1000)), oldOne);
    const removed = db.purgeExpiredTrash();
    expect(removed).toBe(1);
    expect(db.getNote(oldOne)).toBeNull();
    expect(db.listNotes({ trash: true }).some((n) => n.id === recent)).toBe(true);
  });
});

describe('全文搜索（中文逐字分词方案）', () => {
  it('两个字的中文词能搜到', () => {
    db.createNote({ title: '学习方法', content: '间隔重复比一遍遍重读有效得多' });
    expect(db.searchNotes('间隔').length).toBe(1);
    expect(db.searchNotes('重复').length).toBe(1);
  });

  it('四个字的词和跨词片段也能搜到', () => {
    db.createNote({ title: '学习方法', content: '间隔重复比一遍遍重读有效得多' });
    expect(db.searchNotes('间隔重复').length).toBe(1);
    expect(db.searchNotes('重读').length).toBe(1);
  });

  it('多个词之间是「都要有」，不是「有一个就行」', () => {
    db.createNote({ title: '甲', content: '间隔重复的记忆方法' });
    db.createNote({ title: '乙', content: '间隔只是时间间隔' });
    expect(db.searchNotes('间隔').length).toBe(2);
    expect(db.searchNotes('间隔 记忆').length).toBe(1);
    expect(db.searchNotes('间隔 不存在的词').length).toBe(0);
  });

  it('搜标题也能命中，并且给出摘要', () => {
    db.createNote({ title: '深度工作', content: '专注力是稀缺资源' });
    const hits = db.searchNotes('深度工作');
    expect(hits.length).toBe(1);
    expect(hits[0].title).toBe('深度工作');
  });

  it('英文单词能搜到，搜不到的词返回空数组而不是报错', () => {
    db.createNote({ title: 'Deep Work', content: 'focus is scarce' });
    expect(db.searchNotes('focus').length).toBe(1);
    expect(db.searchNotes('zzzz不存在zzzz')).toEqual([]);
  });

  it('已删除的笔记不出现在搜索结果里', () => {
    const id = db.createNote({ title: '临时', content: '独有的词组甲乙丙' });
    expect(db.searchNotes('独有').length).toBe(1);
    db.trashNote(id);
    expect(db.searchNotes('独有').length).toBe(0);
  });

  it('改过正文之后，旧内容搜不到、新内容能搜到', () => {
    const id = db.createNote({ title: '标题', content: '旧内容甲乙丙' });
    db.saveNote(id, '标题', '新内容丁戊己');
    expect(db.searchNotes('旧内容')).toHaveLength(0);
    expect(db.searchNotes('新内容')).toHaveLength(1);
  });

  it('重建索引后照样能搜', () => {
    db.createNote({ title: '索引测试', content: '重建以后也要能搜到' });
    const n = db.rebuildSearchIndex();
    expect(n).toBeGreaterThan(0);
    expect(db.searchNotes('重建').length).toBe(1);
  });
});

describe('标签', () => {
  it('能给笔记打标签、按标签筛笔记', () => {
    const a = db.createNote({ title: '甲', content: '甲的内容' });
    const b = db.createNote({ title: '乙', content: '乙的内容' });
    db.setNoteTags(a, ['工作', '重要']);
    db.setNoteTags(b, ['生活']);
    const tags = db.listTags();
    expect(tags.map((t) => t.name)).toEqual(expect.arrayContaining(['工作', '重要', '生活']));
    const work = tags.find((t) => t.name === '工作')!;
    const filtered = db.listNotes({ tagId: work.id });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].title).toBe('甲');
  });

  it('重设标签会覆盖旧的', () => {
    const a = db.createNote({ title: '甲', content: 'x' });
    db.setNoteTags(a, ['工作', '重要']);
    db.setNoteTags(a, ['学习']);
    expect(db.getNote(a)?.tags.map((t) => t.name)).toEqual(['学习']);
  });
});

describe('任务与重复规则', () => {
  it('按今天 / 已逾期 / 接下来 / 全部 / 已完成 筛选', () => {
    const today = todayLocal();
    db.createTask({ title: '今天的', due_at: today });
    db.createTask({ title: '昨天就该做的', due_at: dayOffset(-1) });
    db.createTask({ title: '下周的', due_at: dayOffset(7) });
    const doneId = db.createTask({ title: '已经做完的', due_at: today });
    db.toggleTask(doneId, 'done');

    // 「今天」视图按产品约定把逾期的也一起列出来（界面上会标红），越早的排越前；
    // 已完成的也留在列表里，只是被排到最后（优化项 4：勾完不消失）
    expect(db.listTasks({ view: 'today' }).map((t) => t.title)).toEqual([
      '昨天就该做的',
      '今天的',
      '已经做完的'
    ]);
    expect(db.listTasks({ view: 'overdue' }).map((t) => t.title)).toEqual(['昨天就该做的']);
    expect(db.listTasks({ view: 'upcoming' }).map((t) => t.title)).toEqual(['下周的']);
    expect(db.listTasks({ view: 'all' })).toHaveLength(4);
    expect(db.listTasks({ view: 'done' }).map((t) => t.title)).toEqual(['已经做完的']);
  });

  it('状态三档筛选：全部 / 未完成 / 已完成，勾完不消失', () => {
    const a = db.createTask({ title: '甲', due_at: todayLocal() });
    const b = db.createTask({ title: '乙', due_at: todayLocal() });
    const c = db.createTask({ title: '丙', due_at: todayLocal() });
    db.toggleTask(b, 'done');

    expect(db.listTasks({ view: 'all', status: 'todo' }).map((t) => t.title).sort()).toEqual(['丙', '甲']);
    expect(db.listTasks({ view: 'all', status: 'done' }).map((t) => t.title)).toEqual(['乙']);
    expect(db.listTasks({ view: 'all' }).map((t) => t.title).sort()).toEqual(['丙', '乙', '甲']);
    // 勾完不消失：今天视图里还在，只是排到最后
    expect(db.listTasks({ view: 'today' }).map((t) => t.title)).toEqual(['丙', '甲', '乙']);
    // 「接下来」视图仍然只列没做完的：已经做完的不该再算「接下来」
    const future = db.createTask({ title: '下周', due_at: dayOffset(7) });
    db.toggleTask(future, 'done');
    expect(db.listTasks({ view: 'upcoming' })).toHaveLength(0);

    // 批量删除走软删除，返回真正删掉的条数
    const before = db.taskCounts();
    expect(db.deleteTasks([a, c])).toBe(2);
    expect(db.deleteTasks([])).toBe(0);
    expect(db.deleteTasks([a])).toBe(0); // 已经删过的不再计数
    expect(db.listTasks({ view: 'all', status: 'todo' })).toHaveLength(0);
    expect(db.taskCounts().all).toBe(before.all - 2);
    expect(db.taskCounts().todo).toBe(0);
    expect(db.taskCounts().done).toBe(2);
  });

  it('优先级与截止日能改', () => {
    const id = db.createTask({ title: '改我', priority: 'normal' });
    db.updateTask(id, { priority: 'urgent', due_at: dayOffset(2) });
    const t = db.listTasks({ view: 'all' }).find((x) => x.id === id)!;
    expect(t.priority).toBe('urgent');
    expect(t.due_at).toBe(dayOffset(2));
  });

  it('勾掉普通任务不会生成下一次', () => {
    const id = db.createTask({ title: '一次性的', due_at: todayLocal() });
    const res = db.toggleTask(id);
    expect(res.task?.status).toBe('done');
    expect(res.spawned).toBeNull();
    expect(db.listTasks({ view: 'all' })).toHaveLength(1);
  });

  it('每日重复：勾掉后生成明天那一条，原条留作记录', () => {
    const id = db.createTask({ title: '晨读', due_at: todayLocal(), repeat_rule: 'daily' });
    const res = db.toggleTask(id);
    expect(res.spawned).not.toBeNull();
    const all = db.listTasks({ view: 'all' });
    expect(all).toHaveLength(2);
    const spawned = all.find((t) => t.id === res.spawned)!;
    expect(spawned.status).toBe('todo');
    expect(spawned.due_at).toBe(dayOffset(1));
    expect(all.find((t) => t.id === id)!.status).toBe('done');
  });

  it('工作日重复：周五做完跳到下周一', () => {
    // 2026-10-16 是周五
    const id = db.createTask({ title: '工作日任务', due_at: '2026-10-16', repeat_rule: 'weekdays' });
    const res = db.toggleTask(id);
    const spawned = db.listTasks({ view: 'all' }).find((t) => t.id === res.spawned)!;
    expect(spawned.due_at).toBe('2026-10-19');
  });

  it('每周重复：往后加 7 天', () => {
    const id = db.createTask({ title: '周会', due_at: '2026-10-16', repeat_rule: 'weekly' });
    const res = db.toggleTask(id);
    const spawned = db.listTasks({ view: 'all' }).find((t) => t.id === res.spawned)!;
    expect(spawned.due_at).toBe('2026-10-23');
  });

  it('每月重复：1 月 31 日跳到 2 月的最后一天，不会溢到 3 月', () => {
    const id = db.createTask({ title: '月底对账', due_at: '2026-01-31', repeat_rule: 'monthly' });
    const res = db.toggleTask(id);
    const spawned = db.listTasks({ view: 'all' }).find((t) => t.id === res.spawned)!;
    expect(spawned.due_at).toBe('2026-02-28');
  });

  it('带时间的截止日会保留时间部分', () => {
    const id = db.createTask({ title: '带时间', due_at: '2026-01-31 09:30', repeat_rule: 'monthly' });
    const res = db.toggleTask(id);
    const spawned = db.listTasks({ view: 'all' }).find((t) => t.id === res.spawned)!;
    expect(spawned.due_at).toBe('2026-02-28 09:30');
  });

  it('取消勾选会把状态改回未完成', () => {
    const id = db.createTask({ title: '反悔', due_at: todayLocal() });
    db.toggleTask(id, 'done');
    db.toggleTask(id, 'todo');
    const t = db.listTasks({ view: 'all' }).find((x) => x.id === id)!;
    expect(t.status).toBe('todo');
    expect(t.completed_at).toBeNull();
  });

  it('删除任务后不再出现在任何视图里', () => {
    const id = db.createTask({ title: '要删的' });
    db.deleteTask(id);
    expect(db.listTasks({ view: 'all' })).toHaveLength(0);
  });

  it('到期通知只挑出「已逾期 + 今天到期」的未完成任务', () => {
    db.createTask({ title: '今天到期', due_at: todayLocal() });
    db.createTask({ title: '已逾期', due_at: dayOffset(-2) });
    db.createTask({ title: '明天的', due_at: dayOffset(1) });
    const ids = db.dueTasksForNotice().map((t) => t.title);
    expect(ids).toEqual(expect.arrayContaining(['今天到期', '已逾期']));
    expect(ids).not.toContain('明天的');
  });
});

describe('目标、计划与首页汇总', () => {
  it('收集箱能一键转成目标与计划', () => {
    const goalId = db.createGoalFromInbox('三个月读完 12 本书');
    const planId = db.createPlanFromInbox('每天读 30 页', '读书');
    expect(goalId).toBeGreaterThan(0);
    expect(planId).toBeGreaterThan(0);
  });

  it('目标没有关键结果时，按关联任务的完成比例算进度', () => {
    const goalId = db.createGoalFromInbox('学会 TypeScript');
    const t1 = db.createTask({ title: '看文档', goal_id: goalId });
    db.createTask({ title: '写练习', goal_id: goalId });
    expect(db.goalProgress(goalId)).toBe(0);
    db.toggleTask(t1, 'done');
    expect(db.goalProgress(goalId)).toBe(50);
  });

  it('首页汇总：今日待办、逾期数、今日完成数、待整理数、最近笔记', () => {
    const today = todayLocal();
    const a = db.createTask({ title: '今天的', due_at: today });
    db.createTask({ title: '逾期的', due_at: dayOffset(-3) });
    const done = db.createTask({ title: '今天做完的', due_at: today });
    db.toggleTask(done, 'done');
    db.addInbox('一个想法');
    db.addInbox('另一条');
    db.createNote({ title: '最近写的' });

    const d = db.dashboard();
    expect(d.today).toBe(today);
    expect(d.tasks.map((t) => t.title)).toEqual(expect.arrayContaining(['今天的', '逾期的']));
    expect(d.overdueCount).toBe(1);
    expect(d.doneTodayCount).toBe(1);
    expect(d.inboxCount).toBe(2);
    expect(d.recentNotes.map((n) => n.title)).toContain('最近写的');
    expect(a).toBeGreaterThan(0);
  });

  it('首页的今日待办把逾期的排在最前面', () => {
    db.createTask({ title: '今天的', due_at: todayLocal() });
    db.createTask({ title: '更早逾期的', due_at: dayOffset(-5) });
    db.createTask({ title: '昨天逾期的', due_at: dayOffset(-1) });
    const titles = db.dashboard().tasks.map((t) => t.title);
    expect(titles[0]).toBe('更早逾期的');
    expect(titles[1]).toBe('昨天逾期的');
    expect(titles[2]).toBe('今天的');
  });
});

describe('附件', () => {
  it('加进去的文件会按年月复制到附件目录，并记进数据库', () => {
    const noteId = db.createNote({ title: '带附件的笔记' });
    const src = path.join(root, '原始文件.txt');
    fs.writeFileSync(src, '附件内容', 'utf8');
    const att = db.addAttachment(noteId, src, '原始文件.txt');
    expect(att.file_name).toBe('原始文件.txt');
    expect(att.size).toBeGreaterThan(0);
    const abs = db.attachmentAbsPath(att.rel_path);
    expect(fs.existsSync(abs)).toBe(true);
    expect(fs.readFileSync(abs, 'utf8')).toBe('附件内容');
    expect(db.getNote(noteId)?.attachments).toHaveLength(1);
  });

  it('同名文件会被改名，不会互相覆盖', () => {
    const noteId = db.createNote({ title: 'x' });
    const src = path.join(root, '同名源.txt');
    fs.writeFileSync(src, '一是', 'utf8');
    const a = db.addAttachment(noteId, src, '同名.txt');
    fs.writeFileSync(src, '二是', 'utf8');
    const b = db.addAttachment(noteId, src, '同名.txt');
    expect(b.rel_path).not.toBe(a.rel_path);
    expect(fs.readFileSync(db.attachmentAbsPath(b.rel_path), 'utf8')).toBe('二是');
  });

  it('删附件会连磁盘上的文件一起删掉', () => {
    const noteId = db.createNote({ title: 'y' });
    const src = path.join(root, '待删.txt');
    fs.writeFileSync(src, 'x', 'utf8');
    const att = db.addAttachment(noteId, src, '待删.txt');
    const abs = db.attachmentAbsPath(att.rel_path);
    db.deleteAttachment(att.id);
    expect(fs.existsSync(abs)).toBe(false);
    expect(db.getNote(noteId)?.attachments).toHaveLength(0);
  });
});

describe('设置', () => {
  it('能写能读，读不到时返回 null', () => {
    db.setSetting('theme', 'dark');
    expect(db.getSetting('theme')).toBe('dark');
    expect(db.getSetting('压根没设过的键')).toBeNull();
    db.setSetting('theme', 'light');
    expect(db.allSettings().theme).toBe('light');
  });
});
