import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { categoryFolders, exportNotesToMarkdown, safeFileName, type ExporterDeps } from '../../src/main/export';
import type { Category } from '../../src/shared/types';

/**
 * 第八版任务四：导出全库为 Markdown。
 * 用临时目录 + 假数据库完整跑一遍，验证目录结构、.md 内容、图片拷贝和进度回调。
 */

let workspace = '';
let sourceImages = '';

function cat(id: number, name: string, parentId: number | null = null): Category {
  return {
    id,
    parent_id: parentId,
    name,
    sort_order: id,
    created_at: '2026-10-18T00:00:00.000Z',
    updated_at: '2026-10-18T00:00:00.000Z',
    deleted_at: null
  };
}

const defaultRows = [
  { id: 1, title: '本周回顾', categoryId: 2 },
  { id: 2, title: '开会记录', categoryId: 1 },
  { id: 3, title: '读书笔记', categoryId: 3 },
  { id: 4, title: '随手记', categoryId: null }
];

/** 数据库投影：3 个分类（工作 / 工作下的周报 / 学习）+ 4 篇笔记 */
function makeDeps(overrides: Partial<ExporterDeps> = {}, rows = defaultRows): ExporterDeps {
  const categories = [cat(1, '工作'), cat(2, '周报', 1), cat(3, '学习')];
  const rowOf = (id: number) => rows.find((r) => r.id === id);
  return {
    listNotes: () => rows,
    getNote: (id) => ({
      id: Number(id),
      category_id: rowOf(Number(id))?.categoryId ?? null,
      title: rowOf(Number(id))?.title ?? '',
      content: '纯文字正文\n\n第二段',
      content_html:
        Number(id) === 1
          ? '<h2>这周做了什么</h2><ul><li><strong>修 bug</strong></li><li>写文档</li></ul><p><img src="jw-att://2026-10/a.png" alt="截图"/></p>'
          : Number(id) === 2
            ? '<p>旧图会丢：<img src="jw-att://2026-10/gone.png" alt="丢了"/></p>'
            : '',
      sort_order: 0,
      draft_title: null,
      draft_content: null,
      draft_at: null,
      excerpt: '',
      word_count: 0,
      is_pinned: 0,
      created_at: '2026-10-18T00:00:00.000Z',
      updated_at: '2026-10-18T00:00:00.000Z',
      deleted_at: null,
      tags: Number(id) === 1 ? [{ id: 1, name: '周报' }] : []
    }),
    categories: () => categories,
    attachmentAbsPath: (relPath) => path.join(sourceImages, relPath.replace(/\//g, path.sep)),
    // 不能直接展开 overrides 覆盖函数以外的东西：这里只让测试覆盖单个方法
    ...overrides
  } as ExporterDeps;
}

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jwkb-export-'));
  sourceImages = path.join(workspace, 'src-attachments');
  fs.mkdirSync(path.join(sourceImages, '2026-10'), { recursive: true });
  fs.writeFileSync(path.join(sourceImages, '2026-10', 'a.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('导出 Markdown：目录结构', () => {
  it('按分类树建目录，没分类的进「未分类」，每篇一个 .md', () => {
    const out = path.join(workspace, 'out');
    const result = exportNotesToMarkdown(out, makeDeps());

    expect(result.notes).toBe(4);
    expect(fs.existsSync(path.join(out, '工作', '周报', '本周回顾.md'))).toBe(true);
    expect(fs.existsSync(path.join(out, '工作', '开会记录.md'))).toBe(true);
    expect(fs.existsSync(path.join(out, '学习', '读书笔记.md'))).toBe(true);
    expect(fs.existsSync(path.join(out, '未分类', '随手记.md'))).toBe(true);
    expect(result.folders).toBe(4);
  });

  it('同名标题不会互相覆盖，自动加 (2)', () => {
    const out = path.join(workspace, 'dup');
    const rows = [
      { id: 1, title: '同名', categoryId: null },
      { id: 2, title: '同名', categoryId: null }
    ];
    const deps = makeDeps({}, rows);
    exportNotesToMarkdown(out, deps);
    expect(fs.existsSync(path.join(out, '未分类', '同名.md'))).toBe(true);
    expect(fs.existsSync(path.join(out, '未分类', '同名 (2).md'))).toBe(true);
  });

  it('文件名里的非法字符会被换掉', () => {
    expect(safeFileName('a/b:c*d?"e<f>g|h')).toBe('a b c d e f g h');
    expect(safeFileName('   ')).toBe('无标题');
  });

  it('分类路径能一路还原到根', () => {
    const byId = new Map([cat(1, '工作'), cat(2, '周报', 1), cat(3, '学习')].map((c) => [c.id, c]));
    expect(categoryFolders(2, byId)).toEqual(['工作', '周报']);
    expect(categoryFolders(3, byId)).toEqual(['学习']);
    expect(categoryFolders(null, byId)).toEqual([]);
  });
});

describe('导出 Markdown：正文与附件', () => {
  it('富文本转成 Markdown，标签写进 frontmatter', () => {
    const out = path.join(workspace, 'md');
    exportNotesToMarkdown(out, makeDeps());
    const text = fs.readFileSync(path.join(out, '工作', '周报', '本周回顾.md'), 'utf8');

    expect(text).toContain('tags: [周报]');
    expect(text).toContain('## 这周做了什么');
    expect(text).toContain('- **修 bug**');
    expect(text).toContain('- 写文档');
    expect(text).not.toContain('<h2>');
  });

  it('图片会拷到 attachments，正文里用相对路径（从分类子目录回指）', () => {
    const out = path.join(workspace, 'withimg');
    const result = exportNotesToMarkdown(out, makeDeps());

    const copied = path.join(out, 'attachments', '2026-10', 'a.png');
    expect(fs.existsSync(copied)).toBe(true);
    expect(result.attachments).toBe(1);

    const text = fs.readFileSync(path.join(out, '工作', '周报', '本周回顾.md'), 'utf8');
    expect(text).toContain('![截图](../../attachments/2026-10/a.png)');
  });

  it('磁盘上找不到的图片只留 alt，并记进 missing', () => {
    const out = path.join(workspace, 'missing');
    const result = exportNotesToMarkdown(out, makeDeps());
    expect(result.missing).toContain('2026-10/gone.png');
    const text = fs.readFileSync(path.join(out, '工作', '开会记录.md'), 'utf8');
    expect(text).toContain('丢了');
    expect(text).not.toContain('jw-att://');
  });

  it('没有富文本的老笔记用纯文字正文导出', () => {
    const out = path.join(workspace, 'plain');
    exportNotesToMarkdown(out, makeDeps());
    const text = fs.readFileSync(path.join(out, '学习', '读书笔记.md'), 'utf8');
    expect(text).toContain('# 读书笔记');
    expect(text).toContain('纯文字正文\n\n第二段');
  });
});

describe('导出 Markdown：进度回调', () => {
  it('每导完一篇报一次，done 从 1 涨到 total', () => {
    const out = path.join(workspace, 'progress');
    const seen: Array<[number, number, string]> = [];
    exportNotesToMarkdown(out, makeDeps({ onProgress: (done, total, title) => seen.push([done, total, title]) }));

    expect(seen).toHaveLength(4);
    expect(seen[0]).toEqual([1, 4, '本周回顾']);
    expect(seen[3]).toEqual([4, 4, '随手记']);
  });
});
