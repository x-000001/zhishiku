import { describe, expect, it } from 'vitest';
import { describeSaveError, saveStamp } from '../../src/renderer/src/save';

describe('手动保存：失败分诊（优化项 8）', () => {
  it('被别的程序占着 → 让用户关掉记事本/编辑器', () => {
    expect(describeSaveError(new Error('SQLITE_BUSY: database is locked'))).toBe(
      '数据文件被其他软件占用，请关闭记事本/编辑器后再试'
    );
    expect(describeSaveError(new Error('EBUSY: resource busy or locked'))).toBe(
      '数据文件被其他软件占用，请关闭记事本/编辑器后再试'
    );
  });

  it('权限不足 → 提示检查 D 盘文件夹权限', () => {
    expect(describeSaveError(new Error('EACCES: permission denied, open D:\\Jw知识库\\kb.db'))).toBe(
      '无法写入 D 盘，请检查文件夹权限'
    );
    expect(describeSaveError(new Error('SQLITE_READONLY: attempt to write a readonly database'))).toBe(
      '无法写入 D 盘，请检查文件夹权限'
    );
  });

  it('磁盘满了 → 提示腾空间', () => {
    expect(describeSaveError(new Error('SQLITE_FULL: database or disk is full'))).toBe(
      'D 盘空间不够了，腾出空间再保存'
    );
  });

  it('库文件坏了 → 指路数据库自检', () => {
    expect(describeSaveError(new Error('SQLITE_CORRUPT: database disk image is malformed'))).toBe(
      '数据文件读不出来了，去设置页跑一次数据库自检'
    );
  });

  it('其它错误原样说出来，不吞掉原因', () => {
    expect(describeSaveError(new Error('奇怪的问题'))).toBe('保存失败：奇怪的问题');
    expect(describeSaveError(undefined)).toBe('保存失败：原因不明');
    expect(describeSaveError('字符串也能兜住')).toBe('保存失败：字符串也能兜住');
  });

  it('同时沾边时先说「被占用」（用户最先要做的事）', () => {
    expect(describeSaveError(new Error('EACCES while SQLITE_BUSY'))).toContain('占用');
  });
});

describe('手动保存：时间戳', () => {
  it('补零成 HH:MM:SS', () => {
    expect(saveStamp(new Date(2026, 9, 16, 9, 5, 3))).toBe('09:05:03');
    expect(saveStamp(new Date(2026, 9, 16, 14, 3, 22))).toBe('14:03:22');
    expect(saveStamp(new Date(2026, 9, 16, 0, 0, 0))).toBe('00:00:00');
  });
});
