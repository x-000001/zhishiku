import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as db from '../../src/main/db';
import { ensureDirs, type DataPaths } from '../../src/main/paths';
import {
  EXTRACT_MAX_CHARS,
  EXTRACT_SOURCE_CLASS,
  EXTRACT_SYSTEM_PROMPT,
  EXTRACT_TRUNCATED_HINT,
  buildExtractHtml,
  buildExtractPrompt,
  extractResultError,
  normalizeExtractTitle,
  splitExtractionOutput,
  truncateForExtraction,
  uniqueExtractTitle
} from '../../src/shared/extract-doc';

/* ------------------------------------------------------------------ */
/* 纯函数：截断 / Prompt / 标题 / 结果校验 / HTML                       */
/* ------------------------------------------------------------------ */

describe('extract-doc 纯函数', () => {
  it('短文本不截断，CRLF 归一化成 LF', () => {
    const result = truncateForExtraction('第一行\r\n第二行');
    expect(result.truncated).toBe(false);
    expect(result.text).toBe('第一行\n第二行');
  });

  it('超长文本按最近换行截断，且不超过上限', () => {
    const line = 'a'.repeat(99);
    const source = Array.from({ length: 120 }, () => line).join('\n');
    expect(source.length).toBeGreaterThan(EXTRACT_MAX_CHARS);
    const result = truncateForExtraction(source);
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(EXTRACT_MAX_CHARS);
    // 每一行都是完整的 99 个 a（没有把某一行切成一半）
    expect(result.text.split('\n').every((item) => item.length === 99)).toBe(true);
    expect(result.text.endsWith('a')).toBe(true);
  });

  it('没有换行可截时硬截断，但不把 emoji 的代理对劈成两半', () => {
    const source = 'a'.repeat(EXTRACT_MAX_CHARS - 1) + '😀';
    const result = truncateForExtraction(source);
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBe(EXTRACT_MAX_CHARS - 1);
    expect(result.text).toBe('a'.repeat(EXTRACT_MAX_CHARS - 1));
  });

  it('超过上限时优先在换行处断开', () => {
    const source = 'a'.repeat(5000) + '\n' + 'b'.repeat(5000);
    const result = truncateForExtraction(source);
    expect(result.truncated).toBe(true);
    expect(result.text).toBe('a'.repeat(5000));
  });

  it('截断提示文案与 8000 字上限一致', () => {
    expect(EXTRACT_TRUNCATED_HINT).toContain('8000');
    expect(EXTRACT_MAX_CHARS).toBe(8000);
  });

  it('Prompt 带齐四条硬性要求（标题/禁开场白/禁脑补/保留结构化内容）', () => {
    const prompt = buildExtractPrompt('复习方法', '原文内容');
    expect(prompt).toContain('第一行只写纯文本标题');
    expect(prompt).toContain('严禁任何开场白');
    expect(prompt).toContain('严禁脑补');
    expect(prompt).toContain('表格、代码');
    expect(prompt).toContain('笔记标题：复习方法');
    expect(prompt).toContain('原文内容');
    // 系统提示词单独一套：必须允许小标题（不能套用「禁 Markdown 标题」的通用提示词）
    expect(EXTRACT_SYSTEM_PROMPT).toContain('小标题');
    expect(EXTRACT_SYSTEM_PROMPT).toContain('第一行只输出纯文本标题');
  });

  it('标题清洗去掉 Markdown 标题符/列表符/数字前缀/强调符', () => {
    expect(normalizeExtractTitle('# 我的标题')).toBe('我的标题');
    expect(normalizeExtractTitle('## 二级标题')).toBe('二级标题');
    expect(normalizeExtractTitle('- 列表标题')).toBe('列表标题');
    expect(normalizeExtractTitle('1. 第一步')).toBe('第一步');
    expect(normalizeExtractTitle('**加粗标题**')).toBe('加粗标题');
    expect(normalizeExtractTitle('“引号标题”')).toBe('引号标题');
    expect(normalizeExtractTitle('   ', '源笔记')).toBe('源笔记');
    expect(normalizeExtractTitle('', '源笔记')).toBe('源笔记');
  });

  it('标题重名时追加 (2)/(3)，不覆盖已有笔记', () => {
    expect(uniqueExtractTitle('重点整理', [])).toBe('重点整理');
    expect(uniqueExtractTitle('重点整理', ['重点整理'])).toBe('重点整理 (2)');
    expect(uniqueExtractTitle('重点整理', ['重点整理', '重点整理 (2)'])).toBe('重点整理 (3)');
    expect(uniqueExtractTitle('重点整理', ['另一篇'])).toBe('重点整理');
  });

  it('把模型输出拆成首行标题与正文，整篇被代码围栏包住时先剥围栏', () => {
    const normal = splitExtractionOutput('重点整理\n\n## 核心结论\n- 一条');
    expect(normal.title).toBe('重点整理');
    expect(normal.body).toBe('## 核心结论\n- 一条');

    const fenced = splitExtractionOutput('```markdown\n重点整理\n\n正文\n```');
    expect(fenced.title).toBe('重点整理');
    expect(fenced.body).toBe('正文');

    const empty = splitExtractionOutput('   ', '源笔记');
    expect(empty.title).toBe('源笔记');
    expect(empty.body).toBe('');
  });

  it('空结果/纯空白/只有标点都判错，正常文字放行', () => {
    expect(extractResultError('')).not.toBeNull();
    expect(extractResultError('   \n\t ')).not.toBeNull();
    expect(extractResultError('*** ###')).not.toBeNull();
    expect(extractResultError('好的，以下是文档')).toBeNull();
    expect(extractResultError('2025 年计划')).toBeNull();
  });

  it('正文转 HTML：表格/代码块保留，末尾追加溯源引用块且标题转义', () => {
    const body = [
      '## 核心结论',
      '- 间隔重复与主动回忆',
      '',
      '| 概念 | 说明 |',
      '| --- | --- |',
      '| 间隔重复 | 按遗忘曲线安排 |',
      '',
      '```js',
      'console.log(1)',
      '```'
    ].join('\n');
    const html = buildExtractHtml(body, '《复习 <方法>》');
    expect(html).toContain('<table');
    expect(html).toContain('<th');
    expect(html).toContain('<pre');
    expect(html).toContain(`<blockquote class="${EXTRACT_SOURCE_CLASS}">`);
    expect(html).toContain('本文由《《复习 &lt;方法&gt;》》经 AI 提炼生成。');
  });
});

/* ------------------------------------------------------------------ */
/* 数据库：事务化落库 / 继承分类标签 / 标题去重                          */
/* ------------------------------------------------------------------ */

let root = '';
let paths: DataPaths;

function resetData(): void {
  const raw = db.getRawDb();
  raw.exec('PRAGMA foreign_keys = OFF');
  for (const table of ['note_tag', 'note_version', 'attachment', 'note', 'tag']) {
    raw.exec(`delete from ${table}`);
  }
  raw.exec('delete from note_fts');
  raw.exec('PRAGMA foreign_keys = ON');
}

describe('createExtractedNote', () => {
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'jwkb-extract-'));
    paths = ensureDirs(root);
    db.openDatabase(paths);
  });

  afterAll(() => {
    try {
      db.closeDatabase();
    } catch {
      /* 已关闭 */
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    resetData();
  });

  it('继承原笔记的分类与标签，正文含表格与溯源块，源笔记不被改动', () => {
    const categoryId = db.createCategory(null, '学习');
    const sourceId = db.createNote({
      categoryId,
      title: '复习方法源笔记',
      content: '# 复习方法\n\n间隔重复和主动回忆。'
    });
    db.setNoteTags(sourceId, ['复习', '方法']);

    const markdown = [
      '重点整理',
      '',
      '## 核心结论',
      '- 间隔重复与主动回忆',
      '',
      '| 概念 | 说明 |',
      '| --- | --- |',
      '| 间隔重复 | 按遗忘曲线安排 |'
    ].join('\n');
    const created = db.createExtractedNote({ sourceNoteId: sourceId, markdown });

    expect(created.title).toBe('重点整理');
    expect(created.category_id).toBe(categoryId);
    expect(created.tags.map((tag) => tag.name).sort()).toEqual(['复习', '方法'].sort());
    expect(created.content_html).toContain('<table');
    expect(created.content_html).toContain(
      `本文由《复习方法源笔记》经 AI 提炼生成。`
    );
    // 源笔记标题/正文不变
    const source = db.getNote(sourceId);
    expect(source?.title).toBe('复习方法源笔记');
    expect(source?.content_html).not.toContain('AI 提炼生成');
    // 新笔记已进 FTS 索引
    expect(db.searchNotes('重点整理').some((hit) => hit.note_id === created.id)).toBe(true);
  });

  it('标题重复时自动追加 (2)，不覆盖已有笔记', () => {
    const sourceId = db.createNote({ title: '源笔记', content: '正文' });
    const markdown = '重点整理\n\n第一条重点';
    const first = db.createExtractedNote({ sourceNoteId: sourceId, markdown });
    const second = db.createExtractedNote({ sourceNoteId: sourceId, markdown });
    expect(first.title).toBe('重点整理');
    expect(second.title).toBe('重点整理 (2)');
    expect(db.getNote(first.id)?.title).toBe('重点整理');
  });

  it('AI 只给了标题、没有正文时抛错且不落库', () => {
    const sourceId = db.createNote({ title: '源笔记', content: '正文' });
    const before = db.listNotes({}).length;
    expect(() => db.createExtractedNote({ sourceNoteId: sourceId, markdown: '只有一个标题' })).toThrow(
      /没有返回可保存的正文/
    );
    expect(db.listNotes({}).length).toBe(before);
  });

  it('源笔记不存在时抛中文错误，不新建笔记', () => {
    const before = db.listNotes({}).length;
    expect(() => db.createExtractedNote({ sourceNoteId: 999999, markdown: '标题\n正文' })).toThrow(
      /原笔记已经不在了/
    );
    expect(db.listNotes({}).length).toBe(before);
  });
});
