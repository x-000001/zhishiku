import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode
} from 'react';
import { api, onAiChatStream } from './api';
import { errText } from './errors';
import type { AiChatStreamEvent } from '../../shared/ai-chat';

interface ChatMessage {
  id: number;
  role: 'user' | 'assistant';
  content: string;
}

/**
 * AI 对话侧边栏（0.12.0 阶段4）。
 *
 * 红线对应：
 * - 独立请求域：requestId 由渲染层生成并随 ai:chat 传下去，取消走 ai:chat:cancel，
 *   和划词用的 ai:run / ai:cancel / AbortController 完全分开；
 * - 切换笔记：立刻中止在途请求、清空历史，并显示「已切换上下文，历史对话已清空」；
 * - 防注入：正文由主进程截到 8000 字并包进 <note_content>，这里只传原文；
 * - rAF 节流：流式增量先进 pendingRef，每帧最多 setState 一次；
 * - 让位：由 Knowledge 给 .kb-editor 加 margin-right（CSS 过渡），抽屉不覆盖正文；
 * - 焦点闭环：打开聚焦输入框，关闭把焦点还给打开前的元素。
 */
export default function AiChatDrawer(props: {
  noteId: number | null;
  noteTitle: string;
  /** 取当前笔记纯文本（含编辑器里还没保存的修改） */
  getContext: () => string;
  /** 复用划词那套「配置齐不齐 / 隐私说明同不同意」的前置检查 */
  ensureReady: () => Promise<boolean>;
  onClose: () => void;
}): ReactNode {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  const messageSeq = useRef(0);
  const requestSeq = useRef(0);
  const requestRef = useRef(0);
  const assistantIdRef = useRef(0);
  const noteRef = useRef<number | null>(props.noteId);
  const pendingRef = useRef('');
  const rafRef = useRef(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const backRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(props.onClose);

  useEffect(() => {
    onCloseRef.current = props.onClose;
  }, [props.onClose]);

  const scrollToBottom = useCallback(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  /* 打开：记住原焦点、聚焦输入框；关闭：拆掉 rAF、中止在途请求、归还焦点 */
  useEffect(() => {
    backRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const raf = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(raf);
      window.cancelAnimationFrame(rafRef.current);
      if (requestRef.current) void api.aiChatCancel(requestRef.current).catch(() => undefined);
      const back = backRef.current;
      if (!back || !document.contains(back)) return;
      const el = document.activeElement as HTMLElement | null;
      const inside = !!(el && panelRef.current && panelRef.current.contains(el));
      if (inside || !el || el === document.body) back.focus();
    };
  }, []);

  /* 流式事件：只认「当前 requestId + 当前 noteId」；同一帧内的多个 delta 合并成一次渲染 */
  useEffect(() => {
    const flush = (): void => {
      rafRef.current = 0;
      const delta = pendingRef.current;
      pendingRef.current = '';
      if (!delta) return;
      const id = assistantIdRef.current;
      setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, content: m.content + delta } : m)));
      scrollToBottom();
    };

    const off = onAiChatStream((event: AiChatStreamEvent) => {
      if (event.requestId !== requestRef.current) return;
      if (event.noteId !== noteRef.current) return;

      if (event.type === 'chunk') {
        pendingRef.current += event.delta;
        if (!rafRef.current) rafRef.current = window.requestAnimationFrame(flush);
        return;
      }

      // 收尾：把还没渲染的增量同步刷掉，再把权威全文写回去
      window.cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
      const rest = pendingRef.current;
      pendingRef.current = '';
      const id = assistantIdRef.current;
      requestRef.current = 0;
      setStreaming(false);

      if (event.type === 'done') {
        setMessages((prev) =>
          prev.map((m) => (m.id === id ? { ...m, content: (event.text || m.content + rest).trim() } : m))
        );
        return;
      }
      if (event.type === 'cancelled') {
        setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, content: (m.content + rest).trim() } : m)));
        setNotice('已停止生成');
        return;
      }
      // error
      setMessages((prev) => {
        const next = prev.map((m) => (m.id === id ? { ...m, content: (m.content + rest).trim() } : m));
        return next.filter((m) => !(m.id === id && !m.content));
      });
      setError(event.message);
    });

    return () => {
      off();
      window.cancelAnimationFrame(rafRef.current);
    };
  }, [scrollToBottom]);

  /* 切换笔记：中止在途请求 + 清空历史 + 明确提示（不静默保留旧上下文） */
  useEffect(() => {
    if (noteRef.current === props.noteId) return;
    noteRef.current = props.noteId;
    if (requestRef.current) {
      void api.aiChatCancel(requestRef.current).catch(() => undefined);
      requestRef.current = 0;
    }
    pendingRef.current = '';
    window.cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
    assistantIdRef.current = 0;
    setStreaming(false);
    setMessages([]);
    setDraft('');
    setError('');
    setNotice('已切换上下文，历史对话已清空');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.noteId]);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  const close = useCallback(() => {
    if (requestRef.current) {
      void api.aiChatCancel(requestRef.current).catch(() => undefined);
      requestRef.current = 0;
    }
    onCloseRef.current();
  }, []);

  const stop = useCallback(() => {
    const id = requestRef.current;
    if (id) void api.aiChatCancel(id).catch(() => undefined);
  }, []);

  const send = async (): Promise<void> => {
    const question = draft.trim();
    if (!question || streaming) return;
    if (!(await props.ensureReady())) return;
    const context = props.getContext();
    if (!context.trim()) {
      setError('这篇笔记还没有正文，先写点内容再问 AI');
      return;
    }
    const history = messages
      .filter((m) => m.content.trim())
      .map((m) => ({ role: m.role, content: m.content }));

    setError('');
    setNotice('');
    const userMessage: ChatMessage = { id: ++messageSeq.current, role: 'user', content: question };
    const assistantMessage: ChatMessage = { id: ++messageSeq.current, role: 'assistant', content: '' };
    assistantIdRef.current = assistantMessage.id;
    setMessages((prev) => [...prev, userMessage, assistantMessage]);
    setDraft('');

    const requestId = ++requestSeq.current;
    requestRef.current = requestId;
    setStreaming(true);
    try {
      await api.aiChat({
        requestId,
        noteId: props.noteId,
        title: props.noteTitle,
        context,
        question,
        history
      });
    } catch (err) {
      if (requestRef.current !== requestId) return;
      requestRef.current = 0;
      setStreaming(false);
      setMessages((prev) => prev.filter((m) => m.id !== assistantIdRef.current || m.content.trim()));
      setError(errText(err));
    }
  };

  const onInputKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.nativeEvent.isComposing) return; // 中文输入法选词时的回车不算发送
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <aside
      ref={panelRef}
      className="ai-chat-drawer"
      role="dialog"
      aria-label="AI 对话"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          close();
        }
      }}
    >
      <div className="ai-chat-head">
        <span className="ai-chat-title">💬 AI 对话</span>
        <span className="ai-chat-sub" title={props.noteTitle}>
          {props.noteTitle || '当前笔记'}
        </span>
        <span className="spacer" style={{ flex: 1 }} />
        <button type="button" className="icon-btn" title="关闭 AI 对话" aria-label="关闭 AI 对话" onClick={close}>
          ✕
        </button>
      </div>

      {notice ? (
        <div className="ai-chat-notice" role="status">
          {notice}
        </div>
      ) : null}

      <div className="ai-chat-list" ref={listRef}>
        {messages.length === 0 && !streaming ? (
          <div className="ai-chat-empty">
            基于当前笔记提问，AI 只会参考这篇笔记的内容回答。
            <br />
            切换笔记时会自动中止生成并清空历史。
          </div>
        ) : null}
        {messages.map((message) => (
          <div key={message.id} className={'ai-chat-msg ' + message.role}>
            <div className="ai-chat-msg-role">{message.role === 'user' ? '我' : 'AI'}</div>
            <div className="ai-chat-msg-body">{message.content || (streaming ? '…' : '')}</div>
          </div>
        ))}
        {streaming ? (
          <div className="ai-chat-typing" aria-live="polite">
            <span className="spin" aria-hidden="true" /> 正在生成…
          </div>
        ) : null}
      </div>

      {error ? (
        <div className="ai-chat-error" role="alert">
          {error}
        </div>
      ) : null}

      <div className="ai-chat-compose">
        <textarea
          ref={inputRef}
          className="ai-chat-input"
          rows={3}
          placeholder="问点关于这篇笔记的问题…（Enter 发送，Shift+Enter 换行）"
          value={draft}
          aria-label="给 AI 的问题"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onInputKeyDown}
        />
        <div className="ai-chat-actions">
          <span className="ai-chat-hint">{streaming ? '生成中…' : '基于当前笔记内容'}</span>
          <span className="spacer" style={{ flex: 1 }} />
          {streaming ? (
            <button type="button" className="btn sm" onClick={stop}>
              ■ 停止
            </button>
          ) : (
            <button type="button" className="btn sm primary ai-chat-send" onClick={() => void send()} disabled={!draft.trim()}>
              发送
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}
