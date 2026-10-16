import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as backup from '../../src/main/backup';
import * as db from '../../src/main/db';
import { ensureDirs, type DataPaths } from '../../src/main/paths';

let root = '';
let paths: DataPaths;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'jwkb-backup-'));
  paths = ensureDirs(root);
  db.openDatabase(paths);
});

afterAll(() => {
  try {
    db.closeDatabase();
  } catch {
    /* 已关闭 */
  }
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  for (const dir of fs.readdirSync(paths.backups)) {
    fs.rmSync(path.join(paths.backups, dir), { recursive: true, force: true });
  }
  db.getRawDb().exec('delete from note_fts; delete from note; delete from task');
  db.setSetting('lastBackupDate', '');
});

describe('备份与恢复', () => {
  it('手动备份会生成一个带时间的快照目录，里面有 kb.db', () => {
    db.createNote({ title: '备份前的笔记', content: '内容' });
    const entry = backup.runBackup(paths, true);
    expect(entry.name.startsWith('手动_')).toBe(true);
    const snapshot = path.join(paths.backups, entry.name, 'kb.db');
    expect(fs.existsSync(snapshot)).toBe(true);
    expect(fs.statSync(snapshot).size).toBeGreaterThan(0);
  });

  it('快照是完整可用的数据库：能独立打开并读到数据', () => {
    db.createNote({ title: '快照里的笔记', content: '内容' });
    const entry = backup.runBackup(paths, true);
    const snapshot = path.join(paths.backups, entry.name, 'kb.db');
    const raw = new DatabaseSync(snapshot, { readOnly: true });
    const row = raw.prepare('select count(*) as c from note').get() as { c: number };
    expect(Number(row.c)).toBe(1);
    raw.close();
  });

  it('备份列表按时间倒序，最新的排最前', () => {
    db.createNote({ title: 'a' });
    const first = backup.runBackup(paths, true);
    const second = backup.runBackup(paths, true);
    const list = backup.listBackups(paths);
    expect(list.length).toBe(2);
    expect([first.name, second.name]).toContain(list[0].name);
    expect(list[0].size).toBeGreaterThan(0);
  });

  it('每天只自动备份一次', () => {
    db.createNote({ title: 'a' });
    const first = backup.maybeDailyBackup(paths);
    expect(first).not.toBeNull();
    const second = backup.maybeDailyBackup(paths);
    expect(second).toBeNull();
  });

  it('恢复前会先把当前数据另存一份，恢复后数据回到快照那一刻', () => {
    db.createNote({ title: '恢复点之前就有的', content: 'x' });
    const entry = backup.runBackup(paths, true);
    // 快照之后又写了一篇
    db.createNote({ title: '快照之后写的', content: 'y' });
    expect(db.listNotes()).toHaveLength(2);

    const res = backup.restoreBackup(paths, entry.name);
    expect(res.preRestore.startsWith('恢复前_')).toBe(true);
    expect(fs.existsSync(path.join(paths.backups, res.preRestore, 'kb.db'))).toBe(true);

    const titles = db.listNotes().map((n) => n.title);
    expect(titles).toContain('恢复点之前就有的');
    expect(titles).not.toContain('快照之后写的');
  });

  it('恢复「恢复前」那一份能把数据再倒回来（恢复也能反悔）', () => {
    db.createNote({ title: '原本的', content: 'x' });
    const entry = backup.runBackup(paths, true);
    db.createNote({ title: '后来加的', content: 'y' });
    const res = backup.restoreBackup(paths, entry.name);
    backup.restoreBackup(paths, res.preRestore);
    expect(db.listNotes().map((n) => n.title)).toContain('后来加的');
  });

  it('删备份会把目录删掉，删不存在的备份不报错', () => {
    db.createNote({ title: 'a' });
    const entry = backup.runBackup(paths, true);
    backup.deleteBackup(paths, entry.name);
    expect(fs.existsSync(path.join(paths.backups, entry.name))).toBe(false);
    expect(() => backup.deleteBackup(paths, '压根不存在的备份')).not.toThrow();
  });

  it('目录名里带 .. 之类的路径穿越会被挡住', () => {
    const outside = path.join(root, '不该被删的');
    fs.mkdirSync(outside, { recursive: true });
    expect(() => backup.deleteBackup(paths, '..\\不该被删的')).toThrow();
    expect(fs.existsSync(outside)).toBe(true);
  });

  it('保留最近 7 份：连着做 9 次每日备份，最后只剩 7 份', () => {
    db.createNote({ title: 'a' });
    for (let i = 0; i < 9; i += 1) {
      db.setSetting('lastBackupDate', ''); // 假装又过了一天
      const entry = backup.maybeDailyBackup(paths);
      expect(entry).not.toBeNull();
    }
    const daily = backup.listBackups(paths).filter((b) => b.kind === 'daily');
    expect(daily).toHaveLength(7);
  });

  it('同一秒里连着备份两次不会互相覆盖', () => {
    db.createNote({ title: 'a' });
    const first = backup.runBackup(paths, true);
    const second = backup.runBackup(paths, true);
    expect(second.name).not.toBe(first.name);
    expect(fs.existsSync(path.join(paths.backups, first.name, 'kb.db'))).toBe(true);
    expect(fs.existsSync(path.join(paths.backups, second.name, 'kb.db'))).toBe(true);
  });

  it('数据库完整性检查在恢复之后仍然是 ok', () => {
    db.createNote({ title: 'a' });
    const entry = backup.runBackup(paths, true);
    backup.restoreBackup(paths, entry.name);
    expect(db.integrityCheck()).toBe('ok');
  });
});
