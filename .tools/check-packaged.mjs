/**
 * 检查「打包后的安装产物」能不能真的用：
 * 直接跑 release\win-unpacked\Jw知识库.exe，用 CDP 连进渲染层，
 * 真实走一遍 preload → IPC → SQLite，并截图存证。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const exe = process.env.JWKB_EXE || path.join(root, 'release', 'win-unpacked', 'Jw知识库.exe');
const dataDir = path.join(root, '.pack-data');
const ud = path.join(root, '.tools', 'check-packaged-ud');
const shotDir = path.join(root, '.tools', 'pack-shots');
const PORT = 9335;

fs.rmSync(dataDir, { recursive: true, force: true });
fs.rmSync(ud, { recursive: true, force: true });
fs.mkdirSync(shotDir, { recursive: true });

if (!fs.existsSync(exe)) {
  console.error('找不到打包产物：' + exe);
  process.exit(1);
}

const logPath = path.join(root, '.tools', 'pack-app-stderr.log');
const logStream = fs.openSync(logPath, 'w');

const child = spawn(exe, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${ud}`, '--no-sandbox'], {
  env: { ...process.env, JWKB_DATA_DIR: dataDir },
  stdio: ['ignore', logStream, logStream],
  windowsHide: false
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findPage(port = PORT) {
  let last = '';
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await res.json();
      last = JSON.stringify(list).slice(0, 400);
      const page = list.find((t) => t.type === 'page' && t.url.includes('index.html'));
      if (page) return page;
    } catch (err) {
      /* 还没起来 */
    }
    await sleep(500);
  }
  console.error('CDP 最后看到的：' + (last || '（连不上调试端口）'));
  return null;
}

class Cdp {
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });
    return new Cdp(ws);
  }
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.waiting = new Map();
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      const slot = this.waiting.get(msg.id);
      if (slot) {
        this.waiting.delete(msg.id);
        slot(msg);
      }
    };
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.waiting.set(id, (msg) => (msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)));
      setTimeout(() => {
        if (this.waiting.has(id)) {
          this.waiting.delete(id);
          reject(new Error('CDP 超时：' + method));
        }
      }, 30000);
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('渲染层报错：' + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails));
    return r.result.value;
  }
  async shot(name) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(shotDir, name + '.png'), Buffer.from(r.data, 'base64'));
  }
}

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

const page = await findPage();
if (!page) {
  child.kill();
  try {
    console.error('--- 应用日志 ---');
    console.error(fs.readFileSync(logPath, 'utf8').slice(-3000));
  } catch {
    /* 没有日志 */
  }
  console.error('30 秒内没等到窗口出现');
  process.exit(1);
}

const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
await cdp.send('Runtime.enable');
await sleep(1500);

const report = await cdp.eval(`(async () => {
  const out = {};
  out.apiMissing = typeof window.api === 'undefined';
  const info = await window.api.invoke('app:info');
  out.info = info;
  const inbox = await window.api.invoke('inbox:add', { content: '打包版冒烟：随手记一条', kind: 'idea' });
  out.inbox = inbox;
  const inboxList = await window.api.invoke('inbox:list', { status: 'open' });
  out.inboxCount = inboxList.length;
  const note = await window.api.invoke('note:create', { title: '打包版新建的笔记', content: '知识 管理' });
  out.noteId = note && note.id ? note.id : null;
  const hits = await window.api.invoke('search:query', { q: '知识' });
  out.hits = hits.length;
  out.integrity = await window.api.invoke('data:integrity');
  out.bodyText = document.body.innerText.slice(0, 200);
  return out;
})()`);

check('打包版能打开窗口并注入 window.api', report.apiMissing === false);
check('打包版数据目录指向测试目录', String(report.info.dataRoot).toLowerCase().startsWith(dataDir.toLowerCase()), report.info.dataRoot);
check('打包版数据库文件已建出来', fs.existsSync(path.join(dataDir, 'kb.db')));
check('打包版能写收集箱', report.inboxCount >= 1, `count=${report.inboxCount}`);
check('打包版能建笔记并全文搜索到中文词', report.hits >= 1, `hits=${report.hits}`);
check('打包版数据库完整性检查通过', report.integrity === 'ok' || report.integrity?.ok === true, JSON.stringify(report.integrity));
check('打包版主页渲染出内容', typeof report.bodyText === 'string' && report.bodyText.length > 10);

await cdp.shot('packaged-home');

// 再走一遍各页面，确认打包版的资源路径（图标、字体、css）都没丢
for (const route of ['/inbox', '/knowledge', '/tasks', '/plans', '/goals', '/next', '/review', '/settings']) {
  await cdp.eval(`location.hash = '#${route}'; true`);
  await sleep(900);
  const text = await cdp.eval('document.body.innerText.slice(0, 120)');
  check(`打包版能渲染 ${route}`, typeof text === 'string' && text.length > 5, text.replace(/\s+/g, ' ').slice(0, 60));
  await cdp.shot('packaged' + route.replace(/\//g, '-'));
}

// ---- 第五版（阶段8）：主题记忆 —— 真的重启一次进程，验证首帧就是存下来的主题 ----
await cdp.eval(`window.api.invoke('settings:set', { key: 'theme', value: 'dark' })`);
await sleep(600);
const savedTheme = await cdp.eval(`(async () => (await window.api.invoke('settings:get')).theme)()`);
check('打包版能把主题存进库', savedTheme === 'dark', `theme=${savedTheme}`);

child.kill();
await sleep(1800);
const logPath2 = path.join(root, '.tools', 'pack-app-stderr2.log');
const logStream2 = fs.openSync(logPath2, 'w');
const PORT2 = 9336;
const child2 = spawn(exe, [`--remote-debugging-port=${PORT2}`, `--user-data-dir=${ud}`, '--no-sandbox'], {
  env: { ...process.env, JWKB_DATA_DIR: dataDir },
  stdio: ['ignore', logStream2, logStream2],
  windowsHide: false
});
const page2 = await findPage(PORT2);
if (!page2) {
  console.error('重启后没等到窗口');
  child2.kill();
  process.exit(1);
}
const cdp2 = await Cdp.connect(page2.webSocketDebuggerUrl);
await cdp2.send('Runtime.enable');
await sleep(1200);
const bootInfo = JSON.parse(
  String(
    await cdp2.eval(
      `JSON.stringify({ boot: document.documentElement.dataset.themeBoot || '', theme: document.documentElement.getAttribute('data-theme'), query: new URLSearchParams(location.search).get('theme') || '' })`
    )
  )
);
check(
  '打包版重启后首帧就是深色（主题记得住、不先亮一下）',
  bootInfo.boot === 'dark' && bootInfo.theme === 'dark' && bootInfo.query === 'dark',
  `首帧记号=${bootInfo.boot} 当前主题=${bootInfo.theme} URL=${bootInfo.query}`
);
await cdp2.shot('packaged-restart-dark');

const failed = results.filter((r) => !r.ok);
console.log('------------------------------------------------');
console.log(`合计 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);
fs.writeFileSync(
  path.join(root, '.tools', 'last-packaged-result.txt'),
  results.map((r) => `${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '  — ' + r.detail : ''}`).join('\n') +
    `\n合计 ${results.length}，失败 ${failed.length}\n`
);

child2.kill();
await sleep(500);
process.exit(failed.length === 0 ? 0 : 1);
