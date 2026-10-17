import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from '../api';
import { toast } from '../ui';
import { toastError } from '../errors';

export default function QuickCapture(props: { onSaved?: () => void }): ReactNode {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  const save = async () => {
    const value = text.trim();
    if (!value) return;
    setBusy(true);
    try {
      await api.addInbox(value, 'idea');
      toast('已存入收集箱');
      setText('');
      props.onSaved?.();
      window.close();
    } catch (err) {
      toastError('保存失败：', err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="quick">
      <textarea
        ref={ref}
        value={text}
        placeholder="想到什么，先写在这儿…（Enter 保存，Shift+Enter 换行，Esc 关闭）"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            void save();
          } else if (e.key === 'Escape') {
            window.close();
          }
        }}
      />
      <div className="hint">
        <span>回车存进收集箱，之后慢慢整理</span>
        <span>{busy ? '保存中…' : 'Esc 关闭'}</span>
      </div>
    </div>
  );
}
