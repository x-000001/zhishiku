import { describe, expect, it } from 'vitest';
import { PRIORITY_LABEL, PRIORITY_ORDER, fmtDate, nextPriority, todayLocal } from '../../src/renderer/src/format';

describe('任务优先级四档（PRD 5.4）', () => {
  it('四档标签齐全，0 是「无」', () => {
    expect(Object.keys(PRIORITY_LABEL)).toHaveLength(4);
    expect(PRIORITY_LABEL[0]).toBe('无');
    expect(PRIORITY_LABEL[3]).toBe('高');
  });

  it('点一下按 无 → 低 → 中 → 高 → 无 循环', () => {
    expect(nextPriority(0)).toBe(1);
    expect(nextPriority(1)).toBe(2);
    expect(nextPriority(2)).toBe(3);
    expect(nextPriority(3)).toBe(0);
  });

  it('越界的值也当「无」处理，不会跑出 0–3', () => {
    expect(nextPriority(-1)).toBe(0);
    expect(nextPriority(99)).toBe(0);
  });

  it('展示顺序是高在前、无在最后', () => {
    expect(PRIORITY_ORDER).toEqual([3, 2, 1, 0]);
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
