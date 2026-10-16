import type { Id } from '../../shared/types';

/**
 * 拖动排序的纯计算部分（不碰 DOM、不碰 React），单独放一个文件是为了能直接被单测覆盖。
 *
 * 两个用法：
 * - `applyOrder(list, ids)`：把 ids 指定的那几条按新顺序摆进原列表，其余条目原地不动，
 *   用来做「松手立刻看到效果」的本地预览。
 * - `moveWithinGroup(list, draggedId, targetId, after)`：算出「在同一个分类里把某张卡片
 *   拖到另一张前面/后面」之后该分类的顺序。返回 null 表示这次拖动不成立（两张不在同一组，
 *   比如在「全部笔记」里把 A 分类的笔记拖到 B 分类的笔记上）。
 */
export function applyOrder<T extends { id: Id }>(prev: T[], ids: Id[]): T[] {
  const pos = new Map(ids.map((id, i) => [id, i]));
  const group = prev
    .filter((n) => pos.has(n.id))
    .sort((a, b) => (pos.get(a.id) as number) - (pos.get(b.id) as number));
  let k = 0;
  return prev.map((n) => (pos.has(n.id) ? group[k++] : n));
}

/** 取分组用的键：同一条分类（含「未分类」）的笔记才互相排得动。 */
export function groupKeyOf(note: { category_id: Id | null }): string {
  return String(note.category_id ?? '');
}

export function moveWithinGroup<T extends { id: Id; category_id: Id | null }>(
  list: T[],
  draggedId: Id,
  targetId: Id,
  after: boolean
): Id[] | null {
  if (draggedId === targetId) return null;
  const dragged = list.find((n) => n.id === draggedId);
  const target = list.find((n) => n.id === targetId);
  if (!dragged || !target) return null;
  if (groupKeyOf(dragged) !== groupKeyOf(target)) return null;
  const key = groupKeyOf(dragged);
  const group = list.filter((n) => groupKeyOf(n) === key);
  const from = group.findIndex((n) => n.id === draggedId);
  const to = group.findIndex((n) => n.id === targetId);
  if (from < 0 || to < 0) return null;
  const next = group.slice();
  const [moved] = next.splice(from, 1);
  let insertAt = next.findIndex((n) => n.id === targetId);
  if (insertAt < 0) return null;
  if (after) insertAt += 1;
  next.splice(insertAt, 0, moved);
  return next.map((n) => n.id);
}
