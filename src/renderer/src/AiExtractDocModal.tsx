/**
 * AI「提取笔记重点并整理成文档」弹窗（0.12.1）。
 *
 * 生命周期：打开即发起 extract 请求 → 流式内容用 requestAnimationFrame 节流写入
 * 预览框 → 用户确认后调 note:extract-save 落库成新笔记。必须守住的东西：
 * 1) isExtracting（这里用 phase）一定在结束/出错/卸载时复位，关闭弹窗要 abort，
 *    防止按钮永远卡在「生成中」；
 * 2) AI 返回空串/纯空白/网络异常绝不进入保存流程（主进程 note:extract-save 还会再拦一次）；
 * 3) 流式中途关闭要二次确认，避免误触丢掉已经生成的内容。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, onAiStream } from './api';
import { Modal, toast } from './ui';
import type { AiStreamEventWithId } from '../../shared/ai';
import {
  EXTRACT_MAX_CHARS,
  EXTRACT_TRUNCATED_HINT,
  extractResultError,
  truncateForExtraction
} from '../../shared/extract-doc';
import type { Id, Note } from '../../shared/types';

type Phase = 'running' | 'done' | 'error';

export default function AiExtractDocModal(props: {
  noteId: Id;
  title: string;
  noteText: string;
  onSaved: (note: Note) => void;
  onClose: () => void;
}): ReactNode {
  // 原文只在这里截一次：传给主进程的就是截断后的文本，弹窗顶部也能立刻给出提示。
  const { text: sourceText, truncated } = useMemo(
    () => truncateForExtraction(props.noteText),
    [props.noteText]
  );

  const [phase, setPhase] = useState<Phase>('running');
  const [output, setOutput] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);

  /** 当前 extract 请求的 requestId；与 ai:stream 事件按它过滤，防止串台。 */
  const requestIdRef = useRef<number | null>(null);
  /** 已排队的 rAF 句柄；chunk 先攒进 pendingRef，一帧只 setState 一次。 */
  const rafRef = useRef<number | null>(null);
  const pendingRef = useRef('');
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const aliveRef = useRef(true);

  const flushPending = useCallback(() => {
    if (rafRef.current != null) return;
    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = null;
      const chunk = pendingRef.current;
      pendingRef.current = '';
      if (chunk) setOutput((prev) => prev + chunk);
      bottomRef.current?.scrollIntoView({ block: 'end' });
    });
  }, []);

  const cancelAnimation = useCallback(() => {
    if (rafRef.current != null) {
      window.cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  const cancelRequest = useCallback(() => {
    const id = requestIdRef.current;
    requestIdRef.current = null;
    if (id != null) void api.aiCancel(id).catch(() => undefined);
  }, []);

  const start = useCallback(async (): Promise<void> => {
    cancelRequest();
    cancelAnimation();
    pendingRef.current = '';
    setOutput('');
    setError('');
    setPhase('running');
    try {
      const res = await api.aiRun({
        action: 'extract',
        noteText: sourceText,
        title: props.title
      });
      if (!aliveRef.current) {
        // 请求回来前弹窗已经关了：把刚拿到的任务立刻取消，别让它在后台烧额度
        void api.aiCancel(res.requestId).catch(() => undefined);
        return;
      }
      requestIdRef.current = res.requestId;
    } catch (err) {
      if (!aliveRef.current) return;
      setPhase('error');
      setError(err instanceof Error ? err.message : 'AI 请求失败了，再试一次吧');
    }
  }, [cancelAnimation, cancelRequest, props.title, sourceText]);

  useEffect(() => {
    aliveRef.current = true;
    const off = onAiStream((event: AiStreamEventWithId) => {
      if (requestIdRef.current == null || event.requestId !== requestIdRef.current) return;
      if (event.type === 'chunk') {
        pendingRef.current += event.delta;
        flushPending();
        return;
      }
      if (event.type === 'done') {
        cancelAnimation();
        const rest = pendingRef.current;
        pendingRef.current = '';
        setOutput((prev) => {
          const merged = rest ? prev + rest : prev;
          // 模型没走增量（或分片全丢）时用 done 带的完整文本兜底
          return merged.trim() ? merged : event.text ?? '';
        });
        setPhase('done');
        bottomRef.current?.scrollIntoView({ block: 'end' });
        return;
      }
      cancelAnimation();
      setError(event.message || 'AI 请求失败了，再试一次吧');
      setPhase('error');
    });
    void start();
    return () => {
      aliveRef.current = false;
      off();
      cancelAnimation();
      const id = requestIdRef.current;
      requestIdRef.current = null;
      if (id != null) void api.aiCancel(id).catch(() => undefined);
    };
  }, [cancelAnimation, flushPending, start]);

  /**
   * Esc / ✕ / 点遮罩都会先问这里：生成中直接拦下并弹二次确认，
   * 而且不播退场动画（否则选「继续生成」后弹窗会卡在半退场状态、✕ 再也点不动）。
   */
  const guardClose = useCallback((): boolean => {
    if (phase === 'running') {
      setConfirmClose(true);
      return false;
    }
    return true;
  }, [phase]);

  const requestClose = useCallback(() => {
    if (!guardClose()) return;
    props.onClose();
  }, [guardClose, props.onClose]);

  const stop = useCallback(() => {
    cancelRequest();
    cancelAnimation();
    setPhase('error');
    setError('已停止生成，可以点「重新生成」再来一次。');
  }, [cancelAnimation, cancelRequest]);

  const abortAndClose = useCallback(() => {
    cancelRequest();
    cancelAnimation();
    pendingRef.current = '';
    setConfirmClose(false);
    props.onClose();
  }, [cancelAnimation, cancelRequest, props.onClose]);

  const save = useCallback(async (): Promise<void> => {
    if (saving || phase !== 'done') return;
    const problem = extractResultError(output);
    if (problem) {
      // 双保险：空结果/纯空白绝不进保存流程
      setError(problem);
      setPhase('error');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const note = await api.createNoteFromExtraction(props.noteId, output);
      toast('已保存为新笔记');
      props.onSaved(note);
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败了，再试一次吧');
    } finally {
      setSaving(false);
    }
  }, [output, phase, props.noteId, props.onSaved, saving]);

  const resultProblem = extractResultError(output);
  const canSave = phase === 'done' && !saving && resultProblem == null;

  return (
    <Modal
      title="AI 整理成重点文档"
      variant="ai-extract"
      width={720}
      onClose={props.onClose}
      beforeClose={guardClose}
      footer={
        <div className="ai-foot">
          {phase === 'running' ? (
            <button type="button" className="btn ai-extract-stop" onClick={stop}>
              停止生成
            </button>
          ) : (
            <button type="button" className="btn ai-extract-retry" onClick={() => void start()}>
              重新生成
            </button>
          )}
          <button type="button" className="btn ai-extract-close" onClick={requestClose}>
            关闭
          </button>
          <button
            type="button"
            className="btn primary ai-extract-save"
            onClick={() => void save()}
            disabled={!canSave}
            title={resultProblem && phase !== 'running' ? resultProblem : '保存为新笔记并打开'}
          >
            {saving ? '保存中…' : '保存为新笔记'}
          </button>
        </div>
      }
    >
      <div className="ai-extract-body">
        {truncated ? <div className="ai-extract-warning">{EXTRACT_TRUNCATED_HINT}</div> : null}
        <div className="ai-extract-meta">
          <span className={`ai-extract-state ${phase}`}>
            {phase === 'running'
              ? '正在读笔记、提炼重点…'
              : phase === 'done'
                ? '提炼完成，确认无误后保存'
                : '本次没有完成'}
          </span>
          <span className="ai-extract-count">
            原笔记：{props.title || '未命名笔记'}（{sourceText.length} / {EXTRACT_MAX_CHARS} 字）
          </span>
        </div>
        <pre className="ai-extract-output" aria-live="polite">
          {output ||
            (phase === 'running' ? '正在读笔记、列提纲…' : '（没有生成任何内容）')}
        </pre>
        <div ref={bottomRef} />
        {error ? <div className="ai-extract-error">{error}</div> : null}
        {confirmClose ? (
          <div className="ai-extract-confirm" role="alertdialog">
            <span>正在生成，关闭会中止本次提炼，已生成的内容不会保存。确定关闭？</span>
            <button type="button" className="btn sm" onClick={() => setConfirmClose(false)}>
              继续生成
            </button>
            <button
              type="button"
              className="btn sm danger ai-extract-confirm-close"
              onClick={abortAndClose}
            >
              关闭并中止
            </button>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
