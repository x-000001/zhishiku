import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as db from '../../src/main/db';
import { ensureDirs, todayLocal, type DataPaths } from '../../src/main/paths';

let root = '';
let paths: DataPaths;

const pad = (n: number) => String(n).padStart(2, '0');
function dayOffset(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function resetData(): void {
  const raw = db.getRawDb();
  raw.exec('PRAGMA foreign_keys = OFF');
  for (const t of [
    'note_tag',
    'note_version',
    'attachment',
    'review_log',
    'review_card',
    'retrospective',
    'task',
    'goal_key_result',
    'milestone',
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
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'jwkb-v2-'));
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

/* ------------------------------------------------------------------ */
/* 当前目标                                                            */
/* ------------------------------------------------------------------ */

describe('当前目标', () => {
  it('能建目标并按条目组装详情', () => {
    const id = db.createGoal({ title: '学会 TypeScript', description: '打基础', target_date: '2026-12-31' });
    const detail = db.getGoalDetail(id);
    expect(detail).not.toBeNull();
    expect(detail!.goal.title).toBe('学会 TypeScript');
    expect(detail!.goal.progress).toBe(0);
    expect(detail!.keyResults).toHaveLength(0);
    expect(detail!.milestones).toHaveLength(0);
  });

  it('当前目标最多 3 个，第 4 个被挡下', () => {
    db.createGoal({ title: '目标一' });
    db.createGoal({ title: '目标二' });
    db.createGoal({ title: '目标三' });
    expect(db.activeGoalCount()).toBe(3);
    expect(() => db.createGoal({ title: '目标四' })).toThrow(/最多 3 个/);
    // 归档一个之后又能建了
    const first = db.listGoals()[0];
    db.updateGoal(first.id, { status: 'archived' });
    expect(db.activeGoalCount()).toBe(2);
    expect(() => db.createGoal({ title: '目标四' })).not.toThrow();
  });

  it('空名称的目标建不出来', () => {
    expect(() => db.createGoal({ title: '   ' })).toThrow(/不能为空/);
  });

  it('关键结果完成度会算进进度', () => {
    const g = db.createGoal({ title: '减脂' });
    const kr = db.createKeyResult(g, { title: '跑步公里数', target_value: 4, current_value: 1 });
    expect(db.goalProgress(g)).toBe(25);
    db.updateKeyResult(kr, { current_value: 4 });
    expect(db.goalProgress(g)).toBe(100);
  });

  it('进度取「关键结果」与「关联任务完成率」的平均', () => {
    const g = db.createGoal({ title: '读书' });
    db.createKeyResult(g, { title: '读完 4 本', target_value: 4, current_value: 1 }); // 25%
    const t1 = db.createTask({ title: '买书', goal_id: g });
    db.createTask({ title: '读书笔记', goal_id: g });
    db.toggleTask(t1);
    expect(db.goalProgress(g)).toBe(38); // (0.25 + 0.5) / 2 = 0.375 → 38
  });

  it('没有关键结果也没有任务时，退到里程碑完成率', () => {
    const g = db.createGoal({ title: '整理房间' });
    const m1 = db.createMilestone(g, { title: '扔掉杂物' });
    db.createMilestone(g, { title: '擦窗户' });
    db.toggleMilestone(m1, true);
    expect(db.goalProgress(g)).toBe(50);
  });

  it('里程碑勾选会记下完成时间，取消后清掉', () => {
    const g = db.createGoal({ title: '学吉他' });
    const m = db.createMilestone(g, { title: '练会 C 和弦' });
    db.toggleMilestone(m);
    let row = db.listMilestones(g)[0];
    expect(row.done).toBe(1);
    expect(row.done_at).not.toBeNull();
    db.toggleMilestone(m);
    row = db.listMilestones(g)[0];
    expect(row.done).toBe(0);
    expect(row.done_at).toBeNull();
  });

  it('删目标：任务留着只解除关联，关键结果与里程碑清掉', () => {
    const g = db.createGoal({ title: '学英语' });
    const t = db.createTask({ title: '背单词', goal_id: g });
    db.createKeyResult(g, { title: '词汇量', target_value: 5000 });
    db.createMilestone(g, { title: '过四级' });
    db.deleteGoal(g);

    expect(db.listGoals().find((x) => x.id === g)).toBeUndefined();
    const task = db.listTasks({ view: 'all' }).find((x) => x.id === t);
    expect(task).toBeDefined();
    expect(task!.goal_id).toBeNull();
    expect(db.getGoalDetail(g)).toBeNull();
    expect(db.getRawDb().prepare('select count(*) as c from goal_key_result').get()).toEqual({ c: 0 });
    expect(db.getRawDb().prepare('select count(*) as c from milestone').get()).toEqual({ c: 0 });
  });
});

/* ------------------------------------------------------------------ */
/* 下一阶段目标                                                        */
/* ------------------------------------------------------------------ */

describe('下一阶段目标（目标池）', () => {
  it('填了启动条件的条目自动标成待启动', () => {
    const a = db.createPoolItem({ title: '学做菜' });
    const b = db.createPoolItem({ title: '学游泳', start_condition: '等夏天到了' });
    const rows = db.listGoalPool();
    expect(rows.find((r) => r.id === a)!.status).toBe('pool');
    expect(rows.find((r) => r.id === b)!.status).toBe('ready');
  });

  it('启动一条入池想法会真的建成当前目标并回链', () => {
    const p = db.createPoolItem({ title: '做个人网站', why: '想有个作品集', start_condition: '学完前端' });
    const { goalId } = db.startPoolItem(p);
    expect(db.getGoalDetail(goalId)!.goal.title).toBe('做个人网站');
    const row = db.listGoalPool().find((r) => r.id === p)!;
    expect(row.goal_id).toBe(goalId);
    expect(row.status).toBe('started');
    // 同一条不能启动两次
    expect(() => db.startPoolItem(p)).toThrow(/已经启动过/);
  });

  it('路线图按地平线筛选', () => {
    db.createPoolItem({ title: '近期想法', horizon: 'this' });
    db.createPoolItem({ title: '以后再说', horizon: 'later' });
    expect(db.listGoalPool('this')).toHaveLength(1);
    expect(db.listGoalPool('later')).toHaveLength(1);
    expect(db.listGoalPool()).toHaveLength(2);
  });

  it('目标池内容可以改，可以删', () => {
    const p = db.createPoolItem({ title: '旧想法' });
    db.updatePoolItem(p, { title: '新想法', why: '换个理由', priority: 3 });
    let row = db.listGoalPool()[0];
    expect(row.title).toBe('新想法');
    expect(row.priority).toBe(3);
    db.deletePoolItem(p);
    expect(db.listGoalPool()).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* 学习计划                                                            */
/* ------------------------------------------------------------------ */

describe('学习计划', () => {
  it('能建计划、加条目，并统计完成数', () => {
    const plan = db.createPlan({
      title: '每天读 30 分钟',
      direction: '读书',
      rhythm: '每天 30 分钟',
      start_date: '2026-10-01',
      end_date: '2026-12-31'
    });
    const i1 = db.createPlanItem(plan, { title: '读《深度工作》第一章', date: todayLocal(), minutes: 30 });
    db.createPlanItem(plan, { title: '读第二章', date: dayOffset(1), minutes: 30 });
    db.togglePlanItem(i1, true);

    const summaries = db.listPlans();
    expect(summaries).toHaveLength(1);
    expect(summaries[0].item_count).toBe(2);
    expect(summaries[0].done_count).toBe(1);

    const detail = db.getPlanDetail(plan)!;
    expect(detail.items).toHaveLength(2);
    expect(detail.items.find((i) => i.id === i1)!.done_at).not.toBeNull();
  });

  it('计划可以挂在目标下面', () => {
    const g = db.createGoal({ title: '成为前端开发' });
    const plan = db.createPlan({ title: '学 React', goal_id: g });
    expect(db.listPlans()[0].goal_title).toBe('成为前端开发');
    expect(db.getPlanDetail(plan)!.plan.goal_id).toBe(g);
  });

  it('日历只取日期落在这段区间里的条目', () => {
    const plan = db.createPlan({ title: '背单词' });
    db.createPlanItem(plan, { title: '今天的', date: todayLocal() });
    db.createPlanItem(plan, { title: '明天的', date: dayOffset(1) });
    db.createPlanItem(plan, { title: '没定日期的', date: null });

    const today = db.calendarEntries(todayLocal(), todayLocal());
    expect(today).toHaveLength(1);
    expect(today[0].title).toBe('今天的');
    expect(today[0].plan_title).toBe('背单词');

    const twoDays = db.calendarEntries(todayLocal(), dayOffset(1));
    expect(twoDays).toHaveLength(2);
  });

  it('删计划是软删，列表里看不到', () => {
    const plan = db.createPlan({ title: '要删掉的计划' });
    db.deletePlan(plan);
    expect(db.listPlans()).toHaveLength(0);
    expect(db.getPlanDetail(plan)).toBeNull();
    // 归档参数带上也看不到软删的
    expect(db.listPlans(true)).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* 复习                                                                */
/* ------------------------------------------------------------------ */

describe('复习（简化 SM-2）', () => {
  it('从笔记一键生成卡片，同一篇不会重复建', () => {
    const noteId = db.createNote({ title: '什么是闭包', content: '闭包是函数和它捕获的变量的组合。' });
    const id1 = db.createCardFromNote(noteId);
    const id2 = db.createCardFromNote(noteId);
    expect(id1).toBe(id2);
    const card = db.listReviewCards()[0];
    expect(card.front).toBe('什么是闭包');
    expect(card.back).toContain('闭包');
    expect(card.next_review_at).toBe(todayLocal());
  });

  it('「记得」把间隔阶梯往上推一格', () => {
    const card = db.createReviewCard({ front: 'A' });
    const after1 = db.gradeReviewCard(card, 'know')!;
    expect(after1.ease_level).toBe(1);
    expect(after1.interval_days).toBe(db.REVIEW_LADDER[0]);
    expect(after1.next_review_at).toBe(dayOffset(db.REVIEW_LADDER[0]));
    expect(after1.review_count).toBe(1);
    const after2 = db.gradeReviewCard(card, 'know')!;
    expect(after2.ease_level).toBe(2);
    expect(after2.interval_days).toBe(db.REVIEW_LADDER[1]);
  });

  it('「模糊」退回一格并把间隔打折', () => {
    const card = db.createReviewCard({ front: 'B' });
    db.gradeReviewCard(card, 'know'); // 到第 1 级，间隔 1 天
    const after = db.gradeReviewCard(card, 'fuzzy')!;
    expect(after.ease_level).toBe(0);
    expect(after.interval_days).toBe(1); // 至少 1 天
    expect(after.next_review_at).toBe(dayOffset(1));
  });

  it('「忘了」回到起点、今天再来一次，并记一次遗忘', () => {
    const card = db.createReviewCard({ front: 'C' });
    db.gradeReviewCard(card, 'know');
    db.gradeReviewCard(card, 'know');
    const after = db.gradeReviewCard(card, 'forgot')!;
    expect(after.ease_level).toBe(0);
    expect(after.interval_days).toBe(0);
    expect(after.next_review_at).toBe(todayLocal());
    expect(after.lapses).toBe(1);
  });

  it('每次打分都留一条复习记录', () => {
    const card = db.createReviewCard({ front: 'D' });
    db.gradeReviewCard(card, 'know');
    db.gradeReviewCard(card, 'fuzzy');
    db.gradeReviewCard(card, 'forgot');
    const logs = db.reviewLogs(card);
    expect(logs).toHaveLength(3);
    expect(logs.map((l) => l.result)).toEqual(['forgot', 'fuzzy', 'know']); // 倒序，最新的在前面
    expect(Number(logs[0].interval_after)).toBe(0);
  });

  it('到期列表只收今天及以前的卡', () => {
    const due = db.createReviewCard({ front: '今天到期' });
    db.createReviewCard({ front: '明天到期', next_review_at: dayOffset(1) });
    db.createReviewCard({ front: '后天到期', next_review_at: dayOffset(2) });
    const rows = db.dueReviewCards();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(due);
  });

  it('统计数字对得上', () => {
    const a = db.createReviewCard({ front: 'E' });
    db.createReviewCard({ front: 'F', next_review_at: dayOffset(3) });
    db.createReviewCard({ front: 'G' }); // 今天到期、还没复习
    db.gradeReviewCard(a, 'know'); // 打完分就不在今天到期里了
    const s = db.reviewStats();
    expect(s.total).toBe(3);
    expect(s.dueToday).toBe(1);
    expect(s.learned).toBe(1);
    expect(s.reviewedToday).toBe(1);
    expect(s.lapses).toBe(0);
  });

  it('删卡片是软删，列表与到期里都不再出现', () => {
    const card = db.createReviewCard({ front: 'G' });
    db.deleteReviewCard(card);
    expect(db.listReviewCards()).toHaveLength(0);
    expect(db.dueReviewCards()).toHaveLength(0);
    expect(db.gradeReviewCard(card, 'know')).toBeNull();
  });

  it('复习页能按来源与到期筛选', () => {
    db.createReviewCard({ front: '错题', source: 'wrong', next_review_at: dayOffset(5) });
    db.createReviewCard({ front: '难点', source: 'hard' });
    expect(db.listReviewCards({ source: 'wrong' })).toHaveLength(1);
    expect(db.listReviewCards({ due: true })).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* 复盘                                                                */
/* ------------------------------------------------------------------ */

describe('复盘', () => {
  it('同一周期的复盘反复保存是覆盖，不产生新记录', () => {
    const id1 = db.saveRetrospective('day', '2026-10-16', '今天读了两章');
    const id2 = db.saveRetrospective('day', '2026-10-16', '今天读了三章');
    expect(id1).toBe(id2);
    expect(db.getRetrospective('day', '2026-10-16')!.content).toBe('今天读了三章');
    expect(db.listRetrospectives('day')).toHaveLength(1);
  });

  it('日/周/月三种复盘互不干扰', () => {
    db.saveRetrospective('day', '2026-10-16', '日');
    db.saveRetrospective('week', '2026-10-16', '周');
    db.saveRetrospective('month', '2026-10-16', '月');
    expect(db.listRetrospectives()).toHaveLength(3);
    expect(db.listRetrospectives('week')).toHaveLength(1);
  });

  it('周区间是周一到周日，月区间是当月一号到月末', () => {
    const week = db.periodRange('week', new Date(2026, 9, 16, 12, 0, 0)); // 2026-10-16 是周五
    expect(week.from).toBe('2026-10-12');
    expect(week.to).toBe('2026-10-18');
    expect(new Date(`${week.from}T12:00:00`).getDay()).toBe(1);

    const month = db.periodRange('month', new Date(2026, 1, 15, 12, 0, 0)); // 2026 年 2 月
    expect(month.from).toBe('2026-02-01');
    expect(month.to).toBe('2026-02-28');
  });

  it('周期统计会数出完成的任务、写过的笔记、复习次数与计划条目', () => {
    const from = todayLocal();
    const t = db.createTask({ title: '今天做完的事' });
    db.toggleTask(t);
    db.createNote({ title: '今天的笔记', content: '写点东西' });
    const card = db.createReviewCard({ front: 'H' });
    db.gradeReviewCard(card, 'know');
    const plan = db.createPlan({ title: '今天的计划' });
    const i1 = db.createPlanItem(plan, { title: '第一条', date: from });
    db.createPlanItem(plan, { title: '第二条', date: from });
    db.togglePlanItem(i1, true);

    const s = db.periodStats(from, from);
    expect(s.tasksDone).toBe(1);
    expect(s.notesWritten).toBeGreaterThanOrEqual(1);
    expect(s.reviewsDone).toBe(1);
    expect(s.planItemsDone).toBe(1);
    expect(s.planItemsTotal).toBe(2);
  });

  it('复盘可以删', () => {
    const id = db.saveRetrospective('day', '2026-10-15', '随便写写');
    db.deleteRetrospective(id);
    expect(db.getRetrospective('day', '2026-10-15')).toBeNull();
  });

  it('优先级三档（紧急/重要/一般）能存能排', () => {
    const normal = db.createTask({ title: '不急的事', priority: 'normal' });
    const urgent = db.createTask({ title: '最要紧的事', priority: 'urgent' });
    const important = db.createTask({ title: '挺重要的事', priority: 'important' });
    const list = db.listTasks({ view: 'all' });
    expect(list.find((t) => t.id === normal)!.priority).toBe('normal');
    const idx = (id: number) => list.findIndex((t) => t.id === id);
    expect(idx(urgent)).toBeLessThan(idx(important));
    expect(idx(important)).toBeLessThan(idx(normal));
    // 筛选某一档时只剩那一档
    expect(db.listTasks({ view: 'all', priority: 'urgent' }).map((t) => t.title)).toEqual(['最要紧的事']);
    // 老代码传数字也会被归一成三档文字
    db.updateTask(normal, { priority: 3 as unknown as 'normal' });
    expect(db.listTasks({ view: 'all' }).find((t) => t.id === normal)!.priority).toBe('urgent');
  });
});

/* ------------------------------------------------------------------ */
/* 提醒与首页                                                          */
/* ------------------------------------------------------------------ */

describe('提醒时间与首页汇总', () => {
  it('设了提醒时间的任务，到点就会进通知列表', () => {
    const soon = db.createTask({ title: '马上要提醒', remind_at: `${todayLocal()} 00:01` });
    const later = db.createTask({ title: '以后再说', remind_at: `${dayOffset(1)} 09:00` });
    const ids = db.dueTasksForNotice().map((t) => t.id);
    expect(ids).toContain(soon);
    expect(ids).not.toContain(later);
  });

  it('没设提醒时间时，仍然按截止日提醒（含逾期）', () => {
    const overdue = db.createTask({ title: '已经逾期', due_at: dayOffset(-1) });
    const future = db.createTask({ title: '下周的事', due_at: dayOffset(7) });
    const ids = db.dueTasksForNotice().map((t) => t.id);
    expect(ids).toContain(overdue);
    expect(ids).not.toContain(future);
  });

  it('完成的任务不再提醒', () => {
    const t = db.createTask({ title: '做完了', remind_at: `${todayLocal()} 00:01` });
    db.toggleTask(t);
    expect(db.dueTasksForNotice().map((x) => x.id)).not.toContain(t);
  });

  it('首页带上今日计划与复习到期数量', () => {
    const g = db.createGoal({ title: '首页目标' });
    const plan = db.createPlan({ title: '首页计划' });
    db.createPlanItem(plan, { title: '今天要学的一节', date: todayLocal() });
    db.createReviewCard({ front: '今天到期的卡' });
    db.createTask({ title: '今天要做的事', due_at: todayLocal() });

    const d = db.dashboard();
    expect(d.today).toBe(todayLocal());
    expect(d.todayPlan).toHaveLength(1);
    expect(d.todayPlan[0].title).toBe('今天要学的一节');
    expect(d.reviewDueCount).toBe(1);
    expect(d.goals.map((x) => x.id)).toContain(g);
    expect(d.tasks.map((t) => t.title)).toContain('今天要做的事');
  });
});
