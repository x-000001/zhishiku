/* ------------------------------------------------------------------ */
/* 高级检索语法（0.12.0 阶段2）                                        */
/*                                                                     */
/* 目标：把 `tag:工作`、`is:pinned` 这类「过滤语法」从全文检索词里剥出来， */
/* 变成结构化条件交给主进程；剩下的文字才进 FTS5 的 MATCH。            */
/*                                                                     */
/* 渲染层用同一个函数即时解析，算出过滤 chip 与防呆提示；主进程不信任    */
/* 渲染层传值，会按 raw 原文用同一个函数重新解析一遍（防绕过）。          */
/* 纯函数、不碰 DOM / DB，可直接单测（tests/unit/search-query.test.ts）。 */
/* ------------------------------------------------------------------ */

/** 笔记支持的 `is:` 状态（笔记没有「done」，所以只列真实存在的两种状态）。 */
export type SearchFlag = 'pinned' | 'trash';

export const SEARCH_FLAGS: SearchFlag[] = ['pinned', 'trash'];

export const SEARCH_FLAG_LABELS: Record<SearchFlag, string> = {
  pinned: '置顶',
  trash: '回收站'
};

/** 一次最多带几个标签过滤（防止拼出几百个 OR 级联）。 */
export const SEARCH_MAX_TAGS = 5;

export interface ParsedSearchQuery {
  /** 原始输入（主进程重新解析时用） */
  raw: string;
  /** 剥掉语法词后的全文检索词 */
  text: string;
  /** tag:xxx 收集到的标签名（去重、最多 SEARCH_MAX_TAGS 个） */
  tags: string[];
  /** is:xxx 里被支持的状态 */
  flags: SearchFlag[];
  /** is:xxx 里不认识的状态（给 UI 做防呆提示，不参与检索） */
  unknownFlags: string[];
  /** 没有任何有效检索内容（既没文字也没标签/状态） */
  empty: boolean;
}

const TAG_PREFIX = /^tag:(.*)$/i;
const IS_PREFIX = /^is:(.*)$/i;

/**
 * 按空白切词，但引号里的空格不切：`tag:"我的 标签"` 算一个词。
 * 只处理单双层引号，足够覆盖标签名里的空格。
 */
function splitTokens(source: string): string[] {
  const out: string[] = [];
  let buffer = '';
  let quote: '"' | "'" | null = null;
  for (const ch of source) {
    if (quote) {
      if (ch === quote) {
        quote = null;
        buffer += ch;
      } else {
        buffer += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buffer += ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (buffer.trim()) out.push(buffer.trim());
      buffer = '';
      continue;
    }
    buffer += ch;
  }
  if (buffer.trim()) out.push(buffer.trim());
  return out;
}

/** 去掉值两侧成对引号；标签名按去引号后的原文精确匹配（区分大小写，与 tag.name 一致）。 */
function cleanValue(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1).trim();
  }
  return value;
}

/** 解析用户输入：语法词进结构化字段，普通词留在 text 里（text 才是 FTS 的 MATCH 来源）。 */
export function parseSearchQuery(raw: string): ParsedSearchQuery {
  const source = String(raw ?? '');
  const textParts: string[] = [];
  const tags: string[] = [];
  const flags: SearchFlag[] = [];
  const unknownFlags: string[] = [];

  for (const token of splitTokens(source)) {
    const tagMatch = token.match(TAG_PREFIX);
    if (tagMatch) {
      const name = cleanValue(tagMatch[1]);
      if (name && tags.indexOf(name) < 0) tags.push(name);
      continue;
    }
    const isMatch = token.match(IS_PREFIX);
    if (isMatch) {
      const value = cleanValue(isMatch[1]).toLowerCase();
      if (!value) continue;
      if ((SEARCH_FLAGS as string[]).indexOf(value) >= 0) {
        const flag = value as SearchFlag;
        if (flags.indexOf(flag) < 0) flags.push(flag);
      } else if (unknownFlags.indexOf(value) < 0) {
        unknownFlags.push(value);
      }
      continue;
    }
    const plain = token.trim();
    if (plain) textParts.push(plain);
  }

  const text = textParts.join(' ').trim();
  return {
    raw: source,
    text,
    tags: tags.slice(0, SEARCH_MAX_TAGS),
    flags,
    unknownFlags,
    empty: !text && tags.length === 0 && flags.length === 0
  };
}

/** 过滤语的展示文案（UI chip 用）：`tag:工作` / `is:置顶`。 */
export function describeSearchTag(tag: string): string {
  return 'tag:' + tag;
}

export function describeSearchFlag(flag: SearchFlag): string {
  return 'is:' + SEARCH_FLAG_LABELS[flag];
}
