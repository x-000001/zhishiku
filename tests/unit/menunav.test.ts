import { describe, expect, it } from 'vitest';
import { nextActiveIndex } from '../../src/renderer/src/menuNav';

const items = [{}, { disabled: true }, {}, {}];

describe('右键菜单键盘导航（顺序 / 跳过禁用项 / 循环）', () => {
  it('没选中时：向下选第一个可用项，向上选最后一个可用项', () => {
    expect(nextActiveIndex(items, -1, 1)).toBe(0);
    expect(nextActiveIndex(items, -1, -1)).toBe(3);
  });

  it('往下走会跳过禁用的那一项', () => {
    expect(nextActiveIndex(items, 0, 1)).toBe(2);
    expect(nextActiveIndex(items, 2, 1)).toBe(3);
  });

  it('到底了会绕回开头（往上同理）', () => {
    expect(nextActiveIndex(items, 3, 1)).toBe(0);
    expect(nextActiveIndex(items, 0, -1)).toBe(3);
  });

  it('当前停在禁用项上时，当作没选中处理', () => {
    expect(nextActiveIndex(items, 1, 1)).toBe(0);
    expect(nextActiveIndex(items, 1, -1)).toBe(3);
  });

  it('全都禁用时返回 -1', () => {
    expect(nextActiveIndex([{ disabled: true }, { disabled: true }], 0, 1)).toBe(-1);
    expect(nextActiveIndex([], -1, 1)).toBe(-1);
  });
});
