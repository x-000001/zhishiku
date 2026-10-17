/**
 * 临时探针：在真实运行的应用里抓所有网络请求（CDP Network 域），
 * 验证「除了点『检查更新』，没有任何联网行为」。
 * 用法：node .tools/probe-net.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const ud = path.join(root, '.tools', 'probe-net-ud');
const data = path.join(root, '.tools', 'probe-net-data');
fs.rmSync(ud, { recursive: true, force: true });
fs.rmSync(data, { recursive: true, force: true });

const exe = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const PORT = 9351;
const child = spawn(exe, ['.', `--remote-debugging-port=${PORT}`, '--no-sandbox', `--user-data-dir=${ud}`], {
  env: { ...process.env, JWKB_DATA_DIR: data },
  stdio: 'ignore'
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findPage() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && t.url.includes('index.html'));
      if (page) return page;
    } catch {
      /* 还没起来 */
    }
    await sleep(400);
  }
  return null;
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
        return;
      }
      if (msg.method) this.events.push(msg);
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value;
  }
}

const page = await findPage();
if (!page) {
  console.error('连不上调试端口');
  child.kill();
  process.exit(1);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', reject, { once: true });
});
const cdp = new Cdp(ws);
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
await cdp.send('Network.enable');
await sleep(1200);

// 把每个页面都走一遍，看有没有页面一打开就偷偷联网
for (const route of ['/', '/inbox', '/knowledge', '/tasks', '/plans', '/goals', '/next', '/review', '/settings']) {
  await cdp.eval(`location.hash = '${route}'; true`);
  await sleep(500);
}

// 唯一预期会联网的动作
const clicked = await cdp.eval(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  location.hash = '/settings';
  await sleep(400);
  const btn = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '检查更新');
  if (!btn) return 'no-button';
  btn.click();
  await sleep(3000);
  return 'clicked';
})()`);

const reqs = cdp.events
  .filter((e) => e.method === 'Network.requestWillBeSent')
  .map((e) => e.params.request.url);
const sockets = cdp.events.filter((e) => e.method === 'Network.webSocketCreated').map((e) => e.params.url);

const classify = (u) => {
  if (u.startsWith('file://')) return 'file://（本地打包资源）';
  if (u.startsWith('devtools://')) return 'devtools://（调试器自身）';
  if (u.startsWith('data:')) return 'data:（内联数据）';
  try {
    const { protocol, host } = new URL(u);
    return protocol + '//' + host;
  } catch {
    return '其它: ' + u.slice(0, 40);
  }
};

const groups = {};
for (const u of reqs) {
  const k = classify(u);
  groups[k] = (groups[k] || 0) + 1;
}

console.log('=== 点「检查更新」的状态：' + clicked + ' ===');
console.log('请求总数（含本地打包资源）：' + reqs.length);
console.log('--- 按来源分组 ---');
for (const [k, n] of Object.entries(groups).sort((a, b) => b[1] - a[1])) console.log(n + '  ' + k);
console.log('--- 非本地请求明细 ---');
const remote = reqs.filter((u) => !/^(file|devtools|data|blob):/.test(u));
console.log(remote.length === 0 ? '（没有）' : remote.join('\n'));
console.log('--- WebSocket ---');
console.log(sockets.length === 0 ? '（没有）' : sockets.join('\n'));

ws.close();
child.kill();
await sleep(600);
fs.rmSync(ud, { recursive: true, force: true });
fs.rmSync(data, { recursive: true, force: true });
