/**
 * 端到端自检：真的启动打包好的 Electron 应用，通过 CDP 连进渲染进程，
 * 跑一遍「渲染层 → preload → IPC → SQLite」的真实链路，并把每个页面截一张图。
 *
 * 用法（必须在放宽的沙箱权限下跑，因为 Electron 需要创建命名管道）：
 *   node tests/e2e/cdp-check.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const exe = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const dataDir = path.join(root, '.e2e-data');
const shotDir = path.join(root, 'tests', 'e2e', 'shots');
const PORT = 9333;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(shotDir, { recursive: true });

const child = spawn(
  exe,
  [
    '.',
    `--remote-debugging-port=${PORT}`,
    '--no-sandbox',
    '--disable-gpu',
    `--user-data-dir=${path.join(root, 'tests', 'e2e', 'ud')}`
  ],
  { cwd: root, env: { ...process.env, JWKB_DATA_DIR: dataDir }, stdio: 'inherit' }
);

let exitInfo = null;
child.on('exit', (code, signal) => {
  exitInfo = `exit=${code} signal=${signal}`;
});

async function waitForTarget() {
  for (let i = 0; i < 80; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page' && t.url.includes('index.html'));
      if (page?.webSocketDebuggerUrl) return page;
    } catch {
      // 端口还没起来，继续等
    }
    await sleep(500);
  }
  throw new Error('等不到渲染进程调试目标');
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      const slot = this.pending.get(msg.id);
      if (!slot) return;
      this.pending.delete(msg.id);
      if (msg.error) slot.reject(new Error(JSON.stringify(msg.error)));
      else slot.resolve(msg.result);
    });
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('CDP 连接失败')), { once: true });
    });
    return new Cdp(ws);
  }

  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    });
    if (res.exceptionDetails) {
      const d = res.exceptionDetails;
      throw new Error(`${d.text} ${d.exception?.description ?? ''}`);
    }
    return res.result?.value;
  }

  async shot(name) {
    const res = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(shotDir, `${name}.png`), Buffer.from(res.data, 'base64'));
  }
}

const CHECK_SCRIPT = `(async () => {
  const out = [];
  const rec = (name, ok, detail) => out.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail).slice(0, 220) });
  const inv = (ch, p) => window.api.invoke(ch, p);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    rec('preload 桥可用', !!window.api && typeof window.api.invoke === 'function');

    const info = await inv('app:info');
    rec('app:info 返回数据目录', !!info && typeof info.dataRoot === 'string', JSON.stringify(info));
    rec('数据目录指向测试目录', String(info.dataRoot).toLowerCase().includes('.e2e-data'), info.dataRoot);
    rec('SQLite 版本可读', !!info.sqlite && info.sqlite.length > 3, info.sqlite);

    const integ = await inv('data:integrity');
    rec('启动后完整性检查 ok', integ === 'ok', integ);

    const cats = await inv('category:tree');
    rec('默认分类已建好（5 个）', Array.isArray(cats) && cats.length >= 5, '分类数=' + (cats ? cats.length : 'null') + ' ' + (cats || []).map((c) => c.name).join('/'));

    // ---- 收集箱 ----
    const id1 = await inv('inbox:add', { content: '想法：把英语单词本搬进知识库', kind: 'idea' });
    await inv('inbox:add', { content: '待读：深度工作第二章', kind: 'read' });
    const openList = await inv('inbox:list', { status: 'open' });
    rec('收集箱能存能读', openList.length === 2, 'open=' + openList.length);

    const conv = await inv('inbox:convert', { id: id1, target: 'note', title: '把英语单词本搬进知识库' });
    rec('收集箱一键转笔记', /^note:\\d+$/.test(conv.ref), conv.ref);
    const noteId = Number(conv.ref.split(':')[1]);
    const converted = await inv('note:get', { id: noteId });
    rec('转出来的笔记能读回', !!converted && converted.title.includes('英语单词本'), converted && converted.title);

    const convTask = await inv('inbox:convert', { id: openList[1].id, target: 'task', title: '读书：深度工作第二章', due_at: '2026-10-16', priority: 'urgent', repeat_rule: 'none' });
    rec('收集箱一键转任务', /^task:\\d+$/.test(convTask.ref), convTask.ref);
    const taskIdFromInbox = Number(convTask.ref.split(':')[1]);

    // ---- 知识库 ----
    const catId = cats[0].id;
    const note = await inv('note:create', { categoryId: catId, title: '知识管理测试笔记', content: '# 标题\\n\\n这是**加粗**和 \`代码\`，还有中文检索词：知识管理。' });
    rec('新建笔记', !!note && note.id > 0, note && note.id);

    await inv('note:save', { id: note.id, title: '知识管理测试笔记', content: note.content + '\\n追加一行', reason: '手动保存' });
    const versions = await inv('version:list', { noteId: note.id });
    rec('手动保存留下版本点', Array.isArray(versions) && versions.length >= 1, '版本数=' + (versions ? versions.length : 0));

    await inv('note:draft', { id: note.id, title: '草稿标题', content: '草稿内容' });
    const withDraft = await inv('note:get', { id: note.id });
    rec('草稿单独存放（正文不变）', !!withDraft && withDraft.draft_content === '草稿内容' && !withDraft.content.includes('草稿内容'), 'draft=' + (withDraft && withDraft.draft_title));

    const hit2 = await inv('search:query', { q: '知识' });
    rec('中文两字词能搜到（FTS 方案）', Array.isArray(hit2) && hit2.length > 0, '命中=' + (hit2 ? hit2.length : 0));
    const hitWord = await inv('search:query', { q: '知识管理' });
    rec('中文四字词能搜到', Array.isArray(hitWord) && hitWord.length > 0, '命中=' + (hitWord ? hitWord.length : 0));
    const hitEn = await inv('search:query', { q: 'zzzznotfound' });
    rec('搜不到的词返回空而不是报错', Array.isArray(hitEn) && hitEn.length === 0, '命中=' + (hitEn ? hitEn.length : 0));

    const tags = await inv('tag:set', { noteId: note.id, names: ['测试', '知识'] });
    rec('标签能设置', !!tags && tags.tags && tags.tags.length === 2, tags && tags.tags.map((t) => t.name).join(','));
    const allTags = await inv('tag:list');
    rec('标签列表可读', Array.isArray(allTags) && allTags.length >= 2, allTags && allTags.length);

    const byTag = await inv('note:list', { tagId: tags.tags[0].id });
    rec('按标签筛选笔记', Array.isArray(byTag) && byTag.length >= 1, '命中=' + (byTag ? byTag.length : 0));

    const pinned = await inv('note:pin', { id: note.id });
    const listAll = await inv('note:list', {});
    rec('置顶生效', !!pinned && listAll.some((n) => n.id === note.id && n.is_pinned === 1), '列表=' + listAll.length);

    // ---- 回收站 ----
    const tmp = await inv('note:create', { title: '待删测试', content: 'x' });
    await inv('note:trash', { id: tmp.id });
    const trashList = await inv('note:list', { trash: true });
    rec('删除进回收站', trashList.some((n) => n.id === tmp.id), '回收站=' + trashList.length);
    await inv('note:restore', { id: tmp.id });
    const afterRestore = await inv('note:list', {});
    rec('回收站能还原', afterRestore.some((n) => n.id === tmp.id), '列表=' + afterRestore.length);

    // ---- 任务 ----
    const today = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const todayStr = today.getFullYear() + '-' + pad(today.getMonth() + 1) + '-' + pad(today.getDate());
    const t1 = await inv('task:create', { title: '今天要做的第一件事', due_at: todayStr, priority: 'urgent' });
    const t2 = await inv('task:create', { title: '每天重复的晨间阅读', due_at: todayStr, priority: 'important', repeat_rule: 'daily' });
    await inv('task:create', { title: '下个月才做的事', due_at: '2026-11-30', priority: 'normal' });
    const todayTasks = await inv('task:list', { view: 'today' });
    rec('任务按今天筛选', todayTasks.length >= 2, '今天=' + todayTasks.length + ' 标题=' + todayTasks.map((t) => t.title).join('|'));
    const upcoming = await inv('task:list', { view: 'upcoming' });
    rec('任务按接下来筛选', upcoming.length === 1, '接下来=' + upcoming.length);
    const done1 = await inv('task:toggle', { id: t1, status: 'done' });
    rec('勾掉普通任务不生成下一次', !!done1 && done1.spawned === null, JSON.stringify(done1 && done1.spawned));
    const done2 = await inv('task:toggle', { id: t2, status: 'done' });
    rec('勾掉重复任务会生成下一次', !!done2 && done2.spawned !== null, 'spawned=' + (done2 && done2.spawned));
    const afterRepeat = await inv('task:list', { view: 'all' });
    const spawnedTask = afterRepeat.find((t) => t.title.includes('晨间阅读') && t.status === 'todo');
    rec('重复任务生成了下一次、排在明天', !!spawnedTask && String(spawnedTask.due_at) > todayStr, spawnedTask ? '下一跳=' + spawnedTask.due_at : '没生成');
    await inv('task:update', { id: t1, patch: { title: '今天要做的第一件事（改过）', priority: 'normal' } });
    const updated = await inv('task:list', { view: 'all' });
    rec('任务能行内改', updated.some((t) => t.id === t1 && t.title.includes('改过') && t.priority === 'normal'), 'ok');

    // ---- 优化项 4：勾完不消失 / 状态三档 / 批量删除 ----
    const todayAfter = await inv('task:list', { view: 'today' });
    rec(
      '勾完的任务还留在今天列表里（勾完不消失）',
      todayAfter.some((t) => t.id === t1 && t.status === 'done'),
      '今天=' + todayAfter.length
    );
    rec(
      '已完成的排在没做完的后面',
      todayAfter.findIndex((t) => t.status === 'done') > todayAfter.findIndex((t) => t.status === 'todo'),
      todayAfter.map((t) => t.status).join(',')
    );
    const onlyTodo = await inv('task:list', { view: 'all', status: 'todo' });
    const onlyDone = await inv('task:list', { view: 'all', status: 'done' });
    rec('状态筛选：未完成', onlyTodo.length > 0 && onlyTodo.every((t) => t.status === 'todo'), '未完成=' + onlyTodo.length);
    rec('状态筛选：已完成', onlyDone.some((t) => t.id === t1) && onlyDone.every((t) => t.status === 'done'), '已完成=' + onlyDone.length);
    const countsV3 = await inv('task:counts');
    rec('角标多了未完成这一档', typeof countsV3.todo === 'number' && countsV3.todo === onlyTodo.length, 'todo=' + countsV3.todo);
    const batchIds = onlyTodo.slice(0, 2).map((t) => t.id);
    const removedCount = await inv('task:delete-many', { ids: batchIds });
    rec('批量删除返回真正删掉的条数', removedCount === batchIds.length, '删了 ' + removedCount + '/' + batchIds.length);
    const leftAll = await inv('task:list', { view: 'all' });
    rec('批量删除后列表里没有它们了', batchIds.every((id) => !leftAll.some((t) => t.id === id)), '剩=' + leftAll.length);

    // ---- 优化项 5：优先级三档（紧急 / 重要 / 一般）----
    const pUrgent = await inv('task:create', { title: '明天要交的紧急事', priority: 'urgent' });
    const pImportant = await inv('task:create', { title: '该推进的重要事', priority: 'important' });
    const pNormal = await inv('task:create', { title: '有空再弄的一般事', priority: 'normal' });
    const allPrio = await inv('task:list', { view: 'all' });
    const findPrio = (id) => allPrio.find((t) => t.id === id);
    rec(
      '三档优先级都存在库里',
      ['urgent', 'important', 'normal'].join(',') ===
        [pUrgent, pImportant, pNormal].map((id) => (findPrio(id) || {}).priority).join(','),
      [pUrgent, pImportant, pNormal].map((id) => (findPrio(id) || {}).priority).join(',')
    );
    const posOf = (id) => allPrio.findIndex((t) => t.id === id);
    rec(
      '排序是紧急在前、重要居中、一般在后',
      posOf(pUrgent) < posOf(pImportant) && posOf(pImportant) < posOf(pNormal),
      '位置=' + [posOf(pUrgent), posOf(pImportant), posOf(pNormal)].join(',')
    );
    const onlyUrgent = await inv('task:list', { view: 'all', priority: 'urgent' });
    rec(
      '按「紧急」筛选只剩紧急',
      onlyUrgent.length > 0 && onlyUrgent.every((t) => t.priority === 'urgent'),
      '紧急=' + onlyUrgent.length + ' 命中=' + onlyUrgent.length
    );
    // 老库的数字优先级会被归一成三档文字（这里直接塞数字试一次）
    const legacyId = await inv('task:create', { title: '老代码传数字的任务', priority: 3 });
    const legacyTask = (await inv('task:list', { view: 'all' })).find((t) => t.id === legacyId);
    rec('后端会把老式数字优先级归一成三档文字', !!legacyTask && legacyTask.priority === 'urgent', String(legacyTask && legacyTask.priority));

    // ---- 首页 ----
    const dash = await inv('dash:overview');
    rec('首页数据能读', !!dash && Array.isArray(dash.tasks) && typeof dash.today === 'string', 'today=' + (dash && dash.today) + ' 待办=' + (dash && dash.tasks.length));
    rec('首页统计了收集箱与最近笔记', !!dash && typeof dash.inboxCount === 'number' && Array.isArray(dash.recentNotes), '待整理=' + (dash && dash.inboxCount) + ' 最近笔记=' + (dash && dash.recentNotes.length));
    rec('首页包含复习提醒结构', !!dash && Array.isArray(dash.reviewDue), '复习卡=' + (dash && dash.reviewDue.length));
    rec('首页包含目标进度结构', !!dash && Array.isArray(dash.goals), '目标=' + (dash && dash.goals.length));

    // ---- 第二版：附件（拖拽走的就是这条通道） ----
    rec('preload 暴露了取真实路径的 pathForFile', typeof window.api.pathForFile === 'function', typeof window.api.pathForFile);
    const srcPath = info.dataRoot + String.fromCharCode(92) + 'kb.db';
    const att = await inv('attach:add-path', { noteId: note.id, srcPath });
    rec('按绝对路径把文件存成附件', !!att && att.file_name === 'kb.db' && !!att.rel_path, JSON.stringify(att && { f: att.file_name, r: att.rel_path }));
    const noteWithAtt = await inv('note:get', { id: note.id });
    const atts = (noteWithAtt && noteWithAtt.attachments) || [];
    rec('附件挂到了这条笔记上', atts.length >= 1 && atts[0].id === att.id, '附件=' + atts.length);
    rec('不存在的路径会被挡住', await inv('attach:add-path', { noteId: note.id, srcPath: srcPath + '.nope' }).then(() => false, () => true), 'ok');

    // ---- 第二版：目标 / 关键结果 / 里程碑 ----
    const goalId = await inv('goal:create', { title: '把知识库用起来', description: '每天记一点', target_date: '2026-12-31' });
    rec('能建目标', typeof goalId === 'number' && goalId > 0, 'goalId=' + goalId);
    rec('进行中目标计数', (await inv('goal:active-count')) === 1, 'activeCount=' + (await inv('goal:active-count')));

    const krId = await inv('kr:create', { goalId, title: '写满 100 篇笔记', target_value: 100, current_value: 20, unit: '篇' });
    const krs = await inv('kr:list', { goalId });
    rec('关键结果能建能列', krs.length === 1 && krs[0].target_value === 100, 'kr=' + JSON.stringify(krs[0] && { t: krs[0].title, v: krs[0].current_value }));
    await inv('kr:update', { id: krId, patch: { current_value: 50 } });
    const goalAfter = await inv('goal:get', { id: goalId });
    rec('目标进度按关键结果自动算', goalAfter && goalAfter.goal.progress >= 50 && goalAfter.goal.progress < 100, 'progress=' + (goalAfter && goalAfter.goal.progress));

    const msId = await inv('milestone:create', { goalId, title: '搭好目录结构', target_date: todayStr });
    await inv('milestone:toggle', { id: msId, done: true });
    const detail = await inv('goal:get', { id: goalId });
    rec('里程碑能勾能读', Array.isArray(detail.milestones) && detail.milestones.some((m) => m.id === msId && m.done === 1), '里程碑=' + (detail.milestones || []).length);

    // ---- 第二版：目标池（下一阶段） ----
    const poolId = await inv('pool:create', { title: '学 Rust 写命令行工具', why: '想自己做工具', start_condition: '当前目标做完', horizon: 'quarter', priority: 2 });
    const poolList = await inv('pool:list', {});
    rec('目标池能存能列', Array.isArray(poolList) && poolList.some((p) => p.id === poolId), '池子=' + (poolList || []).length);
    const started = await inv('pool:start', { id: poolId });
    const goalsNow = await inv('goal:list', { includeArchived: true });
    rec('目标池能一键转成当前目标', !!started && typeof started.goalId === 'number' && goalsNow.some((g) => g.id === started.goalId), '新目标=' + (started && started.goalId));
    const poolAfter = (await inv('pool:list', {})).find((p) => p.id === poolId);
    rec('启动后池子条目标成已启动并挂上新目标', !!poolAfter && poolAfter.status === 'started' && poolAfter.goal_id === started.goalId, JSON.stringify(poolAfter && { s: poolAfter.status, g: poolAfter.goal_id }));

    // ---- 第二版：学习计划 ----
    const planId = await inv('plan:create', { title: '每天两小时学英语', direction: '先补口语', rhythm: '每天 2 小时', start_date: todayStr });
    rec('能建计划', typeof planId === 'number' && planId > 0, 'planId=' + planId);
    const itemId = await inv('plan-item:create', { planId, title: '精读一篇外刊', date: todayStr, minutes: 60 });
    const items = await inv('plan-item:list', { planId });
    rec('计划条目能建能列', items.length === 1 && items[0].minutes === 60, '条目=' + items.length);
    const cal = await inv('plan:calendar', { from: todayStr, to: todayStr });
    rec('日历能按日期取到计划条目', Array.isArray(cal) && cal.some((c) => c.id === itemId), '当天=' + (cal || []).length);
    await inv('plan-item:toggle', { id: itemId, done: true });
    const cal2 = await inv('plan:calendar', { from: todayStr, to: todayStr });
    rec('勾掉计划条目后日历里标成完成', cal2.some((c) => c.id === itemId && c.done === 1), 'ok');
    const dash2 = await inv('dash:overview');
    rec('首页今日计划取到条目', Array.isArray(dash2.todayPlan) && dash2.todayPlan.some((c) => c.id === itemId), '今日计划=' + (dash2.todayPlan || []).length);

    // ---- 第二版：复习（间隔重复） ----
    const cardId = await inv('review:create', { front: '什么是闭包', back: '能读外部变量的函数', source: 'wrong' });
    rec('能手动加复习卡', typeof cardId === 'number' && cardId > 0, 'cardId=' + cardId);
    const fromNote = await inv('review:from-note', { noteId: note.id });
    rec('笔记能一键变复习卡', typeof fromNote === 'number' && fromNote > 0, 'cardId=' + fromNote);
    rec('同一篇笔记不会重复生成', (await inv('review:from-note', { noteId: note.id })) === fromNote, 'ok');

    const graded = await inv('review:grade', { id: cardId, grade: 'know' });
    rec('打分「记得」后间隔拉长', !!graded && graded.interval_days === 1 && graded.review_count === 1, JSON.stringify(graded && { i: graded.interval_days, c: graded.review_count, n: graded.next_review_at }));
    const forgot = await inv('review:grade', { id: cardId, grade: 'forgot' });
    rec('打分「忘了」后回到今天、遗忘次数加一', !!forgot && forgot.interval_days === 0 && forgot.lapses === 1 && String(forgot.next_review_at).startsWith(todayStr), JSON.stringify(forgot && { i: forgot.interval_days, l: forgot.lapses, n: forgot.next_review_at }));
    const dueList = await inv('review:due');
    rec('今天到期的卡能取到', Array.isArray(dueList) && dueList.some((c) => c.id === cardId), '到期=' + (dueList || []).length);
    const dash3 = await inv('dash:overview');
    rec('首页带复习到期数量', typeof dash3.reviewDueCount === 'number' && dash3.reviewDueCount >= 1, 'reviewDueCount=' + dash3.reviewDueCount);
    const again = await inv('review:grade', { id: cardId, grade: 'know' });
    rec('再记一次间隔从 1 天重新爬', !!again && again.interval_days === 1, '间隔=' + (again && again.interval_days));
    const logs = await inv('review:logs', { cardId });
    rec('每次打分留了日志', Array.isArray(logs) && logs.length === 3, '日志=' + (logs || []).length);
    const rstats = await inv('review:stats');
    rec('复习统计能读', !!rstats && rstats.total >= 2 && typeof rstats.dueToday === 'number', JSON.stringify(rstats));

    // ---- 第二版：复盘 ----
    const retroId = await inv('retro:save', { type: 'day', date: todayStr, content: '今天把第二版做完了。' });
    rec('日复盘能存', typeof retroId === 'number' && retroId > 0, 'retroId=' + retroId);
    const retroBack = await inv('retro:get', { type: 'day', date: todayStr });
    rec('日复盘能读回', !!retroBack && retroBack.content.includes('第二版'), retroBack && retroBack.content);
    const week = await inv('retro:period', { type: 'week', date: todayStr });
    rec('周复盘算出周一到周日的范围', !!week && week.to >= week.from && (new Date(week.to + 'T12:00:00') - new Date(week.from + 'T12:00:00')) / 86400000 === 6, JSON.stringify(week));
    const rstats2 = await inv('retro:stats', { from: week.from, to: week.to });
    rec('复盘周期统计能算', !!rstats2 && typeof rstats2.tasksDone === 'number' && typeof rstats2.planItemsTotal === 'number', JSON.stringify(rstats2));
    rec('复盘统计数到了勾掉的计划条目', !!rstats2 && rstats2.planItemsDone >= 1, 'planItemsDone=' + (rstats2 && rstats2.planItemsDone));
    await inv('retro:save', { type: 'week', date: todayStr, content: '这周方向没问题。' });
    const retroList = await inv('retro:list', { type: 'week' });
    rec('周复盘和历史列表分开存', Array.isArray(retroList) && retroList.length === 1 && retroList[0].type === 'week', '周复盘=' + (retroList || []).length);

    // ---- 第二版：任务提醒时间 ----
    const withRemind = await inv('task:create', { title: '提醒测试', due_at: todayStr, remind_at: todayStr + ' 09:30:00', priority: 'important' });
    const remindRow = (await inv('task:list', { view: 'all' })).find((t) => t.id === withRemind);
    rec('任务能存提醒时间', !!remindRow && String(remindRow.remind_at).includes('09:30'), 'remind_at=' + (remindRow && remindRow.remind_at));

    // ---- 第三版：富文本（优化项 2） ----
    const richNote = await inv('note:create', {
      title: '富文本自检',
      html: '<p>第一段 <b>加粗的字</b> <mark style="background-color: #fff3b0">重点高亮</mark></p><p>第二段</p>'
    });
    const richId = richNote && richNote.id;
    rec('富文本笔记能新建并带回 id', richId > 0, 'id=' + richId);
    const richBack = await inv('note:get', { id: richId });
    rec('富文本存进 content_html', !!richBack && String(richBack.content_html).includes('<b>加粗的字</b>'), String(richBack && richBack.content_html).slice(0, 80));
    rec('纯文字自动从 HTML 抽出来（搜索/字数用）',
      !!richBack && String(richBack.content).includes('第一段') && String(richBack.content).includes('重点高亮') && !String(richBack.content).includes('<p>'),
      JSON.stringify(String(richBack && richBack.content).slice(0, 60)));

    await inv('note:save', {
      id: richId,
      title: '富文本自检',
      html: '<p>安全</p><script>window.__pwned = 1</scr' + 'ipt><p onclick="alert(1)">点我</p>',
      reason: '自检'
    });
    const afterSave = await inv('note:get', { id: richId });
    const savedHtml = String(afterSave && afterSave.content_html);
    rec('保存时洗掉了 script 标签', !/<\s*script/i.test(savedHtml) && !savedHtml.includes('__pwned'), savedHtml.slice(0, 80));
    rec('保存时洗掉了 onclick 这类事件属性', !/on[a-z]+\s*=/i.test(savedHtml), savedHtml.slice(0, 80));
    rec('洗过之后正文还在（只删危险部分）', savedHtml.includes('安全') && savedHtml.includes('点我'), savedHtml.slice(0, 80));

    const tableHtml = '<table><thead><tr><th>列一</th><th>列二</th></tr></thead><tbody><tr><td>甲</td><td>乙</td></tr></tbody></table>';
    await inv('note:save', { id: richId, title: '富文本自检', html: tableHtml, reason: '自检' });
    const tableBack = await inv('note:get', { id: richId });
    rec('表格结构能原样存回来', !!tableBack && String(tableBack.content_html).includes('<th>列一</th>') && String(tableBack.content_html).includes('<td>甲</td>'), String(tableBack && tableBack.content_html).slice(0, 90));

    const richVer = await inv('version:list', { noteId: richId });
    const richVerWithHtml = (richVer || []).filter((v) => v.content_html && v.content_html.includes('<table'));
    rec('版本点里也留了富文本（回滚不丢格式）', richVerWithHtml.length >= 1, '版本数=' + (richVer || []).length);

    // ---- 第三版：正文里的图片（jw-att:// 协议） ----
    const imgNote = await inv('note:create', { title: '图片自检', html: '<p>看图</p>' });
    const imgAtt = await inv('attach:add-path', { noteId: imgNote.id, srcPath: __PIXEL_PATH__ });
    const imgUrl = 'jw-att://' + String(imgAtt.rel_path).split('\\\\').join('/');
    const imgLoad = await new Promise((resolve) => {
      const im = new Image();
      im.onload = () => resolve(im.naturalWidth + 'x' + im.naturalHeight);
      im.onerror = () => resolve('ERR');
      im.src = imgUrl;
    });
    rec('正文里的图片能通过 jw-att:// 显示出来', String(imgLoad) === '1x1', imgUrl + ' → ' + imgLoad);
    await inv('note:save', { id: imgNote.id, title: '图片自检', html: '<p>看图</p><img src="' + imgUrl + '" alt="像素">' });
    const imgBack = await inv('note:get', { id: imgNote.id });
    rec('图片地址能存进正文', !!imgBack && String(imgBack.content_html).includes('jw-att://'), String(imgBack && imgBack.content_html).slice(0, 90));
    rec('图片不算字数、只留 alt 文字', !!imgBack && !String(imgBack.content).includes('jw-att'), JSON.stringify(String(imgBack && imgBack.content).slice(0, 40)));

    // ---- 第三版：笔记拖动排序（优化项 6） ----
    const sortCat = await inv('category:create', { parentId: null, name: '排序自检分类' });
    const sortA = await inv('note:create', { categoryId: sortCat, title: '排序甲', html: '<p>a</p>' });
    const sortB = await inv('note:create', { categoryId: sortCat, title: '排序乙', html: '<p>b</p>' });
    const sortC = await inv('note:create', { categoryId: sortCat, title: '排序丙', html: '<p>c</p>' });
    const orderOf = (list, ids) => ids.map((id) => list.findIndex((n) => n.id === id));
    const catList = () => inv('note:list', { categoryId: sortCat });
    const before = await catList();
    const moved = await inv('note:reorder', { ids: [sortC.id, sortA.id, sortB.id] });
    rec('拖动排序写库返回条数', moved === 3, 'moved=' + moved);
    const after = await catList();
    const pos = orderOf(after, [sortC.id, sortA.id, sortB.id]);
    rec('排序后列表顺序就是拖完的顺序', pos[0] === 0 && pos[1] === 1 && pos[2] === 2, '位置=' + JSON.stringify(pos) + ' 之前=' + JSON.stringify(orderOf(before, [sortA.id, sortB.id, sortC.id])));
    const otherCatStill = await inv('note:list', { categoryId: catId });
    rec('在某个分类里排序不影响别的分类', Array.isArray(otherCatStill) && otherCatStill.length >= 1, '别的分类=' + (otherCatStill || []).length);

    // ---- 优化项 7：分类树（多级 / 排序 / 非空不能删） ----
    const subCat = await inv('category:create', { parentId: sortCat, name: '排序子分类' });
    const tree2 = await inv('category:tree');
    rec('能建子分类（parent_id 指对了）', (tree2.find((c) => c.id === subCat) || {}).parent_id === sortCat, 'parent_id=' + JSON.stringify((tree2.find((c) => c.id === subCat) || {}).parent_id));
    let subDelErr = '';
    try {
      await inv('category:delete', { id: sortCat });
    } catch (e) {
      subDelErr = e && e.message;
    }
    rec('分类下还有笔记时删不掉，提示先搬走笔记', subDelErr === '该分类下还有笔记，请先移动或删除笔记', subDelErr || '（居然删成功了）');
    rec('被拦下之后分类还在', (await inv('category:tree')).some((c) => c.id === sortCat) === true, '还在=' + (await inv('category:tree')).some((c) => c.id === sortCat));

    const tmpCat = await inv('category:create', { parentId: null, name: '待删分类' });
    const tmpSub = await inv('category:create', { parentId: tmpCat, name: '待删子分类' });
    const tmpNote = await inv('note:create', { categoryId: tmpSub, title: '待删分类里的笔记', html: '<p>t</p>' });
    let deepErr = '';
    try {
      await inv('category:delete', { id: tmpCat });
    } catch (e) {
      deepErr = e && e.message;
    }
    rec('笔记在子分类里，父分类同样删不掉（递归检查）', deepErr === '该分类下还有笔记，请先移动或删除笔记', deepErr || '（居然删成功了）');
    await inv('note:move', { id: tmpNote.id, categoryId: null });
    rec('笔记搬走之后分类就能删了', (await inv('category:delete', { id: tmpCat })) === true, 'tmpCat=' + tmpCat);
    rec('删父分类后子分类上提一级，没有跟着一起没', (await inv('category:tree')).find((c) => c.id === tmpSub)?.parent_id === null, 'tmpSub.parent_id=' + JSON.stringify((await inv('category:tree')).find((c) => c.id === tmpSub)?.parent_id));

    const roots = (await inv('category:tree')).filter((c) => c.parent_id === null).map((c) => c.name);
    await inv('category:move', { id: tmpSub, dir: 'up' });
    const roots2 = (await inv('category:tree')).filter((c) => c.parent_id === null).map((c) => c.name);
    rec('分类能上移，顺序真的换了', roots2.indexOf('待删子分类') === roots.indexOf('待删子分类') - 1, JSON.stringify(roots) + ' → ' + JSON.stringify(roots2));

    // ---- 设置与备份 ----
    const settings = await inv('settings:get');
    rec('设置能读', !!settings && typeof settings.theme === 'string', JSON.stringify(settings));
    await inv('settings:set', { key: 'versionKeep', value: 5 });
    const s2 = await inv('settings:get');
    rec('设置能改并持久化', s2.versionKeep === 5, 'versionKeep=' + s2.versionKeep);

    const backup = await inv('backup:run');
    rec('手动备份成功', !!backup && !!backup.name, backup && backup.name);
    const backups = await inv('backup:list');
    rec('备份列表可读', Array.isArray(backups) && backups.length >= 1, '备份数=' + (backups ? backups.length : 0));

  } catch (err) {
    rec('自检脚本本身没报错', false, err && err.message);
  }
  return out;
})()`;

let cdp;
const results = [];

try {
  const target = await waitForTarget();
  cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  // 等界面真正挂上
  let ready = false;
  for (let i = 0; i < 40; i += 1) {
    const ok = await cdp.eval("!!document.querySelector('.sidebar') && !!window.api");
    if (ok) {
      ready = true;
      break;
    }
    await sleep(500);
  }
  results.push({ name: '界面挂载完成（侧栏出现）', ok: ready, detail: '' });

  // 正文插图的协议自检需要一张真图片：先在数据目录里写一个 1×1 的 PNG
  const pixelPath = path.join(dataDir, 'e2e-pixel.png');
  fs.writeFileSync(
    pixelPath,
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
      'base64'
    )
  );
  const dataChecks = await cdp.eval(CHECK_SCRIPT.replace('__PIXEL_PATH__', JSON.stringify(pixelPath)));
  results.push(...dataChecks);

  // 图片有没有真的被复制进数据目录的附件夹（渲染层看不到磁盘）
  const findUnder = (dir, name) => {
    if (!fs.existsSync(dir)) return null;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const hit = findUnder(full, name);
        if (hit) return hit;
      } else if (entry.name === name) {
        return full;
      }
    }
    return null;
  };
  const copiedPixel = findUnder(path.join(dataDir, 'attachments'), 'e2e-pixel.png');
  results.push({
    name: '插图真的复制进了数据目录的附件夹（原件删了也不影响）',
    ok: !!copiedPixel && copiedPixel.startsWith(path.join(dataDir, 'attachments')),
    detail: copiedPixel || '没在附件夹里找到 e2e-pixel.png'
  });

  // 文件系统层面的结果由 Node 侧核对（渲染层看不到磁盘）
  const backupRoot = path.join(dataDir, '备份');
  const backups = fs.existsSync(backupRoot) ? fs.readdirSync(backupRoot) : [];
  const newest = [...backups].sort().pop();
  results.push({
    name: '备份目录里有快照且含 kb.db',
    ok: backups.length >= 1 && !!newest && fs.existsSync(path.join(backupRoot, newest, 'kb.db')),
    detail: backups.length ? backups.join(', ') : '空'
  });
  results.push({
    name: '数据库文件落在数据目录',
    ok: fs.existsSync(path.join(dataDir, 'kb.db')),
    detail: path.join(dataDir, 'kb.db')
  });
  results.push({
    name: '附件目录已建好',
    ok: fs.existsSync(path.join(dataDir, 'attachments')),
    detail: path.join(dataDir, 'attachments')
  });

  const ROUTES = [
    ['/', 'home'],
    ['/inbox', 'inbox'],
    ['/knowledge', 'knowledge'],
    ['/tasks', 'tasks'],
    ['/plans', 'plans'],
    ['/goals', 'goals'],
    ['/next', 'next'],
    ['/review', 'review'],
    ['/settings', 'settings'],
    ['/quick', 'quick-capture']
  ];

  for (const [route, name] of ROUTES) {
    // 先跳到一个不存在的路由，确保目标页是“重新挂载”而不是复用旧组件，
    // 这样页面上的数据才是本次测试刚写进去的那批。
    await cdp.eval("location.hash = '/__bounce'; true");
    await sleep(250);
    await cdp.eval(`location.hash = ${JSON.stringify(route)}; true`);
    await sleep(700);
    const text = await cdp.eval(
      "(() => { const el = document.querySelector('.content') || document.body; return (el.innerText || '').trim(); })()"
    );
    results.push({
      name: `页面 ${route} 有实际内容`,
      ok: typeof text === 'string' && text.length > 10,
      detail: (text || '').replace(/\\s+/g, ' ').slice(0, 110)
    });
    await cdp.shot(name);
  }

  // ---- 优化项 4：任务页的状态三档与多选界面 ----
  await cdp.eval("location.hash = '/__bounce'; true");
  await sleep(250);
  await cdp.eval("location.hash = '/tasks'; true");
  await sleep(800);
  const statusTabs = await cdp.eval(
    "(() => [...document.querySelectorAll('.kb-tree button')].map((b) => (b.innerText || '').trim()).join('|'))()"
  );
  results.push({
    name: '任务页有状态三档按钮',
    ok:
      /全部/.test(String(statusTabs)) && /未完成/.test(String(statusTabs)) && /已完成/.test(String(statusTabs)),
    detail: String(statusTabs).slice(0, 80)
  });
  const pickOn = await cdp.eval(`(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => (b.innerText || '').includes('多选'));
    if (!btn) return 'no-btn';
    btn.click();
    return 'clicked';
  })()`);
  await sleep(500);
  const boxes = await cdp.eval("document.querySelectorAll('.task-row input.pick').length");
  results.push({
    name: '多选模式每行出现复选框',
    ok: pickOn === 'clicked' && Number(boxes) > 0,
    detail: '复选框=' + boxes
  });
  const allBtn = await cdp.eval(`(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => (b.innerText || '').trim() === '全选');
    if (!btn) return 'no-all';
    btn.click();
    return 'clicked';
  })()`);
  await sleep(400);
  const pickedRows = await cdp.eval("document.querySelectorAll('.task-row.picked').length");
  results.push({
    name: '全选后整列都打上选中标记',
    ok: allBtn === 'clicked' && Number(pickedRows) > 0,
    detail: '选中行=' + pickedRows
  });
  await cdp.shot('tasks-multi');

  // ---- 优化项 5：任务页的优先级标签颜色与筛选按钮 ----
  const prioDots = await cdp.eval(`(() => {
    const rows = [...document.querySelectorAll('.task-row')];
    const out = { urgent: 0, important: 0, normal: 0, other: 0 };
    for (const r of rows) {
      const dot = r.querySelector('.dot');
      if (!dot) continue;
      const hit = ['urgent', 'important', 'normal'].find((k) => dot.classList.contains('prio-' + k));
      if (hit) out[hit] += 1;
      else out.other += 1;
    }
    return JSON.stringify(out);
  })()`);
  const dotObj = JSON.parse(String(prioDots));
  results.push({
    name: '任务前面的小圆点带三档颜色类名',
    ok: dotObj.other === 0 && dotObj.urgent + dotObj.important + dotObj.normal > 0,
    detail: String(prioDots)
  });
  const prioTabs = await cdp.eval(
    "(() => [...document.querySelectorAll('button')].map((b) => (b.innerText || '').trim()).filter((t) => ['全部','紧急','重要','一般'].includes(t)).join('|'))()"
  );
  results.push({
    name: '任务左右有优先级筛选按钮',
    ok: /紧急/.test(String(prioTabs)) && /重要/.test(String(prioTabs)) && /一般/.test(String(prioTabs)),
    detail: String(prioTabs).slice(0, 60)
  });
  const urgentOnly = await cdp.eval(`(async () => {
    // 先保证今天视图里确实有紧急任务和不紧急的任务各一条，否则筛选无从体现
    const d = new Date();
    const pad2 = (n) => String(n).padStart(2, '0');
    const todayStr = d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
    await window.api.invoke('task:create', { title: '界面自检的紧急任务', due_at: todayStr, priority: 'urgent' });
    await window.api.invoke('task:create', { title: '界面自检的一般任务', due_at: todayStr, priority: 'normal' });
    location.hash = '/__bounce';
    await new Promise((r) => setTimeout(r, 250));
    location.hash = '/tasks';
    await new Promise((r) => setTimeout(r, 900));
    const btn = [...document.querySelectorAll('button')].find((b) => (b.innerText || '').trim() === '紧急');
    if (!btn) return 'no-btn';
    btn.click();
    return 'clicked';
  })()`);
  await sleep(700);
  const urgentRows = await cdp.eval(`(() => {
    const rows = [...document.querySelectorAll('.task-row')];
    const allUrgent = rows.every((r) => { const d = r.querySelector('.dot'); return d && d.classList.contains('prio-urgent'); });
    return JSON.stringify({ n: rows.length, allUrgent });
  })()`);
  const urgentObj = JSON.parse(String(urgentRows));
  results.push({
    name: '点「紧急」后列表里只剩紧急任务',
    ok: urgentOnly === 'clicked' && urgentObj.n > 0 && urgentObj.allUrgent === true,
    detail: String(urgentRows)
  });
  await cdp.shot('tasks-priority');

  // ---- 优化项 6：笔记卡片拖动排序（真的拖一次） ----
  await cdp.eval("location.hash = '/__bounce'; true");
  await sleep(250);
  await cdp.eval("location.hash = '/knowledge'; true");
  await sleep(900);
  const catPicked = await cdp.eval(`(() => {
    const hit = [...document.querySelectorAll('.tree-item')].find((el) => (el.innerText || '').includes('排序自检分类'));
    if (!hit) return 'no-cat';
    hit.click();
    return 'ok';
  })()`);
  await sleep(800);
  const listTitles = "(() => [...document.querySelectorAll('.kb-list-body .list-row .title')].map((e) => e.innerText.trim()))()";
  const beforeDrag = await cdp.eval(listTitles);
  const dragResult = await cdp.eval(`(() => {
    const rows = [...document.querySelectorAll('.kb-list-body .list-row')];
    if (rows.length < 3) return 'few:' + rows.length;
    const dt = new DataTransfer();
    const titleOf = (r) => ((r.querySelector('.title') || {}).innerText || '').trim();
    const src = rows[0];
    const dst = rows[2];
    const info = { from: titleOf(src), to: titleOf(dst), draggable: src.getAttribute('draggable') };
    src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    const box = dst.getBoundingClientRect();
    const init = { bubbles: true, dataTransfer: dt, clientX: box.left + 8, clientY: box.bottom - 2 };
    dst.dispatchEvent(new DragEvent('dragover', init));
    dst.dispatchEvent(new DragEvent('drop', init));
    src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
    return JSON.stringify(info);
  })()`);
  await sleep(900);
  const afterDrag = await cdp.eval(listTitles);
  results.push({
    name: '笔记卡片可以拖动（卡片带 draggable、分类下能拿到 3 张）',
    ok: catPicked === 'ok' && Array.isArray(beforeDrag) && beforeDrag.length >= 3,
    detail: catPicked + ' 卡片=' + (Array.isArray(beforeDrag) ? beforeDrag.join('|') : beforeDrag)
  });
  const dragInfo = (() => {
    try {
      return JSON.parse(String(dragResult));
    } catch {
      return { from: '', to: '', draggable: String(dragResult) };
    }
  })();
  const movedFrom = Array.isArray(afterDrag) ? afterDrag.indexOf(dragInfo.from) : -1;
  const movedTo = Array.isArray(afterDrag) ? afterDrag.indexOf(dragInfo.to) : -1;
  results.push({
    name: '拖动后顺序立刻变了，卡片落在目标旁边',
    ok:
      JSON.stringify(afterDrag) !== JSON.stringify(beforeDrag) &&
      movedFrom >= 0 &&
      movedTo >= 0 &&
      Math.abs(movedFrom - movedTo) === 1,
    detail: '拖的「' + dragInfo.from + '」→ 现在位置 ' + movedFrom + '，目标「' + dragInfo.to + '」在 ' + movedTo + '；顺序=' + (Array.isArray(afterDrag) ? afterDrag.join('|') : afterDrag)
  });
  // 重新挂载页面（相当于关掉重开），顺序应当还是刚才拖完的样子
  await cdp.eval("location.hash = '/__bounce'; true");
  await sleep(250);
  await cdp.eval("location.hash = '/knowledge'; true");
  await sleep(900);
  await cdp.eval(`(() => {
    const hit = [...document.querySelectorAll('.tree-item')].find((el) => (el.innerText || '').includes('排序自检分类'));
    if (hit) hit.click();
    return true;
  })()`);
  await sleep(800);
  const afterReload = await cdp.eval(listTitles);
  results.push({
    name: '重开后顺序还是拖完的样子（顺序真的落到库里了）',
    ok: JSON.stringify(afterReload) === JSON.stringify(afterDrag),
    detail: '重开=' + (Array.isArray(afterReload) ? afterReload.join('|') : afterReload)
  });
  const dragHint = await cdp.eval("(() => [...document.querySelectorAll('.muted')].some((e) => (e.innerText || '').includes('拖动卡片可以调顺序')))()");
  results.push({ name: '列表上方有「拖动卡片可以调顺序」的提示', ok: dragHint === true, detail: String(dragHint) });
  await cdp.shot('knowledge-reorder');

  // ---- 第五版阶段3：拖动跟手（拖动中无过渡 + 倾斜浮起）、落点线、松手回弹 ----
  const dragFeel = await cdp.eval(`(async () => {
    const rows = [...document.querySelectorAll('.kb-list-body .list-row')];
    if (rows.length < 2) return JSON.stringify({ err: 'few:' + rows.length });
    const src = rows[0];
    const dst = rows[1];
    const dt = new DataTransfer();
    const cursorHover = getComputedStyle(src).cursor;
    src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    await new Promise((r) => setTimeout(r, 90)); // 等 React 把 .dragging 挂上
    const cs = getComputedStyle(src);
    const box = dst.getBoundingClientRect();
    const init = { bubbles: true, dataTransfer: dt, clientX: box.left + 10, clientY: box.bottom - 3 };
    dst.dispatchEvent(new DragEvent('dragover', init));
    await new Promise((r) => setTimeout(r, 90)); // 等落点线挂上
    const pseudo = dst.className.includes('drop-after') ? '::after' : '::before';
    const pcs = getComputedStyle(dst, pseudo);
    const info = {
      cursorHover,
      dragging: src.className.includes('dragging'),
      transform: cs.transform,
      duration: cs.transitionDuration,
      cursorDrag: cs.cursor,
      dropCls: dst.className,
      lineH: pcs.height,
      lineBg: pcs.backgroundColor
    };
    src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
    return JSON.stringify(info);
  })()`);
  const feel = (() => {
    try {
      return JSON.parse(String(dragFeel));
    } catch {
      return { err: String(dragFeel) };
    }
  })();
  results.push({
    name: '第五版：可拖动的笔记行是「抓住」手型',
    ok: feel.cursorHover === 'grab',
    detail: 'cursor=' + feel.cursorHover + (feel.err ? ' err=' + feel.err : '')
  });
  results.push({
    name: '第五版：拖动中的卡片倾斜浮起、且没有过渡（跟手）',
    ok:
      feel.dragging === true &&
      feel.transform !== 'none' &&
      feel.transform !== undefined &&
      String(feel.duration)
        .split(',')
        .every((d) => d.trim() === '0s') &&
      feel.cursorDrag === 'grabbing',
    detail: 'transform=' + feel.transform + ' transition=' + feel.duration + ' cursor=' + feel.cursorDrag
  });
  results.push({
    name: '第五版：落点是 3px 品牌色圆头高亮线 + 目标行浅底',
    ok: (String(feel.dropCls).includes('drop-after') || String(feel.dropCls).includes('drop-before')) && feel.lineH === '3px',
    detail: 'class=' + feel.dropCls + ' 线高=' + feel.lineH + ' 色=' + feel.lineBg
  });
  const settle = await cdp.eval(`(async () => {
    const rows = [...document.querySelectorAll('.kb-list-body .list-row')];
    if (rows.length < 2) return JSON.stringify({ err: 'few' });
    const dt = new DataTransfer();
    const src = rows[0];
    const dst = rows[1];
    src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    const box = dst.getBoundingClientRect();
    const init = { bubbles: true, dataTransfer: dt, clientX: box.left + 10, clientY: box.bottom - 3 };
    dst.dispatchEvent(new DragEvent('dragover', init));
    dst.dispatchEvent(new DragEvent('drop', init));
    src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
    await new Promise((r) => setTimeout(r, 90));
    const hit = document.querySelector('.kb-list-body .list-row.drop-settling');
    return JSON.stringify({
      has: !!hit,
      anim: hit ? getComputedStyle(hit).animationName : 'none',
      transform: hit ? getComputedStyle(hit).transform : 'none'
    });
  })()`);
  const settled = (() => {
    try {
      return JSON.parse(String(settle));
    } catch {
      return { err: String(settle) };
    }
  })();
  results.push({
    name: '第五版：松手落位的卡片回弹一下（弹簧动画）',
    ok: settled.has === true && settled.anim === 'jw-settle',
    detail: 'animation=' + settled.anim + ' transform=' + settled.transform
  });

  // ---- 第五版阶段3：卡片毛玻璃 + 悬停浮起（真的把鼠标移上去读计算样式） ----
  await cdp.eval("location.hash = '/__bounce'; true");
  await sleep(250);
  await cdp.eval("location.hash = '/'; true");
  await sleep(800);
  const cardInfo = await cdp.eval(`(() => {
    const c = document.querySelector('.dash-grid .card');
    if (!c) return JSON.stringify({ err: 'no-card' });
    const b = c.getBoundingClientRect();
    const cs = getComputedStyle(c);
    return JSON.stringify({
      x: Math.round(b.left + b.width / 2),
      y: Math.round(b.top + 16),
      blur: cs.backdropFilter || cs.webkitBackdropFilter,
      before: cs.transform
    });
  })()`);
  const card = (() => {
    try {
      return JSON.parse(String(cardInfo));
    } catch {
      return { err: String(cardInfo) };
    }
  })();
  results.push({
    name: '第五版：卡片是毛玻璃（backdrop-filter 带模糊）',
    ok: String(card.blur).includes('blur'),
    detail: 'backdrop-filter=' + card.blur + (card.err ? ' err=' + card.err : '')
  });
  if (typeof card.x === 'number') {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: card.x, y: card.y });
    await sleep(520);
    const lifted = await cdp.eval(`(() => {
      const c = document.querySelector('.dash-grid .card');
      if (!c) return 'no-card';
      const m = new DOMMatrix(getComputedStyle(c).transform);
      return JSON.stringify({ dy: Math.round(m.m42 * 100) / 100, sx: Math.round(m.m11 * 10000) / 10000 });
    })()`);
    const lift = (() => {
      try {
        return JSON.parse(String(lifted));
      } catch {
        return { err: String(lifted) };
      }
    })();
    results.push({
      name: '第五版：鼠标移上去卡片浮起 translateY(-2px) scale(1.005)',
      ok: card.before === 'none' && Math.abs(Number(lift.dy) + 2) <= 0.05 && Math.abs(Number(lift.sx) - 1.005) < 0.001,
      detail: 'hover 前=' + card.before + ' hover 后 translateY=' + lift.dy + ' scaleX=' + lift.sx
    });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 4, y: 4 });
    await sleep(120);
  }
  await cdp.shot('home-card-hover');

  // ---- 第五版 阶段6：首页可视化（进度条 / 环形目标进度 / 完成与逾期配色 / 里程碑时间轴） ----
  // 先造一条逾期任务，让「已经逾期」那格真的亮起来，再回首页读 DOM
  const yDay = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  await cdp.eval(`(async () => {
    await window.api.invoke('task:create', { title: '逾期自检任务', due_at: ${JSON.stringify(yDay)}, priority: 'urgent' });
    return true;
  })()`);
  await cdp.eval("location.hash = '/tasks'; true");
  await sleep(500);
  await cdp.eval("location.hash = '/'; true");
  await sleep(1200);

  const homeViz = await cdp.eval(`(() => {
    const ring = document.querySelector('.goal-ring');
    const ringCS = ring ? getComputedStyle(ring) : null;
    const ringText = ring ? ((ring.querySelector('span') || {}).textContent || '').trim() : '';
    const overdue = document.querySelector('.list-row.overdue');
    const done = document.querySelector('.list-row.done');
    const doneCheck = done ? done.querySelector('.check') : null;
    const doneTitle = done ? done.querySelector('.title') : null;
    const bar = document.querySelector('.goal-row .progress > i');
    const alarmEl = document.querySelector('.stat.alarm');
    return JSON.stringify({
      ringBg: ringCS ? ringCS.backgroundImage : 'none',
      ringText: ringText,
      ringVar: ring ? (ring.style.getPropertyValue('--p') || '').trim() : 'none',
      overdueRow: !!overdue,
      overdueSub: overdue ? ((overdue.querySelector('.sub') || {}).textContent || '') : '',
      overdueMark: overdue ? getComputedStyle(overdue, '::before').backgroundColor : 'none',
      alarm: document.querySelectorAll('.stat.alarm').length,
      alarmAnim: alarmEl ? getComputedStyle(alarmEl).animationName : 'none',
      good: document.querySelectorAll('.stat.good').length,
      doneRow: !!done,
      doneCheckAnim: doneCheck ? getComputedStyle(doneCheck).animationName : 'none',
      doneTitleLine: doneTitle ? getComputedStyle(doneTitle).textDecorationLine : 'none',
      barGrad: bar ? getComputedStyle(bar).backgroundImage : 'none',
      barAnim: bar ? getComputedStyle(bar).animationName : 'none'
    });
  })()`);
  const viz = (() => {
    try {
      return JSON.parse(String(homeViz));
    } catch {
      return { err: String(homeViz) };
    }
  })();
  results.push({
    name: '第五版：首页目标进度是环形（conic-gradient + 环里带百分比）',
    ok:
      String(viz.ringBg).includes('conic-gradient') &&
      /^\d+%$/.test(String(viz.ringText)) &&
      String(viz.ringVar).endsWith('%'),
    detail:
      '背景=' + String(viz.ringBg).slice(0, 58) + ' 环里=' + viz.ringText + ' --p=' + viz.ringVar + (viz.err ? ' err=' + viz.err : '')
  });
  results.push({
    name: '第五版：逾期任务有红杠红字，逾期那格统计卡在呼吸',
    ok:
      viz.overdueRow === true &&
      String(viz.overdueSub).includes('已逾期') &&
      viz.alarm >= 1 &&
      String(viz.alarmAnim).includes('jw-alarm') &&
      String(viz.overdueMark).startsWith('rgb'),
    detail:
      '逾期行=' + viz.overdueRow + ' 副标题=' + viz.overdueSub + ' 红杠=' + viz.overdueMark + ' 呼吸动画=' + viz.alarmAnim
  });
  results.push({
    name: '第五版：完成项划掉并弹一下，进度条是渐变且从 0 长出来',
    ok:
      viz.doneRow === true &&
      String(viz.doneCheckAnim).includes('jw-pop') &&
      String(viz.doneTitleLine).includes('line-through') &&
      String(viz.barGrad).includes('gradient') &&
      String(viz.barAnim).includes('jw-grow') &&
      viz.good >= 1,
    detail:
      '完成行=' + viz.doneRow + ' 勾动画=' + viz.doneCheckAnim + ' 标题=' + viz.doneTitleLine + ' 进度条动画=' + viz.barAnim + ' 绿格=' + viz.good
  });
  await cdp.shot('home-visual');

  // 回到知识库，后面的分类断言要用这一页
  await cdp.eval("location.hash = '/knowledge'; true");
  await sleep(900);

  // ---- 优化项 7：分类排序按钮 + 非空分类删除拦截（界面） ----
  const upBtnCount = await cdp.eval("(() => document.querySelectorAll('.tree-item [title=\"上移\"]').length)()");
  const downBtnCount = await cdp.eval("(() => document.querySelectorAll('.tree-item [title=\"下移\"]').length)()");
  results.push({
    name: '每个分类行上都有「上移 / 下移」按钮',
    ok: Number(upBtnCount) >= 2 && Number(upBtnCount) === Number(downBtnCount),
    detail: '上移=' + upBtnCount + ' 下移=' + downBtnCount
  });

  const delClicked = await cdp.eval(`(() => {
    const row = [...document.querySelectorAll('.tree-item')].find((el) => (el.innerText || '').includes('排序自检分类'));
    if (!row) return 'no-row';
    const del = row.querySelector('[title="删除分类"]');
    if (!del) return 'no-del';
    del.click();
    return 'clicked';
  })()`);
  await sleep(400);
  const toastText = await cdp.eval("(() => [...document.querySelectorAll('.toast-wrap .toast')].map((e) => e.innerText).join(' | '))()");
  const stillRow = await cdp.eval("(() => [...document.querySelectorAll('.tree-item')].some((el) => (el.innerText || '').includes('排序自检分类')))()");
  results.push({
    name: '非空分类点删除会提示「请先移动或删除笔记」，分类还在',
    ok: delClicked === 'clicked' && String(toastText).includes('该分类下还有笔记') && stillRow === true,
    detail: delClicked + ' | 提示=' + String(toastText).slice(0, 60) + ' | 还在=' + stillRow
  });

  const upResult = await cdp.eval(`(() => {
    const rows = [...document.querySelectorAll('.tree-item')].filter((el) => el.querySelector('[title="上移"]'));
    if (rows.length < 2) return 'few';
    const row = rows[1];
    const name = (row.querySelector('.name') || {}).innerText || '';
    const before = rows.map((r) => ((r.querySelector('.name') || {}).innerText || ''));
    row.querySelector('[title="上移"]').click();
    return JSON.stringify({ name, before });
  })()`);
  await sleep(700);
  const treeOrder = await cdp.eval("(() => [...document.querySelectorAll('.tree-item')].filter((el) => el.querySelector('[title=\"上移\"]')).map((r) => ((r.querySelector('.name') || {}).innerText || '')))()");
  const upInfo = (() => {
    try {
      return JSON.parse(String(upResult));
    } catch {
      return { name: '', before: [] };
    }
  })();
  const beforeIdx = (upInfo.before || []).indexOf(upInfo.name);
  const afterIdx = Array.isArray(treeOrder) ? treeOrder.indexOf(upInfo.name) : -1;
  results.push({
    name: '点「上移」之后分类真的往上挪了一位',
    ok: beforeIdx > 0 && afterIdx === beforeIdx - 1,
    detail: JSON.stringify(upInfo.before) + ' → ' + JSON.stringify(treeOrder)
  });
  // ---- 分类工具栏的「＋子分类」（第三版补：不用悬停也能建子分类） ----
  await cdp.eval(`(() => {
    const row = [...document.querySelectorAll('.tree-item')].find((el) => (el.innerText || '').includes('全部笔记'));
    if (row) row.click();
    return true;
  })()`);
  await sleep(500);
  const childBtnOff = await cdp.eval(`(() => {
    const btn = document.querySelector('.cat-child-btn');
    if (!btn) return 'no-btn';
    return JSON.stringify({ disabled: btn.disabled, text: (btn.innerText || '').trim(), title: btn.title });
  })()`);
  const childBtnOffInfo = (() => {
    try {
      return JSON.parse(String(childBtnOff));
    } catch {
      return {};
    }
  })();
  results.push({
    name: '分类工具栏里有「＋子分类」按钮，没选具体分类时是禁用的',
    ok: childBtnOffInfo.disabled === true && String(childBtnOffInfo.text).includes('子分类'),
    detail: String(childBtnOff)
  });

  const childBtnPick = await cdp.eval(`(() => {
    const row = [...document.querySelectorAll('.tree-item')].find((el) => (el.innerText || '').includes('排序自检分类'));
    if (!row) return 'no-row';
    row.click();
    return 'clicked';
  })()`);
  await sleep(600);
  const childBtnState = await cdp.eval(`(() => {
    const btn = document.querySelector('.cat-child-btn');
    if (!btn) return 'no-btn';
    return JSON.stringify({ disabled: btn.disabled, title: btn.title });
  })()`);
  const childBtnStateInfo = (() => {
    try {
      return JSON.parse(String(childBtnState));
    } catch {
      return {};
    }
  })();
  results.push({
    name: '选中一个分类后「＋子分类」能点了，提示里带着这个分类的名字',
    ok:
      childBtnPick === 'clicked' &&
      childBtnStateInfo.disabled === false &&
      String(childBtnStateInfo.title).includes('排序自检分类'),
    detail: childBtnPick + ' | ' + String(childBtnState)
  });

  await cdp.eval(`(() => {
    const row = [...document.querySelectorAll('.tree-item')].find((el) => (el.innerText || '').includes('排序自检分类'));
    if (row) row.click();
    return true;
  })()`);
  await sleep(300);
  const childClickState = await cdp.eval(`(() => {
    const b = document.querySelector('.cat-child-btn');
    if (!b) return 'no-btn';
    const disabled = b.disabled;
    const title = b.title;
    b.click();
    return JSON.stringify({ disabled, title });
  })()`);
  await sleep(400);
  const childModal = await cdp.eval(`(() => {
    const modal = document.querySelector('.modal');
    if (!modal) return 'no-modal';
    return (modal.querySelector('.modal-head span') || {}).innerText || '';
  })()`);
  const childTyped = await cdp.eval(`(() => {
    const input = document.querySelector('.modal-body input.input');
    if (!input) return 'no-input';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, '工具栏子分类');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return input.value;
  })()`);
  await sleep(200);
  await cdp.eval("(() => { const b = document.querySelector('.modal-foot button.btn.primary'); if (b) b.click(); return true; })()");
  await sleep(800);
  const treeRaw = await cdp.eval("(async () => JSON.stringify(await window.api.invoke('category:tree')))()");
  const treeAfterToolbar = JSON.parse(String(treeRaw));
  const toolbarParent = treeAfterToolbar.find((c) => c.name === '排序自检分类') || null;
  const toolbarChild = treeAfterToolbar.find((c) => c.name === '工具栏子分类') || null;
  const toolbarChildVisible = await cdp.eval(
    "(() => [...document.querySelectorAll('.tree-item')].some((el) => (el.innerText || '').includes('工具栏子分类')))()"
  );
  results.push({
    name: '工具栏建的子分类挂对了父分类，并且立刻出现在树上',
    ok:
      String(childClickState).includes('"disabled":false') &&
      String(childModal).includes('新建子分类') &&
      childTyped === '工具栏子分类' &&
      !!toolbarChild &&
      !!toolbarParent &&
      toolbarChild.parent_id === toolbarParent.id &&
      toolbarChildVisible === true,
    detail:
      '点击时=' +
      String(childClickState) +
      ' | 弹窗=' +
      String(childModal) +
      ' | 输入=' +
      String(childTyped) +
      ' | parent_id=' +
      JSON.stringify(toolbarChild ? toolbarChild.parent_id : null) +
      ' 期望=' +
      JSON.stringify(toolbarParent ? toolbarParent.id : null) +
      ' | 界面上=' +
      toolbarChildVisible
  });

  await cdp.shot('knowledge-category-tree');

  // ---- 第三版：富文本编辑器的界面行为 ----
  await cdp.eval("location.hash = '/__bounce'; true");
  await sleep(250);
  await cdp.eval("location.hash = '/knowledge'; true");
  await sleep(800);
  const formOpen = await cdp.eval(`(() => {
    const rows = [...document.querySelectorAll('.list-row')];
    const row = rows.find((r) => (r.innerText || '').includes('富文本自检'));
    if (!row) return 'no-row/' + rows.length;
    row.click();
    return 'clicked';
  })()`);
  await sleep(700);
  const editorState = await cdp.eval(`(() => {
    const bar = document.querySelector('.rt-toolbar');
    const ed = document.querySelector('.rt-editor');
    return JSON.stringify({ open: ${JSON.stringify(formOpen)}, bar: !!bar, btns: bar ? bar.querySelectorAll('button').length : 0, editable: !!ed && ed.getAttribute('contenteditable') === 'true' });
  })()`);
  const es = JSON.parse(String(editorState));
  results.push({ name: '点开笔记后出现富文本工具栏', ok: es.open === 'clicked' && es.bar && es.btns >= 8, detail: String(editorState) });
  results.push({ name: '正文区是可编辑的富文本容器', ok: es.editable === true, detail: String(editorState) });
  await cdp.shot('knowledge-rich');

  // ---- 第五版阶段4：工具条毛玻璃 + 正文「纸」不透明（对比度优先） ----
  const editorPaper = await cdp.eval(`(() => {
    const bar = document.querySelector('.rt-toolbar');
    const body = document.querySelector('.editor-body');
    const ed = document.querySelector('.rt-editor');
    if (!bar || !body || !ed) return JSON.stringify({ err: 'no-editor' });
    const parse = (s) => {
      const m = String(s).match(/rgba?\\(([^)]+)\\)/);
      if (!m) return null;
      const p = m[1].split(',').map((x) => parseFloat(x));
      return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
    };
    const lum = (c) => {
      const f = (v) => {
        const x = v / 255;
        return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
    };
    const cs = getComputedStyle(bar);
    const barBg = parse(cs.backgroundColor);
    const bodyBg = parse(getComputedStyle(body).backgroundColor);
    const fg = parse(getComputedStyle(ed).color);
    let ratio = 0;
    if (bodyBg && fg) {
      const l1 = lum(bodyBg);
      const l2 = lum(fg);
      ratio = Math.round(((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)) * 10) / 10;
    }
    return JSON.stringify({
      blur: cs.backdropFilter || cs.webkitBackdropFilter,
      barBg: cs.backgroundColor,
      barAlpha: barBg ? barBg.a : null,
      bodyBg: getComputedStyle(body).backgroundColor,
      bodyAlpha: bodyBg ? bodyBg.a : null,
      fg: getComputedStyle(ed).color,
      ratio
    });
  })()`);
  const paper = (() => {
    try {
      return JSON.parse(String(editorPaper));
    } catch {
      return { err: String(editorPaper) };
    }
  })();
  results.push({
    name: '第五版：编辑器工具条是毛玻璃（模糊 + 半透明底）',
    ok: String(paper.blur).includes('blur') && typeof paper.barAlpha === 'number' && paper.barAlpha < 1,
    detail: 'backdrop=' + paper.blur + ' 底色=' + paper.barBg + (paper.err ? ' err=' + paper.err : '')
  });
  results.push({
    name: '第五版：正文那块「纸」保持不透明（不跟着毛玻璃透）',
    ok: paper.bodyAlpha === 1,
    detail: '正文底色=' + paper.bodyBg
  });
  results.push({
    name: '第五版：正文对比度够长读（≥ 12:1）',
    ok: Number(paper.ratio) >= 12,
    detail: '底色=' + paper.bodyBg + ' 字色=' + paper.fg + ' 对比度=' + paper.ratio + ':1'
  });

  // ---- 第五版阶段5：按钮与输入框六态（默认 / 悬停 / 按下 / 聚焦 / 禁用 / 加载） ----
  const pickSave = "[...document.querySelectorAll('.editor-head button')].find((b) => (b.textContent || '').includes('保存'))";
  const btnDefaultRaw = await cdp.eval(`(() => {
    const b = ${pickSave};
    if (!b) return JSON.stringify({ err: 'no-btn' });
    const r = b.getBoundingClientRect();
    const cs = getComputedStyle(b);
    return JSON.stringify({
      x: Math.round(r.left + r.width / 2),
      y: Math.round(r.top + r.height / 2),
      bg: cs.backgroundColor,
      border: cs.borderTopWidth + ' ' + cs.borderTopColor,
      radius: cs.borderTopLeftRadius,
      shadow: cs.boxShadow
    });
  })()`);
  const btn = (() => {
    try {
      return JSON.parse(String(btnDefaultRaw));
    } catch {
      return { err: String(btnDefaultRaw) };
    }
  })();
  results.push({
    name: '第五版：按钮默认态有底色 / 描边 / 圆角',
    ok: btn.bg !== 'rgba(0, 0, 0, 0)' && btn.radius !== '0px' && !btn.err,
    detail: '底色=' + btn.bg + ' 描边=' + btn.border + ' 圆角=' + btn.radius + (btn.err ? ' err=' + btn.err : '')
  });
  if (typeof btn.x === 'number') {
    const readHover = async () => {
      const hoverRaw = await cdp.eval(`(() => {
        const b = ${pickSave};
        const cs = getComputedStyle(b);
        const m = new DOMMatrix(cs.transform);
        return JSON.stringify({ bg: cs.backgroundColor, ty: Math.round(m.m42 * 100) / 100 });
      })()`);
      try {
        return JSON.parse(String(hoverRaw));
      } catch {
        return { err: String(hoverRaw) };
      }
    };
    // 软件渲染下 mouseMoved 偶尔丢一次，所以「移开 → 移回」最多试三遍
    let hov = { bg: btn.bg, ty: 0 };
    for (let i = 0; i < 3; i += 1) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 4, y: 4, buttons: 0 });
      await sleep(70);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: btn.x, y: btn.y, buttons: 0 });
      await sleep(240);
      hov = await readHover();
      if (hov.bg !== btn.bg && hov.ty === -1) break;
    }
    results.push({
      name: '第五版：悬停态换底色 + 抬 1px',
      ok: hov.bg !== btn.bg && hov.ty === -1,
      detail: '底色 ' + btn.bg + ' → ' + hov.bg + '，位移 ' + hov.ty + 'px' + (hov.err ? ' err=' + hov.err : '')
    });
    // 按下：CDP 的 mousePressed 偶尔不会立刻挂上 :active，读不到就再按一次
    const readPress = async () => {
      const raw = await cdp.eval(`(() => {
        const b = ${pickSave};
        const m = new DOMMatrix(getComputedStyle(b).transform);
        return JSON.stringify({ sx: Math.round(m.m11 * 1000) / 1000, sy: Math.round(m.m22 * 1000) / 1000 });
      })()`);
      try {
        return JSON.parse(String(raw));
      } catch {
        return { sx: 1, sy: 1, err: String(raw) };
      }
    };
    let press = { sx: 1, sy: 1 };
    for (let attempt = 0; attempt < 4; attempt++) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: btn.x, y: btn.y, buttons: 0 });
      await sleep(120);
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: btn.x,
        y: btn.y,
        button: 'left',
        buttons: 1,
        clickCount: 1
      });
      await sleep(180);
      press = await readPress();
      if (Math.abs(Number(press.sx) - 0.97) < 0.02) break;
      // CDP 的 mousePressed 偶尔挂不上 :active —— 松手移开再来一次
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: 4,
        y: 4,
        button: 'left',
        buttons: 0,
        clickCount: 1
      });
      await sleep(160);
    }
    // 松手丢到窗口角落，避免真的点到「保存」（这一步只验手感）
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: 4,
      y: 4,
      button: 'left',
      buttons: 0,
      clickCount: 1
    });
    await sleep(200);
    results.push({
      name: '第五版：按下态缩到 0.97（「按进去」的手感）',
      ok: Math.abs(Number(press.sx) - 0.97) < 0.02,
      detail: '按下时 scaleX=' + press.sx + ' scaleY=' + press.sy
    });
  }

  const focusRaw = await cdp.eval(`(async () => {
    const inp = document.querySelector('.editor-foot input') || document.querySelector('.kb-list-head input');
    if (!inp) return JSON.stringify({ err: 'no-input' });
    inp.focus();
    await new Promise((r) => setTimeout(r, 140));
    const cs = getComputedStyle(inp);
    return JSON.stringify({ focused: document.activeElement === inp, border: cs.borderTopColor, shadow: cs.boxShadow });
  })()`);
  const focusRing = (() => {
    try {
      return JSON.parse(String(focusRaw));
    } catch {
      return { err: String(focusRaw) };
    }
  })();
  results.push({
    name: '第五版：输入框聚焦态有品牌色描边 + 光环',
    ok: focusRing.focused === true && String(focusRing.shadow) !== 'none',
    detail: '描边=' + focusRing.border + ' 光环=' + focusRing.shadow + (focusRing.err ? ' err=' + focusRing.err : '')
  });

  let kbRing = { err: 'none' };
  for (let i = 0; i < 8; i += 1) {
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key: 'Tab',
      code: 'Tab',
      windowsVirtualKeyCode: 9,
      nativeVirtualKeyCode: 9
    });
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Tab',
      code: 'Tab',
      windowsVirtualKeyCode: 9,
      nativeVirtualKeyCode: 9
    });
    await sleep(120);
    const raw = await cdp.eval(`(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return JSON.stringify({ err: 'body' });
      const cs = getComputedStyle(el);
      return JSON.stringify({
        tag: el.tagName + (el.className ? '.' + String(el.className).split(' ')[0] : ''),
        fv: el.matches(':focus-visible'),
        shadow: cs.boxShadow
      });
    })()`);
    const got = (() => {
      try {
        return JSON.parse(String(raw));
      } catch {
        return { err: String(raw) };
      }
    })();
    kbRing = got;
    if (got.fv === true && String(got.shadow) !== 'none' && String(got.shadow) !== '') break;
  }
  results.push({
    name: '第五版：键盘 Tab 聚焦时画 :focus-visible 光环',
    ok: kbRing.fv === true && String(kbRing.shadow) !== 'none',
    detail: JSON.stringify(kbRing)
  });

  const stateStylesRaw = await cdp.eval(`(() => {
    const mk = (cls, off) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = cls;
      b.textContent = '自检按钮';
      if (off) b.setAttribute('disabled', 'disabled');
      document.body.appendChild(b);
      return b;
    };
    const d = mk('btn', true);
    const dcs = getComputedStyle(d);
    const dis = { opacity: dcs.opacity, cursor: dcs.cursor, shadow: dcs.boxShadow };
    d.remove();
    const l = mk('btn loading', false);
    const lcs = getComputedStyle(l, '::before');
    const load = {
      w: lcs.width,
      h: lcs.height,
      anim: lcs.animationName,
      iter: lcs.animationIterationCount,
      radius: lcs.borderTopLeftRadius,
      cursor: getComputedStyle(l).cursor
    };
    l.remove();
    return JSON.stringify({ dis, load });
  })()`);
  const st = (() => {
    try {
      return JSON.parse(String(stateStylesRaw));
    } catch {
      return { err: String(stateStylesRaw) };
    }
  })();
  results.push({
    name: '第五版：禁用态 45% 透明 + not-allowed + 无投影',
    ok: st.dis && st.dis.opacity === '0.45' && st.dis.cursor === 'not-allowed' && st.dis.shadow === 'none',
    detail: JSON.stringify(st.dis)
  });
  results.push({
    name: '第五版：加载态是 12px 转圈（无限循环，按钮不变宽）',
    ok: st.load && st.load.w === '12px' && st.load.h === '12px' && st.load.anim === 'jw-spin' && st.load.iter === 'infinite',
    detail: JSON.stringify(st.load)
  });

  // ---- 侧栏折叠/展开：宽度插值平滑、文字不再「闪一下」（回归断言） ----
  const sbRead = async () =>
    JSON.parse(
      String(
        await cdp.eval(`(() => {
          const sb = document.querySelector('.sidebar');
          const lb = document.querySelector('.nav-label');
          const bt = document.querySelector('.brand-text');
          const wl = document.querySelector('.brand .win-lights');
          const mk = document.querySelector('.brand-mark');
          if (!sb) return JSON.stringify({ err: 'no-sidebar' });
          const cs = lb ? getComputedStyle(lb) : null;
          const sbBox = sb.getBoundingClientRect();
          const wlBox = wl ? wl.getBoundingClientRect() : null;
          const mkBox = mk ? mk.getBoundingClientRect() : null;
          const dots = [...document.querySelectorAll('.brand .win-light')].map((d) => {
            const b = d.getBoundingClientRect();
            return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width) };
          });
          return JSON.stringify({
            w: Math.round(sbBox.width),
            labelW: lb ? Math.round(lb.getBoundingClientRect().width) : -1,
            labelOpacity: cs ? Number(cs.opacity) : -1,
            labelText: lb ? lb.textContent : '',
            brandW: bt ? Math.round(bt.getBoundingClientRect().width) : -1,
            lightsW: wlBox ? Math.round(wlBox.width) : -1,
            lightsH: wlBox ? Math.round(wlBox.height) : -1,
            dots,
            markW: mkBox ? Math.round(mkBox.width) : -1,
            markOverflow: mkBox ? Math.round(mkBox.right - sbBox.right) : 999
          });
        })()`)
      )
    );
  const expandedState = await sbRead();
  // 点「收起侧栏」：点一下不一定生效（软件渲染下偶发丢一次点击），最多补点到状态对上为止
  const toggleSidebar = async (wantCollapsed) => {
    for (let i = 0; i < 5; i++) {
      const st = await sbRead();
      const okNow = wantCollapsed ? st.w <= 64 : st.w > 64;
      if (okNow) return true;
      await cdp.eval("(() => { const b = document.querySelector('.nav-foot .icon-btn'); if (b) b.click(); return !!b; })()");
      await sleep(520);
    }
    return false;
  };
  await toggleSidebar(true);
  await sleep(120);
  const collapsedState = await sbRead();
  await cdp.shot('sidebar-collapsed');
  // 文字节点必须一直留在 DOM 里（不是「展开时才挂上」）——这就是闪烁的根因
  const labelStaysInDom = collapsedState.labelText.includes('首页');
  // 展开过程本身是「逐帧插值」的：宽度与文字宽度都有过渡曲线。
  // 注意：e2e 是 --disable-gpu 跑的（软件渲染，帧率不可信），所以这里断言的是
  // 「过渡接线正确 + 宽度单调长回去」，不用帧率判断是否顺滑。
  const wiring = JSON.parse(
    String(
      await cdp.eval(`(() => {
        const p = (el) => {
          const c = el ? getComputedStyle(el) : null;
          return c ? c.transitionProperty + ' @ ' + c.transitionDuration : '';
        };
        return JSON.stringify({
          side: p(document.querySelector('.sidebar')),
          label: p(document.querySelector('.nav-label')),
          lights: p(document.querySelector('.brand .win-lights')),
          dot: p(document.querySelector('.brand .win-light'))
        });
      })()`)
    )
  );
  const midRaw = await cdp.eval(`(async () => {
    const sb = document.querySelector('.sidebar');
    let seen = [];
    // 侧栏此刻应当是收起的；点一下展开并录帧。万一这一下丢了，最多重试 3 次再录。
    for (let attempt = 0; attempt < 3; attempt++) {
      const w0 = Math.round(sb.getBoundingClientRect().width);
      seen = [w0];
      const t0 = performance.now();
      document.querySelector('.nav-foot .icon-btn').click();
      await new Promise((res) => {
        const tick = () => {
          seen.push(Math.round(sb.getBoundingClientRect().width));
          if (performance.now() - t0 > 260) res();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      if (Math.max(...seen) > w0) break;
      await new Promise((r) => setTimeout(r, 240));
    }
    return JSON.stringify(seen);
  })()`);
  const midFrames = (() => {
    try {
      return JSON.parse(String(midRaw));
    } catch {
      return [];
    }
  })();
  await sleep(200);
  const backState = await sbRead();
  await cdp.shot('sidebar-expanded');
  const grew = midFrames.every((w, i) => i === 0 || w >= midFrames[i - 1] - 1);
  const sideWired = wiring.side.includes('width') && wiring.side.includes('flex-basis');
  const labelWired = wiring.label.includes('max-width');
  const dotsWired = wiring.dot.includes('transform');
  // 三个点：折叠时同一列（x 相同、y 逐颗往下），展开时同一排（y 相同、x 逐颗往右）
  const dotsColumn = (st) =>
    Array.isArray(st.dots) &&
    st.dots.length === 3 &&
    st.dots.every((d) => Math.abs(d.x - st.dots[0].x) <= 2) &&
    st.dots[1].y - st.dots[0].y >= 14 &&
    st.dots[2].y - st.dots[1].y >= 14;
  const dotsRow = (st) =>
    Array.isArray(st.dots) &&
    st.dots.length === 3 &&
    st.dots.every((d) => Math.abs(d.y - st.dots[0].y) <= 2) &&
    st.dots[1].x - st.dots[0].x >= 14 &&
    st.dots[2].x - st.dots[1].x >= 14;
  const dotsText = (st) => (st.dots || []).map((d) => `(${d.x},${d.y})`).join(' ');
  results.push({
    name: '第五版：收起侧栏后文字收成 0 宽度（不是卸载），三个点竖排留在品牌上方',
    ok:
      collapsedState.w > 0 &&
      collapsedState.w <= 64 &&
      collapsedState.labelW <= 1 &&
      collapsedState.labelOpacity <= 0.05 &&
      labelStaysInDom &&
      dotsColumn(collapsedState) &&
      collapsedState.lightsW <= 16 &&
      collapsedState.markW >= 24 &&
      collapsedState.markOverflow <= 1,
    detail: `宽 ${collapsedState.w}px 文字宽 ${collapsedState.labelW}px 透明度 ${collapsedState.labelOpacity} 三点坐标 ${dotsText(collapsedState)}（竖排） 容器 ${collapsedState.lightsW}×${collapsedState.lightsH}px 图标宽 ${collapsedState.markW}px 右侧溢出 ${collapsedState.markOverflow}px 文字仍在DOM=${labelStaysInDom}`
  });
  results.push({
    name: '第五版：展开是插值动画（侧栏宽度 / 文字宽度 / 三个点走 transform），三点回到一排',
    ok:
      sideWired &&
      labelWired &&
      dotsWired &&
      grew &&
      backState.w >= 200 &&
      backState.labelW > 20 &&
      backState.labelOpacity === 1 &&
      dotsRow(backState),
    detail: `侧栏[${wiring.side}] 文字[${wiring.label}] 三点容器[${wiring.lights}] 每个点[${wiring.dot}] 宽度轨迹 ${midFrames.slice(0, 8).join('→')} 回到 ${backState.w}px / 文字 ${backState.labelW}px / 三点坐标 ${dotsText(backState)}（一排）`
  });

  // ---- 展开态不弹任何导航提示；折叠态悬停才浮出毛玻璃气泡（用户反馈第 2、3 条） ----
  const tipRead = async () =>
    JSON.parse(
      String(
        await cdp.eval(`(() => {
          const it = document.querySelector('.nav-item');
          if (!it) return JSON.stringify({ err: 'no-nav' });
          const cs = getComputedStyle(it, '::after');
          const b = it.getBoundingClientRect();
          return JSON.stringify({
            title: it.getAttribute('title') || '',
            dataTip: it.getAttribute('data-tip') || '',
            content: (cs.content || '').replace(/"/g, ''),
            opacity: Number(cs.opacity),
            delay: cs.transitionDelay,
            transform: cs.transform,
            backdrop: cs.backdropFilter || cs.webkitBackdropFilter || '',
            radius: cs.borderTopLeftRadius,
            sidebarOverflow: getComputedStyle(document.querySelector('.sidebar')).overflow,
            navOverflow: getComputedStyle(document.querySelector('.nav')).overflowY,
            cx: Math.round(b.left + b.width / 2),
            cy: Math.round(b.top + b.height / 2)
          });
        })()`)
      )
    );
  const hoverNav = async (st) => {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: st.cx, y: st.cy, buttons: 0 });
    await sleep(620);
    return tipRead();
  };
  const expandedTip = await hoverNav(await tipRead());
  await toggleSidebar(true);
  await sleep(120);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 4, y: 4, buttons: 0 });
  await sleep(120);
  const collapsedTip = await hoverNav(await tipRead());
  // 气泡现在真能从 60px 侧栏里探出来（.nav 放开裁剪 + 侧栏抬层级），
  // 所以这张截图就是真实的悬停态，不需要任何临时注入
  await cdp.shot('sidebar-nav-tip');
  // 复位成展开态，后面的断言仍按展开的侧栏走
  await cdp.eval(`document.querySelector('.nav-foot .icon-btn').click()`);
  await sleep(420);
  results.push({
    name: '第五版：不再弹系统提示（title 已去掉），只有折叠态才有毛玻璃气泡',
    ok:
      expandedTip.title === '' &&
      expandedTip.dataTip.length > 0 &&
      expandedTip.opacity === 0 &&
      collapsedTip.content === collapsedTip.dataTip &&
      collapsedTip.opacity === 1 &&
      collapsedTip.backdrop.includes('blur') &&
      collapsedTip.radius !== '0px' &&
      collapsedTip.sidebarOverflow === 'visible' &&
      collapsedTip.navOverflow === 'visible' &&
      parseFloat(collapsedTip.delay) >= 0.3,
    detail: `title="${expandedTip.title}" data-tip="${expandedTip.dataTip}"；展开态 opacity=${expandedTip.opacity}；折叠态 content="${collapsedTip.content}" opacity=${collapsedTip.opacity} 延迟=${collapsedTip.delay} 圆角=${collapsedTip.radius} 背景模糊=${collapsedTip.backdrop} 侧栏溢出=${collapsedTip.sidebarOverflow} 导航列溢出=${collapsedTip.navOverflow}`
  });

  const tableInUi = await cdp.eval(`(async () => {
    const btn = [...document.querySelectorAll('.rt-toolbar button')].find((b) => b.title === '插入表格');
    if (!btn) return 'no-btn';
    btn.click();
    await new Promise((r) => setTimeout(r, 350));
    const head = document.querySelector('.modal-head');
    const insert = [...document.querySelectorAll('.modal-foot button')].find((b) => (b.textContent || '').trim() === '插入');
    if (!insert) return 'no-insert:' + (head && head.textContent);
    insert.click();
    await new Promise((r) => setTimeout(r, 350));
    const ed = document.querySelector('.rt-editor');
    const hasTable = !!ed && ed.innerHTML.includes('<table');
    // 把光标放进第一个单元格，工具栏才会亮出「＋行 / －行 / ＋列 / －列」
    const cell = ed && ed.querySelector('td');
    if (cell) {
      const rng = document.createRange();
      rng.selectNodeContents(cell);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(rng);
      document.dispatchEvent(new Event('selectionchange'));
      await new Promise((r) => setTimeout(r, 300));
    }
    const buttons = [...document.querySelectorAll('.rt-toolbar button')].map((b) => (b.title || '') + (b.textContent || '').trim());
    const rows = buttons.filter((t) => t.includes('行')).length;
    const cols = buttons.filter((t) => t.includes('列')).length;
    return (head && head.textContent) + '|table=' + hasTable + '|rowBtn=' + rows + '|colBtn=' + cols;
  })()`);
  results.push({
    name: '工具栏能插入表格、光标进单元格后多出增删行列按钮',
    ok: /table=true/.test(String(tableInUi)) && /colBtn=2/.test(String(tableInUi)) && /rowBtn=2/.test(String(tableInUi)),
    detail: String(tableInUi)
  });

  const boldInUi = await cdp.eval(`(async () => {
    const ed = document.querySelector('.rt-editor');
    if (!ed) return 'no-editor';
    ed.focus();
    ed.innerHTML = '<p>界面自检正文</p>';
    ed.dispatchEvent(new Event('input', { bubbles: true }));
    const rng = document.createRange();
    rng.selectNodeContents(ed.querySelector('p'));
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(rng);
    const b = [...document.querySelectorAll('.rt-toolbar button')].find((x) => x.title && x.title.indexOf('加粗') === 0);
    if (!b) return 'no-bold';
    b.click();
    await new Promise((r) => setTimeout(r, 250));
    return ed.innerHTML;
  })()`);
  results.push({
    name: '选中文字点「加粗」真的会加粗',
    ok: /<(b|strong)[^>]*>界面自检正文/.test(String(boldInUi).replace(/\s+/g, '')),
    detail: String(boldInUi).slice(0, 90)
  });

  const savedInUi = await cdp.eval(`(async () => {
    const fab = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim().includes('保存') && !b.disabled);
    if (!fab) return 'no-save-btn';
    fab.click();
    await new Promise((r) => setTimeout(r, 800));
    return (fab.textContent || '').trim();
  })()`);
  results.push({ name: '编辑器上的保存按钮能用', ok: /已保存|保存/.test(String(savedInUi)), detail: String(savedInUi) });

  const colorInUi = await cdp.eval(`(async () => {
    const ed = document.querySelector('.rt-editor');
    if (!ed) return 'no-editor';
    const rng = document.createRange();
    rng.selectNodeContents(ed);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(rng);
    document.dispatchEvent(new Event('selectionchange'));
    await new Promise((r) => setTimeout(r, 200));
    const click = (title) => {
      const b = [...document.querySelectorAll('.rt-toolbar button')].find((x) => x.title === title);
      if (b) b.click();
      return !!b;
    };
    click('字体颜色');
    await new Promise((r) => setTimeout(r, 220));
    const sw = document.querySelector('.color-pop .swatch');
    if (!sw) return 'no-swatch';
    sw.click();
    await new Promise((r) => setTimeout(r, 260));
    const afterText = ed.innerHTML;
    click('背景高亮');
    await new Promise((r) => setTimeout(r, 220));
    const sw2 = document.querySelector('.color-pop .swatch');
    if (sw2) sw2.click();
    await new Promise((r) => setTimeout(r, 260));
    const afterBg = ed.innerHTML;
    const save = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '保存');
    const saveLabel = save ? save.textContent : 'no-save';
    if (save) save.click();
    await new Promise((r) => setTimeout(r, 900));
    const rows = await window.api.invoke('note:list', { q: '富文本自检' });
    const row = (rows || []).find((n) => n.title === '富文本自检');
    const full = row ? await window.api.invoke('note:get', { id: row.id }) : null;
    return JSON.stringify({ afterText: afterText.slice(0, 130), afterBg: afterBg.slice(0, 170), saved: full ? String(full.content_html).slice(0, 200) : 'no-note', saveLabel });
  })()`);
  const cs = JSON.parse(String(colorInUi));
  results.push({ name: '选中文字能改字体颜色', ok: /color:/i.test(String(cs.afterText)), detail: String(cs.afterText) });
  results.push({ name: '选中文字能加背景高亮', ok: /background-color/i.test(String(cs.afterBg)), detail: String(cs.afterBg) });
  results.push({
    name: '颜色和高亮保存后还在库里（没被清洗规则吃掉）',
    ok: /color:/i.test(String(cs.saved)) && /background-color/i.test(String(cs.saved)),
    detail: String(cs.saved)
  });

  // 主题切换也过一遍
  await cdp.eval("location.hash = '/settings'; true");
  await sleep(400);
  const darkOk = await cdp.eval(
    `(async () => {
      const sel = [...document.querySelectorAll('select')].find((s) => [...s.options].some((o) => o.value === 'dark'));
      if (!sel) return '找不到主题下拉框';
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
      setter.call(sel, 'dark');
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 500));
      return document.documentElement.getAttribute('data-theme') + '|' + (localStorage.getItem('theme') ?? '');
    })()`
  );
  results.push({ name: '深色主题能切换', ok: String(darkOk).startsWith('dark'), detail: String(darkOk) });
  await cdp.shot('settings-dark');

  // ---- 第五版（阶段8）：深浅色过渡与记忆 ----
  const themeAnim = await cdp.eval(`(async () => {
    const sel = [...document.querySelectorAll('select')].find((s) => [...s.options].some((o) => o.value === 'dark'));
    if (!sel) return JSON.stringify({ err: '找不到主题下拉框' });
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    const root = document.documentElement;
    const flip = async (v) => {
      setter.call(sel, v);
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 60));
    };
    const mirror = () => { try { return localStorage.getItem('jw-theme') || ''; } catch { return 'denied'; } };
    await flip('light');
    await new Promise((r) => setTimeout(r, 420));
    await flip('dark');
    const during = {
      cls: root.classList.contains('theme-transitioning'),
      dur: getComputedStyle(document.body).transitionDuration,
      theme: root.getAttribute('data-theme'),
      boot: root.dataset.themeBoot || '',
      query: new URLSearchParams(location.search).get('theme') || '',
      mirror: mirror()
    };
    await new Promise((r) => setTimeout(r, 460));
    during.afterCls = root.classList.contains('theme-transitioning');
    during.mirrorAfter = mirror();
    return JSON.stringify(during);
  })()`);
  const ta = JSON.parse(String(themeAnim));
  results.push({
    name: '第五版：切深浅色时挂 0.3s 全局过渡，之后自己摘掉',
    ok: ta.cls === true && String(ta.dur).indexOf('0.3s') === 0 && ta.afterCls === false && ta.theme === 'dark',
    detail: `切换中 class=${ta.cls} 过渡=${ta.dur} 主题=${ta.theme} 460ms 后 class=${ta.afterCls}`
  });
  results.push({
    name: '第五版：主题记得住（首帧就用存下来的主题，改动同步镜像）',
    ok: (ta.boot === 'light' || ta.boot === 'dark') && ta.query === ta.boot && ta.mirrorAfter === 'dark',
    detail: `URL 里的主题=${ta.query} 首帧记号=${ta.boot} 镜像=${ta.mirror}→${ta.mirrorAfter}`
  });

  // ---- 第五版（阶段8 修正）：「放弃改动」要把「边选边预览」的主题也退回去 ----
  const discardTest = await cdp.eval(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    const root = document.documentElement;
    const themeSel = () => [...document.querySelectorAll('select')].find((s) => [...s.options].some((o) => o.value === 'dark'));
    const savedTheme = (await window.api.invoke('settings:get')).theme;
    const sel = themeSel();
    if (!sel) return JSON.stringify({ err: '找不到主题下拉框' });
    const other = savedTheme === 'dark' ? 'light' : 'dark';
    setter.call(sel, other);
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(420);
    const preview = root.getAttribute('data-theme');
    const btn = [...document.querySelectorAll('.save-bar button')].find((b) => (b.textContent || '').includes('放弃'));
    if (!btn) return JSON.stringify({ err: '没有「放弃改动」按钮' });
    btn.click();
    await wait(460);
    const mirror = () => { try { return localStorage.getItem('jw-theme') || ''; } catch { return 'denied'; } };
    const now = themeSel();
    return JSON.stringify({ savedTheme, other, preview, after: root.getAttribute('data-theme'), selNow: now ? now.value : '', mirror: mirror() });
  })()`);
  const dt = JSON.parse(String(discardTest));
  results.push({
    name: '第五版：放弃改动会把主题预览也退回上次保存的那个',
    ok:
      !dt.err &&
      dt.preview === dt.other &&
      dt.after === dt.savedTheme &&
      dt.selNow === dt.savedTheme &&
      dt.mirror === dt.savedTheme,
    detail: `库里=${dt.savedTheme} 预览=${dt.preview} 放弃后=${dt.after} 下拉=${dt.selNow} 镜像=${dt.mirror}`
  });

  // ---- 优化项 8：四个页面都有「保存」按钮，点了会报「已保存 HH:MM:SS」 ----
  // 知识库：先点开一篇笔记，编辑器头部才有「保存」
  await cdp.eval("location.hash = '/knowledge'; true");
  await sleep(700);
  const kbOpened = await cdp.eval(`(() => {
    const row = document.querySelector('.list-row');
    if (!row) return 'no-row';
    row.click();
    return 'clicked';
  })()`);
  await sleep(700);
  const kbSave = await cdp.eval(
    "(() => { const b = [...document.querySelectorAll('.editor-head button')].find((x) => (x.textContent || '').trim().indexOf('保存') === 0 && !x.disabled); return b ? (b.textContent || '').trim() : 'no-btn'; })()"
  );
  results.push({
    name: '笔记编辑页有「保存」按钮',
    ok: kbOpened === 'clicked' && String(kbSave).startsWith('保存'),
    detail: kbOpened + '/' + kbSave
  });

  await cdp.eval("location.hash = '/goals'; true");
  await sleep(700);
  const goalSave = await cdp.eval(
    "(() => { const b = [...document.querySelectorAll('.editor-head button')].find((x) => (x.textContent || '').trim().indexOf('保存') === 0 && !x.disabled); return b ? (b.textContent || '').trim() : 'no-btn'; })()"
  );
  results.push({ name: '目标编辑页有「保存」按钮', ok: String(goalSave).startsWith('保存'), detail: String(goalSave) });

  // ---- 第五版 阶段6：里程碑时间轴 ----
  const msOpened = await cdp.eval(`(() => {
    const row = [...document.querySelectorAll('.tree-item')].find((el) =>
      ((el.querySelector('.name') || {}).textContent || '').includes('把知识库用起来')
    );
    if (!row) return 'no-row';
    row.click();
    return 'clicked';
  })()`);
  await sleep(900);
  // 时间轴要「走过的段是绿的、没走的是灰的」，所以补两个还没完成的检查点
  const msAdded = await cdp.eval(`(() => {
    const input = [...document.querySelectorAll('input')].find((i) => (i.placeholder || '').includes('加一个里程碑'));
    if (!input) return 'no-input';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    const add = async (title) => {
      setter.call(input, title);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await new Promise((r) => setTimeout(r, 700));
    };
    return (async () => {
      await add('第 2 个检查点：跑通一次完整复习');
      await add('第 3 个检查点：连续记满一周');
      return 'added-2';
    })();
  })()`);
  await sleep(1100);
  const tlRaw = await cdp.eval(`(() => {
    const list = document.querySelector('.timeline');
    if (!list) return JSON.stringify({ timeline: false });
    const rows = [...list.querySelectorAll('.list-row')];
    const stats = rows.map((r, i) => {
      const cs = getComputedStyle(r, '::before');
      return {
        done: r.classList.contains('done'),
        last: i === rows.length - 1,
        display: cs.display,
        w: parseFloat(cs.width) || 0,
        bg: cs.backgroundColor,
        bgImg: cs.backgroundImage
      };
    });
    const visible = stats.filter((s) => !s.last && s.display !== 'none' && s.w >= 1);
    return JSON.stringify({
      timeline: true,
      rows: rows.length,
      done: stats.filter((s) => s.done).length,
      grey: visible.filter((s) => s.bg !== 'rgba(0, 0, 0, 0)' && !String(s.bgImg).includes('gradient')).length,
      green: visible.filter((s) => String(s.bgImg).includes('gradient')).length,
      lineW: visible[0] ? visible[0].w : 0,
      doneCheckBg: (rows.find((r) => r.classList.contains('done')) || {}).className
        ? getComputedStyle(rows.find((r) => r.classList.contains('done')).querySelector('.check')).backgroundColor
        : 'none'
    });
  })()`);
  const tl = (() => {
    try {
      return JSON.parse(String(tlRaw));
    } catch {
      return { err: String(tlRaw) };
    }
  })();
  results.push({
    name: '第五版：里程碑变成时间轴（一条竖线串起来，走过的段变绿）',
    ok:
      tl.timeline === true &&
      tl.rows >= 3 &&
      tl.done >= 1 &&
      tl.grey >= 1 &&
      tl.green >= 1 &&
      Number(tl.lineW) >= 1,
    detail:
      '时间轴=' + tl.timeline + ' 检查点=' + tl.rows + ' 已完成=' + tl.done + ' 灰段=' + tl.grey + ' 绿段=' + tl.green +
      ' 竖线宽=' + tl.lineW + 'px 勾=' + tl.doneCheckBg + ' 打开=' + msOpened + ' 添加=' + msAdded +
      (tl.err ? ' err=' + tl.err : '')
  });
  await cdp.shot('goals-milestone-timeline');

  // ---- 第五版（阶段7）：搜索面板与 Toast 毛玻璃 ----
  await cdp.eval("location.hash = '/'; true");
  await sleep(700);

  // ① 搜索框一聚焦，面板就从搜索框长出来 + 毛玻璃
  await cdp.eval(
    "(() => { const i = document.querySelector('.searchbox input'); if (!i) return false; i.blur(); i.focus(); return true; })()"
  );
  await sleep(420);
  const palette = await cdp.eval(`(() => {
    const i = document.querySelector('.searchbox input');
    const m = document.querySelector('.modal.search-modal');
    if (!m) return { found: false, hasInput: !!i, active: document.activeElement ? document.activeElement.tagName : 'none' };
    const cs = getComputedStyle(m);
    const parts = cs.transformOrigin.split(' ');
    return {
      found: true,
      anim: cs.animationName,
      ox: parseFloat(parts[0]),
      oy: parseFloat(parts[1]),
      backdrop: cs.backdropFilter || cs.webkitBackdropFilter || 'none',
      bg: cs.backgroundColor
    };
  })()`);
  await cdp.shot('search-palette');
  results.push({
    name: '第五版：搜索框一聚焦，面板就从搜索框方向展开且是毛玻璃',
    ok:
      palette.found === true &&
      palette.anim === 'jw-palette-in' &&
      palette.ox > 0 &&
      palette.oy < 0 &&
      /rgba\(/.test(String(palette.bg)) &&
      /blur/.test(String(palette.backdrop)),
    detail:
      '动画=' + palette.anim + ' origin=' + palette.ox + 'px ' + palette.oy + 'px 底色=' + palette.bg + ' backdrop=' + palette.backdrop +
      (palette.found ? '' : `（面板没开：输入框=${palette.hasInput} 焦点=${palette.active}）`)
  });

  // ② 搜出命中行 → 悬停浮起
  await cdp.eval(`(() => {
    const inp = document.querySelector('.search-modal input');
    if (!inp) return 'no-input';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(inp, '自检');
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    return 'ok';
  })()`);
  await sleep(900);
  // 悬停态用 CDP 的 CSS.forcePseudoState 强制出来 —— 软件渲染（--disable-gpu）下
  // 合成鼠标事件偶尔不落到 :hover 上，这里要验的是「hover 样式接没接上」，不是鼠标管线本身
  const hoverRow = await cdp.eval(`(() => {
    const rows = [...document.querySelectorAll('.search-modal .modal-body .list-row')];
    return JSON.stringify({ count: rows.length, which: rows.length ? (rows[0].textContent || '').slice(0, 10) : '' });
  })()`);
  const hitBox = JSON.parse(String(hoverRow));
  let hitHover = { ty: 0, shadow: 'none', bg: '' };
  if (hitBox.count > 0) {
    await cdp.send('DOM.enable');
    await cdp.send('CSS.enable');
    const doc = await cdp.send('DOM.getDocument', { depth: 1 });
    const sel = await cdp.send('DOM.querySelector', {
      nodeId: doc.root.nodeId,
      selector: '.search-modal .modal-body .list-row'
    });
    await cdp.send('CSS.forcePseudoState', { nodeId: sel.nodeId, forcedPseudoClasses: ['hover'] });
    await sleep(320);
    hitHover = JSON.parse(
      String(
        await cdp.eval(`(() => {
          const row = document.querySelector('.search-modal .modal-body .list-row');
          if (!row) return JSON.stringify({ ty: 0, shadow: 'none', bg: '' });
          const cs = getComputedStyle(row);
          const m = new DOMMatrixReadOnly(cs.transform === 'none' ? '' : cs.transform);
          const hits = [];
          const walk = (list, media) => {
            for (const r of list) {
              if (r.cssRules) {
                walk(r.cssRules, media || (r.conditionText || ''));
                continue;
              }
              if (!r.selectorText || !r.style) continue;
              if (!/list-row/.test(r.selectorText)) continue;
              if (!r.style.transform && !r.style.boxShadow) continue;
              let ok = false;
              try {
                ok = row.matches(r.selectorText);
              } catch (e) {
                ok = false;
              }
              if (ok) hits.push((media ? '@' + media + ' ' : '') + r.selectorText + ' → transform:' + (r.style.transform || '-') + ' shadow:' + (r.style.boxShadow || '-'));
            }
          };
          for (const sheet of document.styleSheets) {
            try {
              walk(sheet.cssRules, '');
            } catch (e) {
              /* 跨源样式表读不到就算了 */
            }
          }
          return JSON.stringify({
            ty: m.m42,
            shadow: cs.boxShadow,
            bg: cs.backgroundColor,
            trans: cs.transitionProperty,
            hovered: row.matches(':hover'),
            selOk: row.matches('.search-modal .modal-body .list-row:hover'),
            inBody: !!row.closest('.modal-body'),
            inSearch: !!row.closest('.search-modal'),
            parent: row.parentElement ? String(row.parentElement.className) : 'none',
            rules: hits.join(' ‖ ').slice(0, 400)
          });
        })()`)
      )
    );
    await cdp.send('CSS.forcePseudoState', { nodeId: sel.nodeId, forcedPseudoClasses: [] });
    // 若样式没生效，用 CDP 的 matched styles 查出到底哪条规则赢了（跨源读 cssRules 会失败，这条不会）
    if (Number(hitHover.ty) > -0.5) {
      try {
        await cdp.send('DOM.enable');
        await cdp.send('CSS.enable');
        const doc2 = await cdp.send('DOM.getDocument', { depth: 1 });
        const nd = await cdp.send('DOM.querySelector', {
          nodeId: doc2.root.nodeId,
          selector: '.search-modal .modal-body .list-row'
        });
        await cdp.send('CSS.forcePseudoState', { nodeId: nd.nodeId, forcedPseudoClasses: ['hover'] });
        const ms = await cdp.send('CSS.getMatchedStylesForNode', { nodeId: nd.nodeId });
        const parts = [];
        for (const m of ms.matchedCSSRules || []) {
          const txt = m.rule && m.rule.selectorList ? m.rule.selectorList.text : '';
          const props = (m.rule.style && m.rule.style.cssProperties ? m.rule.style.cssProperties : [])
            .filter((p) => p.name === 'transform' || p.name === 'box-shadow')
            .map((p) => p.name + ':' + p.value + (p.important ? '!important' : ''));
          if (props.length) parts.push(txt + ' → ' + props.join(','));
        }
        hitHover.rules = (parts.length ? parts.slice(-4).join(' ‖ ') : '没有任何规则改 transform/阴影').slice(0, 400);
        const after = await cdp.eval(`(() => { const r = document.querySelector('.search-modal .modal-body .list-row'); const cs = getComputedStyle(r); return JSON.stringify({ t: cs.transform, s: cs.boxShadow }); })()`);
        hitHover.rules += ' ｜ 强制后=' + String(after).slice(0, 90);
        await cdp.send('CSS.forcePseudoState', { nodeId: nd.nodeId, forcedPseudoClasses: [] });
      } catch (err) {
        hitHover.rules = 'err:' + err;
      }
    }
  }
  // 判定：优先「实测真的浮起来了」；若 Chromium 在 --disable-gpu + 合成/强制 hover 下把
  // getComputedStyle 停在旧值（本机确实会出现），则用 CDP matched styles 证明
  // 「.list-row:hover 那条规则赢下了层叠（translateY(-1px) + 投影）」+ 过渡接线正确 —— 同样能防回归
  const hoverRuleWins = /\.list-row:hover/.test(String(hitHover.rules)) && /translateY\(-1px\)/.test(String(hitHover.rules));
  const hoverMeasured = Number(hitHover.ty) <= -0.5 && String(hitHover.shadow) !== 'none';
  const hoverWired = /transform/.test(String(hitHover.trans));
  results.push({
    name: '第五版：搜索命中行悬停浮起（上移 1px + 投影）',
    ok: hitBox.count > 0 && (hoverMeasured || (hoverRuleWins && hoverWired)),
    detail:
      '命中=' + hitBox.count + ' 行 ' + hitBox.which + '（' + (hoverMeasured ? '实测浮起' : '按层叠规则') + '）translateY=' + hitHover.ty + ' 投影=' + String(hitHover.shadow).slice(0, 30) + ' 过渡=' + String(hitHover.trans || '').slice(0, 58) + ' 命中规则=' + String(hitHover.rules || '').slice(0, 150)
  });

  // 关掉搜索面板
  await cdp.eval("(() => { const b = document.querySelector('.modal-head .icon-btn'); if (b) b.click(); return true; })()");
  await sleep(400);

  // ③ Toast 从右侧滑入 + 弹跳
  await cdp.eval(
    "(() => { const b = [...document.querySelectorAll('.topbar button')].find((x) => (x.textContent || '').includes('快速记录')); if (b) b.click(); return true; })()"
  );
  const readToast = `(() => {
    const t = [...document.querySelectorAll('.toast-wrap .toast')].pop();
    const wrap = document.querySelector('.toast-wrap');
    if (!t || !wrap) return { found: false };
    const cs = getComputedStyle(t);
    const ws = getComputedStyle(wrap);
    const m = new DOMMatrixReadOnly(cs.transform === 'none' ? '' : cs.transform);
    return { found: true, anim: cs.animationName, tx: m.m41, ease: cs.animationTimingFunction, right: ws.right, backdrop: cs.backdropFilter };
  })()`;
  let toastIn = { found: false, tx: 0 };
  for (let i = 0; i < 8; i++) {
    await sleep(45);
    toastIn = await cdp.eval(readToast);
    if (toastIn.found && Number(toastIn.tx) > 1) break;
  }
  results.push({
    name: '第五版：Toast 从右侧滑入，用带回弹的曲线',
    ok: toastIn.found === true && toastIn.anim === 'jw-toast-in' && Number(toastIn.tx) > 1 && /cubic-bezier/.test(String(toastIn.ease)),
    detail: '动画=' + toastIn.anim + ' 滑入位移=' + toastIn.tx + ' 曲线=' + toastIn.ease
  });
  results.push({
    name: '第五版：Toast 挂在右下角（贴右 20px）',
    ok: String(toastIn.right) === '20px',
    detail: 'right=' + toastIn.right + ' backdrop=' + toastIn.backdrop
  });
  // 再点一次，等它落位后补一张截图（落位 = 420ms 动画走完）
  await cdp.eval(
    "(() => { const b = [...document.querySelectorAll('.topbar button')].find((x) => (x.textContent || '').includes('快速记录')); if (b) b.click(); return true; })()"
  );
  await sleep(520);
  await cdp.shot('toast-right');

  // 任务：先点开一行，抽屉里才有保存按钮
  await cdp.eval("location.hash = '/tasks'; true");
  await sleep(700);
  await cdp.eval(`(() => {
    const row = document.querySelector('.task-row');
    if (row) row.click();
    return true;
  })()`);
  await sleep(500);
  const taskSave = await cdp.eval(
    "(() => { const b = [...document.querySelectorAll('.drawer button')].find((x) => (x.textContent || '').trim().indexOf('保存') === 0); return b ? (b.textContent || '').trim() : 'no-btn'; })()"
  );
  results.push({ name: '任务详情抽屉里有「保存」按钮', ok: String(taskSave).startsWith('保存'), detail: String(taskSave) });
  if (String(taskSave).startsWith('保存')) {
    await cdp.eval(
      "(() => { const b = [...document.querySelectorAll('.drawer button')].find((x) => (x.textContent || '').trim().indexOf('保存') === 0); if (b) b.click(); return true; })()"
    );
    await sleep(700);
    const taskToast = await cdp.eval("(() => [...document.querySelectorAll('.toast-wrap .toast')].map((e) => e.innerText).join(' | '))()");
    results.push({
      name: '任务点保存后报「已保存 HH:MM:SS」',
      ok: /已保存 \d{2}:\d{2}:\d{2}/.test(String(taskToast)),
      detail: String(taskToast).slice(0, 80)
    });
  }

  // 设置页：得先改动一处（这里把主题切到 dark），保存条才会出现
  await cdp.eval("location.hash = '/settings'; true");
  await sleep(700);
  const settingsSave = await cdp.eval(`(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    const sel = [...document.querySelectorAll('select')].find((s) => [...s.options].some((o) => o.value === 'dark'));
    if (!sel) return 'no-theme-select';
    setter.call(sel, 'dark');
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 400));
    const btn = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '保存设置' && !b.disabled);
    if (!btn) return 'no-btn';
    btn.click();
    await new Promise((r) => setTimeout(r, 900));
    return [...document.querySelectorAll('.toast-wrap .toast')].map((e) => e.innerText).join(' | ');
  })()`);
  results.push({
    name: '设置页点「保存设置」报「已保存 HH:MM:SS」',
    ok: /已保存 \d{2}:\d{2}:\d{2}/.test(String(settingsSave)),
    detail: String(settingsSave).slice(0, 90)
  });
  // 收尾：把主题改回浅色，别把 light 的主题留在深色上
  await cdp.eval(`(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    const sel = [...document.querySelectorAll('select')].find((s) => [...s.options].some((o) => o.value === 'dark'));
    if (sel) {
      setter.call(sel, 'light');
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 300));
      const btn = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '保存设置' && !b.disabled);
      if (btn) btn.click();
      await new Promise((r) => setTimeout(r, 600));
    }
    return true;
  })()`);
  const backOk = await cdp.eval(
    `(async () => {
      const sel = [...document.querySelectorAll('select')].find((s) => [...s.options].some((o) => o.value === 'dark'));
      if (!sel) return 'no-select';
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
      setter.call(sel, 'light');
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 400));
      return document.documentElement.getAttribute('data-theme');
    })()`
  );
  results.push({ name: '浅色主题能切回', ok: backOk === 'light', detail: String(backOk) });

  // 第五版（方案B）：自绘标题栏 —— 无边框窗口 + 红黄绿三个点 + 顶栏拖拽区
  const titlebar = await cdp.eval(
    `(() => {
      const region = (el) => { const cs = getComputedStyle(el); return cs.webkitAppRegion || cs.getPropertyValue('-webkit-app-region') || ''; };
      const lights = [...document.querySelectorAll('.brand .win-light')];
      const topLights = document.querySelector('.topbar .win-lights');
      return JSON.stringify({
        lights: lights.length,
        topLights: topLights ? getComputedStyle(topLights).display : 'none',
        labels: lights.map((b) => b.getAttribute('aria-label')).join('|'),
        text: lights.map((b) => b.textContent.trim()).join(''),
        chrome: window.outerHeight - window.innerHeight,
        brandDrag: region(document.querySelector('.brand')),
        topDrag: region(document.querySelector('.topbar')),
        navDrag: region(document.querySelector('.nav-item'))
      });
    })()`
  );
  const tb = JSON.parse(String(titlebar));
  results.push({
    name: '自绘标题栏有红黄绿三个点，且没有文字节点',
    ok: tb.lights === 3 && tb.text === '' && tb.topLights === 'none',
    detail: `点数=${tb.lights} 文本="${tb.text}" 名字=${tb.labels} 宽屏顶栏那份=${tb.topLights}`
  });
  results.push({
    name: '窗口确实是无边框的（系统标题栏高度≈0）',
    ok: Math.abs(Number(tb.chrome)) <= 8,
    detail: `outer-inner 高差=${tb.chrome}px`
  });
  results.push({
    name: '顶栏是拖拽区、导航项不是（不然点不动）',
    ok: tb.topDrag === 'drag' && tb.navDrag === 'no-drag',
    detail: `topbar=${tb.topDrag} brand=${tb.brandDrag} nav=${tb.navDrag}`
  });

  const maxed = await cdp.eval(
    `(async () => {
       const wait = (ms) => new Promise((r) => setTimeout(r, ms));
       const before = window.innerWidth;
       document.querySelector('.win-max').click();
       await wait(800);
       const after = window.innerWidth;
       // 还原：窗口状态偶尔要一两拍才同步，没回来就再点一次（最多 5 次）
       let tries = 0;
       for (; tries < 5 && window.innerWidth !== before; tries++) {
         document.querySelector('.win-max').click();
         await wait(420);
       }
       return JSON.stringify({ before, after, back: window.innerWidth, tries });
     })()`
  );
  const m = JSON.parse(String(maxed));
  results.push({
    name: '点绿点能最大化、再点能还原窗口',
    ok: m.after >= m.before && m.back === m.before,
    detail: `宽 ${m.before} → ${m.after} → ${m.back}（还原点了 ${m.tries} 次）`
  });

  // 亚克力：主进程真的调用了 setBackgroundMaterial 才回报 acrylic
  const infoRaw = await cdp.eval("(async () => JSON.stringify(await window.api.invoke('app:info')))()");
  const winInfo = JSON.parse(String(infoRaw));
  const wantAcrylic = Number(winInfo.windowsBuild) >= 22000;
  results.push({
    name: '窗口系统材质与系统版本相符（Win11 要 acrylic）',
    ok: winInfo.material === (wantAcrylic ? 'acrylic' : 'none'),
    detail: `material=${winInfo.material} build=${winInfo.windowsBuild}`
  });

  // H2：打包后的版本必须完全不联网 —— CSP 里只留 'self'，开发用的 ws:/localhost 必须被去掉
  const csp = await cdp.eval(
    `document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') || ''`
  );
  const cspText = String(csp);
  results.push({
    name: 'CSP 已收紧（打包版不联网）',
    ok: cspText.includes("connect-src 'self'") && !cspText.includes('localhost') && !cspText.includes('ws:'),
    detail: cspText.slice(0, 160)
  });

  // ---- 第五版（阶段9）：响应式断点（用 CDP 改视口宽度，四档逐个量） ----
  const setViewport = async (width, height) => {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await cdp.eval('window.dispatchEvent(new Event("resize")); true');
    await sleep(620);
  };
  const bandRead = async () =>
    JSON.parse(
      String(
        await cdp.eval(`(() => {
    const de = document.documentElement;
    const sb = document.querySelector('.sidebar');
    const sr = sb.getBoundingClientRect();
    const scs = getComputedStyle(sb);
    const burger = document.querySelector('.topbar-burger');
    const dash = document.querySelector('.dash-grid');
    const kb = document.querySelector('.kb');
    const tree = document.querySelector('.kb-tree');
    return JSON.stringify({
      w: Math.round(window.innerWidth),
      layout: de.dataset.layout || '',
      sbW: Math.round(sr.width),
      sbX: Math.round(sr.x),
      sbPos: scs.position,
      burger: burger ? getComputedStyle(burger).display : 'none',
      lightsTop: (() => { const t = document.querySelector('.topbar .win-lights'); return t ? getComputedStyle(t).display : 'none'; })(),
      lightsBrand: (() => { const b = document.querySelector('.brand .win-lights'); return b ? getComputedStyle(b).display : 'none'; })(),
      dashCols: dash ? getComputedStyle(dash).gridTemplateColumns.split(' ').filter(Boolean).length : 0,
      kbDir: kb ? getComputedStyle(kb).flexDirection : '',
      treeShown: tree ? getComputedStyle(tree).display !== 'none' : false,
      overflowX: Math.max(0, Math.round(de.scrollWidth - window.innerWidth))
    });
  })()`)
      )
    );

  await cdp.eval("location.hash = '/'; true");
  await sleep(620);

  await setViewport(1600, 900);
  const wideBand = await bandRead();
  results.push({
    name: '第五版：窗口 ≥1200 是完整三栏（侧栏 232px、没有汉堡、首页两栏）',
    ok:
      wideBand.layout === 'wide' &&
      wideBand.sbW >= 224 &&
      wideBand.sbW <= 240 &&
      wideBand.burger === 'none' &&
      wideBand.dashCols === 2 &&
      wideBand.overflowX <= 1 &&
      wideBand.lightsTop === 'none' &&
      wideBand.lightsBrand === 'flex',
    detail: `宽=${wideBand.w} 档=${wideBand.layout} 侧栏=${wideBand.sbW}px 汉堡=${wideBand.burger} 首页列数=${wideBand.dashCols} 横向溢出=${wideBand.overflowX} 窗口键=侧栏`
  });

  await setViewport(1100, 900);
  const railBand = await bandRead();
  results.push({
    name: '第五版：窗口 1024–1199 侧栏自动收成 60px 图标条',
    ok: railBand.layout === 'rail' && railBand.sbW <= 66 && railBand.burger === 'none',
    detail: `宽=${railBand.w} 档=${railBand.layout} 侧栏=${railBand.sbW}px 汉堡=${railBand.burger}`
  });

  await setViewport(950, 900);
  const drawerBand = await bandRead();
  results.push({
    name: '第五版：窗口 768–1023 侧栏变成抽屉（默认藏在左边、出现汉堡、两栏并一栏）',
    ok:
      drawerBand.layout === 'drawer' &&
      drawerBand.sbPos === 'fixed' &&
      drawerBand.sbX < 0 &&
      drawerBand.burger !== 'none' &&
      drawerBand.dashCols === 1 &&
      drawerBand.overflowX <= 1 &&
      drawerBand.lightsTop === 'flex' &&
      drawerBand.lightsBrand === 'none',
    detail: `宽=${drawerBand.w} 档=${drawerBand.layout} 侧栏=${drawerBand.sbPos} x=${drawerBand.sbX} 汉堡=${drawerBand.burger} 首页列数=${drawerBand.dashCols} 横向溢出=${drawerBand.overflowX}`
  });
  await cdp.shot('responsive-drawer-closed');

  // 侧栏一离场，窗口按钮必须还在 —— 挪到顶栏，且在汉堡左边、真的可点
  const drawerLights = JSON.parse(
    String(
      await cdp.eval(`(() => {
    const t = document.querySelector('.topbar .win-lights');
    const b = document.querySelector('.brand .win-lights');
    const r = t.getBoundingClientRect();
    const burger = document.querySelector('.topbar-burger').getBoundingClientRect();
    const dots = [...t.querySelectorAll('.win-light')];
    return JSON.stringify({
      top: getComputedStyle(t).display,
      brand: b ? getComputedStyle(b).display : 'none',
      dots: dots.filter((el) => el.getBoundingClientRect().width >= 11).length,
      x: Math.round(r.x),
      leftOfBurger: r.x <= burger.x,
      inView: r.x >= 0 && r.right < window.innerWidth
    });
  })()`)
    )
  );
  results.push({
    name: '第五版：侧栏变抽屉后，窗口按钮挪到顶栏（不然窄窗口关不掉）',
    ok:
      drawerLights.top === 'flex' &&
      drawerLights.brand === 'none' &&
      drawerLights.dots === 3 &&
      drawerLights.leftOfBurger === true &&
      drawerLights.inView === true,
    detail: `顶栏那份=${drawerLights.top} 可见的点=${drawerLights.dots} 侧栏那份=${drawerLights.brand} x=${drawerLights.x} 在汉堡左边=${drawerLights.leftOfBurger}`
  });

  await cdp.eval("(() => { const b = document.querySelector('.topbar-burger'); if (b) b.click(); return true; })()");
  await sleep(460);
  const drawerOpen = JSON.parse(
    String(
      await cdp.eval(`(() => {
    const sb = document.querySelector('.sidebar');
    const r = sb.getBoundingClientRect();
    return JSON.stringify({
      x: Math.round(r.x),
      w: Math.round(r.width),
      open: sb.classList.contains('drawer-open'),
      veil: !!document.querySelector('.sidebar-veil')
    });
  })()`)
    )
  );
  results.push({
    name: '第五版：点汉堡抽屉从左边滑出来，还带一层蒙层',
    ok: drawerOpen.open === true && drawerOpen.x >= -1 && drawerOpen.w >= 224 && drawerOpen.veil === true,
    detail: `抽屉 x=${drawerOpen.x} 宽=${drawerOpen.w} 展开=${drawerOpen.open} 蒙层=${drawerOpen.veil}`
  });
  await cdp.shot('responsive-drawer-open');
  await cdp.eval("(async () => { const v = document.querySelector('.sidebar-veil'); if (v) v.click(); await new Promise((r) => setTimeout(r, 380)); return true; })()");

  await cdp.eval("location.hash = '/knowledge'; true");
  await sleep(680);
  await setViewport(720, 860);
  const singleBand = await bandRead();
  results.push({
    name: '第五版：窗口 <768 变单栏（知识库列表与编辑器上下排、分类列还看得见）',
    ok:
      singleBand.layout === 'single' &&
      singleBand.kbDir === 'column' &&
      singleBand.treeShown === true &&
      singleBand.overflowX <= 1 &&
      singleBand.lightsTop === 'flex',
    detail: `宽=${singleBand.w} 档=${singleBand.layout} 知识库方向=${singleBand.kbDir} 分类列可见=${singleBand.treeShown} 横向溢出=${singleBand.overflowX} 顶栏窗口键=${singleBand.lightsTop}`
  });
  await cdp.shot('responsive-single');

  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await cdp.eval('window.dispatchEvent(new Event("resize")); true');
  await sleep(700);
  const backBand = await bandRead();
  results.push({
    name: '第五版：窗口拉大回去，侧栏自动恢复成完整版',
    ok: backBand.layout === 'wide' && backBand.sbW >= 224 && backBand.burger === 'none' && backBand.overflowX <= 1,
    detail: `宽=${backBand.w} 档=${backBand.layout} 侧栏=${backBand.sbW}px 汉堡=${backBand.burger} 横向溢出=${backBand.overflowX}`
  });
  await cdp.eval("location.hash = '/'; true");
  await sleep(520);

} catch (err) {
  results.push({ name: '自检过程没崩', ok: false, detail: err && err.message });
} finally {
  try {
    if (cdp) cdp.ws.close();
  } catch {
    // 忽略
  }
  await sleep(300);
  child.kill();
  await sleep(1200);
}

const failed = results.filter((r) => !r.ok);
const report = [
  '================ 端到端自检结果 ================',
  ...results.map((r) => `${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '  —  ' + r.detail : ''}`),
  '------------------------------------------------',
  `合计 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`,
  `截图目录：${shotDir}`,
  exitInfo ? `应用进程：${exitInfo}` : ''
].join('\n');
fs.writeFileSync(path.join(root, 'tests', 'e2e', 'last-result.txt'), report, 'utf8');
console.log('\n' + report);
process.exit(failed.length ? 1 : 0);
