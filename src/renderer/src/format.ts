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

export const PRIORITY_LABEL: Record<number, string> = { 1: '低', 2: '中', 3: '高' };
export const PRIORITY_ORDER: number[] = [3, 2, 1];
export const REPEAT_LABEL: Record<string, string> = {
  none: '不重复',
  daily: '每天',
  weekdays: '工作日',
  weekly: '每周',
  monthly: '每月'
};
