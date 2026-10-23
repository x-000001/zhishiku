import { useCallback, useEffect, useState } from 'react';
import { api, onAiMemoryUpdated } from './api';
import { toast } from './ui';
import { toastError } from './errors';
import {
  AI_MEMORY_HINT,
  AI_MEMORY_MODULE_LABELS,
  type AiMemoryEntry,
  type AiMemoryPage
} from '../../shared/ai-memory';

const PAGE_SIZE = 5;

/**
 * 设置页「🧠 AI 长时记忆」区域：开关 + 分页列表 + 单条删除 + 一键清空。
 *
 * 契约二（非阻塞）：后台提取成功后只在此处显示一行小字「已记住」，不弹任何确认框。
 * 用户随时可以在这里反悔：删一条或一键清空，下次注入立刻不再携带。
 */
export default function AiMemoryCard() {
  const [data, setData] = useState<AiMemoryPage | null>(null);
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState('');

  const load = useCallback(async (targetPage: number): Promise<AiMemoryPage> => {
    const result = await api.aiMemoryList(targetPage, PAGE_SIZE);
    setData(result);
    return result;
  }, []);

  useEffect(() => {
    void load(1).catch((err: Error) => toastError('读取 AI 长时记忆失败：', err));
  }, [load]);

  useEffect(() => {
    const off = onAiMemoryUpdated((event) => {
      setHint(event.hint || AI_MEMORY_HINT);
      // 提取完回到第一页，让用户立刻看到刚记住的那一条
      setPage(1);
      void load(1).catch(() => undefined);
    });
    return off;
  }, [load]);

  const enabled = data?.enabled !== false;
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const items = data?.items ?? [];

  const toggle = async (): Promise<void> => {
    setBusy(true);
    try {
      const next = await api.aiMemorySetEnabled(!enabled);
      setData((prev) => ({
        items: prev?.items ?? [],
        total: prev?.total ?? 0,
        page: prev?.page ?? 1,
        size: PAGE_SIZE,
        enabled: next.enabled
      }));
      toast(next.enabled ? '已开启 AI 长时记忆' : '已关闭 AI 长时记忆');
    } catch (err) {
      toastError('切换长时记忆失败：', err);
    } finally {
      setBusy(false);
    }
  };

  const goto = async (target: number): Promise<void> => {
    const safe = Math.max(1, Math.min(totalPages, target));
    setBusy(true);
    try {
      setPage(safe);
      await load(safe);
    } catch (err) {
      toastError('翻页失败：', err);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (entry: AiMemoryEntry): Promise<void> => {
    setBusy(true);
    try {
      await api.aiMemoryDelete(entry.id);
      setHint('已删掉这条记忆，下次不再注入');
      // 删掉本页最后一条时回退一页，避免停在空页面上
      const next = await api.aiMemoryList(page, PAGE_SIZE);
      if (!next.items.length && page > 1) {
        setPage(page - 1);
        await load(page - 1);
      } else {
        setData(next);
      }
    } catch (err) {
      toastError('删除记忆失败：', err);
    } finally {
      setBusy(false);
    }
  };

  const clearAll = async (): Promise<void> => {
    setBusy(true);
    try {
      const removed = await api.aiMemoryClear();
      setPage(1);
      setHint(removed ? `已清空 ${removed} 条记忆` : '已经没有记忆了');
      await load(1);
    } catch (err) {
      toastError('清空记忆失败：', err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card ai-memory-card" data-total={total}>
      <div className="card-head">
        <h2>🧠 AI 长时记忆</h2>
        <span className="badge">{total} 条</span>
        <span className="spacer" />
        <button
          type="button"
          className={enabled ? 'switch on' : 'switch'}
          aria-label="AI 长时记忆开关"
          disabled={busy}
          onClick={() => void toggle()}
        />
      </div>
      <p className="muted">
        AI 会从您的润色、摘要里悄悄记住写作偏好（例如「喜欢简短分点」），下次只在本场景注入最多 3 条，
        全部只存在本机；不想留就删掉，随时可反悔。
      </p>
      {hint ? <p className="ai-memory-hint muted">{hint}</p> : null}
      {items.length === 0 ? (
        <div className="empty">
          还没有记忆。用几次 AI 润色或摘要后，它会自动记下您的格式偏好（前提是配置了 AI）。
        </div>
      ) : (
        items.map((entry) => (
          <div className="memory-row" key={entry.id}>
            <span className="badge">{AI_MEMORY_MODULE_LABELS[entry.module_target] ?? entry.module_target}</span>
            <span className="memory-text">{entry.content}</span>
            <button
              type="button"
              className="btn danger sm"
              disabled={busy}
              onClick={() => void remove(entry)}
            >
              删除
            </button>
          </div>
        ))
      )}
      <div className="ai-memory-foot">
        <button type="button" className="btn sm" disabled={busy || page <= 1} onClick={() => void goto(page - 1)}>
          上一页
        </button>
        <span className="muted">
          第 {page} / {totalPages} 页
        </span>
        <button
          type="button"
          className="btn sm"
          disabled={busy || page >= totalPages}
          onClick={() => void goto(page + 1)}
        >
          下一页
        </button>
        <span className="spacer" />
        <button type="button" className="btn danger sm" disabled={busy || total === 0} onClick={() => void clearAll()}>
          一键清空
        </button>
      </div>
    </section>
  );
}
