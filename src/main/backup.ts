import fs from 'node:fs';
import path from 'node:path';
import { closeDatabase, getRawDb, getSetting, openDatabase, setSetting } from './db';
import { isoLocal, stampLocal, todayLocal, type DataPaths } from './paths';
import type { BackupEntry } from '../shared/types';

const KEEP_DAILY = 7;

function dirSize(dir: string): number {
  let total = 0;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) total += dirSize(p);
      else total += fs.statSync(p).size;
    }
  } catch {
    // 读不到的目录按 0 计
  }
  return total;
}

function kindOf(name: string): BackupEntry['kind'] {
  if (name.startsWith('恢复前_')) return 'pre-restore';
  if (name.startsWith('手动_')) return 'manual';
  return 'daily';
}

export function listBackups(paths: DataPaths): BackupEntry[] {
  if (!fs.existsSync(paths.backups)) return [];
  const entries: BackupEntry[] = [];
  for (const entry of fs.readdirSync(paths.backups, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(paths.backups, entry.name);
    const dbFile = path.join(dir, 'kb.db');
    if (!fs.existsSync(dbFile)) continue;
    entries.push({
      name: entry.name,
      path: dir,
      created_at: fs.statSync(dir).mtime.toISOString(),
      size: dirSize(dir),
      kind: kindOf(entry.name)
    });
  }
  return entries.sort((a, b) => (a.name < b.name ? 1 : -1));
}

function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

/** 用 VACUUM INTO 生成一份一致的数据库快照（比直接拷文件安全，WAL 里的内容也会进去）。 */
export function runBackup(paths: DataPaths, manual = false, prefix = ''): BackupEntry {
  const base = `${prefix}${manual ? '手动_' : ''}${stampLocal()}`;
  // 目录名只到秒。同一秒里连着备份两次（比如「每日自动 + 手动立刻再来一次」）
  // 时加个序号，避免后一次把前一次覆盖掉。
  let name = base;
  let i = 1;
  while (fs.existsSync(path.join(paths.backups, name, 'kb.db'))) {
    i += 1;
    name = `${base}_${i}`;
  }
  const dir = path.join(paths.backups, name);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, 'kb.db');
  if (fs.existsSync(target)) fs.rmSync(target, { force: true });

  // VACUUM INTO 通过主库连接执行，不需要额外打开文件
  getRawDb().exec(`VACUUM INTO '${escapeSqlLiteral(target)}'`);

  const entry: BackupEntry = {
    name,
    path: dir,
    created_at: isoLocal(),
    size: fs.statSync(target).size,
    kind: prefix ? 'pre-restore' : manual ? 'manual' : 'daily'
  };
  return entry;
}

function trimDaily(paths: DataPaths): void {
  const backups = listBackups(paths);
  const daily = backups.filter((b) => b.kind === 'daily');
  for (const old of daily.slice(KEEP_DAILY)) {
    try {
      fs.rmSync(old.path, { recursive: true, force: true });
    } catch {
      // 删不掉旧备份不影响本次备份
    }
  }
}

/** 每天第一次启动时自动备份一次。 */
export function maybeDailyBackup(paths: DataPaths): BackupEntry | null {
  const today = todayLocal();
  if (getSetting('lastBackupDate') === today) return null;
  try {
    const entry = runBackup(paths, false);
    setSetting('lastBackupDate', today);
    trimDaily(paths);
    return entry;
  } catch (err) {
    console.error('[备份] 每日自动备份失败：', err);
    return null;
  }
}

/**
 * 从备份恢复。恢复前先把「当前数据」另存一份，避免误点恢复把现有内容弄丢。
 */
export function restoreBackup(paths: DataPaths, backupName: string): { preRestore: string } {
  const backupDir = path.join(paths.backups, backupName);
  const backupDb = path.join(backupDir, 'kb.db');
  if (!fs.existsSync(backupDb)) throw new Error(`备份不存在：${backupName}`);

  let preRestore = '';
  try {
    // 直接以「恢复前_」为前缀做快照，不再生成完再改名：
    // Windows 上对刚写完的目录做 rename 可能报 EPERM，而这一步是数据安全网，不能靠运气。
    const snapshot = runBackup(paths, false, '恢复前_');
    preRestore = snapshot.name;
  } catch (err) {
    console.error('[备份] 恢复前的当前数据快照失败：', err);
  }

  closeDatabase();
  for (const suffix of ['', '-wal', '-shm']) {
    const f = `${paths.db}${suffix}`;
    if (fs.existsSync(f)) fs.rmSync(f, { force: true });
  }
  fs.copyFileSync(backupDb, paths.db);
  openDatabase(paths);
  return { preRestore };
}

export function deleteBackup(paths: DataPaths, backupName: string): void {
  // 只允许删「备份目录下的直接子目录」：名字里带路径分隔符、或解析后跑到别处，一律拒绝。
  if (!backupName || backupName.includes('/') || backupName.includes('\\') || backupName.startsWith('..')) {
    throw new Error('备份路径不合法');
  }
  const root = path.resolve(paths.backups);
  const resolved = path.resolve(root, backupName);
  if (path.dirname(resolved) !== root) {
    throw new Error('备份路径不合法');
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}
