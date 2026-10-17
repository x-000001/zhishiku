import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { api, onFocusState } from './api';
import { toast } from './ui';
import { toastError } from './errors';
import { DEFAULT_FOCUS_MINUTES, FOCUS_PRESET_MINUTES, formatClock, formatSpan } from '../../shared/focus';
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
/** 贴边时至少留这么多像素在窗口里 */
const EDGE = 8;
/** 0.8.0：松手时离左/右边缘小于这个距离，就自动吸附过去 */
const SNAP_DISTANCE = 50;
/** 吸附到边上时预留的边距（比 EDGE 大一点，看着不贴死） */
const SNAP_MARGIN = 16;

type FabPos = { tx: number; ty: number };
const DEFAULT_POS: FabPos = { tx: 0, ty: 0 };

function readSavedPos(): FabPos {
  try {
    const raw = localStorage.getItem(POS_KEY);
    if (!raw) return DEFAULT_POS;
    const parsed = JSON.parse(raw) as Partial<FabPos> | null;
    if (typeof parsed?.tx === 'number' && typeof parsed?.ty === 'number') {
      return { tx: parsed.tx, ty: parsed.ty };
    }
  } catch {
    /* 坏数据 / localStorage 不可用：回到默认右下角 */
  }
  return DEFAULT_POS;
}

function savePos(pos: FabPos): void {
  try {
    localStorage.setItem(POS_KEY, JSON.stringify(pos));
  } catch {
    /* 存不下就算了，下次回到默认位置 */
  }
}

/**
 * 把位移夹在窗口内。
 * 按钮在 CSS 里是 `right:18px; bottom:18px`，没有定位时它的左上角在
 * `(winW - 18 - w, winH - 18 - h)`；tx / ty 是这个点相对默认位置的偏移。
 */
function clampPos(tx: number, ty: number, dock: HTMLElement | null): FabPos {
  const w = dock?.offsetWidth || 120;
  const h = dock?.offsetHeight || 38;
  const baseLeft = window.innerWidth - 18 - w;
  const baseTop = window.innerHeight - 18 - h;
  const minX = EDGE - baseLeft;
  const maxX = window.innerWidth - EDGE - w - baseLeft;
  const minY = EDGE - baseTop;
  const maxY = window.innerHeight - EDGE - h - baseTop;
  const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), Math.max(lo, hi));
  return { tx: clamp(tx, minX, maxX), ty: clamp(ty, minY, maxY) };
}

/**
 * 0.8.0：边缘吸附。
 * 松手时算一下悬浮球离窗口左/右边缘还有多远，小于 SNAP_DISTANCE 就把横向位置
 * 吸到 SNAP_MARGIN 处；纵向保持用户拖到的高度。最后再过一次 clampPos，保证不会飞出窗口。
 */
function snapToEdge(pos: FabPos, dock: HTMLElement | null): FabPos {
  const w = dock?.offsetWidth || 120;
  const baseLeft = window.innerWidth - 18 - w;
  const left = baseLeft + pos.tx;
  const right = window.innerWidth - (left + w);
  let tx = pos.tx;
  if (left < SNAP_DISTANCE) {
    tx = SNAP_MARGIN - baseLeft;
  } else if (right < SNAP_DISTANCE) {
    tx = window.innerWidth - SNAP_MARGIN - w - baseLeft;
  }
  return clampPos(tx, pos.ty, dock);
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
  } | null>(null);
  const suppressClick = useRef(false);
  const [pos, setPos] = useState<FabPos>(readSavedPos);
  const [dragging, setDragging] = useState(false);

  // 窗口尺寸变了要把按钮重新夹回可视区（重启后读到的旧位置同理）
  useEffect(() => {
    const refit = (): void => {
      setPos((prev) => {
        const next = clampPos(prev.tx, prev.ty, dockRef.current);
        if (next.tx !== prev.tx || next.ty !== prev.ty) savePos(next);
        return next;
      });
    };
    refit();
    window.addEventListener('resize', refit);
    return () => window.removeEventListener('resize', refit);
  }, []);

  const onFabPointerDown = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    dragRef.current = {
      id: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      baseTx: pos.tx,
      baseTy: pos.ty,
      moved: false,
      last: pos,
    };
    setDragging(true);

    // 监听器挂在 window 上，抬手立刻摘掉：鼠标不按着也不会乱飞，也不会累积泄漏
    const dock = dockRef.current;
    const onMove = (moveEvent: PointerEvent): void => {
      const drag = dragRef.current;
      if (!drag || moveEvent.pointerId !== drag.id) return;
      const dx = moveEvent.clientX - drag.startX;
      const dy = moveEvent.clientY - drag.startY;
      if (!drag.moved && Math.hypot(dx, dy) > DRAG_THRESHOLD) drag.moved = true;
      if (!drag.moved) return;
      moveEvent.preventDefault();
      const next = clampPos(drag.baseTx + dx, drag.baseTy + dy, dock);
      drag.last = next;
      if (dock) dock.style.transform = `translate3d(${next.tx}px, ${next.ty}px, 0)`;
    };
    const onEnd = (endEvent: PointerEvent): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onEnd);
      window.removeEventListener('pointercancel', onEnd);
      const drag = dragRef.current;
      dragRef.current = null;
      setDragging(false);
      if (!drag || drag.id !== endEvent.pointerId) return;
      if (!drag.moved) return;
      // 拖完那一下会跟着来一个 click，要吃掉，否则松手就弹面板
      suppressClick.current = true;
      window.setTimeout(() => {
        suppressClick.current = false;
      }, 400);
      // 松手后先算吸附：近边就吸过去，坐标再持久化（动画由 CSS 的 --spring-ease 负责）
      const snapped = snapToEdge(drag.last, dock);
      setPos(snapped);
      savePos(snapped);
    };
    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onEnd);
    window.addEventListener('pointercancel', onEnd);
  };

  const dockStyle: CSSProperties = { transform: `translate3d(${pos.tx}px, ${pos.ty}px, 0)` };
  // 面板默认贴在按钮右上方；靠近窗口左边/顶部时换边，别被切掉
  const dockLeft = window.innerWidth - 18 - (dockRef.current?.offsetWidth || 120) + pos.tx;
  const dockTop = window.innerHeight - 18 - (dockRef.current?.offsetHeight || 38) + pos.ty;
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
