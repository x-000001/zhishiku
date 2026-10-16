import { DatabaseSync, type StatementSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import {
  attachmentDirFor,
  isoLocal,
  nowIso,
  todayLocal,
  type DataPaths
} from './paths';
import { renderMarkdown } from '../shared/markdown';
import { htmlToPlainText, sanitizeHtml, textToHtml } from '../shared/html';
import type {
  Attachment,
  CalendarEntry,
  Category,
  DashboardData,
  Goal,
  GoalDetail,
  GoalHorizon,
  GoalPoolItem,
  GoalStatus,
  GoalSummary,
  Id,
  InboxItem,
  InboxKind,
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
  RepeatRule,
  Retrospective,
  RetroType,
  ReviewCard,
  ReviewGrade,
  ReviewLog,
  ReviewSource,
  SearchHit,
  Tag,
  Task,
  TaskFilter,
  TaskPriority,
  TaskStatus
} from '../shared/types';

let db: DatabaseSync | null = null;
let paths: DataPaths | null = null;

/* ------------------------------------------------------------------ */
/* 基础工具                                                            */
/* ------------------------------------------------------------------ */

type Param = string | number | bigint | null | Uint8Array;

/** node:sqlite 不接受 boolean / undefined，统一转成 0/1 与 null。 */
function norm(v: unknown): Param {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number' || typeof v === 'string' || typeof v === 'bigint') return v;
  if (v instanceof Uint8Array) return v;
  return String(v);
}

function params(list: unknown[]): Param[] {
  return list.map(norm);
}

interface Stmt {
  get: StatementSync['get'];
  all: StatementSync['all'];
  run: StatementSync['run'];
}

function raw(sql: string): Stmt {
  if (!db) throw new Error('数据库尚未打开');
  return db.prepare(sql) as unknown as Stmt;
}

function run(sql: string, ...args: unknown[]): { changes: number; lastInsertRowid: number } {
  const r = raw(sql).run(...params(args));
  return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
}

function all<T>(sql: string, ...args: unknown[]): T[] {
  return raw(sql).all(...params(args)) as unknown as T[];
}

function one<T>(sql: string, ...args: unknown[]): T | undefined {
  return raw(sql).get(...params(args)) as unknown as T | undefined;
}

/* ------------------------------------------------------------------ */
/* 中文友好的全文检索                                                  */
/* ------------------------------------------------------------------ */

const CJK_RE = /([\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff])/g;

/** 把每个汉字拆成独立 token，让 unicode61 分词器也能按字建索引。 */
function expandCjk(text: string): string {
  return text.replace(CJK_RE, ' $1 ').replace(/\s+/g, ' ').trim();
}

/** 把用户输入转成 FTS5 查询：按空白切词，每个词内部要求逐字相邻（短语匹配）。 */
function toMatchQuery(input: string): string | null {
  const terms = input.trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return null;
  return terms
    .map((t) => `"${expandCjk(t).replace(/"/g, '""')}"`)
    .join(' AND ');
}

export function countWords(text: string): number {
  const cjk = text.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g)?.length ?? 0;
  const latin = text.match(/[A-Za-z0-9_']+/g)?.length ?? 0;
  return cjk + latin;
}

function makeExcerpt(content: string, len = 88): string {
  const plain = content
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/[*_>`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length > len ? `${plain.slice(0, len)}…` : plain;
}

function snippetAround(content: string, query: string, len = 90): string {
  const plain = content.replace(/\s+/g, ' ');
  const first = query.trim().split(/\s+/)[0] ?? '';
  const idx = first ? plain.toLowerCase().indexOf(first.toLowerCase()) : -1;
  if (idx < 0) return makeExcerpt(content, len);
  const start = Math.max(0, idx - Math.floor(len / 3));
  const cut = plain.slice(start, start + len);
  return `${start > 0 ? '…' : ''}${cut}${start + len < plain.length ? '…' : ''}`;
}

/* ------------------------------------------------------------------ */
/* 建表与迁移                                                          */
/* ------------------------------------------------------------------ */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS category (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_id  INTEGER REFERENCES category(id),
  name       TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS note (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id   INTEGER REFERENCES category(id),
  title         TEXT NOT NULL DEFAULT '',
  content       TEXT NOT NULL DEFAULT '',
  content_html  TEXT NOT NULL DEFAULT '',
  sort_order    INTEGER NOT NULL DEFAULT 0,
  draft_title   TEXT,
  draft_content TEXT,
  draft_at      TEXT,
  excerpt       TEXT NOT NULL DEFAULT '',
  word_count    INTEGER NOT NULL DEFAULT 0,
  is_pinned     INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  deleted_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_note_category ON note(category_id);
CREATE INDEX IF NOT EXISTS idx_note_updated ON note(updated_at DESC);

CREATE TABLE IF NOT EXISTS tag (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS note_tag (
  note_id INTEGER NOT NULL REFERENCES note(id) ON DELETE CASCADE,
  tag_id  INTEGER NOT NULL REFERENCES tag(id) ON DELETE CASCADE,
  PRIMARY KEY (note_id, tag_id)
);

CREATE TABLE IF NOT EXISTS attachment (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  note_id    INTEGER REFERENCES note(id),
  file_name  TEXT NOT NULL,
  rel_path   TEXT NOT NULL,
  size       INTEGER NOT NULL DEFAULT 0,
  mime       TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS note_version (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  note_id      INTEGER NOT NULL,
  title        TEXT NOT NULL,
  content      TEXT NOT NULL,
  content_html TEXT NOT NULL DEFAULT '',
  word_count   INTEGER NOT NULL DEFAULT 0,
  reason       TEXT NOT NULL DEFAULT '手动保存',
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_version_note ON note_version(note_id, created_at DESC);

CREATE TABLE IF NOT EXISTS inbox_item (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  content      TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'idea',
  status       TEXT NOT NULL DEFAULT 'open',
  converted_to TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_inbox_status ON inbox_item(status, created_at DESC);

CREATE TABLE IF NOT EXISTS task (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  title        TEXT NOT NULL,
  note         TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'todo',
  priority     TEXT NOT NULL DEFAULT 'normal',
  due_at       TEXT,
  remind_at    TEXT,
  repeat_rule  TEXT NOT NULL DEFAULT 'none',
  goal_id      INTEGER REFERENCES goal(id),
  plan_id      INTEGER REFERENCES plan(id),
  completed_at TEXT,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  deleted_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_task_status ON task(status, due_at);

CREATE TABLE IF NOT EXISTS goal (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'active',
  target_date TEXT,
  started_at  TEXT,
  archived_at TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT
);

CREATE TABLE IF NOT EXISTS goal_key_result (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id       INTEGER NOT NULL REFERENCES goal(id),
  title         TEXT NOT NULL,
  target_value  REAL NOT NULL DEFAULT 100,
  current_value REAL NOT NULL DEFAULT 0,
  unit          TEXT NOT NULL DEFAULT '',
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS goal_pool (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  title           TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  why             TEXT NOT NULL DEFAULT '',
  start_condition TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'pool',
  priority        INTEGER NOT NULL DEFAULT 2,
  horizon         TEXT NOT NULL DEFAULT 'later',
  est_start       TEXT,
  goal_id         INTEGER REFERENCES goal(id),
  sort_order      INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS plan (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT NOT NULL,
  direction  TEXT NOT NULL DEFAULT '',
  rhythm     TEXT NOT NULL DEFAULT '',
  start_date TEXT,
  end_date   TEXT,
  status     TEXT NOT NULL DEFAULT 'active',
  goal_id    INTEGER REFERENCES goal(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS plan_item (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id    INTEGER NOT NULL REFERENCES plan(id),
  date       TEXT,
  title      TEXT NOT NULL,
  minutes    INTEGER NOT NULL DEFAULT 0,
  done       INTEGER NOT NULL DEFAULT 0,
  done_at    TEXT,
  note_id    INTEGER REFERENCES note(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plan_item_date ON plan_item(date, done);

CREATE TABLE IF NOT EXISTS review_card (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  note_id         INTEGER REFERENCES note(id),
  front           TEXT NOT NULL,
  back            TEXT NOT NULL DEFAULT '',
  source          TEXT NOT NULL DEFAULT 'note',
  ease_level      INTEGER NOT NULL DEFAULT 0,
  interval_days   INTEGER NOT NULL DEFAULT 0,
  next_review_at  TEXT,
  review_count    INTEGER NOT NULL DEFAULT 0,
  lapses          INTEGER NOT NULL DEFAULT 0,
  last_reviewed_at TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  deleted_at      TEXT
);

CREATE TABLE IF NOT EXISTS milestone (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id     INTEGER NOT NULL REFERENCES goal(id),
  title       TEXT NOT NULL,
  target_date TEXT,
  done        INTEGER NOT NULL DEFAULT 0,
  done_at     TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_milestone_goal ON milestone(goal_id, sort_order);

CREATE TABLE IF NOT EXISTS review_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id         INTEGER NOT NULL REFERENCES review_card(id),
  reviewed_at     TEXT NOT NULL,
  result          TEXT NOT NULL,
  interval_before INTEGER NOT NULL DEFAULT 0,
  interval_after  INTEGER NOT NULL DEFAULT 0,
  ease_before     INTEGER NOT NULL DEFAULT 0,
  ease_after      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_review_log_card ON review_log(card_id, reviewed_at DESC);

CREATE TABLE IF NOT EXISTS retrospective (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  type       TEXT NOT NULL,
  date       TEXT NOT NULL,
  content    TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_retro_type_date ON retrospective(type, date);

CREATE VIRTUAL TABLE IF NOT EXISTS note_fts USING fts5(
  title,
  content,
  tokenize = 'unicode61'
);
`;

const SCHEMA_VERSION = 4;

/** 给老库补列：SQLite 没有 ADD COLUMN IF NOT EXISTS，先查表结构再决定。 */
function addColumnIfMissing(table: string, column: string, decl: string): void {
  const cols = all<{ name: string }>(`PRAGMA table_info(${table})`);
  if (!cols.length) return;
  if (cols.some((c) => c.name === column)) return;
  raw(`alter table ${table} add column ${column} ${decl}`).run();
}

/** Markdown / 纯文本 → 富文本 HTML，解析失败时兜底成转义后的纯文字，绝不丢内容。 */
function markdownToHtmlSafe(text: string): string {
  const raw = String(text ?? '');
  if (!raw.trim()) return '';
  try {
    const html = renderMarkdown(raw);
    return html && html.trim() ? html : textToHtml(raw);
  } catch {
    return textToHtml(raw);
  }
}

/**
 * v2 → v3 迁移第一步：老笔记只有 Markdown 纯文本，转成富文本 HTML 存进 content_html。
 * 草稿（draft_content）也一起转，否则恢复草稿时富文本编辑器拿到的是 Markdown。
 */
function backfillNoteHtml(): void {
  const notes = all<{ id: Id; content: string }>(
    "select id, content from note where content_html is null or content_html = ''"
  );
  for (const note of notes) {
    run('update note set content_html = ? where id = ?', markdownToHtmlSafe(note.content), note.id);
  }
  const drafts = all<{ id: Id; draft_content: string }>(
    "select id, draft_content from note where draft_content is not null and draft_content <> '' and draft_content not like '<%'"
  );
  for (const draft of drafts) {
    run(
      'update note set draft_content = ? where id = ?',
      markdownToHtmlSafe(draft.draft_content),
      draft.id
    );
  }
}

/**
 * v2 → v3 迁移第二步：按「最近改过的排前面」给每个分类里的老笔记铺一遍 sort_order，
 * 让升级后看到的顺序和升级前一致；之后的手动拖动才从这个顺序改起。
 */
function backfillNoteSort(): void {
  const rows = all<{ id: Id; category_id: Id | null }>(
    'select id, category_id from note order by updated_at desc, id desc'
  );
  const counters = new Map<string, number>();
  for (const row of rows) {
    const key = String(row.category_id ?? '');
    const next = (counters.get(key) ?? 0) + 1;
    counters.set(key, next);
    run('update note set sort_order = ? where id = ?', next, row.id);
  }
}

function migrate(): void {
  const database = requireDb();
  database.exec(SCHEMA);
  const row = one<{ user_version: number }>('PRAGMA user_version');
  const current = Number(row?.user_version ?? 0);
  if (current < 2) {
    // v1 → v2：任务提醒时间、目标池的优先级/路线图/启动后关联、学习计划节奏、
    // 计划条目完成时间、复习卡的遗忘次数。
    addColumnIfMissing('task', 'remind_at', 'TEXT');
    addColumnIfMissing('goal_pool', 'priority', 'INTEGER NOT NULL DEFAULT 2');
    addColumnIfMissing('goal_pool', 'horizon', "TEXT NOT NULL DEFAULT 'later'");
    addColumnIfMissing('goal_pool', 'est_start', 'TEXT');
    addColumnIfMissing('goal_pool', 'goal_id', 'INTEGER');
    addColumnIfMissing('plan', 'rhythm', "TEXT NOT NULL DEFAULT ''");
    addColumnIfMissing('plan_item', 'done_at', 'TEXT');
    addColumnIfMissing('review_card', 'lapses', 'INTEGER NOT NULL DEFAULT 0');
  }
  if (current < 3) {
    // v2 → v3：笔记富文本正文（content_html）、分类内手动排序（sort_order）、
    // 历史版本也留一份富文本。老笔记按 Markdown 转过来，顺序按「最近改过」铺一遍。
    addColumnIfMissing('note', 'content_html', "TEXT NOT NULL DEFAULT ''");
    addColumnIfMissing('note', 'sort_order', 'INTEGER NOT NULL DEFAULT 0');
    addColumnIfMissing('note_version', 'content_html', "TEXT NOT NULL DEFAULT ''");
    // 列补齐了才能建这个索引（老库里 note 表此时还没有 sort_order）
    database.exec('CREATE INDEX IF NOT EXISTS idx_note_sort ON note(category_id, sort_order)');
    database.exec('BEGIN');
    try {
      backfillNoteHtml();
      backfillNoteSort();
      database.exec('COMMIT');
    } catch (err) {
      database.exec('ROLLBACK');
      throw err;
    }
  }
  if (current < 4) {
    // v3 → v4：任务优先级从数字（0 无 / 1 低 / 2 中 / 3 高）换成三档文字
    // （urgent 紧急 / important 重要 / normal 一般）。列本身是 INTEGER 亲和性，
    // 存文字没问题；用 typeof 守住幂等，重复打开不会把已经转好的又降回 normal。
    run(
      `update task set priority = case
         when cast(priority as integer) >= 3 then 'urgent'
         when cast(priority as integer) = 2 then 'important'
         else 'normal'
       end
       where typeof(priority) <> 'text'`
    );
  }
  if (current < SCHEMA_VERSION) {
    database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }
}

/* ------------------------------------------------------------------ */
/* 打开 / 关闭                                                         */
/* ------------------------------------------------------------------ */

function requireDb(): DatabaseSync {
  if (!db) throw new Error('数据库尚未打开');
  return db;
}

export function openDatabase(p: DataPaths): void {
  paths = p;
  db = new DatabaseSync(p.db);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  migrate();
  ensureDefaultCategories();
  purgeExpiredTrash();
}

export function closeDatabase(): void {
  if (db) {
    try {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
      // 关库前的检查点失败不影响退出
    }
    db.close();
    db = null;
  }
}

export function dbPaths(): DataPaths {
  if (!paths) throw new Error('数据目录尚未初始化');
  return paths;
}

/** 给备份模块用：拿到底层连接执行 VACUUM INTO。 */
export function getRawDb(): DatabaseSync {
  return requireDb();
}

export function sqliteVersion(): string {
  return String(one<{ v: string }>('select sqlite_version() as v')?.v ?? '');
}

export function integrityCheck(): string {
  const rows = all<Record<string, unknown>>('PRAGMA integrity_check');
  const first = rows[0] ? Object.values(rows[0])[0] : 'unknown';
  return String(first);
}

/* ------------------------------------------------------------------ */
/* 设置                                                               */
/* ------------------------------------------------------------------ */

const SETTING_DEFAULTS: Record<string, string> = {
  versionKeep: '20',
  theme: 'light',
  notifyEnabled: '1',
  closeToTray: '1',
  lastBackupDate: ''
};

export function getSetting(key: string): string | null {
  const row = one<{ value: string }>('select value from meta where key = ?', key);
  return row?.value ?? SETTING_DEFAULTS[key] ?? null;
}

export function setSetting(key: string, value: string): void {
  run(
    'insert into meta(key, value) values(?, ?) on conflict(key) do update set value = excluded.value',
    key,
    value
  );
}

export function allSettings(): Record<string, string> {
  const out: Record<string, string> = { ...SETTING_DEFAULTS };
  for (const row of all<{ key: string; value: string }>('select key, value from meta')) {
    out[row.key] = row.value;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 首次启动的默认分类                                                  */
/* ------------------------------------------------------------------ */

function ensureDefaultCategories(): void {
  const row = one<{ c: number }>('select count(*) as c from category');
  if (Number(row?.c ?? 0) > 0) return;
  const defaults = ['工作', '学习', '生活', '项目', '资料收藏'];
  const now = nowIso();
  defaults.forEach((name, i) => {
    run(
      'insert into category(parent_id, name, sort_order, created_at, updated_at) values(null, ?, ?, ?, ?)',
      name,
      i,
      now,
      now
    );
  });
}

/* ------------------------------------------------------------------ */
/* 分类                                                                */
/* ------------------------------------------------------------------ */

export function categoryTree(): Category[] {
  const rows = all<Category>(
    `select c.*, (select count(*) from note n where n.category_id = c.id and n.deleted_at is null) as note_count
     from category c
     where c.deleted_at is null
     order by c.sort_order, c.id`
  );
  return rows.map((r) => ({ ...r, note_count: Number(r.note_count ?? 0) }));
}

export function createCategory(parentId: Id | null, name: string): Id {
  const now = nowIso();
  const maxRow = one<{ m: number }>(
    'select coalesce(max(sort_order), 0) as m from category where parent_id is ?',
    parentId
  );
  const r = run(
    'insert into category(parent_id, name, sort_order, created_at, updated_at) values(?, ?, ?, ?, ?)',
    parentId,
    name.trim() || '未命名分类',
    Number(maxRow?.m ?? 0) + 1,
    now,
    now
  );
  return r.lastInsertRowid;
}

export function renameCategory(id: Id, name: string): void {
  run('update category set name = ?, updated_at = ? where id = ?', name.trim(), nowIso(), id);
}

/** 删除分类：子分类不动（上提一级），分类下笔记移入「未分类」。 */
export function deleteCategory(id: Id): void {
  const now = nowIso();
  run('update category set parent_id = null, updated_at = ? where parent_id = ?', now, id);
  run('update note set category_id = null, updated_at = ? where category_id = ?', now, id);
  run('update category set deleted_at = ? where id = ?', now, id);
}

/* ------------------------------------------------------------------ */
/* 笔记                                                                */
/* ------------------------------------------------------------------ */

interface NoteRow extends Note {
  category_name?: string | null;
}

function noteListSelect(): string {
  return `select n.id, n.category_id, n.title, n.excerpt, n.word_count, n.is_pinned, n.sort_order,
                 n.updated_at, c.name as category_name
          from note n left join category c on c.id = n.category_id`;
}

export function listNotes(filter: ListFilter = {}): NoteListItem[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (filter.trash) {
    where.push('n.deleted_at is not null');
  } else {
    where.push('n.deleted_at is null');
  }
  if (!filter.trash && filter.categoryId != null) {
    where.push('n.category_id = ?');
    args.push(filter.categoryId);
  }
  if (!filter.trash && filter.tagId != null) {
    where.push('n.id in (select note_id from note_tag where tag_id = ?)');
    args.push(filter.tagId);
  }
  if (filter.q) {
    const match = toMatchQuery(filter.q);
    if (match) {
      where.push('n.id in (select rowid from note_fts where note_fts match ?)');
      args.push(match);
    }
  }
  const limit = Math.min(Math.max(filter.limit ?? 500, 1), 2000);
  // 置顶的最前，然后是手动排序（v3 起可拖动），同一位次里按改动时间兜底
  const sql = `${noteListSelect()} where ${where.join(' and ')}
               order by n.is_pinned desc, n.sort_order asc, n.updated_at desc limit ${limit}`;
  return all<NoteListItem>(sql, ...args);
}

export function getNote(id: Id): (Note & { tags: Tag[]; attachments: Attachment[] }) | null {
  const note = one<Note>('select * from note where id = ?', id);
  if (!note) return null;
  const tags = all<Tag>(
    'select t.* from tag t join note_tag nt on nt.tag_id = t.id where nt.note_id = ? order by t.name',
    id
  );
  const attachments = all<Attachment>(
    'select * from attachment where note_id = ? order by id desc',
    id
  );
  return { ...note, tags, attachments };
}

function syncFts(id: Id, title: string, content: string): void {
  run('delete from note_fts where rowid = ?', id);
  run(
    'insert into note_fts(rowid, title, content) values(?, ?, ?)',
    id,
    expandCjk(title),
    expandCjk(content)
  );
}

/** 分类内排到最后一名的位次（回收站里的不算）。 */
function nextSortOrder(categoryId: Id | null): number {
  const row = one<{ n: number | null }>(
    'select max(sort_order) as n from note where deleted_at is null and category_id is ?',
    categoryId
  );
  return Number(row?.n ?? 0) + 1;
}

export function createNote(input: {
  categoryId?: Id | null;
  title?: string;
  content?: string;
  /** 富文本正文；给了它就以它为准，content 由它抽出来 */
  html?: string;
}): Id {
  const now = nowIso();
  const title = input.title ?? '';
  const html =
    input.html != null ? sanitizeHtml(input.html) : markdownToHtmlSafe(input.content ?? '');
  const content = input.html != null ? htmlToPlainText(html) : (input.content ?? '');
  const categoryId = input.categoryId ?? null;
  const r = run(
    `insert into note(category_id, title, content, content_html, sort_order, excerpt, word_count, created_at, updated_at)
     values(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    categoryId,
    title,
    content,
    html,
    nextSortOrder(categoryId),
    makeExcerpt(content),
    countWords(content),
    now,
    now
  );
  syncFts(r.lastInsertRowid, title, content);
  return r.lastInsertRowid;
}

/** 自动保存：只写草稿，不动正文，也不留版本点。 */
export function saveDraft(id: Id, draftTitle: string, draftContent: string): void {
  run(
    'update note set draft_title = ?, draft_content = ?, draft_at = ? where id = ?',
    draftTitle,
    draftContent,
    nowIso(),
    id
  );
}

export function discardDraft(id: Id): void {
  run('update note set draft_title = null, draft_content = null, draft_at = null where id = ?', id);
}

/**
 * 手动保存的公共实现：正文（纯文字 + 富文本）一起写、清草稿、按设置留版本点。
 * 纯文字那份给全文搜索和字数用，富文本那份给编辑器显示用。
 */
function writeNote(
  id: Id,
  title: string,
  content: string,
  contentHtml: string,
  reason: string
): NoteVersion | null {
  const before = one<{ title: string; content: string; content_html: string }>(
    'select title, content, content_html from note where id = ?',
    id
  );
  const now = nowIso();
  const wc = countWords(content);
  run(
    `update note set title = ?, content = ?, content_html = ?, excerpt = ?, word_count = ?, updated_at = ?,
            draft_title = null, draft_content = null, draft_at = null
     where id = ?`,
    title,
    content,
    contentHtml,
    makeExcerpt(content),
    wc,
    now,
    id
  );
  syncFts(id, title, content);

  const keep = Number(getSetting('versionKeep') ?? '20');
  if (keep <= 0) return null;
  // 第一次保存、或内容确实变了（含只改颜色/加粗这种），才留版本点
  const changed =
    !before ||
    before.content !== content ||
    before.title !== title ||
    before.content_html !== contentHtml;
  if (!changed) return null;
  const r = run(
    `insert into note_version(note_id, title, content, content_html, word_count, reason, created_at)
     values(?, ?, ?, ?, ?, ?, ?)`,
    id,
    title,
    content,
    contentHtml,
    wc,
    reason,
    now
  );
  pruneVersions(id, keep);
  return one<NoteVersion>('select * from note_version where id = ?', r.lastInsertRowid) ?? null;
}

/** 手动保存（Markdown 路径，兼容老调用）：content 按 Markdown 转成富文本一起存。 */
export function saveNote(id: Id, title: string, content: string, reason = '手动保存'): NoteVersion | null {
  return writeNote(id, title, content, markdownToHtmlSafe(content), reason);
}

/** 手动保存（富文本路径）：编辑器交上来的 HTML 过一遍白名单，纯文字由它抽出来。 */
export function saveNoteHtml(id: Id, title: string, html: string, reason = '手动保存'): NoteVersion | null {
  const clean = sanitizeHtml(html);
  return writeNote(id, title, htmlToPlainText(clean), clean, reason);
}

function pruneVersions(noteId: Id, keep: number): void {
  run(
    `delete from note_version
     where note_id = ? and id not in (
       select id from note_version where note_id = ? order by created_at desc, id desc limit ?
     )`,
    noteId,
    noteId,
    keep
  );
}

export function listVersions(noteId: Id): NoteVersion[] {
  return all<NoteVersion>(
    'select * from note_version where note_id = ? order by created_at desc, id desc',
    noteId
  );
}

export function rollbackVersion(versionId: Id): Note {
  const v = one<NoteVersion>('select * from note_version where id = ?', versionId);
  if (!v) throw new Error('版本点不存在');
  const current = getNote(v.note_id);
  if (!current) throw new Error('笔记不存在');
  // 先把当前内容存成版本点，回滚也能反悔
  saveNoteHtml(
    v.note_id,
    current.title,
    current.content_html || markdownToHtmlSafe(current.content),
    '回滚前快照'
  );
  const label = `回滚到 ${v.created_at.slice(0, 16).replace('T', ' ')}`;
  if (v.content_html) {
    saveNoteHtml(v.note_id, v.title, v.content_html, label);
  } else {
    saveNote(v.note_id, v.title, v.content, label);
  }
  const after = getNote(v.note_id);
  if (!after) throw new Error('笔记不存在');
  return after;
}

export function moveNote(id: Id, categoryId: Id | null): void {
  // 换分类后排到新分类的最后，不抢别人位次
  run(
    'update note set category_id = ?, sort_order = ?, updated_at = ? where id = ?',
    categoryId,
    nextSortOrder(categoryId),
    nowIso(),
    id
  );
}

/** 拖动排序落库：按给定顺序把位次写成 1..n。传进来的应当是当前分类的完整可见列表。 */
export function reorderNotes(orderedIds: Id[]): number {
  const clean = orderedIds.map((v) => Number(v)).filter((v) => Number.isFinite(v));
  if (!clean.length) return 0;
  const database = requireDb();
  database.exec('BEGIN');
  try {
    clean.forEach((id, index) => run('update note set sort_order = ? where id = ?', index + 1, id));
    database.exec('COMMIT');
  } catch (err) {
    database.exec('ROLLBACK');
    throw err;
  }
  return clean.length;
}

export function togglePin(id: Id): void {
  run('update note set is_pinned = 1 - is_pinned where id = ?', id);
}

export function trashNote(id: Id): void {
  run('update note set deleted_at = ? where id = ?', nowIso(), id);
}

export function restoreNote(id: Id): void {
  run('update note set deleted_at = null where id = ?', id);
}

export function purgeNote(id: Id): void {
  run('delete from note_fts where rowid = ?', id);
  run('delete from note_version where note_id = ?', id);
  run('delete from note_tag where note_id = ?', id);
  const files = all<{ rel_path: string }>('select rel_path from attachment where note_id = ?', id);
  for (const f of files) removeAttachmentFile(f.rel_path);
  run('delete from attachment where note_id = ?', id);
  run('delete from note where id = ?', id);
}

/** 回收站里超过 30 天的笔记彻底删除。 */
export function purgeExpiredTrash(): number {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);
  const rows = all<{ id: Id }>(
    'select id from note where deleted_at is not null and deleted_at < ?',
    isoLocal(cutoff)
  );
  for (const r of rows) purgeNote(r.id);
  return rows.length;
}

/** 清空回收站：把当前在回收站里的笔记全部彻底删除，返回删掉的条数。 */
export function emptyTrash(): number {
  const rows = all<{ id: Id }>('select id from note where deleted_at is not null');
  for (const r of rows) purgeNote(r.id);
  return rows.length;
}

/* ------------------------------------------------------------------ */
/* 搜索                                                                */
/* ------------------------------------------------------------------ */

export function searchNotes(query: string, limit = 30): SearchHit[] {
  const match = toMatchQuery(query);
  if (!match) return [];
  const rows = all<{ id: Id; title: string; content: string; updated_at: string; category_name: string | null }>(
    `select n.id, n.title, n.content, n.updated_at, c.name as category_name
     from note_fts f
     join note n on n.id = f.rowid
     left join category c on c.id = n.category_id
     where note_fts match ? and n.deleted_at is null
     order by rank
     limit ?`,
    match,
    Math.min(Math.max(limit, 1), 200)
  );
  return rows.map((r) => ({
    note_id: r.id,
    title: r.title || '(无标题)',
    category_name: r.category_name,
    snippet: snippetAround(r.content || r.title, query),
    updated_at: r.updated_at
  }));
}

/** 恢复备份或数据异常后重建索引。 */
export function rebuildSearchIndex(): number {
  run('delete from note_fts');
  const notes = all<{ id: Id; title: string; content: string }>(
    'select id, title, content from note'
  );
  for (const n of notes) syncFts(n.id, n.title ?? '', n.content ?? '');
  return notes.length;
}

/* ------------------------------------------------------------------ */
/* 标签                                                                */
/* ------------------------------------------------------------------ */

export function listTags(): Tag[] {
  return all<Tag>(
    `select t.id, t.name,
            (select count(*) from note_tag nt join note n on n.id = nt.note_id
              where nt.tag_id = t.id and n.deleted_at is null) as note_count
     from tag t order by t.name`
  );
}

export function setNoteTags(noteId: Id, names: string[]): void {
  run('delete from note_tag where note_id = ?', noteId);
  for (const raw of names) {
    const name = raw.trim();
    if (!name) continue;
    run('insert or ignore into tag(name, created_at) values(?, ?)', name, nowIso());
    const tag = one<{ id: Id }>('select id from tag where name = ?', name);
    if (tag) run('insert or ignore into note_tag(note_id, tag_id) values(?, ?)', noteId, tag.id);
  }
}

export function deleteTag(id: Id): void {
  run('delete from tag where id = ?', id);
}

/* ------------------------------------------------------------------ */
/* 附件                                                                */
/* ------------------------------------------------------------------ */

function removeAttachmentFile(relPath: string): void {
  try {
    const p = paths ? path.join(paths.root, relPath) : null;
    if (p && fs.existsSync(p)) fs.rmSync(p, { force: true });
  } catch {
    // 附件文件删不掉不影响数据库一致性
  }
}

export function addAttachment(
  noteId: Id | null,
  sourcePath: string,
  originalName: string
): Attachment {
  if (!paths) throw new Error('数据目录尚未初始化');
  const dir = attachmentDirFor(paths.attachments);
  const ext = path.extname(originalName);
  const base = path.basename(originalName, ext).slice(0, 60) || 'file';
  let fileName = `${base}${ext}`;
  let target = path.join(dir, fileName);
  let i = 1;
  while (fs.existsSync(target)) {
    fileName = `${base}_${i}${ext}`;
    target = path.join(dir, fileName);
    i += 1;
  }
  fs.copyFileSync(sourcePath, target);
  const stat = fs.statSync(target);
  const relPath = path.relative(paths.root, target);
  const r = run(
    `insert into attachment(note_id, file_name, rel_path, size, mime, created_at)
     values(?, ?, ?, ?, ?, ?)`,
    noteId,
    originalName,
    relPath,
    stat.size,
    mimeOf(ext),
    nowIso()
  );
  const created = one<Attachment>('select * from attachment where id = ?', r.lastInsertRowid);
  if (!created) throw new Error('附件写入失败');
  return created;
}

function mimeOf(ext: string): string {
  const map: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain',
    '.md': 'text/markdown'
  };
  return map[ext.toLowerCase()] ?? 'application/octet-stream';
}

export function attachmentAbsPath(relPath: string): string {
  if (!paths) throw new Error('数据目录尚未初始化');
  return path.join(paths.root, relPath);
}

export function deleteAttachment(id: Id): void {
  const row = one<{ rel_path: string }>('select rel_path from attachment where id = ?', id);
  if (row) removeAttachmentFile(row.rel_path);
  run('delete from attachment where id = ?', id);
}

/* ------------------------------------------------------------------ */
/* 收集箱                                                              */
/* ------------------------------------------------------------------ */

export function listInbox(status: 'open' | 'processed' | 'discarded' | 'all' = 'open'): InboxItem[] {
  if (status === 'all') {
    return all<InboxItem>('select * from inbox_item order by created_at desc limit 500');
  }
  return all<InboxItem>(
    'select * from inbox_item where status = ? order by created_at desc limit 500',
    status
  );
}

export function addInbox(content: string, kind: InboxKind = 'idea'): Id {
  const now = nowIso();
  const r = run(
    'insert into inbox_item(content, kind, status, created_at, updated_at) values(?, ?, ?, ?, ?)',
    content.trim(),
    kind,
    'open',
    now,
    now
  );
  return r.lastInsertRowid;
}

export function updateInbox(id: Id, patch: { content?: string; kind?: InboxKind }): void {
  if (patch.content !== undefined) {
    run('update inbox_item set content = ?, updated_at = ? where id = ?', patch.content, nowIso(), id);
  }
  if (patch.kind !== undefined) {
    run('update inbox_item set kind = ?, updated_at = ? where id = ?', patch.kind, nowIso(), id);
  }
}

export function setInboxStatus(id: Id, status: 'open' | 'processed' | 'discarded', convertedTo?: string): void {
  run(
    'update inbox_item set status = ?, converted_to = ?, updated_at = ? where id = ?',
    status,
    convertedTo ?? null,
    nowIso(),
    id
  );
}

export function deleteInbox(id: Id): void {
  run('delete from inbox_item where id = ?', id);
}

export function inboxOpenCount(): number {
  return Number(one<{ c: number }>("select count(*) as c from inbox_item where status = 'open'")?.c ?? 0);
}

/* ------------------------------------------------------------------ */
/* 任务                                                                */
/* ------------------------------------------------------------------ */

/** 老库里可能还留着数字优先级（没走过迁移的手工库），读出来一律归一成三档。 */
function toPriority(value: unknown): TaskPriority {
  if (value === 'urgent' || value === 'important' || value === 'normal') return value;
  const n = Number(value);
  if (n >= 3) return 'urgent';
  if (n === 2) return 'important';
  return 'normal';
}

function toTask(row: Task, today: string): Task {
  const due = row.due_at ? String(row.due_at).slice(0, 10) : null;
  return {
    ...row,
    priority: toPriority(row.priority),
    overdue: !!(due && due < today && row.status === 'todo')
  };
}

export function listTasks(filter: TaskFilter = {}): Task[] {
  const today = todayLocal();
  const where: string[] = ['deleted_at is null'];
  const args: unknown[] = [];
  switch (filter.view) {
    // 今天视图故意不按 status 过滤：勾完就消失会让人以为任务被删了，
    // 已完成的排到最后（见下面 order by）并显示成灰字删除线。
    case 'today':
      where.push('due_at is not null and substr(due_at, 1, 10) <= ?');
      args.push(today);
      break;
    case 'overdue':
      where.push("status = 'todo' and due_at is not null and substr(due_at, 1, 10) < ?");
      args.push(today);
      break;
    case 'upcoming':
      where.push("status = 'todo' and due_at is not null and substr(due_at, 1, 10) > ?");
      args.push(today);
      break;
    case 'done':
      where.push("status = 'done'");
      break;
    default:
      break;
  }
  if (filter.status === 'todo') where.push("status = 'todo'");
  else if (filter.status === 'done') where.push("status = 'done'");
  if (filter.priority && filter.priority !== 'all') {
    where.push('priority = ?');
    args.push(filter.priority);
  }
  if (filter.goalId != null) {
    where.push('goal_id = ?');
    args.push(filter.goalId);
  }
  if (filter.q) {
    where.push('title like ?');
    args.push(`%${filter.q}%`);
  }
  // 列表一次最多取 2000 条（默认 500）：个人知识库正常用不到这么多，
  // 真到了这个量级靠搜索/视图缩小范围，避免一次把几万行塞给界面。
  const limit = Math.min(Math.max(Number(filter.limit ?? 500) || 500, 1), 2000);
  const rows = all<Task>(
    `select * from task where ${where.join(' and ')}
     order by case when status = 'done' then 1 else 0 end asc,
              case when due_at is null then 1 else 0 end asc,
              substr(due_at, 1, 10) asc,
              case priority when 'urgent' then 0 when 'important' then 1 else 2 end asc,
              id desc
     limit ${limit}`,
    ...args
  );
  return rows.map((r) => toTask(r, today));
}

/** 各视图的真实条数：不受列表 500 条上限影响，左侧角标要的是准数。 */
export function taskCounts(): Record<'today' | 'overdue' | 'upcoming' | 'all' | 'todo' | 'done', number> {
  const today = todayLocal();
  const n = (sql: string, ...args: unknown[]): number =>
    Number(one<{ c: number }>(sql, ...args)?.c ?? 0);
  const from = 'from task where deleted_at is null';
  return {
    today: n(`select count(*) as c ${from} and due_at is not null and substr(due_at, 1, 10) <= ?`, today),
    overdue: n(
      `select count(*) as c ${from} and status = 'todo' and due_at is not null and substr(due_at, 1, 10) < ?`,
      today
    ),
    upcoming: n(
      `select count(*) as c ${from} and due_at is not null and substr(due_at, 1, 10) > ?`,
      today
    ),
    all: n(`select count(*) as c ${from}`),
    todo: n(`select count(*) as c ${from} and status = 'todo'`),
    done: n(`select count(*) as c ${from} and status = 'done'`)
  };
}

export function createTask(input: Partial<Task> & { title: string }): Id {
  const now = nowIso();
  const r = run(
    `insert into task(title, note, status, priority, due_at, remind_at, repeat_rule, goal_id, plan_id,
                      sort_order, created_at, updated_at)
     values(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    input.title.trim(),
    input.note ?? '',
    input.status ?? 'todo',
    toPriority(input.priority ?? 'normal'),
    input.due_at ?? null,
    input.remind_at ?? null,
    input.repeat_rule ?? 'none',
    input.goal_id ?? null,
    input.plan_id ?? null,
    0,
    now,
    now
  );
  return r.lastInsertRowid;
}

export function updateTask(id: Id, patch: Partial<Task>): void {
  const fields: string[] = [];
  const args: unknown[] = [];
  const allowed: (keyof Task)[] = [
    'title',
    'note',
    'status',
    'priority',
    'due_at',
    'remind_at',
    'repeat_rule',
    'goal_id',
    'plan_id'
  ];
  for (const key of allowed) {
    if (patch[key] !== undefined) {
      fields.push(`${key} = ?`);
      // 优先级一律归一成三档文字：调用方传数字（老代码/外部脚本）也不会写进脏值
      args.push((key === 'priority' ? toPriority(patch[key]) : patch[key]) as never);
    }
  }
  if (!fields.length) return;
  fields.push('updated_at = ?');
  args.push(nowIso());
  args.push(id);
  run(`update task set ${fields.join(', ')} where id = ?`, ...args);
}

function addDays(dateStr: string, days: number): string {
  const [datePart, timePart] = dateStr.split(' ');
  const dt = parseLocalDate(datePart);
  dt.setDate(dt.getDate() + days);
  const iso = todayLocal(dt);
  return timePart ? `${iso} ${timePart}` : iso;
}

/** 按本地时区解析 YYYY-MM-DD，避免 new Date('...') 当 UTC 处理导致的星期偏差。 */
function parseLocalDate(dateStr: string): Date {
  const [y, m, d] = dateStr.slice(0, 10).split('-').map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

function nextOccurrence(dueAt: string, rule: RepeatRule): string {
  switch (rule) {
    case 'daily':
      return addDays(dueAt, 1);
    case 'weekdays': {
      let next = addDays(dueAt, 1);
      while ([0, 6].includes(parseLocalDate(next).getDay())) next = addDays(next, 1);
      return next;
    }
    case 'weekly':
      return addDays(dueAt, 7);
    case 'monthly': {
      // 下个月的「同一天」。遇到下个月没有的日子（1/31 → 2 月）就退到当月最后一天，
      // 不能直接用 new Date(y, m, d)，那样会溢出到 3 月 3 日。
      const [datePart, timePart] = dueAt.split(' ');
      const [y, m, d] = datePart.split('-').map(Number);
      const monthStart = new Date(y, m, 1);
      const lastDay = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 0).getDate();
      const dt = new Date(monthStart.getFullYear(), monthStart.getMonth(), Math.min(d, lastDay));
      const iso = todayLocal(dt);
      return timePart ? `${iso} ${timePart}` : iso;
    }
    default:
      return dueAt;
  }
}

/**
 * 勾选/取消任务。重复任务勾完会自动生成下一次的那条，
 * 已完成的那条留在原地作为记录。
 */
export function toggleTask(id: Id, status?: TaskStatus): { task: Task | null; spawned: Id | null } {
  const row = one<Task>('select * from task where id = ?', id);
  if (!row) return { task: null, spawned: null };
  const next: TaskStatus = status ?? (row.status === 'done' ? 'todo' : 'done');
  const now = nowIso();
  run(
    'update task set status = ?, completed_at = ?, updated_at = ? where id = ?',
    next,
    next === 'done' ? now : null,
    now,
    id
  );

  let spawned: Id | null = null;
  if (next === 'done' && row.status !== 'done' && row.repeat_rule && row.repeat_rule !== 'none') {
    const base = row.due_at ?? todayLocal();
    spawned = createTask({
      title: row.title,
      note: row.note,
      priority: row.priority,
      due_at: nextOccurrence(base, row.repeat_rule),
      repeat_rule: row.repeat_rule,
      goal_id: row.goal_id,
      plan_id: row.plan_id
    });
  }
  const updated = one<Task>('select * from task where id = ?', id) ?? null;
  return { task: updated ? toTask(updated, todayLocal()) : null, spawned };
}

export function deleteTask(id: Id): void {
  run('update task set deleted_at = ? where id = ?', nowIso(), id);
}

/** 批量删除（多选模式用）：走和单条一样的软删除，返回真正删掉的条数。 */
export function deleteTasks(ids: Id[]): number {
  const clean = [...new Set(ids.map(Number).filter((n) => Number.isFinite(n)))];
  if (clean.length === 0) return 0;
  const now = nowIso();
  let n = 0;
  for (const id of clean) {
    const before = one<{ c: number }>('select count(*) as c from task where id = ? and deleted_at is null', id);
    run('update task set deleted_at = ? where id = ? and deleted_at is null', now, id);
    if (Number(before?.c ?? 0) > 0) n += 1;
  }
  return n;
}

/** 本地「YYYY-MM-DD HH:mm」，只用来和 remind_at 做字符串比较。 */
export function nowLocalMinute(d = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 到期与逾期通知的数据来源：提醒时间到了，或者截止日到了（含逾期）。 */
export function dueTasksForNotice(): Task[] {
  const today = todayLocal();
  const nowMinute = nowLocalMinute();
  return all<Task>(
    `select * from task
     where deleted_at is null and status = 'todo'
       and (
         (remind_at is not null and remind_at <> '' and remind_at <= ?)
         or (due_at is not null and substr(due_at, 1, 10) <= ?)
       )
     order by substr(coalesce(remind_at, due_at), 1, 16) asc,
              case priority when 'urgent' then 0 when 'important' then 1 else 2 end asc`,
    nowMinute,
    today
  ).map((r) => toTask(r, today));
}

/* ------------------------------------------------------------------ */
/* 目标（第一版仅首页摘要使用，完整界面在第二版）                      */
/* ------------------------------------------------------------------ */

/** 收集箱「转目标」：第一版只落库，界面在第二版补全。 */
export function createGoalFromInbox(title: string, description = ''): Id {
  const now = nowIso();
  const r = run(
    `insert into goal(title, description, status, started_at, created_at, updated_at)
     values(?, ?, 'active', ?, ?, ?)`,
    title.trim(),
    description,
    todayLocal(),
    now,
    now
  );
  return r.lastInsertRowid;
}

/** 收集箱「转学习计划」：第一版只落库，界面在第二版补全。 */
export function createPlanFromInbox(title: string, direction = ''): Id {
  const now = nowIso();
  const r = run(
    `insert into plan(title, direction, start_date, status, created_at, updated_at)
     values(?, ?, ?, 'active', ?, ?)`,
    title.trim(),
    direction,
    todayLocal(),
    now,
    now
  );
  return r.lastInsertRowid;
}

export function goalProgress(goalId: Id): number {
  // 进度 = 可用维度的平均值：关键结果完成度 + 关联任务完成率；
  // 两者都没有时，退到里程碑完成率；都没有就是 0。
  const kr = one<{ cur: number; tar: number; c: number }>(
    `select sum(current_value) as cur, sum(target_value) as tar, count(*) as c
     from goal_key_result where goal_id = ?`,
    goalId
  );
  const krCount = Number(kr?.c ?? 0);
  const tasks = one<{ total: number; done: number }>(
    `select count(*) as total, sum(case when status = 'done' then 1 else 0 end) as done
     from task where goal_id = ? and deleted_at is null`,
    goalId
  );
  const taskTotal = Number(tasks?.total ?? 0);
  const ms = one<{ total: number; done: number }>(
    `select count(*) as total, sum(done) as done from milestone where goal_id = ?`,
    goalId
  );
  const msTotal = Number(ms?.total ?? 0);

  const parts: number[] = [];
  if (krCount > 0) {
    const tar = Number(kr?.tar ?? 0);
    parts.push(tar > 0 ? Math.min(1, Number(kr?.cur ?? 0) / tar) : 0);
  }
  if (taskTotal > 0) parts.push(Number(tasks?.done ?? 0) / taskTotal);
  if (parts.length === 0 && msTotal > 0) parts.push(Number(ms?.done ?? 0) / msTotal);
  if (parts.length === 0) return 0;
  const avg = parts.reduce((a, b) => a + b, 0) / parts.length;
  return Math.max(0, Math.min(100, Math.round(avg * 100)));
}

/* ------------------------------------------------------------------ */
/* 首页总览                                                            */
/* ------------------------------------------------------------------ */

export function dashboard(): DashboardData {
  const today = todayLocal();
  const tasks = all<Task>(
    `select * from task
     where deleted_at is null and status = 'todo' and due_at is not null
       and substr(due_at, 1, 10) <= ?
     order by substr(due_at, 1, 10) asc,
              case priority when 'urgent' then 0 when 'important' then 1 else 2 end asc, id desc
     limit 50`,
    today
  ).map((r) => toTask(r, today));

  const overdueCount = Number(
    one<{ c: number }>(
      `select count(*) as c from task where deleted_at is null and status = 'todo'
         and due_at is not null and substr(due_at, 1, 10) < ?`,
      today
    )?.c ?? 0
  );

  const doneTodayCount = Number(
    one<{ c: number }>(
      `select count(*) as c from task where deleted_at is null and status = 'done'
         and completed_at is not null and substr(completed_at, 1, 10) = ?`,
      today
    )?.c ?? 0
  );

  const reviewDue = all<{ id: Id; note_id: Id | null; front: string; next_review_at: string }>(
    `select id, note_id, front, next_review_at from review_card
     where deleted_at is null and next_review_at is not null and substr(next_review_at, 1, 10) <= ?
     order by next_review_at asc limit 20`,
    today
  );

  const goalRows = all<{ id: Id; title: string; target_date: string | null }>(
    `select id, title, target_date from goal
     where deleted_at is null and status = 'active' order by sort_order, id limit 3`
  );

  const recentNotes = listNotes({ limit: 6 });
  const todayPlan = calendarEntries(today, today);
  const reviewDueCount = Number(
    one<{ c: number }>(
      `select count(*) as c from review_card
       where deleted_at is null and next_review_at is not null and substr(next_review_at, 1, 10) <= ?`,
      today
    )?.c ?? 0
  );

  return {
    today,
    tasks,
    overdueCount,
    doneTodayCount,
    inboxCount: inboxOpenCount(),
    reviewDue,
    reviewDueCount,
    todayPlan,
    goals: goalRows.map((g) => ({ ...g, progress: goalProgress(g.id) })),
    recentNotes
  };
}

/* ------------------------------------------------------------------ */
/* 第二版：当前目标（关键结果 / 里程碑）                                */
/* ------------------------------------------------------------------ */

/** 当前目标最多 3 个（PRD 4 / 5.6：不允许无限堆积）。 */
export const MAX_ACTIVE_GOALS = 3;

function goalSummary(g: Goal): GoalSummary {
  const krCount = Number(
    one<{ c: number }>('select count(*) as c from goal_key_result where goal_id = ?', g.id)?.c ?? 0
  );
  const msCount = Number(
    one<{ c: number }>('select count(*) as c from milestone where goal_id = ?', g.id)?.c ?? 0
  );
  const taskCount = Number(
    one<{ c: number }>(
      'select count(*) as c from task where goal_id = ? and deleted_at is null',
      g.id
    )?.c ?? 0
  );
  return {
    ...g,
    progress: goalProgress(g.id),
    kr_count: krCount,
    milestone_count: msCount,
    task_count: taskCount
  };
}

export function activeGoalCount(): number {
  return Number(
    one<{ c: number }>(
      "select count(*) as c from goal where deleted_at is null and status = 'active'"
    )?.c ?? 0
  );
}

export function listGoals(includeArchived = false): GoalSummary[] {
  const rows = all<Goal>(
    `select * from goal
     where deleted_at is null ${includeArchived ? '' : "and status = 'active'"}
     order by case status when 'active' then 0 when 'done' then 1 else 2 end, sort_order, id`
  );
  return rows.map(goalSummary);
}

export function getGoalDetail(goalId: Id): GoalDetail | null {
  const g = one<Goal>('select * from goal where id = ? and deleted_at is null', goalId);
  if (!g) return null;
  return {
    goal: goalSummary(g),
    keyResults: listKeyResults(goalId),
    milestones: listMilestones(goalId),
    tasks: listTasks({ goalId, limit: 200 })
  };
}

export function createGoal(input: {
  title: string;
  description?: string;
  target_date?: string | null;
  status?: GoalStatus;
}): Id {
  const title = input.title.trim();
  if (!title) throw new Error('目标名称不能为空');
  const status: GoalStatus = input.status ?? 'active';
  if (status === 'active' && activeGoalCount() >= MAX_ACTIVE_GOALS) {
    throw new Error(`当前目标最多 ${MAX_ACTIVE_GOALS} 个，先完成或归档一个再新建`);
  }
  const now = nowIso();
  const nextOrder =
    Number(one<{ m: number }>('select coalesce(max(sort_order), 0) + 1 as m from goal')?.m ?? 1) || 1;
  const r = run(
    `insert into goal(title, description, status, target_date, started_at, sort_order, created_at, updated_at)
     values(?, ?, ?, ?, ?, ?, ?, ?)`,
    title,
    input.description ?? '',
    status,
    input.target_date ?? null,
    status === 'active' ? todayLocal() : null,
    nextOrder,
    now,
    now
  );
  return r.lastInsertRowid;
}

export function updateGoal(id: Id, patch: Partial<Goal>): void {
  const fields: string[] = [];
  const args: unknown[] = [];
  for (const key of ['title', 'description', 'target_date', 'status', 'sort_order'] as (keyof Goal)[]) {
    if (patch[key] !== undefined) {
      fields.push(`${key} = ?`);
      args.push(patch[key] as never);
    }
  }
  if (fields.length) {
    fields.push('updated_at = ?');
    args.push(nowIso());
    args.push(id);
    run(`update goal set ${fields.join(', ')} where id = ?`, ...args);
  }
  if (patch.status === 'archived') {
    run('update goal set archived_at = ?, updated_at = ? where id = ?', nowIso(), nowIso(), id);
  } else if (patch.status === 'active') {
    run('update goal set archived_at = null, updated_at = ? where id = ?', nowIso(), id);
  }
}

/** 删除目标：任务不删只解除关联，关键结果与里程碑一并清掉（PRD 6.3）。 */
export function deleteGoal(id: Id): void {
  run('update task set goal_id = null where goal_id = ?', id);
  run('update goal_pool set goal_id = null where goal_id = ?', id);
  run('delete from goal_key_result where goal_id = ?', id);
  run('delete from milestone where goal_id = ?', id);
  const now = nowIso();
  run('update goal set deleted_at = ?, updated_at = ? where id = ?', now, now, id);
}

export function listKeyResults(goalId: Id): KeyResult[] {
  return all<KeyResult>(
    'select * from goal_key_result where goal_id = ? order by sort_order, id',
    goalId
  );
}

export function createKeyResult(
  goalId: Id,
  input: { title: string; target_value?: number; current_value?: number; unit?: string }
): Id {
  const title = input.title.trim();
  if (!title) throw new Error('关键结果不能为空');
  const now = nowIso();
  const nextOrder =
    Number(
      one<{ m: number }>(
        'select coalesce(max(sort_order), 0) + 1 as m from goal_key_result where goal_id = ?',
        goalId
      )?.m ?? 1
    ) || 1;
  const r = run(
    `insert into goal_key_result(goal_id, title, target_value, current_value, unit, sort_order, created_at, updated_at)
     values(?, ?, ?, ?, ?, ?, ?, ?)`,
    goalId,
    title,
    Number(input.target_value ?? 1),
    Number(input.current_value ?? 0),
    input.unit ?? '',
    nextOrder,
    now,
    now
  );
  return r.lastInsertRowid;
}

export function updateKeyResult(id: Id, patch: Partial<KeyResult>): void {
  const fields: string[] = [];
  const args: unknown[] = [];
  for (const key of ['title', 'target_value', 'current_value', 'unit', 'sort_order'] as (keyof KeyResult)[]) {
    if (patch[key] !== undefined) {
      fields.push(`${key} = ?`);
      args.push(patch[key] as never);
    }
  }
  if (!fields.length) return;
  fields.push('updated_at = ?');
  args.push(nowIso());
  args.push(id);
  run(`update goal_key_result set ${fields.join(', ')} where id = ?`, ...args);
}

export function deleteKeyResult(id: Id): void {
  run('delete from goal_key_result where id = ?', id);
}

export function listMilestones(goalId: Id): Milestone[] {
  return all<Milestone>('select * from milestone where goal_id = ? order by sort_order, id', goalId);
}

export function createMilestone(
  goalId: Id,
  input: { title: string; target_date?: string | null }
): Id {
  const title = input.title.trim();
  if (!title) throw new Error('里程碑不能为空');
  const now = nowIso();
  const nextOrder =
    Number(
      one<{ m: number }>(
        'select coalesce(max(sort_order), 0) + 1 as m from milestone where goal_id = ?',
        goalId
      )?.m ?? 1
    ) || 1;
  const r = run(
    `insert into milestone(goal_id, title, target_date, done, sort_order, created_at, updated_at)
     values(?, ?, ?, 0, ?, ?, ?)`,
    goalId,
    title,
    input.target_date ?? null,
    nextOrder,
    now,
    now
  );
  return r.lastInsertRowid;
}

export function updateMilestone(id: Id, patch: Partial<Milestone>): void {
  const fields: string[] = [];
  const args: unknown[] = [];
  for (const key of ['title', 'target_date', 'sort_order'] as (keyof Milestone)[]) {
    if (patch[key] !== undefined) {
      fields.push(`${key} = ?`);
      args.push(patch[key] as never);
    }
  }
  if (!fields.length) return;
  fields.push('updated_at = ?');
  args.push(nowIso());
  args.push(id);
  run(`update milestone set ${fields.join(', ')} where id = ?`, ...args);
}

export function toggleMilestone(id: Id, done?: boolean): void {
  const row = one<Milestone>('select * from milestone where id = ?', id);
  if (!row) return;
  const next = done ?? !Number(row.done);
  run(
    'update milestone set done = ?, done_at = ?, updated_at = ? where id = ?',
    next ? 1 : 0,
    next ? nowIso() : null,
    nowIso(),
    id
  );
}

export function deleteMilestone(id: Id): void {
  run('delete from milestone where id = ?', id);
}

/* ------------------------------------------------------------------ */
/* 第二版：下一阶段目标（目标池 / 路线图 / 启动条件）                   */
/* ------------------------------------------------------------------ */

export function listGoalPool(horizon?: GoalHorizon): GoalPoolItem[] {
  const args: unknown[] = [];
  let where = '';
  if (horizon) {
    where = 'where horizon = ?';
    args.push(horizon);
  }
  const rows = all<GoalPoolItem>(
    `select * from goal_pool ${where}
     order by case status when 'ready' then 0 when 'pool' then 1 when 'started' then 2 else 3 end,
              case horizon when 'this' then 0 when 'next' then 1 else 2 end,
              priority desc, id desc`,
    ...args
  );
  return rows.map((r) => ({ ...r, priority: Number(r.priority) }));
}

export function createPoolItem(input: {
  title: string;
  why?: string;
  start_condition?: string;
  horizon?: GoalHorizon;
  priority?: number;
  est_start?: string | null;
}): Id {
  const title = input.title.trim();
  if (!title) throw new Error('想法名称不能为空');
  const now = nowIso();
  const nextOrder =
    Number(one<{ m: number }>('select coalesce(max(sort_order), 0) + 1 as m from goal_pool')?.m ?? 1) ||
    1;
  // 启动条件填了就标成「待启动」，路线图与首页据此提示。
  const status = (input.start_condition ?? '').trim() ? 'ready' : 'pool';
  const r = run(
    `insert into goal_pool(title, description, why, start_condition, status, priority, horizon,
                           est_start, sort_order, created_at, updated_at)
     values(?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    title,
    input.why ?? '',
    input.start_condition ?? '',
    status,
    Number(input.priority ?? 2),
    input.horizon ?? 'later',
    input.est_start ?? null,
    nextOrder,
    now,
    now
  );
  return r.lastInsertRowid;
}

export function updatePoolItem(id: Id, patch: Partial<GoalPoolItem>): void {
  const fields: string[] = [];
  const args: unknown[] = [];
  for (const key of [
    'title',
    'description',
    'why',
    'start_condition',
    'status',
    'priority',
    'horizon',
    'est_start',
    'goal_id',
    'sort_order'
  ] as (keyof GoalPoolItem)[]) {
    if (patch[key] !== undefined) {
      fields.push(`${key} = ?`);
      args.push(patch[key] as never);
    }
  }
  if (!fields.length) return;
  fields.push('updated_at = ?');
  args.push(nowIso());
  args.push(id);
  run(`update goal_pool set ${fields.join(', ')} where id = ?`, ...args);
}

export function deletePoolItem(id: Id): void {
  run('delete from goal_pool where id = ?', id);
}

/** 启动条件满足 → 转成当前目标，池里留下关联（PRD 5.7）。 */
export function startPoolItem(id: Id): { goalId: Id } {
  const row = one<GoalPoolItem>('select * from goal_pool where id = ?', id);
  if (!row) throw new Error('目标池里找不到这一条');
  if (row.goal_id) throw new Error('这一条已经启动过了');
  const goalId = createGoal({
    title: row.title,
    description: row.why || row.start_condition,
    status: 'active'
  });
  run(
    "update goal_pool set status = 'started', goal_id = ?, updated_at = ? where id = ?",
    goalId,
    nowIso(),
    id
  );
  return { goalId };
}

/* ------------------------------------------------------------------ */
/* 第二版：学习计划（周期安排 + 日历）                                  */
/* ------------------------------------------------------------------ */

function planSummary(p: Plan): PlanSummary {
  const row = one<{ total: number; done: number }>(
    'select count(*) as total, sum(done) as done from plan_item where plan_id = ?',
    p.id
  );
  const goalTitle = p.goal_id
    ? (one<{ title: string }>('select title from goal where id = ?', p.goal_id)?.title ?? null)
    : null;
  return {
    ...p,
    goal_title: goalTitle,
    item_count: Number(row?.total ?? 0),
    done_count: Number(row?.done ?? 0)
  };
}

export function listPlans(includeArchived = false): PlanSummary[] {
  const rows = all<Plan>(
    `select * from plan where deleted_at is null ${includeArchived ? '' : "and status != 'done'"}
     order by status asc, start_date is null, start_date, id`
  );
  return rows.map(planSummary);
}

export function getPlanDetail(planId: Id): PlanDetail | null {
  const p = one<Plan>('select * from plan where id = ? and deleted_at is null', planId);
  if (!p) return null;
  return { plan: planSummary(p), items: listPlanItems(planId) };
}

export function createPlan(input: {
  title: string;
  direction?: string;
  rhythm?: string;
  start_date?: string | null;
  end_date?: string | null;
  goal_id?: Id | null;
}): Id {
  const title = input.title.trim();
  if (!title) throw new Error('学习方向不能为空');
  const now = nowIso();
  const r = run(
    `insert into plan(title, direction, rhythm, start_date, end_date, status, goal_id, created_at, updated_at)
     values(?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
    title,
    input.direction ?? '',
    input.rhythm ?? '',
    input.start_date ?? todayLocal(),
    input.end_date ?? null,
    input.goal_id ?? null,
    now,
    now
  );
  return r.lastInsertRowid;
}

export function updatePlan(id: Id, patch: Partial<Plan>): void {
  const fields: string[] = [];
  const args: unknown[] = [];
  for (const key of [
    'title',
    'direction',
    'rhythm',
    'start_date',
    'end_date',
    'status',
    'goal_id'
  ] as (keyof Plan)[]) {
    if (patch[key] !== undefined) {
      fields.push(`${key} = ?`);
      args.push(patch[key] as never);
    }
  }
  if (!fields.length) return;
  fields.push('updated_at = ?');
  args.push(nowIso());
  args.push(id);
  run(`update plan set ${fields.join(', ')} where id = ?`, ...args);
}

/** 删除学习计划：软删计划本身，条目保留（计划藏起来后就看不见了）。 */
export function deletePlan(id: Id): void {
  const now = nowIso();
  run('update plan set deleted_at = ?, updated_at = ? where id = ?', now, now, id);
}

export function listPlanItems(planId: Id): PlanItem[] {
  return all<PlanItem>(
    `select * from plan_item where plan_id = ?
     order by date is null, date, id`,
    planId
  );
}

export function createPlanItem(
  planId: Id,
  input: { title: string; date?: string | null; minutes?: number; note_id?: Id | null }
): Id {
  const title = input.title.trim();
  if (!title) throw new Error('计划内容不能为空');
  const now = nowIso();
  const r = run(
    `insert into plan_item(plan_id, date, title, minutes, done, note_id, created_at, updated_at)
     values(?, ?, ?, ?, 0, ?, ?, ?)`,
    planId,
    input.date ?? null,
    title,
    Number(input.minutes ?? 0),
    input.note_id ?? null,
    now,
    now
  );
  return r.lastInsertRowid;
}

export function updatePlanItem(id: Id, patch: Partial<PlanItem>): void {
  const fields: string[] = [];
  const args: unknown[] = [];
  for (const key of ['date', 'title', 'minutes', 'note_id'] as (keyof PlanItem)[]) {
    if (patch[key] !== undefined) {
      fields.push(`${key} = ?`);
      args.push(patch[key] as never);
    }
  }
  if (!fields.length) return;
  fields.push('updated_at = ?');
  args.push(nowIso());
  args.push(id);
  run(`update plan_item set ${fields.join(', ')} where id = ?`, ...args);
}

export function togglePlanItem(id: Id, done?: boolean): void {
  const row = one<PlanItem>('select * from plan_item where id = ?', id);
  if (!row) return;
  const next = done ?? !Number(row.done);
  run(
    'update plan_item set done = ?, done_at = ?, updated_at = ? where id = ?',
    next ? 1 : 0,
    next ? nowIso() : null,
    nowIso(),
    id
  );
}

export function deletePlanItem(id: Id): void {
  run('delete from plan_item where id = ?', id);
}

/** 日历视图：某段日期内的全部计划条目（含所属计划名）。 */
export function calendarEntries(from: string, to: string): CalendarEntry[] {
  return all<CalendarEntry>(
    `select i.id, i.plan_id, p.title as plan_title, i.date, i.title, i.minutes, i.done, i.done_at
     from plan_item i join plan p on p.id = i.plan_id
     where p.deleted_at is null and i.date is not null and i.date >= ? and i.date <= ?
     order by i.date, i.done, i.id`,
    from,
    to
  ).map((r) => ({ ...r, minutes: Number(r.minutes), done: Number(r.done) }));
}

/* ------------------------------------------------------------------ */
/* 第二版：复习与复盘（简化 SM-2 + 日/周/月复盘）                       */
/* ------------------------------------------------------------------ */

/** 三档打分对应的间隔阶梯（天）。ease_level 是阶梯下标。 */
export const REVIEW_LADDER = [1, 2, 4, 7, 15, 30, 60, 120];

export function listReviewCards(filter: { due?: boolean; source?: string; limit?: number } = {}): ReviewCard[] {
  const where: string[] = ['deleted_at is null'];
  const args: unknown[] = [];
  if (filter.due) {
    where.push('next_review_at is not null and substr(next_review_at, 1, 10) <= ?');
    args.push(todayLocal());
  }
  if (filter.source) {
    where.push('source = ?');
    args.push(filter.source);
  }
  const limit = Math.min(Math.max(Number(filter.limit ?? 300) || 300, 1), 2000);
  return all<ReviewCard>(
    `select * from review_card where ${where.join(' and ')}
     order by next_review_at is null, next_review_at, id
     limit ${limit}`,
    ...args
  );
}

export function dueReviewCards(date = todayLocal()): ReviewCard[] {
  return all<ReviewCard>(
    `select * from review_card
     where deleted_at is null and next_review_at is not null and substr(next_review_at, 1, 10) <= ?
     order by next_review_at asc, id asc`,
    date
  );
}

export function createReviewCard(input: {
  front: string;
  back?: string;
  note_id?: Id | null;
  source?: ReviewSource;
  next_review_at?: string | null;
}): Id {
  const front = input.front.trim();
  if (!front) throw new Error('卡片正面不能为空');
  const now = nowIso();
  const r = run(
    `insert into review_card(note_id, front, back, source, ease_level, interval_days,
                             next_review_at, review_count, lapses, created_at, updated_at)
     values(?, ?, ?, ?, 0, 0, ?, 0, 0, ?, ?)`,
    input.note_id ?? null,
    front,
    input.back ?? '',
    input.source ?? 'note',
    input.next_review_at ?? todayLocal(),
    now,
    now
  );
  return r.lastInsertRowid;
}

/** 从笔记一键生成卡片：正面是标题，背面是正文开头。 */
export function createCardFromNote(noteId: Id): Id {
  const note = one<{ title: string; content: string }>(
    'select title, content from note where id = ? and deleted_at is null',
    noteId
  );
  if (!note) throw new Error('笔记不存在');
  const exists = one<{ id: Id }>(
    'select id from review_card where note_id = ? and deleted_at is null limit 1',
    noteId
  );
  if (exists) return exists.id;
  const back = note.content.replace(/\s+/g, ' ').trim().slice(0, 300);
  return createReviewCard({
    front: note.title || back.slice(0, 40) || '未命名笔记',
    back,
    note_id: noteId,
    source: 'note'
  });
}

export function updateReviewCard(id: Id, patch: Partial<ReviewCard>): void {
  const fields: string[] = [];
  const args: unknown[] = [];
  for (const key of ['front', 'back', 'source', 'note_id', 'next_review_at'] as (keyof ReviewCard)[]) {
    if (patch[key] !== undefined) {
      fields.push(`${key} = ?`);
      args.push(patch[key] as never);
    }
  }
  if (!fields.length) return;
  fields.push('updated_at = ?');
  args.push(nowIso());
  args.push(id);
  run(`update review_card set ${fields.join(', ')} where id = ?`, ...args);
}

export function deleteReviewCard(id: Id): void {
  run('update review_card set deleted_at = ?, updated_at = ? where id = ?', nowIso(), nowIso(), id);
}

function dateAfter(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return todayLocal(d);
}

/**
 * 三档打分（忘了 / 模糊 / 记得）决定下次复习时间：
 * - 记得：阶梯上走一格（1→2→4→7→15→30→60→120 天）
 * - 模糊：退回一格，间隔取当前间隔的 60%（至少 1 天）
 * - 忘了：回到起点，今天再来一次，并记一次遗忘
 */
export function gradeReviewCard(id: Id, grade: ReviewGrade): ReviewCard | null {
  const row = one<ReviewCard>('select * from review_card where id = ? and deleted_at is null', id);
  if (!row) return null;
  const level = Math.max(0, Math.min(Number(row.ease_level) || 0, REVIEW_LADDER.length - 1));
  const prevInterval = Number(row.interval_days) || 0;
  let nextLevel = level;
  let interval = prevInterval;

  if (grade === 'know') {
    // ease_level 记的是「已经答对过几次」，间隔取阶梯上对应的那一格：
    // 第一次记得 = 1 天，第二次 = 2 天……到顶就一直停在 120 天。
    nextLevel = Math.min(level + 1, REVIEW_LADDER.length);
    interval = REVIEW_LADDER[nextLevel - 1];
  } else if (grade === 'fuzzy') {
    nextLevel = Math.max(0, level - 1);
    interval = Math.max(1, Math.round((prevInterval || REVIEW_LADDER[level]) * 0.6));
  } else {
    nextLevel = 0;
    interval = 0;
  }

  const now = nowIso();
  const nextAt = interval > 0 ? dateAfter(interval) : todayLocal();
  run(
    `update review_card set ease_level = ?, interval_days = ?, next_review_at = ?,
            review_count = review_count + 1, lapses = lapses + ?, last_reviewed_at = ?, updated_at = ?
     where id = ?`,
    nextLevel,
    interval,
    nextAt,
    grade === 'forgot' ? 1 : 0,
    now,
    now,
    id
  );
  run(
    `insert into review_log(card_id, reviewed_at, result, interval_before, interval_after, ease_before, ease_after)
     values(?, ?, ?, ?, ?, ?, ?)`,
    id,
    now,
    grade,
    prevInterval,
    interval,
    level,
    nextLevel
  );
  return one<ReviewCard>('select * from review_card where id = ?', id) ?? null;
}

export function reviewLogs(cardId: Id, limit = 50): ReviewLog[] {
  return all<ReviewLog>(
    'select * from review_log where card_id = ? order by reviewed_at desc, id desc limit ?',
    cardId,
    Math.min(Math.max(Number(limit) || 50, 1), 500)
  );
}

export function reviewStats(): {
  total: number;
  dueToday: number;
  learned: number;
  reviewedToday: number;
  lapses: number;
} {
  const today = todayLocal();
  const n = (sql: string, ...args: unknown[]): number =>
    Number(one<{ c: number }>(sql, ...args)?.c ?? 0);
  return {
    total: n('select count(*) as c from review_card where deleted_at is null'),
    dueToday: n(
      `select count(*) as c from review_card where deleted_at is null
       and next_review_at is not null and substr(next_review_at, 1, 10) <= ?`,
      today
    ),
    learned: n('select count(*) as c from review_card where deleted_at is null and review_count > 0'),
    reviewedToday: n(
      'select count(*) as c from review_log where substr(reviewed_at, 1, 10) = ?',
      today
    ),
    lapses: n('select coalesce(sum(lapses), 0) as c from review_card where deleted_at is null')
  };
}

export function listRetrospectives(type?: RetroType): Retrospective[] {
  if (type) {
    return all<Retrospective>(
      'select * from retrospective where type = ? order by date desc limit 200',
      type
    );
  }
  return all<Retrospective>('select * from retrospective order by date desc limit 200');
}

export function getRetrospective(type: RetroType, date: string): Retrospective | null {
  return (
    one<Retrospective>('select * from retrospective where type = ? and date = ?', type, date) ?? null
  );
}

/** 写复盘：同一天同一类型只保留一份，再写就是覆盖。 */
export function saveRetrospective(type: RetroType, date: string, content: string): Id {
  const now = nowIso();
  const exists = getRetrospective(type, date);
  if (exists) {
    run(
      'update retrospective set content = ?, updated_at = ? where id = ?',
      content,
      now,
      exists.id
    );
    return exists.id;
  }
  const r = run(
    'insert into retrospective(type, date, content, created_at, updated_at) values(?, ?, ?, ?, ?)',
    type,
    date,
    content,
    now,
    now
  );
  return r.lastInsertRowid;
}

export function deleteRetrospective(id: Id): void {
  run('delete from retrospective where id = ?', id);
}

/** 复盘周期边界：本周（周一为起点）与本月。 */
export function periodRange(type: 'week' | 'month', from = new Date()): { from: string; to: string } {
  if (type === 'month') {
    const first = new Date(from.getFullYear(), from.getMonth(), 1);
    const last = new Date(from.getFullYear(), from.getMonth() + 1, 0);
    return { from: todayLocal(first), to: todayLocal(last) };
  }
  const day = from.getDay();
  const offset = day === 0 ? -6 : 1 - day;
  const monday = new Date(from.getFullYear(), from.getMonth(), from.getDate() + offset);
  const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);
  return { from: todayLocal(monday), to: todayLocal(sunday) };
}

/** 复盘页需要的「这段日期的产出」：完成的任务数、写完的笔记数、复习次数、计划完成率。 */
export function periodStats(from: string, to: string): {
  tasksDone: number;
  notesWritten: number;
  reviewsDone: number;
  planItemsDone: number;
  planItemsTotal: number;
} {
  const n = (sql: string, ...args: unknown[]): number =>
    Number(one<{ c: number }>(sql, ...args)?.c ?? 0);
  return {
    tasksDone: n(
      `select count(*) as c from task where deleted_at is null and status = 'done'
       and completed_at is not null and substr(completed_at, 1, 10) >= ? and substr(completed_at, 1, 10) <= ?`,
      from,
      to
    ),
    notesWritten: n(
      `select count(*) as c from note where deleted_at is null
       and substr(updated_at, 1, 10) >= ? and substr(updated_at, 1, 10) <= ?`,
      from,
      to
    ),
    reviewsDone: n(
      'select count(*) as c from review_log where substr(reviewed_at, 1, 10) >= ? and substr(reviewed_at, 1, 10) <= ?',
      from,
      to
    ),
    planItemsDone: n(
      'select count(*) as c from plan_item where done = 1 and date >= ? and date <= ?',
      from,
      to
    ),
    planItemsTotal: n(
      'select count(*) as c from plan_item where date >= ? and date <= ?',
      from,
      to
    )
  };
}
