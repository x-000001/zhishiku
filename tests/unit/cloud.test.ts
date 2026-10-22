import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { takeSnapshot, escapeSqlLiteral } from '../../src/main/snapshot';
import {
  CLOUD_WEBDAV_TIMEOUT_MS,
  RESTORE_CONFIRM_WORD,
  attachmentCloudName,
  backupStamp,
  canConfirmRestore,
  describeCloudError,
  joinWebdavUrl,
  normalizeWebdavUrl,
  sanitizeAttachmentPath
} from '../../src/shared/cloud';

/* 云端灾备（0.12.0 阶段5）：截止符/路径消毒、高危确认、错误翻译、VACUUM INTO 快照。 */

describe('WebDAV 地址与路径', () => {
  it('地址规范化：去空白、补结尾斜杠、拒绝非 http(s)', () => {
    expect(normalizeWebdavUrl(' https://dav.example.com/a ')).toBe('https://dav.example.com/a/');
    expect(normalizeWebdavUrl('https://dav.example.com/a/')).toBe('https://dav.example.com/a/');
    expect(normalizeWebdavUrl('')).toBe('');
    expect(() => normalizeWebdavUrl('ftp://x')).toThrow(/只支持 http/);
    expect(() => normalizeWebdavUrl('随便写的')).toThrow(/格式不对/);
  });

  it('拼子路径时每段 encode，且不会出现双斜杠', () => {
    expect(joinWebdavUrl('https://d.com/dav/', 'jwkb-backup', 'kb.db')).toBe('https://d.com/dav/jwkb-backup/kb.db');
    expect(joinWebdavUrl('https://d.com/dav', '', '/kb.db/')).toBe('https://d.com/dav/kb.db');
  });

  it('附件路径拒绝 .. 和绝对路径，扁平化后不含斜杠', () => {
    expect(sanitizeAttachmentPath('a/b.png')).toBe('a/b.png');
    expect(sanitizeAttachmentPath('\\a\\b.png')).toBe('a/b.png');
    expect(() => sanitizeAttachmentPath('../etc/passwd')).toThrow(/不合法/);
    expect(sanitizeAttachmentPath('/abs.png')).toBe('abs.png');
    expect(attachmentCloudName('a/b 图.png')).not.toContain('/');
  });
});

describe('高危恢复闸门', () => {
  it('必须输入 CONFIRM（区分大小写）或勾选确认', () => {
    expect(canConfirmRestore({ typed: 'CONFIRM', checked: false })).toBe(true);
    expect(canConfirmRestore({ typed: ' CONFIRM ', checked: false })).toBe(true);
    expect(canConfirmRestore({ typed: 'confirm', checked: false })).toBe(false);
    expect(canConfirmRestore({ typed: '', checked: true })).toBe(true);
    expect(canConfirmRestore({ typed: 'WRONG', checked: false })).toBe(false);
    expect(canConfirmRestore(null)).toBe(false);
    expect(RESTORE_CONFIRM_WORD).toBe('CONFIRM');
  });

  it('超时是 30 秒（红线）', () => {
    expect(CLOUD_WEBDAV_TIMEOUT_MS).toBe(30000);
  });
});

describe('错误翻译', () => {
  it('SQLITE_BUSY → 中文「数据库正忙」提示', () => {
    expect(describeCloudError(new Error('SQLITE_BUSY: database is locked'))).toContain('数据库正忙');
    expect(describeCloudError(new Error('database is locked'))).toContain('数据库正忙');
  });

  it('磁盘满 / 超时 / 其它错误都有可读文案', () => {
    expect(describeCloudError(new Error('SQLITE_FULL'))).toContain('磁盘空间');
    expect(describeCloudError(new Error('AbortError: timeout'))).toContain('30 秒');
    expect(describeCloudError(new Error('HTTP 500'))).toContain('HTTP 500');
    expect(describeCloudError(undefined)).toContain('失败');
  });

  it('备份文件名时间戳可排序', () => {
    const a = backupStamp(Date.UTC(2026, 0, 2, 3, 4));
    const b = backupStamp(Date.UTC(2026, 0, 2, 3, 5));
    expect(a).toBe('2026-01-02-0304');
    expect(a < b).toBe(true);
  });
});

describe('VACUUM INTO 快照', () => {
  let dir = '';

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jwkb-snapshot-'));
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('生成成功时返回文件大小，SQL 里单引号被转义', () => {
    const target = path.join(dir, "it's.db");
    const sqls: string[] = [];
    const size = takeSnapshot((sql) => {
      sqls.push(sql);
      fs.writeFileSync(target, Buffer.alloc(32, 1));
    }, target);
    expect(size).toBe(32);
    expect(sqls[0]).toContain("VACUUM INTO '");
    expect(sqls[0]).toContain("''");
  });

  it('SQLITE_BUSY 变成中文可读错误，而不是原始英文', () => {
    const target = path.join(dir, 'busy.db');
    expect(() =>
      takeSnapshot(() => {
        throw new Error('SQLITE_BUSY: database is locked');
      }, target)
    ).toThrow(/数据库正忙/);
  });

  it('exec 没报错但文件没生成时也给明确错误', () => {
    const target = path.join(dir, 'missing.db');
    expect(() => takeSnapshot(() => undefined, target)).toThrow(/快照没生成/);
  });

  it('SQL 字面量转义可单测', () => {
    expect(escapeSqlLiteral("a'b")).toBe("a''b");
  });
});
