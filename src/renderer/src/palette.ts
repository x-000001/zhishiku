/* ------------------------------------------------------------------ */
/* 全局命令面板（0.12.0 阶段1）的纯逻辑                                */
/*                                                                     */
/* 只做四件事：模糊匹配打分、过滤排序、上下键索引、虚拟列表窗口计算。  */
/* 不 import React / 不碰 DOM，所以可以直接在 Node 里单测              */
/* （tests/unit/palette.test.ts）。                                     */
/* ------------------------------------------------------------------ */

/** 一条命令的「数据面」：可序列化、可搜索、不含闭包。 */
export interface PaletteCommandItem {
  /** 稳定 id（React key / aria-activedescendant 用） */
  key: string;
  /** 主标题（唯一参与高亮的字段） */
  title: string;
  /** 分组名（右侧灰字） */
  group: string;
  /** 额外可搜词：英文、拼音、别名。只在标题不命中时兜底，不参与高亮 */
  keywords?: string;
  /** 右侧提示（快捷键 / 当前值），也参与兜底搜索 */
  hint?: string;
  /** 行首图标（emoji 或字符） */
  icon?: string;
}

/** 组件里用的命令：数据面 + 可执行动作。 */
export interface PaletteCommand extends PaletteCommandItem {
  run: () => void | Promise<void>;
}

export interface FuzzyResult {
  score: number;
  /** 命中的字符下标（用于把标题里的关键字高亮） */
  indices: number[];
}

/* 虚拟列表：固定行高 44px、视口 8 行（352px）、上下各多渲染 3 行。 */
export const PALETTE_ROW_HEIGHT = 44;
export const PALETTE_VIEWPORT_HEIGHT = 352;
export const PALETTE_OVERSCAN = 3;

const CHAR_BASE = 10;
const CONSECUTIVE_BONUS = 14;
const PREFIX_BONUS = 30;
const START_BONUS = 46;
const WORD_BOUNDARY_BONUS = 18;
const GAP_PENALTY = -2;
/** 只命中 keywords/hint 的命令整体降权，保证标题命中永远排在前面 */
const FALLBACK_PENALTY = 24;
const MAX_GAP_PENALTY_CHARS = 6;

/** 分词边界：空格/常见标点/中英文交界，都算「一个词的开头」。 */
function isBoundary(text: string, index: number): boolean {
  if (index === 0) return true;
  const prev = text[index - 1];
  const cur = text[index];
  if (/\s|[-_./:：，。·、（）()【】[\]"'“”‘’]/.test(prev)) return true;
  const prevCjk = /[\u4e00-\u9fa5]/.test(prev);
  const curCjk = /[\u4e00-\u9fa5]/.test(cur);
  return prevCjk !== curCjk;
}

/**
 * 子序列模糊匹配（大小写不敏感，中文按字符匹配）。
 * 返回 null 表示 query 不是 text 的子序列；空 query 返回 score 0 全匹配。
 */
export function fuzzyMatch(text: string, query: string): FuzzyResult | null {
  const q = query.trim().toLowerCase();
  const target = text.toLowerCase();
  if (!q) return { score: 0, indices: [] };
  if (!target) return null;

  let score = 0;
  let last = -1;
  const indices: number[] = [];

  for (let qi = 0; qi < q.length; qi += 1) {
    const ch = q[qi];
    let found = -1;
    for (let i = last + 1; i < target.length; i += 1) {
      if (target[i] === ch) {
        found = i;
        break;
      }
    }
    if (found < 0) return null;

    score += CHAR_BASE;
    if (found === last + 1) score += CONSECUTIVE_BONUS;
    else if (last >= 0) score += GAP_PENALTY * Math.min(MAX_GAP_PENALTY_CHARS, found - last - 1);
    if (isBoundary(text, found)) score += WORD_BOUNDARY_BONUS;
    if (found === 0) score += START_BONUS;

    indices.push(found);
    last = found;
  }

  // 整段前缀命中再加一点：「任务待办」在搜「任务」时要压过「今天的任务」
  if (target.startsWith(q)) score += PREFIX_BONUS;
  return { score, indices };
}

export interface ScoredPaletteItem<T extends PaletteCommandItem> {
  item: T;
  score: number;
  /** 标题里的命中下标；空数组表示只靠 keywords/hint 命中 */
  indices: number[];
}

/**
 * 过滤 + 排序。空 query 按原顺序返回前 limit 条；
 * 有 query 时标题命中 > 兜底命中，同分按原顺序（稳定，不依赖 locale）。
 */
export function filterPaletteItems<T extends PaletteCommandItem>(
  items: T[],
  query: string,
  limit = 200
): ScoredPaletteItem<T>[] {
  const q = query.trim();
  if (!q) return items.slice(0, limit).map((item) => ({ item, score: 0, indices: [] }));

  const hits: Array<ScoredPaletteItem<T> & { order: number }> = [];
  items.forEach((item, order) => {
    const titleHit = fuzzyMatch(item.title, q);
    if (titleHit) {
      hits.push({ item, score: titleHit.score, indices: titleHit.indices, order });
      return;
    }
    const fallbackHit = fuzzyMatch([item.keywords ?? '', item.group, item.hint ?? ''].join(' '), q);
    if (fallbackHit) {
      hits.push({ item, score: fallbackHit.score - FALLBACK_PENALTY, indices: [], order });
    }
  });

  hits.sort((a, b) => b.score - a.score || a.order - b.order);
  return hits.slice(0, limit).map(({ item, score, indices }) => ({ item, score, indices }));
}

/** 上下键移动高亮：到顶/到底就停住（不循环，和系统命令面板一致）。 */
export function moveActiveIndex(active: number, delta: number, total: number): number {
  if (total <= 0) return 0;
  const next = active + delta;
  if (next < 0) return 0;
  if (next > total - 1) return total - 1;
  return next;
}

/** 只渲染视口内（+overscan）的行，>50 条也不会一次挂几百个 DOM。 */
export function virtualWindow(
  total: number,
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  overscan = PALETTE_OVERSCAN
): { start: number; end: number } {
  if (total <= 0) return { start: 0, end: 0 };
  if (rowHeight <= 0 || viewportHeight <= 0) {
    return { start: 0, end: Math.min(total, overscan * 2 + 1) };
  }
  const first = Math.floor(Math.max(0, scrollTop) / rowHeight);
  const visible = Math.ceil(viewportHeight / rowHeight) + 1;
  return {
    start: Math.max(0, first - overscan),
    end: Math.min(total, first + visible + overscan)
  };
}

/** 键盘移动高亮时把该行滚进视口（返回新的 scrollTop；不需要滚就原样返回）。 */
export function scrollTopForIndex(
  scrollTop: number,
  index: number,
  viewportHeight: number,
  rowHeight: number
): number {
  if (index < 0 || rowHeight <= 0 || viewportHeight <= 0) return scrollTop;
  const top = index * rowHeight;
  const bottom = top + rowHeight;
  if (top < scrollTop) return top;
  if (bottom > scrollTop + viewportHeight) return bottom - viewportHeight;
  return scrollTop;
}

/** 输入类元素：裸键（不带 Ctrl/Alt/Meta）不应触发任何全局快捷键。 */
export interface ShortcutTargetLike {
  tagName?: string;
  isContentEditable?: boolean;
}

export function isEditableTarget(target: ShortcutTargetLike | null | undefined): boolean {
  if (!target) return false;
  const tag = (target.tagName || '').toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return target.isContentEditable === true;
}

/**
 * 全局快捷键的第一道闸：焦点在输入框 / contenteditable 里、且按的是裸键时，
 * 直接放行给输入区域，不让应用级快捷键抢走。
 * （带 Ctrl/Alt/Meta 的组合键仍是应用级快捷键，比如 Ctrl+S / Ctrl+K。）
 */
export function shouldIgnoreShortcut(
  event: { target: ShortcutTargetLike | null; ctrlKey: boolean; metaKey: boolean; altKey: boolean } | null | undefined
): boolean {
  if (!event) return false;
  if (!isEditableTarget(event.target)) return false;
  return !event.ctrlKey && !event.metaKey && !event.altKey;
}
