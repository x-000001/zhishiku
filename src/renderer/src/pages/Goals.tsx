import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from '../api';
import { ConfirmDialog, Empty, toast } from '../ui';
import { SaveButton, useManualSave } from '../save';
import { fmtDate } from '../format';
import type { GoalDetail, GoalSummary, Id } from '../../../shared/types';import { toastError, errText } from '../errors';

/**
 * 当前目标：最多 3 个在跑，进度由关键结果与关联任务自动汇总。
 * 左栏选目标，右栏拆关键结果 / 里程碑 / 挂任务。
 */
export default function Goals(props: { refreshCount: () => void }): ReactNode {
  const [goals, setGoals] = useState<GoalSummary[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [selected, setSelected] = useState<Id | null>(null);
  const [detail, setDetail] = useState<GoalDetail | null>(null);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [confirmDelete, setConfirmDelete] = useState<GoalSummary | null>(null);
  const [krDraft, setKrDraft] = useState('');
  const [msDraft, setMsDraft] = useState('');
  const [msDate, setMsDate] = useState('');
  const [goalNote, setGoalNote] = useState('');
  const titleRef = useRef<HTMLInputElement>(null);
  const dateRef = useRef<HTMLInputElement>(null);
  const addRef = useRef<HTMLInputElement>(null);

  const load = useCallback(
    (keepSelection = true) => {
      return api
        .listGoals(showArchived)
        .then((list) => {
          setGoals(list);
          setSelected((current) => {
            if (keepSelection && current && list.some((g) => g.id === current)) return current;
            return list[0]?.id ?? null;
          });
        })
        .catch((err) => toastError('读取目标失败：', err))
        .finally(() => setLoading(false));
    },
    [showArchived]
  );

  const loadDetail = useCallback((id: Id | null) => {
    if (!id) {
      setDetail(null);
      return;
    }
    void api
      .getGoal(id)
      .then((d) => {
        setDetail(d);
        setGoalNote(d?.goal.description ?? '');
      })
      .catch((err) => toastError('读不到目标详情：', err));
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  useEffect(() => {
    loadDetail(selected);
  }, [selected, loadDetail]);

  const createGoal = async (): Promise<void> => {
    const title = draft.trim();
    if (!title) return;
    try {
      const id = await api.createGoal({ title });
      setDraft('');
      setShowArchived(false);
      await load(false);
      setSelected(id);
      props.refreshCount();
      toast('目标建好了，接着拆关键结果');
    } catch (err) {
      toast(errText(err));
    }
  };

  const patchGoal = async (id: Id, patch: Parameters<typeof api.updateGoal>[1]): Promise<void> => {
    try {
      await api.updateGoal(id, patch);
      await load();
      loadDetail(id);
      props.refreshCount();
    } catch (err) {
      toastError('改不动：', err);
    }
  };

  // 优化项 8：手动保存。标题和目标日期是「没失焦就还没落库」的两个输入框，
  // 这里直接把当前输入框里的值一起写一遍，点一下就是一次真写盘。
  const { saving, run: runSave } = useManualSave();
  const saveGoalNow = (): void => {
    if (!detail) return;
    const g = detail.goal;
    const title = titleRef.current?.value.trim() || g.title;
    const targetDate = dateRef.current?.value || null;
    void runSave(async () => {
      await api.updateGoal(g.id, { title, target_date: targetDate, description: goalNote });
      await load();
      loadDetail(g.id);
      props.refreshCount();
    });
  };

  const addKeyResult = async (): Promise<void> => {
    const title = krDraft.trim();
    if (!title || !detail) return;
    try {
      await api.createKeyResult(detail.goal.id, { title, target_value: 1, current_value: 0 });
      setKrDraft('');
      await load();
      loadDetail(detail.goal.id);
    } catch (err) {
      toastError('加不上：', err);
    }
  };

  const addMilestone = async (): Promise<void> => {
    const title = msDraft.trim();
    if (!title || !detail) return;
    try {
      await api.createMilestone(detail.goal.id, { title, target_date: msDate || null });
      setMsDraft('');
      setMsDate('');
      await load();
      loadDetail(detail.goal.id);
    } catch (err) {
      toastError('加不上：', err);
    }
  };

  const refreshAll = async (id: Id): Promise<void> => {
    await load();
    loadDetail(id);
    props.refreshCount();
  };

  const removeGoal = async (goal: GoalSummary): Promise<void> => {
    try {
      await api.deleteGoal(goal.id);
      setSelected(null);
      setDetail(null);
      await load(false);
      props.refreshCount();
      toast('目标已删除（挂着的任务保留，只是不再关联）');
    } catch (err) {
      toastError('删除失败：', err);
    }
  };

  return (
    <div className="kb">
      {/* 左栏：目标列表 */}
      <div className="kb-tree">
        <div className="row" style={{ marginBottom: 8 }}>
          <span className="muted" style={{ fontSize: 12, flex: 1 }}>
            当前目标 {goals.filter((g) => g.status === 'active').length}/3
          </span>
          <button
            type="button"
            className="btn ghost sm"
            onClick={() => setShowArchived((v) => !v)}
            title="把已经归档的目标也列出来"
          >
            {showArchived ? '看进行中' : '看归档'}
          </button>
        </div>

        {loading ? (
          <Empty>正在读取…</Empty>
        ) : goals.length === 0 ? (
          <Empty>{showArchived ? '还没有归档过的目标。' : '还没有目标，在下面输入框里写一个。'}</Empty>
        ) : (
          goals.map((goal) => (
            <div
              key={goal.id}
              className={selected === goal.id ? 'tree-item selected' : 'tree-item'}
              onClick={() => setSelected(goal.id)}
            >
              <span>{goal.status === 'done' ? '🏁' : goal.status === 'archived' ? '📦' : '🎯'}</span>
              <span className="name">{goal.title}</span>
              <span className="muted">{goal.progress}%</span>
            </div>
          ))
        )}

        <div style={{ height: 10 }} />
        <input
          ref={addRef}
          placeholder="新建目标，回车加上"
          value={draft}
          style={{ width: '100%' }}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void createGoal();
            }
          }}
        />
        <div style={{ height: 8 }} />
        <button type="button" className="btn sm" style={{ width: '100%' }} onClick={() => void createGoal()}>
          ＋ 新建目标
        </button>

        <div style={{ height: 14 }} />
        <div className="muted" style={{ fontSize: 12, lineHeight: 1.9 }}>
          · 同时最多 3 个在跑
          <br />· 进度 = 关键结果完成度 + 关联任务完成率
          <br />· 两个都没有时看里程碑
        </div>
      </div>

      {/* 右栏：目标详情 */}
      <div className="kb-editor">
        {!detail ? (
          <Empty>左边选一个目标，或者先建一个。</Empty>
        ) : (
          <>
            <div className="editor-head">
              <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
                <input
                  className="inline-title"
                  ref={titleRef}
                  defaultValue={detail.goal.title}
                  style={{ fontSize: 16, fontWeight: 650, minWidth: 220 }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                  }}
                  onBlur={(e) => {
                    const value = e.target.value.trim();
                    if (!value) {
                      e.target.value = detail.goal.title;
                      return;
                    }
                    if (value !== detail.goal.title) void patchGoal(detail.goal.id, { title: value });
                  }}
                />
                <span className="badge">{detail.goal.progress}%</span>
                <span className="spacer" style={{ flex: 1 }} />
                <SaveButton saving={saving} primary onClick={saveGoalNow} />
                <button
                  type="button"
                  className="btn sm"
                  onClick={() =>
                    void patchGoal(detail.goal.id, {
                      status: detail.goal.status === 'active' ? 'archived' : 'active'
                    })
                  }
                >
                  {detail.goal.status === 'active' ? '归档目标' : '重新激活'}
                </button>
                <button
                  type="button"
                  className="btn sm"
                  onClick={() => void patchGoal(detail.goal.id, { status: 'done' })}
                  title="标记成已完成"
                >
                  标记完成
                </button>
                <button type="button" className="btn sm" onClick={() => setConfirmDelete(detail.goal)}>
                  删除
                </button>
              </div>
            </div>

            <div className="editor-body" style={{ padding: 14, overflow: 'auto' }}>
              <div className="progress" style={{ marginBottom: 14 }}>
                <i style={{ width: `${Math.min(100, detail.goal.progress)}%` }} />
              </div>

              <div className="stat-row" style={{ marginBottom: 14 }}>
                <div className="stat">
                  <b>{detail.keyResults.length}</b>
                  <span>关键结果</span>
                </div>
                <div className="stat">
                  <b>{detail.milestones.filter((m) => m.done).length}/{detail.milestones.length}</b>
                  <span>里程碑</span>
                </div>
                <div className="stat">
                  <b>{detail.tasks.filter((t) => t.status === 'done').length}/{detail.tasks.length}</b>
                  <span>关联任务</span>
                </div>
                <div className="stat">
                  <b>{detail.goal.target_date ? fmtDate(detail.goal.target_date) : '没定'}</b>
                  <span>目标日期</span>
                </div>
              </div>

              <div className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
                <div className="field" style={{ flex: 1 }}>
                  <label>目标日期</label>
                  <input
                    type="date"
                    ref={dateRef}
                    defaultValue={detail.goal.target_date ?? ''}
                    onBlur={(e) => {
                      const value = e.target.value || null;
                      if (value !== detail.goal.target_date) void patchGoal(detail.goal.id, { target_date: value });
                    }}
                  />
                </div>
                <div className="field" style={{ flex: 2 }}>
                  <label>为什么想做 / 做到什么算成功</label>
                  <textarea
                    rows={2}
                    value={goalNote}
                    placeholder="写清楚动机和验收标准，之后复盘用得上"
                    onChange={(e) => setGoalNote(e.target.value)}
                    onBlur={() => {
                      if (goalNote !== detail.goal.description) {
                        void patchGoal(detail.goal.id, { description: goalNote });
                      }
                    }}
                  />
                </div>
              </div>

              {/* 关键结果 */}
              <div className="card" style={{ marginTop: 14 }}>
                <div className="card-head">
                  <h2>关键结果</h2>
                  <span className="spacer" />
                  <span className="muted">有数值才有进度</span>
                </div>
                {detail.keyResults.length === 0 ? (
                  <Empty>还没有关键结果。写一条可以量化的，比如「跑步 100 公里」。</Empty>
                ) : (
                  detail.keyResults.map((kr) => (
                    <div key={kr.id} className="kr-row">
                      <input
                        className="inline-title"
                        defaultValue={kr.title}
                        style={{ flex: 1 }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                        }}
                        onBlur={(e) => {
                          const value = e.target.value.trim();
                          if (!value) {
                            e.target.value = kr.title;
                            return;
                          }
                          if (value !== kr.title) {
                            void api.updateKeyResult(kr.id, { title: value }).then(() => refreshAll(detail.goal.id));
                          }
                        }}
                      />
                      <input
                        type="number"
                        style={{ width: 74 }}
                        value={kr.current_value}
                        onChange={(e) => {
                          const v = Number(e.target.value);
                          void api.updateKeyResult(kr.id, { current_value: v }).then(() => refreshAll(detail.goal.id));
                        }}
                      />
                      <span className="muted">/</span>
                      <input
                        type="number"
                        style={{ width: 74 }}
                        value={kr.target_value}
                        onChange={(e) => {
                          const v = Number(e.target.value);
                          void api.updateKeyResult(kr.id, { target_value: v }).then(() => refreshAll(detail.goal.id));
                        }}
                      />
                      <input
                        placeholder="单位"
                        style={{ width: 72 }}
                        defaultValue={kr.unit}
                        onBlur={(e) => {
                          if (e.target.value !== kr.unit) {
                            void api.updateKeyResult(kr.id, { unit: e.target.value }).then(() => refreshAll(detail.goal.id));
                          }
                        }}
                      />
                      <button
                        type="button"
                        className="icon-btn"
                        title="删掉这条"
                        onClick={() => {
                          void api.deleteKeyResult(kr.id).then(() => refreshAll(detail.goal.id));
                        }}
                      >
                        🗑
                      </button>
                    </div>
                  ))
                )}
                <div className="row" style={{ marginTop: 8, gap: 8 }}>
                  <input
                    placeholder="加一条关键结果，回车"
                    value={krDraft}
                    style={{ flex: 1 }}
                    onChange={(e) => setKrDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                        e.preventDefault();
                        void addKeyResult();
                      }
                    }}
                  />
                  <button type="button" className="btn sm" onClick={() => void addKeyResult()}>
                    加上
                  </button>
                </div>
              </div>

              {/* 里程碑 */}
              <div className="card">
                <div className="card-head">
                  <h2>里程碑</h2>
                  <span className="spacer" />
                  <span className="muted">阶段性的检查点</span>
                </div>
                {detail.milestones.length === 0 ? (
                  <Empty>还没有里程碑。比如「第 1 个月：能读懂 TypeScript 类型报错」。</Empty>
                ) : (
                  <div className="list timeline">
                    {detail.milestones.map((m) => (
                      <div key={m.id} className={m.done ? 'list-row done' : 'list-row'}>
                        <button
                          type="button"
                          className={m.done ? 'check on' : 'check'}
                          title={m.done ? '取消完成' : '标记完成'}
                          onClick={() => {
                            void api.toggleMilestone(m.id).then(() => refreshAll(detail.goal.id));
                          }}
                        >
                          ✓
                        </button>
                        <div className="grow">
                          <div className="title">
                            {m.title}
                          </div>
                          <div className="sub">
                            {m.target_date ? fmtDate(m.target_date) : '没定时间'}
                            {m.done_at ? ' · 已完成' : ''}
                          </div>
                        </div>
                        <input
                          type="date"
                          defaultValue={m.target_date ?? ''}
                          style={{ width: 138 }}
                          onChange={(e) => {
                            void api
                              .updateMilestone(m.id, { target_date: e.target.value || null })
                              .then(() => refreshAll(detail.goal.id));
                          }}
                        />
                        <button
                          type="button"
                          className="icon-btn"
                          title="删掉"
                          onClick={() => {
                            void api.deleteMilestone(m.id).then(() => refreshAll(detail.goal.id));
                          }}
                        >
                          🗑
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="row" style={{ marginTop: 8, gap: 8 }}>
                  <input
                    placeholder="加一个里程碑，回车"
                    value={msDraft}
                    style={{ flex: 1 }}
                    onChange={(e) => setMsDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                        e.preventDefault();
                        void addMilestone();
                      }
                    }}
                  />
                  <input type="date" value={msDate} onChange={(e) => setMsDate(e.target.value)} style={{ width: 138 }} />
                  <button type="button" className="btn sm" onClick={() => void addMilestone()}>
                    加上
                  </button>
                </div>
              </div>

              {/* 关联任务 */}
              <div className="card">
                <div className="card-head">
                  <h2>关联任务</h2>
                  <span className="spacer" />
                  <span className="muted">任务页里把「挂在目标」选成它就行</span>
                </div>
                {detail.tasks.length === 0 ? (
                  <Empty>还没有挂到这个目标下的任务。</Empty>
                ) : (
                  <div className="list">
                    {detail.tasks.map((t) => (
                      <div key={t.id} className="list-row">
                        <button
                          type="button"
                          className={t.status === 'done' ? 'check on' : 'check'}
                          title={t.status === 'done' ? '取消完成' : '标记完成'}
                          onClick={() => {
                            void api
                              .toggleTask(t.id, t.status === 'done' ? 'todo' : 'done')
                              .then(() => refreshAll(detail.goal.id));
                          }}
                        >
                          ✓
                        </button>
                        <span className={`dot prio-${t.priority}`} />
                        <div className="grow">
                          <div className="title" style={t.status === 'done' ? { textDecoration: 'line-through' } : undefined}>
                            {t.title}
                          </div>
                          <div className="sub">{t.due_at ? fmtDate(t.due_at) : '无截止日'}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </div>

      {confirmDelete ? (
        <ConfirmDialog
          title="删除目标"
          message={
            <>
              确定删除「<b>{confirmDelete.title}</b>」吗？
              <br />
              关键结果和里程碑会一起清掉，挂在这个目标下的任务会保留，只是不再关联。
            </>
          }
          confirmLabel="删除"
          danger
          onCancel={() => setConfirmDelete(null)}
          onConfirm={async () => {
            await removeGoal(confirmDelete);
            setConfirmDelete(null);
          }}
        />
      ) : null}
    </div>
  );
}
