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
import {
  buildExtractHtml,
  splitExtractionOutput,
  uniqueExtractTitle
} from '../shared/extract-doc';
import type {
  Attachment,
  CalendarEntry,
  Category,
  DashboardData,
  FocusKind,
  FocusSession,
  FocusSummary,
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
  TagDeleteResult,
  TagRenameResult,
  Task,
  TaskFilter,
  TaskPriority,
  TaskStatus
} from '../shared/types';
import { AI_MEMORY_SCHEMA, FOCUS_SCHEMA, GITHUB_SCHEMA, SCHEMA } from './schema';
import {
  AI_MEMORY_MAX_INJECT,
  AI_MEMORY_SETTING_KEY,
  sanitizeMemoryText,
  type AiMemoryEntry
} from '../shared/ai-memory';
import { runCleanGithubBugMigration } from './migrations/cleanGithubBug';
import type { RepoExtractMeta, RepoExtractStatus } from '../shared/github';

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

const SCHEMA_VERSION = 8;

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
  database.exec(FOCUS_SCHEMA);
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
  if (current < 5) {
    // v4 → v5：标签全局管理。表结构不用动（tag / note_tag 第一版就有），
    // 只补一个按标签反查的索引 —— 引用数统计和「点标签筛选」都靠它。
    database.exec('CREATE INDEX IF NOT EXISTS idx_note_tag_tag ON note_tag(tag_id)');
  }
  if (current < 6) {
    // v5 → v6：番茄钟专注计时。只加 focus_sessions 表和它的时间索引，
    // 已有表一列都不动；老用户升级后历史为空，从第一次点「开始专注」开始记。
    database.exec(FOCUS_SCHEMA);
  }
  if (current < 7) {
    // v6 → v7：GitHub Issues 单向同步。task 加两列（issue 唯一键 + issue 侧 updated_at，
    // 用来判断这行到底变没变），github_sync_meta 记每个仓库的增量游标（since）。
    addColumnIfMissing('task', 'github_issue_id', 'TEXT');
    addColumnIfMissing('task', 'github_updated_at', 'TEXT');
    // SQLite 的 ADD COLUMN 不能带 UNIQUE，改成「部分唯一索引」：老任务的 NULL 不参与唯一性。
    database.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_task_github_issue ON task(github_issue_id) WHERE github_issue_id IS NOT NULL'
    );
    database.exec(GITHUB_SCHEMA);
  }
  if (current < 8) {
    // v7 → v8：GitHub 集成从「Issues 同步成待办」改成「收集箱里搜集开源项目 + AI 提炼」。
    // 老表 github_sync_meta 与 task.github_issue_id 保留不动（老数据不丢，只是不再读写）；
    // 收集箱补 6 列：仓库名、链接、star、语言、提炼状态、提炼结果（JSON）。
    addColumnIfMissing('inbox_item', 'github_repo', 'TEXT');
    addColumnIfMissing('inbox_item', 'github_url', 'TEXT');
    addColumnIfMissing('inbox_item', 'github_stars', 'INTEGER');
    addColumnIfMissing('inbox_item', 'github_language', 'TEXT');
    addColumnIfMissing('inbox_item', 'extract_status', 'TEXT');
    addColumnIfMissing('inbox_item', 'extract_meta', 'TEXT');
  }
  // AI 长时记忆（0.12.2）：这张表不藏在 SCHEMA_VERSION 后面，每次打开都幂等补齐，
  // 这样 0.12.1 的老库和全新库走同一条路径；契约要求「Migration 兜底」——
  // 建表失败只打印日志，绝不能因为这张表把整个应用卡在启动阶段（白屏）。
  // 功能层（listAiMemory 等）也全部做了「表不在 = 静默降级为不注入」。
  try {
    database.exec(AI_MEMORY_SCHEMA);
  } catch (err) {
    console.error('[迁移] 创建 ai_memory 表失败（长时记忆本次不生效，不影响启动）：', err);
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
  // 数据清理（指令回显修复配套）：把 0.11.0 遗留的条目改判 ai_failed（自己兜 try/catch，不阻断启动）
  runCleanGithubBugMigration(db);
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

/**
 * 删除分类。
 * 优化项 7 的硬规矩：**分类下还有笔记（含子分类里的）就不许删**，
 * 直接给一句人话让用户先搬走或删掉，免得点一下就把一整类笔记变成「未分类」。
 * 空分类删掉时，子分类上提一级（不跟着一起没），作者是分类的 sort_order 邻位重排。
 */
export function deleteCategory(id: Id): void {
  const notes = one<{ n: number }>(
    `with recursive sub(cid) as (
       select ? as cid
       union all
       select c.id from category c join sub on c.parent_id = sub.cid where c.deleted_at is null
     )
     select count(*) as n from note
      where deleted_at is null and category_id in (select cid from sub)`,
    id
  );
  if (Number(notes?.n ?? 0) > 0) throw new Error('该分类下还有笔记，请先移动或删除笔记');
  const now = nowIso();
  const row = one<{ parent_id: Id | null }>('select parent_id from category where id = ?', id);
  const parentId = row?.parent_id ?? null;
  // 子分类上提一级，并排到新一层的最末尾（不跟原来那一层的旧邻居插队）
  const kids = all<{ id: Id }>(
    'select id from category where parent_id = ? and deleted_at is null order by sort_order, id',
    id
  );
  run('update category set deleted_at = ? where id = ?', now, id);
  if (kids.length) {
    const maxRow = one<{ m: number }>(
      'select coalesce(max(sort_order), 0) as m from category where parent_id is ? and deleted_at is null',
      parentId
    );
    let next = Number(maxRow?.m ?? 0);
    for (const kid of kids) {
      next += 1;
      run(
        'update category set parent_id = ?, sort_order = ?, updated_at = ? where id = ?',
        parentId,
        next,
        now,
        kid.id
      );
    }
  }
}

/** 分类排序：跟同一个父分类下的上/下一条换位，并把这一层重新编号（防止历史 sort_order 撞车）。 */
export function moveCategory(id: Id, dir: 'up' | 'down'): void {
  const row = one<{ parent_id: Id | null }>(
    'select parent_id from category where id = ? and deleted_at is null',
    id
  );
  if (!row) throw new Error('这个分类不在了');
  const siblings = all<{ id: Id }>(
    'select id from category where parent_id is ? and deleted_at is null order by sort_order, id',
    row.parent_id
  );
  const ids = siblings.map((s) => Number(s.id));
  const pos = ids.indexOf(Number(id));
  const target = dir === 'up' ? pos - 1 : pos + 1;
  if (pos < 0 || target < 0 || target >= ids.length) return;
  const tmp = ids[pos];
  ids[pos] = ids[target];
  ids[target] = tmp;
  const now = nowIso();
  ids.forEach((cid, i) => {
    run('update category set sort_order = ?, updated_at = ? where id = ?', i + 1, now, cid);
  });
}

/* ------------------------------------------------------------------ */
/* 笔记                                                                */
/* ------------------------------------------------------------------ */

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
  /**
   * 搜索用的纯文本正文；给了它就直接用（GitHub 笔记要把 YAML + Markdown 原文完整存下来，
   * 不能走 html→text 的抽取，否则 frontmatter 会丢）。
   */
  plain?: string;
}): Id {
  const now = nowIso();
  const title = input.title ?? '';
  const html =
    input.html != null ? sanitizeHtml(input.html) : markdownToHtmlSafe(input.content ?? '');
  const content =
    input.plain != null ? input.plain : input.html != null ? htmlToPlainText(html) : (input.content ?? '');
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

/**
 * AI「整理成重点文档」落库：把提炼结果新建成一篇笔记，整条链路一个事务。
 * 规则：标题取 AI 输出第一行（清洗 + 与现有标题去重，重名追加 " (2)"），
 * 继承原笔记的分类与标签，正文末尾追加溯源引用块；中途任何一步失败都回滚，
 * 绝不留下半篇笔记（SQLITE_BUSY 翻成中文提示，让用户稍后重试）。
 */
export function createExtractedNote(input: {
  sourceNoteId: Id;
  markdown: string;
}): Note & { tags: Tag[]; attachments: Attachment[] } {
  const source = getNote(input.sourceNoteId);
  if (!source) throw new Error('原笔记已经不在了，可能刚被删掉。');
  const sourceTitle = source.title || '未命名笔记';
  const parsed = splitExtractionOutput(input.markdown, sourceTitle);
  if (!parsed.body.trim()) {
    throw new Error('AI 没有返回可保存的正文，本次不会落库。');
  }
  const html = buildExtractHtml(parsed.body, sourceTitle);
  const tagNames = (source.tags ?? []).map((tag) => tag.name).filter(Boolean);
  const database = requireDb();
  let begun = false;
  try {
    // IMMEDIATE：先拿写锁再读标题列表，避免两个窗口同时保存时都以为标题没被占用。
    database.exec('BEGIN IMMEDIATE');
    begun = true;
    const titles = all<{ title: string }>('select title from note').map((row) => row.title);
    const title = uniqueExtractTitle(parsed.title, titles);
    const id = createNote({
      categoryId: source.category_id ?? null,
      title,
      html
    });
    if (tagNames.length) setNoteTags(id, tagNames);
    database.exec('COMMIT');
    begun = false;
    const created = getNote(id);
    if (!created) throw new Error('新笔记写入后没能读回来，请重试。');
    return created;
  } catch (err) {
    if (begun) {
      try {
        database.exec('ROLLBACK');
      } catch {
        // 事务可能已被 SQLite 自动回滚，忽略即可，保留原始错误
      }
    }
    if (/SQLITE_BUSY|database is locked/i.test(String(err))) {
      throw new Error('数据库正忙（可能有别的保存任务在跑），请稍后再试。');
    }
    throw err;
  }
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

/** 高级检索的过滤条件（0.12.0 阶段2）：标签走 tag.name 唯一索引，状态走 note 列。 */
export interface SearchNoteFilters {
  tags?: string[];
  pinned?: boolean;
  trash?: boolean;
}

/** 这些标签名里哪些真的存在（一次 IN 查询，走 tag.name 唯一索引）。 */
export function tagNamesIn(names: string[]): string[] {
  const clean = [...new Set(names.map((n) => String(n ?? '').trim()).filter(Boolean))].slice(0, 5);
  if (!clean.length) return [];
  const marks = clean.map(() => '?').join(', ');
  const rows = all<{ name: string }>(`select name from tag where name in (${marks})`, ...clean);
  return rows.map((r) => r.name);
}

/**
 * 高级检索：文字走 FTS5 MATCH（调用方保证已把 tag:/is: 语法剔掉），标签/状态走精准索引。
 * 只有过滤语（没有文字）时退回「置顶优先 + 更新时间」的数据查询，全程不拼 LIKE '%…%'。
 */
export function searchNotesAdvanced(query: string, limit = 30, filters: SearchNoteFilters = {}): SearchHit[] {
  const text = String(query ?? '').trim();
  const match = toMatchQuery(text);
  const tags = [...new Set((filters.tags ?? []).map((t) => String(t ?? '').trim()).filter(Boolean))].slice(0, 5);
  const lim = Math.min(Math.max(limit, 1), 200);

  const where: string[] = [];
  const args: unknown[] = [];
  where.push(filters.trash ? 'n.deleted_at is not null' : 'n.deleted_at is null');
  if (filters.pinned) where.push('n.is_pinned = 1');
  for (const tag of tags) {
    // exists 子查询：note_tag 主键以 note_id 打头，tag.name 有唯一索引，两层都是精准索引查找
    where.push(
      'exists (select 1 from note_tag nt join tag t on t.id = nt.tag_id where nt.note_id = n.id and t.name = ?)'
    );
    args.push(tag);
  }
  const whereSql = where.join(' and ');
  const columns = 'n.id, n.title, n.content, n.updated_at, c.name as category_name';
  const joins = 'from note n left join category c on c.id = n.category_id';

  const rows = match
    ? all<{ id: Id; title: string; content: string; updated_at: string; category_name: string | null }>(
        `select ${columns}
         from note_fts f
         join note n on n.id = f.rowid
         left join category c on c.id = n.category_id
         where note_fts match ? and ${whereSql}
         order by rank
         limit ?`,
        match,
        ...args,
        lim
      )
    : all<{ id: Id; title: string; content: string; updated_at: string; category_name: string | null }>(
        `select ${columns} ${joins} where ${whereSql} order by n.is_pinned desc, n.updated_at desc limit ?`,
        ...args,
        lim
      );

  return rows.map((r) => ({
    note_id: r.id,
    title: r.title || '(无标题)',
    category_name: r.category_name,
    snippet: snippetAround(r.content || r.title, text),
    updated_at: r.updated_at
  }));
}

/**
 * 相关笔记检索（0.12.0 阶段3）：关键词之间是 OR（只要沾上一个就有机会），
 * 但 SQL 里硬性 `and n.id != ?` —— 当前笔记永远不能出现在「相关笔记」里。
 * 关键词由调用方用 shared/backlinks 提取（已过滤停用词），这里只负责检索。
 */
export function searchRelatedNotes(noteId: Id, terms: string[], limit = 6): SearchHit[] {
  const clean = [...new Set(terms.map((t) => String(t ?? '').trim()).filter(Boolean))].slice(0, 10);
  if (!clean.length) return [];
  const match = clean.map((t) => `"${expandCjk(t).replace(/"/g, '""')}"`).join(' OR ');
  const lim = Math.min(Math.max(limit, 1), 20);
  const rows = all<{ id: Id; title: string; content: string; updated_at: string; category_name: string | null }>(
    `select n.id, n.title, n.content, n.updated_at, c.name as category_name
     from note_fts f
     join note n on n.id = f.rowid
     left join category c on c.id = n.category_id
     where note_fts match ? and n.deleted_at is null and n.id != ?
     order by rank
     limit ?`,
    match,
    noteId,
    lim
  );
  return rows.map((r) => ({
    note_id: r.id,
    title: r.title || '(无标题)',
    category_name: r.category_name,
    snippet: snippetAround(r.content || r.title, clean[0] ?? ''),
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

/** 引用数 = 未删除笔记里用了这个标签的篇数；回收站里的笔记不算。 */
const TAG_SELECT = `select t.id, t.name,
            (select count(*) from note_tag nt join note n on n.id = nt.note_id
              where nt.tag_id = t.id and n.deleted_at is null) as note_count
     from tag t`;

export function listTags(): Tag[] {
  return all<Tag>(`${TAG_SELECT} order by t.name`);
}

function tagById(id: Id): Tag | undefined {
  return one<Tag>(`${TAG_SELECT} where t.id = ?`, id);
}

/** 标签名最长 40 字，和分类名同一量级。 */
const TAG_NAME_MAX = 40;

/** 洗标签名：去首尾空白、把换行/制表压成空格、禁逗号（逗号在笔记里用来分隔多个标签）。 */
function cleanTagName(raw: string): string {
  const name = String(raw ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!name) throw new Error('标签名不能为空');
  if (name.length > TAG_NAME_MAX) throw new Error(`标签名最多 ${TAG_NAME_MAX} 个字符`);
  if (name.includes(',')) throw new Error('标签名里不能有逗号，「,」用来分隔多个标签');
  return name;
}

function countTagNotes(id: Id): number {
  const row = one<{ c: number }>('select count(*) as c from note_tag where tag_id = ?', id);
  return Number(row?.c ?? 0);
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

/**
 * 全局改标签名。撞名时自动合并（两条并一条）—— 与其报错让用户自己清理，
 * 不如合并后告诉他影响了多少篇。整个过程一个事务，中途出错整体回滚。
 */
export function renameTag(id: Id, rawName: string): TagRenameResult {
  const name = cleanTagName(rawName);
  const current = tagById(id);
  if (!current) throw new Error('这个标签已经不在了，刷新一下再试');
  const same = one<{ id: Id }>('select id from tag where name = ? and id <> ?', name, id);
  const affected = countTagNotes(id);
  const database = requireDb();
  database.exec('BEGIN');
  try {
    let merged = false;
    let afterId = id;
    if (same) {
      // 合并：把旧标签下的笔记改挂到目标标签上（note_tag 主键会自然去重），再删掉旧标签
      run(
        'insert or ignore into note_tag(note_id, tag_id) select note_id, ? from note_tag where tag_id = ?',
        same.id,
        id
      );
      run('delete from tag where id = ?', id);
      merged = true;
      afterId = same.id;
    } else {
      run('update tag set name = ? where id = ?', name, id);
    }
    const tag = tagById(afterId);
    if (!tag) throw new Error('标签改名后没能读回来');
    database.exec('COMMIT');
    return { tag, merged, affected };
  } catch (err) {
    database.exec('ROLLBACK');
    throw err;
  }
}

/** 删除标签：只拆「笔记 ↔ 标签」的关联，笔记本身一条不动。 */
export function deleteTagById(id: Id): TagDeleteResult {
  const current = tagById(id);
  if (!current) throw new Error('这个标签已经不在了，刷新一下再试');
  const affected = countTagNotes(id);
  const database = requireDb();
  database.exec('BEGIN');
  try {
    run('delete from note_tag where tag_id = ?', id);
    run('delete from tag where id = ?', id);
    database.exec('COMMIT');
    return { id, name: current.name, affected };
  } catch (err) {
    database.exec('ROLLBACK');
    throw err;
  }
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

/* ------------------------------------------------------------------ */
/* 第六版：番茄钟专注计时                                               */
/* ------------------------------------------------------------------ */

/** 进行中的计时器状态存在 meta 表里，重启应用能接着走。 */
const FOCUS_STATE_KEY = 'focus:current';

interface FocusRow {
  id: number;
  kind: string;
  task_id: number | null;
  started_at: string;
  ended_at: string | null;
  planned_seconds: number;
  actual_seconds: number;
  status: string;
}

function toFocusSession(row: FocusRow): FocusSession {
  return {
    id: row.id,
    kind: row.kind === 'break' ? 'break' : 'focus',
    status:
      row.status === 'done' || row.status === 'abandoned' || row.status === 'paused'
        ? row.status
        : 'running',
    taskId: row.task_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    plannedSeconds: Number(row.planned_seconds),
    actualSeconds: Number(row.actual_seconds)
  };
}

/** 开一条新会话（专注或休息），返回会话 id。 */
export function createFocusSession(input: {
  kind: FocusKind;
  taskId: Id | null;
  plannedSeconds: number;
  startedAt: string;
}): number {
  const res = run(
    `insert into focus_sessions (kind, task_id, started_at, planned_seconds, actual_seconds, status, created_at)
     values (?, ?, ?, ?, 0, 'running', ?)`,
    input.kind,
    input.taskId,
    input.startedAt,
    Math.max(0, Math.round(input.plannedSeconds)),
    new Date().toISOString()
  );
  return Number(res.lastInsertRowid);
}

/** 中途暂停/继续：只挪状态，不改计划时长。 */
export function setFocusSessionStatus(id: Id, status: 'running' | 'paused'): void {
  run('update focus_sessions set status = ? where id = ?', status, id);
}

/** 结束一条会话：done 正常做完，abandoned 中途放弃。 */
export function finishFocusSession(
  id: Id,
  input: { status: 'done' | 'abandoned'; actualSeconds: number; endedAt: string }
): void {
  run(
    'update focus_sessions set status = ?, actual_seconds = ?, ended_at = ? where id = ?',
    input.status,
    Math.max(0, Math.round(input.actualSeconds)),
    input.endedAt,
    id
  );
}

export function focusSessionById(id: Id): FocusSession | null {
  const row = one<FocusRow>('select * from focus_sessions where id = ?', id);
  return row ? toFocusSession(row) : null;
}

/**
 * 今日 / 本周统计。只算 kind='focus' 且 status='done' 的会话：
 * 休息不算专注时长，放弃的会话保留记录但不计入总时长。
 * started_at 统一存 ISO 字符串，字典序即时间序，所以直接用 >= 比。
 */
export function focusSummary(now = new Date()): FocusSummary {
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const mondayOffset = (startOfDay.getDay() + 6) % 7;
  const startOfWeek = new Date(
    startOfDay.getFullYear(),
    startOfDay.getMonth(),
    startOfDay.getDate() - mondayOffset
  );
  const rows = all<{ started_at: string; actual_seconds: number }>(
    `select started_at, actual_seconds from focus_sessions
     where kind = 'focus' and status = 'done' and started_at >= ?`,
    startOfWeek.toISOString()
  );
  const dayStart = startOfDay.toISOString();
  const summary: FocusSummary = { todayCount: 0, todaySeconds: 0, weekCount: 0, weekSeconds: 0 };
  for (const row of rows) {
    summary.weekCount += 1;
    summary.weekSeconds += Number(row.actual_seconds) || 0;
    if (row.started_at >= dayStart) {
      summary.todayCount += 1;
      summary.todaySeconds += Number(row.actual_seconds) || 0;
    }
  }
  return summary;
}

/** 把「现在进行中的计时器」写进 meta，重启后由主进程读回来接着走。 */
export function saveFocusState(json: string): void {
  setSetting(FOCUS_STATE_KEY, json);
}

export function loadFocusState(): string | null {
  return getSetting(FOCUS_STATE_KEY);
}

export function clearFocusState(): void {
  run('delete from meta where key = ?', FOCUS_STATE_KEY);
}

/**
 * 启动时收尾：上次异常退出留下的 running / paused 记录统一标成 abandoned，
 * 免得统计里出现永远走不完的会话。keepId 是这次要接上的那一条（可以为 null）。
 */
export function closeDanglingFocusSessions(keepId: Id | null, endedAt: string): void {
  if (keepId === null) {
    run(
      `update focus_sessions set status = 'abandoned', ended_at = ? where status in ('running', 'paused')`,
      endedAt
    );
    return;
  }
  run(
    `update focus_sessions set status = 'abandoned', ended_at = ? where status in ('running', 'paused') and id <> ?`,
    endedAt,
    keepId
  );
}
/* ------------------------------------------------------------------ */
/* GitHub 项目（收集箱）                                               */
/* ------------------------------------------------------------------ */

/** 收集箱单条（卡片重试提炼时用）。 */
export function inboxItem(id: Id): InboxItem | null {
  return one<InboxItem>('select * from inbox_item where id = ?', id) ?? null;
}

/** 新建一条 GitHub 项目收集箱条目（内容和元信息一起写进同一行）。 */
export function addGithubInbox(input: {
  content: string;
  repo: string;
  url: string;
  stars: number;
  language: string | null;
  status: RepoExtractStatus;
  meta: RepoExtractMeta;
}): Id {
  const now = nowIso();
  const r = run(
    `insert into inbox_item(content, kind, status, created_at, updated_at,
                          github_repo, github_url, github_stars, github_language, extract_status, extract_meta)
     values(?, 'github', 'open', ?, ?, ?, ?, ?, ?, ?, ?)`,
    input.content,
    now,
    now,
    input.repo,
    input.url,
    input.stars,
    input.language,
    input.status,
    JSON.stringify(input.meta)
  );
  return r.lastInsertRowid;
}

/** 重试提炼后回写内容 / 状态 / 元信息（不动 status 和 created_at）。 */
export function updateGithubInboxExtract(
  id: Id,
  input: { content: string; status: RepoExtractStatus; meta: RepoExtractMeta }
): void {
  run(
    `update inbox_item set content = ?, extract_status = ?, extract_meta = ?, updated_at = ? where id = ?`,
    input.content,
    input.status,
    JSON.stringify(input.meta),
    nowIso(),
    id
  );
}

/* ------------------------------------------------------------------ */
/* AI 长时记忆（0.12.2）                                               */
/* ------------------------------------------------------------------ */

/**
 * 表不在（迁移失败 / 老库异常）时返回 false，所有记忆读写都退化成空操作。
 * 契约一：记忆是非核心链路，任何异常都不能冒泡到润色/摘要主流程。
 */
function aiMemoryTableExists(): boolean {
  try {
    return (
      all<{ name: string }>(
        "select name from sqlite_master where type = 'table' and name = 'ai_memory'"
      ).length > 0
    );
  } catch {
    return false;
  }
}

/** 长时记忆总开关（meta 表，默认开启）。读失败按关闭处理，宁可不注入也不报错。 */
export function aiMemoryEnabled(): boolean {
  try {
    return (getSetting(AI_MEMORY_SETTING_KEY) ?? '1') !== '0';
  } catch {
    return false;
  }
}

export function setAiMemoryEnabled(enabled: boolean): void {
  setSetting(AI_MEMORY_SETTING_KEY, enabled ? '1' : '0');
}

/** 注入用：严格按 moduleTarget 过滤（契约三：领域隔离），最多 3 条。 */
export function listAiMemory(moduleTarget: string, limit = AI_MEMORY_MAX_INJECT): AiMemoryEntry[] {
  if (!aiMemoryTableExists()) return [];
  const target = String(moduleTarget ?? '').trim();
  if (!target) return [];
  const capped = Math.max(1, Math.min(AI_MEMORY_MAX_INJECT, Math.floor(limit) || AI_MEMORY_MAX_INJECT));
  return all<AiMemoryEntry>(
    'select * from ai_memory where module_target = ? order by updated_at desc, id desc limit ?',
    target,
    capped
  );
}

/** 设置页分页列表（按最近更新倒序）。 */
export function aiMemoryPage(page = 1, size = 5): { items: AiMemoryEntry[]; total: number } {
  if (!aiMemoryTableExists()) return { items: [], total: 0 };
  const total = Number(one<{ c: number }>('select count(*) as c from ai_memory')?.c ?? 0);
  const safeSize = Math.max(1, Math.min(20, Math.floor(size) || 5));
  const totalPages = Math.max(1, Math.ceil(total / safeSize));
  const safePage = Math.max(1, Math.min(totalPages, Math.floor(page) || 1));
  const items = all<AiMemoryEntry>(
    'select * from ai_memory order by updated_at desc, id desc limit ? offset ?',
    safeSize,
    (safePage - 1) * safeSize
  );
  return { items, total };
}

export function aiMemoryCount(): number {
  if (!aiMemoryTableExists()) return 0;
  return Number(one<{ c: number }>('select count(*) as c from ai_memory')?.c ?? 0);
}

/**
 * 批量写入提取到的偏好：先 sanitize（契约二：入库前剥特殊符号），
 * 同一场景同一句只留一条（唯一索引），重复命中只更新 updated_at / hit_count。
 * 返回真正新增的条数；0 表示全是重复命中。
 */
export function addAiMemory(moduleTarget: string, contents: string[]): number {
  if (!aiMemoryTableExists()) return 0;
  const target = String(moduleTarget ?? '').trim();
  if (!target || !Array.isArray(contents) || !contents.length) return 0;
  const now = nowIso();
  let added = 0;
  for (const item of contents) {
    const content = sanitizeMemoryText(item);
    if (!content) continue;
    const existed = one<{ id: Id }>(
      'select id from ai_memory where module_target = ? and content = ?',
      target,
      content
    );
    if (existed) {
      run('update ai_memory set hit_count = hit_count + 1, updated_at = ? where id = ?', now, existed.id);
      continue;
    }
    run(
      'insert into ai_memory(module_target, content, hit_count, created_at, updated_at) values(?, ?, 1, ?, ?)',
      target,
      content,
      now,
      now
    );
    added += 1;
  }
  // 每个场景只留最近 20 条：注入永远只有 3 条，旧的不清只会越攒越多。
  run(
    `delete from ai_memory where module_target = ? and id not in (
       select id from ai_memory where module_target = ? order by updated_at desc, id desc limit 20
     )`,
    target,
    target
  );
  return added;
}

export function deleteAiMemory(id: Id): boolean {
  if (!aiMemoryTableExists()) return false;
  return run('delete from ai_memory where id = ?', id).changes > 0;
}

export function clearAiMemory(): number {
  if (!aiMemoryTableExists()) return 0;
  const database = requireDb();
  database.exec('BEGIN');
  try {
    const changes = run('delete from ai_memory').changes;
    database.exec('COMMIT');
    return changes;
  } catch (err) {
    database.exec('ROLLBACK');
    throw err;
  }
}
