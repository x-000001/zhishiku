import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { api, onFocusState } from './api';
import { toast } from './ui';
import { toastError } from './errors';
import { DEFAULT_FOCUS_MINUTES, FOCUS_PRESET_MINUTES, formatClock, formatSpan } from '../../shared/focus';
import {
  clampFabPos,
  fabBasePoint,
  fabSizeOf,
  FAB_FALLBACK_SIZE,
  parseFabPos,
  snapFabEdge,
  type FabPos,
  type FabSize,
  type FabView,
} from './fabPos';
import type { FocusState, FocusSummary } from '../../shared/types';

/**
 * 右下角番茄钟。
 *
 * 渲染层不是计时真相：它只镜像主进程给的快照，每秒用 endAt - now 重算一次显示。
 * 所以合上这个面板、切到别的页面、甚至最小化窗口，时间都照走不误。
 */

const MINUTES_KEY = 'jw-focus-minutes';
const PRESETS: readonly number[] = FOCUS_PRESET_MINUTES;

function readSavedMinutes(): number {
  try {
    const raw = Number(localStorage.getItem(MINUTES_KEY));
    if (PRESETS.includes(raw)) return raw;
  } catch {
    /* localStorage 不可用时用默认值 */
  }
  return DEFAULT_FOCUS_MINUTES;
}

function saveMinutes(minutes: number): void {
  try {
    localStorage.setItem(MINUTES_KEY, String(minutes));
  } catch {
    /* 存不下就算了，不影响计时 */
  }
}

/* ---------------- 悬浮按钮可拖动 ---------------- */

const POS_KEY = 'jw-focus-fab-pos';
/** 位移超过这个距离才算拖拽，否则当成点击（触控板抖动也不至于误判） */
const DRAG_THRESHOLD = 4;

function readStoredPosRaw(): string | null {
  try {
    return localStorage.getItem(POS_KEY);
  } catch {
    return null;
  }
}

function savePos(pos: FabPos): void {
  try {
    localStorage.setItem(POS_KEY, JSON.stringify(pos));
  } catch {
    /* 存不下就算了，下次回到默认位置 */
  }
}

function currentView(): FabView {
  return { width: window.innerWidth, height: window.innerHeight };
}

export default function FocusDock(): ReactNode {
  const [state, setState] = useState<FocusState | null>(null);
  const [summary, setSummary] = useState<FocusSummary | null>(null);
  const [open, setOpen] = useState(false);
  const [minutes, setMinutes] = useState(readSavedMinutes);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);

  /* 悬浮按钮的位置：唯一真相是 pos（会被拖拽改），拖动过程中直接写 DOM 的 transform，不逐帧 setState。 */
  const dockRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{
    id: number;
    startX: number;
    startY: number;
    baseTx: number;
    baseTy: number;
    moved: boolean;
    last: FabPos;
    size: FabSize;
    view: FabView;
  } | null>(null);
  const suppressClick = useRef(false);
  const [pos, setPos] = useState<FabPos>(() => parseFabPos(readStoredPosRaw(), FAB_FALLBACK_SIZE, currentView()));
  const [dragging, setDragging] = useState(false);
  // 窗口尺寸单独存一份：resize 时面板换边的判断要用新尺寸，不能读渲染时缓存的旧值
  const [view, setView] = useState<FabView>(currentView);

  // 窗口尺寸变了、按钮文字变长变短，都要把按钮重新夹回可视区（重启后读到的旧位置同理）
  const refitPos = (): void => {
    const size = fabSizeOf(dockRef.current);
    const nextView = currentView();
    setView(nextView);
    setPos((prev) => {
      const next = clampFabPos(prev.tx, prev.ty, size, nextView);
      // 顺手把规范化后的坐标存回去：手改坏的 localStorage（1e999 之类）会被覆盖成正常值
      savePos(next);
      return next.tx === prev.tx && next.ty === prev.ty ? prev : next;
    });
  };

  useEffect(() => {
    refitPos();
    window.addEventListener('resize', refitPos);
    return () => window.removeEventListener('resize', refitPos);
    // 只挂一次；refitPos 里读的都是 ref / window，不依赖渲染期状态
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onFabPointerDown = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    if (dragRef.current) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const button = event.currentTarget;
    dragRef.current = {
      id: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      baseTx: pos.tx,
      baseTy: pos.ty,
      moved: false,
      last: pos,
      size: fabSizeOf(dockRef.current),
      view: currentView(),
    };
    setDragging(true);

    // 抓住指针：鼠标甩出窗口再松手也能收到 pointerup，按钮不会“粘”在鼠标上
    try {
      button.setPointerCapture(event.pointerId);
    } catch {
      /* 合成事件 / 老环境不支持就算了，window 上的监听仍然兜底 */
    }

    const onMove = (moveEvent: PointerEvent): void => {
      const drag = dragRef.current;
      if (!drag || moveEvent.pointerId !== drag.id) return;
      const dx = moveEvent.clientX - drag.startX;
      const dy = moveEvent.clientY - drag.startY;
      if (!drag.moved && Math.hypot(dx, dy) > DRAG_THRESHOLD) drag.moved = true;
      if (!drag.moved) return;
      moveEvent.preventDefault();
      const next = clampFabPos(drag.baseTx + dx, drag.baseTy + dy, drag.size, drag.view);
      drag.last = next;
      if (dockRef.current) dockRef.current.style.transform = `translate3d(${next.tx}px, ${next.ty}px, 0)`;
    };

    const detach = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onFinish);
      window.removeEventListener('pointercancel', onFinish);
      window.removeEventListener('blur', onAbort);
      document.removeEventListener('visibilitychange', onVisibility);
      try {
        if (button.hasPointerCapture?.(event.pointerId)) button.releasePointerCapture(event.pointerId);
      } catch {
        /* 已经自动释放 */
      }
    };

    /** 收尾：指针抬起 / 被取消 / 窗口失焦 都走这里，保证监听器和捕获一定被摘干净 */
    const finish = (endEvent: PointerEvent | null): void => {
      const drag = dragRef.current;
      if (!drag) return;
      detach();
      dragRef.current = null;
      setDragging(false);
      if (endEvent && drag.id !== endEvent.pointerId) return;
      if (!drag.moved) return;
      // 拖完那一下会跟着来一个 click，要吃掉，否则松手就弹面板
      suppressClick.current = true;
      window.setTimeout(() => {
        suppressClick.current = false;
      }, 400);
      // 松手后先算吸附：近边就吸过去，坐标再持久化（动画由 CSS 的 --spring-ease 负责）
      const snapped = snapFabEdge(drag.last, drag.size, drag.view);
      setPos(snapped);
      savePos(snapped);
    };
    const onFinish = (endEvent: PointerEvent): void => finish(endEvent);
    // 切窗口 / 最小化 / Alt+Tab 时 pointerup 可能永远不来：失焦和页面隐藏都兜底收尾
    const onAbort = (): void => finish(null);
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') finish(null);
    };

    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onFinish);
    window.addEventListener('pointercancel', onFinish);
    window.addEventListener('blur', onAbort);
    document.addEventListener('visibilitychange', onVisibility);
  };

  // 拖动中即使组件因计时刷新而重渲染，也要接着显示拖到一半的位置，不能弹回旧坐标
  const shownPos = dragging && dragRef.current ? dragRef.current.last : pos;
  const dockStyle: CSSProperties = { transform: `translate3d(${shownPos.tx}px, ${shownPos.ty}px, 0)` };
  // 面板默认贴在按钮右上方；靠近窗口左边/顶部时换边，别被切掉。尺寸用 view 状态算，resize 后立刻正确
  const size = fabSizeOf(dockRef.current);
  const base = fabBasePoint(size, view);
  const dockLeft = base.left + pos.tx;
  const dockTop = base.top + pos.ty;
  const panelSide: CSSProperties = {
    ...(dockLeft < 24 ? { left: 0, right: 'auto' } : { right: 0, left: 'auto' }),
    ...(dockTop < 320 ? { top: 'calc(100% + 10px)', bottom: 'auto' } : { bottom: 'calc(100% + 10px)', top: 'auto' }),
  };

  // 挂载：先问主进程要一次快照，然后订阅它的推送
  useEffect(() => {
    let alive = true;
    api
      .focusState()
      .then((next) => {
        if (alive) setState(next);
      })
      .catch(() => {
        /* 主进程还没准备好，订阅会补上 */
      });
    api
      .focusSummary()
      .then((next) => {
        if (alive) setSummary(next);
      })
      .catch(() => undefined);
    const off = onFocusState((next) => setState(next));
    return () => {
      alive = false;
      off();
    };
  }, []);

  const status = state?.status ?? 'idle';

  // 只有计时中才需要每秒重绘；暂停/空闲时一个定时器都不留
  useEffect(() => {
    if (status !== 'running' && status !== 'break') return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [status]);

  // 一轮结束（回到空闲）时刷新今日/本周统计
  useEffect(() => {
    if (status !== 'idle') return;
    api
      .focusSummary()
      .then(setSummary)
      .catch(() => undefined);
  }, [status]);

  const remainingMs =
    state === null
      ? minutes * 60 * 1000
      : status === 'running' || status === 'break'
        ? Math.max(0, (state.endAt ?? now) - now)
        : state.remainingMs;

  async function run(action: () => Promise<FocusState>, fail: string): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      setState(await action());
    } catch (err) {
      toastError(fail, err);
    } finally {
      setBusy(false);
    }
  }

  function start(): void {
    void run(() => api.startFocus(minutes * 60), '开始专注失败：');
  }

  function pause(): void {
    void run(() => api.pauseFocus(), '暂停失败：');
  }

  function resume(): void {
    void run(() => api.resumeFocus(), '继续失败：');
  }

  function abandon(): void {
    void run(async () => {
      const next = await api.abandonFocus();
      toast('这一轮先不算了，休息一下再来');
      return next;
    }, '放弃失败：');
  }

  function skipBreak(): void {
    void run(() => api.skipBreak(), '跳过休息失败：');
  }

  const active = status !== 'idle';
  const fabText =
    status === 'break'
      ? `☕ ${formatClock(remainingMs)}`
      : status === 'running' || status === 'paused'
        ? `⏱ ${formatClock(remainingMs)}`
        : '⏱ 番茄钟';

  return (
    <div ref={dockRef} className={'focus-dock' + (dragging ? ' dragging' : '')} style={dockStyle}>
      <button
        type="button"
        className={'focus-fab' + (active ? ' active' : '')}
        aria-label="番茄钟"
        aria-expanded={open}
        title={active ? '番茄钟：点开看剩余时间；按住可拖动' : '番茄钟：点开开始专注；按住可拖动'}
        onPointerDown={onFabPointerDown}
        onClick={() => {
          // 拖拽松手后浏览器还会补一个 click，这一下不能弹面板
          if (suppressClick.current) {
            suppressClick.current = false;
            return;
          }
          setOpen((v) => !v);
        }}
      >
        {fabText}
      </button>

      {open ? (
        <div className="focus-panel" role="dialog" aria-label="番茄钟面板" style={panelSide}>
          <div className="focus-panel-head">
            <b>番茄钟</b>
            <span className="spacer" />
            <button type="button" className="icon-btn" aria-label="收起番茄钟" title="收起" onClick={() => setOpen(false)}>
              ✕
            </button>
          </div>

          {status === 'idle' ? (
            <>
              <div className="focus-presets" role="group" aria-label="专注时长">
                {PRESETS.map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    className={minutes === preset ? 'btn sm on' : 'btn sm'}
                    aria-pressed={minutes === preset}
                    onClick={() => {
                      setMinutes(preset);
                      saveMinutes(preset);
                    }}
                  >
                    {preset} 分钟
                  </button>
                ))}
              </div>
              <button type="button" className="btn primary focus-start" disabled={busy} onClick={start}>
                开始专注
              </button>
              <p className="muted focus-stat">
                今日 {summary ? formatSpan(summary.todaySeconds) : '0 秒'} · {summary?.todayCount ?? 0} 次
                <br />
                本周 {summary ? formatSpan(summary.weekSeconds) : '0 秒'} · {summary?.weekCount ?? 0} 次
              </p>
            </>
          ) : null}

          {status === 'running' || status === 'paused' ? (
            <>
              <div className="focus-clock" aria-live="off">
                {formatClock(remainingMs)}
              </div>
              <p className="muted focus-meta">
                {status === 'paused' ? '已暂停，时间冻住了' : '专注中，切页也不会停'}
                {state?.taskTitle ? ` · ${state.taskTitle}` : ''}
              </p>
              <div className="focus-actions">
                {status === 'running' ? (
                  <button type="button" className="btn sm" disabled={busy} onClick={pause}>
                    暂停
                  </button>
                ) : (
                  <button type="button" className="btn sm" disabled={busy} onClick={resume}>
                    继续
                  </button>
                )}
                <button type="button" className="btn sm ghost" disabled={busy} onClick={abandon}>
                  放弃这一轮
                </button>
              </div>
            </>
          ) : null}

          {status === 'break' ? (
            <>
              <div className="focus-clock">☕ {formatClock(remainingMs)}</div>
              <p className="muted focus-meta">休息中，起来走两步；回来点「开始专注」就是下一轮。</p>
              <div className="focus-actions">
                <button type="button" className="btn sm" disabled={busy} onClick={skipBreak}>
                  跳过休息
                </button>
              </div>
            </>
          ) : null}

          <p className="muted focus-hint">时间由主进程按结束时刻算，关面板、切页、最小化都不会走偏。</p>
        </div>
      ) : null}
    </div>
  );
}
