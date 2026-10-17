import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { nextActiveIndex } from './menuNav';

/* ------------------------------------------------------------------ */
/* 右键菜单（第五版 阶段10）                                           */
/*                                                                     */
/* 用法：在一个元素上挂 onContextMenu，然后调 showContextMenu(e, [...]) */
/* 菜单本身是单例：同一个时刻只会有一份，换地方右键就换内容。            */
/* 只做外观与交互，所有动作都复用已有函数 —— 不新增业务逻辑。            */
/* 拆成几块：位置计算 / 事件绑定 / 单行渲染 各自独立，MenuPanel 只负责拼。*/
/* ------------------------------------------------------------------ */

export interface MenuItem {
  label: string;
  /** 右对齐的灰字提示（快捷键、当前值之类） */
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
  /** 在这一项前面画一条分隔线 */
  separator?: boolean;
  onSelect: () => void;
}

interface MenuState {
  x: number;
  y: number;
  items: MenuItem[];
  seq: number;
}

let pending: MenuState | null = null;
const listeners = new Set<(v: MenuState | null) => void>();
let seq = 0;

function emit(): void {
  const snapshot = pending;
  listeners.forEach((l) => l(snapshot));
}

/** 在鼠标位置弹出菜单（坐标就是原生的 clientX / clientY） */
export function showContextMenu(e: { clientX: number; clientY: number }, items: MenuItem[]): void {
  if (items.length === 0) return;
  pending = { x: e.clientX, y: e.clientY, items, seq: ++seq };
  emit();
}

export function hideContextMenu(): void {
  if (!pending) return;
  pending = null;
  emit();
}

export function ContextMenuHost(): ReactNode {
  const [state, setState] = useState<MenuState | null>(pending);
  useEffect(() => {
    listeners.add(setState);
    return () => {
      listeners.delete(setState);
    };
  }, []);
  if (!state) return null;
  return <MenuPanel key={state.seq} state={state} />;
}

/** 贴边时把菜单往里收 / 往上翻。用 offsetWidth/Height 量：入场动画带 scale，getBoundingClientRect 会偏小。 */
function useMenuPlacement(state: MenuState, boxRef: RefObject<HTMLDivElement | null>) {
  const [pos, setPos] = useState({ left: state.x, top: state.y, visible: false });
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const gap = 8;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const left = Math.min(state.x, Math.max(gap, window.innerWidth - w - gap));
    const top = Math.min(state.y, Math.max(gap, window.innerHeight - h - gap));
    setPos({ left: Math.max(gap, left), top: Math.max(gap, top), visible: true });
  }, [state, boxRef]);
  return pos;
}

interface MenuEventsOptions {
  state: MenuState;
  active: number;
  setActive: (i: number) => void;
  boxRef: RefObject<HTMLDivElement | null>;
  close: (delay?: boolean) => void;
}

/** 键盘（Esc / ↑↓ / Enter）、点外面、失焦、缩放、滚动 —— 都关掉菜单。 */
function useMenuEvents({ state, active, setActive, boxRef, close }: MenuEventsOptions): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const next = nextActiveIndex(state.items, active, e.key === 'ArrowDown' ? 1 : -1);
        if (next >= 0) setActive(next);
        return;
      }
      if (e.key === 'Enter' && active >= 0) {
        e.preventDefault();
        const item = state.items[active];
        if (item && !item.disabled) {
          close(false);
          item.onSelect();
        }
      }
    };
    const onDown = (e: MouseEvent): void => {
      if (boxRef.current && e.target instanceof Node && boxRef.current.contains(e.target)) return;
      close();
    };
    const onBlur = (): void => close(false);
    const onScroll = (): void => close(false);
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('blur', onBlur);
    window.addEventListener('resize', onBlur);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('resize', onBlur);
      window.removeEventListener('scroll', onScroll, true);
    };
    // active 变化要重新绑（键盘高亮是内部状态）；退场定时器只在卸载时清，
    // 不能放在这里 —— 否则 close() 一 setClosing 就会把 130ms 的定时器清掉，菜单永远停在 .leaving。
  }, [active, state, setActive, boxRef, close]);
}

function MenuRow({
  item,
  index,
  active,
  onHover,
  onSelect
}: {
  item: MenuItem;
  index: number;
  active: number;
  onHover: (i: number) => void;
  onSelect: (item: MenuItem) => void;
}): ReactNode {
  return (
    <div>
      {item.separator ? <div className="ctx-sep" /> : null}
      <button
        type="button"
        role="menuitem"
        className={['ctx-item', item.danger ? 'danger' : '', active === index ? 'active' : '', item.disabled ? 'disabled' : '']
          .filter(Boolean)
          .join(' ')}
        aria-disabled={item.disabled ? true : undefined}
        onMouseEnter={() => onHover(index)}
        onClick={() => onSelect(item)}
      >
        <span className="ctx-label">{item.label}</span>
        {item.hint ? <span className="hint">{item.hint}</span> : null}
      </button>
    </div>
  );
}

function MenuPanel({ state }: { state: MenuState }): ReactNode {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const timerRef = useRef(0);
  const [closing, setClosing] = useState(false);
  const [active, setActive] = useState(-1);
  const pos = useMenuPlacement(state, boxRef);

  const close = (delay = true): void => {
    if (closing) return;
    setClosing(true);
    window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => hideContextMenu(), delay ? 130 : 0);
  };

  useMenuEvents({ state, active, setActive, boxRef, close });
  useEffect(() => () => window.clearTimeout(timerRef.current), []);

  const pick = (item: MenuItem): void => {
    if (item.disabled) return;
    close(false);
    item.onSelect();
  };

  return (
    <div
      ref={boxRef}
      className={'ctx-menu' + (closing ? ' leaving' : '')}
      role="menu"
      style={{ left: pos.left, top: pos.top, visibility: pos.visible ? 'visible' : 'hidden' }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {state.items.map((item, i) => (
        <MenuRow key={item.label + i} item={item} index={i} active={active} onHover={setActive} onSelect={pick} />
      ))}
    </div>
  );
}
