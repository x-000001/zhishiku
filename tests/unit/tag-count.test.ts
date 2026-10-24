import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as db from '../../src/main/db';
import { ensureDirs, type DataPaths } from '../../src/main/paths';

let root = '';
let paths: DataPaths;

function resetData(): void {
  const raw = db.getRawDb();
  raw.exec('PRAGMA foreign_keys = OFF');
  for (const t of ['note_tag', 'note_version', 'attachment', 'note', 'tag']) {
    raw.exec(`delete from ${t}`);
  }
  raw.exec('delete from note_fts');
  raw.exec('PRAGMA foreign_keys = ON');
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'jwkb-tag-count-'));
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
  resetData();
});

/** 从实时列表里取某个标签的引用数（等于用户在左侧标签管理里看到的数字）。 */
function tagCount(name: string): number {
  return db.listTags().find((t) => t.name === name)?.note_count ?? 0;
}

describe('标签数量：实时 COUNT + 软删除/还原', () => {
  it('移到回收站后数量减一，还原后回到原值', () => {
    const id = db.createNote({ title: '标签计数自检', content: '间隔重复与主动回忆' });
    db.setNoteTags(id, ['学习']);
    expect(tagCount('学习')).toBe(1);

    db.trashNote(id);
    expect(tagCount('学习')).toBe(0);

    db.restoreNote(id);
    expect(tagCount('学习')).toBe(1);
  });

  it('反复删除 + 还原时数量始终在 0/1 之间，绝不为负', () => {
    const id = db.createNote({ title: '并发自检', content: '手速很快地删了又还原' });
    db.setNoteTags(id, ['并发标签']);

    for (let i = 0; i < 40; i += 1) {
      db.trashNote(id);
      expect(tagCount('并发标签')).toBe(0);
      db.restoreNote(id);
      expect(tagCount('并发标签')).toBe(1);
    }

    // 收尾：所有标签的实时数量都不允许是负数
    db.trashNote(id);
    expect(Math.min(...db.listTags().map((t) => t.note_count ?? 0))).toBeGreaterThanOrEqual(0);
    expect(tagCount('并发标签')).toBe(0);
  });

  it('标签被彻底删掉后再还原笔记：静默跳过、不因为外键报错', () => {
    const id = db.createNote({ title: '标签先没了', content: '先删标签再还原笔记' });
    db.setNoteTags(id, ['会被删掉的标签']);
    db.trashNote(id);

    const tag = db.listTags().find((t) => t.name === '会被删掉的标签')!;
    db.deleteTagById(tag.id);

    expect(() => db.restoreNote(id)).not.toThrow();
    expect(db.getNote(id)?.tags).toEqual([]);
  });
});

describe('硬删除：note_tag 与 FTS5 一起清理', () => {
  it('彻底删除后搜不到该笔记、FTS 和标签关联都不留幽灵', () => {
    const id = db.createNote({ title: '幽灵笔记', content: '配置 WAL 的完整说明' });
    db.setNoteTags(id, ['幽灵标签']);
    expect(db.searchNotes('幽灵').length).toBe(1);

    db.trashNote(id);
    db.purgeNote(id);

    expect(db.searchNotes('幽灵')).toEqual([]);
    const raw = db.getRawDb();
    const fts = raw.prepare('select count(*) as c from note_fts').get() as { c: number };
    const links = raw.prepare('select count(*) as c from note_tag').get() as { c: number };
    expect(Number(fts.c)).toBe(0);
    expect(Number(links.c)).toBe(0);
    // 标签本身还在（只是没人用了），数量是 0 而不是负数
    expect(tagCount('幽灵标签')).toBe(0);
  });

  it('清空回收站：一次事务里批量硬删，标签数量全部归零且搜索为 0', () => {
    const a = db.createNote({ title: '批量清理甲', content: '幽灵甲' });
    const b = db.createNote({ title: '批量清理乙', content: '幽灵乙' });
    db.setNoteTags(a, ['清理标签']);
    db.setNoteTags(b, ['清理标签']);
    expect(tagCount('清理标签')).toBe(2);

    db.trashNote(a);
    db.trashNote(b);
    expect(tagCount('清理标签')).toBe(0);

    expect(db.emptyTrash()).toBe(2);
    expect(db.searchNotes('幽灵')).toEqual([]);
    expect(tagCount('清理标签')).toBe(0);
  });
});

describe('SQLITE_BUSY：最多重试 3 次、每次 50ms', () => {
  it('前两次「database is locked」后第三次成功', () => {
    let attempts = 0;
    const start = Date.now();
    const result = db.withBusyRetry(() => {
      attempts += 1;
      if (attempts < 3) throw new Error('database is locked');
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(attempts).toBe(3);
    // 两次退避 ≈ 100ms（时间断言放松到 90ms，避免 CI 抖动）
    expect(Date.now() - start).toBeGreaterThanOrEqual(90);
  });

  it('非 BUSY 错误立即抛出，不做无意义重试', () => {
    let attempts = 0;
    expect(() =>
      db.withBusyRetry(() => {
        attempts += 1;
        throw new Error('不认识的错误');
      })
    ).toThrow('不认识的错误');
    expect(attempts).toBe(1);
  });

  it('一直 BUSY 时最多尝试 3 次就放弃，不无限卡死', () => {
    let attempts = 0;
    expect(() =>
      db.withBusyRetry(() => {
        attempts += 1;
        throw new Error('SQLITE_BUSY: database is locked');
      })
    ).toThrow(/SQLITE_BUSY/);
    expect(attempts).toBe(3);
  });
});

describe('开机一次性校准（meta 记版本）', () => {
  it('清理幽灵 note_tag / FTS 行，且只执行一次', () => {
    const id = db.createNote({ title: '校准自检', content: '正常笔记' });
    db.setNoteTags(id, ['校准标签']);
    const raw = db.getRawDb();
    const tag = raw.prepare('select id from tag limit 1').get() as { id: number };

    // 模拟老库遗留：外键关闭时插过指向不存在笔记的关联与 FTS 行
    raw.exec("delete from meta where key like 'tag.count.recalibrated%'");
    raw.exec('PRAGMA foreign_keys = OFF');
    raw.prepare('insert into note_tag(note_id, tag_id) values(999999, ?)').run(tag.id);
    raw.exec('PRAGMA foreign_keys = ON');
    raw.prepare("insert into note_fts(rowid, title, content) values(999999, '幽灵', '幽灵')").run();

    expect(db.recalibrateTagCountsOnce()).toBeGreaterThanOrEqual(2);
    // 第二次调用被 meta 版本拦住
    expect(db.recalibrateTagCountsOnce()).toBe(0);

    const links = raw.prepare('select count(*) as c from note_tag where note_id = 999999').get() as { c: number };
    const fts = raw.prepare('select count(*) as c from note_fts where rowid = 999999').get() as { c: number };
    expect(Number(links.c)).toBe(0);
    expect(Number(fts.c)).toBe(0);
    // 正常数据不受影响
    expect(tagCount('校准标签')).toBe(1);
  });
});
