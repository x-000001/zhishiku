import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  AI_ACTION_LABELS,
  AI_QUICK_ACTIONS,
  AI_TARGET_LANGS,
  clampAiText,
  parseRelatedItems,
  parseTagSuggestion,
  type AiLangValue,
  type AiRelatedItem,
  type AiRunPayload,
  type AiTagSuggestion,
  type AiTextAction
} from '../../shared/ai';
import { escapeHtml } from '../../shared/html';
import { api, onAiStream } from './api';
import { errText } from './errors';
import { Modal, toast } from './ui';

/**
 * 第七版（0.7.0）：渲染层的 AI 组件。
 *
 * 所有请求都走主进程（api.aiRun → ai:run），这里只负责：
 * 发起请求、收流、把结果展示成能对比/能确认的界面。
 * 渲染层永远不直接调外部 URL —— Key 不进这里。
 */

export interface AiRunState {
  /** 已经收到的文字（流式累加） */
  text: string;
  done: boolean;
  /** 用户主动点了「停止生成」：done 为真但保留已生成内容，不算出错 */
  stopped: boolean;
  error: string | null;
  requestId: number | null;
}

export interface AiRunHandle {
  state: AiRunState;
  start: (payload: AiRunPayload) => Promise<void>;
  cancel: () => void;
  reset: () => void;
}

const EMPTY_RUN: AiRunState = { text: '', done: false, stopped: false, error: null, requestId: null };

/**
 * AI 请求 hook：start 立刻拿 requestId，文字随后从 ai:stream 事件推过来。
 * 卸载时自动把还没结束的请求取消掉（不浪费额度，也不让回调落到已卸载组件上）。
 */
export function useAiRun(): AiRunHandle {
  const [state, setState] = useState<AiRunState>(EMPTY_RUN);
  const idRef = useRef<number | null>(null);

  useEffect(() => {
    const off = onAiStream((event) => {
      const id = idRef.current;
      if (id == null || event.requestId !== id) return;
      if (event.type === 'chunk') {
        setState((prev) => ({ ...prev, text: prev.text + event.delta }));
      } else if (event.type === 'done') {
        setState((prev) => ({ ...prev, text: event.text || prev.text, done: true }));
      } else if (event.message === '已取消') {
        // 用户点了「停止生成」：保留已经收到的文字，不当成错误弹红字
        setState((prev) => ({ ...prev, done: true, stopped: true, error: null }));
      } else {
        setState((prev) => ({ ...prev, done: true, error: event.message }));
      }
    });
    return () => {
      off();
      const id = idRef.current;
      if (id != null) {
        idRef.current = null;
        void api.aiCancel(id).catch(() => {});
      }
    };
  }, []);

  const start = useCallback(async (payload: AiRunPayload) => {
    const prev = idRef.current;
    if (prev != null) {
      idRef.current = null;
      void api.aiCancel(prev).catch(() => {});
    }
    setState(EMPTY_RUN);
    try {
      const { requestId } = await api.aiRun(payload);
      idRef.current = requestId;
      setState({ text: '', done: false, stopped: false, error: null, requestId });
    } catch (err) {
      idRef.current = null;
      setState({ text: '', done: true, stopped: false, error: errText(err), requestId: null });
    }
  }, []);

  const cancel = useCallback(() => {
    const id = idRef.current;
    idRef.current = null;
    if (id != null) void api.aiCancel(id).catch(() => {});
    // 保留已经收到的文字：用户可以接着复制/替换，只是后面不再有新内容
    setState((prev) => ({ ...prev, done: true, stopped: true, error: null }));
  }, []);

  const reset = useCallback(() => {
    const id = idRef.current;
    idRef.current = null;
    if (id != null) void api.aiCancel(id).catch(() => {});
    setState(EMPTY_RUN);
  }, []);

  return { state, start, cancel, reset };
}

/** AI 结果面板里的小尾巴：没写完闪一个光标，写完就消失。 */
function TypingCaret(props: { show: boolean }): ReactNode {
  if (!props.show) return null;
  return <span className="ai-caret" aria-hidden="true" />;
}

/** 还在生成（loading 或 streaming）时为真。 */
function isRunning(state: AiRunState): boolean {
  return !state.done && !state.error;
}

/**
 * 0.8.0：生成过程中的「停止生成」。
 * 点了之后主进程 abort() 掉网络请求，已经收到的文字留在弹窗里，可以继续复制/替换。
 */
function AiStop(props: { onStop: () => void }): ReactNode {
  return (
    <button
      type="button"
      className="btn sm ai-stop"
      title="中断这次生成；已经生成的内容会留下，可以继续复制或替换"
      onClick={props.onStop}
    >
      ■ 停止生成
    </button>
  );
}

/** 把 AI 的纯文本结果排成两栏对比里能读的样子（保留换行，别的都转义）。 */
function plainLines(text: string): string {
  return escapeHtml(text).replace(/\r\n/g, '\n').replace(/\n/g, '<br/>');
}

function langOf(value: AiLangValue): string {
  const found = AI_TARGET_LANGS.find((item) => item.value === value);
  return found ? found.label : '自动判断';
}

export function AiLangSelect(props: {
  value: AiLangValue;
  onChange: (value: AiLangValue) => void;
  disabled?: boolean;
}): ReactNode {
  return (
    <select
      className="ai-lang-select"
      value={props.value}
      disabled={props.disabled}
      title="翻译成哪种语言"
      aria-label="翻译目标语言"
      onChange={(e) => props.onChange(e.target.value as AiLangValue)}
    >
      {AI_TARGET_LANGS.map((item) => (
        <option key={item.value} value={item.value}>
          {item.label}
        </option>
      ))}
    </select>
  );
}

/**
 * 划词气泡菜单：选中一段文字后浮在选区下面。
 * 只负责「选哪个动作 / 译成什么语言」，点动作后由 Knowledge 打开预览弹窗。
 */
export function AiBubble(props: {
  left: number;
  top: number;
  lang: AiLangValue;
  onLang: (value: AiLangValue) => void;
  onAction: (action: AiTextAction) => void;
}): ReactNode {
  return (
    <div
      className="ai-bubble"
      style={{ left: props.left, top: props.top }}
      role="toolbar"
      aria-label="划词 AI 菜单"
      onMouseDown={(e) => e.preventDefault()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="ai-bubble-row">
        <span className="ai-bubble-title">✨ AI</span>
        <AiLangSelect value={props.lang} onChange={props.onLang} />
      </div>
      <div className="ai-bubble-actions">
        {AI_QUICK_ACTIONS.map((action) => (
          <button
            key={action}
            type="button"
            className="ai-bubble-btn"
            title={action === 'translate' ? `翻译成${langOf(props.lang)}` : AI_ACTION_LABELS[action]}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => props.onAction(action)}
          >
            {AI_ACTION_LABELS[action]}
          </button>
        ))}
      </div>
      <div className="ai-bubble-hint">选中的文字会发给你配置的模型服务，确认后才替换</div>
    </div>
  );
}

/**
 * 划词结果的预览弹窗：左边原文、右边 AI 结果（流式）。
 * **确认替换之前绝不改正文** —— 这是需求里的硬红线。
 */
export function AiPreviewModal(props: {
  action: AiTextAction;
  source: string;
  initialLang: AiLangValue;
  onConfirm: (text: string) => void;
  onClose: () => void;
}): ReactNode {
  const { state, start, cancel } = useAiRun();
  const [lang, setLang] = useState<AiLangValue>(props.initialLang);
  const label = AI_ACTION_LABELS[props.action];
  const isTranslate = props.action === 'translate';
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void start({
      action: props.action,
      text: clampAiText(props.source),
      targetLang: isTranslate ? lang : undefined
    });
  }, [props.action, props.source, isTranslate, lang, start]);

  const restart = (): void => {
    void start({
      action: props.action,
      text: clampAiText(props.source),
      targetLang: isTranslate ? lang : undefined
    });
  };

  const result = state.text.trim();
  const canConfirm = state.done && !state.error && result.length > 0;

  const copy = (): void => {
    if (!result) return;
    void api.copyText(result).then(() => toast('已复制 AI 结果'));
  };

  return (
    <Modal
      title={`${label}${isTranslate ? ' · ' + langOf(lang) : ''}`}
      variant="ai-preview"
      width={760}
      onClose={props.onClose}
      footer={
        <div className="ai-foot">
          <span className="spacer" style={{ flex: 1 }} />
          {isRunning(state) ? <AiStop onStop={cancel} /> : null}
          <button type="button" className="btn" onClick={props.onClose}>
            取消
          </button>
          <button type="button" className="btn" disabled={!result} onClick={copy}>
            复制
          </button>
          <button
            type="button"
            className="btn primary ai-confirm"
            disabled={!canConfirm}
            onClick={() => props.onConfirm(result)}
            title={canConfirm ? '写回选中的位置' : '等 AI 写完才能替换'}
          >
            确认替换
          </button>
        </div>
      }
    >
      <div className="ai-preview">
        {isTranslate ? (
          <div className="ai-preview-lang">
            <span>翻译成</span>
            <AiLangSelect
              value={lang}
              disabled={!state.done && !state.error && state.text.length === 0}
              onChange={(next) => {
                setLang(next);
                restart();
              }}
            />
            <span className="ai-tip">默认「自动判断」：中文译成英文，其它语言译成中文</span>
          </div>
        ) : null}
        <div className="ai-preview-cols">
          <div className="ai-col">
            <div className="ai-col-head">原文</div>
            <pre className="ai-preview-src">{props.source || '（没有选中文字）'}</pre>
          </div>
          <div className="ai-col">
            <div className="ai-col-head">
              AI 结果
              {isRunning(state) ? <span className="ai-busy">生成中…</span> : null}
              {state.stopped ? <span className="ai-stopped">已停止</span> : null}
            </div>
            <pre className="ai-preview-out">
              {state.error ? (
                <span className="ai-error-text">{state.error}</span>
              ) : (
                <span dangerouslySetInnerHTML={{ __html: plainLines(state.text) }} />
              )}
              <TypingCaret show={isRunning(state)} />
            </pre>
          </div>
        </div>
        {state.error ? (
          <div className="ai-error-bar">
            <span>{state.error}</span>
            <button type="button" className="btn sm" onClick={restart}>
              重试
            </button>
          </div>
        ) : null}
        {state.stopped ? (
          <div className="ai-stop-bar">
            <span>已经停止生成，后半段没要。留下的是已经生成的部分，可以复制或直接替换。</span>
            <button type="button" className="btn sm" onClick={restart}>
              重新生成
            </button>
          </div>
        ) : null}
        <p className="ai-tip">
          这只是预览。点「确认替换」才会写进笔记；替换后可以用 <kbd>Ctrl+Z</kbd> 整体撤销。
        </p>
      </div>
    </Modal>
  );
}

/**
 * 全文摘要：流式生成完**自动**插到笔记开头（引用块），弹窗里留一个「撤销插入」。
 * 插入本身在 Knowledge 里用一次 execCommand('insertHTML') 完成，所以 Ctrl+Z 能整块撤掉。
 */
export function AiSummaryModal(props: {
  title: string;
  noteText: string;
  onInsert: (text: string) => void;
  onUndo: () => boolean;
  onClose: () => void;
}): ReactNode {
  const { state, start, cancel } = useAiRun();
  const startedRef = useRef(false);
  const insertedRef = useRef(false);
  const [inserted, setInserted] = useState(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void start({ action: 'summary', noteText: clampAiText(props.noteText), title: props.title });
  }, [start, props.noteText, props.title]);

  useEffect(() => {
    // 主动停止的不自动插入：只把已经生成的部分留在弹窗里，插不插由用户再点一下
    if (insertedRef.current || !state.done || state.error || state.stopped) return;
    const text = state.text.trim();
    if (!text) return;
    insertedRef.current = true;
    setInserted(true);
    props.onInsert(text);
  }, [state.done, state.error, state.stopped, state.text, props]);

  /** 停止之后手动把「已经生成的部分」插到开头。 */
  const insertPartial = (): void => {
    const text = state.text.trim();
    if (!text || insertedRef.current) return;
    insertedRef.current = true;
    setInserted(true);
    props.onInsert(text);
    toast('已把生成到的部分插到笔记开头');
  };

  const undo = (): void => {
    if (!props.onUndo()) {
      toast('没找到能撤销的插入，试试在编辑器里按 Ctrl+Z');
      return;
    }
    insertedRef.current = true;
    setInserted(false);
    toast('摘要已从开头拿掉（编辑器里也能 Ctrl+Z 撤销）');
  };

  const restart = (): void => {
    insertedRef.current = false;
    setInserted(false);
    void start({ action: 'summary', noteText: clampAiText(props.noteText), title: props.title });
  };

  const copy = (): void => {
    const text = state.text.trim();
    if (!text) return;
    void api.copyText(text).then(() => toast('已复制摘要'));
  };

  return (
    <Modal
      title="AI 摘要"
      variant="ai-summary"
      width={680}
      onClose={props.onClose}
      footer={
        <div className="ai-foot">
          <span className="spacer" style={{ flex: 1 }} />
          {isRunning(state) ? <AiStop onStop={cancel} /> : null}
          {state.stopped && !inserted ? (
            <button
              type="button"
              className="btn ai-insert-partial"
              onClick={insertPartial}
              disabled={!state.text.trim()}
              title="把已经生成到的部分插到笔记开头"
            >
              插入已生成部分
            </button>
          ) : null}
          <button type="button" className="btn" onClick={copy} disabled={!state.text.trim()}>
            复制
          </button>
          <button
            type="button"
            className="btn ai-undo"
            onClick={undo}
            disabled={!inserted}
            title={inserted ? '把刚插到开头的摘要拿掉' : '摘要还没插进去'}
          >
            撤销插入
          </button>
          <button type="button" className="btn primary" onClick={props.onClose}>
            完成
          </button>
        </div>
      }
    >
      <div className="ai-summary">
        <div className="ai-summary-head">
          {state.error ? (
            <span className="ai-error-text">{state.error}</span>
          ) : (
            <span>
              {state.done
                ? inserted
                  ? '摘要已插到笔记开头（引用块）'
                  : state.stopped
                    ? '已停止生成（没有自动插入，可以点「插入已生成部分」）'
                    : '摘要生成完了'
                : '正在总结这篇笔记…'}
            </span>
          )}
          {state.done && !state.error ? (
            <button type="button" className="btn sm" onClick={restart}>
              重新生成
            </button>
          ) : null}
        </div>
        <pre className="ai-summary-out">
          {state.error ? '' : <span>{state.text}</span>}
          <TypingCaret show={isRunning(state)} />
        </pre>
        <p className="ai-tip">
          插进去的是一整块引用，不想要了可以按「撤销插入」，或者直接在编辑器里 <kbd>Ctrl+Z</kbd> 整块撤销。
        </p>
      </div>
    </Modal>
  );
}

/** 分类整理：标签一键加，分类一键挪。 */
export function AiTagsModal(props: {
  title: string;
  noteText: string;
  tags: string[];
  categories: string[];
  onAddTag: (name: string) => void;
  onApplyCategory: (name: string) => boolean;
  onClose: () => void;
}): ReactNode {
  const { state, start, cancel } = useAiRun();
  const startedRef = useRef(false);
  const [added, setAdded] = useState<string[]>([]);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void start({
      action: 'tags',
      noteText: clampAiText(props.noteText),
      title: props.title,
      tags: props.tags,
      categories: props.categories
    });
  }, [start, props.noteText, props.title, props.tags, props.categories]);

  const suggestion: AiTagSuggestion | null = useMemo(() => {
    if (!state.done || state.error) return null;
    try {
      return parseTagSuggestion(state.text);
    } catch {
      return null;
    }
  }, [state.done, state.error, state.text]);

  const restart = (): void => {
    setAdded([]);
    void start({
      action: 'tags',
      noteText: clampAiText(props.noteText),
      title: props.title,
      tags: props.tags,
      categories: props.categories
    });
  };

  const addTag = (name: string): void => {
    if (added.includes(name)) return;
    props.onAddTag(name);
    setAdded((prev) => [...prev, name]);
  };

  return (
    <Modal
      title="AI 分类整理"
      variant="ai-tags"
      width={620}
      onClose={props.onClose}
      footer={
        <div className="ai-foot">
          <span className="spacer" style={{ flex: 1 }} />
          {isRunning(state) ? <AiStop onStop={cancel} /> : null}
          {state.done && !state.error ? (
            <button type="button" className="btn" onClick={restart}>
              重新分析
            </button>
          ) : null}
          <button type="button" className="btn primary" onClick={props.onClose}>
            完成
          </button>
        </div>
      }
    >
      <div className="ai-tags">
        {state.error ? (
          <div className="ai-error-bar">
            <span>{state.error}</span>
            <button type="button" className="btn sm" onClick={restart}>
              重试
            </button>
          </div>
        ) : isRunning(state) ? (
          <p className="ai-busy">正在读这篇笔记，想标签和分类…</p>
        ) : state.stopped ? (
          <div className="ai-stop-bar">
            <span>已停止生成，这一次没拿到完整的标签结果。</span>
            <button type="button" className="btn sm" onClick={restart}>
              重新分析
            </button>
          </div>
        ) : !suggestion ? (
          <div className="ai-error-bar">
            <span>AI 的回复里没找到标签，再试一次吧</span>
            <button type="button" className="btn sm" onClick={restart}>
              重试
            </button>
          </div>
        ) : (
          <>
            <div className="ai-block">
              <div className="ai-block-head">建议的标签（点一下加进笔记）</div>
              <div className="ai-chips">
                {suggestion.tags.length === 0 ? (
                  <span className="ai-tip">这次没给出合适的标签</span>
                ) : (
                  suggestion.tags.map((name) => {
                    const isAdded = added.includes(name) || props.tags.includes(name);
                    return (
                      <button
                        key={name}
                        type="button"
                        className={isAdded ? 'ai-chip on ai-tag-chip' : 'ai-chip ai-tag-chip'}
                        disabled={isAdded}
                        title={isAdded ? '已经在这个笔记上了' : '点一下加进笔记'}
                        onClick={() => addTag(name)}
                      >
                        {isAdded ? '✓ ' : '+ '}
                        {name}
                      </button>
                    );
                  })
                )}
              </div>
            </div>
            <div className="ai-block">
              <div className="ai-block-head">建议的分类</div>
              {suggestion.category ? (
                <div className="ai-cat-row">
                  <span className="ai-cat-name ai-cat-suggest">{suggestion.category}</span>
                  <button
                    type="button"
                    className="btn sm"
                    onClick={() => {
                      if (props.onApplyCategory(suggestion.category as string)) {
                        toast(`已移动到分类「${suggestion.category}」`);
                      }
                    }}
                  >
                    移到这个分类
                  </button>
                </div>
              ) : (
                <span className="ai-tip">这篇笔记不太像现有的任何分类，可以先不动</span>
              )}
            </div>
            {suggestion.reason ? <p className="ai-tip">为什么：{suggestion.reason}</p> : null}
          </>
        )}
      </div>
    </Modal>
  );
}

/** 知识联想：列几个值得往下想的点，每条能复制或直接新建笔记。 */
export function AiRelatedModal(props: {
  title: string;
  noteText: string;
  onNewNote: (item: AiRelatedItem) => void | Promise<void>;
  onClose: () => void;
}): ReactNode {
  const { state, start, cancel } = useAiRun();
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void start({ action: 'related', noteText: clampAiText(props.noteText), title: props.title });
  }, [start, props.noteText, props.title]);

  const items: AiRelatedItem[] | null = useMemo(() => {
    if (!state.done || state.error) return null;
    try {
      return parseRelatedItems(state.text);
    } catch {
      return null;
    }
  }, [state.done, state.error, state.text]);

  const restart = (): void => {
    void start({ action: 'related', noteText: clampAiText(props.noteText), title: props.title });
  };

  const copy = (item: AiRelatedItem): void => {
    void api
      .copyText(`${item.title}\n${item.detail}`)
      .then(() => toast('已复制这条联想'));
  };

  return (
    <Modal
      title="AI 知识联想"
      variant="ai-related"
      width={640}
      onClose={props.onClose}
      footer={
        <div className="ai-foot">
          <span className="spacer" style={{ flex: 1 }} />
          {isRunning(state) ? <AiStop onStop={cancel} /> : null}
          {state.done && !state.error ? (
            <button type="button" className="btn" onClick={restart}>
              换一批
            </button>
          ) : null}
          <button type="button" className="btn primary" onClick={props.onClose}>
            完成
          </button>
        </div>
      }
    >
      <div className="ai-related">
        {state.error ? (
          <div className="ai-error-bar">
            <span>{state.error}</span>
            <button type="button" className="btn sm" onClick={restart}>
              重试
            </button>
          </div>
        ) : isRunning(state) ? (
          <p className="ai-busy">正在找相关的问题和知识点…</p>
        ) : state.stopped ? (
          <div className="ai-stop-bar">
            <span>已停止生成，这一次没拿到完整的联想结果。</span>
            <button type="button" className="btn sm" onClick={restart}>
              重新分析
            </button>
          </div>
        ) : !items ? (
          <div className="ai-error-bar">
            <span>AI 的回复里没找到能看的联想，再试一次吧</span>
            <button type="button" className="btn sm" onClick={restart}>
              重试
            </button>
          </div>
        ) : (
          <ul className="ai-related-list">
            {items.map((item, index) => (
              <li key={item.title + index} className="ai-related-item">
                <div className="ai-related-txt">
                  <b>{item.title}</b>
                  <p>{item.detail}</p>
                </div>
                <div className="ai-related-ops">
                  <button type="button" className="btn sm" onClick={() => copy(item)}>
                    复制
                  </button>
                  <button
                    type="button"
                    className="btn sm primary"
                    title="在当前分类下新建一篇笔记并打开"
                    onClick={() => void props.onNewNote(item)}
                  >
                    新建笔记
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
        <p className="ai-tip">「新建笔记」会用当前笔记的分类，并直接把新笔记打开。</p>
      </div>
    </Modal>
  );
}

/** 第一次用 AI 之前的隐私确认：说清楚会把内容发给第三方。 */
export function AiPrivacyModal(props: {
  baseUrl: string;
  model: string;
  onAgree: () => void;
  onCancel: () => void;
}): ReactNode {
  return (
    <Modal
      title="用 AI 之前，先说清楚一件事"
      variant="ai-privacy"
      width={560}
      onClose={props.onCancel}
      footer={
        <div className="ai-foot">
          <span className="spacer" style={{ flex: 1 }} />
          <button type="button" className="btn" onClick={props.onCancel}>
            先不用
          </button>
          <button type="button" className="btn primary ai-privacy-agree" onClick={props.onAgree}>
            我知道，开始用
          </button>
        </div>
      }
    >
      <div className="ai-privacy">
        <p>
          AI 功能需要把<strong>选中的文字</strong>或<strong>整篇笔记的正文</strong>发给你配置的模型服务（
          {props.baseUrl || '还没填地址'} · {props.model || '还没填模型'}）。
        </p>
        <ul>
          <li>请求由本机主进程直接发出，不经过任何中间服务器。</li>
          <li>API Key 只存在本机的设置里（系统支持时会加密），不会出现在界面上，也不会写进日志。</li>
          <li>不想用的时候随时可以关掉 AI，或者清空 Key —— 本地笔记、搜索、复习都不受影响。</li>
        </ul>
        <p className="ai-tip">确认一次就够了，之后可以在「设置 → AI 模型」里重新关掉。</p>
      </div>
    </Modal>
  );
}
