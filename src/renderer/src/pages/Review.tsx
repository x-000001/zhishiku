import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from '../api';
import { Empty, Modal, toast } from '../ui';
import { fmtDate, fmtDateTime, todayLocal } from '../format';import { toastError } from '../errors';

import type {
  NoteListItem,
  RetroStats,
  RetroType,
  ReviewCard,
  ReviewGrade,
  ReviewSource
} from '../../../shared/types';

const SOURCE_LABEL: Record<ReviewSource, string> = { note: '笔记', wrong: '错题', hard: '难点' };
const RETRO_TYPES: { key: RetroType; label: string; hint: string }[] = [
  { key: 'day', label: '日复盘', hint: '今天做了什么、哪里卡住了' },
  { key: 'week', label: '周复盘', hint: '这一周的方向对不对' },
  { key: 'month', label: '月复盘', hint: '这个月的目标推进了多少' }
];

/**
 * 复习与复盘：
 * - 复习用简化 SM-2，三档打分（忘了 / 模糊 / 记得）决定下次什么时候再见
 * - 复盘按日 / 周 / 月写，旁边直接给出这段时间的完成数字
 */
export default function Review(): ReactNode {
  const [tab, setTab] = useState<'review' | 'retro'>('review');

  /* ---------------- 复习 ---------------- */
  const [stats, setStats] = useState<{ total: number; dueToday: number; learned: number; reviewedToday: number; lapses: number } | null>(null);
  const [due, setDue] = useState<ReviewCard[]>([]);
  const [revealed, setRevealed] = useState(false);
  const [allCards, setAllCards] = useState<ReviewCard[]>([]);
  const [sourceFilter, setSourceFilter] = useState<ReviewSource | 'all'>('all');
  const [front, setFront] = useState('');
  const [back, setBack] = useState('');
  const [newSource, setNewSource] = useState<ReviewSource>('wrong');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [noteQuery, setNoteQuery] = useState('');
  const [notes, setNotes] = useState<NoteListItem[]>([]);

  const loadReview = useCallback(() => {
    return Promise.all([api.reviewStats(), api.dueReview(), api.listReview()])
      .then(([s, d, list]) => {
        setStats(s);
        setDue(d);
        setAllCards(list);
      })
      .catch((err) => toastError('读取复习数据失败：', err));
  }, []);

  useEffect(() => {
    void loadReview();
  }, [loadReview]);

  useEffect(() => {
    if (!pickerOpen) return;
    const timer = window.setTimeout(() => {
      void api.listNotes({ q: noteQuery.trim() || undefined, limit: 50 }).then(setNotes);
    }, 180);
    return () => window.clearTimeout(timer);
  }, [pickerOpen, noteQuery]);

  const current = due[0] ?? null;

  const grade = async (g: ReviewGrade): Promise<void> => {
    if (!current) return;
    try {
      const updated = await api.gradeReview(current.id, g);
      const label = g === 'know' ? '记得' : g === 'fuzzy' ? '模糊' : '忘了';
      toast(
        updated
          ? `${label} · 下次 ${updated.interval_days > 0 ? `${updated.interval_days} 天后` : '今天再来'}（${fmtDate(updated.next_review_at)}）`
          : label
      );
      setRevealed(false);
      await loadReview();
    } catch (err) {
      toastError('打分失败：', err);
    }
  };

  const addCard = async (): Promise<void> => {
    const f = front.trim();
    if (!f) return;
    try {
      await api.createReview({ front: f, back, source: newSource });
      setFront('');
      setBack('');
      await loadReview();
      toast('卡片加好了');
    } catch (err) {
      toastError('加不上：', err);
    }
  };

  const fromNote = async (noteId: number): Promise<void> => {
    try {
      await api.reviewFromNote(noteId);
      setPickerOpen(false);
      await loadReview();
      toast('已从这篇笔记生成卡片（同一篇不会重复生成）', {
        actionLabel: '开始复习',
        onAction: () => setTab('review')
      });
    } catch (err) {
      toastError('生成失败：', err);
    }
  };

  const shownCards = useMemo(
    () => (sourceFilter === 'all' ? allCards : allCards.filter((c) => c.source === sourceFilter)),
    [allCards, sourceFilter]
  );

  /* ---------------- 复盘 ---------------- */
  const [retroType, setRetroType] = useState<RetroType>('day');
  const [retroDate, setRetroDate] = useState(todayLocal());
  const [range, setRange] = useState<{ from: string; to: string }>({ from: todayLocal(), to: todayLocal() });
  const [retroStats, setRetroStats] = useState<RetroStats | null>(null);
  const [retroContent, setRetroContent] = useState('');
  const [history, setHistory] = useState<{ id: number; type: RetroType; date: string; content: string; updated_at: string }[]>([]);

  const retroKey = retroType === 'day' ? retroDate : range.from;

  useEffect(() => {
    if (retroType === 'day') {
      setRange({ from: retroDate, to: retroDate });
      return;
    }
    void api.retroPeriod(retroType, retroDate).then(setRange);
  }, [retroType, retroDate]);

  useEffect(() => {
    if (retroRangeReady(range)) {
      void api.retroStats(range.from, range.to).then(setRetroStats);
    }
  }, [range]);

  useEffect(() => {
    if (retroRangeReady(range)) {
      void api.getRetro(retroType, retroKey).then((r) => setRetroContent(r?.content ?? ''));
    }
    void api.listRetros(retroType).then(setHistory);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retroType, retroKey]);

  const saveRetro = async (): Promise<void> => {
    try {
      await api.saveRetro(retroType, retroKey, retroContent);
      await api.listRetros(retroType).then(setHistory);
      toast('复盘已保存');
    } catch (err) {
      toastError('保存失败：', err);
    }
  };

  return (
    <div className="dash-grid">
      <div>
        <div className="card">
          <div className="card-head">
            <div className="tabs">
              <button type="button" className={tab === 'review' ? 'on' : ''} onClick={() => setTab('review')}>
                🔁 复习
              </button>
              <button type="button" className={tab === 'retro' ? 'on' : ''} onClick={() => setTab('retro')}>
                📝 复盘
              </button>
            </div>
            <span className="spacer" />
            {stats ? (
              <span className="muted">
                今天到期 {stats.dueToday} · 已复习 {stats.reviewedToday}
              </span>
            ) : null}
          </div>

          {tab === 'review' ? (
            <>
              <div className="stat-row" style={{ marginBottom: 12 }}>
                <div className="stat">
                  <b>{stats?.total ?? 0}</b>
                  <span>卡片总数</span>
                </div>
                <div className="stat">
                  <b style={{ color: stats?.dueToday ? 'var(--warn, #d97706)' : undefined }}>{stats?.dueToday ?? 0}</b>
                  <span>今天该复习</span>
                </div>
                <div className="stat">
                  <b style={{ color: 'var(--ok)' }}>{stats?.learned ?? 0}</b>
                  <span>已经过过一遍</span>
                </div>
                <div className="stat">
                  <b>{stats?.lapses ?? 0}</b>
                  <span>累计忘了</span>
                </div>
              </div>

              {due.length === 0 ? (
                <Empty>今天没有要复习的卡片，去知识库把笔记变成卡片吧。</Empty>
              ) : (
                <div className="review-stage">
                  <div className="muted" style={{ marginBottom: 6 }}>
                    还剩 {due.length} 张 · {SOURCE_LABEL[current!.source]}
                    {current!.review_count ? ` · 已经复习过 ${current!.review_count} 次` : ' · 第一次见'}
                  </div>
                  <div className="review-front">{current!.front}</div>
                  {revealed ? (
                    <>
                      <div className="review-back">{current!.back || '（这张卡没有背面，凭记忆回想一下）'}</div>
                      <div className="row" style={{ gap: 10, marginTop: 14 }}>
                        <button type="button" className="btn" style={{ flex: 1 }} onClick={() => void grade('forgot')}>
                          忘了 · 今天再来
                        </button>
                        <button type="button" className="btn" style={{ flex: 1 }} onClick={() => void grade('fuzzy')}>
                          模糊 · 明天再见
                        </button>
                        <button
                          type="button"
                          className="btn primary"
                          style={{ flex: 1 }}
                          onClick={() => void grade('know')}
                        >
                          记得 · 往下走
                        </button>
                      </div>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="btn primary"
                      style={{ width: '100%', marginTop: 12 }}
                      onClick={() => setRevealed(true)}
                    >
                      显示答案
                    </button>
                  )}
                </div>
              )}

              <div className="card" style={{ marginTop: 14 }}>
                <div className="card-head">
                  <h2>加一张卡片</h2>
                  <span className="spacer" />
                  <button type="button" className="btn ghost sm" onClick={() => setPickerOpen(true)}>
                    从笔记生成
                  </button>
                </div>
                <div className="field">
                  <label>正面（问题）</label>
                  <input value={front} onChange={(e) => setFront(e.target.value)} placeholder="比如「什么是闭包」" />
                </div>
                <div className="field">
                  <label>背面（答案）</label>
                  <textarea rows={2} value={back} onChange={(e) => setBack(e.target.value)} placeholder="留空也可以，靠回想" />
                </div>
                <div className="row" style={{ gap: 10 }}>
                  <select
                    value={newSource}
                    style={{ width: 120 }}
                    onChange={(e) => setNewSource(e.target.value as ReviewSource)}
                  >
                    <option value="note">笔记</option>
                    <option value="wrong">错题</option>
                    <option value="hard">难点</option>
                  </select>
                  <button type="button" className="btn" onClick={() => void addCard()}>
                    加上
                  </button>
                </div>
              </div>
            </>
          ) : (
            <>
              <div className="tabs">
                {RETRO_TYPES.map((t) => (
                  <button key={t.key} type="button" className={retroType === t.key ? 'on' : ''} onClick={() => setRetroType(t.key)}>
                    {t.label}
                  </button>
                ))}
              </div>
              <p className="muted" style={{ marginTop: 8 }}>
                {RETRO_TYPES.find((t) => t.key === retroType)?.hint}
              </p>
              <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
                <div className="field">
                  <label>{retroType === 'day' ? '哪一天' : '选这段时间里的任意一天'}</label>
                  <input type="date" value={retroDate} onChange={(e) => setRetroDate(e.target.value || todayLocal())} />
                </div>
                <div className="field" style={{ flex: 1 }}>
                  <label>覆盖范围</label>
                  <div className="muted" style={{ paddingTop: 8 }}>
                    {range.from} ~ {range.to}
                    {retroType !== 'day' ? '（按周一到周日 / 当月计算）' : ''}
                  </div>
                </div>
              </div>

              {retroStats ? (
                <div className="stat-row" style={{ margin: '10px 0 14px' }}>
                  <div className="stat">
                    <b style={{ color: 'var(--ok)' }}>{retroStats.tasksDone}</b>
                    <span>完成的任务</span>
                  </div>
                  <div className="stat">
                    <b>{retroStats.notesWritten}</b>
                    <span>动过的笔记</span>
                  </div>
                  <div className="stat">
                    <b>{retroStats.reviewsDone}</b>
                    <span>复习次数</span>
                  </div>
                  <div className="stat">
                    <b>
                      {retroStats.planItemsDone}/{retroStats.planItemsTotal}
                    </b>
                    <span>计划条目</span>
                  </div>
                </div>
              ) : null}

              <div className="field">
                <label>写点什么</label>
                <textarea
                  rows={9}
                  value={retroContent}
                  placeholder={'可以按这三段写：\n1. 做成了什么\n2. 卡在哪里、为什么\n3. 下一步改什么'}
                  onChange={(e) => setRetroContent(e.target.value)}
                />
              </div>
              <div className="row">
                <span className="muted" style={{ flex: 1 }}>
                  {retroContent.trim() ? `${retroContent.trim().length} 字` : '还没写'}
                </span>
                <button type="button" className="btn primary" onClick={() => void saveRetro()}>
                  保存复盘
                </button>
              </div>
            </>
          )}
        </div>

        {tab === 'review' ? (
          <div className="card">
            <div className="card-head">
              <h2>全部卡片</h2>
              <span className="spacer" />
              <select value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value as ReviewSource | 'all')}>
                <option value="all">全部来源</option>
                <option value="note">笔记</option>
                <option value="wrong">错题</option>
                <option value="hard">难点</option>
              </select>
            </div>
            {shownCards.length === 0 ? (
              <Empty>还没有卡片。</Empty>
            ) : (
              <div className="list">
                {shownCards.map((card) => (
                  <div key={card.id} className="list-row">
                    <span className="badge">{SOURCE_LABEL[card.source]}</span>
                    <div className="grow">
                      <div className="title">{card.front}</div>
                      <div className="sub">
                        下次 {fmtDate(card.next_review_at)} · 复习 {card.review_count} 次 · 遗忘 {card.lapses} 次 ·
                        间隔 {card.interval_days} 天
                      </div>
                    </div>
                    <button
                      type="button"
                      className="icon-btn"
                      title="删除这张卡"
                      onClick={() => {
                        void api.deleteReview(card.id).then(loadReview);
                      }}
                    >
                      🗑
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="card">
            <div className="card-head">
              <h2>{RETRO_TYPES.find((t) => t.key === retroType)?.label}历史</h2>
            </div>
            {history.length === 0 ? (
              <Empty>还没有写过{RETRO_TYPES.find((t) => t.key === retroType)?.label}。</Empty>
            ) : (
              <div className="list">
                {history.map((r) => (
                  <div
                    key={r.id}
                    className="list-row"
                    onClick={() => {
                      setRetroDate(r.date);
                      setRetroContent(r.content);
                    }}
                  >
                    <span>📝</span>
                    <div className="grow">
                      <div className="title">{r.date}</div>
                      <div className="sub">{r.content.replace(/\s+/g, ' ').slice(0, 60)}</div>
                    </div>
                    <span className="muted">{fmtDateTime(r.updated_at)}</span>
                    <button
                      type="button"
                      className="icon-btn"
                      title="删除"
                      onClick={(e) => {
                        e.stopPropagation();
                        void api.deleteRetro(r.id).then(() => api.listRetros(retroType).then(setHistory));
                      }}
                    >
                      🗑
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <div>
        <div className="card">
          <div className="card-head">
            <h2>怎么用这一页</h2>
          </div>
          <p className="muted" style={{ lineHeight: 1.9, margin: 0 }}>
            · 复习三档：忘了（今天再来）/ 模糊（打折）/ 记得（往上升一格）
            <br />· 阶梯是 1、2、4、7、15、30、60、120 天
            <br />· 知识库的笔记可以一键变成卡片，错题和难点手动加
            <br />· 日 / 周 / 月复盘分开存，旁边数字是按周期自动算的
          </p>
        </div>

        {stats ? (
          <div className="card">
            <div className="card-head">
              <h2>复习情况</h2>
            </div>
            <div className="list">
              <div className="list-row">
                <span>📚</span>
                <div className="grow">
                  <div className="title">一共 {stats.total} 张卡片</div>
                  <div className="sub">
                    今天到期 {stats.dueToday} 张 · 今天已复习 {stats.reviewedToday} 张
                  </div>
                </div>
              </div>
              <div className="list-row">
                <span>💪</span>
                <div className="grow">
                  <div className="title">已经过过一遍 {stats.learned} 张</div>
                  <div className="sub">累计遗忘 {stats.lapses} 次，忘了就重来，很正常</div>
                </div>
              </div>
            </div>
          </div>
        ) : null}
      </div>

      {pickerOpen ? (
        <Modal title="从笔记生成复习卡" onClose={() => setPickerOpen(false)} width={620}>
          <input
            placeholder="搜笔记标题或内容…"
            value={noteQuery}
            style={{ width: '100%', marginBottom: 10 }}
            onChange={(e) => setNoteQuery(e.target.value)}
          />
          <div className="list" style={{ maxHeight: 380, overflow: 'auto' }}>
            {notes.map((note) => (
              <div key={note.id} className="list-row" onClick={() => void fromNote(note.id)}>
                <span>📄</span>
                <div className="grow">
                  <div className="title">{note.title || '无标题笔记'}</div>
                  <div className="sub">{note.excerpt ? note.excerpt.replace(/\s+/g, ' ').slice(0, 60) : '点一下生成卡片'}</div>
                </div>
              </div>
            ))}
            {notes.length === 0 ? <Empty>没有找到笔记。</Empty> : null}
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

/** 周/月复盘的范围要等 periodRange 回来才算得出来，先挡掉空值。 */
function retroRangeReady(range: { from: string; to: string }): boolean {
  return Boolean(range.from && range.to);
}
