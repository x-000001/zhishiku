import { describe, expect, it } from 'vitest';
import {
  filterPaletteItems,
  fuzzyMatch,
  isEditableTarget,
  moveActiveIndex,
  PALETTE_OVERSCAN,
  PALETTE_ROW_HEIGHT,
  PALETTE_VIEWPORT_HEIGHT,
  scrollTopForIndex,
  shouldIgnoreShortcut,
  virtualWindow,
  type PaletteCommandItem
} from '../../src/renderer/src/palette';

/* 全局命令面板的纯逻辑（0.12.0 阶段1）：模糊匹配 / 排序 / 上下键 / 虚拟列表。 */

function item(key: string, title: string, extra: Partial<PaletteCommandItem> = {}): PaletteCommandItem {
  return { key, title, group: '测试', ...extra };
}

describe('fuzzyMatch：子序列模糊匹配', () => {
  it('空关键词匹配一切，分数 0、无高亮', () => {
    expect(fuzzyMatch('任务待办', '')).toEqual({ score: 0, indices: [] });
    expect(fuzzyMatch('', '')).toEqual({ score: 0, indices: [] });
  });

  it('不匹配（字符顺序不对 / 缺字）返回 null', () => {
    expect(fuzzyMatch('任务待办', '务任')).toBeNull();
    expect(fuzzyMatch('任务待办', '任务盘')).toBeNull();
    expect(fuzzyMatch('', 'abc')).toBeNull();
  });

  it('中文按字符子序列命中，并给出高亮下标', () => {
    const hit = fuzzyMatch('任务待办', '任务');
    expect(hit).not.toBeNull();
    expect(hit?.indices).toEqual([0, 1]);
  });

  it('英文大小写不敏感', () => {
    expect(fuzzyMatch('Export Markdown', 'export')?.indices).toEqual([0, 1, 2, 3, 4, 5]);
    expect(fuzzyMatch('export markdown', 'MARK')?.indices).toEqual([7, 8, 9, 10]);
  });

  it('前缀、连续、词边界命中比分散命中分数高', () => {
    const prefix = fuzzyMatch('任务待办', '任务')?.score ?? 0;
    const scattered = fuzzyMatch('今天的任务', '任务')?.score ?? 0;
    expect(prefix).toBeGreaterThan(scattered);
  });

  it('同样的词在标题开头比在中间分数高（避免「我的任务」压过「任务待办」）', () => {
    const start = fuzzyMatch('备份数据库', '备份')?.score ?? 0;
    const middle = fuzzyMatch('立即备份数据库', '备份')?.score ?? 0;
    expect(start).toBeGreaterThan(middle);
  });
});

describe('filterPaletteItems：过滤 + 稳定排序', () => {
  const items: PaletteCommandItem[] = [
    item('nav:tasks', '任务待办', { group: '前往' }),
    item('action:backup', '立即备份数据库', { group: '工具', keywords: 'backup 备份' }),
    item('action:export', '导出全部笔记为 Markdown', { group: '工具', keywords: 'export markdown 导出' }),
    item('nav:home', '首页', { group: '前往' })
  ];

  it('空关键词按原顺序全量返回', () => {
    expect(filterPaletteItems(items, '').map((h) => h.item.key)).toEqual([
      'nav:tasks',
      'action:backup',
      'action:export',
      'nav:home'
    ]);
  });

  it('标题命中的排前面，标题不命中但 keywords 命中的降权排后面', () => {
    const hits = filterPaletteItems(items, '备份');
    expect(hits[0]?.item.key).toBe('action:backup');
    const byKeywordOnly = filterPaletteItems(items, 'backup');
    expect(byKeywordOnly.map((h) => h.item.key)).toContain('action:backup');
  });

  it('只靠 keywords 命中时不给高亮下标（避免高亮错位）', () => {
    const hits = filterPaletteItems(items, 'backup');
    expect(hits[0]?.indices).toEqual([]);
  });

  it('没有命中返回空数组（UI 据此显示「换个关键词」）', () => {
    expect(filterPaletteItems(items, 'zzz不存在')).toEqual([]);
  });

  it('limit 生效（虚拟列表只处理前 N 条）', () => {
    const many = Array.from({ length: 60 }, (_, i) => item('n' + i, '打开笔记：笔记 ' + i));
    expect(filterPaletteItems(many, '打开笔记', 50)).toHaveLength(50);
  });
});

describe('moveActiveIndex：上下键不越界', () => {
  it('向下/向上正常移动', () => {
    expect(moveActiveIndex(0, 1, 5)).toBe(1);
    expect(moveActiveIndex(3, -1, 5)).toBe(2);
  });

  it('到顶/到底夹住（不循环）', () => {
    expect(moveActiveIndex(0, -1, 5)).toBe(0);
    expect(moveActiveIndex(4, 1, 5)).toBe(4);
  });

  it('空列表恒为 0', () => {
    expect(moveActiveIndex(3, 1, 0)).toBe(0);
  });
});

describe('virtualWindow：>50 条也只渲染视口附近', () => {
  it('空列表不渲染', () => {
    expect(virtualWindow(0, 0, PALETTE_VIEWPORT_HEIGHT, PALETTE_ROW_HEIGHT)).toEqual({ start: 0, end: 0 });
  });

  it('顶部：从 0 开始，最多 视口行数 + overscan', () => {
    const win = virtualWindow(60, 0, PALETTE_VIEWPORT_HEIGHT, PALETTE_ROW_HEIGHT, PALETTE_OVERSCAN);
    expect(win.start).toBe(0);
    expect(win.end).toBeGreaterThan(0);
    expect(win.end).toBeLessThan(60);
  });

  it('滚动到中间：渲染窗口跟着下移，且始终小于总数', () => {
    const win = virtualWindow(60, PALETTE_ROW_HEIGHT * 20, PALETTE_VIEWPORT_HEIGHT, PALETTE_ROW_HEIGHT, PALETTE_OVERSCAN);
    expect(win.start).toBe(20 - PALETTE_OVERSCAN);
    expect(win.end - win.start).toBeLessThanOrEqual(20);
    expect(win.end).toBeLessThanOrEqual(60);
  });

  it('滚动到底：end 夹到总数，start 不会超过总数', () => {
    const win = virtualWindow(60, PALETTE_ROW_HEIGHT * 60, PALETTE_VIEWPORT_HEIGHT, PALETTE_ROW_HEIGHT, PALETTE_OVERSCAN);
    expect(win.end).toBe(60);
    expect(win.start).toBeLessThan(60);
  });

  it('参数退化（行高/视口为 0）时也能给出一个安全窗口', () => {
    const win = virtualWindow(60, 0, 0, 0, 3);
    expect(win.start).toBe(0);
    expect(win.end).toBe(7);
  });
});

describe('scrollTopForIndex：键盘高亮滚进视口', () => {
  const VH = PALETTE_VIEWPORT_HEIGHT;
  const RH = PALETTE_ROW_HEIGHT;

  it('目标在视口上方：滚到该行顶部', () => {
    expect(scrollTopForIndex(RH * 10, 2, VH, RH)).toBe(RH * 2);
  });

  it('目标在视口下方：滚到该行底部贴住视口底', () => {
    expect(scrollTopForIndex(0, 12, VH, RH)).toBe(RH * 13 - VH);
  });

  it('目标已在视口内：不动', () => {
    expect(scrollTopForIndex(RH * 2, 3, VH, RH)).toBe(RH * 2);
  });

  it('非法索引/尺寸原样返回', () => {
    expect(scrollTopForIndex(120, -1, VH, RH)).toBe(120);
    expect(scrollTopForIndex(120, 3, 0, RH)).toBe(120);
  });
});

describe('输入区域快捷键闸门（红线：屏蔽 input / contenteditable 冒泡）', () => {
  it('识别输入类元素', () => {
    expect(isEditableTarget({ tagName: 'INPUT' })).toBe(true);
    expect(isEditableTarget({ tagName: 'textarea' })).toBe(true);
    expect(isEditableTarget({ tagName: 'SELECT' })).toBe(true);
    expect(isEditableTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true);
    expect(isEditableTarget({ tagName: 'DIV' })).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });

  it('输入区域里的裸键放行给输入区域', () => {
    expect(shouldIgnoreShortcut({ target: { tagName: 'INPUT' }, ctrlKey: false, metaKey: false, altKey: false })).toBe(true);
    expect(
      shouldIgnoreShortcut({ target: { tagName: 'DIV', isContentEditable: true }, ctrlKey: false, metaKey: false, altKey: false })
    ).toBe(true);
  });

  it('带修饰键的应用级快捷键照常生效', () => {
    expect(shouldIgnoreShortcut({ target: { tagName: 'INPUT' }, ctrlKey: true, metaKey: false, altKey: false })).toBe(false);
    expect(shouldIgnoreShortcut({ target: { tagName: 'DIV', isContentEditable: true }, ctrlKey: false, metaKey: true, altKey: false })).toBe(false);
  });

  it('非输入区域不受影响', () => {
    expect(shouldIgnoreShortcut({ target: { tagName: 'BODY' }, ctrlKey: false, metaKey: false, altKey: false })).toBe(false);
    expect(shouldIgnoreShortcut(null)).toBe(false);
  });
});
