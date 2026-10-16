import type {
  AppInfo,
  AppSettings,
  Attachment,
  BackupEntry,
  Category,
  DashboardData,
  Id,
  InboxItem,
  InboxKind,
  InboxStatus,
  ListFilter,
  Note,
  NoteListItem,
  NoteVersion,
  SearchHit,
  Tag,
  Task,
  TaskFilter
} from '../../shared/types';

const raw = window.api;
if (!raw) {
  throw new Error('preload 没有加载成功，窗口与主进程的通道不可用。');
}
const bridge = raw;

function call<T>(channel: string, payload?: unknown): Promise<T> {
  return bridge.invoke<T>(channel, payload);
}

/** 渲染进程用的事件通道白名单。 */
export function onEvent(channel: 'nav:go' | 'capture:focus' | 'notice:due', listener: (payload: unknown) => void): () => void {
  return bridge.on(channel, listener);
}

export const api = {
  appInfo: () => call<AppInfo>('app:info'),
  integrity: () => call<string>('data:integrity'),
  revealData: () => call<void>('data:reveal'),
  revealBackups: () => call<void>('backup:reveal'),

  getSettings: () => call<AppSettings>('settings:get'),
  setSetting: (key: string, value: string | number | boolean) =>
    call<Record<string, string>>('settings:set', { key, value }),

  categoryTree: () => call<Category[]>('category:tree'),
  createCategory: (parentId: Id | null, name: string) => call<Id>('category:create', { parentId, name }),
  renameCategory: (id: Id, name: string) => call<boolean>('category:rename', { id, name }),
  deleteCategory: (id: Id) => call<boolean>('category:delete', { id }),

  listNotes: (filter: ListFilter) => call<NoteListItem[]>('note:list', filter),
  getNote: (id: Id) => call<(Note & { tags: Tag[]; attachments: Attachment[] }) | null>('note:get', { id }),
  createNote: (input: { categoryId?: Id | null; title?: string; content?: string }) =>
    call<(Note & { tags: Tag[]; attachments: Attachment[] }) | null>('note:create', input),
  saveDraft: (id: Id, title: string, content: string) => call<boolean>('note:draft', { id, title, content }),
  saveNote: (id: Id, title: string, content: string, reason?: string) =>
    call<{ note: Note; version: NoteVersion | null }>('note:save', { id, title, content, reason }),
  moveNote: (id: Id, categoryId: Id | null) => call<boolean>('note:move', { id, categoryId }),
  togglePin: (id: Id) => call<boolean>('note:pin', { id }),
  trashNote: (id: Id) => call<boolean>('note:trash', { id }),
  restoreNote: (id: Id) => call<boolean>('note:restore', { id }),
  purgeNote: (id: Id) => call<boolean>('note:purge', { id }),
  emptyTrash: () => call<number>('note:empty-trash'),

  listVersions: (noteId: Id) => call<NoteVersion[]>('version:list', { noteId }),
  rollbackVersion: (id: Id) => call<Note>('version:rollback', { id }),

  listTags: () => call<Tag[]>('tag:list'),
  setNoteTags: (noteId: Id, names: string[]) =>
    call<Note & { tags: Tag[]; attachments: Attachment[] }>('tag:set', { noteId, names }),

  search: (q: string, limit?: number) => call<SearchHit[]>('search:query', { q, limit }),
  reindex: () => call<number>('search:reindex'),

  addAttachment: (noteId: Id | null) => call<Attachment[]>('attach:add', { noteId }),
  openAttachment: (id: Id, relPath: string) => call<string>('attach:open', { id, relPath }),
  deleteAttachment: (id: Id) => call<boolean>('attach:delete', { id }),

  listInbox: (status: InboxStatus | 'all' = 'open') => call<InboxItem[]>('inbox:list', { status }),
  addInbox: (content: string, kind: InboxKind = 'idea') => call<Id>('inbox:add', { content, kind }),
  updateInbox: (id: Id, patch: { content?: string; kind?: InboxKind }) =>
    call<boolean>('inbox:update', { id, ...patch }),
  discardInbox: (id: Id) => call<boolean>('inbox:discard', { id }),
  restoreInbox: (id: Id) => call<boolean>('inbox:restore', { id }),
  deleteInbox: (id: Id) => call<boolean>('inbox:delete', { id }),
  convertInbox: (payload: {
    id: Id;
    target: 'note' | 'task' | 'goal' | 'plan';
    title?: string;
    categoryId?: Id | null;
    due_at?: string | null;
    priority?: number;
    repeat_rule?: Task['repeat_rule'];
  }) => call<{ ref: string }>('inbox:convert', payload),

  listTasks: (filter: TaskFilter) => call<Task[]>('task:list', filter),
  taskCounts: () => call<Record<'today' | 'overdue' | 'upcoming' | 'all' | 'done', number>>('task:counts'),
  createTask: (input: Partial<Task> & { title: string }) => call<Id>('task:create', input),
  updateTask: (id: Id, patch: Partial<Task>) => call<boolean>('task:update', { id, patch }),
  toggleTask: (id: Id, status?: Task['status']) =>
    call<{ task: Task | null; spawned: Id | null }>('task:toggle', { id, status }),
  deleteTask: (id: Id) => call<boolean>('task:delete', { id }),

  dashboard: () => call<DashboardData>('dash:overview'),

  listBackups: () => call<BackupEntry[]>('backup:list'),
  runBackup: () => call<BackupEntry>('backup:run'),
  restoreBackup: (name: string) => call<{ preRestore: string }>('backup:restore', { name }),
  deleteBackup: (name: string) => call<boolean>('backup:delete', { name })
};

export type Api = typeof api;
