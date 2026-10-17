import { useEffect, useState, type ReactNode } from 'react';
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

export default function FocusDock(): ReactNode {
  const [state, setState] = useState<FocusState | null>(null);
  const [summary, setSummary] = useState<FocusSummary | null>(null);
  const [open, setOpen] = useState(false);
  const [minutes, setMinutes] = useState(readSavedMinutes);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);

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
    <>
      <button
        type="button"
        className={'focus-fab' + (active ? ' active' : '')}
        aria-label="番茄钟"
        aria-expanded={open}
        title={active ? '番茄钟：点开看剩余时间' : '番茄钟：点开开始专注'}
        onClick={() => setOpen((v) => !v)}
      >
        {fabText}
      </button>

      {open ? (
        <div className="focus-panel" role="dialog" aria-label="番茄钟面板">
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
    </>
  );
}
