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

    // ---- 首页 ----
    const dash = await inv('dash:overview');
    rec('首页数据能读', !!dash && Array.isArray(dash.tasks) && typeof dash.today === 'string', 'today=' + (dash && dash.today) + ' 待办=' + (dash && dash.tasks.length));
    rec('首页统计了收集箱与最近笔记', !!dash && typeof dash.inboxCount === 'number' && Array.isArray(dash.recentNotes), '待整理=' + (dash && dash.inboxCount) + ' 最近笔记=' + (dash && dash.recentNotes.length));
    rec('首页包含复习提醒结构', !!dash && Array.isArray(dash.reviewDue), '复习卡=' + (dash && dash.reviewDue.length));
    rec('首页包含目标进度结构', !!dash && Array.isArray(dash.goals), '目标=' + (dash && dash.goals.length));

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

  const dataChecks = await cdp.eval(CHECK_SCRIPT);
  results.push(...dataChecks);

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
