import type { TaskPriority } from '../../shared/types';

export function todayLocal(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function fmtDate(value: string | null | undefined): string {
  if (!value) return '无截止日';
  const day = value.slice(0, 10);
  const today = todayLocal();
  if (day === today) return '今天';
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (day === todayLocal(tomorrow)) return '明天';
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  if (day === todayLocal(yesterday)) return '昨天';
  return day;
}

export function fmtDateTime(value: string | null | undefined): string {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 面向人话的“刚刚 / 3 分钟前 / 昨天 15:20”。 */
export function relative(value: string | null | undefined): string {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  const diff = Date.now() - d.getTime();
  if (diff < 45_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000 && todayLocal(d) === todayLocal()) {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `今天 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  return fmtDateTime(value);
}

/** 任务优先级三档（优化项 5）：紧急 / 重要 / 一般。 */
export const PRIORITY_LABEL: Record<string, string> = {
  urgent: '紧急',
  important: '重要',
  normal: '一般'
};
/** 由高到低，排序与筛选按钮都按这个顺序走。 */
export const PRIORITY_ORDER: TaskPriority[] = ['urgent', 'important', 'normal'];

/** 点一下换下一档，循环顺序：紧急 → 重要 → 一般 → 紧急。 */
export function nextPriority(current: TaskPriority | string | null | undefined): TaskPriority {
  const list = PRIORITY_ORDER;
  const i = list.indexOf(current as TaskPriority);
  return list[(i + 1) % list.length] as TaskPriority;
}

export const REPEAT_LABEL: Record<string, string> = {
  none: '不重复',
  daily: '每天',
  weekdays: '工作日',
  weekly: '每周',
  monthly: '每月'
};
