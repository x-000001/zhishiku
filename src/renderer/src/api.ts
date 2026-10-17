import type {
  AppInfo,
  AppSettings,
  Attachment,
  BackupEntry,
  CalendarEntry,
  Category,
  DashboardData,
  FocusState,
  FocusSummary,
  Goal,
  GoalDetail,
  GoalHorizon,
  GoalPoolItem,
  GoalSummary,
  Id,
  InboxItem,
  InboxKind,
  InboxStatus,
  KeyResult,
  ListFilter,
  Milestone,
  Note,
  NoteListItem,
  NoteVersion,
  Plan,
  PlanDetail,
  PlanItem,
  PlanSummary,
  RetroStats,
  RetroType,
  Retrospective,
  ReviewCard,
  ReviewGrade,
  ReviewLog,
  ReviewSource,
  SearchHit,
  Tag,
  TagDeleteResult,
  TagRenameResult,
  Task,
  TaskFilter,
  UpdateCheck,
  UpdateDownload,
  UpdateInstallResult,
  UpdateProgress
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
export function onEvent(
  channel: 'nav:go' | 'capture:focus' | 'notice:due' | 'update:progress' | 'focus:state',
  listener: (payload: unknown) => void
): () => void {
  return bridge.on(channel, listener);
}

/** 番茄钟状态变化（主进程是唯一计时源，渲染层只镜像）。 */
export function onFocusState(listener: (state: FocusState) => void): () => void {
  return bridge.on('focus:state', (payload) => listener(payload as FocusState));
}

/** 下载安装包的进度（主进程推过来，不在渲染层发请求）。 */
export function onUpdateProgress(listener: (progress: UpdateProgress) => void): () => void {
  return bridge.on('update:progress', (payload) => listener(payload as UpdateProgress));
}

/**
 * 拖进窗口的文件换绝对路径。Electron 32 之后 File 上没有 path 了，
 * 只能走 preload 里的 webUtils.getPathForFile。
 */
export function pathForFile(file: File): string {
  return typeof bridge.pathForFile === 'function' ? bridge.pathForFile(file) : '';
}

export const api = {
  appInfo: () => call<AppInfo>('app:info'),
  integrity: () => call<string>('data:integrity'),

  /** 第五版：自绘标题栏的三个点 */
  winMinimize: () => call<boolean>('win:minimize'),
  winToggleMax: () => call<boolean>('win:toggle-max'),
  winClose: () => call<boolean>('win:close'),

  revealData: () => call<void>('data:reveal'),
  revealBackups: () => call<void>('backup:reveal'),

  getSettings: () => call<AppSettings>('settings:get'),
  setSetting: (key: string, value: string | number | boolean) =>
    call<Record<string, string>>('settings:set', { key, value }),

  categoryTree: () => call<Category[]>('category:tree'),
  createCategory: (parentId: Id | null, name: string) => call<Id>('category:create', { parentId, name }),
  renameCategory: (id: Id, name: string) => call<boolean>('category:rename', { id, name }),
  deleteCategory: (id: Id) => call<boolean>('category:delete', { id }),
  moveCategory: (id: Id, dir: 'up' | 'down') => call<boolean>('category:move', { id, dir }),

  listNotes: (filter: ListFilter) => call<NoteListItem[]>('note:list', filter),
  getNote: (id: Id) => call<(Note & { tags: Tag[]; attachments: Attachment[] }) | null>('note:get', { id }),
  createNote: (input: { categoryId?: Id | null; title?: string; content?: string; html?: string }) =>
    call<(Note & { tags: Tag[]; attachments: Attachment[] }) | null>('note:create', input),
  saveDraft: (id: Id, title: string, content: string) => call<boolean>('note:draft', { id, title, content }),
  /** 富文本编辑器走 html；传 content 就是老的 Markdown 路径 */
  saveNote: (id: Id, title: string, body: { html?: string; content?: string }, reason?: string) =>
    call<{ note: Note; version: NoteVersion | null }>('note:save', { id, title, ...body, reason }),
  reorderNotes: (ids: Id[]) => call<number>('note:reorder', { ids }),
  moveNote: (id: Id, categoryId: Id | null) => call<boolean>('note:move', { id, categoryId }),
  togglePin: (id: Id) => call<boolean>('note:pin', { id }),
  trashNote: (id: Id) => call<boolean>('note:trash', { id }),
  restoreNote: (id: Id) => call<boolean>('note:restore', { id }),
  /**
   * 物理删除单篇笔记。界面上刻意没有入口：删除一律先进回收站，
   * 物理删除只走「清空回收站」和回收站满 30 天的自动清理（主进程内部调用）。
   * 这个封装留着，以后要做「彻底删除」勾选项时直接能用。
   */
  purgeNote: (id: Id) => call<boolean>('note:purge', { id }),
  emptyTrash: () => call<number>('note:empty-trash'),

  listVersions: (noteId: Id) => call<NoteVersion[]>('version:list', { noteId }),
  rollbackVersion: (id: Id) => call<Note>('version:rollback', { id }),

  listTags: () => call<Tag[]>('tag:list'),
  setNoteTags: (noteId: Id, names: string[]) =>
    call<Note & { tags: Tag[]; attachments: Attachment[] }>('tag:set', { noteId, names }),
  renameTag: (id: Id, name: string) => call<TagRenameResult>('tag:rename', { id, name }),
  deleteTag: (id: Id) => call<TagDeleteResult>('tag:delete', { id }),

  search: (q: string, limit?: number) => call<SearchHit[]>('search:query', { q, limit }),
  reindex: () => call<number>('search:reindex'),

  addAttachment: (noteId: Id | null) => call<Attachment[]>('attach:add', { noteId }),
  addAttachmentPath: (noteId: Id | null, srcPath: string) =>
    call<Attachment>('attach:add-path', { noteId, srcPath }),
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
    priority?: Task['priority'];
    repeat_rule?: Task['repeat_rule'];
  }) => call<{ ref: string }>('inbox:convert', payload),

  listTasks: (filter: TaskFilter) => call<Task[]>('task:list', filter),
  taskCounts: () =>
    call<Record<'today' | 'overdue' | 'upcoming' | 'all' | 'todo' | 'done', number>>('task:counts'),
  createTask: (input: Partial<Task> & { title: string }) => call<Id>('task:create', input),
  updateTask: (id: Id, patch: Partial<Task>) => call<boolean>('task:update', { id, patch }),
  toggleTask: (id: Id, status?: Task['status']) =>
    call<{ task: Task | null; spawned: Id | null }>('task:toggle', { id, status }),
  deleteTask: (id: Id) => call<boolean>('task:delete', { id }),
  deleteTasks: (ids: Id[]) => call<number>('task:delete-many', { ids }),

  dashboard: () => call<DashboardData>('dash:overview'),

  /* 当前目标 */
  listGoals: (includeArchived = false) => call<GoalSummary[]>('goal:list', { includeArchived }),
  getGoal: (id: Id) => call<GoalDetail | null>('goal:get', { id }),
  createGoal: (input: { title: string; description?: string; target_date?: string | null }) =>
    call<Id>('goal:create', input),
  updateGoal: (id: Id, patch: Partial<Goal>) => call<boolean>('goal:update', { id, patch }),
  deleteGoal: (id: Id) => call<boolean>('goal:delete', { id }),
  activeGoalCount: () => call<number>('goal:active-count'),

  listKeyResults: (goalId: Id) => call<KeyResult[]>('kr:list', { goalId }),
  createKeyResult: (goalId: Id, input: Partial<KeyResult> & { title: string }) =>
    call<Id>('kr:create', { goalId, ...input }),
  updateKeyResult: (id: Id, patch: Partial<KeyResult>) => call<boolean>('kr:update', { id, patch }),
  deleteKeyResult: (id: Id) => call<boolean>('kr:delete', { id }),

  listMilestones: (goalId: Id) => call<Milestone[]>('milestone:list', { goalId }),
  createMilestone: (goalId: Id, input: { title: string; target_date?: string | null }) =>
    call<Id>('milestone:create', { goalId, ...input }),
  updateMilestone: (id: Id, patch: Partial<Milestone>) => call<boolean>('milestone:update', { id, patch }),
  toggleMilestone: (id: Id, done?: boolean) => call<boolean>('milestone:toggle', { id, done }),
  deleteMilestone: (id: Id) => call<boolean>('milestone:delete', { id }),

  /* 下一阶段目标 */
  listPool: (horizon?: GoalHorizon) => call<GoalPoolItem[]>('pool:list', { horizon }),
  createPool: (input: {
    title: string;
    description?: string;
    why?: string;
    start_condition?: string;
    horizon?: GoalHorizon;
    priority?: number;
    est_start?: string | null;
  }) => call<Id>('pool:create', input),
  updatePool: (id: Id, patch: Partial<GoalPoolItem>) => call<boolean>('pool:update', { id, patch }),
  deletePool: (id: Id) => call<boolean>('pool:delete', { id }),
  startPool: (id: Id) => call<{ goalId: Id }>('pool:start', { id }),

  /* 学习计划 */
  listPlans: (includeArchived = false) => call<PlanSummary[]>('plan:list', { includeArchived }),
  getPlan: (id: Id) => call<PlanDetail | null>('plan:get', { id }),
  createPlan: (input: {
    title: string;
    direction?: string;
    rhythm?: string;
    start_date?: string | null;
    end_date?: string | null;
    goal_id?: Id | null;
  }) => call<Id>('plan:create', input),
  updatePlan: (id: Id, patch: Partial<Plan>) => call<boolean>('plan:update', { id, patch }),
  deletePlan: (id: Id) => call<boolean>('plan:delete', { id }),
  listPlanItems: (planId: Id) => call<PlanItem[]>('plan-item:list', { planId }),
  createPlanItem: (planId: Id, input: { title: string; date?: string | null; minutes?: number }) =>
    call<Id>('plan-item:create', { planId, ...input }),
  updatePlanItem: (id: Id, patch: Partial<PlanItem>) => call<boolean>('plan-item:update', { id, patch }),
  togglePlanItem: (id: Id, done?: boolean) => call<boolean>('plan-item:toggle', { id, done }),
  deletePlanItem: (id: Id) => call<boolean>('plan-item:delete', { id }),
  calendar: (from: string, to: string) => call<CalendarEntry[]>('plan:calendar', { from, to }),

  /* 复习与复盘 */
  listReview: (filter: { due?: boolean; source?: ReviewSource; limit?: number } = {}) =>
    call<ReviewCard[]>('review:list', filter),
  dueReview: () => call<ReviewCard[]>('review:due'),
  reviewStats: () =>
    call<{ total: number; dueToday: number; learned: number; reviewedToday: number; lapses: number }>(
      'review:stats'
    ),
  createReview: (input: {
    front: string;
    back?: string;
    note_id?: Id | null;
    source?: ReviewSource;
  }) => call<Id>('review:create', input),
  reviewFromNote: (noteId: Id) => call<Id>('review:from-note', { noteId }),
  updateReview: (id: Id, patch: Partial<ReviewCard>) => call<boolean>('review:update', { id, patch }),
  deleteReview: (id: Id) => call<boolean>('review:delete', { id }),
  gradeReview: (id: Id, grade: ReviewGrade) =>
    call<ReviewCard>('review:grade', { id, grade }),
  reviewLogs: (cardId: Id) => call<ReviewLog[]>('review:logs', { cardId }),

  listRetros: (type?: RetroType) => call<Retrospective[]>('retro:list', { type }),
  getRetro: (type: RetroType, date: string) => call<Retrospective | null>('retro:get', { type, date }),
  saveRetro: (type: RetroType, date: string, content: string) =>
    call<Retrospective>('retro:save', { type, date, content }),
  deleteRetro: (id: Id) => call<boolean>('retro:delete', { id }),
  retroPeriod: (type: 'week' | 'month', date?: string) =>
    call<{ from: string; to: string }>('retro:period', { type, date }),
  retroStats: (from: string, to: string) => call<RetroStats>('retro:stats', { from, to }),

  listBackups: () => call<BackupEntry[]>('backup:list'),
  runBackup: () => call<BackupEntry>('backup:run'),
  restoreBackup: (name: string) => call<{ preRestore: string }>('backup:restore', { name }),
  deleteBackup: (name: string) => call<boolean>('backup:delete', { name }),

  /**
   * 设置页「检查更新」：主进程联网查一次 GitHub 的 latest Release。
   * 断网 / 超时 / 接口变了都会以中文消息 reject，调用方 catch 后 toast 出来即可。
   */
  checkUpdate: () => call<UpdateCheck>('update:check'),
  /** 下载刚检查到的那个安装包：主进程流式下载 + 校验，进度走 onUpdateProgress。 */
  downloadUpdate: () => call<UpdateDownload>('update:download'),
  /** 取消正在进行的下载（半成品由主进程删掉）。 */
  cancelUpdate: () => call<boolean>('update:cancel'),
  /** 拉起安装程序（便携版会改成打开文件夹）；dryRun 时只返回结果不执行。 */
  installUpdate: (path: string) => call<UpdateInstallResult>('update:install', { path }),
  /** 在资源管理器里选中安装包。 */
  revealUpdate: (path: string) => call<boolean>('update:reveal', { path }),
  /** 安装程序已启动：关掉本应用，让 NSIS 能覆盖文件。 */
  quitForUpdate: () => call<boolean>('update:quit'),
  /** 复制文本到系统剪贴板（目前只有更新提示里的下载链接用）。 */
  copyText: (text: string) => call<boolean>('system:copy-text', { text }),

  /* ---------------- 第六版：番茄钟（主进程计时） ---------------- */
  focusState: () => call<FocusState>('focus:state'),
  startFocus: (plannedSeconds: number, taskId: Id | null = null, taskTitle: string | null = null) =>
    call<FocusState>('focus:start', { plannedSeconds, taskId, taskTitle }),
  pauseFocus: () => call<FocusState>('focus:pause'),
  resumeFocus: () => call<FocusState>('focus:resume'),
  abandonFocus: () => call<FocusState>('focus:abandon'),
  skipBreak: () => call<FocusState>('focus:skip-break'),
  focusSummary: () => call<FocusSummary>('focus:summary')
};

export type Api = typeof api;
