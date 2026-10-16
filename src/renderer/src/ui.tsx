import { useEffect, useState, type ReactNode } from 'react';

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
const listeners = new Set<(list: ToastItem[]) => void>();

function emit(): void {
  const snapshot = [...items];
  listeners.forEach((l) => l(snapshot));
}

function drop(id: number): void {
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
  window.setTimeout(() => drop(item.id), options.ttl ?? (options.actionLabel ? 6000 : 2600));
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
    <div className="toast-wrap">
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
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className={props.variant ? 'modal ' + props.variant : 'modal'} style={props.width ? { width: props.width } : undefined}>
        <div className="modal-head">
          <span>{props.title}</span>
          <span className="spacer" style={{ flex: 1 }} />
          <button type="button" className="icon-btn" onClick={props.onClose} title="关闭">
            ✕
          </button>
        </div>
        <div className="modal-body">{props.children}</div>
        {props.footer ? <div className="modal-foot">{props.footer}</div> : null}
      </div>
    </div>
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
