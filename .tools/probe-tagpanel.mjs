/**
 * 阶段1 验收自检探针：知识库左栏「标签管理」面板。
 * 查三件事：①空态文案 ②展开后每行的引用数/对比度/行高 ③深浅色都对、不横向溢出。
 * 截图落在 .tools/probe-shots/。跑完可删（产物目录已在 .gitignore）。
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
const PORT = 9351;
const child = spawn(
  exe,
  [
    '.',
    `--remote-debugging-port=${PORT}`,
    '--no-sandbox',
    '--disable-gpu',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-features=CalculateNativeWinOcclusion',
    `--user-data-dir=${ud}`
  ],
  { env: { ...process.env, JWKB_DATA_DIR: data }, stdio: 'ignore' }
);

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

const HELPERS = `
  const nums = (s) => (s.match(/[\\d.]+/g) || []).map(Number);
  const lum = (c) => { const f = c.slice(0,3).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126*f[0] + 0.7152*f[1] + 0.0722*f[2]; };
  const bgOf = (el) => { let n = el; while (n && n !== document.documentElement) { const c = nums(getComputedStyle(n).backgroundColor); if (c.length === 3 || (c.length === 4 && c[3] > 0.9)) return c; n = n.parentElement; } return [0,0,0]; };
  const findRow = (text) => [...document.querySelectorAll('.tree-item')].find((el) => (el.innerText || '').includes(text));
  const expand = async (sleep) => {
    const head = findRow('标签管理');
    if (!head) return { error: '没有标签管理入口' };
    if (!head.getAttribute('aria-expanded') || head.getAttribute('aria-expanded') === 'false') head.click();
    await sleep(420);
    return {};
  };
`;

const EMPTY_STATE = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  location.hash = '/knowledge';
  await sleep(820);
  document.documentElement.setAttribute('data-theme', 'light');
  await sleep(200);
  ${HELPERS}
  const head = findRow('标签管理');
  if (!head) return JSON.stringify({ error: '没有标签管理入口' });
  head.click();
  await sleep(420);
  const hint = [...document.querySelectorAll('.kb-tree .muted')].map((e) => (e.innerText || '').trim()).filter(Boolean);
  return JSON.stringify({
    headText: (head.innerText || '').replace(/\\s+/g, ' ').trim(),
    expanded: head.getAttribute('aria-expanded'),
    hint,
    rows: [...document.querySelectorAll('.tree-item')].filter((el) => el.querySelector('[title="标签操作"]')).length
  });
})()`;

const MEASURE = (theme) => `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  ${HELPERS}
  document.documentElement.setAttribute('data-theme', '${theme}');
  await sleep(260);
  await expand(sleep);
  const rows = [...document.querySelectorAll('.tree-item')].filter((el) => el.querySelector('[title="标签操作"]'));
  const measured = rows.map((b) => {
    const cs = getComputedStyle(b);
    const fg = nums(cs.color);
    const bg = bgOf(b);
    const l1 = lum(fg);
    const l2 = lum(bg);
    return {
      text: (b.innerText || '').replace(/\\s+/g, ' ').trim(),
      h: Math.round(b.getBoundingClientRect().height),
      padLeft: cs.paddingLeft,
      ratio: Math.round(((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)) * 100) / 100
    };
  });
  const tree = document.querySelector('.kb-tree');
  return JSON.stringify({
    theme: document.documentElement.dataset.theme,
    scheme: getComputedStyle(document.documentElement).colorScheme,
    rows: measured,
    treeOverflow: tree ? tree.scrollWidth - tree.clientWidth : null,
    headText: (findRow('标签管理') || {}).innerText ? findRow('标签管理').innerText.replace(/\\s+/g, ' ').trim() : ''
  });
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
await sleep(1100);

const out = {};

// ① 空库：只有「还没有标签」的提示
out.empty = JSON.parse(String(await cdp.eval(EMPTY_STATE)));
out.empty.shot = await cdp.shot('tag-panel-empty');

// ② 造数据：学习 2 篇 / 工作 1 篇 / 空标签 1 个（0 篇）
await cdp.eval(`(async () => {
  const inv = (ch, p) => window.api.invoke(ch, p);
  const a = await inv('note:create', { title: '学习笔记甲', content: 'x' });
  const b = await inv('note:create', { title: '学习笔记乙', content: 'x' });
  const c = await inv('note:create', { title: '工作笔记', content: 'x' });
  await inv('tag:set', { noteId: a.id, names: ['学习', '工作'] });
  await inv('tag:set', { noteId: b.id, names: ['学习'] });
  await inv('tag:set', { noteId: c.id, names: ['工作'] });
  await inv('tag:set', { noteId: c.id, names: ['工作', '空标签'] });
  location.hash = '/';
  await new Promise((r) => setTimeout(r, 300));
  location.hash = '/knowledge';
  await new Promise((r) => setTimeout(r, 900));
  return 'ok';
})()`);

for (const theme of ['light', 'dark']) {
  const parsed = JSON.parse(String(await cdp.eval(MEASURE(theme))));
  parsed.shot = await cdp.shot(`tag-panel-${theme}`);
  out[theme] = parsed;
}

console.log(JSON.stringify(out, null, 2));
ws.close();
child.kill();
