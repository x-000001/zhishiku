/**
 * 番茄钟悬浮按钮的坐标计算（0.8.1）。
 *
 * 全是很纯的算术，不碰 DOM / React / Electron，方便单测，也方便以后换布局。
 *
 * 约定：
 * - 按钮在 CSS 里是 `right:18px; bottom:18px`，没拖动时它的左上角在
 *   `(窗口宽 - 18 - 按钮宽, 窗口高 - 18 - 按钮高)`；
 * - `tx / ty` 是这个左上角相对默认位置的偏移（CSS 用 transform 表达，不碰 left/top）；
 * - 所有函数都不读全局 `window`，窗口尺寸由调用方传进来，单测里可以随便造。
 */

export type FabPos = { tx: number; ty: number };
export type FabSize = { width: number; height: number };
export type FabView = { width: number; height: number };

/** 默认位置：右下角，tx / ty 都是 0（对应 CSS 的 right:18px; bottom:18px） */
export const FAB_DEFAULT_POS: FabPos = { tx: 0, ty: 0 };
/** 量不到按钮尺寸时的兜底（和 CSS 里的按钮差不多大） */
export const FAB_FALLBACK_SIZE: FabSize = { width: 120, height: 38 };
/** 按钮与窗口左/右/下边至少留这么多像素 */
export const FAB_EDGE = 8;
/**
 * 顶部安全区：窗口顶部是自绘标题栏的拖拽区（`-webkit-app-region: drag`），
 * 按钮一旦压进去，鼠标事件会被系统当成「拖窗口」吃掉，连 pointerdown 都收不到。
 * 所以纵向上限从 60px 开始，给标题栏（52~56px）留出余量。
 */
export const FAB_TOP_SAFE = 60;
/** 松手时离左/右边缘小于这个距离，就自动吸附过去（0.8.0 加的） */
export const FAB_SNAP_DISTANCE = 50;
/** 吸附到边上时预留的边距，比 FAB_EDGE 大一点，看着不贴死 */
export const FAB_SNAP_MARGIN = 16;
/** 与 CSS 里 right / bottom 的 18px 保持一致 */
export const FAB_BASE_INSET = 18;
/** 存下来的坐标绝对值超过这个数就当脏数据（1e999、手改 localStorage 等） */
export const FAB_MAX_ABS = 20000;

function clamp(value: number, lo: number, hi: number): number {
  // lo > hi 的极端情况（窗口比按钮还小）时保持 lo，至少保证按钮左上角可见
  return Math.min(Math.max(value, lo), Math.max(lo, hi));
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

/** 量按钮尺寸；量不到（还没挂载 / 被隐藏）就用兜底值 */
export function fabSizeOf(dock: { offsetWidth?: number; offsetHeight?: number } | null | undefined): FabSize {
  const width = dock?.offsetWidth ?? 0;
  const height = dock?.offsetHeight ?? 0;
  return {
    width: width > 0 ? width : FAB_FALLBACK_SIZE.width,
    height: height > 0 ? height : FAB_FALLBACK_SIZE.height,
  };
}

/** 默认位置（未拖动）的左上角，单位是视口像素 */
export function fabBasePoint(size: FabSize, view: FabView): { left: number; top: number } {
  return {
    left: view.width - FAB_BASE_INSET - size.width,
    top: view.height - FAB_BASE_INSET - size.height,
  };
}

/** 任意 pos 换算成按钮在视口里的矩形（给测试和面板换边用） */
export function fabRect(pos: FabPos, size: FabSize, view: FabView): { left: number; top: number; right: number; bottom: number } {
  const base = fabBasePoint(size, view);
  const left = base.left + pos.tx;
  const top = base.top + pos.ty;
  return { left, top, right: left + size.width, bottom: top + size.height };
}

/**
 * 把位移夹进可选区域：
 * 左/右/下留 FAB_EDGE，上留 FAB_TOP_SAFE（避开标题栏拖拽区）。
 */
export function clampFabPos(tx: number, ty: number, size: FabSize, view: FabView): FabPos {
  const base = fabBasePoint(size, view);
  const minX = FAB_EDGE - base.left;
  const maxX = view.width - FAB_EDGE - size.width - base.left;
  const minY = FAB_TOP_SAFE - base.top;
  const maxY = view.height - FAB_EDGE - size.height - base.top;
  return {
    tx: clamp(finiteOr(tx, 0), minX, maxX),
    ty: clamp(finiteOr(ty, 0), minY, maxY),
  };
}

/** 松手时吸附：离左/右边缘小于 FAB_SNAP_DISTANCE 就吸到 FAB_SNAP_MARGIN 处，纵向不动 */
export function snapFabEdge(pos: FabPos, size: FabSize, view: FabView): FabPos {
  const rect = fabRect(pos, size, view);
  let tx = pos.tx;
  if (rect.left < FAB_SNAP_DISTANCE) {
    tx = FAB_SNAP_MARGIN - fabBasePoint(size, view).left;
  } else if (view.width - rect.right < FAB_SNAP_DISTANCE) {
    tx = view.width - FAB_SNAP_MARGIN - size.width - fabBasePoint(size, view).left;
  }
  return clampFabPos(tx, pos.ty, size, view);
}

/** localStorage 里的东西可能被手改坏：结构不对、NaN、Infinity、大到离谱都算无效 */
export function isFabPosLike(value: unknown): value is FabPos {
  if (value === null || typeof value !== 'object') return false;
  const cand = value as Partial<FabPos>;
  return (
    typeof cand.tx === 'number' &&
    typeof cand.ty === 'number' &&
    Number.isFinite(cand.tx) &&
    Number.isFinite(cand.ty) &&
    Math.abs(cand.tx) <= FAB_MAX_ABS &&
    Math.abs(cand.ty) <= FAB_MAX_ABS
  );
}

/**
 * 解释 localStorage 里存的位置：
 * 坏的 / 越出可信范围的一律回默认右下角；正常但当前窗口放不下的夹回可视区。
 */
export function parseFabPos(raw: string | null | undefined, size: FabSize, view: FabView): FabPos {
  if (!raw) return clampFabPos(FAB_DEFAULT_POS.tx, FAB_DEFAULT_POS.ty, size, view);
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  if (!isFabPosLike(parsed)) {
    return clampFabPos(FAB_DEFAULT_POS.tx, FAB_DEFAULT_POS.ty, size, view);
  }
  return clampFabPos(parsed.tx, parsed.ty, size, view);
}
