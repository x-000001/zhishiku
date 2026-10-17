import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, pathForFile } from '../api';
import { ConfirmDialog, Empty, Modal, toast } from '../ui';
import { fmtDate, relative } from '../format';
import { diffLines, renderMarkdown } from '../../../shared/markdown';
import { attachmentUrl, htmlToPlainText, sanitizeHtml } from '../../../shared/html';
import * as rich from '../rich';
import { describeSaveError, saveStamp } from '../save';
import { applyOrder, moveWithinGroup } from '../reorder';
import type { Attachment, Category, Id, Note, NoteListItem, NoteVersion, Tag } from '../../../shared/types';

type NoteDetail = Note & { tags: Tag[]; attachments: Attachment[] };
type CatSel = Id | 'all' | 'unassigned' | 'trash';

/** 字数按纯文字算：HTML 标签不算字。 */
function countLocal(html: string): number {
  return htmlToPlainText(html).replace(/\s/g, '').length;
}

export default function Knowledge(props: {
  openNoteId: Id | null;
  clearOpenNote: () => void;
  refreshCount: () => void;
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
  const [confirmPurge, setConfirmPurge] = useState<Id | null>(null);
  const [confirmEmpty, setConfirmEmpty] = useState(false);
  const [confirmCatDel, setConfirmCatDel] = useState<Category | null>(null);
  /** 改名 / 新建子分类的输入框（Electron 里没有 window.prompt，必须自己做） */
  const [promptFor, setPromptFor] = useState<{ kind: 'rename' | 'child'; cat: Category; value: string } | null>(
    null
  );
  const [tagFilterOpen, setTagFilterOpen] = useState(false);

  const draftTimer = useRef<number | null>(null);
  const wordTimer = useRef<number | null>(null);
  /** touchBody 定义在 scheduleDraft 之前，用 ref 转一手避免顺序问题 */
  const scheduleDraftRef = useRef<(() => void) | null>(null);
  /** 彻底删除的待办计时器：界面上先消失，5 秒后才真删，这期间可以撤销。 */
  const pendingDelete = useRef(new Map<Id, ReturnType<typeof setTimeout>>());
  const stateRef = useRef({ title: '', html: '', id: null as Id | null });
  stateRef.current = { title, html: htmlRef.current, id: openId };

  /* ---------------- 编辑器与正文 ---------------- */

  /** 把一段 HTML 放进编辑器：换笔记、恢复草稿、回滚版本都走这里。 */
  const putIntoEditor = useCallback((html: string, nextTitle?: string) => {
    const clean = sanitizeHtml(html);
    htmlRef.current = clean;
    setPreviewHtml(clean);
    setWordCount(countLocal(clean));
    if (nextTitle != null) setTitle(nextTitle);
    setEditorEpoch((n) => n + 1);
  }, []);

  /** 正文被改动：标脏、排草稿、慢一点再更新字数（不整页重渲染）。 */
  const touchBody = useCallback(() => {
    const el = editorRef.current;
    if (el) htmlRef.current = el.innerHTML;
    setSaveState('dirty');
    scheduleDraftRef.current?.();
    if (wordTimer.current) window.clearTimeout(wordTimer.current);
    wordTimer.current = window.setTimeout(() => setWordCount(countLocal(htmlRef.current)), 300);
  }, []);

  /** 只在换笔记 / 恢复草稿后把 ref 里的 HTML 推进编辑器；平时让它自己管，光标才不会跳。 */
  useEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    if (el.innerHTML !== htmlRef.current) el.innerHTML = htmlRef.current;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editorEpoch, openId]);

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
      .catch((err: Error) => toast('读取分类失败：' + err.message));
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
      .catch((err: Error) => toast('读取笔记失败：' + err.message));
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
      .catch((err: Error) => toast('打开笔记失败：' + err.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (openId != null) openNote(openId);
    else setNote(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openId]);

  /* ---------------- 草稿与手动保存 ---------------- */

  const scheduleDraft = useCallback(() => {
    if (draftTimer.current) window.clearTimeout(draftTimer.current);
    draftTimer.current = window.setTimeout(() => {
      const { id, title: t } = stateRef.current;
      if (id == null) return;
      void api.saveDraft(id, t, htmlRef.current).catch(() => undefined);
    }, 1000);
  }, []);
  scheduleDraftRef.current = scheduleDraft;

  const manualSave = useCallback(async () => {
    const id = stateRef.current.id;
    if (id == null) return;
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
      window.setTimeout(() => setSavedFlash(false), 1500);
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
          toast(`「${file.name}」没加上：` + (err as Error).message);
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
          toast(`「${file.name}」没插上：` + (err as Error).message);
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
      toast('生成失败：' + (err as Error).message);
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
      toast('新建笔记失败：' + (err as Error).message);
    }
  };

  const doMove = async (noteId: Id, categoryId: Id | null): Promise<void> => {
    try {
      await api.moveNote(noteId, categoryId);
      await loadList();
      await loadCats();
      toast('已移动');
    } catch (err) {
      toast('移动失败：' + (err as Error).message);
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
    window.setTimeout(() => setSettlingId((cur) => (cur === draggedId ? null : cur)), 420);
    void api
      .reorderNotes(ids)
      .then(() => loadList())
      .catch((err: Error) => toast('排序保存失败：' + err.message));
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
      toast('排序失败：' + (err as Error).message);
    }
  };

  const trash = async (id: Id): Promise<void> => {    try {
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
      toast('删除失败：' + (err as Error).message);
    }
  };

  /**
   * 彻底删除笔记：不可逆，但仍然给 5 秒后悔时间。
   * 先让它从列表里消失，5 秒后才真删；这期间点撤销就重新读回来。
   */
  const purge = (id: Id): void => {
    setList((prev) => prev.filter((n) => n.id !== id));
    if (openId === id) setOpenId(null);
    const timer = setTimeout(() => {
      pendingDelete.current.delete(id);
      void api
        .purgeNote(id)
        .then(() => {
          loadCats();
          props.refreshCount();
        })
        .catch((err: Error) => toast('删除失败：' + err.message));
    }, 5000);
    pendingDelete.current.set(id, timer);
    toast('已彻底删除', {
      actionLabel: '撤销',
      onAction: () => {
        const t = pendingDelete.current.get(id);
        if (t) {
          clearTimeout(t);
          pendingDelete.current.delete(id);
        }
        void loadList();
        void loadCats();
        toast('已撤回，笔记回来了');
      }
    });
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
      toast('删除分类失败：' + (err as Error).message);
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
      toast('操作失败：' + (err as Error).message);
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
      toast('设置标签失败：' + (err as Error).message);
    }
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
    <div className="kb">
      {/* 左栏：分类树 */}
      <div className="kb-tree">
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
        <div className={'kb-list-body' + (list.length > 50 ? ' many' : '')}>
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
                    <>
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
                      <button type="button" className="icon-btn" title="彻底删除" onClick={() => setConfirmPurge(item.id)}>
                        ✕
                      </button>
                    </>
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
                      <button type="button" className="icon-btn" title="删除到回收站" onClick={() => void trash(item.id)}>
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
      <div className="kb-editor">
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
                      void api.openAttachment(att.id, att.rel_path).catch((err: Error) => toast(err.message));
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
          </>
        )}
      </div>

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
              toast('清空失败：' + (err as Error).message);
            }
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
  actions?: ReactNode;
}): ReactNode {
  return (
    <div
      className={props.drop ? 'tree-item selected' : props.selected ? 'tree-item selected' : 'tree-item'}
      onClick={props.onSelect}
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
        actions={
          <>
            <button
              type="button"
              className="icon-btn"
              title="新建子分类"
              onClick={(e) => {
                e.stopPropagation();
                props.onAddChild(cat);
              }}
            >
              ＋
            </button>
            <button
              type="button"
              className="icon-btn"
              title="上移"
              onClick={(e) => {
                e.stopPropagation();
                props.onMove(cat, 'up');
              }}
            >
              ↑
            </button>
            <button
              type="button"
              className="icon-btn"
              title="下移"
              onClick={(e) => {
                e.stopPropagation();
                props.onMove(cat, 'down');
              }}
            >
              ↓
            </button>
            <button
              type="button"
              className="icon-btn"
              title="重命名"
              onClick={(e) => {
                e.stopPropagation();
                props.onRename(cat);
              }}
            >
              ✎
            </button>
            <button
              type="button"
              className="icon-btn"
              title="删除分类"
              onClick={(e) => {
                e.stopPropagation();
                props.onDelete(cat);
              }}
            >
              ✕
            </button>
          </>
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

function VersionDrawer(props: {
  noteId: Id;
  current: { title: string; content: string };
  onClose: () => void;
  onRolledBack: () => void;
}): ReactNode {
  const [versions, setVersions] = useState<NoteVersion[]>([]);
  const [preview, setPreview] = useState<NoteVersion | null>(null);
  const [compare, setCompare] = useState<NoteVersion | null>(null);

  /**
   * 回滚：不做二次确认，改成「先回滚 + 5 秒撤销」——
   * 回滚前后都各留一个版本点，所以这是一条可逆的路（PRD H3：确认框只留给清空回收站/恢复备份/删含子内容分类）。
   */
  const doRollback = async (ver: NoteVersion): Promise<void> => {
    const before = await api.getNote(props.noteId);
    if (!before) {
      toast('读不到这篇笔记，先刷新一下');
      return;
    }
    const beforeHtml = before.content_html || renderMarkdown(before.content);
    try {
      await api.rollbackVersion(ver.id);
    } catch (err) {
      toast('回滚失败：' + (err as Error).message);
      return;
    }
    toast('已回滚到这个版本', {
      actionLabel: '撤销',
      onAction: async () => {
        try {
          await api.saveNote(props.noteId, before.title, { html: beforeHtml }, '撤销回滚');
          toast('已恢复到回滚前的内容');
          props.onRolledBack();
        } catch (err) {
          toast('恢复失败：' + (err as Error).message);
        }
      }
    });
    props.onRolledBack();
  };

  useEffect(() => {
    api
      .listVersions(props.noteId)
      .then(setVersions)
      .catch((err: Error) => toast('读取版本失败：' + err.message));
  }, [props.noteId]);

  if (preview) {
    return (
      <Modal title={`版本预览 · ${relative(preview.created_at)}`} onClose={() => setPreview(null)} width={760}>
        <div className="muted" style={{ marginBottom: 8 }}>
          {preview.title || '无标题'} · {preview.word_count} 字 · {preview.reason}
        </div>
        <div className="md-preview note-body" style={{ maxHeight: '58vh', overflow: 'auto' }}>
          <div
            dangerouslySetInnerHTML={{
              __html: preview.content_html || renderMarkdown(preview.content)
            }}
          />
        </div>
      </Modal>
    );
  }

  if (compare) {
    const lines = diffLines(compare.content, htmlToPlainText(props.current.content));
    return (
      <Modal
        title={`对比：${relative(compare.created_at)} 的版本 → 现在`}
        onClose={() => setCompare(null)}
        width={860}
      >
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
                <button type="button" className="btn sm" onClick={() => void doRollback(ver)}>
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
