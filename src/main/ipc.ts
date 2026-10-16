import { BrowserWindow, app, dialog, ipcMain, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import * as db from './db';
import * as backup from './backup';
import type { DataPaths } from './paths';
import type {
  AppSettings,
  Goal,
  GoalHorizon,
  GoalPoolItem,
  Id,
  InboxKind,
  InboxStatus,
  KeyResult,
  ListFilter,
  Milestone,
  Plan,
  PlanItem,
  RetroType,
  ReviewGrade,
  ReviewSource,
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
  /** 拖拽进来的文件：渲染层拿得到绝对路径，直接复制进附件目录。 */
  handle('attach:add-path', (p: { noteId: Id | null; srcPath: string }) => {
    if (!p?.srcPath) throw new Error('没有取到文件路径');
    if (!fs.existsSync(p.srcPath)) throw new Error('找不到这个文件：' + p.srcPath);
    return db.addAttachment(p.noteId, p.srcPath, path.basename(p.srcPath));
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
        ref = `goal:${db.createGoal({ title })}`;
      } else {
        ref = `plan:${db.createPlan({ title })}`;
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
  // 多选模式一次删一批，返回真正删掉的条数
  handle('task:delete-many', (p: { ids: Id[] }) => db.deleteTasks(p?.ids ?? []));

  /* ---------------- 首页 ---------------- */

  handle('dash:overview', () => db.dashboard());

  /* ---------------- 当前目标（第二版） ---------------- */

  handle('goal:list', (p: { includeArchived?: boolean }) => db.listGoals(p?.includeArchived ?? false));
  handle('goal:get', (p: { id: Id }) => db.getGoalDetail(p.id));
  handle('goal:create', (p: { title: string; description?: string; target_date?: string | null }) =>
    db.createGoal(p)
  );
  handle('goal:update', (p: { id: Id; patch: Partial<Goal> }) => {
    db.updateGoal(p.id, p.patch);
    return true;
  });
  handle('goal:delete', (p: { id: Id }) => {
    db.deleteGoal(p.id);
    return true;
  });
  handle('goal:active-count', () => db.activeGoalCount());

  handle('kr:list', (p: { goalId: Id }) => db.listKeyResults(p.goalId));
  handle('kr:create', (p: { goalId: Id } & Parameters<typeof db.createKeyResult>[1]) =>
    db.createKeyResult(p.goalId, p)
  );
  handle('kr:update', (p: { id: Id; patch: Partial<KeyResult> }) => {
    db.updateKeyResult(p.id, p.patch);
    return true;
  });
  handle('kr:delete', (p: { id: Id }) => {
    db.deleteKeyResult(p.id);
    return true;
  });

  handle('milestone:list', (p: { goalId: Id }) => db.listMilestones(p.goalId));
  handle('milestone:create', (p: { goalId: Id; title: string; target_date?: string | null }) =>
    db.createMilestone(p.goalId, p)
  );
  handle('milestone:update', (p: { id: Id; patch: Partial<Milestone> }) => {
    db.updateMilestone(p.id, p.patch);
    return true;
  });
  handle('milestone:toggle', (p: { id: Id; done?: boolean }) => {
    db.toggleMilestone(p.id, p.done);
    return true;
  });
  handle('milestone:delete', (p: { id: Id }) => {
    db.deleteMilestone(p.id);
    return true;
  });

  /* ---------------- 下一阶段目标（第二版） ---------------- */

  handle('pool:list', (p: { horizon?: GoalHorizon }) => db.listGoalPool(p?.horizon));
  handle('pool:create', (p: Parameters<typeof db.createPoolItem>[0]) => db.createPoolItem(p));
  handle('pool:update', (p: { id: Id; patch: Partial<GoalPoolItem> }) => {
    db.updatePoolItem(p.id, p.patch);
    return true;
  });
  handle('pool:delete', (p: { id: Id }) => {
    db.deletePoolItem(p.id);
    return true;
  });
  handle('pool:start', (p: { id: Id }) => db.startPoolItem(p.id));

  /* ---------------- 学习计划（第二版） ---------------- */

  handle('plan:list', (p: { includeArchived?: boolean }) => db.listPlans(p?.includeArchived ?? false));
  handle('plan:get', (p: { id: Id }) => db.getPlanDetail(p.id));
  handle('plan:create', (p: Parameters<typeof db.createPlan>[0]) => db.createPlan(p));
  handle('plan:update', (p: { id: Id; patch: Partial<Plan> }) => {
    db.updatePlan(p.id, p.patch);
    return true;
  });
  handle('plan:delete', (p: { id: Id }) => {
    db.deletePlan(p.id);
    return true;
  });
  handle('plan-item:list', (p: { planId: Id }) => db.listPlanItems(p.planId));
  handle('plan-item:create', (p: { planId: Id } & Parameters<typeof db.createPlanItem>[1]) =>
    db.createPlanItem(p.planId, p)
  );
  handle('plan-item:update', (p: { id: Id; patch: Partial<PlanItem> }) => {
    db.updatePlanItem(p.id, p.patch);
    return true;
  });
  handle('plan-item:toggle', (p: { id: Id; done?: boolean }) => {
    db.togglePlanItem(p.id, p.done);
    return true;
  });
  handle('plan-item:delete', (p: { id: Id }) => {
    db.deletePlanItem(p.id);
    return true;
  });
  handle('plan:calendar', (p: { from: string; to: string }) => db.calendarEntries(p.from, p.to));

  /* ---------------- 复习与复盘（第二版） ---------------- */

  handle('review:list', (p: { due?: boolean; source?: ReviewSource; limit?: number }) =>
    db.listReviewCards(p ?? {})
  );
  handle('review:due', () => db.dueReviewCards());
  handle('review:stats', () => db.reviewStats());
  handle('review:create', (p: Parameters<typeof db.createReviewCard>[0]) => db.createReviewCard(p));
  handle('review:from-note', (p: { noteId: Id }) => db.createCardFromNote(p.noteId));
  handle('review:update', (p: { id: Id; patch: Partial<Parameters<typeof db.createReviewCard>[0]> }) => {
    db.updateReviewCard(p.id, p.patch);
    return true;
  });
  handle('review:delete', (p: { id: Id }) => {
    db.deleteReviewCard(p.id);
    return true;
  });
  handle('review:grade', (p: { id: Id; grade: ReviewGrade }) => db.gradeReviewCard(p.id, p.grade));
  handle('review:logs', (p: { cardId: Id }) => db.reviewLogs(p.cardId));

  handle('retro:list', (p: { type?: RetroType }) => db.listRetrospectives(p?.type));
  handle('retro:get', (p: { type: RetroType; date: string }) => db.getRetrospective(p.type, p.date));
  handle('retro:save', (p: { type: RetroType; date: string; content: string }) =>
    db.saveRetrospective(p.type, p.date, p.content)
  );
  handle('retro:delete', (p: { id: Id }) => {
    db.deleteRetrospective(p.id);
    return true;
  });
  handle('retro:period', (p: { type: 'week' | 'month'; date?: string }) => {
    const base = p?.date ? new Date(`${p.date}T12:00:00`) : new Date();
    return db.periodRange(p.type, base);
  });
  handle('retro:stats', (p: { from: string; to: string }) => db.periodStats(p.from, p.to));

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
