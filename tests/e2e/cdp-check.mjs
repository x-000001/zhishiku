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

    const convTask = await inv('inbox:convert', { id: openList[1].id, target: 'task', title: '读书：深度工作第二章', due_at: '2026-10-16', priority: 3, repeat_rule: 'none' });
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
    const t1 = await inv('task:create', { title: '今天要做的第一件事', due_at: todayStr, priority: 3 });
    const t2 = await inv('task:create', { title: '每天重复的晨间阅读', due_at: todayStr, priority: 2, repeat_rule: 'daily' });
    await inv('task:create', { title: '下个月才做的事', due_at: '2026-11-30', priority: 1 });
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
    await inv('task:update', { id: t1, patch: { title: '今天要做的第一件事（改过）', priority: 1 } });
    const updated = await inv('task:list', { view: 'all' });
    rec('任务能行内改', updated.some((t) => t.id === t1 && t.title.includes('改过') && t.priority === 1), 'ok');

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
    const withRemind = await inv('task:create', { title: '提醒测试', due_at: todayStr, remind_at: todayStr + ' 09:30:00', priority: 2 });
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
