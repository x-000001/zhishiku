/**
 * 番茄钟相关的纯展示计算（主进程和渲染层共用）。
 * 这里不碰计时器本身 —— 计时唯一真相在主进程的 focus.ts / focus 数据库。
 */

/** 面板上可选的时长（分钟）。 */
export const FOCUS_PRESET_MINUTES = [15, 25, 45, 60] as const;

/** 默认 25 分钟。 */
export const DEFAULT_FOCUS_MINUTES = 25;

/** 专注结束后自动开始的休息倒计时（秒）。 */
export const BREAK_SECONDS = 5 * 60;

/** 毫秒 → mm:ss（向上取整，所以 24:00.2 显示成 24:01 之前不会闪成 23:59）。 */
export function formatClock(ms: number): string {
  const safe = Number.isFinite(ms) ? ms : 0;
  const total = Math.max(0, Math.ceil(safe / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/** 秒 → 「N 分钟 / N 小时 M 分」，统计区用。 */
export function formatSpan(seconds: number): string {
  const safe = Number.isFinite(seconds) ? seconds : 0;
  const total = Math.max(0, Math.round(safe));
  if (total < 60) return `${total} 秒`;
  const minutes = Math.round(total / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分`;
}
