import { describe, expect, it } from 'vitest';
import { PRIORITY_LABEL, PRIORITY_ORDER, fmtDate, nextPriority, todayLocal } from '../../src/renderer/src/format';

describe('任务优先级三档（优化项 5）', () => {
  it('三档标签齐全', () => {
    expect(Object.keys(PRIORITY_LABEL)).toHaveLength(3);
    expect(PRIORITY_LABEL.urgent).toBe('紧急');
    expect(PRIORITY_LABEL.important).toBe('重要');
    expect(PRIORITY_LABEL.normal).toBe('一般');
  });

  it('点一下按 紧急 → 重要 → 一般 → 紧急 循环', () => {
    expect(nextPriority('urgent')).toBe('important');
    expect(nextPriority('important')).toBe('normal');
    expect(nextPriority('normal')).toBe('urgent');
  });

  it('认不出来的值（老库里的数字、空值）当「一般」处理', () => {
    expect(nextPriority('3')).toBe('urgent');
    expect(nextPriority(2 as unknown as string)).toBe('urgent');
    expect(nextPriority(null)).toBe('urgent');
    expect(nextPriority(undefined)).toBe('urgent');
  });

  it('展示顺序是紧急在前、一般在最后', () => {
    expect(PRIORITY_ORDER).toEqual(['urgent', 'important', 'normal']);
  });
});

describe('日期小工具', () => {
  it('今天显示成「今天」', () => {
    expect(fmtDate(todayLocal())).toBe('今天');
  });

  it('今天 / 明天 / 昨天 说人话，其余显示完整日期', () => {
    const pad = (n: number) => String(n).padStart(2, '0');
    const plus = (days: number) => {
      const x = new Date();
      x.setDate(x.getDate() + days);
      return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`;
    };
    expect(fmtDate(plus(1))).toBe('明天');
    expect(fmtDate(plus(-1))).toBe('昨天');
    expect(fmtDate('2001-03-05')).toBe('2001-03-05');
  });

  it('空值不会出 NaN', () => {
    expect(fmtDate(null)).toBe('无截止日');
    expect(todayLocal()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
