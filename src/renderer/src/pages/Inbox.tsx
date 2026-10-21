import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { TIMING } from '../timing';
import { api } from '../api';
import { Empty, Modal, toast } from '../ui';
import { PRIORITY_LABEL, PRIORITY_ORDER, relative } from '../format';
import { parseRepoNoteMarkdown } from '../../../shared/github';
import { renderMarkdown } from '../../../shared/markdown';
import { sanitizeHtml } from '../../../shared/html';
import type { InboxItem, InboxKind, InboxStatus, TaskPriority } from '../../../shared/types';
import { toastError } from '../errors';

const KIND_LABEL: Record<InboxKind, string> = {
  idea: '想法',
  read: '待读',
  organize: '待整理',
  github: 'GitHub 项目'
};
const KIND_ICON: Record<InboxKind, string> = {
  idea: '💡',
  read: '📖',
  organize: '🧹',
  github: '🐙'
};
/** 手动记录时能选的三类；github 只能由「导入 GitHub 项目」产生。 */
const EDITABLE_KINDS: InboxKind[] = ['idea', 'read', 'organize'];
const STATUS_TABS: { key: InboxStatus; label: string }[] = [
  { key: 'open', label: '待处理' },
  { key: 'processed', label: '已处理' },
  { key: 'discarded', label: '已丢弃' }
];

const REF_LABEL: Record<string, string> = { note: '笔记', task: '任务', goal: '目标', plan: '学习计划' };

/** 把主进程给的 `note:12` 拆成 { kind, id }。 */
function parseRef(ref: string): { kind: string; id: number } | null {
  const [kind, raw] = ref.split(':');
  const id = Number(raw);
  if (!kind || !Number.isFinite(id)) return null;
  return { kind, id };
}

/** 去掉笔记最前面的 YAML frontmatter，只留正文。 */
function stripFrontmatter(markdown: string): string {
  return markdown.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
}

/* 可编辑正文：失焦时把改动写回去。 */
function EditableText({ value, onSave }: { value: string; onSave: (next: string) => void }): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current && ref.current.textContent !== value) ref.current.textContent = value;
  }, [value]);
  return (
    <div
      ref={ref}
      className="txt"
      contentEditable
      suppressContentEditableWarning
      spellCheck={false}
      title="点一下可以直接改文字"
      onKeyDown={(e) => {
        if (e.key === 'Escape') ref.current?.blur();
      }}
      onBlur={() => {
        const next = (ref.current?.textContent ?? '').replace(/\u00a0/g, ' ').trim();
        if (next && next !== value) onSave(next);
        else if (ref.current) ref.current.textContent = value;
      }}
    />
  );
}

export default function Inbox(props: {
  navigate: (route: string) => void;
  refreshCount: () => void;
  openNote: (id: number) => void;
}): ReactNode {
  const [items, setItems] = useState<InboxItem[]>([]);
  const [status, setStatus] = useState<InboxStatus>('open');
  const [text, setText] = useState('');
  const [kind, setKind] = useState<InboxKind>('idea');
  const [cleaning, setCleaning] = useState(false);
  const [taskFormFor, setTaskFormFor] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  /* 0.11.0：从 GitHub 导入开源项目（仅保存链接 / 保存并 AI 提炼）。 */
  const [ghOpen, setGhOpen] = useState(false);
  const [ghBusy, setGhBusy] = useState<'link' | 'extract' | ''>('');
  const [ghRetrying, setGhRetrying] = useState<number | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  /** 彻底删除的待办计时器：先让界面上的条目消失，5 秒后才真删，这期间可以撤销。 */
  const pendingDelete = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const load = useCallback(
    (which: InboxStatus = status) => {
      return api
        .listInbox(which)
        .then((list) => {
          setItems(list);
          props.refreshCount();
        })
        .catch((err) => toastError('读取收集箱失败：', err))
        .finally(() => setLoading(false));
    },
    [props, status]
  );

  useEffect(() => {
    void load(status);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  /* ---------------- 存一条 ---------------- */

  const save = async () => {
    const content = text.trim();
    if (!content) {
      toast('先写点什么再回车');
      return;
    }
    try {
      await api.addInbox(content, kind);
      setText('');
      await load('open');
      if (status !== 'open') setStatus('open');
      toast('已存进收集箱');
    } catch (err) {
      toastError('保存失败：', err);
    }
    inputRef.current?.focus();
  };

  /* ---------------- 行内动作 ---------------- */

  const convert = async (
    item: InboxItem,
    target: 'note' | 'task' | 'goal' | 'plan',
    extra: { due_at?: string | null; priority?: TaskPriority; repeat_rule?: string } = {}
  ) => {
    try {
      const { ref } = await api.convertInbox({
        id: item.id,
        target,
        title: item.content,
        due_at: extra.due_at ?? null,
        priority: extra.priority ?? 'normal',
        repeat_rule: (extra.repeat_rule as 'none') ?? 'none'
      });
      setTaskFormFor(null);
      await load();
      if (target === 'note' || target === 'task') {
        toast(`已转成${REF_LABEL[target]}`, {
          actionLabel: '撤销',
          onAction: async () => {
            const parsed = parseRef(ref);
            if (parsed) {
              if (parsed.kind === 'note') await api.purgeNote(parsed.id);
              if (parsed.kind === 'task') await api.deleteTask(parsed.id);
            }
            await api.restoreInbox(item.id);
            await load();
            toast('已撤回，回到收集箱');
          }
        });
      } else {
        toast(`已转成${REF_LABEL[target]}，数据已存好（${REF_LABEL[target]}页在第二版补全）`);
      }
    } catch (err) {
      toastError('转换失败：', err);
    }
  };

  const discard = async (item: InboxItem) => {
    try {
      await api.discardInbox(item.id);
      await load();
      toast('已丢弃', {
        actionLabel: '撤销',
        onAction: async () => {
          await api.restoreInbox(item.id);
          await load();
        }
      });
    } catch (err) {
      toastError('操作失败：', err);
    }
  };

  /**
   * 彻底删除：不可逆的动作也要给 5 秒后悔时间 —— 先把它从界面上拿掉，
   * 5 秒后才真正删库；这期间点撤销就把数据原样读回来，不弹确认框。
   */
  const hardDelete = (item: InboxItem) => {
    setItems((prev) => prev.filter((i) => i.id !== item.id));
    const timer = setTimeout(() => {
      pendingDelete.current.delete(item.id);
      void api.deleteInbox(item.id).catch((err) => toastError('删除失败：', err));
    }, TIMING.undoWindow);
    pendingDelete.current.set(item.id, timer);
    toast('已彻底删除', {
      actionLabel: '撤销',
      onAction: () => {
        const t = pendingDelete.current.get(item.id);
        if (t) {
          clearTimeout(t);
          pendingDelete.current.delete(item.id);
        }
        void load();
        toast('已撤回，条目回来了');
      }
    });
  };

  /* ---------------- GitHub 项目 ---------------- */

  const importRepo = async (url: string, extract: boolean) => {
    setGhBusy(extract ? 'extract' : 'link');
    try {
      const result = await api.githubImport({ url, extract });
      setGhOpen(false);
      if (status !== 'open') setStatus('open');
      await load('open');
      if (result.status === 'ai_failed') {
        toast(result.warning ?? 'AI 提炼失败，已先保存基础信息，可稍后重试');
      } else if (result.status === 'link_only') {
        toast('已保存链接：' + result.repo);
      } else {
        toast('已导入并提炼：' + result.repo);
      }
    } catch (err) {
      toastError(extract ? '导入并提炼失败：' : '导入失败：', err);
    } finally {
      setGhBusy('');
    }
  };

  const retryExtract = async (item: InboxItem) => {
    setGhRetrying(item.id);
    try {
      const result = await api.githubRetryExtract(item.id);
      await load();
      if (result.status === 'ai_failed') {
        toast(result.warning ?? 'AI 提炼还是没成功，可以稍后再试');
      } else {
        toast('AI 提炼完成');
      }
    } catch (err) {
      toastError('提炼失败：', err);
    } finally {
      setGhRetrying(null);
    }
  };

  const convertGithubToNote = async (item: InboxItem) => {
    try {
      const { noteId } = await api.githubConvertNote({ itemId: item.id });
      await load();
      toast('已转成知识库笔记（YAML 也一起存进去了）', {
        actionLabel: '打开笔记',
        onAction: () => props.openNote(noteId)
      });
    } catch (err) {
      toastError('转笔记失败：', err);
    }
  };

  const convertByKey = useCallback(
    async (item: InboxItem, key: string): Promise<void> => {
      if (key === '1') {
        if (item.kind === 'github') return convertGithubToNote(item);
        return convert(item, 'note');
      }
      if (key === '2') {
        setTaskFormFor(item.id);
        return;
      }
      if (key === '3') return convert(item, 'goal');
      if (key === '4') return convert(item, 'plan');
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items]
  );

  /* 逐条清理模式：焦点不在输入框时才接管键盘。 */
  useEffect(() => {
    if (!cleaning) return;
    const onKey = async (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      const first = items[0];
      if (e.key === 'Escape') {
        setCleaning(false);
        return;
      }
      if (!first) return;
      if (e.key === '1' || e.key === '2' || e.key === '3' || e.key === '4') {
        e.preventDefault();
        await convertByKey(first, e.key);
      } else if (e.key === 'd' || e.key === 'D') {
        e.preventDefault();
        await discard(first);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cleaning, items]);

  const visible = cleaning ? items.slice(0, 1) : items;

  return (
    <div>
      <div className="card">
        <div className="card-head">
          <h2>随手记一条</h2>
          <span className="spacer" />
          <button
            type="button"
            className="btn sm github-import-btn"
            onClick={() => setGhOpen(true)}
            title="粘一个 GitHub 仓库链接，拉 README 让 AI 提炼成知识点"
          >
            🐙 导入 GitHub 项目
          </button>
          <select value={kind} onChange={(e) => setKind(e.target.value as InboxKind)} title="分类标签">
            {EDITABLE_KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_ICON[k]} {KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </div>
        <div className="capture-box">
          <textarea
            ref={inputRef}
            value={text}
            placeholder="想到什么先扔进来 —— 回车即存，Shift+Enter 换行"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void save();
              }
            }}
          />
          <button type="button" className="btn primary" onClick={() => void save()}>
            存进收集箱
          </button>
        </div>
        <p className="muted" style={{ marginTop: 8 }}>
          快捷键 <span className="kbd">Ctrl+Alt+Space</span> 可以在任何地方呼出小窗口快速记录，存好自动进这里。
        </p>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>
            {STATUS_TABS.find((t) => t.key === status)?.label} · {items.length} 条
          </h2>
          <span className="spacer" />
          {status === 'open' && items.length > 0 ? (
            <button
              type="button"
              className={cleaning ? 'btn primary sm' : 'btn sm'}
              onClick={() => setCleaning((c) => !c)}
              title="一条一条处理，键盘决定去向"
            >
              {cleaning ? '退出逐条清理' : '逐条清理'}
            </button>
          ) : null}
          {EDITABLE_KINDS.map((k) => (
            <span key={k} className="muted" style={{ marginLeft: 8 }}>
              {KIND_ICON[k]} {items.filter((i) => i.kind === k).length}
            </span>
          ))}
          <span className="muted" style={{ marginLeft: 8 }}>
            🐙 {items.filter((i) => i.kind === 'github').length}
          </span>
        </div>

        {cleaning ? (
          <div className="draft-banner" style={{ borderRadius: 8, marginBottom: 10 }}>
            <span>
              按 <span className="kbd">1</span> 转笔记 · <span className="kbd">2</span> 转任务 ·{' '}
              <span className="kbd">3</span> 转目标 · <span className="kbd">4</span> 转学习计划 ·{' '}
              <span className="kbd">D</span> 丢弃 · <span className="kbd">Esc</span> 退出
            </span>
            <span className="spacer" style={{ flex: 1 }} />
            <span>还剩 {items.length} 条</span>
          </div>
        ) : null}

        <div className="tabs" style={{ marginBottom: 10 }}>
          {STATUS_TABS.map((tab) => (
            <button
              key={tab.key}
              type="button"
              className={status === tab.key ? 'btn sm primary' : 'btn sm ghost'}
              onClick={() => setStatus(tab.key)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {loading ? (
          <Empty>正在读取…</Empty>
        ) : visible.length === 0 ? (
          <Empty>
            {status === 'open'
              ? '收集箱是空的。想到什么就先扔进来，回头再决定它的去处。'
              : status === 'processed'
                ? '还没有已经整理的条目。'
                : '没有丢弃的条目。'}
          </Empty>
        ) : (
          visible.map((item) => (
            <div className="inbox-item" key={item.id}>
              <div className="row" style={{ alignItems: 'flex-start', gap: 8 }}>
                <span title={KIND_LABEL[item.kind]}>{KIND_ICON[item.kind]}</span>
                <div className="grow" style={{ minWidth: 0 }}>
                  {item.kind === 'github' ? (
                    <GithubItemBody item={item} />
                  ) : item.status === 'open' ? (
                    <EditableText
                      value={item.content}
                      onSave={(next) => {
                        void api.updateInbox(item.id, { content: next }).then(() => load());
                      }}
                    />
                  ) : (
                    <div className="txt">{item.content}</div>
                  )}
                  <div className="muted" style={{ marginTop: 6 }}>
                    {KIND_LABEL[item.kind]} · {relative(item.created_at)}
                    {item.status === 'processed' && item.converted_to
                      ? ` · 已转成${REF_LABEL[item.converted_to.split(':')[0]] ?? '内容'}`
                      : ''}
                    {item.status === 'discarded' ? ' · 已丢弃' : ''}
                  </div>
                </div>
                {item.kind === 'github' ? null : (
                  <select
                    value={item.kind}
                    title="改分类"
                    disabled={item.status !== 'open'}
                    onChange={(e) => {
                      void api.updateInbox(item.id, { kind: e.target.value as InboxKind }).then(() => load());
                    }}
                  >
                    {EDITABLE_KINDS.map((k) => (
                      <option key={k} value={k}>
                        {KIND_LABEL[k]}
                      </option>
                    ))}
                  </select>
                )}
              </div>

              <div className="inbox-tools">
                {item.status === 'open' ? (
                  <>
                    {item.kind === 'github' ? (
                      <GithubItemTools
                        item={item}
                        busy={ghRetrying === item.id}
                        onConvert={() => convertGithubToNote(item)}
                        onRetry={() => retryExtract(item)}
                      />
                    ) : (
                      <button type="button" className="btn sm" onClick={() => void convert(item, 'note')}>
                        📄 转笔记
                      </button>
                    )}
                    <button
                      type="button"
                      className={taskFormFor === item.id ? 'btn sm primary' : 'btn sm'}
                      onClick={() => setTaskFormFor(taskFormFor === item.id ? null : item.id)}
                    >
                      ✅ 转任务
                    </button>
                    <button type="button" className="btn sm" onClick={() => void convert(item, 'goal')}>
                      🎯 转目标
                    </button>
                    <button type="button" className="btn sm" onClick={() => void convert(item, 'plan')}>
                      📅 转学习计划
                    </button>
                    <span className="spacer" style={{ flex: 1 }} />
                    <button type="button" className="btn sm ghost" onClick={() => void discard(item)}>
                      丢弃
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      className="btn sm"
                      onClick={() => {
                        void api.restoreInbox(item.id).then(() => {
                          void load();
                          toast('已经放回待处理');
                        });
                      }}
                    >
                      ↩ 放回待处理
                    </button>
                    {item.status === 'processed' && item.converted_to?.startsWith('note:') ? (
                      <button
                        type="button"
                        className="btn sm"
                        onClick={() => props.openNote(Number(item.converted_to?.split(':')[1]))}
                      >
                        打开笔记
                      </button>
                    ) : null}
                    {item.status === 'processed' && item.converted_to?.startsWith('task:') ? (
                      <button type="button" className="btn sm" onClick={() => props.navigate('/tasks')}>
                        去任务页
                      </button>
                    ) : null}
                    <span className="spacer" style={{ flex: 1 }} />
                    <button type="button" className="btn sm ghost" onClick={() => hardDelete(item)}>
                      彻底删除
                    </button>
                  </>
                )}
              </div>

              {taskFormFor === item.id ? (
                <TaskQuickForm
                  onCancel={() => setTaskFormFor(null)}
                  onSubmit={(form) => void convert(item, 'task', form)}
                />
              ) : null}
            </div>
          ))
        )}
      </div>

      {ghOpen ? (
        <ImportGithubModal
          busy={ghBusy}
          onClose={() => setGhOpen(false)}
          onSubmit={(url, extract) => importRepo(url, extract)}
        />
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* GitHub 条目：解析 YAML frontmatter，把元信息渲染成徽章 + Markdown    */
/* ------------------------------------------------------------------ */

function GithubItemBody(props: { item: InboxItem }): ReactNode {
  const { item } = props;
  const parsed = parseRepoNoteMarkdown(item.content);
  const body = stripFrontmatter(item.content);
  const failed = item.extract_status === 'ai_failed';
  const linkOnly = item.extract_status === 'link_only';
  return (
    <div className="github-item">
      <div className="github-badges">
        <span className="badge">{item.github_repo ?? parsed.repo ?? '未知仓库'}</span>
        {item.github_stars !== null && item.github_stars !== undefined ? (
          <span className="badge">⭐ {item.github_stars}</span>
        ) : null}
        {item.github_language ? <span className="badge">{item.github_language}</span> : null}
        {failed ? <span className="badge badge-warn">AI 提炼失败</span> : null}
        {linkOnly ? <span className="badge">仅链接</span> : null}
      </div>
      <div
        className="md-preview github-md"
        dangerouslySetInnerHTML={{ __html: sanitizeHtml(renderMarkdown(body)) }}
      />
    </div>
  );
}

function GithubItemTools(props: {
  item: InboxItem;
  busy: boolean;
  onConvert: () => Promise<void> | void;
  onRetry: () => Promise<void> | void;
}): ReactNode {
  const { item, busy } = props;
  const failed = item.extract_status === 'ai_failed';
  const linkOnly = item.extract_status === 'link_only';
  return (
    <>
      <button
        type="button"
        className="btn sm primary github-to-note"
        disabled={busy}
        onClick={() => void props.onConvert()}
      >
        📄 转为知识库笔记
      </button>
      {failed || linkOnly ? (
        <button
          type="button"
          className="btn sm github-retry-btn"
          disabled={busy}
          onClick={() => void props.onRetry()}
        >
          {busy ? '提炼中…' : failed ? '↻ 重试提炼' : '✨ AI 提炼'}
        </button>
      ) : null}
      {item.content ? (
        <button
          type="button"
          className="btn sm ghost github-copy-md"
          onClick={() => {
            void navigator.clipboard.writeText(item.content);
            toast('已复制 Markdown');
          }}
        >
          复制 Markdown
        </button>
      ) : null}
    </>
  );
}

/** 导入弹窗：URL 校验、两个按钮（仅保存 / 保存并提炼）、Loading。 */
function ImportGithubModal(props: {
  busy: '' | 'link' | 'extract';
  onClose: () => void;
  onSubmit: (url: string, extract: boolean) => Promise<void> | void;
}): ReactNode {
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const { busy } = props;
  const working = busy !== '';

  const submit = (extract: boolean) => {
    const value = url.trim();
    if (!value) {
      setError('先粘一个 GitHub 仓库链接');
      return;
    }
    if (!/github\.com/i.test(value) && !/^[\w.-]+\/[\w.-]+$/.test(value)) {
      setError('这不像 GitHub 仓库地址，形如 https://github.com/owner/repo');
      return;
    }
    setError('');
    void props.onSubmit(value, extract);
  };

  return (
    <Modal
      variant="github-import"
      title="导入 GitHub 开源项目"
      width={620}
      onClose={() => {
        if (!working) props.onClose();
      }}
      footer={
        <>
          <button className="btn" disabled={working} onClick={() => props.onClose()}>
            取消
          </button>
          <button className="btn" disabled={working} onClick={() => submit(false)}>
            {busy === 'link' ? '保存中…' : '仅保存链接'}
          </button>
          <button className="btn primary" disabled={working} onClick={() => submit(true)}>
            {busy === 'extract' ? 'AI 提炼中…' : '保存并 AI 提炼'}
          </button>
        </>
      }
    >
      <div className="github-import-body">
        <p className="muted">
          支持带 <code>.git</code>、<code>/tree/main</code>、查询参数的链接，会自动清洗成 owner/repo。
        </p>
        <input
          className="input github-import-url"
          autoFocus
          value={url}
          placeholder="https://github.com/owner/repo"
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !working) submit(true);
          }}
        />
        {error ? <p className="github-error">{error}</p> : null}
        {working ? (
          <p className="muted github-import-loading">
            {busy === 'extract' ? '正在拉 README 并让 AI 提炼…（最多约半分钟）' : '正在读取仓库信息…'}
          </p>
        ) : (
          <p className="muted">
            「保存并 AI 提炼」会把 README 前 8000 字发给设置里的模型服务；失败也不会丢，卡片上可重试。
          </p>
        )}
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* 转任务时行内展开的小表单                                            */
/* ------------------------------------------------------------------ */

function TaskQuickForm(props: {
  onCancel: () => void;
  onSubmit: (form: { due_at: string | null; priority: TaskPriority; repeat_rule: string }) => void;
}): ReactNode {
  const [due, setDue] = useState('');
  const [priority, setPriority] = useState<TaskPriority>('normal');
  const [repeat, setRepeat] = useState('none');
  return (
    <div className="row" style={{ marginTop: 10, gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
      <span className="muted">截止日</span>
      <input type="date" value={due} onChange={(e) => setDue(e.target.value)} />
      <span className="muted">优先级</span>
      <select value={priority} onChange={(e) => setPriority(e.target.value as TaskPriority)}>
        {PRIORITY_ORDER.map((p) => (
          <option key={p} value={p}>
            {PRIORITY_LABEL[p]}
          </option>
        ))}
      </select>
      <span className="muted">重复</span>
      <select value={repeat} onChange={(e) => setRepeat(e.target.value)}>
        <option value="none">不重复</option>
        <option value="daily">每天</option>
        <option value="weekdays">工作日</option>
        <option value="weekly">每周</option>
        <option value="monthly">每月</option>
      </select>
      <button
        type="button"
        className="btn sm primary"
        onClick={() => props.onSubmit({ due_at: due || null, priority, repeat_rule: repeat })}
      >
        确定转成任务
      </button>
      <button type="button" className="btn sm ghost" onClick={props.onCancel}>
        取消
      </button>
    </div>
  );
}
