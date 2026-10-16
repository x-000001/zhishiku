import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { api } from '../api';
import { Empty, toast } from '../ui';
import { fmtDate, relative } from '../format';
import type { DashboardData, Task } from '../../../shared/types';

export default function Dashboard(props: {
  navigate: (route: string) => void;
  refreshCount: () => void;
  openNote: (id: number) => void;
}): ReactNode {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    api
      .dashboard()
      .then((d) => {
        setData(d);
        setError('');
      })
      .catch((err: Error) => setError(err.message));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // 从别的地方切回窗口（比如快速记录小窗、托盘、别的程序）时，首页重新算一遍，
  // 免得停在这一页看到的是旧数字。
  useEffect(() => {
    const onFocus = () => load();
    const onVisible = () => {
      if (!document.hidden) load();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load]);

  if (error) {
    return (
      <div className="card">
        <b>首页数据没读出来</b>
        <p className="muted">{error}</p>
        <button type="button" className="btn" onClick={load}>
          重试
        </button>
      </div>
    );
  }

  if (!data) return <Empty>正在读取…</Empty>;

  const toggle = async (task: Task) => {
    try {
      const res = await api.toggleTask(task.id, task.status === 'done' ? 'todo' : 'done');
      if (res.spawned) toast('已勾掉，并按重复规则生成下一次');
      else toast('已完成');
      load();
    } catch (err) {
      toast('操作失败：' + (err as Error).message);
    }
  };

  return (
    <div className="dash-grid">
      <div>
        <div className="card">
          <div className="card-head">
            <h2>今日待办</h2>
            <span className="spacer" />
            <button type="button" className="btn ghost sm" onClick={() => props.navigate('/tasks')}>
              去任务页
            </button>
          </div>
          <div className="stat-row" style={{ marginBottom: 12 }}>
            <div className="stat">
              <b>{data.tasks.length}</b>
              <span>今天要做的</span>
            </div>
            <div className={data.overdueCount ? 'stat alarm' : 'stat'}>
              <b>{data.overdueCount}</b>
              <span>已经逾期</span>
            </div>
            <div className="stat good">
              <b>{data.doneTodayCount}</b>
              <span>今天已完成</span>
            </div>
          </div>
          <div className="list">
            {data.tasks.map((task) => (
              <div
                key={task.id}
                className={
                  task.status === 'done' ? 'list-row done' : task.overdue ? 'list-row overdue' : 'list-row'
                }
              >
                <button
                  type="button"
                  className="check"
                  title="标记完成"
                  onClick={() => void toggle(task)}
                >
                  ✓
                </button>
                <span className={`dot prio-${task.priority}`} />
                <div className="grow">
                  <div className="title">{task.title}</div>
                  <div className="sub">
                    {task.due_at ? fmtDate(task.due_at) : '无截止日'}
                    {task.overdue ? ' · 已逾期' : ''}
                  </div>
                </div>
              </div>
            ))}
            {data.tasks.length === 0 ? <Empty>今天没有到期任务，松一口气。</Empty> : null}
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <h2>最近笔记</h2>
            <span className="spacer" />
            <button type="button" className="btn ghost sm" onClick={() => props.navigate('/knowledge')}>
              去知识库
            </button>
          </div>
          <div className="list">
            {data.recentNotes.map((note) => (
              <div key={note.id} className="list-row" onClick={() => props.openNote(note.id)}>
                <span>{note.is_pinned ? '📌' : '📄'}</span>
                <div className="grow">
                  <div className="title">{note.title || '无标题笔记'}</div>
                  <div className="sub">
                    {note.category_name ?? '未分类'} · {relative(note.updated_at)} · {note.word_count} 字
                  </div>
                </div>
              </div>
            ))}
            {data.recentNotes.length === 0 ? <Empty>还没有笔记，去知识库写第一篇。</Empty> : null}
          </div>
        </div>
      </div>

      <div>
        <div className="card">
          <div className="card-head">
            <h2>快捷创建</h2>
          </div>
          <div className="quick-actions">
            <button type="button" className="btn" onClick={() => props.navigate('/inbox')}>
              📥 记一条想法
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                void api.createNote({}).then((note) => {
                  if (note) props.openNote(note.id);
                  toast('已新建笔记');
                });
              }}
            >
              📄 新建笔记
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                void api.createTask({ title: '新任务', priority: 'normal' }).then(() => {
                  props.navigate('/tasks');
                  toast('已加一条任务，记得改标题和截止日');
                });
              }}
            >
              ✅ 新建任务
            </button>
            <button type="button" className="btn" onClick={() => props.navigate('/review')}>
              🔁 开始复习
            </button>
          </div>
          <p className="muted" style={{ marginTop: 10 }}>
            快捷键：<span className="kbd">Ctrl+Alt+Space</span> 随时呼出快速记录
          </p>
        </div>

        <div className="card">
          <div className="card-head">
            <h2>当前目标进度</h2>
            <span className="spacer" />
            <button type="button" className="btn ghost sm" onClick={() => props.navigate('/goals')}>
              目标页
            </button>
          </div>
          {data.goals.length === 0 ? (
            <Empty>还没有进行中的目标。</Empty>
          ) : (
            data.goals.map((goal) => {
              const pct = Math.max(0, Math.min(100, goal.progress));
              return (
                <div key={goal.id} className="goal-row">
                  {/* 环形进度：百分比写进 CSS 变量，conic-gradient 画环，CSS 里给 --p 加了过渡 */}
                  <div
                    className="goal-ring"
                    data-progress={goal.progress}
                    style={{ '--p': `${pct}%` } as CSSProperties}
                  >
                    <span>{goal.progress}%</span>
                  </div>
                  <div className="grow">
                    <div className="goal-title">{goal.title}</div>
                    <div className="progress">
                      <i style={{ width: `${pct}%` }} />
                    </div>
                    {goal.target_date ? (
                      <div className="muted goal-date">目标日期 {goal.target_date}</div>
                    ) : null}
                  </div>
                </div>
              );
            })
          )}
        </div>

        <div className="card">
          <div className="card-head">
            <h2>今日计划</h2>
            <span className="spacer" />
            <button type="button" className="btn ghost sm" onClick={() => props.navigate('/plans')}>
              计划页
            </button>
          </div>
          {data.todayPlan.length === 0 ? (
            <Empty>今天还没有排计划条目。</Empty>
          ) : (
            <div className="list">
              {data.todayPlan.map((item) => (
                <div key={item.id} className={item.done ? 'list-row done' : 'list-row'}>
                  <button
                    type="button"
                    className={item.done ? 'check on' : 'check'}
                    title={item.done ? '改回未完成' : '标记完成'}
                    onClick={() => {
                      void api
                        .togglePlanItem(item.id, !item.done)
                        .then(load)
                        .catch((err: Error) => toast('操作失败：' + err.message));
                    }}
                  >
                    ✓
                  </button>
                  <div className="grow">
                    <div className="title">{item.title}</div>
                    <div className="sub">
                      {item.plan_title}
                      {item.minutes ? ` · 预计 ${item.minutes} 分钟` : ''}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="card">
          <div className="card-head">
            <h2>复习提醒</h2>
            <span className="spacer" />
            <button type="button" className="btn ghost sm" onClick={() => props.navigate('/review')}>
              {data.reviewDueCount > 0 ? `去复习（${data.reviewDueCount}）` : '去复习'}
            </button>
          </div>
          {data.reviewDue.length === 0 ? (
            <Empty>今天没有要复习的内容。</Empty>
          ) : (
            <div className="list">
              {data.reviewDue.slice(0, 6).map((card) => (
                <div
                  key={card.id}
                  className="list-row"
                  onClick={() => card.note_id && props.openNote(card.note_id)}
                >
                  <span>🔁</span>
                  <div className="grow">
                    <div className="title">{card.front || '（无标题复习卡）'}</div>
                    <div className="sub">{fmtDate(card.next_review_at)}该复习</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="card">
          <div className="card-head">
            <h2>收集箱</h2>
          </div>
          <div className="stat-row">
            <div className="stat">
              <b>{data.inboxCount}</b>
              <span>条等待整理</span>
            </div>
            <button type="button" className="btn" onClick={() => props.navigate('/inbox')}>
              去整理
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
