import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

export interface DataPaths {
  root: string;
  db: string;
  attachments: string;
  backups: string;
  /** 数据根目录不是默认位置时为 true（例如 D 盘不可用时的兜底） */
  fallback: boolean;
}

export const DEFAULT_DATA_ROOT = 'D:\\Jw知识库';

/** 定位文件：记录用户选定的数据根目录（不把绝对路径写死在代码里，方便以后换盘/加同步）。 */
function locatorFile(): string {
  return path.join(app.getPath('appData'), 'Jw知识库', 'locator.json');
}

export function readLocator(): string | null {
  try {
    const file = locatorFile();
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { dataRoot?: unknown };
    if (parsed && typeof parsed.dataRoot === 'string' && parsed.dataRoot.trim()) {
      return path.resolve(parsed.dataRoot.trim());
    }
  } catch {
    // 定位文件损坏时静默回退到默认目录
  }
  return null;
}

/** 记录数据根目录。这只是个提示文件，写不进去不影响使用（比如 %APPDATA% 被锁时）。 */
export function writeLocator(root: string): boolean {
  try {
    const file = locatorFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ dataRoot: root }, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.warn('[数据] 定位文件没能写入，下次启动按默认目录找：', err);
    return false;
  }
}

function probeWritable(root: string): boolean {
  try {
    fs.mkdirSync(root, { recursive: true });
    const probe = path.join(root, '.write-test');
    fs.writeFileSync(probe, 'ok', 'utf8');
    fs.rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * 解析数据根目录，顺序：
 * 1. 环境变量 JWKB_DATA_DIR（开发/测试用）
 * 2. 定位文件里记录的位置
 * 3. 默认 D:\Jw知识库
 * 若目标位置不可写（比如换了一台没有 D 盘的电脑），退到用户数据目录，界面会提示。
 */
export function resolveDataRoot(): { root: string; fallback: boolean } {
  const fromEnv = process.env.JWKB_DATA_DIR?.trim();
  if (fromEnv) {
    const root = path.resolve(fromEnv);
    if (probeWritable(root)) return { root, fallback: false };
  }

  const fromLocator = readLocator();
  if (fromLocator && probeWritable(fromLocator)) return { root: fromLocator, fallback: false };

  if (probeWritable(DEFAULT_DATA_ROOT)) return { root: DEFAULT_DATA_ROOT, fallback: false };

  const fallbackRoot = path.join(app.getPath('userData'), 'data');
  fs.mkdirSync(fallbackRoot, { recursive: true });
  return { root: fallbackRoot, fallback: true };
}

export function ensureDirs(root: string, fallback = false): DataPaths {
  const attachments = path.join(root, 'attachments');
  const backups = path.join(root, '备份');
  fs.mkdirSync(attachments, { recursive: true });
  fs.mkdirSync(backups, { recursive: true });
  return { root, db: path.join(root, 'kb.db'), attachments, backups, fallback };
}

/** 附件按年月分文件夹存放，避免单个目录堆几万个文件。 */
export function attachmentDirFor(attachmentsRoot: string, date = new Date()): string {
  const month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  const dir = path.join(attachmentsRoot, month);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 本地日期 YYYY-MM-DD（不用 UTC，避免跨时区把「今天」算错）。 */
export function todayLocal(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 本地时间戳 YYYY-MM-DD_HHmm，用于备份目录名。 */
export function stampLocal(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${todayLocal(d)}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 把某个时刻格式化成带本地时区偏移的 ISO 串，用于和 created_at/updated_at 做字符串比较。 */
export function isoLocal(d = new Date()): string {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const p = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, '0');
  return (
    `${todayLocal(d)}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:` +
    `${String(d.getSeconds()).padStart(2, '0')}.${String(d.getMilliseconds()).padStart(3, '0')}` +
    `${sign}${p(off / 60)}:${p(off % 60)}`
  );
}

/** 现在时刻的 ISO 字符串（带时区偏移），用于 created_at / updated_at。 */
export function nowIso(): string {
  return isoLocal(new Date());
}
