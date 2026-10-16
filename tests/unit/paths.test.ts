import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_DATA_ROOT,
  attachmentDirFor,
  ensureDirs,
  isoLocal,
  readLocator,
  resolveDataRoot,
  stampLocal,
  todayLocal,
  writeLocator
} from '../../src/main/paths';

describe('本地日期与时间戳', () => {
  it('todayLocal 输出 YYYY-MM-DD，并且用本地时区而不是 UTC', () => {
    // 本地时间 2026-01-01 00:30，在 UTC+8 下 UTC 还是 2025-12-31，必须取本地那天
    const d = new Date(2026, 0, 1, 0, 30, 0);
    expect(todayLocal(d)).toBe('2026-01-01');
  });

  it('todayLocal 会补零', () => {
    expect(todayLocal(new Date(2026, 8, 9, 12, 0, 0))).toBe('2026-09-09');
  });

  it('stampLocal 输出 YYYY-MM-DD_HHmmss', () => {
    expect(stampLocal(new Date(2026, 9, 16, 11, 4, 6))).toBe('2026-10-16_110406');
  });

  it('isoLocal 带本地时区偏移，可以直接和数据库里的字符串比较', () => {
    const iso = isoLocal(new Date(2026, 9, 16, 11, 4, 6, 123));
    expect(iso.startsWith('2026-10-16T11:04:06.123')).toBe(true);
    expect(iso).toMatch(/[+-]\d{2}:\d{2}$/);
    // 同一台机器上先后取的两个时间戳，字符串顺序要等于时间顺序
    const later = isoLocal(new Date(2026, 9, 16, 11, 4, 7, 0));
    expect(later > iso).toBe(true);
  });
});

describe('附件目录', () => {
  it('按年月分文件夹，并且会自动建出来', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jwkb-att-'));
    const dir = attachmentDirFor(root, new Date(2026, 9, 16));
    expect(path.basename(dir)).toBe('2026-10');
    expect(fs.existsSync(dir)).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('数据目录解析', () => {
  const oldEnv = process.env.JWKB_DATA_DIR;

  it('默认位置是 D 盘的 Jw知识库', () => {
    expect(DEFAULT_DATA_ROOT).toBe('D:\\Jw知识库');
  });

  it('环境变量优先，并且会被解析成绝对路径', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jwkb-env-'));
    process.env.JWKB_DATA_DIR = dir;
    const res = resolveDataRoot();
    expect(res.root).toBe(path.resolve(dir));
    expect(res.fallback).toBe(false);
    process.env.JWKB_DATA_DIR = oldEnv;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('环境变量指向不可写的位置时不会卡死，会继续往下退', () => {
    // 用一个「占位文件」挡住目录名，mkdir 必然失败
    const blocked = path.join(os.tmpdir(), 'jwkb-block-' + Date.now());
    fs.writeFileSync(blocked, 'x');
    process.env.JWKB_DATA_DIR = path.join(blocked, 'sub');
    const res = resolveDataRoot();
    expect(res.root).toBeTruthy();
    expect(fs.existsSync(res.root)).toBe(true);
    process.env.JWKB_DATA_DIR = oldEnv;
    fs.rmSync(blocked, { force: true });
  });

  it('定位文件能写能读', () => {
    expect(writeLocator('D:\\Jw知识库')).toBe(true);
    expect(readLocator()).toBe(path.resolve('D:\\Jw知识库'));
  });

  it('ensureDirs 建出 attachments 与 备份 两个子目录，并给出完整路径', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jwkb-dirs-'));
    const p = ensureDirs(root);
    expect(p.db).toBe(path.join(root, 'kb.db'));
    expect(fs.existsSync(p.attachments)).toBe(true);
    expect(fs.existsSync(p.backups)).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
