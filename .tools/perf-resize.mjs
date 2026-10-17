/**
 * 临时性能探针：用 Win32 SetWindowPos 真的把窗口一帧一帧改宽（外框真实 resize，
 * 不是 Emulation 那种软改），同时在渲染层用 rAF 记每帧间隔，看跨过 1200px 档位那一下掉不掉帧。
 * 用来对比「拖动期间锁定插值」前后的差别。
 *
 * 用法（要放宽沙箱，Electron 需要命名管道）：node .tools/perf-resize.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const exe = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const dataDir = path.join(root, '.perf-data');
const ud = path.join(root, '.tools', 'perf-ud');
const PORT = 9337;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.rmSync(dataDir, { recursive: true, force: true });
fs.rmSync(ud, { recursive: true, force: true });

const child = spawn(
  exe,
  [
    '.',
    `--remote-debugging-port=${PORT}`,
    '--no-sandbox',
    '--disable-backgrounding-occluded-windows',
    '--disable-features=CalculateNativeWinOcclusion',
    `--user-data-dir=${ud}`
  ],
  { cwd: root, env: { ...process.env, JWKB_DATA_DIR: dataDir }, stdio: 'ignore', windowsHide: false }
);

async function waitForTarget() {
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
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.text);
    return res.result?.value;
  }
}

const target = await waitForTarget();
const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
await cdp.send('Page.enable');
await sleep(1800);

const view = await cdp.eval('({ w: window.innerWidth, h: window.innerHeight, dpr: devicePixelRatio })');
console.log('视口初始 ' + view.w + 'x' + view.h + ' dpr=' + view.dpr);
console.log('主进程 pid=' + child.pid);

// 渲染层装逐帧记录器（顺带记侧栏宽度、正文宽度、窗口内宽 —— 跨档那一下能对上）
await cdp.eval(`(() => {
  window.__perf = { frames: [], widths: [], contentW: [], innerW: [], last: performance.now(), running: true };
  const loop = () => {
    const now = performance.now();
    window.__perf.frames.push(now - window.__perf.last);
    window.__perf.last = now;
    const sb = document.querySelector('.sidebar');
    const ct = document.querySelector('.content');
    window.__perf.widths.push(sb ? Math.round(sb.getBoundingClientRect().width) : -1);
    window.__perf.contentW.push(ct ? Math.round(ct.getBoundingClientRect().width) : -1);
    window.__perf.innerW.push(window.innerWidth);
    if (window.__perf.running) requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  return 'ok';
})()`);

// 用 Win32 真实改窗口尺寸：从 1320 一路缩到 1080，每步 16ms（≈60fps 的拖动速度）
const ps = `
$src = @"
using System;
using System.Runtime.InteropServices;
public class Win32 {
  [DllImport("user32.dll", SetLastError=true)] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
"@
Add-Type -TypeDefinition $src
$proc = Get-Process -Id ${child.pid}
Write-Output ('title=' + $proc.MainWindowTitle)
$h = $proc.MainWindowHandle
if ($h -eq [IntPtr]::Zero) { Write-Output 'no-window'; exit 1 }
[Win32]::ShowWindow($h, 9) | Out-Null
[Win32]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 300
$ok = 0
for ($w = 1320; $w -ge 1080; $w -= 8) {
  if ([Win32]::SetWindowPos($h, [IntPtr]::Zero, 40, 40, $w, 860, 0x0004)) { $ok++ }
  Start-Sleep -Milliseconds 16
}
Write-Output ('steps-ok=' + $ok)
`;
// 清空记录器：只统计真正改窗口的这段
await cdp.eval(
  'window.__perf.frames.length = 0; window.__perf.widths.length = 0; window.__perf.contentW.length = 0; window.__perf.innerW.length = 0; "ok"'
);

const res = spawnSync(
  'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps],
  { encoding: 'utf8' }
);
console.log(
  '改窗口：status=' +
    res.status +
    ' out=' +
    (res.stdout || '').trim().replace(/\s+/g, ' ') +
    (res.stderr ? ' err=' + res.stderr.trim().slice(0, 300) : '') +
    (res.error ? ' spawn-error=' + res.error.message : '')
);
await sleep(600);

const data = await cdp.eval(`(() => {
  window.__perf.running = false;
  return {
    frames: window.__perf.frames,
    widths: window.__perf.widths,
    contentW: window.__perf.contentW,
    innerW: window.__perf.innerW
  };
})()`);

const frames = data.frames.slice(2);
const sorted = [...frames].sort((a, b) => a - b);
const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
const over = (ms) => frames.filter((f) => f > ms).length;

// 正文宽度的逐帧变化：窗口每一步只缩 8px，正文宽度理论上也只该跟着变 8px；
// 如果某一帧跳了 20-40px，画面上就是「内容被抽了一下」——这才是拖动时那种卡顿感。
const cw = data.contentW;
const deltas = [];
for (let i = 1; i < cw.length; i += 1) {
  if (cw[i] < 0 || cw[i - 1] < 0) continue;
  deltas.push(Math.abs(cw[i] - cw[i - 1]));
}
const jerks = deltas.filter((d) => d > 14).length;
const maxJerk = deltas.length ? Math.max(...deltas) : 0;

console.log(
  JSON.stringify(
    {
      frames: frames.length,
      p50: +pct(0.5).toFixed(1),
      p90: +pct(0.9).toFixed(1),
      p95: +pct(0.95).toFixed(1),
      p99: +pct(0.99).toFixed(1),
      max: +Math.max(...frames).toFixed(1),
      over33: over(33.4),
      over50: over(50),
      contentJerks: jerks,
      maxContentJump: maxJerk,
      sidebarWidths: [...new Set(data.widths)].slice(0, 40),
      contentWidths: cw.slice(0, 30)
    },
    null,
    2
  )
);

child.kill();
await sleep(1500);
try {
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(ud, { recursive: true, force: true });
} catch {
  /* 进程还没松手就留给下次 */
}
process.exit(0);
