// 只读探针：看某个 kb.db 的 schema 版本、表、各表行数（用 Node 内置 node:sqlite）
const { DatabaseSync } = require('node:sqlite');
const p = process.argv[2];
const db = new DatabaseSync(p, { readOnly: true });
const uv = db.prepare('pragma user_version').get().user_version;
const tables = db
  .prepare("select name from sqlite_master where type='table' order by name")
  .all()
  .map((r) => r.name);
const counts = {};
for (const t of [
  'note',
  'task',
  'inbox_item',
  'tag',
  'attachment',
  'goal',
  'goal_key_result',
  'goal_pool',
  'plan',
  'plan_item',
  'review_card',
  'milestone',
  'review_log',
  'retrospective'
]) {
  try {
    counts[t] = db.prepare(`select count(*) c from ${t}`).get().c;
  } catch {
    counts[t] = 'NO_TABLE';
  }
}
const cols = (t) => {
  try {
    return db
      .prepare(`pragma table_info(${t})`)
      .all()
      .map((r) => r.name);
  } catch {
    return [];
  }
};
console.log(
  JSON.stringify(
    { user_version: uv, tables, counts, task_cols: cols('task'), pool_cols: cols('goal_pool') },
    null,
    1
  )
);
db.close();
