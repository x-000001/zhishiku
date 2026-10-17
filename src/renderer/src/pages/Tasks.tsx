import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from '../api';
import { Empty, ConfirmDialog, toast } from '../ui';
import { showContextMenu } from '../menu';
import { PRIORITY_LABEL, PRIORITY_ORDER, REPEAT_LABEL, fmtDate, fmtDateTime, nextPriority, relative, todayLocal } from '../format';
import { SaveButton, useManualSave } from '../save';
import type { GoalSummary, Id, Task, TaskFilter, TaskPriority } from '../../../shared/types';

const VIEWS: { key: NonNullable<TaskFilter['view']>; icon: string; label: string; hint: string }[] = [
  { key: 'today', icon: '☀️', label: '今天', hint: '今天到期，连同已经逾期的（完成的留在原地）' },
  { key: 'overdue', icon: '⚠️', label: '已逾期', hint: '截止日已经过去还没做完' },
  { key: 'upcoming', icon: '📆', label: '接下来', hint: '今天之后要做的' },
  { key: 'all', icon: '📋', label: '全部', hint: '所有没做完的任务' }
];

/** 状态筛选三档（优化项 4）：勾完不消失，靠这里区分看没做完还是看做完的。 */
const STATUSES: { key: NonNullable<TaskFilter['status']>; label: string; countKey: 'all' | 'todo' | 'done' }[] = [
  { key: 'all', label: '全部', countKey: 'all' },
  { key: 'todo', label: '未完成', countKey: 'todo' },
  { key: 'done', label: '已完成', countKey: 'done' }
];

function isOverdue(task: Task): boolean {
  if (task.status === 'done' || !task.due_at) return false;
  return task.due_at.slice(0, 10) < todayLocal();
}

export default function Tasks(props: { refreshCount: () => void }): ReactNode {
  const [view, setView] = useState<NonNullable<TaskFilter['view']>>('today');
  const [status, setStatus] = useState<NonNullable<TaskFilter['status']>>('all');
  const [prioFilter, setPrioFilter] = useState<NonNullable<TaskFilter['priority']>>('all');
  const [newPrio, setNewPrio] = useState<TaskPriority>('normal');
  const [q, setQ] = useState('');
  const [tasks, setTasks] = useState<Task[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [selected, setSelected] = useState<Id | null>(null);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [pickMode, setPickMode] = useState(false);
  const [picked, setPicked] = useState<Set<Id>>(() => new Set());
  const [confirmBatch, setConfirmBatch] = useState(false);
  const addRef = useRef<HTMLInputElement>(null);

  const load = useCallback(
    (which = view) => {
      return Promise.all([
        api.listTasks({
          view: which,
          status,
          priority: prioFilter,
          q: q.trim() || undefined
        }),
        api.taskCounts()
      ])
        .then(([rows, realCounts]) => {
          setTasks(rows);
          setCounts(realCounts);
          // 勾选状态跟着列表走：删掉/改状态后不再留下的 id 自动从选中集合里消失
          setPicked((prev) => {
            if (prev.size === 0) return prev;
            const alive = new Set(rows.map((r) => r.id));
            const next = new Set([...prev].filter((id) => alive.has(id)));
            return next.size === prev.size ? prev : next;
          });
          props.refreshCount();
        })
        .catch((err: Error) => toast('读取任务失败：' + err.message))
        .finally(() => setLoading(false));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [view, status, prioFilter, q]
  );

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, status, prioFilter]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 200);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const patch = async (id: Id, changes: Partial<Task>): Promise<void> => {
    try {
      await api.updateTask(id, changes);
      await load();
    } catch (err) {
      toast('改不动：' + (err as Error).message);
    }
  };

  /** 手动保存走这条：不吞异常，交给「保存」按钮按占用/权限分诊报错。 */
  const patchStrict = async (id: Id, changes: Partial<Task>): Promise<void> => {
    await api.updateTask(id, changes);
    await load();
  };

  const toggle = async (task: Task): Promise<void> => {
    try {
      const res = await api.toggleTask(task.id, task.status === 'done' ? 'todo' : 'done');
      if (res.spawned) toast('已完成，按重复规则生成了下一次');
      else toast(task.status === 'done' ? '又变回没做完' : '已勾掉');
      await load();
    } catch (err) {
      toast('操作失败：' + (err as Error).message);
    }
  };

  const addTask = async (): Promise<void> => {
    const title = draft.trim();
    if (!title) return;
    try {
      await api.createTask({
        title,
        priority: newPrio,
        due_at: view === 'today' || view === 'overdue' ? todayLocal() : null
      });
      setDraft('');
      await load();
      addRef.current?.focus();
    } catch (err) {
      toast('新建失败：' + (err as Error).message);
    }
  };

  const remove = async (task: Task): Promise<void> => {
    try {
      await api.deleteTask(task.id);
      if (selected === task.id) setSelected(null);
      await load();
      toast('已删除', {
        actionLabel: '撤销',
        onAction: async () => {
          await api.createTask({
            title: task.title,
            note: task.note,
            priority: task.priority,
            due_at: task.due_at,
            repeat_rule: task.repeat_rule,
            goal_id: task.goal_id,
            plan_id: task.plan_id
          });
          await load();
          toast('任务已放回来（会是一条新的）');
        }
      });
    } catch (err) {
      toast('删除失败：' + (err as Error).message);
    }
  };

  const togglePick = (id: Id): void => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const batchRemove = async (): Promise<void> => {
    const ids = [...picked];
    setConfirmBatch(false);
    if (ids.length === 0) return;
    try {
      const n = await api.deleteTasks(ids);
      setPicked(new Set());
      setSelected(null);
      await load();
      toast(`已删除 ${n} 条任务`);
    } catch (err) {
      toast('批量删除失败：' + (err as Error).message);
    }
  };

  const current = VIEWS.find((v) => v.key === view) ?? VIEWS[0];
  const allPicked = tasks.length > 0 && tasks.every((t) => picked.has(t.id));
  const selectedTask = useMemo(() => tasks.find((t) => t.id === selected) ?? null, [tasks, selected]);

  return (
    <div className="kb">
      {/* 左栏：视图与筛选 */}
      <div className="kb-tree">
        <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
          视图
        </div>
        {VIEWS.map((item) => (
          <div
            key={item.key}
            className={view === item.key ? 'tree-item selected' : 'tree-item'}
            title={item.hint}
            onClick={() => {
              setView(item.key);
              setSelected(null);
            }}
          >
            <span>{item.icon}</span>
            <span className="name">{item.label}</span>
            <span className="muted">{counts[item.key] ?? 0}</span>
          </div>
        ))}

        <div style={{ height: 10 }} />
        <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
          状态
        </div>
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          {STATUSES.map((item) => (
            <button
              key={item.key}
              type="button"
              className={status === item.key ? 'btn sm primary' : 'btn sm'}
              onClick={() => {
                setStatus(item.key);
                setPicked(new Set());
                setSelected(null);
              }}
            >
              {item.label}
              <span className="muted" style={{ marginLeft: 5 }}>
                {counts[item.countKey] ?? 0}
              </span>
            </button>
          ))}
        </div>
        <div style={{ height: 10 }} />
        <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
          优先级
        </div>
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          {(['all', ...PRIORITY_ORDER] as (TaskPriority | 'all')[]).map((p) => (
            <button
              key={p}
              type="button"
              className={prioFilter === p ? 'btn sm primary' : 'btn sm'}
              onClick={() => {
                setPrioFilter(p);
                setPicked(new Set());
                setSelected(null);
              }}
            >
              {p === 'all' ? '全部' : PRIORITY_LABEL[p]}
            </button>
          ))}
        </div>
        <div style={{ height: 10 }} />
        <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
          筛选
        </div>
        <input
          type="search"
          placeholder="搜任务…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{ width: '100%' }}
        />
        <div style={{ height: 12 }} />
        <div className="muted" style={{ fontSize: 12, lineHeight: 1.9 }}>
          · 点标题直接改
          <br />· 点小圆点换优先级（紧急 / 重要 / 一般）
          <br />· 点日期改截止日
          <br />· 回车快速加下一条
        </div>
      </div>

      {/* 右栏：任务列表 */}
      <div className="kb-editor">
        <div className="editor-head">
          <div className="row">
            <span style={{ fontSize: 16, fontWeight: 650 }}>
              {current.icon} {current.label}
            </span>
            <span className="muted" style={{ marginLeft: 8 }}>
              {tasks.length} 条 · {current.hint}
              {pickMode ? ` · 已选 ${picked.size} 条` : ''}
              {tasks.length >= 500 ? '（只显示前 500 条，用搜索缩小范围）' : ''}
            </span>
            <span className="spacer" style={{ flex: 1 }} />
            {pickMode ? (
              <>
                <button
                  type="button"
                  className="btn sm"
                  onClick={() => setPicked(allPicked ? new Set() : new Set(tasks.map((t) => t.id)))}
                >
                  {allPicked ? '取消全选' : '全选'}
                </button>
                <button
                  type="button"
                  className="btn sm"
                  disabled={picked.size === 0}
                  style={
                    picked.size
                      ? { background: 'var(--danger)', borderColor: 'var(--danger)', color: '#fff' }
                      : undefined
                  }
                  onClick={() => setConfirmBatch(true)}
                >
                  批量删除（{picked.size}）
                </button>
              </>
            ) : null}
            <button
              type="button"
              className={pickMode ? 'btn sm primary' : 'btn sm'}
              title="打开后每行前面会出现复选框，可以一次删掉一批"
              onClick={() => {
                setPickMode(!pickMode);
                setPicked(new Set());
              }}
            >
              {pickMode ? '退出多选' : '☑ 多选'}
            </button>
            <button
              type="button"
              className="btn sm"
              onClick={() => {
                setSelected(null);
                addRef.current?.focus();
              }}
            >
              ＋ 新建
            </button>
          </div>
        </div>

        <div className="editor-body" style={{ padding: '8px 10px' }}>
          {loading ? (
            <Empty>正在读取…</Empty>
          ) : tasks.length === 0 ? (
            <Empty>
              {view === 'today'
                ? '今天没有到期任务，松一口气。'
                : view === 'done'
                  ? '还没有完成的任务。'
                  : view === 'overdue'
                    ? '没有逾期任务，很好。'
                    : '这里还没有任务，在下面输入框敲一条。'}
            </Empty>
          ) : (
            tasks.map((task) => (
              <div key={task.id}>
                <div
                  className={`task-row${task.status === 'done' ? ' done' : ''}${selected === task.id ? ' selected' : ''}${picked.has(task.id) ? ' picked' : ''}`}
                  // 第五版（阶段11）：整行也能用键盘走到（Enter / 空格 展开详情）
                  role="button"
                  tabIndex={0}
                  aria-expanded={selected === task.id}
                  onKeyDown={(e) => {
                    if (e.target !== e.currentTarget) return;
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      if (pickMode) togglePick(task.id);
                      else setSelected(selected === task.id ? null : task.id);
                    }
                  }}
                  onClick={() => (pickMode ? togglePick(task.id) : setSelected(selected === task.id ? null : task.id))}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    showContextMenu(e, [
                      {
                        label: task.status === 'done' ? '取消完成' : '标记完成',
                        onSelect: () => void toggle(task)
                      },
                      ...PRIORITY_ORDER.map((p, i) => ({
                        label: `优先级：${PRIORITY_LABEL[p] ?? p}`,
                        hint: task.priority === p ? '当前' : undefined,
                        separator: i === 0,
                        onSelect: () => void patch(task.id, { priority: p as TaskPriority })
                      })),
                      { label: '删除', danger: true, separator: true, onSelect: () => void remove(task) }
                    ]);
                  }}
                >
                  {pickMode ? (
                    <input
                      type="checkbox"
                      className="pick"
                      checked={picked.has(task.id)}
                      onClick={(e) => e.stopPropagation()}
                      onChange={() => togglePick(task.id)}
                    />
                  ) : null}
                  <button
                    type="button"
                    className={task.status === 'done' ? 'check on' : 'check'}
                    title={task.status === 'done' ? '取消完成' : '标记完成'}
                    onClick={(e) => {
                      e.stopPropagation();
                      void toggle(task);
                    }}
                  >
                    ✓
                  </button>
                  <button
                    type="button"
                    className={`dot prio-${task.priority}`}
                    title={`优先级：${PRIORITY_LABEL[task.priority] ?? '一般'}（点一下换一档）`}
                    onClick={(e) => {
                      e.stopPropagation();
                      void patch(task.id, { priority: nextPriority(task.priority) });
                    }}
                  />
                  <input
                    className="inline-title"
                    defaultValue={task.title}
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                      if (e.key === 'Escape') {
                        (e.target as HTMLInputElement).value = task.title;
                        (e.target as HTMLInputElement).blur();
                      }
                    }}
                    onBlur={(e) => {
                      const value = e.target.value.trim();
                      if (!value) {
                        e.target.value = task.title;
                        return;
                      }
                      if (value !== task.title) void patch(task.id, { title: value });
                    }}
                  />
                  {task.repeat_rule !== 'none' ? (
                    <span title={`重复：${REPEAT_LABEL[task.repeat_rule]}`}>🔁</span>
                  ) : null}
                  {task.goal_id ? <span title={`属于目标 #${task.goal_id}`}>🎯</span> : null}
                  <input
                    type="date"
                    value={task.due_at ? task.due_at.slice(0, 10) : ''}
                    onClick={(e) => e.stopPropagation()}
                    title="改截止日"
                    style={{ width: 138 }}
                    onChange={(e) => void patch(task.id, { due_at: e.target.value || null })}
                  />
                  <span
                    className="muted"
                    style={{
                      width: 52,
                      textAlign: 'right',
                      color: isOverdue(task) ? 'var(--danger)' : undefined
                    }}
                  >
                    {isOverdue(task) ? '已逾期' : fmtDate(task.due_at)}
                  </span>
                  <button
                    type="button"
                    className="icon-btn"
                    title="删除"
                    onClick={(e) => {
                      e.stopPropagation();
                      void remove(task);
                    }}
                  >
                    🗑
                  </button>
                </div>

                {selected === task.id && selectedTask ? (
                  <TaskDrawer
                    task={selectedTask}
                    onPatch={(changes) => void patch(selectedTask.id, changes)}
                    onSave={(changes) => patchStrict(selectedTask.id, changes)}
                    onClose={() => setSelected(null)}
                  />
                ) : null}
              </div>
            ))
          )}
        </div>

        <div className="task-add">
          <span>＋</span>
          <input
            ref={addRef}
            placeholder="敲一条任务，回车就加上，接着敲下一条"
            value={draft}
            style={{ flex: 1 }}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void addTask();
              }
            }}
          />
          <select
            value={newPrio}
            title="新任务的优先级"
            onChange={(e) => setNewPrio(e.target.value as TaskPriority)}
          >
            {PRIORITY_ORDER.map((p) => (
              <option key={p} value={p}>
                {PRIORITY_LABEL[p]}
              </option>
            ))}
          </select>
          <button type="button" className="btn sm primary" onClick={() => void addTask()}>
            加上
          </button>
        </div>
      </div>

      {confirmBatch ? (
        <ConfirmDialog
          title="批量删除任务"
          message={`确定删掉选中的 ${picked.size} 条任务吗？删掉后不在这里显示，数据还在库里（软删除）。`}
          confirmLabel={`删除 ${picked.size} 条`}
          danger
          onCancel={() => setConfirmBatch(false)}
          onConfirm={batchRemove}
        />
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 详情抽屉                                                            */
/* ------------------------------------------------------------------ */

function TaskDrawer(props: {
  task: Task;
  onPatch: (changes: Partial<Task>) => void;
  onSave: (changes: Partial<Task>) => Promise<void>;
  onClose: () => void;
}): ReactNode {
  const { task } = props;
  const [note, setNote] = useState(task.note);
  useEffect(() => setNote(task.note), [task.id, task.note]);

  const [goals, setGoals] = useState<GoalSummary[]>([]);
  useEffect(() => {
    void api.listGoals().then(setGoals);
  }, []);

  // 优化项 8：手动保存——把备注（唯一「改了还没写」的字段）立刻写进去，并报时间/分诊报错
  const { saving, run } = useManualSave();
  const saveNow = (): void => {
    void run(() => props.onSave({ note }));
  };

  return (
    <div className="drawer">
      <div className="row">
        <span className="muted" style={{ flex: 1 }}>
          任务详情 · 建于 {relative(task.created_at)}
          {task.completed_at ? ` · 完成于 ${relative(task.completed_at)}` : ''}
        </span>
        <button type="button" className="icon-btn" title="收起" onClick={props.onClose}>
          ▲
        </button>
      </div>

      <div className="field">
        <label>优先级</label>
        <select
          value={task.priority}
          onChange={(e) => props.onPatch({ priority: e.target.value as TaskPriority })}
        >
          {PRIORITY_ORDER.map((p) => (
            <option key={p} value={p}>
              {PRIORITY_LABEL[p]}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label>截止日</label>
        <input
          type="date"
          value={task.due_at ? task.due_at.slice(0, 10) : ''}
          onChange={(e) => props.onPatch({ due_at: e.target.value || null })}
        />
      </div>
      <div className="field">
        <label>提醒时间</label>
        <input
          type="datetime-local"
          value={task.remind_at ? task.remind_at.replace(' ', 'T').slice(0, 16) : ''}
          onChange={(e) => props.onPatch({ remind_at: e.target.value ? e.target.value.replace('T', ' ') : null })}
        />
        <span className="muted">
          {task.remind_at ? `到 ${fmtDateTime(task.remind_at)} 会进首页提醒` : '留空就按截止日提醒'}
        </span>
      </div>
      <div className="field">
        <label>挂在目标</label>
        <select
          value={task.goal_id ?? ''}
          onChange={(e) => props.onPatch({ goal_id: e.target.value ? Number(e.target.value) : null })}
        >
          <option value="">不挂</option>
          {goals.map((g) => (
            <option key={g.id} value={g.id}>
              {g.title}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label>重复</label>
        <select
          value={task.repeat_rule}
          onChange={(e) => props.onPatch({ repeat_rule: e.target.value as Task['repeat_rule'] })}
        >
          {Object.entries(REPEAT_LABEL).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
        <span className="muted">勾完之后按这个规则生成下一次</span>
      </div>
      <div className="field" style={{ alignItems: 'flex-start' }}>
        <label style={{ paddingTop: 6 }}>备注</label>
        <textarea
          rows={3}
          value={note}
          placeholder="补充说明、想到的步骤，随便写"
          onChange={(e) => setNote(e.target.value)}
          onBlur={() => {
            if (note !== task.note) props.onPatch({ note });
          }}
        />
      </div>
      <div className="row" style={{ marginTop: 4 }}>
        <span className="muted" style={{ flex: 1 }}>
          改完点一下保存，立刻写进数据文件
        </span>
        <SaveButton saving={saving} primary onClick={saveNow} />
      </div>
      <div className="row">
        <span className="muted" style={{ flex: 1 }}>
          {task.goal_id ? `挂在目标 #${task.goal_id} 上` : '还没挂到目标上'}
          {task.plan_id ? ` · 学习计划 #${task.plan_id}` : ''}
        </span>
        <button
          type="button"
          className="btn sm"
          onClick={() =>
            props.onPatch({ status: task.status === 'done' ? 'todo' : 'done' })
          }
        >
          {task.status === 'done' ? '标成没做完' : '标记完成'}
        </button>
      </div>
    </div>
  );
}
