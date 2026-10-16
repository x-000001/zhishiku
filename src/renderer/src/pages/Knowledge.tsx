import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { api } from '../api';
import { ConfirmDialog, Empty, Modal, toast } from '../ui';
import { fmtDate, relative } from '../format';
import { diffLines, renderMarkdown } from '../markdown';
import type { Attachment, Category, Id, Note, NoteListItem, NoteVersion, Tag } from '../../../shared/types';

type NoteDetail = Note & { tags: Tag[]; attachments: Attachment[] };
type CatSel = Id | 'all' | 'unassigned' | 'trash';

const MD_EXT = [markdown({ base: markdownLanguage, codeLanguages: languages })];

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
  const [openId, setOpenId] = useState<Id | null>(null);
  const [note, setNote] = useState<NoteDetail | null>(null);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [mode, setMode] = useState<'edit' | 'preview'>('edit');
  const [saveState, setSaveState] = useState<'saved' | 'dirty' | 'saving' | 'error'>('saved');
  const [savedFlash, setSavedFlash] = useState(false);
  const [draftPrompt, setDraftPrompt] = useState<{ title: string; content: string } | null>(null);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [tagText, setTagText] = useState('');
  const [newCatName, setNewCatName] = useState('');
  const [addingCat, setAddingCat] = useState(false);
  const [dropTarget, setDropTarget] = useState<CatSel | null>(null);
  const [confirmPurge, setConfirmPurge] = useState<Id | null>(null);
  const [confirmEmpty, setConfirmEmpty] = useState(false);
  const [confirmCatDel, setConfirmCatDel] = useState<Category | null>(null);
  /** 改名 / 新建子分类的输入框（Electron 里没有 window.prompt，必须自己做） */
  const [promptFor, setPromptFor] = useState<{ kind: 'rename' | 'child'; cat: Category; value: string } | null>(
    null
  );
  const [tagFilterOpen, setTagFilterOpen] = useState(false);

  const draftTimer = useRef<number | null>(null);
  /** 彻底删除的待办计时器：界面上先消失，5 秒后才真删，这期间可以撤销。 */
  const pendingDelete = useRef(new Map<Id, ReturnType<typeof setTimeout>>());
  const stateRef = useRef({ title: '', content: '', id: null as Id | null });
  stateRef.current = { title, content, id: openId };

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
        setTitle(full.title);
        setContent(full.content);
        setTagText(full.tags.map((t) => t.name).join(', '));
        setSaveState('saved');
        setMode('edit');
        const draft = full.draft_content;
        if (draft != null && draft !== full.content) {
          setDraftPrompt({ title: full.draft_title ?? full.title, content: draft });
        } else {
          setDraftPrompt(null);
        }
      })
      .catch((err: Error) => toast('打开笔记失败：' + err.message));
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
      const { id, title: t, content: c } = stateRef.current;
      if (id == null) return;
      void api.saveDraft(id, t, c).catch(() => undefined);
    }, 1000);
  }, []);

  const manualSave = useCallback(async () => {
    const id = stateRef.current.id;
    if (id == null) return;
    setSaveState('saving');
    try {
      const res = await api.saveNote(id, stateRef.current.title, stateRef.current.content, '手动保存');
      setSaveState('saved');
      setSavedFlash(true);
      window.setTimeout(() => setSavedFlash(false), 1500);
      setNote((prev) =>
        prev && res.note ? { ...res.note, tags: prev.tags, attachments: prev.attachments } : prev
      );
      setDraftPrompt(null);
      void loadList();
      void loadTags();
    } catch (err) {
      setSaveState('error');
      toast('保存失败：' + (err as Error).message);
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

  const touch = (nextTitle: string, nextContent: string) => {
    setTitle(nextTitle);
    setContent(nextContent);
    setSaveState('dirty');
    scheduleDraft();
  };

  /* ---------------- 列表与分类操作 ---------------- */

  const createNote = async (): Promise<void> => {
    try {
      const created = await api.createNote({
        categoryId: typeof sel === 'number' ? sel : null,
        title: '',
        content: ''
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
  const catName = useMemo(() => {
    if (sel === 'all') return '全部笔记';
    if (sel === 'unassigned') return '未分类';
    if (sel === 'trash') return '回收站';
    return cats.find((c) => c.id === sel)?.name ?? '笔记';
  }, [cats, sel]);

  const wordCount = content.replace(/\s/g, '').length;

  /* ---------------- 渲染 ---------------- */

  return (
    <div className="kb">
      {/* 左栏：分类树 */}
      <div className="kb-tree">
        <div className="row" style={{ marginBottom: 8 }}>
          <span className="muted" style={{ flex: 1, fontSize: 12 }}>
            分类
          </span>
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
              // 只有「含子内容」的分类才需要二次确认（PRD H3 允许弹确认的三处之一）
              const hasChild = cats.some((c) => c.parent_id === cat.id);
              const hasNote = (cat.note_count ?? 0) > 0;
              if (hasChild || hasNote) setConfirmCatDel(cat);
              else void doDeleteCategory(cat);
            }}
            onAddChild={(parent) => setPromptFor({ kind: 'child', cat: parent, value: '' })}
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
        </div>

        <div className="kb-list-body">
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
                className={openId === item.id ? 'list-row selected' : 'list-row'}
                draggable={sel !== 'trash'}
                onDragStart={(e) => e.dataTransfer.setData('text/note-id', String(item.id))}
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
                  onChange={(e) => touch(e.target.value, content)}
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
                  className={saveState === 'dirty' ? 'btn primary sm' : 'btn sm'}
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
                  onClick={() => setMode('preview')}
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
                    touch(draftPrompt.title, draftPrompt.content);
                    setDraftPrompt(null);
                    toast('已恢复草稿，确认没问题后按 Ctrl+S 保存');
                  }}
                >
                  恢复草稿
                </button>
                <button
                  type="button"
                  className="btn sm ghost"
                  onClick={() => {
                    if (openId != null) void api.saveDraft(openId, note.title, note.content);
                    setDraftPrompt(null);
                  }}
                >
                  放弃草稿
                </button>
              </div>
            ) : null}

            <div className="editor-body">
              {mode === 'edit' ? (
                <CodeMirror
                  value={content}
                  height="100%"
                  extensions={MD_EXT}
                  basicSetup={{ lineNumbers: false, foldGutter: false, highlightActiveLine: false }}
                  onChange={(value) => touch(title, value)}
                />
              ) : (
                <div className="md-preview" dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }} />
              )}
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
                    if (added.length && openId != null) openNote(openId);
                  });
                }}
              >
                加附件
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
                      void api.deleteAttachment(att.id).then(() => {
                        if (openId != null) openNote(openId);
                      });
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

      {versionsOpen && openId != null ? (
        <VersionDrawer
          noteId={openId}
          current={{ title, content }}
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
          message="这个分类下面还有子分类或笔记，删除后子分类会消失、笔记会变成「未分类」，笔记本身不会丢。"
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
          await api.saveNote(props.noteId, before.title, before.content, '撤销回滚');
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
        <div className="md-preview" style={{ maxHeight: '58vh', overflow: 'auto' }}>
          <div dangerouslySetInnerHTML={{ __html: renderMarkdown(preview.content) }} />
        </div>
      </Modal>
    );
  }

  if (compare) {
    const lines = diffLines(compare.content, props.current.content);
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
