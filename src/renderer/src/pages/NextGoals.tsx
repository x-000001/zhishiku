import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api } from '../api';
import { Empty, toast } from '../ui';
import type { GoalHorizon, GoalPoolItem, Id, PoolStatus } from '../../../shared/types';import { toastError, errText } from '../errors';

const HORIZONS: { key: GoalHorizon | 'all' | 'started'; label: string; hint: string }[] = [
  { key: 'this', label: '近期', hint: '条件快成熟了，这阵子就能开工' },
  { key: 'next', label: '下一步', hint: '排在后面，但要开始准备了' },
  { key: 'later', label: '以后', hint: '先记下来，别让它占脑子' },
  { key: 'started', label: '已启动', hint: '已经变成当前目标了' },
  { key: 'all', label: '全部', hint: '所有记下来的想法' }
];

const HORIZON_LABEL: Record<GoalHorizon, string> = { this: '近期', next: '下一步', later: '以后' };
const STATUS_LABEL: Record<PoolStatus, string> = {
  pool: '池子里',
  ready: '待启动',
  started: '已启动',
  dropped: '已放弃'
};

/**
 * 下一阶段目标：把「现在还不能做但以后要做」的想法先放进来，
 * 写清楚为什么做、什么条件下启动；条件成熟了再一键变成当前目标。
 */
export default function NextGoals(props: { navigate: (route: string) => void; refreshCount: () => void }): ReactNode {
  const [tab, setTab] = useState<GoalHorizon | 'all' | 'started'>('this');
  const [items, setItems] = useState<GoalPoolItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState<Id | null>(null);
  const [draftTitle, setDraftTitle] = useState('');
  const [draftWhy, setDraftWhy] = useState('');
  const [draftWhen, setDraftWhen] = useState('');
  const [draftHorizon, setDraftHorizon] = useState<GoalHorizon>('later');

  const load = useCallback(() => {
    return api
      .listPool()
      .then(setItems)
      .catch((err) => toastError('读取目标池失败：', err))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const shown = items.filter((item) => {
    if (tab === 'all') return item.status !== 'dropped';
    if (tab === 'started') return item.status === 'started';
    return item.horizon === tab && item.status !== 'started' && item.status !== 'dropped';
  });

  const add = async (): Promise<void> => {
    const title = draftTitle.trim();
    if (!title) return;
    try {
      await api.createPool({
        title,
        why: draftWhy,
        start_condition: draftWhen,
        horizon: draftHorizon
      });
      setDraftTitle('');
      setDraftWhy('');
      setDraftWhen('');
      setDraftHorizon(tab === 'all' || tab === 'started' ? 'later' : tab);
      await load();
      toast('记下了，等条件成熟再启动');
    } catch (err) {
      toastError('存不上：', err);
    }
  };

  const patch = async (id: Id, changes: Partial<GoalPoolItem>): Promise<void> => {
    try {
      await api.updatePool(id, changes);
      await load();
    } catch (err) {
      toastError('改不动：', err);
    }
  };

  const start = async (item: GoalPoolItem): Promise<void> => {
    try {
      const { goalId } = await api.startPool(item.id);
      await load();
      props.refreshCount();
      toast(`「${item.title}」已经变成当前目标，去目标页拆关键结果`, {
        actionLabel: '去目标页',
        onAction: () => props.navigate('/goals')
      });
      void goalId;
    } catch (err) {
      toast(errText(err));
    }
  };

  const remove = async (item: GoalPoolItem): Promise<void> => {
    try {
      await api.deletePool(item.id);
      await load();
      toast('已删除');
    } catch (err) {
      toastError('删除失败：', err);
    }
  };

  const current = HORIZONS.find((h) => h.key === tab) ?? HORIZONS[0];

  return (
    <div className="dash-grid">
      <div>
        <div className="card">
          <div className="card-head">
            <h2>🚀 目标池</h2>
            <span className="spacer" />
            <span className="muted">{current.hint}</span>
          </div>

          <div className="tabs">
            {HORIZONS.map((h) => (
              <button
                key={h.key}
                type="button"
                className={tab === h.key ? 'on' : ''}
                onClick={() => setTab(h.key)}
              >
                {h.label}
                <span className="muted">
                  {' '}
                  {h.key === 'all'
                    ? items.filter((i) => i.status !== 'dropped').length
                    : h.key === 'started'
                      ? items.filter((i) => i.status === 'started').length
                      : items.filter((i) => i.horizon === h.key && i.status !== 'started' && i.status !== 'dropped').length}
                </span>
              </button>
            ))}
          </div>

          {loading ? (
            <Empty>正在读取…</Empty>
          ) : shown.length === 0 ? (
            <Empty>
              {tab === 'this'
                ? '近期没有排队的想法。以后想做的事可以先记到「以后」里。'
                : '这里还空着。'}
            </Empty>
          ) : (
            <div className="pool-list">
              {shown.map((item) => (
                <div key={item.id} className={openId === item.id ? 'pool-card open' : 'pool-card'}>
                  <div className="row" onClick={() => setOpenId(openId === item.id ? null : item.id)}>
                    <span className="badge">{HORIZON_LABEL[item.horizon]}</span>
                    <span className={`dot p${item.priority}`} title="优先级" />
                    <span style={{ flex: 1, fontWeight: 600 }}>{item.title}</span>
                    <span className={item.status === 'ready' ? 'badge ready' : 'badge'}>
                      {STATUS_LABEL[item.status]}
                    </span>
                  </div>

                  {item.start_condition ? (
                    <div className="muted" style={{ marginTop: 4 }}>
                      启动条件：{item.start_condition}
                    </div>
                  ) : null}

                  {openId === item.id ? (
                    <div style={{ marginTop: 10 }}>
                      <div className="field">
                        <label>为什么想做</label>
                        <textarea
                          rows={2}
                          defaultValue={item.why}
                          placeholder="写下动机。半年后回来看，这句话能帮你判断还值不值得做"
                          onBlur={(e) => {
                            if (e.target.value !== item.why) void patch(item.id, { why: e.target.value });
                          }}
                        />
                      </div>
                      <div className="field">
                        <label>什么条件下启动</label>
                        <input
                          defaultValue={item.start_condition}
                          placeholder="比如「等这个项目上线后」「攒够 2 万块」"
                          onBlur={(e) => {
                            if (e.target.value !== item.start_condition) {
                              void patch(item.id, { start_condition: e.target.value });
                            }
                          }}
                        />
                      </div>
                      <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
                        <div className="field" style={{ flex: 1 }}>
                          <label>地平线</label>
                          <select
                            value={item.horizon}
                            onChange={(e) => void patch(item.id, { horizon: e.target.value as GoalHorizon })}
                          >
                            <option value="this">近期</option>
                            <option value="next">下一步</option>
                            <option value="later">以后</option>
                          </select>
                        </div>
                        <div className="field" style={{ flex: 1 }}>
                          <label>优先级</label>
                          <select
                            value={item.priority}
                            onChange={(e) => void patch(item.id, { priority: Number(e.target.value) })}
                          >
                            <option value={3}>高</option>
                            <option value={2}>中</option>
                            <option value={1}>低</option>
                            <option value={0}>无</option>
                          </select>
                        </div>
                        <div className="field" style={{ flex: 1 }}>
                          <label>预计开始</label>
                          <input
                            type="date"
                            defaultValue={item.est_start ?? ''}
                            onChange={(e) => void patch(item.id, { est_start: e.target.value || null })}
                          />
                        </div>
                      </div>
                      <div className="row" style={{ marginTop: 10, gap: 8 }}>
                        {item.status === 'started' ? (
                          <button type="button" className="btn sm" onClick={() => props.navigate('/goals')}>
                            看当前目标
                          </button>
                        ) : (
                          <>
                            <button type="button" className="btn sm primary" onClick={() => void start(item)}>
                              启动，变成当前目标
                            </button>
                            <button
                              type="button"
                              className="btn sm"
                              title="条件还不成熟，先标成放弃"
                              onClick={() => void patch(item.id, { status: 'dropped' })}
                            >
                              放弃
                            </button>
                          </>
                        )}
                        <span className="spacer" style={{ flex: 1 }} />
                        <button type="button" className="btn sm" onClick={() => void remove(item)}>
                          删除
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div>
        <div className="card">
          <div className="card-head">
            <h2>记一个以后想做的事</h2>
          </div>
          <div className="field">
            <label>想做什么</label>
            <input
              placeholder="比如「学做菜」"
              value={draftTitle}
              onChange={(e) => setDraftTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void add();
                }
              }}
            />
          </div>
          <div className="field">
            <label>为什么想做</label>
            <textarea
              rows={2}
              placeholder="想清楚动机再记，回头才好判断"
              value={draftWhy}
              onChange={(e) => setDraftWhy(e.target.value)}
            />
          </div>
          <div className="field">
            <label>什么条件下启动</label>
            <input
              placeholder="填了就标成「待启动」"
              value={draftWhen}
              onChange={(e) => setDraftWhen(e.target.value)}
            />
          </div>
          <div className="field">
            <label>地平线</label>
            <select value={draftHorizon} onChange={(e) => setDraftHorizon(e.target.value as GoalHorizon)}>
              <option value="this">近期</option>
              <option value="next">下一步</option>
              <option value="later">以后</option>
            </select>
          </div>
          <button type="button" className="btn primary" style={{ width: '100%' }} onClick={() => void add()}>
            记下来
          </button>
        </div>

        <div className="card">
          <div className="card-head">
            <h2>怎么用这一页</h2>
          </div>
          <p className="muted" style={{ lineHeight: 1.9, margin: 0 }}>
            · 当前目标同时最多 3 个，别的地方放不下的就丢这儿
            <br />· 每条都写清「为什么」和「什么条件下启动」
            <br />· 启动条件满足了，点「启动」就变成当前目标
            <br />· 做完了回当前目标页归档，然后来这儿启动下一条
          </p>
        </div>
      </div>
    </div>
  );
}
