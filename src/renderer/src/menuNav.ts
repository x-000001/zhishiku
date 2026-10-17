/* ------------------------------------------------------------------ */
/* 右键菜单的键盘导航（纯计算，不 import React，方便单测）               */
/* ------------------------------------------------------------------ */

interface NavItem {
  disabled?: boolean;
}

/**
 * 上下键在「可用项」之间循环，返回下一项的下标。
 * - 当前没选中（active = -1）时：向下选第一个可用项，向上选最后一个可用项
 * - 全都禁用时返回 -1（调用方据此什么都不做）
 */
export function nextActiveIndex(items: NavItem[], active: number, step: 1 | -1): number {
  const usable = items.map((it, i) => ({ it, i })).filter((x) => !x.it.disabled);
  if (usable.length === 0) return -1;
  const at = usable.findIndex((x) => x.i === active);
  const next = at === -1 ? (step === 1 ? 0 : usable.length - 1) : (at + step + usable.length) % usable.length;
  return usable[next].i;
}
