/* ------------------------------------------------------------------ */
/* 建表 SQL                                                            */
/*                                                                     */
/* 全部是幂等的 CREATE ... IF NOT EXISTS，每次打开库都跑一遍也不会坏。   */
/* 单独放一个文件，是因为它有 200 多行，混在 db.ts 里会把真正的代码挤没。  */
/* 改表结构时：这里是「新库直接建成这样」，老库的升级仍走 db.ts 的迁移。  */
/* ------------------------------------------------------------------ */

export const SCHEMA = `
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
-- 第六版（标签全局管理）：按标签反查笔记、算引用数都走这个索引
CREATE INDEX IF NOT EXISTS idx_note_tag_tag ON note_tag(tag_id);

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

/**
 * 第六版（番茄钟）：专注/休息会话表。
 * 单独抽出来，是因为「新库建表」和「老库 v5 → v6 迁移」要用同一段 SQL，
 * 复制两份迟早会漂移。
 */
export const FOCUS_SCHEMA = `
CREATE TABLE IF NOT EXISTS focus_sessions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  kind            TEXT NOT NULL DEFAULT 'focus',
  task_id         INTEGER REFERENCES task(id) ON DELETE SET NULL,
  started_at      TEXT NOT NULL,
  ended_at        TEXT,
  planned_seconds INTEGER NOT NULL,
  actual_seconds  INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_focus_started ON focus_sessions(started_at DESC);
`;


/**
 * 第七版留下的表：每个仓库的增量游标（last_synced_at / last_error）。
 * 0.11.0 起「Issues 同步成待办」被换成「收集箱搜集项目 + AI 提炼」，这张表不再读写；
 * 之所以不删，是为了老库升级时不动用户已有数据（迁移链里只建不写）。
 */
export const GITHUB_SCHEMA = `
CREATE TABLE IF NOT EXISTS github_sync_meta (
  repo           TEXT PRIMARY KEY,
  last_synced_at TEXT,
  last_error     TEXT
);
`;