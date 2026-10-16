// 探测 Electron 内置 Node 与 node:sqlite 的能力
console.log('NODE', process.versions.node, '| ELECTRON', process.versions.electron, '| V8', process.versions.v8);
try {
  const s = require('node:sqlite');
  console.log('NODE_SQLITE_OK', Object.keys(s).join(','));
  const db = new s.DatabaseSync(':memory:');
  console.log('SQLITE_VERSION', db.prepare('select sqlite_version() as v').get().v);
  try {
    db.exec("create virtual table t using fts5(a, tokenize='trigram')");
    console.log('FTS5_TRIGRAM_OK');
  } catch (e) {
    console.log('FTS5_TRIGRAM_FAIL', e.message);
  }
  try {
    console.log('WAL', JSON.stringify(db.prepare('pragma journal_mode=wal').get()));
  } catch (e) {
    console.log('WAL_FAIL', e.message);
  }
} catch (e) {
  console.log('NODE_SQLITE_FAIL', e.message);
}
