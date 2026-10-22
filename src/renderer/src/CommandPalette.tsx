import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { toastError } from './errors';
import {
  PALETTE_OVERSCAN,
  PALETTE_ROW_HEIGHT,
  PALETTE_VIEWPORT_HEIGHT,
  filterPaletteItems,
  moveActiveIndex,
  scrollTopForIndex,
  virtualWindow,
  type PaletteCommand
} from './palette';

/**
 * 全局命令面板（0.12.0 阶段1）。
 *
 * 约束遵守点：
 * - 独立浮层：通过 portal 挂到 body，z-index 60（`.cmd-palette-backdrop`），
 *   低于 Toast(80)、高于番茄钟(55)，不动任何既有布局；
 * - 焦点闭环：打开时记下原焦点并自动聚焦输入框，关闭时只有「焦点还在面板里/已落到 body」
 *   才归还，避免把刚打开的其它弹窗焦点抢走；
 * - 虚拟列表：只渲染视口 + overscan 的行，>50 条命令不卡；
 * - 耗时操作：执行期间显示 Loading、禁用输入与列表、屏蔽 Esc/点蒙层关闭，防连点雪崩。
 */
export default function CommandPalette(props: {
  commands: PaletteCommand[];
  /** 笔记命令是否还在加载（只影响底部提示，不阻塞已有命令） */
  loading: boolean;
  onClose: () => void;
}): ReactNode {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [busy, setBusy] = useState<PaletteCommand | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const backRef = useRef<HTMLElement | null>(null);
  const rafRef = useRef(0);
  const busyRef = useRef<PaletteCommand | null>(null);
  const onCloseRef = useRef(props.onClose);

  useEffect(() => {
    onCloseRef.current = props.onClose;
  }, [props.onClose]);

  const results = useMemo(() => filterPaletteItems(props.commands, query), [props.commands, query]);
  const win = virtualWindow(results.length, scrollTop, PALETTE_VIEWPORT_HEIGHT, PALETTE_ROW_HEIGHT, PALETTE_OVERSCAN);
  const activeKey = results[active]?.item.key ?? '';

  /* 焦点闭环：记住打开前的元素 → 聚焦输入框；卸载时按需归还。 */
  useEffect(() => {
    backRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const raf = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(raf);
      const back = backRef.current;
      if (!back || !document.contains(back)) return;
      const el = document.activeElement as HTMLElement | null;
      const insidePalette = !!(el && panelRef.current && panelRef.current.contains(el));
      // 只有焦点还停在面板里、或已经落到 body（面板被卸载）时才归还；
      // 如果命令打开了另一个弹窗并抢走焦点，就别抢回来。
      if (insidePalette || !el || el === document.body) back.focus();
    };
  }, []);

  /* Esc 关闭（全局监听：焦点可能在面板任意位置）；执行中屏蔽，防误触雪崩。 */
  const requestClose = useCallback(() => {
    if (busyRef.current) return;
    onCloseRef.current();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      requestClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [requestClose]);

  /* 查询变化：回到第一行、滚回顶部。 */
  useEffect(() => {
    setActive(0);
    setScrollTop(0);
    if (listRef.current) listRef.current.scrollTop = 0;
  }, [query]);

  /* 命令列表异步补进来 / 过滤后变短：把越界的高亮夹回范围内。 */
  useEffect(() => {
    setActive((cur) => (cur > results.length - 1 ? Math.max(0, results.length - 1) : cur));
  }, [results.length]);

  /* 滚动用 rAF 节流：滚动事件每帧最多触发一次 setState。 */
  const onScroll = (): void => {
    const el = listRef.current;
    if (!el) return;
    window.cancelAnimationFrame(rafRef.current);
    rafRef.current = window.requestAnimationFrame(() => setScrollTop(el.scrollTop));
  };
  useEffect(() => () => window.cancelAnimationFrame(rafRef.current), []);

  const scrollActiveIntoView = (index: number): void => {
    const el = listRef.current;
    if (!el) return;
    const next = scrollTopForIndex(el.scrollTop, index, PALETTE_VIEWPORT_HEIGHT, PALETTE_ROW_HEIGHT);
    if (next !== el.scrollTop) {
      el.scrollTop = next;
      setScrollTop(next);
    }
  };

  const run = async (item: PaletteCommand | undefined): Promise<void> => {
    if (!item || busyRef.current) return;
    busyRef.current = item;
    setBusy(item);
    try {
      await item.run();
    } catch (err) {
      toastError('命令执行失败：', err);
    } finally {
      busyRef.current = null;
      setBusy(null);
      onCloseRef.current();
    }
  };

  const onInputKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (busyRef.current) {
      e.preventDefault();
      return;
    }
    if (e.key === 'Tab') {
      // 焦点闭环：面板里只有输入框可 Tab 到，Tab 不把焦点漏到背后的页面
      e.preventDefault();
      inputRef.current?.focus();
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = moveActiveIndex(active, e.key === 'ArrowDown' ? 1 : -1, results.length);
      setActive(next);
      scrollActiveIntoView(next);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      void run(results[active]?.item);
    }
  };

  return createPortal(
    <div
      className="cmd-palette-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) requestClose();
      }}
    >
      <div
        ref={panelRef}
        className={'cmd-palette' + (busy ? ' busy' : '')}
        role="dialog"
        aria-modal="true"
        aria-label="命令面板"
        aria-busy={busy ? true : undefined}
      >
        <div className="cmd-palette-top">
          <span className="cmd-palette-icon" aria-hidden="true">
            {busy ? '⏳' : '⌘'}
          </span>
          <input
            ref={inputRef}
            className="cmd-palette-input"
            type="text"
            value={query}
            disabled={busy !== null}
            placeholder="搜索页面、笔记、动作…（↑↓ 选择 · Enter 执行 · Esc 关闭）"
            aria-label="命令搜索"
            aria-controls="cmd-palette-list"
            aria-activedescendant={activeKey ? 'cmd-palette-opt-' + active : undefined}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onInputKeyDown}
          />
          <kbd className="cmd-palette-kbd">Esc</kbd>
        </div>

        {busy ? (
          <div className="cmd-palette-busy" role="status" aria-live="polite">
            <span className="spin" aria-hidden="true" />
            正在执行「{busy.title}」…
          </div>
        ) : null}

        <div
          id="cmd-palette-list"
          ref={listRef}
          className="cmd-palette-list"
          role="listbox"
          aria-label="命令列表"
          aria-activedescendant={activeKey ? 'cmd-palette-opt-' + active : undefined}
          data-total={results.length}
          data-start={win.start}
          data-scroll-top={Math.round(scrollTop)}
          onScroll={onScroll}
        >
          <div className="cmd-palette-canvas" style={{ height: results.length * PALETTE_ROW_HEIGHT }}>
            {results.slice(win.start, win.end).map((entry, offset) => {
              const index = win.start + offset;
              const item = entry.item;
              return (
                <button
                  key={item.key}
                  id={'cmd-palette-opt-' + index}
                  type="button"
                  role="option"
                  className={'cmd-palette-row' + (index === active ? ' active' : '')}
                  aria-selected={index === active}
                  data-index={index}
                  tabIndex={-1}
                  style={{ transform: 'translateY(' + index * PALETTE_ROW_HEIGHT + 'px)' }}
                  disabled={busy !== null}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => void run(item)}
                >
                  <span className="cmd-palette-row-icon" aria-hidden="true">
                    {item.icon ?? '•'}
                  </span>
                  <span className="cmd-palette-row-title">{highlightTitle(item.title, entry.indices)}</span>
                  <span className="cmd-palette-row-group">{item.group}</span>
                  {item.hint ? <span className="cmd-palette-row-hint">{item.hint}</span> : null}
                </button>
              );
            })}
          </div>
        </div>

        {results.length === 0 ? <div className="cmd-palette-empty">没有匹配的命令，换个关键词试试</div> : null}

        <div className="cmd-palette-foot">
          <span>{props.loading ? '正在加载笔记…' : '共 ' + results.length + ' 条命令'}</span>
          <span className="spacer" />
          <span>↑↓ 选择 · Enter 执行 · Esc 关闭</span>
        </div>
      </div>
    </div>,
    document.body
  );
}

/** 把标题里命中的字符包成 <mark>，做轻量高亮（不改变搜索语义）。 */
function highlightTitle(text: string, indices: number[]): ReactNode {
  if (indices.length === 0) return text;
  const set = new Set(indices);
  const out: ReactNode[] = [];
  let buffer = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (set.has(i)) {
      if (buffer) {
        out.push(buffer);
        buffer = '';
      }
      out.push(
        <mark key={i} className="cmd-palette-mark">
          {ch}
        </mark>
      );
    } else {
      buffer += ch;
    }
  }
  if (buffer) out.push(buffer);
  return out;
}
