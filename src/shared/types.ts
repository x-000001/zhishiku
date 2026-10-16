/** 主进程与渲染进程共用的数据类型。字段命名与 SQLite 表列一一对应。 */

export type Id = number;

export interface Category {
  id: Id;
  parent_id: Id | null;
  name: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  /** 仅用于界面：该分类下直接归属的笔记数量 */
  note_count?: number;
}

export interface Note {
  id: Id;
  category_id: Id | null;
  title: string;
  content: string;
  draft_title: string | null;
  draft_content: string | null;
  draft_at: string | null;
  excerpt: string;
  word_count: number;
  is_pinned: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface NoteListItem {
  id: Id;
  category_id: Id | null;
  category_name: string | null;
  title: string;
  excerpt: string;
  word_count: number;
  is_pinned: number;
  updated_at: string;
}

export interface NoteVersion {
  id: Id;
  note_id: Id;
  title: string;
  content: string;
  word_count: number;
  reason: string;
  created_at: string;
}

export interface Tag {
  id: Id;
  name: string;
  note_count?: number;
}

export interface Attachment {
  id: Id;
  note_id: Id | null;
  file_name: string;
  rel_path: string;
  size: number;
  mime: string | null;
  created_at: string;
}

export type InboxKind = 'idea' | 'read' | 'organize';
export type InboxStatus = 'open' | 'processed' | 'discarded';

export interface InboxItem {
  id: Id;
  content: string;
  kind: InboxKind;
  status: InboxStatus;
  converted_to: string | null;
  created_at: string;
  updated_at: string;
}

export type TaskStatus = 'todo' | 'done';
export type RepeatRule = 'none' | 'daily' | 'weekdays' | 'weekly' | 'monthly';

export interface Task {
  id: Id;
  title: string;
  note: string;
  status: TaskStatus;
  priority: number; // 1 低 / 2 中 / 3 高
  due_at: string | null; // YYYY-MM-DD 或 YYYY-MM-DD HH:mm（本地时间）
  repeat_rule: RepeatRule;
  goal_id: Id | null;
  plan_id: Id | null;
  completed_at: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  /** 视图用：是否已逾期 */
  overdue?: boolean;
}

export interface ListFilter {
  q?: string;
  categoryId?: Id | null;
  tagId?: Id | null;
  trash?: boolean;
  limit?: number;
}

export interface TaskFilter {
  view?: 'today' | 'all' | 'upcoming' | 'done' | 'overdue';
  q?: string;
  goalId?: Id;
  /** 一次最多取多少条，默认 500、上限 2000（见 db.listTasks） */
  limit?: number;
}

export interface DashboardData {
  today: string;
  tasks: Task[];
  overdueCount: number;
  doneTodayCount: number;
  inboxCount: number;
  reviewDue: { id: Id; note_id: Id | null; front: string; next_review_at: string }[];
  goals: { id: Id; title: string; progress: number; target_date: string | null }[];
  recentNotes: NoteListItem[];
}

export interface AppSettings {
  dataRoot: string;
  versionKeep: number; // 每篇笔记保留的版本点数量，0 表示关闭
  theme: 'light' | 'dark';
  notifyEnabled: boolean;
  closeToTray: boolean;
}

export interface BackupEntry {
  name: string; // 目录名，如 2026-10-16_1130
  path: string;
  created_at: string;
  size: number;
  kind: 'daily' | 'manual' | 'pre-restore';
}

export interface SearchHit {
  note_id: Id;
  title: string;
  category_name: string | null;
  snippet: string;
  updated_at: string;
}

export interface AppInfo {
  dataRoot: string;
  dbPath: string;
  attachmentsDir: string;
  backupsDir: string;
  version: string;
  electron: string;
  node: string;
  sqlite: string;
}

/** preload 暴露给渲染进程的接口。 */
export interface KbApi {
  invoke<T = unknown>(channel: string, payload?: unknown): Promise<T>;
  on(channel: string, listener: (payload: unknown) => void): () => void;
}

declare global {
  interface Window {
    api?: KbApi;
  }
}
