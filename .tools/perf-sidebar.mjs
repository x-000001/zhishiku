/**
 * 侧栏收起/展开的动画体检（只测「动画本身」，不测功能）。
 *
 * 干两件事：
 *   ① 录帧：点一下「收起侧栏」，用 requestAnimationFrame 记录每帧间隔，算 p50/p95/p99/最大。
 *   ② 数布局：通过 CDP Performance 域读 LayoutCount / RecalcStyleCount 的增量 ——
 *      这是判断「动画有没有触发回流」最直接的证据：
 *      - 改 width 的老写法：每一帧都要重新布局一次 → LayoutCount 会涨几十；
 *      - 只动 transform：布局次数应当基本为 0（只有首尾各一次）。
 *
 * 用法（要放宽沙箱：Electron 需要命名管道）：
 *   node .tools/perf-sidebar.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const exe = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const PORT = 9338;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dataDir = path.join(root, '.perf-data');
fs.rmSync(dataDir, { recursive: true, force: true });

const child = spawn(
  exe,
  [
    '.',
    `--remote-debugging-port=${PORT}`,
    '--no-sandbox',
    '--disable-backgrounding-occluded-windows',
    '--disable-features=CalculateNativeWinOcclusion',
    `--user-data-dir=${path.join(root, '.tools', 'perf-ud')}`
  ],
  { cwd: root, env: { ...process.env, JWKB_DATA_DIR: dataDir }, stdio: 'ignore' }
);

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
    const res = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (res.exceptionDetails) {
      throw new Error(`${res.exceptionDetails.text} ${res.exceptionDetails.exception?.description ?? ''}`);
    }
    return res.result?.value;
  }

  async metrics() {
    const res = await this.send('Performance.getMetrics');
    const out = {};
    for (const m of res.metrics) out[m.name] = m.value;
    return out;
  }
}

async function findPage() {
  for (let i = 0; i < 80; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && t.url.includes('index.html'));
      if (page?.webSocketDebuggerUrl) return page;
    } catch {
      /* 还没起来 */
    }
    await sleep(500);
  }
  throw new Error('等不到渲染进程');
}

const pct = (arr, p) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor((s.length * p) / 100))] * 100) / 100;
};

let cdp;
try {
  const page = await findPage();
  cdp = await Cdp.connect(page.webSocketDebuggerUrl);
  await cdp.send('Performance.enable');
  await sleep(1800); // 等首屏、字体、壁纸都稳定下来
  const before = await cdp.metrics();

  const summary = JSON.parse(
    String(
      await cdp.eval(`(async () => {
    const sb = document.querySelector('.sidebar');
    const label = document.querySelector('.nav-label');
    if (!sb) return JSON.stringify({ err: 'no-sidebar' });

    // 先把侧栏切到「展开」，每次测量都从同一个起点出发
    const collapsedNow = () => Math.round(sb.getBoundingClientRect().right) <= 64;
    for (let i = 0; i < 4 && collapsedNow(); i++) {
      document.querySelector('.nav-foot .icon-btn').click();
      await new Promise((r) => setTimeout(r, 700));
    }
    await new Promise((r) => setTimeout(r, 300));

    const frames = [];
    const samples = [];
    let stop = false;
    let last = performance.now();
    const tick = () => {
      const t = performance.now();
      frames.push(t - last);
      last = t;
      if (!stop) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);

    const t0 = performance.now();
    document.querySelector('.nav-foot .icon-btn').click(); // 收起
    while (performance.now() - t0 < 900) {
      await new Promise((r) => requestAnimationFrame(r));
      if (samples.length < 200) {
        samples.push({
          t: Math.round(performance.now() - t0),
          right: Math.round(sb.getBoundingClientRect().right),
          tf: getComputedStyle(sb).transform
        });
      }
    }
    stop = true;
    const deltas = frames.slice(2); // 丢掉前两帧（click 那一帧的时长不可比）
    const labelEnd = getComputedStyle(label).opacity;
    // 动画结束后再点回去，恢复展开态
    document.querySelector('.nav-foot .icon-btn').click();
    await new Promise((r) => setTimeout(r, 700));
    return JSON.stringify({
      frames: deltas,
      samples,
      labelEnd,
      finalRight: Math.round(sb.getBoundingClientRect().right)
    });
  })()`)
    )
  );

  const after = await cdp.metrics();

  const f = summary.frames || [];
  const med = pct(f, 50);
  const p95 = pct(f, 95);
  const p99 = pct(f, 99);
  const max = Math.round(Math.max(...f) * 100) / 100;
  const over33 = f.filter((d) => d > 33.4).length;

  // 只挑「右边缘在变」的那几帧，证明动画真的在跑（不是瞬间切换）
  const moving = (summary.samples || []).filter((s) => s.right > 62 && s.right < 231);
  const edges = moving.slice(0, 8).map((s) => `${s.t}ms:${s.right}px`);

  console.log('=== 侧栏收起动画体检（真实 GPU，无 --disable-gpu）===');
  console.log(`帧数 ${f.length}  中位 ${med}ms  p95 ${p95}ms  p99 ${p99}ms  最大 ${max}ms  超 33ms ${over33} 帧`);
  console.log(`右边缘插值轨迹（前 8 个中间帧）：${edges.length ? edges.join(' → ') : '（没采到中间帧）'}`);
  console.log(`动画结束后：右边缘=${summary.finalRight}px  文字透明度=${summary.labelEnd}`);
  const dLayout = Math.round((after.LayoutCount || 0) - (before.LayoutCount || 0));
  const dStyle = Math.round((after.RecalcStyleCount || 0) - (before.RecalcStyleCount || 0));
  const dLayoutMs = Math.round(((after.LayoutDuration || 0) - (before.LayoutDuration || 0)) * 1000);
  const dStyleMs = Math.round(((after.RecalcStyleDuration || 0) - (before.RecalcStyleDuration || 0)) * 1000);
  console.log(`这一段里：布局 ${dLayout} 次（${dLayoutMs}ms） 样式重算 ${dStyle} 次（${dStyleMs}ms）`);
} catch (err) {
  console.error('体检失败：' + (err && err.message));
} finally {
  try {
    cdp?.ws.close();
  } catch {
    /* 忽略 */
  }
  await sleep(200);
  child.kill();
  await sleep(800);
  process.exit(0);
}
