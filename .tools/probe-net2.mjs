/**
 * 临时探针：给应用挂一个「记账用」的本地代理，看它到底往外发什么请求。
 * - 用 --proxy-server 把整个 Chromium 网络栈（渲染层 + 主进程 net.fetch）都指到本地代理；
 * - 代理不回任何真实内容（CONNECT 一律 502），只记录被访问的主机；
 * - 先把 9 个页面走一遍（看有没有一打开就联网），再点一次「检查更新」（预期唯一一次外连）。
 * 用法：node .tools/probe-net2.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const root = process.cwd();
const ud = path.join(root, '.tools', 'probe-net-ud');
const data = path.join(root, '.tools', 'probe-net-data');
fs.rmSync(ud, { recursive: true, force: true });
fs.rmSync(data, { recursive: true, force: true });

const log = [];
const proxy = http.createServer((req, res) => {
  log.push({ at: Date.now(), kind: 'http', target: req.url });
  res.writeHead(502).end('probe proxy: 不在测试里真联网');
});
proxy.on('connect', (req, socket) => {
  log.push({ at: Date.now(), kind: 'connect', target: req.url });
  socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
});
await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exe = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const PORT = 9353;
const rawExtra = process.env.JWKB_PROBE_SWITCHES || '';
const extra = rawExtra.trim().startsWith('[') ? JSON.parse(rawExtra) : rawExtra.split(' ').filter(Boolean);
const child = spawn(
  exe,
  ['.', `--remote-debugging-port=${PORT}`, '--no-sandbox', `--proxy-server=${proxyUrl}`, `--user-data-dir=${ud}`, ...extra],
  { env: { ...process.env, JWKB_DATA_DIR: data }, stdio: 'ignore' }
);

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

const started = Date.now();
const page = await findPage();
if (!page) {
  console.error('连不上调试端口');
  child.kill();
  proxy.close();
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
await sleep(1500);

const beforeNav = log.slice();
for (const route of ['/', '/inbox', '/knowledge', '/tasks', '/plans', '/goals', '/next', '/review', '/settings']) {
  await cdp.eval(`location.hash = '${route}'; true`);
  await sleep(450);
}
const afterNav = log.slice();

const clicked = await cdp.eval(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  location.hash = '/settings';
  await sleep(400);
  const btn = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '检查更新');
  if (!btn) return 'no-button';
  btn.click();
  await sleep(3000);
  const tip = [...document.querySelectorAll('.toast-wrap .toast')].map((e) => e.innerText).join(' | ');
  return 'clicked │ toast=' + (tip || '(无)');
})()`);
await sleep(1200);
const afterClick = log.slice();

const renderer = cdp.events
  .filter((e) => e.method === 'Network.requestWillBeSent')
  .map((e) => e.params.request.url);
const sockets = cdp.events.filter((e) => e.method === 'Network.webSocketCreated').map((e) => e.params.url);

const show = (rows) => (rows.length === 0 ? '（无）' : rows.map((r) => `  +${((r.at - started) / 1000).toFixed(1)}s ${r.kind} ${r.target}`).join('\n'));

console.log('=== 启动 + 加载完成（还没点按钮）===');
console.log('代理收到的请求：' + beforeNav.length + '\n' + show(beforeNav));
console.log('=== 9 个页面依次打开后 ===');
console.log('新增请求：' + (afterNav.length - beforeNav.length) + '\n' + show(afterNav.slice(beforeNav.length)));
console.log('=== 点「检查更新」之后（' + clicked + '）===');
console.log('新增请求：' + (afterClick.length - afterNav.length) + '\n' + show(afterClick.slice(afterNav.length)));
console.log('=== 渲染进程自己发的请求（CDP Network）===');
const remote = renderer.filter((u) => !/^(file|devtools|data|blob):/.test(u));
console.log('总数=' + renderer.length + '，非本地=' + remote.length + (remote.length ? '\n' + remote.join('\n') : ''));
console.log('=== WebSocket ===');
console.log(sockets.length === 0 ? '（没有）' : sockets.join('\n'));

ws.close();
child.kill();
proxy.close();
await sleep(600);
fs.rmSync(ud, { recursive: true, force: true });
fs.rmSync(data, { recursive: true, force: true });
