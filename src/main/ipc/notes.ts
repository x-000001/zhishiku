import * as db from '../db';
import type { Id, ListFilter, SearchAdvancedRequest, SearchAdvancedResult, SearchHit } from '../../shared/types';
import { parseSearchQuery } from '../../shared/search-query';
import { extractBacklinkKeywords } from '../../shared/backlinks';
import { extractResultError } from '../../shared/extract-doc';
import type { Handle } from './common';

/** 分类、笔记、版本点、标签、搜索：知识库这一摊。 */
export function registerNotes(handle: Handle): void {
  handle('category:tree', () => db.categoryTree());
  handle('category:create', (p: { parentId: Id | null; name: string }) => db.createCategory(p.parentId, p.name));
  handle('category:rename', (p: { id: Id; name: string }) => {
    db.renameCategory(p.id, p.name);
    return true;
  });
  handle('category:delete', (p: { id: Id }) => {
    db.deleteCategory(p.id);
    return true;
  });
  handle('category:move', (p: { id: Id; dir: 'up' | 'down' }) => {
    db.moveCategory(p.id, p.dir);
    return true;
  });

  /* ---------------- 笔记 ---------------- */

  handle('note:list', (p: ListFilter) => db.listNotes(p ?? {}));
  handle('note:get', (p: { id: Id }) => db.getNote(p.id));
  handle('note:create', (p: { categoryId?: Id | null; title?: string; content?: string; html?: string }) => {
    const id = db.createNote(p ?? {});
    return db.getNote(id);
  });
  handle('note:draft', (p: { id: Id; title: string; content: string }) => {
    db.saveDraft(p.id, p.title, p.content);
    return true;
  });
  handle('note:save', (p: { id: Id; title: string; content?: string; html?: string; reason?: string }) => {
    const reason = p.reason ?? '手动保存';
    // 富文本编辑器交 html；老调用交 Markdown 纯文字
    const version =
      p.html != null
        ? db.saveNoteHtml(p.id, p.title, p.html, reason)
        : db.saveNote(p.id, p.title, p.content ?? '', reason);
    return { note: db.getNote(p.id), version };
  });
  handle('note:reorder', (p: { ids: Id[] }) => db.reorderNotes(p?.ids ?? []));
  handle('note:move', (p: { id: Id; categoryId: Id | null }) => {
    db.moveNote(p.id, p.categoryId);
    return true;
  });
  handle('note:pin', (p: { id: Id }) => {
    db.togglePin(p.id);
    return true;
  });
  handle('note:trash', (p: { id: Id }) => {
    db.trashNote(p.id);
    return true;
  });
  handle('note:restore', (p: { id: Id }) => {
    db.restoreNote(p.id);
    return true;
  });
  handle('note:purge', (p: { id: Id }) => {
    db.purgeNote(p.id);
    return true;
  });
  handle('note:empty-trash', () => db.emptyTrash());

  /* ---------------- 版本点 ---------------- */

  handle('version:list', (p: { noteId: Id }) => db.listVersions(p.noteId));
  handle('version:rollback', (p: { id: Id }) => db.rollbackVersion(p.id));

  /* ---------------- 标签 ---------------- */

  handle('tag:list', () => db.listTags());
  handle('tag:set', (p: { noteId: Id; names: string[] }) => {
    db.setNoteTags(p.noteId, p.names);
    return db.getNote(p.noteId);
  });
  handle('tag:rename', (p: { id: Id; name: string }) => db.renameTag(p.id, p.name));
  handle('tag:delete', (p: { id: Id }) => db.deleteTagById(p.id));

  /* ---------------- 搜索 ---------------- */

  handle('search:query', (p: { q: string; limit?: number }) => db.searchNotes(p.q, p.limit ?? 30));

  /**
   * 高级检索（0.12.0 阶段2）：渲染层会把 `tag:工作` / `is:pinned` 解析成结构化条件传过来，
   * 但这里不信任渲染层的解析结果 —— 按 raw 原文用同一个 shared 解析器重新解析一次，
   * 保证 `tag:` / `is:` 一定不会进 FTS5 的 MATCH 字符串（防绕过、防渲染层被改）。
   */
  handle('search:advanced', (p: SearchAdvancedRequest) => {
    const parsed = parseSearchQuery(p?.raw ?? '');
    const limit = Math.min(Math.max(Number(p?.limit ?? 30) || 30, 1), 100);
    const existing = db.tagNamesIn(parsed.tags);
    const unknownTags = parsed.tags.filter((tag) => existing.indexOf(tag) < 0);
    const hasRule = parsed.text.length > 0 || parsed.tags.length > 0 || parsed.flags.length > 0;
    // 不支持的 is: 状态不静默忽略：宁可返回空结果 + 提示，也不给人「过滤生效了」的错觉
    let hits: SearchHit[] = [];
    if (hasRule && parsed.unknownFlags.length === 0) {
      hits = db.searchNotesAdvanced(parsed.text, limit, {
        tags: parsed.tags,
        pinned: parsed.flags.indexOf('pinned') >= 0,
        trash: parsed.flags.indexOf('trash') >= 0
      });
    }
    const result: SearchAdvancedResult = {
      hits,
      text: parsed.text,
      tags: parsed.tags,
      flags: parsed.flags,
      unknownTags,
      unknownFlags: parsed.unknownFlags
    };
    return result;
  });

  handle('search:reindex', () => db.rebuildSearchIndex());

  /**
   * 相关笔记（0.12.0 阶段3）：主进程读当前笔记 → 提取关键词（过滤停用词）→ FTS5 检索。
   * 排除当前笔记的 `and n.id != ?` 写死在 db.searchRelatedNotes 的 SQL 里。
   */
  handle('note:related', (p: { id: Id; limit?: number }) => {
    const note = db.getNote(p.id);
    if (!note) return [];
    const terms = extractBacklinkKeywords({ title: note.title ?? '', text: note.content ?? '' });
    return db.searchRelatedNotes(p.id, terms, p.limit ?? 6);
  });

  /**
   * AI「整理成重点文档」落库（0.12.1）：空结果在这里再拦一次，绝不落空笔记；
   * 事务、标题去重、继承分类/标签、溯源块都在 db.createExtractedNote 里。
   */
  handle('note:extract-save', (p: { sourceNoteId: Id; markdown: string }) => {
    const markdown = String(p?.markdown ?? '');
    const problem = extractResultError(markdown);
    if (problem) throw new Error(problem);
    return db.createExtractedNote({ sourceNoteId: p.sourceNoteId, markdown });
  });
}
