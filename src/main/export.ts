import fs from 'node:fs';
import path from 'node:path';
import { htmlToMarkdown, plainToMarkdown } from './html-to-md';
import type { Category, Id, Note, Tag } from '../shared/types';

/**
 * 第八版任务四：把整个库导成 Markdown（给用户一条「随时能走」的退路）。
 *
 * 目录结构就按知识库的分类树来：
 *   导出目录/
 *     工作/周报/xxx.md
 *     学习/xxx.md
 *     未分类/xxx.md
 *     attachments/2026-10/图片.png
 * 所有写盘动作都在主进程里做，渲染层只负责弹文件夹选择和显示进度。
 * 文件系统、数据库都通过 deps 注入，所以单测可以用临时目录完整跑一遍。
 */

export interface ExportNoteRow {
  id: Id;
  title: string;
  categoryId: Id | null;
}

export interface ExportNoteDetail extends Note {
  tags?: Tag[];
}

export interface ExporterDeps {
  /** 当前库里没进回收站的笔记（按分类/排序） */
  listNotes(): ExportNoteRow[];
  /** 取一篇笔记的完整内容（含富文本正文） */
  getNote(id: Id): ExportNoteDetail | null;
  /** 分类的扁平列表（含 parent_id），用来还原目录树 */
  categories(): Category[];
  /** 附件在磁盘上的绝对路径（db.attachmentAbsPath） */
  attachmentAbsPath(relPath: string): string;
  /** 每导完一篇报一次进度 */
  onProgress?(done: number, total: number, title: string): void;
}

export interface ExportResult {
  /** 实际导出的根目录 */
  dir: string;
  folders: number;
  notes: number;
  attachments: number;
  /** 附件记录还在、但磁盘上找不到的（不耽误导出，只在结果里提一句） */
  missing: string[];
}

const UNSORTED_DIR = '未分类';
const BAD_NAME_CHARS = /[\\/:*?"<>|]/g;

/** 文件名安全化：去掉 Windows 不认的字符、压空格、限制长度。 */
export function safeFileName(raw: string, fallback = '无标题'): string {
  const name = String(raw ?? '')
    .replace(BAD_NAME_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+/, '')
    .trim()
    .slice(0, 80)
    .trim();
  return name || fallback;
}

/** 从分类往上走到根，返回每一级的安全目录名。 */
export function categoryFolders(categoryId: Id | null, byId: Map<Id, Category>): string[] {
  if (categoryId === null) return [];
  const folders: string[] = [];
  const seen = new Set<Id>();
  let current = byId.get(categoryId) ?? null;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    folders.unshift(safeFileName(current.name, '未命名分类'));
    current = current.parent_id === null ? null : (byId.get(current.parent_id) ?? null);
  }
  return folders;
}

function uniqueName(dir: string, base: string, used: Map<string, Set<string>>): string {
  const key = dir.toLowerCase();
  const taken = used.get(key) ?? new Set<string>();
  used.set(key, taken);
  let name = `${base}.md`;
  let index = 2;
  while (taken.has(name.toLowerCase())) {
    name = `${base} (${index}).md`;
    index += 1;
  }
  taken.add(name.toLowerCase());
  return name;
}

function frontmatter(note: ExportNoteDetail, categoryName: string | null): string {
  const tags = (note.tags ?? []).map((tag) => tag.name).filter(Boolean);
  if (tags.length === 0 && !categoryName) return '';
  const lines = ['---'];
  if (categoryName) lines.push(`category: ${categoryName}`);
  if (tags.length > 0) lines.push(`tags: [${tags.join(', ')}]`);
  lines.push('---', '');
  return `${lines.join('\n')}\n`;
}

/**
 * 真正的导出。rootDir 由调用方（对话框）选好。
 * 同名笔记会自动加 (2)(3) 后缀，不会互相覆盖。
 */
export function exportNotesToMarkdown(rootDir: string, deps: ExporterDeps): ExportResult {
  const root = path.resolve(rootDir);
  const attachmentsDir = path.join(root, 'attachments');
  fs.mkdirSync(root, { recursive: true });

  const categories = deps.categories();
  const byId = new Map<Id, Category>(categories.map((cat) => [cat.id, cat]));
  const rows = deps.listNotes();
  const used = new Map<string, Set<string>>();
  const folders = new Set<string>();
  const copied = new Set<string>();
  const missing: string[] = [];
  let notes = 0;

  rows.forEach((row, index) => {
    const detail = deps.getNote(row.id);
    if (!detail) return;

    const folderParts = row.categoryId === null ? [UNSORTED_DIR] : categoryFolders(row.categoryId, byId);
    if (folderParts.length === 0) folderParts.push(UNSORTED_DIR);
    const noteDir = path.join(root, ...folderParts);
    fs.mkdirSync(noteDir, { recursive: true });
    folders.add(noteDir);

    const markdown = detail.content_html?.trim()
      ? htmlToMarkdown(detail.content_html, {
          resolveImage: (relPath) => {
            const source = deps.attachmentAbsPath(relPath);
            if (!source || !fs.existsSync(source)) {
              missing.push(relPath);
              return '';
            }
            const target = path.join(attachmentsDir, relPath);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            if (!fs.existsSync(target)) fs.copyFileSync(source, target);
            copied.add(relPath);
            // 笔记在分类子目录里，所以用相对路径回指 attachment 目录（Obsidian 认这个）
            return path.relative(noteDir, target).split(path.sep).join('/');
          }
        })
      : plainToMarkdown(detail.content);

    const title = safeFileName(detail.title || row.title);
    const categoryName = row.categoryId === null ? UNSORTED_DIR : (byId.get(row.categoryId)?.name ?? null);
    const head = markdown.startsWith('# ') ? '' : `# ${detail.title || title}\n\n`;
    const body = `${frontmatter(detail, categoryName)}${head}${markdown}`.trimEnd().concat('\n');
    const fileName = uniqueName(noteDir, title, used);
    fs.writeFileSync(path.join(noteDir, fileName), body, 'utf8');

    notes += 1;
    deps.onProgress?.(index + 1, rows.length, detail.title || title);
  });

  return {
    dir: root,
    folders: folders.size,
    notes,
    attachments: copied.size,
    missing: Array.from(new Set(missing))
  };
}
