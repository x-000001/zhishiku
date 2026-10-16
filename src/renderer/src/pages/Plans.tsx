import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from '../api';
import { Empty, toast } from '../ui';
import { fmtDate, todayLocal } from '../format';
import type { CalendarEntry, GoalSummary, Id, PlanDetail, PlanSummary } from '../../../shared/types';

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];

function pad(n: number): string {
  return String(n).padStart(2, '0');
}
function dayKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
/** 从周一开始的 6×7 网格，前后补上下月的日子。 */
function monthMatrix(year: number, month: number): Date[] {
  const first = new Date(year, month, 1);
  const offset = (first.getDay() + 6) % 7; // 周一 = 0
  const start = new Date(year, month, 1 - offset);
  return Array.from({ length: 42 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
}

/**
 * 学习计划：先定方向和节奏，再把条目排到具体日期上；
 * 日历视图按月看每天要学什么，条目可以挂在当前目标下。
 */
export default function Plans(props: { refreshCount: () => void }): ReactNode {
  const [plans, setPlans] = useState<PlanSummary[]>([]);
  const [selected, setSelected] = useState<Id | null>(null);
  const [detail, setDetail] = useState<PlanDetail | null>(null);
  const [goals, setGoals] = useState<GoalSummary[]>([]);
  const [tab, setTab] = useState<'items' | 'calendar'>('items');
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState('');
  const [itemDraft, setItemDraft] = useState('');
  const [itemDate, setItemDate] = useState(todayLocal());
  const [itemMinutes, setItemMinutes] = useState(30);
  const [cursor, setCursor] = useState(() => {
    const d = new Date();
    return { year: d.getFullYear(), month: d.getMonth() };
  });
  const [entries, setEntries] = useState<CalendarEntry[]>([]);

  const load = useCallback((keep = true) => {
    return api
      .listPlans()
      .then((list) => {
        setPlans(list);
        setSelected((current) => (keep && current && list.some((p) => p.id === current) ? current : (list[0]?.id ?? null)));
      })
      .catch((err: Error) => toast('读取学习计划失败：' + err.message))
      .finally(() => setLoading(false));
  }, []);

  const loadDetail = useCallback((id: Id | null) => {
    if (!id) {
      setDetail(null);
      return;
    }
    void api.getPlan(id).then(setDetail);
  }, []);

  const loadCalendar = useCallback(() => {
    const days = monthMatrix(cursor.year, cursor.month);
    const from = dayKey(days[0]);
    const to = dayKey(days[days.length - 1]);
    void api.calendar(from, to).then(setEntries);
  }, [cursor]);

  useEffect(() => {
    void load(false);
    void api.listGoals().then(setGoals);
  }, [load]);

  useEffect(() => {
    loadDetail(selected);
  }, [selected, loadDetail]);

  useEffect(() => {
    if (tab === 'calendar') loadCalendar();
  }, [tab, loadCalendar]);

  const byDay = useMemo(() => {
    const map = new Map<string, CalendarEntry[]>();
    entries.forEach((e) => {
      if (!e.date) return;
      const key = e.date.slice(0, 10);
      map.set(key, [...(map.get(key) ?? []), e]);
    });
    return map;
  }, [entries]);

  const createPlan = async (): Promise<void> => {
    const title = draft.trim();
    if (!title) return;
    try {
      const id = await api.createPlan({ title, start_date: todayLocal() });
      setDraft('');
      await load(false);
      setSelected(id);
      props.refreshCount();
      toast('计划建好了，接着往里排条目');
    } catch (err) {
      toast('建不上：' + (err as Error).message);
    }
  };

  const patchPlan = async (id: Id, patch: Parameters<typeof api.updatePlan>[1]): Promise<void> => {
    try {
      await api.updatePlan(id, patch);
      await load();
      loadDetail(id);
      props.refreshCount();
    } catch (err) {
      toast('改不动：' + (err as Error).message);
    }
  };

  const addItem = async (date?: string): Promise<void> => {
    const title = itemDraft.trim();
    if (!title || !detail) return;
    try {
      await api.createPlanItem(detail.plan.id, {
        title,
        date: date ?? itemDate ?? null,
        minutes: Number(itemMinutes) || 0
      });
      setItemDraft('');
      await load();
      loadDetail(detail.plan.id);
      if (tab === 'calendar') loadCalendar();
    } catch (err) {
      toast('加不上：' + (err as Error).message);
    }
  };

  const toggleItem = async (id: Id, done?: boolean): Promise<void> => {
    await api.togglePlanItem(id, done);
    if (detail) loadDetail(detail.plan.id);
    await load();
    if (tab === 'calendar') loadCalendar();
  };

  const removePlan = async (plan: PlanSummary): Promise<void> => {
    try {
      await api.deletePlan(plan.id);
      setSelected(null);
      setDetail(null);
      await load(false);
      props.refreshCount();
      toast('计划已删除');
    } catch (err) {
      toast('删除失败：' + (err as Error).message);
    }
  };

  const days = monthMatrix(cursor.year, cursor.month);

  return (
    <div className="kb">
      <div className="kb-tree">
        <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
          学习计划
        </div>
        {loading ? (
          <Empty>正在读取…</Empty>
        ) : plans.length === 0 ? (
          <Empty>还没有学习计划。</Empty>
        ) : (
          plans.map((plan) => (
            <div
              key={plan.id}
              className={selected === plan.id ? 'tree-item selected' : 'tree-item'}
              onClick={() => setSelected(plan.id)}
              title={plan.direction || plan.title}
            >
              <span>{plan.status === 'done' ? '🏁' : plan.status === 'paused' ? '⏸' : '📅'}</span>
              <span className="name">{plan.title}</span>
              <span className="muted">
                {plan.done_count}/{plan.item_count}
              </span>
            </div>
          ))
        )}

        <div style={{ height: 10 }} />
        <input
          placeholder="新建学习方向，回车"
          value={draft}
          style={{ width: '100%' }}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void createPlan();
            }
          }}
        />
        <div style={{ height: 8 }} />
        <button type="button" className="btn sm" style={{ width: '100%' }} onClick={() => void createPlan()}>
          ＋ 新建计划
        </button>

        <div style={{ height: 14 }} />
        <div className="muted" style={{ fontSize: 12, lineHeight: 1.9 }}>
          · 方向 + 节奏 + 条目
          <br />· 条目排到具体日期就能在日历里看到
          <br />· 可以挂在当前目标下，进度会算进目标
        </div>
      </div>

      <div className="kb-editor">
        {!detail ? (
          <Empty>左边选一个计划，或者先建一个。</Empty>
        ) : (
          <>
            <div className="editor-head">
              <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
                <input
                  className="inline-title"
                  defaultValue={detail.plan.title}
                  style={{ fontSize: 16, fontWeight: 650, minWidth: 200 }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                  }}
                  onBlur={(e) => {
                    const value = e.target.value.trim();
                    if (!value) {
                      e.target.value = detail.plan.title;
                      return;
                    }
                    if (value !== detail.plan.title) void patchPlan(detail.plan.id, { title: value });
                  }}
                />
                <span className="badge">
                  {detail.plan.done_count}/{detail.plan.item_count} 条
                </span>
                <span className="spacer" style={{ flex: 1 }} />
                <div className="tabs">
                  <button type="button" className={tab === 'items' ? 'on' : ''} onClick={() => setTab('items')}>
                    计划内容
                  </button>
                  <button type="button" className={tab === 'calendar' ? 'on' : ''} onClick={() => setTab('calendar')}>
                    日历视图
                  </button>
                </div>
                <button type="button" className="btn sm" onClick={() => void removePlan(detail.plan)}>
                  删除
                </button>
              </div>
            </div>

            <div className="editor-body" style={{ padding: 14, overflow: 'auto' }}>
              <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                <div className="field" style={{ flex: 1, minWidth: 150 }}>
                  <label>方向</label>
                  <input
                    defaultValue={detail.plan.direction}
                    placeholder="比如「前端工程化」"
                    onBlur={(e) => {
                      if (e.target.value !== detail.plan.direction) {
                        void patchPlan(detail.plan.id, { direction: e.target.value });
                      }
                    }}
                  />
                </div>
                <div className="field" style={{ flex: 1, minWidth: 150 }}>
                  <label>节奏</label>
                  <input
                    defaultValue={detail.plan.rhythm}
                    placeholder="比如「每天 30 分钟」"
                    onBlur={(e) => {
                      if (e.target.value !== detail.plan.rhythm) {
                        void patchPlan(detail.plan.id, { rhythm: e.target.value });
                      }
                    }}
                  />
                </div>
                <div className="field" style={{ minWidth: 140 }}>
                  <label>开始</label>
                  <input
                    type="date"
                    defaultValue={detail.plan.start_date ?? ''}
                    onChange={(e) => void patchPlan(detail.plan.id, { start_date: e.target.value || null })}
                  />
                </div>
                <div className="field" style={{ minWidth: 140 }}>
                  <label>结束</label>
                  <input
                    type="date"
                    defaultValue={detail.plan.end_date ?? ''}
                    onChange={(e) => void patchPlan(detail.plan.id, { end_date: e.target.value || null })}
                  />
                </div>
                <div className="field" style={{ minWidth: 150 }}>
                  <label>挂在目标</label>
                  <select
                    value={detail.plan.goal_id ?? ''}
                    onChange={(e) =>
                      void patchPlan(detail.plan.id, { goal_id: e.target.value ? Number(e.target.value) : null })
                    }
                  >
                    <option value="">不挂</option>
                    {goals.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.title}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field" style={{ minWidth: 120 }}>
                  <label>状态</label>
                  <select
                    value={detail.plan.status}
                    onChange={(e) => void patchPlan(detail.plan.id, { status: e.target.value as PlanSummary['status'] })}
                  >
                    <option value="active">进行中</option>
                    <option value="paused">暂停</option>
                    <option value="done">已完成</option>
                  </select>
                </div>
              </div>

              {tab === 'items' ? (
                <div className="card" style={{ marginTop: 14 }}>
                  <div className="card-head">
                    <h2>计划条目</h2>
                    <span className="spacer" />
                    <span className="muted">没日期也行，排到日期上才会进日历</span>
                  </div>
                  {detail.items.length === 0 ? (
                    <Empty>还没有条目。在下面写一条「今天学什么」。</Empty>
                  ) : (
                    <div className="list">
                      {detail.items.map((item) => (
                        <div key={item.id} className="list-row">
                          <button
                            type="button"
                            className={item.done ? 'check on' : 'check'}
                            title={item.done ? '取消完成' : '标记完成'}
                            onClick={() => void toggleItem(item.id)}
                          >
                            ✓
                          </button>
                          <div className="grow">
                            <div className="title" style={item.done ? { textDecoration: 'line-through' } : undefined}>
                              {item.title}
                            </div>
                            <div className="sub">
                              {item.date ? fmtDate(item.date) : '没排日期'}
                              {item.minutes ? ` · ${item.minutes} 分钟` : ''}
                              {item.done_at ? ' · 已完成' : ''}
                            </div>
                          </div>
                          <input
                            type="date"
                            defaultValue={item.date ?? ''}
                            style={{ width: 138 }}
                            onChange={(e) => {
                              void api
                                .updatePlanItem(item.id, { date: e.target.value || null })
                                .then(() => {
                                  loadDetail(detail.plan.id);
                                  return load();
                                });
                            }}
                          />
                          <input
                            type="number"
                            defaultValue={item.minutes || 0}
                            style={{ width: 68 }}
                            title="预计分钟数"
                            onBlur={(e) => {
                              const minutes = Number(e.target.value) || 0;
                              if (minutes !== item.minutes) {
                                void api.updatePlanItem(item.id, { minutes }).then(() => loadDetail(detail.plan.id));
                              }
                            }}
                          />
                          <button
                            type="button"
                            className="icon-btn"
                            title="删除"
                            onClick={() => {
                              void api.deletePlanItem(item.id).then(async () => {
                                loadDetail(detail.plan.id);
                                await load();
                              });
                            }}
                          >
                            🗑
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="row" style={{ marginTop: 10, gap: 8, flexWrap: 'wrap' }}>
                    <input
                      placeholder="这一节学什么，回车加上"
                      value={itemDraft}
                      style={{ flex: 1, minWidth: 180 }}
                      onChange={(e) => setItemDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                          e.preventDefault();
                          void addItem();
                        }
                      }}
                    />
                    <input type="date" value={itemDate} onChange={(e) => setItemDate(e.target.value)} style={{ width: 138 }} />
                    <input
                      type="number"
                      value={itemMinutes}
                      style={{ width: 78 }}
                      title="预计分钟数"
                      onChange={(e) => setItemMinutes(Number(e.target.value))}
                    />
                    <button type="button" className="btn sm" onClick={() => void addItem()}>
                      加上
                    </button>
                  </div>
                </div>
              ) : (
                <div className="card" style={{ marginTop: 14 }}>
                  <div className="card-head">
                    <button
                      type="button"
                      className="btn ghost sm"
                      onClick={() =>
                        setCursor((c) => (c.month === 0 ? { year: c.year - 1, month: 11 } : { ...c, month: c.month - 1 }))
                      }
                    >
                      ‹ 上个月
                    </button>
                    <h2 style={{ margin: '0 10px' }}>
                      {cursor.year} 年 {cursor.month + 1} 月
                    </h2>
                    <button
                      type="button"
                      className="btn ghost sm"
                      onClick={() =>
                        setCursor((c) => (c.month === 11 ? { year: c.year + 1, month: 0 } : { ...c, month: c.month + 1 }))
                      }
                    >
                      下个月 ›
                    </button>
                    <span className="spacer" />
                    <button
                      type="button"
                      className="btn ghost sm"
                      onClick={() => {
                        const now = new Date();
                        setCursor({ year: now.getFullYear(), month: now.getMonth() });
                      }}
                    >
                      回到今天
                    </button>
                  </div>

                  <div className="cal-head">
                    {WEEKDAYS.map((w) => (
                      <div key={w} className="cal-cell head">
                        周{w}
                      </div>
                    ))}
                  </div>
                  <div className="cal-grid">
                    {days.map((d) => {
                      const key = dayKey(d);
                      const list = byDay.get(key) ?? [];
                      const isToday = key === todayLocal();
                      const inMonth = d.getMonth() === cursor.month;
                      return (
                        <div
                          key={key}
                          className={`cal-cell${isToday ? ' today' : ''}${inMonth ? '' : ' out'}`}
                          title="双击在这一天加一条"
                          onDoubleClick={() => {
                            setItemDate(key);
                            setTab('items');
                            toast('日期已填好，写下这一节学什么');
                          }}
                        >
                          <div className="cal-day">{d.getDate()}</div>
                          {list.map((e) => (
                            <button
                              key={e.id}
                              type="button"
                              className={e.done ? 'cal-item done' : 'cal-item'}
                              title={`${e.plan_title} · ${e.minutes} 分钟（点一下切换完成）`}
                              onClick={() => void toggleItem(e.id)}
                            >
                              {e.title}
                            </button>
                          ))}
                        </div>
                      );
                    })}
                  </div>
                  <p className="muted" style={{ marginTop: 10 }}>
                    双击某天可以去那天加条目；点条目直接切换完成状态。
                  </p>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
