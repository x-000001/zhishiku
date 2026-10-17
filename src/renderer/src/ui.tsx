import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/* ------------------------------------------------------------------ */
/* 轻提示（含 5 秒撤销）                                               */
/* ------------------------------------------------------------------ */

export interface ToastOptions {
  actionLabel?: string;
  onAction?: () => void | Promise<void>;
  ttl?: number;
}

interface ToastItem {
  id: number;
  text: string;
  actionLabel?: string;
  onAction?: () => void | Promise<void>;
}

let seq = 0;
let items: ToastItem[] = [];
/** 每条提示自己的计时器。手动关掉时要连计时器一起清，不然它会挂到 2.6/6 秒后才空转一次。 */
const timers = new Map<number, number>();
const listeners = new Set<(list: ToastItem[]) => void>();

function emit(): void {
  const snapshot = [...items];
  listeners.forEach((l) => l(snapshot));
}

function drop(id: number): void {
  const timer = timers.get(id);
  if (timer !== undefined) {
    window.clearTimeout(timer);
    timers.delete(id);
  }
  items = items.filter((i) => i.id !== id);
  emit();
}

export function toast(text: string, options: ToastOptions = {}): void {
  const item: ToastItem = {
    id: ++seq,
    text,
    actionLabel: options.actionLabel,
    onAction: options.onAction
  };
  items = [...items, item];
  emit();
  const ttl = options.ttl ?? (options.actionLabel ? 6000 : 2600);
  timers.set(
    item.id,
    window.setTimeout(() => drop(item.id), ttl)
  );
}

export function ToastHost(): ReactNode {
  const [list, setList] = useState<ToastItem[]>(items);
  useEffect(() => {
    listeners.add(setList);
    return () => {
      listeners.delete(setList);
    };
  }, []);
  if (list.length === 0) return null;
  return (
    // 第五版（阶段11）：role=status + aria-live，屏幕阅读器会把提示条念出来
    <div className="toast-wrap" role="status" aria-live="polite" aria-atomic="false">
      {list.map((item) => (
        <div className="toast" key={item.id}>
          <span>{item.text}</span>
          {item.actionLabel ? (
            <button
              type="button"
              onClick={() => {
                drop(item.id);
                void item.onAction?.();
              }}
            >
              {item.actionLabel}
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 弹窗                                                                */
/* ------------------------------------------------------------------ */

export function Modal(props: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
  /** 第五版：给弹窗挂一个变体类名（比如全局搜索的 search-modal），只用来加外观 */
  variant?: string;
}): ReactNode {
  const onCloseRef = useRef(props.onClose);
  onCloseRef.current = props.onClose;
  const [leaving, setLeaving] = useState(false);
  const leavingRef = useRef(false);
  const timerRef = useRef(0);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const backRef = useRef<Element | null>(null);

  // 关闭先播 150ms 退场动画（只动 transform / opacity），再真正卸载
  const requestClose = useCallback(() => {
    if (leavingRef.current) return;
    leavingRef.current = true;
    setLeaving(true);
    window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => onCloseRef.current(), 150);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') requestClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [requestClose]);

  // 打开时把焦点交给第一个能输入的东西（搜索面板自己管焦点，跳过），关掉后还回去
  useEffect(() => {
    backRef.current = document.activeElement;
    if (props.variant !== 'search-modal') {
      const el = boxRef.current?.querySelector<HTMLElement>(
        'input:not([type="hidden"]), textarea, select, .modal-foot .btn.primary'
      );
      el?.focus();
    }
    return () => {
      window.clearTimeout(timerRef.current);
      // 全局搜索面板是靠「搜索框聚焦」打开的：关掉时若把焦点还给搜索框，onFocus 会立刻把它再打开一遍
      if (props.variant === 'search-modal') return;
      const back = backRef.current;
      if (back instanceof HTMLElement && document.contains(back)) back.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 挂到 body 上：页面里的玻璃面板带 backdrop-filter，会让 position:fixed 以它为参照物，
  // 弹窗就会被裁在那个面板里（窄窗口底部面板量出来只有 688 宽）。
  return createPortal(
    <div
      className={'modal-backdrop' + (leaving ? ' leaving' : '')}
      onMouseDown={(e) => e.target === e.currentTarget && requestClose()}
    >
      <div
        ref={boxRef}
        className={props.variant ? 'modal ' + props.variant : 'modal'}
        style={props.width ? { width: props.width } : undefined}
        role="dialog"
        aria-modal="true"
        aria-labelledby="jw-modal-title"
      >
        <div className="modal-head">
          <span id="jw-modal-title">{props.title}</span>
          <span className="spacer" style={{ flex: 1 }} />
          <button
            type="button"
            className="icon-btn"
            onClick={requestClose}
            title="关闭"
            aria-label="关闭弹窗"
          >
            ✕
          </button>
        </div>
        <div className="modal-body">{props.children}</div>
        {props.footer ? <div className="modal-foot">{props.footer}</div> : null}
      </div>
    </div>,
    document.body
  );
}

export function ConfirmDialog(props: {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}): ReactNode {
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title={props.title}
      onClose={props.onCancel}
      width={460}
      footer={
        <>
          <button type="button" className="btn" onClick={props.onCancel} disabled={busy}>
            取消
          </button>
          <button
            type="button"
            className={props.danger ? 'btn primary' : 'btn primary'}
            style={props.danger ? { background: 'var(--danger)', borderColor: 'var(--danger)' } : undefined}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await props.onConfirm();
              } finally {
                setBusy(false);
              }
            }}
          >
            {props.confirmLabel ?? '确定'}
          </button>
        </>
      }
    >
      <div style={{ lineHeight: 1.7, fontSize: 13.5 }}>{props.message}</div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

export function Empty({ children }: { children: ReactNode }): ReactNode {
  return <div className="empty">{children}</div>;
}

export function dirLabel(value: string | null | undefined): string {
  if (!value) return '未分类';
  const parts = value.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? value;
}

export function Empty2(): ReactNode {
  return null;
}
