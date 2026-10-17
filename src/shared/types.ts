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
  /** 纯文字正文：全文搜索、摘要、字数都吃它 */
  content: string;
  /** 富文本正文（编辑器真正显示的那份），老笔记在迁移时由 content 转来 */
  content_html: string;
  /** 分类内的手动排序位（越小越靠前） */
  sort_order: number;
  draft_title: string | null;
  /** 草稿正文，v3 起存富文本 HTML */
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
  sort_order: number;
  updated_at: string;
}

export interface NoteVersion {
  id: Id;
  note_id: Id;
  title: string;
  content: string;
  content_html: string;
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
/** 任务优先级三档（v4 起，替代原来的数字 0-3） */
export type TaskPriority = 'urgent' | 'important' | 'normal';
export type RepeatRule = 'none' | 'daily' | 'weekdays' | 'weekly' | 'monthly';

export interface Task {
  id: Id;
  title: string;
  note: string;
  status: TaskStatus;
  priority: TaskPriority; // urgent 紧急 / important 重要 / normal 一般
  due_at: string | null; // YYYY-MM-DD 或 YYYY-MM-DD HH:mm（本地时间）
  remind_at: string | null; // 提醒时间，同样是本地时间串
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
  /** 状态筛选：不传或 'all' = 全部（含已完成，勾完不消失），'todo' = 未完成，'done' = 已完成 */
  status?: 'all' | 'todo' | 'done';
  /** 优先级筛选：不传或 'all' = 三档都看 */
  priority?: TaskPriority | 'all';
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
  reviewDueCount: number;
  todayPlan: CalendarEntry[];
  goals: { id: Id; title: string; progress: number; target_date: string | null }[];
  recentNotes: NoteListItem[];
}

/* ---------------- 第二版：目标 ---------------- */

export type GoalStatus = 'active' | 'done' | 'archived';

export interface Goal {
  id: Id;
  title: string;
  description: string;
  status: GoalStatus;
  target_date: string | null;
  started_at: string | null;
  archived_at: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface GoalSummary extends Goal {
  /** 0–100，关键结果完成度与关联任务完成率的平均值 */
  progress: number;
  kr_count: number;
  milestone_count: number;
  task_count: number;
}

export interface KeyResult {
  id: Id;
  goal_id: Id;
  title: string;
  target_value: number;
  current_value: number;
  unit: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface Milestone {
  id: Id;
  goal_id: Id;
  title: string;
  target_date: string | null;
  done: number;
  done_at: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface GoalDetail {
  goal: GoalSummary;
  keyResults: KeyResult[];
  milestones: Milestone[];
  tasks: Task[];
}

/* ---------------- 第二版：下一阶段目标 ---------------- */

export type GoalHorizon = 'this' | 'next' | 'later';
export type PoolStatus = 'pool' | 'ready' | 'started' | 'dropped';

export interface GoalPoolItem {
  id: Id;
  title: string;
  description: string;
  why: string;
  start_condition: string;
  status: PoolStatus;
  priority: number;
  horizon: GoalHorizon;
  est_start: string | null;
  goal_id: Id | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

/* ---------------- 第二版：学习计划 ---------------- */

export type PlanStatus = 'active' | 'paused' | 'done';

export interface Plan {
  id: Id;
  title: string;
  direction: string;
  rhythm: string;
  start_date: string | null;
  end_date: string | null;
  status: PlanStatus;
  goal_id: Id | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface PlanSummary extends Plan {
  goal_title: string | null;
  item_count: number;
  done_count: number;
}

export interface PlanItem {
  id: Id;
  plan_id: Id;
  date: string | null;
  title: string;
  minutes: number;
  done: number;
  done_at: string | null;
  note_id: Id | null;
  created_at: string;
  updated_at: string;
}

export interface PlanDetail {
  plan: PlanSummary;
  items: PlanItem[];
}

/** 日历视图用：计划条目 + 所属计划名。 */
export interface CalendarEntry {
  id: Id;
  plan_id: Id;
  plan_title: string;
  date: string | null;
  title: string;
  minutes: number;
  done: number;
  done_at: string | null;
}

/* ---------------- 第二版：复习与复盘 ---------------- */

export type ReviewGrade = 'forgot' | 'fuzzy' | 'know';
export type ReviewSource = 'note' | 'wrong' | 'hard';

export interface ReviewCard {
  id: Id;
  note_id: Id | null;
  front: string;
  back: string;
  source: ReviewSource;
  ease_level: number;
  interval_days: number;
  next_review_at: string | null;
  review_count: number;
  lapses: number;
  last_reviewed_at: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface ReviewLog {
  id: Id;
  card_id: Id;
  reviewed_at: string;
  result: ReviewGrade;
  interval_before: number;
  interval_after: number;
  ease_before: number;
  ease_after: number;
}

export type RetroType = 'day' | 'week' | 'month';

export interface Retrospective {
  id: Id;
  type: RetroType;
  date: string;
  content: string;
  created_at: string;
  updated_at: string;
}

/** 复盘页顶部那排数字，按复盘周期统计。 */
export interface RetroStats {
  tasksDone: number;
  notesWritten: number;
  reviewsDone: number;
  planItemsDone: number;
  planItemsTotal: number;
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
  /** 第五版：窗口系统材质（Windows 11 上是 'acrylic'，其它平台是 'none'）。 */
  material?: string;
  /** 第五版：Windows build 号，用来解释 material 该是什么。 */
  windowsBuild?: number;
}

/* ---------------- 设置页「检查更新」（手动联网，一次一个请求） ---------------- */

export type UpdateStatus = 'newer' | 'latest' | 'no-release';

export interface UpdateRelease {
  /** 去掉 v 前缀的版本号，例如 0.3.1 */
  version: string;
  /** 原始 tag_name，例如 v0.3.1 */
  tag: string;
  /** 发布页地址（「复制下载链接」复制的就是它） */
  url: string;
  /** 更新说明，截断到 600 字以内，弹窗里直接显示 */
  notes: string;
  /** 发布时间（ISO 字符串），没给就是空串 */
  publishedAt: string;
}

export interface UpdateCheck {
  status: UpdateStatus;
  /** 当前运行的版本 */
  current: string;
  /** GitHub 上最新的 Release；仓库还没发过版本时为 null */
  latest: UpdateRelease | null;
  /** 这次检查的时间（毫秒时间戳） */
  checkedAt: number;
}

/** preload 暴露给渲染进程的接口。 */
export interface KbApi {
  invoke<T = unknown>(channel: string, payload?: unknown): Promise<T>;
  on(channel: string, listener: (payload: unknown) => void): () => void;
  /** 拖进来的文件换绝对路径（Electron 32+ 没有 file.path 了）。 */
  pathForFile(file: File): string;
}

declare global {
  interface Window {
    api?: KbApi;
  }
}
