import { describe, expect, it } from 'vitest';
import {
  clampFabPos,
  fabBasePoint,
  fabRect,
  fabSizeOf,
  FAB_DEFAULT_POS,
  FAB_EDGE,
  FAB_FALLBACK_SIZE,
  FAB_MAX_ABS,
  FAB_SNAP_DISTANCE,
  FAB_SNAP_MARGIN,
  FAB_TOP_SAFE,
  isFabPosLike,
  parseFabPos,
  snapFabEdge,
  type FabSize,
  type FabView,
} from '../../src/renderer/src/fabPos';

/** 番茄钟悬浮按钮的坐标计算（0.8.1 修复「拖到顶部变死区」时抽出来的纯函数）。 */

const SIZE: FabSize = { width: 120, height: 38 };
const VIEW: FabView = { width: 1200, height: 800 };

describe('fabSizeOf', () => {
  it('量到尺寸就用真实尺寸，量不到退回兜底值', () => {
    expect(fabSizeOf({ offsetWidth: 140, offsetHeight: 42 })).toEqual({ width: 140, height: 42 });
    expect(fabSizeOf({ offsetWidth: 0, offsetHeight: 0 })).toEqual(FAB_FALLBACK_SIZE);
    expect(fabSizeOf(null)).toEqual(FAB_FALLBACK_SIZE);
  });
});

describe('clampFabPos', () => {
  it('默认位置原样不动（没拖动就不该挪）', () => {
    expect(clampFabPos(FAB_DEFAULT_POS.tx, FAB_DEFAULT_POS.ty, SIZE, VIEW)).toEqual({ tx: 0, ty: 0 });
  });

  it('四边都留 FAB_EDGE，纵向顶部留 FAB_TOP_SAFE（避开标题栏拖拽区）', () => {
    const rect = fabRect(clampFabPos(-9999, -9999, SIZE, VIEW), SIZE, VIEW);
    expect(rect.left).toBe(FAB_EDGE);
    // 顶部安全区是这次修复的核心：不允许再拖进 60px 以内的窗口拖拽区
    expect(rect.top).toBe(FAB_TOP_SAFE);

    const br = fabRect(clampFabPos(9999, 9999, SIZE, VIEW), SIZE, VIEW);
    expect(br.right).toBe(VIEW.width - FAB_EDGE);
    expect(br.bottom).toBe(VIEW.height - FAB_EDGE);
  });

  it('窗口比按钮还小时也不算出 NaN，至少保证左上角贴着边', () => {
    const tiny: FabView = { width: 80, height: 40 };
    const pos = clampFabPos(9999, 9999, SIZE, tiny);
    expect(Number.isFinite(pos.tx)).toBe(true);
    expect(Number.isFinite(pos.ty)).toBe(true);
  });

  it('NaN / Infinity 一律当 0 处理，不会把 transform 写成 NaN', () => {
    const pos = clampFabPos(Number.NaN, Number.POSITIVE_INFINITY, SIZE, VIEW);
    expect(Number.isFinite(pos.tx)).toBe(true);
    expect(Number.isFinite(pos.ty)).toBe(true);
  });
});

describe('snapFabEdge', () => {
  it('靠近左 / 右边缘（< 50px）自动吸到 16px 处', () => {
    const nearLeft = clampFabPos(-9999, -40, SIZE, VIEW);
    expect(fabRect(nearLeft, SIZE, VIEW).left).toBe(FAB_EDGE);
    const snappedLeft = snapFabEdge(nearLeft, SIZE, VIEW);
    expect(fabRect(snappedLeft, SIZE, VIEW).left).toBe(FAB_SNAP_MARGIN);

    const nearRight = clampFabPos(9999, -40, SIZE, VIEW);
    expect(fabRect(nearRight, SIZE, VIEW).right).toBe(VIEW.width - FAB_EDGE);
    const snappedRight = snapFabEdge(nearRight, SIZE, VIEW);
    expect(fabRect(snappedRight, SIZE, VIEW).right).toBe(VIEW.width - FAB_SNAP_MARGIN);
  });

  it('在窗口中间就不吸，纵向不动', () => {
    const mid = { tx: -400, ty: -200 };
    expect(snapFabEdge(mid, SIZE, VIEW)).toEqual(mid);
    // 距离恰好在阈值外也不吸
    const base = fabBasePoint(SIZE, VIEW);
    const justOutside = { tx: FAB_SNAP_DISTANCE - base.left + FAB_EDGE, ty: 0 };
    expect(fabRect(snapFabEdge(justOutside, SIZE, VIEW), SIZE, VIEW).left).toBeGreaterThanOrEqual(FAB_SNAP_MARGIN);
  });
});

describe('isFabPosLike / parseFabPos', () => {
  it('结构对、数值可信才算有效', () => {
    expect(isFabPosLike({ tx: -10, ty: 20 })).toBe(true);
    expect(isFabPosLike({ tx: 1, ty: 2.5 })).toBe(true);
    expect(isFabPosLike(null)).toBe(false);
    expect(isFabPosLike('x')).toBe(false);
    expect(isFabPosLike({ tx: '1', ty: 2 })).toBe(false);
    expect(isFabPosLike({ tx: Number.NaN, ty: 2 })).toBe(false);
    expect(isFabPosLike({ tx: 1e999, ty: 2 })).toBe(false);
    expect(isFabPosLike({ tx: FAB_MAX_ABS + 1, ty: 0 })).toBe(false);
  });

  it('坏 JSON / 空值 / 脏数据都回到默认右下角', () => {
    const fallback = clampFabPos(0, 0, SIZE, VIEW);
    expect(parseFabPos(null, SIZE, VIEW)).toEqual(fallback);
    expect(parseFabPos('', SIZE, VIEW)).toEqual(fallback);
    expect(parseFabPos('{坏掉的', SIZE, VIEW)).toEqual(fallback);
    expect(parseFabPos('{"tx":1e999,"ty":-1e999}', SIZE, VIEW)).toEqual(fallback);
    expect(parseFabPos('{"tx":"-10","ty":20}', SIZE, VIEW)).toEqual(fallback);
    expect(parseFabPos('{"tx":-99999,"ty":0}', SIZE, VIEW)).toEqual(fallback);
  });

  it('正常位置读回来原样保留', () => {
    const saved = JSON.stringify({ tx: -320, ty: -120 });
    expect(parseFabPos(saved, SIZE, VIEW)).toEqual({ tx: -320, ty: -120 });
  });

  it('位置合法但当前窗口放不下：夹进可视区，不丢用户偏好', () => {
    const saved = JSON.stringify({ tx: 0, ty: 0 });
    const small: FabView = { width: 700, height: 520 };
    const pos = parseFabPos(saved, SIZE, small);
    const rect = fabRect(pos, SIZE, small);
    expect(rect.left).toBeGreaterThanOrEqual(FAB_EDGE);
    expect(rect.top).toBeGreaterThanOrEqual(FAB_TOP_SAFE);
    expect(rect.right).toBeLessThanOrEqual(small.width - FAB_EDGE);
    expect(rect.bottom).toBeLessThanOrEqual(small.height - FAB_EDGE);
  });
});
