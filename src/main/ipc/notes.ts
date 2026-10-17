import * as db from '../db';
import type { Id, ListFilter } from '../../shared/types';
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
  handle('search:reindex', () => db.rebuildSearchIndex());
}
