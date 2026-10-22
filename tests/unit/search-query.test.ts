import { describe, expect, it } from 'vitest';
import {
  describeSearchFlag,
  describeSearchTag,
  parseSearchQuery,
  SEARCH_FLAG_LABELS,
  SEARCH_MAX_TAGS
} from '../../src/shared/search-query';

/* 高级检索语法解析（0.12.0 阶段2）：语法词必须从全文检索词里剔除。 */

describe('parseSearchQuery：基础行为', () => {
  it('普通关键词原样保留，没有任何过滤条件', () => {
    const parsed = parseSearchQuery('间隔重复 记忆');
    expect(parsed.text).toBe('间隔重复 记忆');
    expect(parsed.tags).toEqual([]);
    expect(parsed.flags).toEqual([]);
    expect(parsed.unknownFlags).toEqual([]);
    expect(parsed.empty).toBe(false);
  });

  it('tag: 被剔除出全文检索词，只留在 tags 里', () => {
    const parsed = parseSearchQuery('tag:工作 项目复盘');
    expect(parsed.tags).toEqual(['工作']);
    expect(parsed.text).toBe('项目复盘');
  });

  it('只有 tag: 时 text 为空（主进程走过滤查询，不进 FTS MATCH）', () => {
    const parsed = parseSearchQuery('tag:工作');
    expect(parsed.text).toBe('');
    expect(parsed.tags).toEqual(['工作']);
    expect(parsed.empty).toBe(false);
  });

  it('多个标签去重、保持首次出现顺序', () => {
    const parsed = parseSearchQuery('tag:工作 tag:学习 tag:工作 复盘');
    expect(parsed.tags).toEqual(['工作', '学习']);
    expect(parsed.text).toBe('复盘');
  });

  it('标签数量上限生效', () => {
    const raw = Array.from({ length: SEARCH_MAX_TAGS + 3 }, (_, i) => 'tag:标签' + i).join(' ');
    const parsed = parseSearchQuery(raw);
    expect(parsed.tags).toHaveLength(SEARCH_MAX_TAGS);
  });

  it('带引号的标签名（含空格）可以解析', () => {
    const parsed = parseSearchQuery('tag:"我的 标签" 正文');
    expect(parsed.tags).toEqual(['我的 标签']);
    expect(parsed.text).toBe('正文');
  });
});

describe('parseSearchQuery：is: 状态', () => {
  it('is:pinned / is:trash 解析成 flags 并从检索词里剔除', () => {
    const parsed = parseSearchQuery('is:pinned 复盘');
    expect(parsed.flags).toEqual(['pinned']);
    expect(parsed.text).toBe('复盘');

    const both = parseSearchQuery('is:trash is:pinned');
    expect(both.flags).toEqual(['trash', 'pinned']);
    expect(both.text).toBe('');
  });

  it('不支持的 is: 值进 unknownFlags，不参与检索、也不污染 text', () => {
    const parsed = parseSearchQuery('is:done 复盘');
    expect(parsed.flags).toEqual([]);
    expect(parsed.unknownFlags).toEqual(['done']);
    expect(parsed.text).toBe('复盘');
  });

  it('前缀大小写不敏感（TAG: / IS:）', () => {
    const parsed = parseSearchQuery('TAG:工作 IS:PINNED 笔记');
    expect(parsed.tags).toEqual(['工作']);
    expect(parsed.flags).toEqual(['pinned']);
    expect(parsed.text).toBe('笔记');
  });
});

describe('parseSearchQuery：空输入与展示文案', () => {
  it('空输入 / 纯空白 / 只有空标签都算 empty', () => {
    expect(parseSearchQuery('').empty).toBe(true);
    expect(parseSearchQuery('   ').empty).toBe(true);
    expect(parseSearchQuery('tag:').empty).toBe(true);
    expect(parseSearchQuery('is:').empty).toBe(true);
  });

  it('只有未知状态时不算 empty（UI 要显示不支持提示）', () => {
    const parsed = parseSearchQuery('is:done');
    expect(parsed.empty).toBe(true);
    expect(parsed.unknownFlags).toEqual(['done']);
  });

  it('chip 文案：tag:标签名 / is:中文状态', () => {
    expect(describeSearchTag('工作')).toBe('tag:工作');
    expect(describeSearchFlag('pinned')).toBe('is:' + SEARCH_FLAG_LABELS.pinned);
    expect(describeSearchFlag('trash')).toBe('is:回收站');
  });
});
