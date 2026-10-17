/**
 * 临时探针：深色模式下分段标签（.tabs 里的裸 button）的「文字 / 底色」对比度。
 * 用来验证「白底白字」这个 bug 修好了，顺带截图。跑完可以删。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const ud = path.join(root, '.tools', 'probe-ud');
const data = path.join(root, '.probe-data');
fs.rmSync(ud, { recursive: true, force: true });
fs.rmSync(data, { recursive: true, force: true });
const shotDir = path.join(root, '.tools', 'probe-shots');
fs.mkdirSync(shotDir, { recursive: true });

const exe = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const PORT = 9343;
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
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description ?? ''));
    return r.result.value;
  }
  async shot(name) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    const p = path.join(shotDir, name + '.png');
    fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
    return p;
  }
}

const MEASURE = (route, theme) => `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  location.hash = '${route}';
  await sleep(520);
  document.documentElement.setAttribute('data-theme', '${theme}');
  document.body.getBoundingClientRect();
  await sleep(240);
  const nums = (s) => (s.match(/[\\d.]+/g) || []).map(Number);
  const lum = (c) => {
    const f = c.slice(0, 3).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2];
  };
  const bgOf = (el) => {
    let n = el;
    while (n && n !== document.documentElement) {
      const c = nums(getComputedStyle(n).backgroundColor);
      if (c.length === 3 || (c.length === 4 && c[3] > 0.9)) return c;
      n = n.parentElement;
    }
    return [0, 0, 0];
  };
  const rows = [...document.querySelectorAll('.tabs > button')].map((b) => {
    const cs = getComputedStyle(b);
    const fg = nums(cs.color);
    const bg = bgOf(b);
    const l1 = lum(fg);
    const l2 = lum(bg);
    return {
      text: b.textContent.trim(),
      on: b.classList.contains('on'),
      color: cs.color,
      bg: 'rgb(' + bg.join(', ') + ')',
      ratio: Math.round(((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)) * 100) / 100,
      appearance: cs.appearance
    };
  });
  return JSON.stringify({ theme: document.documentElement.dataset.theme, scheme: getComputedStyle(document.documentElement).colorScheme, rows });
})()`;

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
await sleep(900);

const out = [];
for (const [route, theme, name] of [
  ['/review', 'dark', 'dark-review'],
  ['/next', 'dark', 'dark-next'],
  ['/review', 'light', 'light-review'],
  ['/next', 'light', 'light-next']
]) {
  const raw = await cdp.eval(MEASURE(route, theme));
  const parsed = JSON.parse(raw);
  const shot = await cdp.shot(name);
  out.push({ route, theme, shot, ...parsed });
}

console.log(JSON.stringify(out, null, 2));
ws.close();
child.kill();
