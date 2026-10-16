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
import type {
  Attachment,
  Category,
  DashboardData,
  Id,
  InboxItem,
  InboxKind,
  ListFilter,
  Note,
  NoteListItem,
  NoteVersion,
  RepeatRule,
  SearchHit,
  Tag,
  Task,
  TaskFilter,
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
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  note_id    INTEGER NOT NULL,
  title      TEXT NOT NULL,
  content    TEXT NOT NULL,
  word_count INTEGER NOT NULL DEFAULT 0,
  reason     TEXT NOT NULL DEFAULT '手动保存',
  created_at TEXT NOT NULL
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
  priority     INTEGER NOT NULL DEFAULT 2,
  due_at       TEXT,
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
  sort_order      INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS plan (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT NOT NULL,
  direction  TEXT NOT NULL DEFAULT '',
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
  note_id    INTEGER REFERENCES note(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

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
  last_reviewed_at TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  deleted_at      TEXT
);

CREATE VIRTUAL TABLE IF NOT EXISTS note_fts USING fts5(
  title,
  content,
  tokenize = 'unicode61'
);
`;

const SCHEMA_VERSION = 1;

function migrate(): void {
  const database = requireDb();
  database.exec(SCHEMA);
  const row = one<{ user_version: number }>('PRAGMA user_version');
  const current = Number(row?.user_version ?? 0);
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
  return `select n.id, n.category_id, n.title, n.excerpt, n.word_count, n.is_pinned, n.updated_at,
                 c.name as category_name
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
  const sql = `${noteListSelect()} where ${where.join(' and ')}
               order by n.is_pinned desc, n.updated_at desc limit ${limit}`;
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

export function createNote(input: { categoryId?: Id | null; title?: string; content?: string }): Id {
  const now = nowIso();
  const title = input.title ?? '';
  const content = input.content ?? '';
  const r = run(
    `insert into note(category_id, title, content, excerpt, word_count, created_at, updated_at)
     values(?, ?, ?, ?, ?, ?, ?)`,
    input.categoryId ?? null,
    title,
    content,
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

/** 手动保存：写正文、清草稿，并按设置留一个版本点。 */
export function saveNote(id: Id, title: string, content: string, reason = '手动保存'): NoteVersion | null {
  const before = one<{ title: string; content: string; word_count: number }>(
    'select title, content, word_count from note where id = ?',
    id
  );
  const now = nowIso();
  const wc = countWords(content);
  run(
    `update note set title = ?, content = ?, excerpt = ?, word_count = ?, updated_at = ?,
            draft_title = null, draft_content = null, draft_at = null
     where id = ?`,
    title,
    content,
    makeExcerpt(content),
    wc,
    now,
    id
  );
  syncFts(id, title, content);

  const keep = Number(getSetting('versionKeep') ?? '20');
  if (keep <= 0) return null;
  // 第一次保存、或内容确实变了，才留版本点
  const changed = !before || before.content !== content || before.title !== title;
  if (!changed) return null;
  const r = run(
    `insert into note_version(note_id, title, content, word_count, reason, created_at)
     values(?, ?, ?, ?, ?, ?)`,
    id,
    title,
    content,
    wc,
    reason,
    now
  );
  pruneVersions(id, keep);
  return one<NoteVersion>('select * from note_version where id = ?', r.lastInsertRowid) ?? null;
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
  saveNote(v.note_id, current.title, current.content, '回滚前快照');
  saveNote(v.note_id, v.title, v.content, `回滚到 ${v.created_at.slice(0, 16).replace('T', ' ')}`);
  const after = getNote(v.note_id);
  if (!after) throw new Error('笔记不存在');
  return after;
}

export function moveNote(id: Id, categoryId: Id | null): void {
  run('update note set category_id = ?, updated_at = ? where id = ?', categoryId, nowIso(), id);
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

function toTask(row: Task, today: string): Task {
  const due = row.due_at ? String(row.due_at).slice(0, 10) : null;
  return {
    ...row,
    priority: Number(row.priority),
    overdue: !!(due && due < today && row.status === 'todo')
  };
}

export function listTasks(filter: TaskFilter = {}): Task[] {
  const today = todayLocal();
  const where: string[] = ['deleted_at is null'];
  const args: unknown[] = [];
  switch (filter.view) {
    case 'today':
      where.push("status = 'todo' and due_at is not null and substr(due_at, 1, 10) <= ?");
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
     order by status asc,
              case when due_at is null then 1 else 0 end asc,
              substr(due_at, 1, 10) asc,
              priority desc, id desc
     limit ${limit}`,
    ...args
  );
  return rows.map((r) => toTask(r, today));
}

/** 各视图的真实条数：不受列表 500 条上限影响，左侧角标要的是准数。 */
export function taskCounts(): Record<'today' | 'overdue' | 'upcoming' | 'all' | 'done', number> {
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
    done: n(`select count(*) as c ${from} and status = 'done'`)
  };
}

export function createTask(input: Partial<Task> & { title: string }): Id {
  const now = nowIso();
  const r = run(
    `insert into task(title, note, status, priority, due_at, repeat_rule, goal_id, plan_id,
                      sort_order, created_at, updated_at)
     values(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    input.title.trim(),
    input.note ?? '',
    input.status ?? 'todo',
    input.priority ?? 2,
    input.due_at ?? null,
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
    'repeat_rule',
    'goal_id',
    'plan_id'
  ];
  for (const key of allowed) {
    if (patch[key] !== undefined) {
      fields.push(`${key} = ?`);
      args.push(patch[key] as never);
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

/** 到期与逾期通知的数据来源。 */
export function dueTasksForNotice(): Task[] {
  const today = todayLocal();
  return all<Task>(
    `select * from task
     where deleted_at is null and status = 'todo' and due_at is not null
       and substr(due_at, 1, 10) <= ?
     order by substr(due_at, 1, 10) asc, priority desc`,
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
  const row = one<{ cur: number; tar: number; c: number }>(
    `select sum(current_value) as cur, sum(target_value) as tar, count(*) as c
     from goal_key_result where goal_id = ?`,
    goalId
  );
  const count = Number(row?.c ?? 0);
  if (!count) {
    const tasks = one<{ total: number; done: number }>(
      `select count(*) as total, sum(case when status = 'done' then 1 else 0 end) as done
       from task where goal_id = ? and deleted_at is null`,
      goalId
    );
    const total = Number(tasks?.total ?? 0);
    if (!total) return 0;
    return Math.round((Number(tasks?.done ?? 0) / total) * 100);
  }
  const tar = Number(row?.tar ?? 0);
  if (tar <= 0) return 0;
  return Math.min(100, Math.round((Number(row?.cur ?? 0) / tar) * 100));
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
     order by substr(due_at, 1, 10) asc, priority desc, id desc
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

  return {
    today,
    tasks,
    overdueCount,
    doneTodayCount,
    inboxCount: inboxOpenCount(),
    reviewDue,
    goals: goalRows.map((g) => ({ ...g, progress: goalProgress(g.id) })),
    recentNotes
  };
}
