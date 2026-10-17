import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as db from '../../src/main/db';
import { createFocus, type FocusDeps } from '../../src/main/focus';
import { ensureDirs } from '../../src/main/paths';
import { BREAK_SECONDS, DEFAULT_FOCUS_MINUTES } from '../../src/shared/focus';
import type { FocusState } from '../../src/shared/types';

/**
 * 番茄钟计时引擎（第六版 / 阶段2）。
 * 用假时钟把 25 分钟瞬间跑完 —— 不用真等，也不依赖真实 setInterval。
 */

let root = '';
let clock = 0;
let timers: { handle: number; at: number; fn: () => void }[] = [];
let emitted: FocusState[] = [];
let notified: { title: string; body: string }[] = [];
let nextHandle = 1;

function makeDeps(): FocusDeps {
  return {
    now: () => clock,
    setTimer: (fn, ms) => {
      const handle = nextHandle++;
      timers.push({ handle, at: clock + ms, fn });
      return handle;
    },
    clearTimer: (handle) => {
      timers = timers.filter((t) => t.handle !== handle);
    },
    notify: (title, body) => notified.push({ title, body }),
    emit: (state) => emitted.push(state),
    persist: (state) => {
      if (state === null) db.clearFocusState();
      else db.saveFocusState(JSON.stringify(state));
    }
  };
}


/** 把时钟往前推 ms，然后按到期顺序触发到点的定时器（模拟真实时间流逝）。 */
function advance(ms: number): void {
  const target = clock + ms;
  for (;;) {
    const due = timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0];
    if (!due) break;
    timers = timers.filter((t) => t !== due);
    clock = due.at;
    due.fn();
  }
  clock = target;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'jwkb-focus-'));
  db.openDatabase(ensureDirs(root));
  clock = Date.UTC(2026, 9, 18, 10, 0, 0);
  timers = [];
  emitted = [];
  notified = [];
  nextHandle = 1;
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

describe('番茄钟：开始 / 暂停 / 继续', () => {
  it('开始后状态是 running，剩余时间完全由 endAt 算出来', () => {
    const taskId = db.createTask({ title: '写周报' });
    const focus = createFocus(makeDeps());
    const started = focus.start({ plannedSeconds: 1500, taskId, taskTitle: '写周报' });
    expect(started.status).toBe('running');
    expect(started.plannedSeconds).toBe(1500);
    expect(started.endAt).toBe(clock + 1500_000);
    expect(started.taskTitle).toBe('写周报');

    // 没有任何「每秒减一」：直接把时钟推 10 分钟，剩余时间自动算对
    clock += 600_000;
    expect(focus.state().remainingMs).toBe(900_000);
    expect(focus.state().status).toBe('running');
  });

  it('暂停再继续：剩余时间冻住，继续后按剩余重排 endAt', () => {
    const focus = createFocus(makeDeps());
    focus.start({ plannedSeconds: 1500 });
    advance(600_000);

    const paused = focus.pause();
    expect(paused.status).toBe('paused');
    expect(paused.remainingMs).toBe(900_000);

    // 暂停期间时钟继续走，剩余时间不动
    clock += 300_000;
    expect(focus.state().remainingMs).toBe(900_000);

    const resumed = focus.resume();
    expect(resumed.status).toBe('running');
    expect(resumed.endAt).toBe(clock + 900_000);
  });

  it('时间到自动进休息 5 分钟，休息结束回到空闲并记两条 done', () => {
    const focus = createFocus(makeDeps());
    focus.start({ plannedSeconds: 1500 });
    advance(1500_000);

    const breaking = focus.state();
    expect(breaking.status).toBe('break');
    expect(breaking.plannedSeconds).toBe(BREAK_SECONDS);
    expect(focus.state().remainingMs).toBe(BREAK_SECONDS * 1000);

    advance(BREAK_SECONDS * 1000);
    expect(focus.state().status).toBe('idle');
    expect(notified.map((n) => n.title)).toEqual(['专注结束', '休息结束']);

    const summary = focus.summary();
    expect(summary.todayCount).toBe(1);
    expect(summary.todaySeconds).toBe(1500);
  });

  it('放弃：记录保留为 abandoned，但不计入今日/本周专注时长', () => {
    const focus = createFocus(makeDeps());
    const started = focus.start({ plannedSeconds: 1500 });
    const sessionId = started.sessionId;
    advance(600_000);
    const after = focus.abandon();
    expect(after.status).toBe('idle');

    const summary = focus.summary();
    expect(summary.todayCount).toBe(0);
    expect(summary.todaySeconds).toBe(0);

    const row = sessionId === null ? null : db.focusSessionById(sessionId);
    expect(row?.status).toBe('abandoned');
    expect(row?.actualSeconds).toBe(600);
  });

  it('跳过休息：休息记 done，回到空闲', () => {
    const focus = createFocus(makeDeps());
    const started = focus.start({ plannedSeconds: 60 });
    advance(60_000);
    const breaking = focus.state();
    expect(breaking.status).toBe('break');

    const after = focus.skipBreak();
    expect(after.status).toBe('idle');
    const focusRow = started.sessionId === null ? null : db.focusSessionById(started.sessionId);
    const breakRow = breaking.sessionId === null ? null : db.focusSessionById(breaking.sessionId);
    expect(focusRow?.status).toBe('done');
    expect(breakRow?.status).toBe('done');
  });
});

describe('番茄钟：非法操作', () => {
  it('已经有一轮在跑时不能再开始', () => {
    const focus = createFocus(makeDeps());
    focus.start({ plannedSeconds: 1500 });
    expect(() => focus.start({ plannedSeconds: 1500 })).toThrow('上一轮还没结束');
  });

  it('时长超出 1 分钟~4 小时会被拒绝', () => {
    const focus = createFocus(makeDeps());
    expect(() => focus.start({ plannedSeconds: 30 })).toThrow('时长不太对');
    expect(() => focus.start({ plannedSeconds: 5 * 3600 })).toThrow('时长不太对');
  });

  it('没在跑的时候暂停/继续/放弃都报错', () => {
    const focus = createFocus(makeDeps());
    expect(() => focus.pause()).toThrow('没有正在跑的专注');
    expect(() => focus.resume()).toThrow('暂停状态才能继续');
    expect(() => focus.abandon()).toThrow('没有进行中的专注');
  });

  it('默认时长是 25 分钟', () => {
    const focus = createFocus(makeDeps());
    expect(focus.start().plannedSeconds).toBe(DEFAULT_FOCUS_MINUTES * 60);
  });
});

describe('番茄钟：重启后接上 / 收尾', () => {
  it('关掉应用再打开：运行中的这一轮按真实剩余时间接着走', () => {
    const first = createFocus(makeDeps());
    first.start({ plannedSeconds: 1500 });
    advance(600_000);
    const saved = focusSnapshot();
    expect(saved?.status).toBe('running');

    // 模拟重启：新的引擎实例，时钟往前推 5 分钟
    timers = [];
    clock += 300_000;
    const second = createFocus(makeDeps());
    second.restore();
    const restored = second.state();
    expect(restored.status).toBe('running');
    expect(restored.remainingMs).toBe(600_000);

    // 再走完剩下的 10 分钟，正常进休息
    advance(600_000);
    expect(second.state().status).toBe('break');
  });

  it('关着应用的时候已经超时：补记 done 并回到空闲', () => {
    const first = createFocus(makeDeps());
    first.start({ plannedSeconds: 60 });
    timers = [];
    clock += 120_000;

    const second = createFocus(makeDeps());
    second.restore();
    expect(second.state().status).toBe('idle');
    expect(second.summary().todayCount).toBe(1);
  });

  it('异常退出留下的 running 记录会被收成 abandoned', () => {
    const danglingId = db.createFocusSession({
      kind: 'focus',
      taskId: null,
      plannedSeconds: 1500,
      startedAt: new Date(clock).toISOString()
    });
    const focus = createFocus(makeDeps());
    focus.restore();
    expect(db.focusSessionById(danglingId)?.status).toBe('abandoned');
  });
});

/**
 * 第八版任务二：番茄钟和系统任务栏联动（Windows 任务栏进度条 + 到点闪任务栏）。
 * 引擎只负责算「进度该是多少」，真正调 setProgressBar / flashFrame 的是 ipc/focus.ts，
 * 所以这里用假 deps 记录调用序列，验证状态机在每个转折点都通知对了。
 */
describe('番茄钟：任务栏进度条与到点强提醒', () => {
  let progressCalls: (number | null)[] = [];
  let flashCount = 0;

  function makeTaskbarDeps(): FocusDeps {
    return {
      ...makeDeps(),
      progress: (ratio) => progressCalls.push(ratio),
      flash: () => {
        flashCount += 1;
      }
    };
  }

  beforeEach(() => {
    progressCalls = [];
    flashCount = 0;
  });

  it('开始专注时进度从 0 起算，走了一半就是 0.5', () => {
    const focus = createFocus(makeTaskbarDeps());
    focus.start({ plannedSeconds: 600 });
    expect(progressCalls.at(-1)).toBe(0);

    advance(300_000);
    focus.pause();
    focus.resume();
    expect(progressCalls.at(-1)).toBeCloseTo(0.5, 2);
    for (const ratio of progressCalls) {
      if (ratio !== null) expect(ratio).toBeGreaterThanOrEqual(0);
    }
  });

  it('暂停 / 放弃 / 进入休息 / 回到空闲都会把进度条清掉（传 null）', () => {
    const focus = createFocus(makeTaskbarDeps());
    focus.start({ plannedSeconds: 120 });
    expect(progressCalls.at(-1)).toBe(0);

    focus.pause();
    expect(progressCalls.at(-1)).toBeNull();

    focus.resume();
    expect(progressCalls.at(-1)).not.toBeNull();

    focus.abandon();
    expect(progressCalls.at(-1)).toBeNull();

    const second = createFocus(makeTaskbarDeps());
    second.start({ plannedSeconds: 60 });
    advance(60_000);
    expect(second.state().status).toBe('break');
    expect(progressCalls.at(-1)).toBeNull();
  });

  it('专注到点会闪一次任务栏；休息到点或放弃不会闪', () => {
    const focus = createFocus(makeTaskbarDeps());
    focus.start({ plannedSeconds: 60 });
    advance(60_000);
    expect(focus.state().status).toBe('break');
    expect(flashCount).toBe(1);

    advance(BREAK_SECONDS * 1000);
    expect(focus.state().status).toBe('idle');
    expect(flashCount).toBe(1);

    focus.start({ plannedSeconds: 60 });
    focus.abandon();
    expect(flashCount).toBe(1);
  });

  it('没有传 progress / flash 依赖时引擎照样能跑（老调用方零破坏）', () => {
    const focus = createFocus(makeDeps());
    focus.start({ plannedSeconds: 60 });
    advance(60_000);
    expect(focus.state().status).toBe('break');
  });
});

function focusSnapshot(): FocusState | null {
  const raw = db.loadFocusState();
  return raw === null ? null : (JSON.parse(raw) as FocusState);
}
