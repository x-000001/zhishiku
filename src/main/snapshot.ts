import fs from 'node:fs';
import { describeCloudError } from '../shared/cloud';

/**
 * 数据库快照（VACUUM INTO）。单独放在这里是为了能在不 import electron 的情况下单测：
 * exec 抛 SQLITE_BUSY 时必须翻译成中文提示（红线：SQLITE_BUSY 友好提示）。
 */
export function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

export function takeSnapshot(exec: (sql: string) => void, target: string): number {
  if (fs.existsSync(target)) fs.rmSync(target, { force: true });
  try {
    exec(`VACUUM INTO '${escapeSqlLiteral(target)}'`);
  } catch (err) {
    throw new Error(describeCloudError(err));
  }
  if (!fs.existsSync(target)) throw new Error('数据库快照没生成出来，请稍后重试');
  return fs.statSync(target).size;
}
