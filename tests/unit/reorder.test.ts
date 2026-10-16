import { describe, expect, it } from 'vitest';
import { applyOrder, groupKeyOf, moveWithinGroup } from '../../src/renderer/src/reorder';
import type { NoteListItem } from '../../src/shared/types';

/** 造一条只带排序相关字段的笔记，省得填一整套 NoteListItem。 */
function note(id: number, category_id: number | null, title: string): NoteListItem {
  return {
    id,
    category_id,
    category_name: '',
    title,
    excerpt: '',
    word_count: 0,
    is_pinned: 0,
    sort_order: 0,
    updated_at: '2026-10-16T10:00:00+08:00'
  } as NoteListItem;
}

describe('拖动排序：分组内的顺序计算（优化项 6）', () => {
  const a = note(1, 7, '甲');
  const b = note(2, 7, '乙');
  const c = note(3, 7, '丙');

  it('把最后一张拖到最前面', () => {
    expect(moveWithinGroup([a, b, c], c.id, a.id, false)).toEqual([3, 1, 2]);
  });

  it('把第一张拖到最后一张后面', () => {
    expect(moveWithinGroup([a, b, c], a.id, c.id, true)).toEqual([2, 3, 1]);
  });

  it('拖到中间那张后面', () => {
    expect(moveWithinGroup([a, b, c], a.id, b.id, true)).toEqual([2, 1, 3]);
  });

  it('拖到自己身上什么都不做', () => {
    expect(moveWithinGroup([a, b, c], b.id, b.id, false)).toBeNull();
  });

  it('跨分类拖（两张不在同一个分类）不成立', () => {
    const other = note(9, 8, '别的分类');
    expect(moveWithinGroup([a, b, c, other], a.id, other.id, false)).toBeNull();
    expect(moveWithinGroup([a, b, c, other], other.id, a.id, true)).toBeNull();
  });

  it('「未分类」的笔记互相能排，但不会跟某个分类混在一起', () => {
    const n1 = note(11, null, '未分类一');
    const n2 = note(12, null, '未分类二');
    expect(groupKeyOf(n1)).toBe('');
    expect(moveWithinGroup([n1, n2, a], n2.id, n1.id, false)).toEqual([12, 11]);
    expect(moveWithinGroup([n1, n2, a], n1.id, a.id, false)).toBeNull();
  });

  it('列表里找不到的 id 返回 null', () => {
    expect(moveWithinGroup([a, b], 999, a.id, false)).toBeNull();
    expect(moveWithinGroup([a, b], a.id, 999, true)).toBeNull();
  });

  it('只重排分组内那几条，别的分类的顺序原样不动', () => {
    const other = note(9, 8, '别的分类');
    const list = [a, other, b, c];
    const ids = moveWithinGroup(list, c.id, a.id, false)!;
    expect(ids).toEqual([3, 1, 2]);
    // 本地预览：other 还在原来的位置上
    expect(applyOrder(list, ids).map((n) => n.title)).toEqual(['丙', '别的分类', '甲', '乙']);
  });
});

describe('拖动排序：本地预览 applyOrder', () => {
  it('把 ids 摆成新顺序，其余的原地不动', () => {
    const list = [note(1, 1, '一'), note(2, 2, '二'), note(3, 1, '三')];
    expect(applyOrder(list, [3, 1]).map((n) => n.title)).toEqual(['三', '二', '一']);
  });

  it('ids 里没有的条目不会被丢掉，也不会重复', () => {
    const list = [note(1, 1, '一'), note(2, 1, '二'), note(3, 1, '三')];
    // applyOrder 占的是「这些条目原本所在的位置」，所以只给一条时顺序不变
    expect(applyOrder(list, [2]).map((n) => n.id)).toEqual([1, 2, 3]);
    // 给两条就是这两条互换位置，第三条原地不动
    const out = applyOrder(list, [2, 1]);
    expect(out.map((n) => n.id)).toEqual([2, 1, 3]);
    expect(new Set(out.map((n) => n.id)).size).toBe(3);
  });

  it('空 ids 时原样返回', () => {
    const list = [note(1, 1, '一'), note(2, 1, '二')];
    expect(applyOrder(list, []).map((n) => n.id)).toEqual([1, 2]);
  });
});
