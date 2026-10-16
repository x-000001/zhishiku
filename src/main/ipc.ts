import { BrowserWindow, app, dialog, ipcMain, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import * as db from './db';
import * as backup from './backup';
import type { DataPaths } from './paths';
import type {
  AppSettings,
  Id,
  InboxKind,
  InboxStatus,
  ListFilter,
  Task,
  TaskFilter
} from '../shared/types';

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

function wrap<T>(fn: (payload: never) => T | Promise<T>) {
  return async (_event: unknown, payload: unknown): Promise<Result<T>> => {
    try {
      return { ok: true, data: await fn(payload as never) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[IPC] 处理失败：', message);
      return { ok: false, error: message };
    }
  };
}

export interface IpcContext {
  paths: DataPaths;
  sqliteVersion: string;
}

export function registerIpc(getPaths: () => DataPaths, sqliteVersion: string): void {
  const has = (channel: string) => ipcMain.removeHandler(channel);
  const handle = <T>(channel: string, fn: (payload: never) => T | Promise<T>) => {
    has(channel);
    ipcMain.handle(channel, wrap(fn));
  };

  /* ---------------- 应用与设置 ---------------- */

  handle('app:info', () => {
    const p = getPaths();
    return {
      dataRoot: p.root,
      dbPath: p.db,
      attachmentsDir: p.attachments,
      backupsDir: p.backups,
      version: app.getVersion(),
      electron: process.versions.electron ?? '',
      node: process.versions.node ?? '',
      sqlite: sqliteVersion
    };
  });

  handle('settings:get', (): AppSettings => {
    const s = db.allSettings();
    return {
      dataRoot: getPaths().root,
      versionKeep: Number(s.versionKeep ?? '20'),
      theme: (s.theme as 'light' | 'dark') ?? 'light',
      notifyEnabled: s.notifyEnabled === '1',
      closeToTray: s.closeToTray === '1'
    };
  });

  handle('settings:set', (payload: { key: string; value: string | number | boolean }) => {
    db.setSetting(payload.key, typeof payload.value === 'boolean' ? (payload.value ? '1' : '0') : String(payload.value));
    return db.allSettings();
  });

  /* ---------------- 分类 ---------------- */

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

  /* ---------------- 笔记 ---------------- */

  handle('note:list', (p: ListFilter) => db.listNotes(p ?? {}));
  handle('note:get', (p: { id: Id }) => db.getNote(p.id));
  handle('note:create', (p: { categoryId?: Id | null; title?: string; content?: string }) => {
    const id = db.createNote(p ?? {});
    return db.getNote(id);
  });
  handle('note:draft', (p: { id: Id; title: string; content: string }) => {
    db.saveDraft(p.id, p.title, p.content);
    return true;
  });
  handle('note:save', (p: { id: Id; title: string; content: string; reason?: string }) => {
    const version = db.saveNote(p.id, p.title, p.content, p.reason ?? '手动保存');
    return { note: db.getNote(p.id), version };
  });
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

  /* ---------------- 搜索 ---------------- */

  handle('search:query', (p: { q: string; limit?: number }) => db.searchNotes(p.q, p.limit ?? 30));
  handle('search:reindex', () => db.rebuildSearchIndex());

  /* ---------------- 附件 ---------------- */

  handle('attach:add', async (p: { noteId: Id | null }) => {
    const win = BrowserWindow.getAllWindows()[0];
    const picked = win
      ? await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'], title: '添加附件' })
      : await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'], title: '添加附件' });
    if (picked.canceled) return [];
    return picked.filePaths.map((file) => db.addAttachment(p.noteId, file, path.basename(file)));
  });
  handle('attach:open', (p: { id: Id; relPath: string }) => {
    const abs = db.attachmentAbsPath(p.relPath);
    if (!fs.existsSync(abs)) throw new Error('文件已不在原位：' + p.relPath);
    return shell.openPath(abs);
  });
  handle('attach:delete', (p: { id: Id }) => {
    db.deleteAttachment(p.id);
    return true;
  });

  /* ---------------- 收集箱 ---------------- */

  handle('inbox:list', (p: { status?: InboxStatus | 'all' }) => db.listInbox(p?.status ?? 'open'));
  handle('inbox:add', (p: { content: string; kind?: InboxKind }) => db.addInbox(p.content, p.kind ?? 'idea'));
  handle('inbox:update', (p: { id: Id; content?: string; kind?: InboxKind }) => {
    db.updateInbox(p.id, p);
    return true;
  });
  handle('inbox:discard', (p: { id: Id }) => {
    db.setInboxStatus(p.id, 'discarded');
    return true;
  });
  handle('inbox:restore', (p: { id: Id }) => {
    db.setInboxStatus(p.id, 'open');
    return true;
  });
  handle('inbox:delete', (p: { id: Id }) => {
    db.deleteInbox(p.id);
    return true;
  });
  handle(
    'inbox:convert',
    (p: {
      id: Id;
      target: 'note' | 'task' | 'goal' | 'plan';
      title?: string;
      categoryId?: Id | null;
      due_at?: string | null;
      priority?: number;
      repeat_rule?: Task['repeat_rule'];
    }) => {
      const item = db.listInbox('all').find((i) => i.id === p.id);
      if (!item) throw new Error('这条收集箱记录已经不在了');
      const title = (p.title ?? item.content).trim();
      let ref = '';
      if (p.target === 'note') {
        const id = db.createNote({ categoryId: p.categoryId ?? null, title, content: item.content });
        ref = `note:${id}`;
      } else if (p.target === 'task') {
        const id = db.createTask({
          title,
          note: item.content,
          due_at: p.due_at ?? null,
          priority: p.priority ?? 2,
          repeat_rule: p.repeat_rule ?? 'none'
        });
        ref = `task:${id}`;
      } else if (p.target === 'goal') {
        ref = `goal:${db.createGoalFromInbox(title)}`;
      } else {
        ref = `plan:${db.createPlanFromInbox(title)}`;
      }
      db.setInboxStatus(p.id, 'processed', ref);
      return { ref };
    }
  );

  /* ---------------- 任务 ---------------- */

  handle('task:list', (p: TaskFilter) => db.listTasks(p ?? {}));
  handle('task:counts', () => db.taskCounts());
  handle('task:create', (p: Partial<Task> & { title: string }) => db.createTask(p));
  handle('task:update', (p: { id: Id; patch: Partial<Task> }) => {
    db.updateTask(p.id, p.patch);
    return true;
  });
  handle('task:toggle', (p: { id: Id; status?: Task['status'] }) => db.toggleTask(p.id, p.status));
  handle('task:delete', (p: { id: Id }) => {
    db.deleteTask(p.id);
    return true;
  });

  /* ---------------- 首页 ---------------- */

  handle('dash:overview', () => db.dashboard());

  /* ---------------- 备份与恢复 ---------------- */

  handle('backup:list', () => backup.listBackups(getPaths()));
  handle('backup:run', () => backup.runBackup(getPaths(), true));
  handle('backup:restore', (p: { name: string }) => {
    const r = backup.restoreBackup(getPaths(), p.name);
    db.rebuildSearchIndex();
    return r;
  });
  handle('backup:delete', (p: { name: string }) => {
    backup.deleteBackup(getPaths(), p.name);
    return true;
  });
  handle('backup:reveal', () => shell.openPath(getPaths().backups));
  handle('data:reveal', () => shell.openPath(getPaths().root));
  handle('data:integrity', () => db.integrityCheck());
}
