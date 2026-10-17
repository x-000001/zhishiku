import * as db from '../db';
import type { Id, InboxKind, InboxStatus, Task, TaskFilter, TaskPriority } from '../../shared/types';
import type { Handle } from './common';

/** 收集箱、任务、首页概览。 */
export function registerTasks(handle: Handle): void {
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
      priority?: TaskPriority;
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
          priority: p.priority ?? 'normal',
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
}
