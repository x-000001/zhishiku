import type { DatabaseSync } from 'node:sqlite';

/**
 * 清理 0.11.0 留下的「指令回显」脏数据。
 *
 * 0.11.0 的提炼 Prompt 里用括号写了格式占位说明，模型偶尔会把这些模板原样抄成正文，
 * 而旧的解析器只要非空就当成 done 存进收集箱。解析器修复后，历史库里已经躺着的条目
 * 不会自己变 —— 这个迁移把它们统一标成 ai_failed，卡片上就会出现「重试提炼」。
 */

/** 与 ai.ts 的 REPO_EXTRACT_ECHO_MARKERS 保持一致。
 *  这里故意复制一份：迁移在打开数据库时执行，不能反向 import ai.ts（否则 db ↔ ai 循环依赖）。 */
export const GITHUB_ECHO_MARKERS = [
  '我们需要回答用户',
  '严格按格式输出纯 Markdown',
  '按以下 Markdown 格式输出',
  '只写 README 里明确提到的能力',
  '一句话：什么情况下值得用',
  '3 到 5 条，每条不超过 30 字',
  '不要输出“以下是”'
];

/** 只依赖 prepare/exec，测试可以塞假实现，不强制真库。 */
export type GithubBugDb = Pick<DatabaseSync, 'prepare' | 'exec'>;

/** 同事务把命中回显的条目改判 ai_failed，返回改掉的条数（0 = 没有脏数据）。 */
export function cleanGithubBugRows(db: GithubBugDb): number {
  const where = GITHUB_ECHO_MARKERS.map(() => '(content like ? or extract_meta like ?)').join(' or ');
  const params: string[] = [];
  for (const marker of GITHUB_ECHO_MARKERS) params.push(`%${marker}%`, `%${marker}%`);
  const rows = db
    .prepare(`select id from inbox_item where extract_status = 'done' and (${where})`)
    .all(...params) as Array<{ id: number }>;
  if (rows.length === 0) return 0;
  const update = db.prepare(
    "update inbox_item set extract_status = 'ai_failed', updated_at = ? where id = ? and extract_status = 'done'"
  );
  const stamp = new Date().toISOString();
  db.exec('BEGIN');
  try {
    for (const row of rows) update.run(stamp, row.id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return rows.length;
}

/** 启动入口：整个清理过程包在 try/catch 里，失败也只打日志，绝不阻断软件启动。 */
export function runCleanGithubBugMigration(db: GithubBugDb): number {
  try {
    const changed = cleanGithubBugRows(db);
    if (changed > 0) {
      console.log(`[迁移] GitHub 指令回显脏数据：已把 ${changed} 条标成 ai_failed（卡片上可点「重试提炼」）`);
    }
    return changed;
  } catch (err) {
    console.error(
      '[迁移] 清理 GitHub 指令回显脏数据失败（不影响启动）：',
      err instanceof Error ? err.message : err
    );
    return 0;
  }
}
