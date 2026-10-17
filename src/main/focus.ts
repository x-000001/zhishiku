import * as db from './db';
import { BREAK_SECONDS, DEFAULT_FOCUS_MINUTES, formatSpan } from '../shared/focus';
import type { FocusSummary, FocusState, Id } from '../shared/types';

/**
 * 番茄钟的计时引擎 —— 全应用唯一的计时真相。
 *
 * 设计要点（对应需求里划的红线）：
 * - 只存「结束时刻 endAt」这个绝对时间戳，剩余时间是 `endAt - now` 算出来的；
 *   全程没有任何「每秒减一」的累加，所以切页、最小化、电脑睡眠都不会偏。
 * - 整个引擎只有**一个** setTimeout（到 endAt 那一下），暂停/放弃/结束都会先清掉它；
 *   卸载/关闭时也会清，不留悬空定时器。
 * - 副作用全部通过注入的依赖完成（通知、广播、持久化、时钟、定时器），
 *   所以单测可以拿假时钟把 25 分钟瞬间跑完，不用真等。
 */

export interface FocusDeps {
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  notify(title: string, body: string): void;
  /** 把最新快照发给渲染层 */
  emit(state: FocusState): void;
  /** 把快照写进 meta 表（idle 时传 null 表示清掉） */
  persist(state: FocusState | null): void;
  /** 任务栏进度（0~1 专注中、null 表示清掉）—— 平台不支持时由 Electron 层静默降级 */
  progress?(ratio: number | null): void;
  /** 到点强提醒：闪一下任务栏图标（用户点回应用后 Electron 层负责停） */
  flash?(): void;
}

export interface FocusStartInput {
  /** 计划时长（秒）；不传用默认 25 分钟 */
  plannedSeconds?: number;
  taskId?: Id | null;
  taskTitle?: string | null;
}

export interface FocusRuntime {
  state(): FocusState;
  /** 应用启动时调一次：把上次没走完的会话接上 */
  restore(): void;
  start(input?: FocusStartInput): FocusState;
  pause(): FocusState;
  resume(): FocusState;
  abandon(): FocusState;
  skipBreak(): FocusState;
  summary(): FocusSummary;
}

const MIN_PLANNED_SECONDS = 60;
const MAX_PLANNED_SECONDS = 4 * 60 * 60;

/**
 * 允许的最短专注时长，生产环境固定 60 秒。
 * e2e 要真跑完一整轮（含「时间到 → 进休息」）不可能真等 25 分钟，
 * 所以留一个仅测试用的环境变量把下限临时调到几秒；没设就还是 60。
 */
function minPlannedSeconds(): number {
  const override = Number(process.env.JWKB_FOCUS_MIN_SECONDS);
  return Number.isFinite(override) && override > 0 && override < MIN_PLANNED_SECONDS ? override : MIN_PLANNED_SECONDS;
}

function idleState(): FocusState {
  const seconds = DEFAULT_FOCUS_MINUTES * 60;
  return {
    status: 'idle',
    kind: 'focus',
    sessionId: null,
    plannedSeconds: seconds,
    endAt: null,
    remainingMs: seconds * 1000,
    taskId: null,
    taskTitle: null,
    startedAt: null
  };
}

function isoAt(ms: number): string {
  return new Date(ms).toISOString();
}

export function createFocus(deps: FocusDeps): FocusRuntime {
  let state: FocusState = idleState();
  let timer: unknown = null;

  const remainingAt = (now: number): number =>
    state.endAt === null ? state.remainingMs : Math.max(0, state.endAt - now);

  function clearTimer(): void {
    if (timer !== null) {
      deps.clearTimer(timer);
      timer = null;
    }
  }

  function arm(ms: number, fn: () => void): void {
    clearTimer();
    timer = deps.setTimer(fn, Math.max(0, ms));
  }

  /** 广播 + 落库。所有状态变化最后都要走这里，保证渲染层和 meta 表一致。 */
  function publish(): void {
    const now = deps.now();
    const snapshot: FocusState = { ...state, remainingMs: remainingAt(now) };
    deps.emit(snapshot);
    deps.persist(snapshot.status === 'idle' ? null : snapshot);
    // 任务栏进度条：只有「专注中」显示，暂停 / 休息 / 空闲都清掉（Electron 里 -1 = 隐藏）
    if (deps.progress) {
      try {
        const running = snapshot.status === 'running' && snapshot.kind === 'focus' && snapshot.plannedSeconds > 0;
        const ratio = running ? Math.min(1, Math.max(0, 1 - snapshot.remainingMs / (snapshot.plannedSeconds * 1000))) : null;
        deps.progress(ratio);
      } catch {
        /* 平台不支持进度条就静默跳过，不能影响计时本身 */
      }
    }
  }

  function resetToIdle(): void {
    clearTimer();
    state = idleState();
    publish();
  }

  function finishRow(status: 'done' | 'abandoned', actualSeconds: number, now: number): void {
    if (state.sessionId !== null) {
      db.finishFocusSession(state.sessionId, {
        status,
        actualSeconds,
        endedAt: isoAt(now)
      });
    }
  }

  /** 专注到时：记一条 done，然后自动进入 5 分钟休息倒计时。 */
  function completeFocus(): void {
    const now = deps.now();
    const finished = { ...state };
    finishRow('done', finished.plannedSeconds, now);
    deps.notify('专注结束', `这一轮 ${formatSpan(finished.plannedSeconds)} 完成了，休息 5 分钟吧`);
    // 到点强提醒：任务栏图标闪烁，用户点回窗口后由 Electron 层停掉
    try {
      deps.flash?.();
    } catch {
      /* 平台不支持闪烁就静默跳过 */
    }

    const breakSessionId = db.createFocusSession({
      kind: 'break',
      taskId: null,
      plannedSeconds: BREAK_SECONDS,
      startedAt: isoAt(now)
    });
    state = {
      status: 'break',
      kind: 'break',
      sessionId: breakSessionId,
      plannedSeconds: BREAK_SECONDS,
      endAt: now + BREAK_SECONDS * 1000,
      remainingMs: BREAK_SECONDS * 1000,
      taskId: finished.taskId,
      taskTitle: finished.taskTitle,
      startedAt: isoAt(now)
    };
    arm(BREAK_SECONDS * 1000, completeBreak);
    publish();
  }

  /** 休息到时：记一条 done，回到空闲，提醒可以继续了。 */
  function completeBreak(): void {
    const now = deps.now();
    finishRow('done', state.plannedSeconds, now);
    deps.notify('休息结束', '站起来走一走，回来再开一轮');
    resetToIdle();
  }

  return {
    state(): FocusState {
      return { ...state, remainingMs: remainingAt(deps.now()) };
    },

    restore(): void {
      // 上次异常退出残留的 running / paused 记录先收成 abandoned，避免悬空
      const raw = db.loadFocusState();
      let keepId: Id | null = null;
      let restored: FocusState | null = null;
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as FocusState;
          if (parsed && typeof parsed === 'object' && parsed.sessionId !== null) {
            restored = parsed;
            keepId = parsed.sessionId;
          }
        } catch {
          restored = null;
        }
      }
      const now = deps.now();
      db.closeDanglingFocusSessions(keepId, isoAt(now));

      if (!restored) {
        state = idleState();
        publish();
        return;
      }

      if (restored.status === 'paused') {
        state = { ...restored, endAt: null, remainingMs: Math.max(0, restored.remainingMs) };
        publish();
        return;
      }

      const endAt = restored.endAt ?? 0;
      if (endAt > now) {
        // 关着应用的时候这一轮还没走完：接着走
        state = { ...restored };
        if (state.kind === 'break') arm(endAt - now, completeBreak);
        else arm(endAt - now, completeFocus);
        publish();
        return;
      }

      // 关着应用的这段时间里已经到点了：补记一条 done，不弹通知（免得一开应用就吵）
      state = { ...restored };
      finishRow('done', restored.plannedSeconds, now);
      state = idleState();
      publish();
    },

    start(input: FocusStartInput = {}): FocusState {
      if (state.status !== 'idle') {
        throw new Error('上一轮还没结束，先暂停/放弃它再开新的');
      }
      const raw = Math.round(
        typeof input.plannedSeconds === 'number' ? input.plannedSeconds : DEFAULT_FOCUS_MINUTES * 60
      );
      if (!Number.isFinite(raw) || raw < minPlannedSeconds() || raw > MAX_PLANNED_SECONDS) {
        throw new Error('时长不太对：最少 1 分钟、最多 4 小时');
      }
      const now = deps.now();
      const startedAt = isoAt(now);
      const sessionId = db.createFocusSession({
        kind: 'focus',
        taskId: input.taskId ?? null,
        plannedSeconds: raw,
        startedAt
      });
      state = {
        status: 'running',
        kind: 'focus',
        sessionId,
        plannedSeconds: raw,
        endAt: now + raw * 1000,
        remainingMs: raw * 1000,
        taskId: input.taskId ?? null,
        taskTitle: input.taskTitle ?? null,
        startedAt
      };
      arm(raw * 1000, completeFocus);
      publish();
      return { ...state };
    },

    pause(): FocusState {
      if (state.status !== 'running') throw new Error('现在没有正在跑的专注');
      const now = deps.now();
      const remainingMs = remainingAt(now);
      clearTimer();
      if (state.sessionId !== null) db.setFocusSessionStatus(state.sessionId, 'paused');
      state = { ...state, status: 'paused', endAt: null, remainingMs };
      publish();
      return { ...state };
    },

    resume(): FocusState {
      if (state.status !== 'paused') throw new Error('现在是暂停状态才能继续');
      const now = deps.now();
      const remainingMs = state.remainingMs;
      if (state.sessionId !== null) db.setFocusSessionStatus(state.sessionId, 'running');
      state = { ...state, status: 'running', endAt: now + remainingMs, remainingMs };
      arm(remainingMs, completeFocus);
      publish();
      return { ...state };
    },

    abandon(): FocusState {
      if (state.status === 'idle') throw new Error('现在没有进行中的专注');
      const now = deps.now();
      const remainingMs = remainingAt(now);
      const elapsedSeconds = Math.max(0, Math.round((state.plannedSeconds * 1000 - remainingMs) / 1000));
      // 放弃的会话保留记录（status=abandoned），但统计只算 done，所以不计入专注时长
      finishRow('abandoned', elapsedSeconds, now);
      resetToIdle();
      return { ...state };
    },

    skipBreak(): FocusState {
      if (state.status !== 'break') throw new Error('现在不在休息里');
      const now = deps.now();
      const remainingMs = remainingAt(now);
      const elapsedSeconds = Math.max(0, Math.round((state.plannedSeconds * 1000 - remainingMs) / 1000));
      finishRow('done', elapsedSeconds, now);
      resetToIdle();
      return { ...state };
    },

    summary(): FocusSummary {
      return db.focusSummary(new Date(deps.now()));
    }
  };
}
