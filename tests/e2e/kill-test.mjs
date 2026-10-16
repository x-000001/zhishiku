/**
 * 「强制结束进程也不丢数据」的验收（PRD F2 / A5、开发计划 S7.2）。
 *
 * 做法：启动打包好的应用 → 通过真实 IPC 写进 20 条收集箱 + 若干笔记和任务
 *      → 不等它正常退出，直接强杀（Windows 上是 TerminateProcess）
 *      → 重新启动 → 读回来逐条核对，并跑一次数据库完整性检查。
 *
 * 用法（必须在放宽的沙箱权限下跑，因为 Electron 需要创建命名管道）：
 *   node tests/e2e/kill-test.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const exe = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const dataDir = path.join(root, '.kill-data');
const PORT = 9334;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.rmSync(dataDir, { recursive: true, force: true });

function launch() {
  return spawn(
    exe,
    [
      '.',
      `--remote-debugging-port=${PORT}`,
      '--no-sandbox',
      '--disable-gpu',
      `--user-data-dir=${path.join(root, 'tests', 'e2e', 'ud-kill')}`
    ],
    { cwd: root, env: { ...process.env, JWKB_DATA_DIR: dataDir }, stdio: 'ignore' }
  );
}

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

async function connectEval(url) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('CDP 连接失败')), { once: true });
  });
  let seq = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    const slot = pending.get(msg.id);
    if (!slot) return;
    pending.delete(msg.id);
    if (msg.error) slot.reject(new Error(JSON.stringify(msg.error)));
    else slot.resolve(msg.result);
  });

  return {
    close: () => ws.close(),
    async eval(expression) {
      const id = ++seq;
      const res = await new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(
          JSON.stringify({
            id,
            method: 'Runtime.evaluate',
            params: { expression, awaitPromise: true, returnByValue: true }
          })
        );
      });
      if (res.exceptionDetails) {
        throw new Error(`${res.exceptionDetails.text} ${res.exceptionDetails.exception?.description ?? ''}`);
      }
      return res.result?.value;
    }
  };
}

const results = [];
const rec = (name, ok, detail) => results.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail).slice(0, 220) });

const WRITE = `(async () => {
  const inv = (ch, p) => window.api.invoke(ch, p);
  const log = [];
  let failed = '';
  const step = async (name, fn) => {
    if (failed) return null;
    try {
      const v = await fn();
      log.push(name + '=' + JSON.stringify(v === undefined ? null : v));
      return v;
    } catch (err) {
      failed = name + ' 报错：' + (err && err.message);
      return null;
    }
  };
  const before = await inv('data:integrity', {});
  for (let i = 0; i < 20 && !failed; i++) {
    await step('inbox' + i, () => inv('inbox:add', { content: '强杀测试第 ' + i + ' 条：' + '内容'.repeat(i % 5 + 1), kind: 'idea' }));
  }
  // 一定要「手动保存」过，才算用户认为保存好的数据（note:create 返回的是整条笔记，取 .id）
  const n1 = await step('note:create', () => inv('note:create', { title: '强杀前保存的笔记', content: '这段正文必须活下来。' }));
  await step('note:save', () => inv('note:save', { id: n1 && n1.id, title: '强杀前保存的笔记', content: '这段正文必须活下来。' }));
  const t1 = await step('task:create', () => inv('task:create', { title: '强杀前建的任务' }));
  // 故意留一个「只写了草稿、没点保存」的笔记，用来验证草稿也能找回
  const n2 = await step('note:create2', () => inv('note:create', { title: '只写了草稿', content: '' }));
  await step('note:draft', () => inv('note:draft', { id: n2 && n2.id, title: '只写了草稿', content: '草稿也要能找回' }));
  return { integrity: before, failed, log: log.slice(-4), noteId: n1, draftId: n2, taskId: t1 };
})()`;

const READ = `(async () => {
  const inv = (ch, p) => window.api.invoke(ch, p);
  const inbox = await inv('inbox:list', { status: 'open' });
  const notes = await inv('note:list', { limit: 100 });
  const tasks = await inv('task:list', { view: 'all' });
  const integrity = await inv('data:integrity', {});
  const saved = notes.find((n) => n.title === '强杀前保存的笔记');
  const draftSummary = notes.find((n) => n.title === '只写了草稿');
  const draft = draftSummary ? await inv('note:get', { id: draftSummary.id }) : null;
  return {
    inboxCount: inbox.length,
    inboxFirst: inbox[0] ? inbox[0].content : '',
    noteCount: notes.length,
    savedFound: !!saved,
    savedBody: saved && saved.excerpt ? saved.excerpt : '',
    draftFound: !!draft && JSON.stringify(draft).includes('草稿也要能找回'),
    taskFound: tasks.some((t) => t.title === '强杀前建的任务'),
    integrity
  };
})()`;

let first = null;
let second = null;
try {
  first = launch();
  const target1 = await waitForTarget();
  const cdp1 = await connectEval(target1.webSocketDebuggerUrl);
  await sleep(600);
  const written = await cdp1.eval(WRITE);
  rec(
    '强杀前：20 条收集箱 + 笔记 + 任务都写进去了',
    written && !written.failed && written.integrity === 'ok',
    written && (written.failed || JSON.stringify(written))
  );
  cdp1.close();
  await sleep(200);

  // 关键一步：不给它正常退出的机会，直接强杀
  first.kill('SIGKILL');
  await sleep(1500);

  second = launch();
  const target2 = await waitForTarget();
  const cdp2 = await connectEval(target2.webSocketDebuggerUrl);
  await sleep(600);
  const back = await cdp2.eval(READ);
  cdp2.close();

  rec('强杀重启后：数据库完整性检查仍然 ok', back && back.integrity === 'ok', back && back.integrity);
  rec('强杀重启后：20 条收集箱一条不少', back && back.inboxCount === 20, back && back.inboxCount);
  rec('强杀重启后：手动保存过的笔记还在', back && back.savedFound);
  rec('强杀重启后：任务还在', back && back.taskFound);
  rec('强杀重启后：没点保存的草稿也能找回', back && back.draftFound);
} catch (err) {
  rec('强杀测试过程没崩', false, err && err.message);
} finally {
  for (const child of [first, second]) {
    try {
      if (child && child.exitCode === null) child.kill('SIGKILL');
    } catch {
      // 已经退出了
    }
  }
  await sleep(500);
}

const failed = results.filter((r) => !r.ok);
const lines = [
  '================ 强杀（断电）测试结果 ================',
  ...results.map((r) => `${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '  —  ' + r.detail : ''}`),
  '------------------------------------------------------',
  `合计 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`,
  `测试数据目录：${dataDir}`
];
const text = lines.join('\n');
fs.writeFileSync(path.join(root, 'tests', 'e2e', 'last-kill-result.txt'), text, 'utf8');
console.log(text);
process.exit(failed.length === 0 ? 0 : 1);
