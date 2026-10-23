import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { TIMING } from '../timing';
import { api, pathForFile } from '../api';
import { ConfirmDialog, Empty, Modal, toast } from '../ui';
import { showContextMenu, type MenuItem } from '../menu';
import { relative } from '../format';
import { diffLines, renderMarkdown } from '../../../shared/markdown';
import { attachmentUrl, escapeHtml, htmlToPlainText, sanitizeHtml } from '../../../shared/html';
import { findQuoteRanges, takeAround } from '../../../shared/locate';
import {
  buildTextMap,
  capRanges,
  clearHighlights,
  highlightRanges,
  rangesFromOffsets,
  scrollRangeIntoView,
  stripHighlights
} from '../dom-find';
import {
  AI_ACTION_LABELS,
  AI_DEFAULT_LANG,
  AI_QUICK_ACTIONS,
  AI_SUMMARY_CLASS,
  AI_TARGET_LANGS,
  type AiConfigPublic,
  type AiFullAction,
  type AiLangValue,
  type AiRelatedItem,
  type AiTextAction
} from '../../../shared/ai';
import {
  AiBubble,
  AiPreviewModal,
  AiPrivacyModal,
  AiRelatedModal,
  AiSummaryModal,
  AiTagsModal
} from '../ai';
import * as rich from '../rich';
import { describeSaveError, saveStamp } from '../save';
import { applyOrder, moveWithinGroup } from '../reorder';
import RelatedNotes from '../RelatedNotes';
import AiChatDrawer from '../AiChatDrawer';
import AiExtractDocModal from '../AiExtractDocModal';
import type { SearchHit } from '../../../shared/types';
import type { Attachment, Category, Id, Note, NoteListItem, NoteVersion, Tag } from '../../../shared/types';import { toastError, errText } from '../errors';

type NoteDetail = Note & { tags: Tag[]; attachments: Attachment[] };
type CatSel = Id | 'all' | 'unassigned' | 'trash';

/**
 * 「✨ AI」下拉菜单的换肤钩子：交给 menu.tsx 挂在菜单面板上，
 * 对应的样式全部收在 styles.css 的 .ctx-menu.ai-dropdown 里（其它右键菜单不受影响）。
 */
const AI_MENU_CLASS = 'ai-dropdown';

/** 没有搜索直达时用：保持 Hook 依赖稳定。 */
const noopLocateConsume = (): void => undefined;

/** 字数按纯文字算：HTML 标签不算字。 */
function countLocal(html: string): number {
  return htmlToPlainText(html).replace(/\s/g, '').length;
}

/* ---------------- 0.12.3：搜索直达（本地秒级兜底 + AI 异步纠偏） ----------------
   契约：
   1. 本地先按用户原始 Query 高亮滚动，0 延迟给反馈；
   2. 随后 ai:locate（总 8s）拿 AI 引文替换高亮；
   3. 切笔记 / 换搜索立刻 abort 上一单，回调前再比对 openId，防串台；
   4. 高亮优先走 CSS Custom Highlight（零 DOM 变更），不支持才用 <mark> 兜底。 */

/** 搜索语法（tag:/is:）不是要定位的文字，本地匹配前先剥掉。 */
function locateableQuery(raw: string): string {
  return raw.replace(/\b(?:tag|is):\S+/gi, ' ').replace(/\s+/g, ' ').trim();
}

/** 滚动居中 + 把焦点和光标放到命中位置附近。 */
function focusRange(editor: HTMLDivElement, range: Range): void {
  const body = editor.closest('.editor-body');
  if (body instanceof HTMLElement) scrollRangeIntoView(range, body);
  try {
    editor.focus({ preventScroll: true });
  } catch {
    editor.focus();
  }
  const sel = window.getSelection();
  if (!sel) return;
  const caret = range.cloneRange();
  caret.collapse(true);
  sel.removeAllRanges();
  sel.addRange(caret);
}

interface LocateHookOptions {
  editor: { current: HTMLDivElement | null };
  locateQuery: string | null;
  openId: Id | null;
  editorEpoch: number;
  onConsumed: () => void;
}

function useLocateHighlight(options: LocateHookOptions): void {
  const { editor, locateQuery, openId, editorEpoch, onConsumed } = options;
  const seqRef = useRef(0);
  const requestRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const activeIdRef = useRef<Id | null>(null);
  activeIdRef.current = openId;

  useEffect(() => {
    const query = locateableQuery(locateQuery ?? '');
    if (!query || openId == null) return;
    const el = editor.current;
    if (!el) return;

    const seq = seqRef.current + 1;
    seqRef.current = seq;
    // 换笔记 / 新搜索：先取消上一单（真的 abort 主进程请求），再清旧高亮
    abortRef.current?.abort();
    abortRef.current = null;
    clearHighlights(el);

    // ① 本地秒级兜底：不等待 AI，先按原始 Query 定位
    const localMap = buildTextMap(el);
    const localSpans = findQuoteRanges(localMap.text, query);
    let anchor = query;
    if (localSpans.length) {
      anchor = localMap.text.slice(localSpans[0].start, localSpans[0].end);
      const localRanges = capRanges(rangesFromOffsets(localMap, localSpans));
      highlightRanges(localRanges, el);
      if (localRanges[0]) focusRange(el, localRanges[0]);
    }

    // ② AI 异步纠偏：只发命中附近的一个窗口，失败/超时静默降级
    const controller = new AbortController();
    abortRef.current = controller;
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    controller.signal.addEventListener('abort', () => {
      void api.aiLocateCancel(requestId);
    });

    let settled = false;
    const consume = (): void => {
      if (settled) return;
      settled = true;
      onConsumed();
    };

    const around = takeAround(localMap.text, anchor);
    void api
      .aiLocate({ requestId, query, text: around.text })
      .then((result) => {
        if (controller.signal.aborted) return;
        if (seqRef.current !== seq) return;
        if (activeIdRef.current !== openId) return;
        const quote = String(result?.quote ?? '').trim();
        if (!quote) return;
        const current = editor.current;
        if (!current) return;
        const fresh = buildTextMap(current);
        const spans = findQuoteRanges(fresh.text, quote);
        if (!spans.length) return;
        const ranges = capRanges(rangesFromOffsets(fresh, spans));
        if (!ranges.length) return;
        clearHighlights(current);
        highlightRanges(ranges, current);
        focusRange(current, ranges[0]);
      })
      .catch(() => undefined)
      .finally(() => {
        // 只有"当前这一单"才回传 onConsumed：切笔记后旧单的 finally 不能把新搜索清掉
        if (seqRef.current === seq) consume();
      });

    return () => {
      controller.abort();
      if (abortRef.current === controller) abortRef.current = null;
    };
    // onConsumed 用 useCallback 稳定引用；这里显式列出其余依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locateQuery, openId, editorEpoch, onConsumed]);
}

export default function Knowledge(props: {
  openNoteId: Id | null;
  clearOpenNote: () => void;
  refreshCount: () => void;
  /** 0.12.3：从搜索结果点进来时带上的原始 Query（只对这一次打开生效） */
  locateQuery?: string | null;
  onLocateConsumed?: () => void;
}): ReactNode {
  const [cats, setCats] = useState<Category[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [sel, setSel] = useState<CatSel>('all');
  const [tagId, setTagId] = useState<Id | null>(null);
  const [q, setQ] = useState('');
  const [list, setList] = useState<NoteListItem[]>([]);
  const [dragId, setDragId] = useState<Id | null>(null);
  const [dropAt, setDropAt] = useState<{ id: Id; after: boolean } | null>(null);
  /** 刚落位的卡片：40ms 内挂 .drop-settling，让它弹一下再归位（第五版阶段3） */
  const [settlingId, setSettlingId] = useState<Id | null>(null);
  // 搜索或按标签筛出来的是一小撮子集，这时候拖动排序没有意义，关掉
  const canReorder = sel !== 'trash' && !q.trim() && tagId === null;
  const [openId, setOpenId] = useState<Id | null>(null);
  const [note, setNote] = useState<NoteDetail | null>(null);
  const [title, setTitle] = useState('');
  /**
   * 正文是富文本 HTML。改得很频繁，所以放在 ref 里，
   * 只有换笔记 / 恢复草稿时才把它推进编辑器（见 editorEpoch），避免每次敲键都重渲染整页。
   */
  const htmlRef = useRef('');
  const editorRef = useRef<HTMLDivElement | null>(null);
  const imageInput = useRef<HTMLInputElement | null>(null);
  const [editorEpoch, setEditorEpoch] = useState(0);
  const [wordCount, setWordCount] = useState(0);
  const [previewHtml, setPreviewHtml] = useState('');
  const [mode, setMode] = useState<'edit' | 'preview'>('edit');
  const [saveState, setSaveState] = useState<'saved' | 'dirty' | 'saving' | 'error'>('saved');
  const [savedFlash, setSavedFlash] = useState(false);
  const [draftPrompt, setDraftPrompt] = useState<{ title: string; content: string } | null>(null);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [tagText, setTagText] = useState('');
  const [newCatName, setNewCatName] = useState('');
  const [addingCat, setAddingCat] = useState(false);
  const [dropTarget, setDropTarget] = useState<CatSel | null>(null);
  /** 有文件被拖到编辑区上方时，显示一条接收提示 */
  const [fileHover, setFileHover] = useState(false);
  /** 工具栏：颜色面板 / 插图 / 表格 / 当前光标格式 */
  const [colorOpen, setColorOpen] = useState<'text' | 'bg' | null>(null);
  const [tableOpen, setTableOpen] = useState(false);
  const [tableSize, setTableSize] = useState({ rows: 3, cols: 3 });
  const [fmt, setFmt] = useState({ inTable: false, bold: false, italic: false, underline: false });
  /**
   * 「移到回收站」前的二次确认：存要挪走的笔记 id。
   * 产品规则：不提供逐条物理删除，物理删除只走「清空回收站」（以及回收站满 30 天自动清）。
   */
  const [confirmTrash, setConfirmTrash] = useState<Id | null>(null);
  const [confirmEmpty, setConfirmEmpty] = useState(false);
  const [confirmCatDel, setConfirmCatDel] = useState<Category | null>(null);
  /** 改名 / 新建子分类的输入框（Electron 里没有 window.prompt，必须自己做） */
  const [promptFor, setPromptFor] = useState<{ kind: 'rename' | 'child'; cat: Category; value: string } | null>(
    null
  );
  const [tagFilterOpen, setTagFilterOpen] = useState(false);

  /* 标签全局管理：左侧展开式列表 + 改名 / 删除两个确认框 */
  const [tagsOpen, setTagsOpen] = useState(false);
  const [tagRename, setTagRename] = useState<{ tag: Tag; value: string } | null>(null);
  const [tagDelete, setTagDelete] = useState<Tag | null>(null);

  /* ---------------- 0.12.0 阶段3：编辑器底部「🧠 相关笔记」 ---------------- */
  const [related, setRelated] = useState<SearchHit[]>([]);
  const [relatedLoading, setRelatedLoading] = useState(false);
  /** 请求序号：切笔记/关笔记时作废旧请求，防止旧结果写进新笔记的面板 */
  const relatedSeq = useRef(0);
  /** 闭包防串台：回调里比对「当前打开的是不是发起请求时那篇」 */
  const relatedNoteRef = useRef<Id | null>(null);

  /* ---------------- 0.12.0 阶段4：AI 对话侧边栏 ---------------- */
  const [chatOpen, setChatOpen] = useState(false);

  /* ---------------- 第七版：AI 辅助（0.7.0） ----------------
   * 划词气泡只做「选动作 + 选目标语言」；真正的请求、对比、替换都交给弹窗。
   * API Key 不在渲染层：这里只拿 AiConfigPublic（hasKey/keyHint），请求全走主进程。
   */
  const [aiBubble, setAiBubble] = useState<{
    text: string;
    left: number;
    top: number;
    range: Range;
  } | null>(null);
  const [aiLang, setAiLang] = useState<AiLangValue>(AI_DEFAULT_LANG);
  const [aiPreview, setAiPreview] = useState<{
    action: AiTextAction;
    source: string;
    range: Range | null;
  } | null>(null);
  const [aiFull, setAiFull] = useState<AiFullAction | null>(null);
  const [aiPrivacy, setAiPrivacy] = useState<{
    baseUrl: string;
    model: string;
    resolve: (ok: boolean) => void;
  } | null>(null);
  /** 上次读到的主进程侧配置（设置页改过之后可以再读一次） */
  const aiConfigRef = useRef<AiConfigPublic | null>(null);
  /** 分类整理里连续点标签时，用 ref 记住「已经加过的」，避免和 note.tags 的异步刷新打架 */
  const aiPendingTags = useRef<string[]>([]);

  const draftTimer = useRef<number | null>(null);
  const wordTimer = useRef<number | null>(null);
  /** 「已保存」闪标的定时器：连点保存时先清旧的，别让旧定时器把新状态提前关掉 */
  const savedFlashTimer = useRef(0);
  /** touchBody 定义在 scheduleDraft 之前，用 ref 转一手避免顺序问题 */
  const scheduleDraftRef = useRef<(() => void) | null>(null);
  const stateRef = useRef({ title: '', html: '', id: null as Id | null });
  stateRef.current = { title, html: htmlRef.current, id: openId };

  /* ---------------- 编辑器与正文 ---------------- */

  /** 把一段 HTML 放进编辑器：换笔记、恢复草稿、回滚版本都走这里。 */
  const putIntoEditor = useCallback((html: string, nextTitle?: string) => {
    const clean = sanitizeHtml(html);
    // 换文档前先把上一轮定位高亮清掉（mark 兜底路径尤其要清，别把标签抄进新正文）
    clearHighlights();
    htmlRef.current = clean;
    setPreviewHtml(clean);
    setWordCount(countLocal(clean));
    if (nextTitle != null) setTitle(nextTitle);
    setEditorEpoch((n) => n + 1);
  }, []);

  /** 正文被改动：标脏、排草稿、慢一点再更新字数（不整页重渲染）。 */
  const touchBody = useCallback(() => {
    const el = editorRef.current;
    if (el) {
      // 0.12.3：<mark> 兜底高亮绝不能被 htmlRef 抄走 → 先拆标签再读 HTML
      stripHighlights(el);
      htmlRef.current = el.innerHTML;
    }
    setSaveState('dirty');
    scheduleDraftRef.current?.();
    if (wordTimer.current) window.clearTimeout(wordTimer.current);
    wordTimer.current = window.setTimeout(() => setWordCount(countLocal(htmlRef.current)), TIMING.wordCountIdle);
  }, []);

  /** 只在换笔记 / 恢复草稿后把 ref 里的 HTML 推进编辑器；平时让它自己管，光标才不会跳。 */
  useEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    if (el.innerHTML !== htmlRef.current) el.innerHTML = htmlRef.current;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editorEpoch, openId]);

  /* 0.12.3 搜索直达：必须排在「把 HTML 推进编辑器」的 effect 之后，
     这样本地定位拿到的一定是已经渲染完成的 DOM。 */
  useLocateHighlight({
    editor: editorRef,
    locateQuery: props.locateQuery ?? null,
    openId,
    editorEpoch,
    onConsumed: props.onLocateConsumed ?? noopLocateConsume
  });

  /** 光标位置变了就更新工具栏状态（选中文字时加粗按钮亮不亮、光标在不在表格里）。 */
  useEffect(() => {
    const onSel = () => {
      const next = {
        inTable: rich.inTable(),
        bold: rich.stateOf('bold'),
        italic: rich.stateOf('italic'),
        underline: rich.stateOf('underline')
      };
      setFmt((prev) =>
        prev.inTable === next.inTable &&
        prev.bold === next.bold &&
        prev.italic === next.italic &&
        prev.underline === next.underline
          ? prev
          : next
      );
    };
    document.addEventListener('selectionchange', onSel);
    return () => document.removeEventListener('selectionchange', onSel);
  }, []);

  /**
   * 第七版：选中正文里的一段文字就浮出 AI 气泡。
   * 只在编辑态显示、只认编辑器里的选区；气泡本身用 onMouseDown preventDefault，不会把选区弄丢。
   */
  useEffect(() => {
    if (mode !== 'edit' || openId == null) {
      setAiBubble(null);
      return;
    }
    const onSel = () => {
      const el = editorRef.current;
      const sel = window.getSelection();
      if (!el || !sel || sel.rangeCount === 0 || sel.isCollapsed) {
        setAiBubble(null);
        return;
      }
      const range = sel.getRangeAt(0);
      if (!el.contains(range.commonAncestorContainer)) {
        setAiBubble(null);
        return;
      }
      const text = sel.toString().trim();
      if (!text) {
        setAiBubble(null);
        return;
      }
      const rect = range.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
        setAiBubble(null);
        return;
      }
      const next = {
        text,
        left: Math.max(150, Math.min(window.innerWidth - 150, rect.left + rect.width / 2)),
        top: Math.min(window.innerHeight - 120, rect.bottom + 8),
        range: range.cloneRange()
      };
      setAiBubble((prev) =>
        prev &&
        prev.text === next.text &&
        Math.abs(prev.left - next.left) < 2 &&
        Math.abs(prev.top - next.top) < 2
          ? prev
          : next
      );
    };
    document.addEventListener('selectionchange', onSel);
    return () => document.removeEventListener('selectionchange', onSel);
  }, [mode, openId]);

  useEffect(
    () => () => {
      if (wordTimer.current) window.clearTimeout(wordTimer.current);
    },
    []
  );

  /* ---------------- 读取 ---------------- */

  const loadCats = useCallback(() => {
    api
      .categoryTree()
      .then(setCats)
      .catch((err) => toastError('读取分类失败：', err));
  }, []);

  const loadTags = useCallback(() => {
    api.listTags().then(setTags).catch(() => undefined);
  }, []);

  const loadList = useCallback(() => {
    const filter =
      sel === 'trash'
        ? { trash: true as const }
        : {
            categoryId: sel === 'all' ? undefined : sel === 'unassigned' ? null : sel,
            tagId: tagId ?? undefined,
            limit: 400
          };
    return api
      .listNotes(filter)
      .then((rows) => {
        const key = q.trim().toLowerCase();
        setList(
          key
            ? rows.filter(
                (r) => r.title.toLowerCase().includes(key) || r.excerpt.toLowerCase().includes(key)
              )
            : rows
        );
      })
      .catch((err) => toastError('读取笔记失败：', err));
  }, [sel, tagId, q]);

  useEffect(() => {
    loadCats();
    loadTags();
  }, [loadCats, loadTags]);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  useEffect(() => {
    if (props.openNoteId != null) {
      setOpenId(props.openNoteId);
      props.clearOpenNote();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.openNoteId]);

  const openNote = useCallback((id: Id) => {
    setOpenId(id);
    api
      .getNote(id)
      .then((full) => {
        if (!full) {
          toast('这篇笔记已经不在了');
          return;
        }
        setNote(full);
        // 老笔记没有富文本正文，就用 Markdown 现场转一份出来显示
        putIntoEditor(full.content_html || renderMarkdown(full.content), full.title);
        setTagText(full.tags.map((t) => t.name).join(', '));
        setSaveState('saved');
        setMode('edit');
        const draft = full.draft_content;
        if (draft != null && draft !== full.content_html) {
          setDraftPrompt({ title: full.draft_title ?? full.title, content: draft });
        } else {
          setDraftPrompt(null);
        }
      })
      .catch((err) => toastError('打开笔记失败：', err));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (openId != null) openNote(openId);
    else setNote(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openId]);

  /* 0.12.0 阶段3：切笔记就重新拉「相关笔记」；旧请求回来先比 noteId 再比序号，不一致直接丢弃。 */
  useEffect(() => {
    relatedNoteRef.current = openId;
    if (openId == null) {
      relatedSeq.current += 1;
      setRelated([]);
      setRelatedLoading(false);
      return;
    }
    const seq = relatedSeq.current + 1;
    relatedSeq.current = seq;
    setRelated([]);
    setRelatedLoading(true);
    const timer = window.setTimeout(() => {
      api
        .relatedNotes(openId, 6)
        .then((list) => {
          if (relatedNoteRef.current !== openId) return;
          if (relatedSeq.current !== seq) return;
          setRelated(list);
        })
        .catch(() => {
          if (relatedNoteRef.current !== openId) return;
          if (relatedSeq.current !== seq) return;
          setRelated([]);
        })
        .finally(() => {
          if (relatedNoteRef.current === openId && relatedSeq.current === seq) setRelatedLoading(false);
        });
    }, 280);
    return () => {
      window.clearTimeout(timer);
      if (relatedSeq.current === seq) relatedSeq.current += 1;
    };
  }, [openId]);

  /* ---------------- 草稿与手动保存 ---------------- */

  const scheduleDraft = useCallback(() => {
    if (draftTimer.current) window.clearTimeout(draftTimer.current);
    draftTimer.current = window.setTimeout(() => {
      const { id, title: t } = stateRef.current;
      if (id == null) return;
      // 存草稿前再兜一道：降级路径的 <mark> 不允许进 draft_content
      if (editorRef.current) stripHighlights(editorRef.current);
      void api.saveDraft(id, t, htmlRef.current).catch(() => undefined);
    }, TIMING.draftIdle);
  }, []);
  scheduleDraftRef.current = scheduleDraft;

  const manualSave = useCallback(async () => {
    const id = stateRef.current.id;
    if (id == null) return;
    // 0.12.3：保存前清场，保证 <mark class="jw-hit"> 永远进不了 SQLite
    if (editorRef.current) {
      stripHighlights(editorRef.current);
      htmlRef.current = editorRef.current.innerHTML;
    }
    setSaveState('saving');
    try {
      const res = await api.saveNote(
        id,
        stateRef.current.title,
        { html: htmlRef.current },
        '手动保存'
      );
      setSaveState('saved');
      setSavedFlash(true);
      window.clearTimeout(savedFlashTimer.current);
      savedFlashTimer.current = window.setTimeout(() => setSavedFlash(false), TIMING.savedFlash);
      setNote((prev) =>
        prev && res.note ? { ...res.note, tags: prev.tags, attachments: prev.attachments } : prev
      );
      setDraftPrompt(null);
      void loadList();
      void loadTags();
      toast('已保存 ' + saveStamp());
    } catch (err) {
      setSaveState('error');
      toast(describeSaveError(err), { ttl: 7000 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadList, loadTags]);

  // 「已保存」闪标的定时器归这个组件所有：切页 / 关笔记时清掉，别让旧定时器在卸载后还 setState。
  useEffect(() => {
    return () => {
      window.clearTimeout(savedFlashTimer.current);
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void manualSave();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [manualSave]);

  useEffect(
    () => () => {
      if (draftTimer.current) window.clearTimeout(draftTimer.current);
    },
    []
  );

  /** 只刷新附件列表，不动正文（正文有没保存的改动时，重载会把它冲掉）。 */
  const refreshAttachments = useCallback(async (id: Id) => {
    try {
      const full = await api.getNote(id);
      if (full) {
        setNote((prev) => (prev && prev.id === id ? { ...prev, attachments: full.attachments } : prev));
      }
    } catch {
      /* 刷不到就算了，不影响编辑 */
    }
  }, []);

  /** 只刷新这篇笔记的标签区，不动正文（理由同上）。 */
  const refreshNoteTags = useCallback(async (id: Id) => {
    try {
      const full = await api.getNote(id);
      if (full) {
        setNote((prev) => (prev && prev.id === id ? { ...prev, tags: full.tags } : prev));
        setTagText(full.tags.map((t) => t.name).join(', '));
      }
    } catch {
      /* 刷不到就算了，不影响编辑 */
    }
  }, []);

  /* ---------------- 标签全局管理 ---------------- */

  const submitTagRename = async (): Promise<void> => {
    const job = tagRename;
    if (!job) return;
    const name = job.value.trim();
    if (!name) {
      toast('标签名不能为空');
      return;
    }
    setTagRename(null);
    try {
      const res = await api.renameTag(job.tag.id, name);
      // 撞名合并时标签 id 会变，选中的得跟着换到合并后的那个
      if (tagId === job.tag.id) setTagId(res.tag.id);
      void loadTags();
      void loadList();
      if (openId != null) void refreshNoteTags(openId);
      toast(
        res.merged
          ? `已合并到「${res.tag.name}」，影响 ${res.affected} 篇笔记`
          : `标签已改名为「${res.tag.name}」，影响 ${res.affected} 篇笔记`
      );
    } catch (err) {
      toastError('改标签名失败：', err);
    }
  };

  const doDeleteTag = async (tag: Tag): Promise<void> => {
    setTagDelete(null);
    try {
      const res = await api.deleteTag(tag.id);
      if (tagId === tag.id) setTagId(null);
      void loadTags();
      void loadList();
      if (openId != null) void refreshNoteTags(openId);
      toast(`标签「${res.name}」已删除，${res.affected} 篇笔记的关联已解除（笔记都还在）`);
    } catch (err) {
      toastError('删除标签失败：', err);
    }
  };

  /**
   * 把拖进来的文件复制成附件。渲染层只有 File 对象，
   * 绝对路径得让 preload 用 webUtils.getPathForFile 换出来。
   */
  const attachFiles = useCallback(
    async (files: File[]) => {
      const id = stateRef.current.id;
      if (id == null || files.length === 0) return;
      let ok = 0;
      for (const file of files) {
        const src = pathForFile(file);
        if (!src) {
          toast(`拿不到「${file.name}」的路径，请用「加附件」按钮选它`);
          continue;
        }
        try {
          await api.addAttachmentPath(id, src);
          ok += 1;
        } catch (err) {
          toastError(`「${file.name}」没加上：`, err);
        }
      }
      if (ok > 0) {
        toast(`已加上 ${ok} 个附件`);
        void refreshAttachments(id);
      }
    },
    [refreshAttachments]
  );

  /**
   * 插入图片：先把文件复制进数据目录的附件夹，再往正文里插一个 jw-att:// 的图。
   * 库里存的是相对路径，换电脑/换盘符都不会失效。
   */
  const insertImages = useCallback(
    async (files: File[]) => {
      const images = files.filter(
        (f) => f.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp)$/i.test(f.name)
      );
      if (images.length === 0) return;
      const id = stateRef.current.id;
      if (id == null) {
        toast('先选中或新建一篇笔记，再插图');
        return;
      }
      let ok = 0;
      for (const file of images) {
        const src = pathForFile(file);
        if (!src) {
          toast(`拿不到「${file.name}」的路径，试试点工具栏上的「插图」按钮选它`);
          continue;
        }
        try {
          const att = await api.addAttachmentPath(id, src);
          rich.insertImage(attachmentUrl(att.rel_path), att.file_name);
          ok += 1;
        } catch (err) {
          toastError(`「${file.name}」没插上：`, err);
        }
      }
      if (ok > 0) {
        touchBody();
        void refreshAttachments(id);
        toast(`已插入 ${ok} 张图（按 Ctrl+S 保存）`);
      }
    },
    [refreshAttachments, touchBody]
  );

  /** 一键把当前笔记变成一张复习卡（同一篇重复点不会生成第二张）。 */
  const makeCard = async (): Promise<void> => {
    const id = stateRef.current.id;
    if (id == null) return;
    try {
      const cardId = await api.reviewFromNote(id);
      toast(cardId ? '已经生成复习卡，去复习页就能看到' : '这篇笔记之前已经生成过卡片了');
    } catch (err) {
      toastError('生成失败：', err);
    }
  };

  /** 标题被改：只标脏 + 排草稿，正文交给编辑器自己。 */
  const touchTitle = (nextTitle: string) => {
    setTitle(nextTitle);
    setSaveState('dirty');
    scheduleDraft();
  };

  /* ---------------- 列表与分类操作 ---------------- */

  const createNote = async (): Promise<void> => {
    try {
      const created = await api.createNote({
        categoryId: typeof sel === 'number' ? sel : null,
        title: '',
        html: ''
      });
      if (created) {
        setSel(typeof sel === 'number' ? sel : 'all');
        await loadList();
        setOpenId(created.id);
      }
    } catch (err) {
      toastError('新建笔记失败：', err);
    }
  };

  const doMove = async (noteId: Id, categoryId: Id | null): Promise<void> => {
    try {
      await api.moveNote(noteId, categoryId);
      await loadList();
      await loadCats();
      toast('已移动');
    } catch (err) {
      toastError('移动失败：', err);
    }
  };

  /**
   * 优化项 6：卡片拖动排序。
   * 只重排「被拖动那张所在的分类」里的笔记，别的分类（以及置顶/筛选后的顺序）不受影响——
   * 这就是「在某分类下排序只影响该分类」的落点。
   */
  const reorderTo = (draggedId: Id, targetId: Id, after: boolean): void => {
    const ids = moveWithinGroup(list, draggedId, targetId, after);
    if (!ids) return;
    // 先在本地摆好，拖动松手就能看到效果，再落库
    setList((prev) => applyOrder(prev, ids));
    // 第五版阶段3：落位的那张弹一下（CSS 弹簧曲线），400ms 后摘掉类
    setSettlingId(draggedId);
    window.setTimeout(() => setSettlingId((cur) => (cur === draggedId ? null : cur)), TIMING.dragSettle);
    void api
      .reorderNotes(ids)
      .then(() => loadList())
      .catch((err) => toastError('排序保存失败：', err));
  };

  /**
   * 第五版阶段3：拖动时给指针一份「拿起来的卡片」影像（倾斜 + 重阴影），
   * 比 Chromium 默认那层灰糊糊的截图更跟手。不支持就悄悄退回默认。
   */
  const liftDragImage = (row: HTMLElement, dt: DataTransfer): void => {
    try {
      const box = row.getBoundingClientRect();
      const ghost = row.cloneNode(true) as HTMLElement;
      ghost.classList.add('drag-ghost');
      ghost.style.width = `${box.width}px`;
      document.body.appendChild(ghost);
      dt.setDragImage(ghost, 26, Math.min(box.height - 2, Math.max(14, box.height / 2)));
      window.setTimeout(() => ghost.remove(), 0);
    } catch {
      /* 自绘拖动影像不可用时（老环境 / 合成事件）就用系统默认的 */
    }
  };

  /** 优化项 7：分类排序——跟同一层的上/下一条换位（子分类各排各的）。 */
  const moveCat = async (cat: Category, dir: 'up' | 'down'): Promise<void> => {
    try {
      await api.moveCategory(cat.id, dir);
      await loadCats();
    } catch (err) {
      toastError('排序失败：', err);
    }
  };

  const trash = async (id: Id): Promise<void> => {
    try {
      await api.trashNote(id);
      if (openId === id) setOpenId(null);
      await loadList();
      await loadCats();
      toast('已放进回收站（保留 30 天）', {
        actionLabel: '撤销',
        onAction: async () => {
          await api.restoreNote(id);
          await loadList();
        }
      });
    } catch (err) {
      toastError('删除失败：', err);
    }
  };

  /** 删分类：确认框只给「含子内容」的分类；其它直接删，靠 5 秒撤销兜底。 */
  const doDeleteCategory = async (cat: Category): Promise<void> => {
    try {
      await api.deleteCategory(cat.id);
      if (sel === cat.id) setSel('all');
      loadCats();
      loadList();
      props.refreshCount();
      toast(`分类「${cat.name}」已删除`, {
        actionLabel: '撤销',
        onAction: async () => {
          // 撤销只把分类本身建回来；笔记此时已经是「未分类」，需要用户自己再归类
          await api.createCategory(cat.parent_id, cat.name);
          loadCats();
          loadList();
          toast('分类已恢复，里面的笔记请在「未分类」里重新归类');
        }
      });
    } catch (err) {
      toastError('删除分类失败：', err);
    }
  };

  /** 改名 / 新建子分类的输入框提交 */
  const submitPrompt = async (): Promise<void> => {
    if (!promptFor) return;
    const name = promptFor.value.trim();
    if (!name) {
      toast('名字不能为空');
      return;
    }
    const job = promptFor;
    setPromptFor(null);
    try {
      if (job.kind === 'rename') await api.renameCategory(job.cat.id, name);
      else await api.createCategory(job.cat.id, name);
      loadCats();
      if (job.kind === 'rename') loadList();
    } catch (err) {
      toastError('操作失败：', err);
    }
  };

  const applyTags = async (names: string[]): Promise<void> => {
    if (openId == null) return;
    try {
      const updated = await api.setNoteTags(openId, names);
      setNote((prev) => (prev && updated ? { ...updated } : prev));
      setTagText(updated.tags.map((t) => t.name).join(', '));
      void loadTags();
      void loadList();
    } catch (err) {
      toastError('设置标签失败：', err);
    }
  };

  /* ---------------- 第七版：AI 的入口与落地动作 ---------------- */

  /** 取当前正文里选中的 Range（工具栏菜单打开时用）。 */
  const currentSelectionRange = (): Range | null => {
    const el = editorRef.current;
    const sel = window.getSelection();
    if (!el || !sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    if (!el.contains(range.commonAncestorContainer)) return null;
    return sel.toString().trim() ? range.cloneRange() : null;
  };

  const notePlainText = (): string => htmlToPlainText(htmlRef.current);

  /**
   * 用 AI 之前先确认两件事：配置齐不齐、用户知不知道内容会发给第三方。
   * 返回 null 表示这次不继续（原因已经用 toast / 弹窗说清楚了）。
   */
  const ensureAiReady = async (): Promise<boolean> => {
    let cfg = aiConfigRef.current;
    if (!cfg) {
      try {
        cfg = await api.aiGetConfig();
        aiConfigRef.current = cfg;
      } catch (err) {
        toastError('读取 AI 设置失败：', err);
        return false;
      }
    }
    if (!cfg.hasKey || !cfg.baseUrl.trim() || !cfg.model.trim()) {
      toast('还没配好 AI：去「设置 → AI 模型」填地址、模型名和 Key');
      return false;
    }
    if (!cfg.privacyAck) {
      const readyCfg = cfg;
      const agreed = await new Promise<boolean>((resolve) => {
        setAiPrivacy({ baseUrl: readyCfg.baseUrl, model: readyCfg.model, resolve });
      });
      if (!agreed) return false;
      try {
        cfg = await api.aiSetConfig({ privacyAck: true });
        aiConfigRef.current = cfg;
      } catch (err) {
        toastError('保存 AI 设置失败：', err);
        return false;
      }
    }
    return true;
  };

  /** 打开划词预览：气泡和工具栏菜单都走这里。确认之前一个字都不写回正文。 */
  const openAiText = (action: AiTextAction, source?: string, range?: Range | null): void => {
    const text = (source ?? aiBubble?.text ?? '').trim();
    const target = range ?? aiBubble?.range ?? currentSelectionRange();
    if (!text) {
      toast('先在正文里选中一段文字，再用 AI');
      return;
    }
    setAiBubble(null);
    setAiPreview({ action, source: text.slice(0, 4000), range: target ? target.cloneRange() : null });
  };

  /** 用户在弹窗里点了「确认替换」，才把结果写回刚选中的位置。 */
  const replaceSelectionWithAi = (text: string): void => {
    const job = aiPreview;
    if (!job) return;
    const editor = editorRef.current;
    if (!editor || !job.range || !editor.contains(job.range.commonAncestorContainer)) {
      toast('刚才的选区已经不在了，重新选中再试一次');
      return;
    }
    const html = escapeHtml(text).replace(/\r\n/g, '\n').replace(/\n/g, '<br/>');
    editor.focus();
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(job.range);
    rich.exec('insertHTML', html);
    setAiPreview(null);
    setAiBubble(null);
    touchBody();
    toast('已替换，不满意可以 Ctrl+Z 撤销');
  };

  /** 摘要：以「引用块」一次性插到开头，原生撤销栈里是一整块。 */
  const insertAiSummary = (text: string): void => {
    const editor = editorRef.current;
    if (!editor) return;
    setMode('edit');
    const quote =
      `<blockquote class="${AI_SUMMARY_CLASS}"><b>AI 摘要</b><br/>` +
      escapeHtml(text).replace(/\r\n/g, '\n').replace(/\n/g, '<br/>') +
      '</blockquote><p><br/></p>';
    editor.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.setStart(editor, 0);
    range.collapse(true);
    sel?.removeAllRanges();
    sel?.addRange(range);
    rich.exec('insertHTML', quote);
    touchBody();
  };

  /** 撤销刚插入的摘要：优先用编辑器原生撤销（一步撤掉整块），不行再手动摘掉。 */
  const undoAiSummary = (): boolean => {
    const editor = editorRef.current;
    if (!editor) return false;
    editor.focus();
    document.execCommand('undo');
    const first = editor.firstElementChild;
    if (first && first.classList.contains(AI_SUMMARY_CLASS)) first.remove();
    touchBody();
    return true;
  };

  /** 分类整理：点一下标签就加进笔记（连续点也不会互相覆盖）。 */
  const addAiTag = (name: string): void => {
    if (openId == null) return;
    const base = note?.tags.map((t) => t.name) ?? [];
    const next = Array.from(new Set([...base, ...aiPendingTags.current, name]));
    aiPendingTags.current = next;
    void applyTags(next);
  };

  /** 分类整理：把笔记挪到 AI 建议的分类（只认已存在的分类）。 */
  const applyAiCategory = (name: string): boolean => {
    const target = cats.find((c) => c.name.trim() === name.trim());
    if (!target) {
      toast(`没找到叫「${name}」的分类，先去左边建一个`);
      return false;
    }
    if (!note) return false;
    if (note.category_id === target.id) {
      toast('这篇已经在那个分类里了');
      return true;
    }
    void doMove(note.id, target.id);
    return true;
  };

  /** 知识联想 → 新建笔记：默认落进当前笔记的分类，然后直接把新笔记打开。 */
  const createNoteFromAi = async (item: AiRelatedItem): Promise<void> => {
    const catId = note?.category_id ?? (typeof sel === 'number' ? sel : null);
    try {
      const created = await api.createNote({
        categoryId: catId,
        title: item.title,
        html: item.detail ? `<p>${escapeHtml(item.detail)}</p>` : ''
      });
      if (!created) return;
      if (catId != null) setSel(catId);
      await loadList();
      setAiFull(null);
      setOpenId(created.id);
      toast('已新建笔记并打开');
    } catch (err) {
      toastError('新建笔记失败：', err);
    }
  };

  /** 全文动作的统一入口：先按当前正文快照做配置/隐私检查，再开弹窗。 */
  const startAiFull = async (action: AiFullAction): Promise<void> => {
    if (openId == null) return;
    if (!notePlainText().trim()) {
      toast('这篇笔记还没有正文，AI 没东西可读');
      return;
    }
    if (!(await ensureAiReady())) return;
    if (action === 'tags') aiPendingTags.current = [];
    setAiFull(action);
  };

  /** 工具栏「✨ AI」：划词四项（没选中时置灰）+ 全文三项。 */
  const openAiMenu = (e: ReactMouseEvent<HTMLElement>): void => {
    const hasSelection = !!currentSelectionRange();
    const items: MenuItem[] = AI_QUICK_ACTIONS.map((action) => ({
      label: AI_ACTION_LABELS[action],
      hint: action === 'translate' ? AI_TARGET_LANGS.find((l) => l.value === aiLang)?.label : undefined,
      disabled: !hasSelection,
      onSelect: () => openAiText(action)
    }));
    items.push({ label: '摘要（插到开头）', separator: true, onSelect: () => void startAiFull('summary') });
    items.push({ label: '分类整理', onSelect: () => void startAiFull('tags') });
    items.push({ label: '知识联想', onSelect: () => void startAiFull('related') });
    // 0.12.1：提炼成重点文档，确认后另存为新笔记（流程在 AiExtractDocModal 里）
    items.push({ label: '整理成重点文档', onSelect: () => void startAiFull('extract') });
    showContextMenu(e, items, { panelClass: AI_MENU_CLASS });
  };

  const tree = useMemo(() => buildTree(cats), [cats]);
  /** 工具栏「新建子分类」用：只有当前选中的是一个真分类时才能建子分类 */
  const selectedCat = useMemo(() => (typeof sel === 'number' ? cats.find((c) => c.id === sel) ?? null : null), [cats, sel]);
  const catName = useMemo(() => {
    if (sel === 'all') return '全部笔记';
    if (sel === 'unassigned') return '未分类';
    if (sel === 'trash') return '回收站';
    return cats.find((c) => c.id === sel)?.name ?? '笔记';
  }, [cats, sel]);

  /* ---------------- 渲染 ---------------- */

  return (
    <div className={'kb' + (chatOpen ? ' chat-open' : '')}>
      {/* 左栏：分类树 */}
      <div className="kb-tree" role="tree" aria-label="分类">
        <div className="row" style={{ marginBottom: 8 }}>
          <span className="muted" style={{ flex: 1, fontSize: 12 }}>
            分类
          </span>
          <button
            type="button"
            className="icon-btn wide cat-child-btn"
            title={
              selectedCat
                ? `在「${selectedCat.name}」下新建子分类`
                : '新建子分类：先在下面点一个分类，再点这里'
            }
            disabled={!selectedCat}
            onClick={() => {
              if (!selectedCat) return;
              setAddingCat(false);
              setPromptFor({ kind: 'child', cat: selectedCat, value: '' });
            }}
          >
            ＋子分类
          </button>
          <button type="button" className="icon-btn" title="新建分类" onClick={() => setAddingCat((v) => !v)}>
            ＋
          </button>
        </div>
        {addingCat ? (
          <div className="row" style={{ marginBottom: 8 }}>
            <input
              autoFocus
              placeholder="分类名"
              value={newCatName}
              onChange={(e) => setNewCatName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && newCatName.trim()) {
                  void api.createCategory(null, newCatName.trim()).then(() => {
                    setNewCatName('');
                    setAddingCat(false);
                    loadCats();
                  });
                } else if (e.key === 'Escape') {
                  setAddingCat(false);
                }
              }}
            />
          </div>
        ) : null}

        <TreeRow
          icon="🗂"
          name="全部笔记"
          selected={sel === 'all'}
          onSelect={() => setSel('all')}
          drop={dropTarget === 'all'}
          onDropNote={(noteId) => void doMove(noteId, null)}
          onDragEnter={() => setDropTarget('all')}
          onDragLeave={() => setDropTarget(null)}
        />
        <TreeRow
          icon="📭"
          name="未分类"
          selected={sel === 'unassigned'}
          onSelect={() => setSel('unassigned')}
          drop={dropTarget === 'unassigned'}
          onDropNote={(noteId) => void doMove(noteId, null)}
          onDragEnter={() => setDropTarget('unassigned')}
          onDragLeave={() => setDropTarget(null)}
        />

        <div style={{ height: 6 }} />
        {tree.map((node) => (
          <TreeNode
            key={node.cat.id}
            node={node}
            sel={sel}
            dropTarget={dropTarget}
            onSelect={setSel}
            onDropNote={(noteId, catId) => void doMove(noteId, catId)}
            onDragEnter={setDropTarget}
            onDragLeave={() => setDropTarget(null)}
            onRename={(cat) => setPromptFor({ kind: 'rename', cat, value: cat.name })}
            onDelete={(cat) => {
              // 优化项 7：分类下还有笔记就拦下来（含子分类里的），先搬走或删掉再回来删分类
              const hasChild = cats.some((c) => c.parent_id === cat.id);
              const hasNote = (cat.note_count ?? 0) > 0;
              if (hasNote) {
                toast('该分类下还有笔记，请先移动或删除笔记');
                return;
              }
              if (hasChild) setConfirmCatDel(cat);
              else void doDeleteCategory(cat);
            }}
            onAddChild={(parent) => setPromptFor({ kind: 'child', cat: parent, value: '' })}
            onMove={(cat, dir) => void moveCat(cat, dir)}
          />
        ))}

        <div style={{ height: 8 }} />
        <TreeRow icon="🗑" name="回收站" selected={sel === 'trash'} onSelect={() => setSel('trash')} />

        {/* 标签全局管理：展开式列表，行样式复用分类树的 .tree-item */}
        <div style={{ height: 8 }} />
        <div
          role="treeitem"
          tabIndex={0}
          aria-expanded={tagsOpen}
          className="tree-item"
          title={tagsOpen ? '收起标签列表' : '展开标签列表：点标签就能筛笔记'}
          onClick={() => setTagsOpen((v) => !v)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              setTagsOpen((v) => !v);
            }
          }}
        >
          <span aria-hidden="true">🏷</span>
          <span className="name">标签管理{tags.length > 0 ? `（${tags.length}）` : ''}</span>
          <span className="muted" aria-hidden="true">
            {tagsOpen ? '▾' : '▸'}
          </span>
        </div>
        {tagsOpen ? (
          tags.length === 0 ? (
            <div className="muted" style={{ padding: '6px 8px 6px 22px', fontSize: 12 }}>
              还没有标签，在笔记右下角的标签框里添加
            </div>
          ) : (
            tags.map((tag) => (
              <div
                key={tag.id}
                role="treeitem"
                tabIndex={0}
                aria-selected={tagId === tag.id}
                className={tagId === tag.id ? 'tree-item selected' : 'tree-item'}
                style={{ paddingLeft: 22 }}
                title={`只看用了「${tag.name}」的笔记`}
                onClick={() => {
                  setSel('all');
                  setTagId(tagId === tag.id ? null : tag.id);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setSel('all');
                    setTagId(tagId === tag.id ? null : tag.id);
                  }
                }}
                onContextMenu={(e) => {
                  showContextMenu(
                    e,
                    tagMenuItems(tag, {
                      onRename: (t) => setTagRename({ tag: t, value: t.name }),
                      onDelete: setTagDelete
                    })
                  );
                }}
              >
                <span aria-hidden="true">#</span>
                <span className="name">
                  {tag.name} ({tag.note_count ?? 0})
                </span>
                <span className="actions">
                  <button
                    type="button"
                    className="icon-btn"
                    title="标签操作"
                    onClick={(e) => {
                      e.stopPropagation();
                      showContextMenu(
                        e,
                        tagMenuItems(tag, {
                          onRename: (t) => setTagRename({ tag: t, value: t.name }),
                          onDelete: setTagDelete
                        })
                      );
                    }}
                  >
                    ⋯
                  </button>
                </span>
              </div>
            ))
          )
        ) : null}
      </div>

      {/* 中栏：笔记列表 */}
      <div className="kb-list">
        <div className="kb-list-head">
          <div className="row">
            <input
              type="search"
              placeholder="在这类里找…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              style={{ flex: 1 }}
            />
            <button type="button" className="btn primary sm" onClick={() => void createNote()} title="新建笔记">
              ＋
            </button>
          </div>
          <div className="row" style={{ gap: 6 }}>
            <span className="muted" style={{ flex: 1, fontSize: 12 }}>
              {catName} · {list.length} 篇
            </span>
            <button
              type="button"
              className={tagId ? 'btn sm primary' : 'btn sm ghost'}
              onClick={() => setTagFilterOpen((v) => !v)}
              title="按标签筛选"
            >
              🏷 标签
            </button>
          </div>
          {tagFilterOpen ? (
            <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
              <span className={tagId === null ? 'tag-chip on' : 'tag-chip'} onClick={() => setTagId(null)}>
                全部
              </span>
              {tags.map((tag) => (
                <span
                  key={tag.id}
                  className={tagId === tag.id ? 'tag-chip on' : 'tag-chip'}
                  onClick={() => setTagId(tagId === tag.id ? null : tag.id)}
                >
                  {tag.name}
                  {tag.note_count ? ` ${tag.note_count}` : ''}
                </span>
              ))}
              {tags.length === 0 ? <span className="muted">还没有标签，在笔记右下角添加</span> : null}
            </div>
          ) : null}
          {sel === 'trash' && list.length > 0 ? (
            <div className="row" style={{ gap: 6 }}>
              <span className="muted" style={{ flex: 1, fontSize: 12 }}>
                回收站里的笔记会在 30 天后自动清掉
              </span>
              <button type="button" className="btn sm ghost" onClick={() => setConfirmEmpty(true)}>
                清空回收站
              </button>
            </div>
          ) : null}
          {canReorder && list.length > 1 ? (
            <div className="row" style={{ gap: 6 }}>
              <span className="muted" style={{ flex: 1, fontSize: 12 }}>
                拖动卡片可以调顺序（只影响当前分类）
              </span>
            </div>
          ) : null}
        </div>

        {/* 第五版（动画专项）：超过 50 条时不做逐条位移过渡，新行整体淡入（见 styles.css .many） */}
        <div
          className={'kb-list-body' + (list.length > 50 ? ' many' : '')}
          role="listbox"
          aria-label="笔记列表"
        >
          {list.length === 0 ? (
            <Empty>
              {sel === 'trash'
                ? '回收站是空的。'
                : q
                  ? '这类里没有匹配的笔记。'
                  : '这里还没有笔记，点右上角 ＋ 新建一篇。'}
            </Empty>
          ) : (
            list.map((item) => (
              <div
                key={item.id}
                // 第五版（阶段11）：列表 = listbox，每行 = option；键盘能走到、Enter/空格 打开
                role="option"
                aria-selected={openId === item.id}
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setOpenId(item.id);
                  }
                }}
                className={[
                  'list-row',
                  openId === item.id ? 'selected' : '',
                  canReorder ? 'drag-able' : '',
                  dragId === item.id ? 'dragging' : '',
                  settlingId === item.id ? 'drop-settling' : '',
                  dropAt && dropAt.id === item.id ? (dropAt.after ? 'drop-after' : 'drop-before') : ''
                ]
                  .filter(Boolean)
                  .join(' ')}
                draggable={sel !== 'trash'}
                onDragStart={(e) => {
                  e.dataTransfer.setData('text/note-id', String(item.id));
                  e.dataTransfer.effectAllowed = 'move';
                  setDragId(item.id);
                  liftDragImage(e.currentTarget, e.dataTransfer);
                }}
                onDragEnd={() => {
                  setDragId(null);
                  setDropAt(null);
                }}
                onDragOver={(e) => {
                  if (!canReorder || dragId === null || dragId === item.id) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                  const box = e.currentTarget.getBoundingClientRect();
                  const after = e.clientY > box.top + box.height / 2;
                  if (!dropAt || dropAt.id !== item.id || dropAt.after !== after) {
                    setDropAt({ id: item.id, after });
                  }
                }}
                onDragLeave={(e) => {
                  if (dropAt && dropAt.id === item.id && !e.currentTarget.contains(e.relatedTarget as Node)) {
                    setDropAt(null);
                  }
                }}
                onDrop={(e) => {
                  if (!canReorder) return;
                  const raw = e.dataTransfer.getData('text/note-id');
                  const dropped = Number(raw);
                  if (!raw || Number.isNaN(dropped) || dropped === item.id) return;
                  e.preventDefault();
                  e.stopPropagation();
                  const after = dropAt && dropAt.id === item.id ? dropAt.after : false;
                  reorderTo(dropped, item.id, after);
                  setDragId(null);
                  setDropAt(null);
                }}
                onClick={() => setOpenId(item.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  const items: MenuItem[] =
                    sel === 'trash'
                      ? [
                          {
                            label: '还原',
                            onSelect: () => {
                              void api.restoreNote(item.id).then(() => {
                                void loadList();
                                toast('已还原');
                              });
                            }
                          }
                        ]
                      : [
                          { label: '打开', onSelect: () => setOpenId(item.id) },
                          {
                            label: item.is_pinned ? '取消置顶' : '置顶',
                            onSelect: () => {
                              void api.togglePin(item.id).then(() => loadList());
                            }
                          },
                          { label: '移到回收站', danger: true, separator: true, onSelect: () => setConfirmTrash(item.id) }
                        ];
                  showContextMenu(e, items);
                }}
              >
                <span>{item.is_pinned ? '📌' : '📄'}</span>
                <div className="grow">
                  <div className="title">{item.title || '无标题笔记'}</div>
                  <div className="sub">
                    {relative(item.updated_at)} · {item.word_count} 字
                    {item.category_name ? ` · ${item.category_name}` : ''}
                  </div>
                </div>
                <div className="actions" onClick={(e) => e.stopPropagation()}>
                  {sel === 'trash' ? (
                    <button
                      type="button"
                      className="icon-btn"
                      title="还原"
                      onClick={() => {
                        void api.restoreNote(item.id).then(() => {
                          void loadList();
                          toast('已还原');
                        });
                      }}
                    >
                      ↩
                    </button>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="icon-btn"
                        title={item.is_pinned ? '取消置顶' : '置顶'}
                        onClick={() => {
                          void api.togglePin(item.id).then(() => loadList());
                        }}
                      >
                        📌
                      </button>
                      <button type="button" className="icon-btn" title="删除到回收站" onClick={() => setConfirmTrash(item.id)}>
                        🗑
                      </button>
                    </>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* 右栏：编辑器 */}
      <div className={'kb-editor' + (chatOpen ? ' chat-open' : '')}>
        {!note ? (
          <Empty>左边挑一篇笔记，或者点 ＋ 新建一篇。</Empty>
        ) : (
          <>
            <div className="editor-head">
              <div className="row" style={{ gap: 8 }}>
                <input
                  className="editor-title"
                  placeholder="无标题笔记"
                  value={title}
                  onChange={(e) => touchTitle(e.target.value)}
                />
                <button
                  type="button"
                  className="icon-btn ai-chat-toggle"
                  title="AI 对话（基于当前笔记）"
                  aria-label="AI 对话"
                  aria-expanded={chatOpen}
                  onClick={() => setChatOpen((open) => !open)}
                >
                  💬
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  title="版本历史"
                  onClick={() => setVersionsOpen(true)}
                >
                  🕘
                </button>
                <button
                  type="button"
                  className={['btn sm', saveState === 'dirty' ? 'primary' : '', saveState === 'saving' ? 'loading' : '']
                    .filter(Boolean)
                    .join(' ')}
                  onClick={() => void manualSave()}
                  title="Ctrl+S"
                >
                  {saveState === 'saving' ? '保存中…' : '保存'}
                </button>
              </div>
              <div className="editor-meta">
                <span className={saveClass(saveState, savedFlash)}>
                  {savedFlash ? '✓ 已保存 · 刚刚' : saveLabel(saveState)}
                </span>
                <span>·</span>
                <span>{wordCount} 字</span>
                <span>·</span>
                <span>{relative(note.updated_at)}改过</span>
                <span className="spacer" style={{ flex: 1 }} />
                <button
                  type="button"
                  className={mode === 'edit' ? 'btn sm primary' : 'btn sm ghost'}
                  onClick={() => setMode('edit')}
                >
                  编辑
                </button>
                <button
                  type="button"
                  className={mode === 'preview' ? 'btn sm primary' : 'btn sm ghost'}
                  onClick={() => {
                    setPreviewHtml(sanitizeHtml(htmlRef.current));
                    setMode('preview');
                  }}
                >
                  预览
                </button>
              </div>
            </div>

            {draftPrompt ? (
              <div className="draft-banner">
                <span>上次关窗口时这条笔记有没保存的改动，草稿已经自动留下来了。</span>
                <span className="spacer" style={{ flex: 1 }} />
                <button
                  type="button"
                  className="btn sm primary"
                  onClick={() => {
                    putIntoEditor(draftPrompt.content, draftPrompt.title);
                    setDraftPrompt(null);
                    setSaveState('dirty');
                    toast('已恢复草稿，确认没问题后按 Ctrl+S 保存');
                  }}
                >
                  恢复草稿
                </button>
                <button
                  type="button"
                  className="btn sm ghost"
                  onClick={() => {
                    if (openId != null) void api.saveDraft(openId, note.title, htmlRef.current);
                    setDraftPrompt(null);
                  }}
                >
                  放弃草稿
                </button>
              </div>
            ) : null}

            {fileHover ? (
              <div className="drop-hint">松手：图片插进正文（存进附件夹），其它文件存成附件</div>
            ) : null}

            {mode === 'edit' ? (
              <div className="rt-toolbar">
                <button
                  type="button"
                  className={fmt.bold ? 'tb on' : 'tb'}
                  title="加粗（Ctrl+B）"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    rich.bold();
                    touchBody();
                  }}
                >
                  <b>B</b>
                </button>
                <button
                  type="button"
                  className={fmt.italic ? 'tb on' : 'tb'}
                  title="斜体（Ctrl+I）"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    rich.italic();
                    touchBody();
                  }}
                >
                  <i>I</i>
                </button>
                <button
                  type="button"
                  className={fmt.underline ? 'tb on' : 'tb'}
                  title="下划线（Ctrl+U）"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    rich.underline();
                    touchBody();
                  }}
                >
                  <u>U</u>
                </button>
                <span className="tb-sep" />
                <button
                  type="button"
                  className={colorOpen === 'text' ? 'tb on' : 'tb'}
                  title="字体颜色"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => setColorOpen(colorOpen === 'text' ? null : 'text')}
                >
                  A<span className="tb-under" />
                </button>
                <button
                  type="button"
                  className={colorOpen === 'bg' ? 'tb on' : 'tb'}
                  title="背景高亮"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => setColorOpen(colorOpen === 'bg' ? null : 'bg')}
                >
                  🖍
                </button>
                <span className="tb-sep" />
                <button
                  type="button"
                  className="tb"
                  title="插入本地图片"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => imageInput.current?.click()}
                >
                  🖼
                </button>
                <button
                  type="button"
                  className="tb"
                  title="插入表格"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => setTableOpen(true)}
                >
                  ⊞
                </button>
                <span className="tb-sep" />
                <button
                  type="button"
                  className="tb"
                  title="撤销（Ctrl+Z）"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    rich.undo();
                    touchBody();
                  }}
                >
                  ↶
                </button>
                <button
                  type="button"
                  className="tb"
                  title="重做（Ctrl+Y）"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    rich.redo();
                    touchBody();
                  }}
                >
                  ↷
                </button>
                {fmt.inTable ? (
                  <>
                    <span className="tb-sep" />
                    <span className="tb-hint">表格</span>
                    <button
                      type="button"
                      className="tb tb-wide"
                      title="在下面加一行"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        rich.addRow(true);
                        touchBody();
                      }}
                    >
                      ＋行
                    </button>
                    <button
                      type="button"
                      className="tb tb-wide"
                      title="删掉当前行"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        rich.deleteRow();
                        touchBody();
                      }}
                    >
                      －行
                    </button>
                    <button
                      type="button"
                      className="tb tb-wide"
                      title="在右边加一列"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        rich.addColumn(true);
                        touchBody();
                      }}
                    >
                      ＋列
                    </button>
                    <button
                      type="button"
                      className="tb tb-wide"
                      title="删掉当前列"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        rich.deleteColumn();
                        touchBody();
                      }}
                    >
                      －列
                    </button>
                  </>
                ) : null}
                <span className="tb-sep" />
                <button
                  type="button"
                  className="tb tb-ai"
                  title="AI 助手：润色 / 扩写 / 缩写 / 翻译 / 摘要 / 分类整理 / 知识联想"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={openAiMenu}
                >
                  ✨ AI
                </button>
                <span className="spacer" style={{ flex: 1 }} />
                <span className="tb-hint">Ctrl+B 加粗 · Ctrl+S 保存</span>
              </div>
            ) : null}

            {colorOpen ? (
              <div className="color-pop">
                {(colorOpen === 'text' ? rich.TEXT_COLORS : rich.HIGHLIGHTS).map((color) => (
                  <button
                    key={color}
                    type="button"
                    className="swatch"
                    style={{ background: color }}
                    title={color}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      if (colorOpen === 'text') rich.foreColor(color);
                      else rich.hiliteColor(color);
                      setColorOpen(null);
                      touchBody();
                    }}
                  />
                ))}
              </div>
            ) : null}

            <div
              className="editor-body"
              onDragOver={(e) => {
                if (!Array.from(e.dataTransfer.types).includes('Files')) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'copy';
                setFileHover(true);
              }}
              onDragLeave={(e) => {
                if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
                setFileHover(false);
              }}
              onDrop={(e) => {
                const files = Array.from(e.dataTransfer.files ?? []);
                if (files.length === 0) return;
                e.preventDefault();
                setFileHover(false);
                const images = files.filter((f) => f.type.startsWith('image/'));
                const others = files.filter((f) => !f.type.startsWith('image/'));
                if (images.length) void insertImages(images);
                if (others.length) void attachFiles(others);
              }}
            >
              <input
                ref={imageInput}
                type="file"
                accept="image/*"
                multiple
                style={{ display: 'none' }}
                onChange={(e) => {
                  const files = Array.from(e.target.files ?? []);
                  e.target.value = '';
                  void insertImages(files);
                }}
              />
              {/* 编辑器一直挂着（预览时藏起来），这样来回切标签不会丢光标和没保存的内容 */}
              <div
                ref={editorRef}
                className="rt-editor note-body"
                contentEditable
                suppressContentEditableWarning
                spellCheck={false}
                style={mode === 'edit' ? undefined : { display: 'none' }}
                onInput={touchBody}
                onPaste={(e) => {
                  const files = Array.from(e.clipboardData?.files ?? []);
                  if (files.some((f) => f.type.startsWith('image/'))) {
                    e.preventDefault();
                    void insertImages(files);
                    return;
                  }
                  // 从网页/Word 粘进来的 HTML 先洗一遍再插入，别把脚本带进库
                  const pasted = e.clipboardData?.getData('text/html');
                  if (pasted) {
                    e.preventDefault();
                    rich.exec('insertHTML', sanitizeHtml(pasted));
                    touchBody();
                  }
                }}
              />
              {mode === 'preview' ? (
                <div className="md-preview note-body" dangerouslySetInnerHTML={{ __html: previewHtml }} />
              ) : null}
            </div>

            <div className="editor-foot">
              <span>🏷</span>
              <input
                placeholder="标签，用逗号分开（回车生效）"
                value={tagText}
                style={{ flex: 1, minWidth: 120 }}
                onChange={(e) => setTagText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void applyTags(
                      tagText
                        .split(/[,，]/)
                        .map((s) => s.trim())
                        .filter(Boolean)
                    );
                  }
                }}
              />
              <span>·</span>
              <span>📎 {note.attachments.length}</span>
              <button
                type="button"
                className="btn sm"
                onClick={() => {
                  void api.addAttachment(note.id).then((added) => {
                    if (added.length) void refreshAttachments(note.id);
                  });
                }}
              >
                加附件
              </button>
              <button type="button" className="btn sm" title="把这篇笔记变成一张复习卡" onClick={() => void makeCard()}>
                🔁 变复习卡
              </button>
              <span className="spacer" style={{ flex: 1 }} />
              {note.attachments.slice(0, 3).map((att) => (
                <span key={att.id} className="row" style={{ gap: 4 }}>
                  <button
                    type="button"
                    className="btn sm ghost"
                    title={att.rel_path}
                    onClick={() => {
                      void api.openAttachment(att.id, att.rel_path).catch((err) => toast(errText(err)));
                    }}
                  >
                    {att.file_name.length > 12 ? att.file_name.slice(0, 12) + '…' : att.file_name}
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    title="删掉这个附件"
                    onClick={() => {
                      void api.deleteAttachment(att.id).then(() => refreshAttachments(note.id));
                    }}
                  >
                    ✕
                  </button>
                </span>
              ))}
            </div>

            {openId != null ? (
              <RelatedNotes
                items={related}
                loading={relatedLoading}
                onOpen={(id) => {
                  setMode('edit');
                  openNote(id);
                }}
              />
            ) : null}
          </>
        )}
      </div>

      {chatOpen && note ? (
        <AiChatDrawer
          noteId={openId}
          noteTitle={title || note.title}
          getContext={() => htmlToPlainText(htmlRef.current)}
          ensureReady={ensureAiReady}
          onClose={() => setChatOpen(false)}
        />
      ) : null}

      {tableOpen ? (
        <Modal
          title="插入表格"
          onClose={() => setTableOpen(false)}
          width={340}
          footer={
            <>
              <button type="button" className="btn ghost" onClick={() => setTableOpen(false)}>
                取消
              </button>
              <button
                type="button"
                className="btn primary"
                onClick={() => {
                  rich.insertTable(tableSize.rows, tableSize.cols);
                  setTableOpen(false);
                  touchBody();
                }}
              >
                插入
              </button>
            </>
          }
        >
          <div className="row" style={{ gap: 14 }}>
            <label className="field" style={{ flex: 1 }}>
              行数（不含表头）
              <input
                type="number"
                min={1}
                max={30}
                value={tableSize.rows}
                onChange={(e) =>
                  setTableSize((prev) => ({ ...prev, rows: Number(e.target.value) || 1 }))
                }
              />
            </label>
            <label className="field" style={{ flex: 1 }}>
              列数
              <input
                type="number"
                min={1}
                max={10}
                value={tableSize.cols}
                onChange={(e) =>
                  setTableSize((prev) => ({ ...prev, cols: Number(e.target.value) || 1 }))
                }
              />
            </label>
          </div>
          <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
            第一行会当成表头。插好后把光标放进表格，工具栏上会多出「＋行 / －行 / ＋列 / －列」。
          </p>
        </Modal>
      ) : null}

      {/* 第七版：AI 划词气泡 + 四类弹窗（预览确认 / 摘要 / 分类整理 / 知识联想） */}
      {aiBubble ? (
        <AiBubble
          left={aiBubble.left}
          top={aiBubble.top}
          lang={aiLang}
          onLang={setAiLang}
          onAction={(action) => openAiText(action)}
        />
      ) : null}

      {aiPreview ? (
        <AiPreviewModal
          action={aiPreview.action}
          source={aiPreview.source}
          initialLang={aiLang}
          onConfirm={replaceSelectionWithAi}
          onClose={() => setAiPreview(null)}
        />
      ) : null}

      {aiFull === 'summary' ? (
        <AiSummaryModal
          title={title}
          noteText={notePlainText()}
          onInsert={(text) => insertAiSummary(text)}
          onUndo={undoAiSummary}
          onClose={() => setAiFull(null)}
        />
      ) : null}

      {aiFull === 'tags' && note ? (
        <AiTagsModal
          title={title}
          noteText={notePlainText()}
          tags={note.tags.map((t) => t.name)}
          categories={cats.map((c) => c.name)}
          onAddTag={(name) => addAiTag(name)}
          onApplyCategory={(name) => applyAiCategory(name)}
          onClose={() => setAiFull(null)}
        />
      ) : null}

      {aiFull === 'related' ? (
        <AiRelatedModal
          title={title}
          noteText={notePlainText()}
          onNewNote={(item) => createNoteFromAi(item)}
          onClose={() => setAiFull(null)}
        />
      ) : null}

      {/* 0.12.1：AI 整理成重点文档 —— 生成完成后保存为新笔记，并直接打开它 */}
      {aiFull === 'extract' && openId != null ? (
        <AiExtractDocModal
          noteId={openId}
          title={title}
          noteText={notePlainText()}
          onSaved={(created) => {
            setAiFull(null);
            void loadList();
            setOpenId(created.id);
            toast('已保存为《' + created.title + '》');
          }}
          onClose={() => setAiFull(null)}
        />
      ) : null}

      {aiPrivacy ? (
        <AiPrivacyModal
          baseUrl={aiPrivacy.baseUrl}
          model={aiPrivacy.model}
          onAgree={() => {
            aiPrivacy.resolve(true);
            setAiPrivacy(null);
          }}
          onCancel={() => {
            aiPrivacy.resolve(false);
            setAiPrivacy(null);
          }}
        />
      ) : null}

      {versionsOpen && openId != null ? (
        <VersionDrawer
          noteId={openId}
          current={{ title, content: htmlRef.current }}
          onClose={() => setVersionsOpen(false)}
          onRolledBack={() => {
            setVersionsOpen(false);
            if (openId != null) openNote(openId);
            void loadList();
          }}
        />
      ) : null}

      {confirmCatDel ? (
        <ConfirmDialog
          title={`删除分类「${confirmCatDel.name}」？`}
          danger
          confirmLabel="删除分类"
          message="这个分类下面还有子分类，删除后它们会往上提一级（子分类和里面的笔记都不会丢）。分类里如果有笔记，是删不掉的——要先把笔记搬走或删掉。"
          onCancel={() => setConfirmCatDel(null)}
          onConfirm={async () => {
            const cat = confirmCatDel;
            setConfirmCatDel(null);
            await doDeleteCategory(cat);
          }}
        />
      ) : null}

      {confirmEmpty ? (
        <ConfirmDialog
          title="清空回收站？"
          danger
          confirmLabel="清空回收站"
          message="回收站里的笔记会被彻底删除，版本记录和附件一起清掉，这一步不能撤销。"
          onCancel={() => setConfirmEmpty(false)}
          onConfirm={async () => {
            setConfirmEmpty(false);
            try {
              const n = await api.emptyTrash();
              await loadList();
              await loadCats();
              props.refreshCount();
              toast(`回收站已清空，删掉 ${n} 篇`);
            } catch (err) {
              toastError('清空失败：', err);
            }
          }}
        />
      ) : null}

      {confirmTrash != null ? (
        <ConfirmDialog
          title="移到回收站？"
          danger
          confirmLabel="移到回收站"
          message="这篇笔记会进入回收站，30 天内都能还原；想彻底删掉就等清空回收站（或 30 天后自动清理）。"
          onCancel={() => setConfirmTrash(null)}
          onConfirm={() => {
            const id = confirmTrash;
            setConfirmTrash(null);
            void trash(id);
          }}
        />
      ) : null}

      {promptFor ? (
        <Modal
          title={promptFor.kind === 'rename' ? '改分类名字' : `在「${promptFor.cat.name}」下新建子分类`}
          onClose={() => setPromptFor(null)}
          width={420}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setPromptFor(null)}>
                取消
              </button>
              <button type="button" className="btn primary" onClick={() => void submitPrompt()}>
                确定
              </button>
            </>
          }
        >
          <input
            className="input"
            autoFocus
            value={promptFor.value}
            placeholder="分类名字"
            onChange={(e) => setPromptFor({ ...promptFor, value: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submitPrompt();
              if (e.key === 'Escape') setPromptFor(null);
            }}
          />
        </Modal>
      ) : null}

      {tagRename ? (
        <Modal
          title="改标签名字"
          onClose={() => setTagRename(null)}
          width={420}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setTagRename(null)}>
                取消
              </button>
              <button type="button" className="btn primary" onClick={() => void submitTagRename()}>
                确定
              </button>
            </>
          }
        >
          <input
            className="input"
            autoFocus
            value={tagRename.value}
            placeholder="标签名字"
            onChange={(e) => setTagRename({ ...tagRename, value: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submitTagRename();
              if (e.key === 'Escape') setTagRename(null);
            }}
          />
          <p className="muted" style={{ marginTop: 8, fontSize: 12 }}>
            新名字和已有标签重名时会自动合并成一条。
          </p>
        </Modal>
      ) : null}

      {tagDelete ? (
        <ConfirmDialog
          title={`删除标签「${tagDelete.name}」？`}
          message={`该操作会批量影响相关笔记，但不会删除笔记。当前有 ${tagDelete.note_count ?? 0} 篇笔记用了这个标签，删除后它们只是少一个标签。`}
          confirmLabel="删除标签"
          danger
          onCancel={() => setTagDelete(null)}
          onConfirm={() => doDeleteTag(tagDelete)}
        />
      ) : null}
    </div>
  );
}

function saveLabel(state: 'saved' | 'dirty' | 'saving' | 'error'): string {
  if (state === 'dirty') return '● 有未保存的改动 · Ctrl+S 保存';
  if (state === 'saving') return '保存中…';
  if (state === 'error') return '保存失败，点保存重试';
  return '已保存';
}

function saveClass(state: 'saved' | 'dirty' | 'saving' | 'error', flash: boolean): string {
  if (state === 'dirty') return 'save-state dirty';
  if (state === 'saving') return 'save-state saving';
  if (state === 'error') return 'save-state error';
  return flash ? 'save-state saved' : 'save-state';
}

/* ------------------------------------------------------------------ */
/* 分类树                                                              */
/* ------------------------------------------------------------------ */

interface TreeNodeType {
  cat: Category;
  children: TreeNodeType[];
}

function buildTree(flat: Category[], parentId: Id | null = null): TreeNodeType[] {
  return flat
    .filter((c) => c.parent_id === parentId)
    .sort((a, b) => a.sort_order - b.sort_order || a.id - b.id)
    .map((cat) => ({ cat, children: buildTree(flat, cat.id) }));
}

function TreeRow(props: {
  icon: string;
  name: string;
  selected: boolean;
  onSelect: () => void;
  drop?: boolean;
  onDropNote?: (noteId: Id) => void;
  onDragEnter?: () => void;
  onDragLeave?: () => void;
  onContextMenu?: (e: ReactMouseEvent<HTMLDivElement>) => void;
  actions?: ReactNode;
}): ReactNode {
  return (
    <div
      // 第五版（阶段11）：分类行也能用键盘走到并用 Enter/空格 选中
      role="treeitem"
      tabIndex={0}
      aria-selected={props.selected}
      className={props.drop ? 'tree-item selected' : props.selected ? 'tree-item selected' : 'tree-item'}
      onClick={props.onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          props.onSelect();
        }
      }}
      onContextMenu={props.onContextMenu}
      onDragOver={(e) => {
        if (props.onDropNote) e.preventDefault();
      }}
      onDragEnter={() => props.onDragEnter?.()}
      onDragLeave={() => props.onDragLeave?.()}
      onDrop={(e) => {
        const raw = e.dataTransfer.getData('text/note-id');
        if (raw && props.onDropNote) {
          e.preventDefault();
          props.onDropNote(Number(raw));
        }
      }}
    >
      <span>{props.icon}</span>
      <span className="name">{props.name}</span>
      {props.actions ? <span className="actions">{props.actions}</span> : null}
    </div>
  );
}

/** 分类行右键菜单的项目（和第 10 阶段的行内小图标是同一组动作）。 */
function catMenuItems(cat: Category, h: CatMenuHost): MenuItem[] {
  return [
    { label: '新建子分类', onSelect: () => h.onAddChild(cat) },
    { label: '改名字', onSelect: () => h.onRename(cat) },
    { label: '上移', onSelect: () => h.onMove(cat, 'up') },
    { label: '下移', onSelect: () => h.onMove(cat, 'down') },
    { label: '删除分类', danger: true, separator: true, onSelect: () => h.onDelete(cat) }
  ];
}

interface CatMenuHost {
  onAddChild: (cat: Category) => void;
  onRename: (cat: Category) => void;
  onMove: (cat: Category, dir: 'up' | 'down') => void;
  onDelete: (cat: Category) => void;
}

/** 标签行右键菜单的项目（和行尾 ⋯ 是同一组动作）。 */
function tagMenuItems(
  tag: Tag,
  h: { onRename: (tag: Tag) => void; onDelete: (tag: Tag) => void }
): MenuItem[] {
  return [
    { label: '改标签名', onSelect: () => h.onRename(tag) },
    { label: '删除标签', danger: true, separator: true, onSelect: () => h.onDelete(tag) }
  ];
}

/** 分类行右侧那排小图标：点的时候别让选中跟着跳，所以统一 stopPropagation。 */
function TreeActions({ cat, ...h }: { cat: Category } & CatMenuHost): ReactNode {
  const act = (fn: () => void) => (e: ReactMouseEvent) => {
    e.stopPropagation();
    fn();
  };
  return (
    <>
      <button type="button" className="icon-btn" title="新建子分类" onClick={act(() => h.onAddChild(cat))}>
        ＋
      </button>
      <button type="button" className="icon-btn" title="上移" onClick={act(() => h.onMove(cat, 'up'))}>
        ↑
      </button>
      <button type="button" className="icon-btn" title="下移" onClick={act(() => h.onMove(cat, 'down'))}>
        ↓
      </button>
      <button type="button" className="icon-btn" title="重命名" onClick={act(() => h.onRename(cat))}>
        ✎
      </button>
      <button type="button" className="icon-btn" title="删除分类" onClick={act(() => h.onDelete(cat))}>
        ✕
      </button>
    </>
  );
}

function TreeNode(props: {
  node: TreeNodeType;
  sel: CatSel;
  dropTarget: CatSel | null;
  onSelect: (id: Id) => void;
  onDropNote: (noteId: Id, catId: Id) => void;
  onDragEnter: (id: CatSel) => void;
  onDragLeave: () => void;
  onRename: (cat: Category) => void;
  onDelete: (cat: Category) => void;
  onAddChild: (cat: Category) => void;
  onMove: (cat: Category, dir: 'up' | 'down') => void;
}): ReactNode {
  const [open, setOpen] = useState(true);
  const { cat, children } = props.node;
  return (
    <div>
      <TreeRow
        icon={open && children.length ? '📂' : '📁'}
        name={`${cat.name}${cat.note_count ? ` (${cat.note_count})` : ''}`}
        selected={props.sel === cat.id}
        drop={props.dropTarget === cat.id}
        onSelect={() => {
          props.onSelect(cat.id);
          setOpen(true);
        }}
        onDropNote={(noteId) => props.onDropNote(noteId, cat.id)}
        onDragEnter={() => props.onDragEnter(cat.id)}
        onDragLeave={props.onDragLeave}
        onContextMenu={(e) => {
          e.preventDefault();
          showContextMenu(e, catMenuItems(cat, props));
        }}
        actions={
          <TreeActions
            cat={cat}
            onAddChild={props.onAddChild}
            onRename={props.onRename}
            onMove={props.onMove}
            onDelete={props.onDelete}
          />
        }
      />
      {children.length && open ? (
        <div className="tree-children">
          {children.map((child) => (
            <TreeNode key={child.cat.id} {...props} node={child} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 版本历史                                                            */
/* ------------------------------------------------------------------ */

/**
 * 回滚：不做二次确认，改成「先回滚 + 5 秒撤销」——
 * 回滚前后都各留一个版本点，所以这是一条可逆的路（PRD H3：确认框只留给清空回收站/恢复备份/删含子内容分类）。
 */
async function rollbackToVersion(o: { noteId: Id; version: NoteVersion; onRolledBack: () => void }): Promise<void> {
  const before = await api.getNote(o.noteId);
  if (!before) {
    toast('读不到这篇笔记，先刷新一下');
    return;
  }
  const beforeHtml = before.content_html || renderMarkdown(before.content);
  try {
    await api.rollbackVersion(o.version.id);
  } catch (err) {
    toastError('回滚失败：', err);
    return;
  }
  toast('已回滚到这个版本', {
    actionLabel: '撤销',
    onAction: async () => {
      try {
        await api.saveNote(o.noteId, before.title, { html: beforeHtml }, '撤销回滚');
        toast('已恢复到回滚前的内容');
        o.onRolledBack();
      } catch (err) {
        toastError('恢复失败：', err);
      }
    }
  });
  o.onRolledBack();
}

/** 单个版本的预览（只读渲染，跟正文同一套 markdown + 消毒流程）。 */
function VersionPreviewModal({ version, onClose }: { version: NoteVersion; onClose: () => void }): ReactNode {
  return (
    <Modal title={`版本预览 · ${relative(version.created_at)}`} onClose={onClose} width={760}>
      <div className="muted" style={{ marginBottom: 8 }}>
        {version.title || '无标题'} · {version.word_count} 字 · {version.reason}
      </div>
      <div className="md-preview note-body" style={{ maxHeight: '58vh', overflow: 'auto' }}>
        <div
          dangerouslySetInnerHTML={{
            __html: version.content_html || renderMarkdown(version.content)
          }}
        />
      </div>
    </Modal>
  );
}

/** 某个版本 → 现在的行级对比（绿色新增、红色删掉）。 */
function VersionCompareModal({
  version,
  current,
  onClose
}: {
  version: NoteVersion;
  current: { title: string; content: string };
  onClose: () => void;
}): ReactNode {
  const lines = diffLines(version.content, htmlToPlainText(current.content));
  return (
    <Modal title={`对比：${relative(version.created_at)} 的版本 → 现在`} onClose={onClose} width={860}>
      <div className="muted" style={{ marginBottom: 8 }}>
        绿色是现在多出来的，红色是那个版本里有、现在已经没有的。
      </div>
      <div style={{ maxHeight: '58vh', overflow: 'auto', background: 'var(--bg-sunken)', borderRadius: 8, padding: 8 }}>
        {lines.map((line, index) => (
          <div
            key={index}
            className={line.type === 'add' ? 'diff-line add' : line.type === 'del' ? 'diff-line del' : 'diff-line'}
          >
            {line.type === 'add' ? '+ ' : line.type === 'del' ? '- ' : '  '}
            {line.text || ' '}
          </div>
        ))}
      </div>
    </Modal>
  );
}

function VersionDrawer(props: {
  noteId: Id;
  current: { title: string; content: string };
  onClose: () => void;
  onRolledBack: () => void;
}): ReactNode {
  const [versions, setVersions] = useState<NoteVersion[]>([]);
  const [preview, setPreview] = useState<NoteVersion | null>(null);
  const [compare, setCompare] = useState<NoteVersion | null>(null);

  useEffect(() => {
    api
      .listVersions(props.noteId)
      .then(setVersions)
      .catch((err) => toastError('读取版本失败：', err));
  }, [props.noteId]);

  if (preview) return <VersionPreviewModal version={preview} onClose={() => setPreview(null)} />;
  if (compare) {
    return <VersionCompareModal version={compare} current={props.current} onClose={() => setCompare(null)} />;
  }

  return (
    <Modal
      title="版本历史"
      onClose={props.onClose}
      width={620}
      footer={
        <span className="muted">
          只在手动保存时才留版本点，每篇最多保留 {versions.length} 个（数量可以在设置里改）。
        </span>
      }
    >
      {versions.length === 0 ? (
        <Empty>还没有版本点。按 Ctrl+S 保存一次就会留下第一个。</Empty>
      ) : (
        <div style={{ maxHeight: '56vh', overflow: 'auto' }}>
          {versions.map((ver, index) => {
            const prev = versions[index + 1];
            const delta = prev ? ver.word_count - prev.word_count : 0;
            return (
              <div className="ver-row" key={ver.id}>
                <span>{relative(ver.created_at)}</span>
                <span className="muted">
                  {ver.word_count} 字
                  {delta !== 0 ? ` (${delta > 0 ? '+' : ''}${delta})` : ''}
                </span>
                <span className="muted ellipsis" style={{ flex: 1, minWidth: 0 }}>
                  {ver.title || '无标题'}
                </span>
                <button type="button" className="btn sm ghost" onClick={() => setPreview(ver)}>
                  预览
                </button>
                <button type="button" className="btn sm ghost" onClick={() => setCompare(ver)}>
                  对比
                </button>
                <button
                  type="button"
                  className="btn sm"
                  onClick={() =>
                    void rollbackToVersion({ noteId: props.noteId, version: ver, onRolledBack: props.onRolledBack })
                  }
                >
                  回滚
                </button>
              </div>
            );
          })}
        </div>
      )}
    </Modal>
  );
}
