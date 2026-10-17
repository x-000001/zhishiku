import { describe, expect, it } from 'vitest';
import { BREAK_SECONDS, DEFAULT_FOCUS_MINUTES, FOCUS_PRESET_MINUTES, formatClock, formatSpan } from '../../src/shared/focus';

/** 番茄钟的纯展示计算（第六版 / 阶段2）。 */

describe('formatClock', () => {
  it('毫秒转 mm:ss，秒向上取整（不会提前一秒闪数）', () => {
    expect(formatClock(1500_000)).toBe('25:00');
    expect(formatClock(1500_000 - 1)).toBe('25:00');
    expect(formatClock(1500_000 - 1000)).toBe('24:59');
    expect(formatClock(59_000)).toBe('00:59');
    expect(formatClock(0)).toBe('00:00');
  });

  it('负数/异常值一律当 0 显示，不会出现 -01:00', () => {
    expect(formatClock(-5000)).toBe('00:00');
    expect(formatClock(Number.NaN)).toBe('00:00');
  });
});

describe('formatSpan', () => {
  it('秒 / 分钟 / 小时三种档位', () => {
    expect(formatSpan(0)).toBe('0 秒');
    expect(formatSpan(45)).toBe('45 秒');
    expect(formatSpan(60)).toBe('1 分钟');
    expect(formatSpan(1499)).toBe('25 分钟');
    expect(formatSpan(3600)).toBe('1 小时');
    expect(formatSpan(5400)).toBe('1 小时 30 分');
  });

  it('负数和异常值当 0', () => {
    expect(formatSpan(-10)).toBe('0 秒');
    expect(formatSpan(Number.NaN)).toBe('0 秒');
  });
});

describe('常量', () => {
  it('可选时长是 15/25/45/60，默认 25，休息 5 分钟', () => {
    expect([...FOCUS_PRESET_MINUTES]).toEqual([15, 25, 45, 60]);
    expect(FOCUS_PRESET_MINUTES).toContain(DEFAULT_FOCUS_MINUTES);
    expect(BREAK_SECONDS).toBe(300);
  });
});
