/**
 * 搜索直达（0.12.3）的 DOM 层：把 shared/locate 算出来的字符区间，落到
 * contenteditable 的真实文本节点上，并负责高亮与滚动。
 *
 * 高亮策略（契约一）：
 * - 首选 CSS Custom Highlight API（`new Highlight(...ranges)` + `CSS.highlights.set`），
 *   **完全不改 DOM**，天然不会把标签写进数据库；
 * - 只有浏览器不支持时才降级为 `<mark class="jw-hit">`，
 *   并在 touchBody / manualSave / scheduleDraft 之前调用 stripHighlights() 清场。
 *
 * 滚动策略（契约三）：严禁 scrollIntoView，按 range 的 client rect 手动算居中位置。
 */
import { LOCATE_MAX_SPANS, type LocateSpan } from '../../shared/locate';

/** 原生高亮在 CSS.highlights 里的名字（对应 styles.css 的 `::highlight(jw-locate-hit)`）。 */
export const LOCATE_HIGHLIGHT_NAME = 'jw-locate-hit';

export interface TextMapPart {
  node: Text;
  /** 该文本节点在 TextMap.text 里的起始下标 */
  start: number;
  /** 结束下标（不含） */
  end: number;
}

export interface TextMap {
  root: HTMLElement;
  /** 整篇正文的"可定位文本"：块级元素之间补 \n，跳过隐藏节点 */
  text: string;
  parts: TextMapPart[];
}

export interface HighlightHandle {
  /** native = CSS Custom Highlight；mark = <mark> 降级；none = 什么也没做 */
  kind: 'native' | 'mark' | 'none';
  ranges: Range[];
  marks: HTMLElement[];
}

/** 这些标签里的文字不参与定位（脚本/样式/模板），对应契约一"拒绝幽灵节点"。 */
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TEXTAREA', 'SELECT', 'OPTION']);

/** 块级元素：进入时补一个 \n，保证跨段落的引文能被匹配到。 */
const BLOCK_TAGS = new Set([
  'P',
  'DIV',
  'SECTION',
  'ARTICLE',
  'HEADER',
  'FOOTER',
  'MAIN',
  'ASIDE',
  'LI',
  'UL',
  'OL',
  'DL',
  'DT',
  'DD',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'BLOCKQUOTE',
  'PRE',
  'TABLE',
  'THEAD',
  'TBODY',
  'TFOOT',
  'TR',
  'TD',
  'TH',
  'FIGURE',
  'FIGCAPTION',
  'HR'
]);

interface NativeHighlightApi {
  registry: { set(name: string, highlight: object): void; delete(name: string): boolean };
  ctor: new (...ranges: Range[]) => object;
}

/** 探测 CSS Custom Highlight API；不可用时返回 null（此时才允许 <mark> 降级）。 */
function nativeHighlightApi(): NativeHighlightApi | null {
  const css = (globalThis as unknown as { CSS?: { highlights?: NativeHighlightApi['registry'] } }).CSS;
  const ctor = (globalThis as unknown as { Highlight?: NativeHighlightApi['ctor'] }).Highlight;
  if (!css || !css.highlights || !ctor) return null;
  return { registry: css.highlights, ctor };
}

const hiddenCache = new WeakMap<Element, boolean>();

function isHiddenElement(el: Element): boolean {
  const cached = hiddenCache.get(el);
  if (cached != null) return cached;
  let hidden = false;
  if (el instanceof HTMLElement) {
    if (el.hidden || el.getAttribute('aria-hidden') === 'true') hidden = true;
  }
  if (!hidden) {
    const style = window.getComputedStyle(el);
    hidden = style.display === 'none' || style.visibility === 'hidden';
  }
  hiddenCache.set(el, hidden);
  return hidden;
}

/**
 * 用 TreeWalker 把 contenteditable 的正文拍平成"纯文本 + 文本节点偏移表"。
 * - 跳过 script/style/隐藏元素（含其子树）；
 * - 块级元素进出时补 \n，<br> 也补 \n；
 * - 连续换行压成一个，避免 <p><br></p> 产生一堆空行。
 */
export function buildTextMap(root: HTMLElement): TextMap {
  const parts: TextMapPart[] = [];
  const chunks: string[] = [];
  let length = 0;
  let pendingBreak = false;

  const pushBreak = (): void => {
    if (length === 0) return;
    const last = chunks.length ? chunks[chunks.length - 1] : '';
    if (last.endsWith('\n')) return;
    pendingBreak = true;
  };

  const flushBreak = (): void => {
    if (!pendingBreak) return;
    pendingBreak = false;
    chunks.push('\n');
    length += 1;
  };

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(node: Node): number {
      if (node.nodeType === Node.TEXT_NODE) {
        const parent = (node as Text).parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        for (let el: Element | null = parent; el && el !== root; el = el.parentElement) {
          if (SKIP_TAGS.has(el.tagName) || isHiddenElement(el)) return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
      const el = node as Element;
      if (SKIP_TAGS.has(el.tagName) || isHiddenElement(el)) return NodeFilter.FILTER_REJECT;
      if (el.tagName === 'BR') {
        pushBreak();
        return NodeFilter.FILTER_SKIP;
      }
      if (BLOCK_TAGS.has(el.tagName)) pushBreak();
      return NodeFilter.FILTER_SKIP;
    }
  });

  let node = walker.nextNode();
  while (node) {
    if (node.nodeType === Node.TEXT_NODE) {
      const value = (node as Text).data;
      if (value) {
        flushBreak();
        parts.push({ node: node as Text, start: length, end: length + value.length });
        chunks.push(value);
        length += value.length;
      }
    }
    node = walker.nextNode();
  }

  return { root, text: chunks.join(''), parts };
}

interface EdgePoint {
  node: Text;
  offset: number;
}

function pointAt(map: TextMap, offset: number, edge: 'start' | 'end'): EdgePoint | null {
  if (!map.parts.length) return null;
  const first = map.parts[0];
  const lastPart = map.parts[map.parts.length - 1];
  if (offset <= first.start) return { node: first.node, offset: 0 };
  if (offset >= lastPart.end) return { node: lastPart.node, offset: lastPart.node.data.length };
  // 文本节点按 start 升序，二分找第一个 end > offset 的节点
  let lo = 0;
  let hi = map.parts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (map.parts[mid].end > offset) hi = mid;
    else lo = mid + 1;
  }
  const part = map.parts[lo];
  if (offset < part.start) {
    // 落在块级元素补出来的 \n 上：贴到该节点开头
    return edge === 'end' ? { node: part.node, offset: 0 } : { node: part.node, offset: 0 };
  }
  return { node: part.node, offset: Math.min(part.node.data.length, offset - part.start) };
}

/** 字符区间 → 真实 DOM Range。 */
export function rangesFromOffsets(map: TextMap, spans: LocateSpan[]): Range[] {
  const ranges: Range[] = [];
  for (const span of spans) {
    if (span.end <= span.start) continue;
    const from = pointAt(map, span.start, 'start');
    const to = pointAt(map, span.end, 'end');
    if (!from || !to) continue;
    const range = document.createRange();
    try {
      range.setStart(from.node, from.offset);
      range.setEnd(to.node, to.offset);
    } catch {
      continue;
    }
    if (!range.collapsed) ranges.push(range);
  }
  return ranges;
}

/** 把 <mark> 里的内容放回父节点并删掉标记。 */
function unwrapMark(mark: HTMLElement): void {
  const parent = mark.parentNode;
  if (!parent) return;
  while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
  parent.removeChild(mark);
  parent.normalize();
}

/** 降级路径：给单段 Range 里每个文本节点分别包一个 <mark>，绝不跨节点 surroundContents。 */
function wrapRangeWithMarks(range: Range): HTMLElement[] {
  const marks: HTMLElement[] = [];
  const nodes: Text[] = [];
  const root: Node =
    range.commonAncestorContainer.nodeType === Node.TEXT_NODE
      ? (range.commonAncestorContainer.parentNode as Node)
      : range.commonAncestorContainer;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    if (range.intersectsNode(node)) nodes.push(node as Text);
    node = walker.nextNode();
  }
  for (const text of nodes) {
    const localStart = text === range.startContainer ? range.startOffset : 0;
    const localEnd = text === range.endContainer ? range.endOffset : text.data.length;
    if (localEnd <= localStart) continue;
    const local = document.createRange();
    local.setStart(text, localStart);
    local.setEnd(text, localEnd);
    const mark = document.createElement('mark');
    mark.className = 'jw-hit';
    try {
      local.surroundContents(mark);
      marks.push(mark);
    } catch {
      // 极少数情况下 range 边界被同步改动：跳过这一小段，不影响其它段
    }
  }
  return marks;
}

/** 清掉上一次的高亮（原生注册表 + 可能残留的 mark）。 */
export function clearHighlights(scope?: HTMLElement | null): void {
  const api = nativeHighlightApi();
  if (api) api.registry.delete(LOCATE_HIGHLIGHT_NAME);
  const root: ParentNode = scope ?? document;
  root.querySelectorAll?.('mark.jw-hit').forEach((mark) => unwrapMark(mark as HTMLElement));
}

/**
 * 高亮若干 Range。契约一：优先零 DOM 变更的 CSS Custom Highlight；
 * 只有 API 不可用时才插入 <mark class="jw-hit">。
 */
export function highlightRanges(ranges: Range[], scope?: HTMLElement | null): HighlightHandle {
  clearHighlights(scope);
  if (!ranges.length) return { kind: 'none', ranges: [], marks: [] };
  const api = nativeHighlightApi();
  if (api) {
    const highlight = new api.ctor(...ranges.map((range) => range.cloneRange()));
    api.registry.set(LOCATE_HIGHLIGHT_NAME, highlight);
    return { kind: 'native', ranges, marks: [] };
  }
  const marks: HTMLElement[] = [];
  for (const range of ranges) marks.push(...wrapRangeWithMarks(range));
  return { kind: 'mark', ranges, marks };
}

/**
 * 强制清场：只在 <mark> 降级路径下需要，保证这些标签永远不会被 htmlRef 抄进数据库。
 * touchBody / manualSave / scheduleDraft 触发前都要先调它。
 */
export function stripHighlights(scope?: HTMLElement | null): void {
  const root: ParentNode = scope ?? document;
  root.querySelectorAll?.('mark.jw-hit').forEach((mark) => unwrapMark(mark as HTMLElement));
}

/**
 * 精确滚动（契约三）：完全按 range 的 client rect 算居中位置，
 * 禁止 scrollIntoView（它会贴顶、也会被外层 flex 布局干扰）。
 *
 * targetScrollTop = container.scrollTop + (rect.top - containerRect.top)
 *                   - container.clientHeight / 2 + rect.height / 2
 */
export function scrollRangeIntoView(range: Range, container: HTMLElement): boolean {
  const rects = range.getClientRects();
  const rect = rects.length ? rects[0] : range.getBoundingClientRect();
  if (!rect || (rect.width === 0 && rect.height === 0)) return false;
  const containerRect = container.getBoundingClientRect();
  const maxTop = Math.max(0, container.scrollHeight - container.clientHeight);
  const targetScrollTop =
    container.scrollTop +
    (rect.top - containerRect.top) -
    container.clientHeight / 2 +
    rect.height / 2;
  container.scrollTop = Math.max(0, Math.min(maxTop, targetScrollTop));
  return true;
}

/** 把命中的 Range 限制在前 N 个，避免高亮过多。 */
export function capRanges(ranges: Range[], limit = LOCATE_MAX_SPANS): Range[] {
  return ranges.slice(0, Math.max(1, limit));
}
