/**
 * 临时探针：仓库转公开后，真联网点一次「检查更新」，看应用里实际发生什么。
 * 用法：node .tools/probe-update-live.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const ud = path.join(root, '.tools', 'probe-live-ud');
const data = path.join(root, '.tools', 'probe-live-data');
fs.rmSync(ud, { recursive: true, force: true });
fs.rmSync(data, { recursive: true, force: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exe = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const PORT = 9355;
const child = spawn(exe, ['.', `--remote-debugging-port=${PORT}`, '--no-sandbox', `--user-data-dir=${ud}`], {
  env: { ...process.env, JWKB_DATA_DIR: data },
  stdio: 'ignore'
});

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
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
      }
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
await sleep(1200);

const result = await cdp.eval(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  location.hash = '/settings';
  await sleep(600);
  const toasts = () => [...document.querySelectorAll('.toast-wrap .toast')].map((e) => e.innerText.trim());
  const btn = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '检查更新');
  if (!btn) return { error: '没找到按钮' };
  btn.click();
  const seen = [];
  const t0 = Date.now();
  let loadingSeen = false;
  while (Date.now() - t0 < 9000) {
    const label = (btn.textContent || '').trim();
    if (label.includes('正在连接')) loadingSeen = true;
    for (const t of toasts()) if (!seen.includes(t)) seen.push(t);
    if (seen.length && !label.includes('正在连接')) break;
    await sleep(150);
  }
  const modal = document.querySelector('.modal');
  return {
    loadingSeen,
    toasts: seen,
    modal: modal ? { title: (modal.querySelector('.modal-head span') || {}).textContent || '', body: (modal.querySelector('.modal-body') || {}).innerText || '' } : null,
    version: document.body.innerText.includes('当前版本 0.4.0')
  };
})()`);
console.log(JSON.stringify(result, null, 2));

ws.close();
child.kill();
await sleep(600);
fs.rmSync(ud, { recursive: true, force: true });
fs.rmSync(data, { recursive: true, force: true });
