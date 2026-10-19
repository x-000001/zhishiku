/* 一次性脚本：给 tests/e2e/cdp-check.mjs 加 GitHub 集成（stub 路由 + 启动环境 + 断言） */
const fs = require('node:fs');
const file = 'tests/e2e/cdp-check.mjs';
let text = fs.readFileSync(file, 'utf8');
const nl = text.includes('\r\n') ? '\r\n' : '\n';
const anchor = (s) => s.split('\n').join(nl);

/* ---------- 1) stub 服务器：GitHub 路由 ---------- */
const stubAnchor = anchor(`  if (url.startsWith('/download/')) {`);
const stubBlock = anchor(`  /* 第九版：GitHub 集成（Device Flow / Issues 分页 / PR 过滤 / 401 / 部分仓库失败）。 */
  if (url.startsWith('/github/')) {
    const send = (body, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'POST' && url.startsWith('/github/oauth/device/code')) {
      send({ device_code: 'e2e-device-code', user_code: 'E2E-1234', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 1 });
      return;
    }
    if (req.method === 'POST' && url.startsWith('/github/oauth/access_token')) {
      send({ access_token: 'gho_e2e_token_123456', token_type: 'bearer', scope: 'repo' });
      return;
    }
    if (url.startsWith('/github/api/user')) {
      send({ login: 'octo-e2e' });
      return;
    }
    if (url.startsWith('/github/api/repos/')) {
      githubCalls.push(url);
      const page = Number((url.match(/[?&]page=(\\d+)/) || [])[1] || '1');
      const repo = url.replace('/github/api/repos/', '').split('/issues')[0];
      const later = () => {
        send([]);
      };
      if (repo === 'octo/expired') {
        send({ message: 'Bad credentials' }, 401);
        return;
      }
      if (repo === 'octo/boom') {
        send({ message: 'stub 500' }, 500);
        return;
      }
      const issues = {
        'octo/demo': [
          {
            number: 11,
            title: '登录页在窄窗口下错位',
            body: '把窗口拉到 720 宽，登录卡片会压到边栏上。',
            state: 'open',
            labels: [{ name: 'bug' }],
            html_url: 'https://github.com/octo/demo/issues/11',
            updated_at: '2026-10-18T09:00:00Z',
            closed_at: null,
            milestone: null
          },
          {
            number: 12,
            title: '补一份 Markdown 导出说明',
            body: '导出后的目录结构要写清楚。',
            state: 'closed',
            labels: [{ name: 'docs' }],
            html_url: 'https://github.com/octo/demo/issues/12',
            updated_at: '2026-10-17T08:00:00Z',
            closed_at: '2026-10-17T10:00:00Z',
            milestone: null
          },
          {
            number: 13,
            title: '这是一个 PR，不该变成待办',
            body: 'pull_request 字段在这里。',
            state: 'open',
            labels: [],
            html_url: 'https://github.com/octo/demo/pull/13',
            updated_at: '2026-10-18T09:30:00Z',
            closed_at: null,
            milestone: null,
            pull_request: { url: 'https://api.github.com/repos/octo/demo/pulls/13' }
          }
        ],
        'octo/second': [
          {
            number: 21,
            title: '第二个仓库的 Issue',
            body: '这条来自另一个仓库。',
            state: 'open',
            labels: [{ name: 'enhancement' }],
            html_url: 'https://github.com/octo/second/issues/21',
            updated_at: '2026-10-16T09:00:00Z',
            closed_at: null,
            milestone: null
          }
        ]
      }[repo] || [];
      const rows = page === 1 ? issues : [];
      setTimeout(() => send(rows), 200);
      return;
    }
    send({ message: 'stub: unknown github route' }, 404);
    return;
  }
`);
if (!text.includes(stubAnchor)) throw new Error('stub anchor missing');
text = text.replace(stubAnchor, stubBlock + stubAnchor);

/* githubCalls 计数器 + 顶部声明 */
const counterAnchor = anchor(`let stubPort = 0;`);
text = text.replace(counterAnchor, anchor(`const githubCalls = [];`) + nl + counterAnchor);

/* ---------- 2) 启动环境变量 ---------- */
const envAnchor = anchor(`      JWKB_FOCUS_MIN_SECONDS: '2'`);
const envBlock = anchor(`      JWKB_FOCUS_MIN_SECONDS: '2',
      JWKB_GITHUB_CLIENT_ID: 'e2e-client-id',
      JWKB_GITHUB_API_BASE: \`http://127.0.0.1:\${stubPort}/github/api\`,
      JWKB_GITHUB_OAUTH_BASE: \`http://127.0.0.1:\${stubPort}/github/oauth\``);
text = text.replace(envAnchor, envBlock);

/* ---------- 3) 断言块：插在结尾 hash 重置之前 ---------- */
const endAnchor = anchor(`  await cdp.eval("location.hash = '/'; true");`);
if (!text.includes(endAnchor)) throw new Error('end anchor missing');

const block = anchor(`  // ---- 第九版：GitHub Issues 单向同步（Device Flow / 分页 / PR 过滤 / 去重 / 401）----
  const ghSetup = await cdp.eval(\`(async () => {
    const inv = (ch, p) => window.api.invoke(ch, p);
    const bad = await inv('github:config:set', { repos: ['not a repo', 'octo/demo', 'octo/second'] });
    const code = await inv('github:request-code');
    const status = await inv('github:poll-token');
    return { bad, code, status };
  })()\`);
  results.push({
    name: '0.10.0：仓库名格式校验（非法项被丢掉，owner/repo 原样保留）',
    ok:
      Array.isArray(ghSetup.status.repos) &&
      ghSetup.status.repos.length === 2 &&
      ghSetup.status.repos.includes('octo/demo') &&
      ghSetup.status.repos.includes('octo/second'),
    detail: 'repos=' + JSON.stringify(ghSetup.status && ghSetup.status.repos)
  });
  results.push({
    name: '0.10.0：Device Flow 能拿到设备码（user_code + 轮询间隔）',
    ok: !!ghSetup.code && String(ghSetup.code.userCode || '').length >= 4,
    detail: 'userCode=' + (ghSetup.code && ghSetup.code.userCode)
  });
  results.push({
    name: '0.10.0：授权成功后 Token 只在主进程（前端只有打码状态）',
    ok: ghSetup.status.connected === true && !JSON.stringify(ghSetup.status).includes('gho_e2e_token_123456'),
    detail: 'hint=' + ghSetup.status.tokenHint + ' encrypted=' + ghSetup.status.encrypted
  });

  const ghSync1 = await cdp.eval(\`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const inv = (ch, p) => window.api.invoke(ch, p);
    await inv('github:config:set', { repos: ['octo/demo', 'octo/second', 'octo/boom'] });
    location.hash = '/tasks';
    await sleep(700);
    const btn = document.querySelector('.github-sync-btn');
    if (!btn) return { error: '没有同步按钮' };
    btn.click();
    await sleep(160);
    const during = {
      disabled: btn.disabled === true,
      loading: btn.classList.contains('loading'),
      text: (document.body.innerText || '').includes('正在同步')
    };
    for (let i = 0; i < 140; i += 1) {
      await sleep(150);
      if (!btn.classList.contains('loading')) break;
    }
    await sleep(700);
    const rows = [...document.querySelectorAll('.task-row')].map((row) => ({
      text: (row.innerText || '').replace(/\\\\s+/g, ' ').trim(),
      done: row.classList.contains('done'),
      prio: (row.querySelector('.dot') || {}).className || ''
    }));
    return { during, rows, body: (document.body.innerText || '').slice(0, 400) };
  })()\`);
  results.push({
    name: '0.10.0：同步进行中按钮被禁用（防连点），并显示「正在同步 (1/3)」',
    ok: ghSync1.during && ghSync1.during.disabled === true && ghSync1.during.text === true,
    detail: 'disabled=' + (ghSync1.during && ghSync1.during.disabled) + ' 文案=' + (ghSync1.during && ghSync1.during.text)
  });
  results.push({
    name: '0.10.0：三个仓库串行同步（一个 500 失败也不拖垮整轮）',
    ok: !!ghSync1.body && ghSync1.body.includes('成功 2 个仓库') && ghSync1.body.includes('失败 1 个'),
    detail: (ghSync1.body || '').replace(/\\\\s+/g, ' ').slice(0, 120)
  });
  results.push({
    name: '0.10.0：Issue 变成待办（closed → 已完成，bug 标签 → 重要），PR 被过滤',
    ok:
      Array.isArray(ghSync1.rows) &&
      ghSync1.rows.some((row) => row.text.includes('登录页在窄窗口下错位') && row.prio.includes('prio-important')) &&
      ghSync1.rows.some((row) => row.text.includes('补一份 Markdown 导出说明') && row.done === true) &&
      ghSync1.rows.some((row) => row.text.includes('第二个仓库的 Issue')) &&
      !ghSync1.rows.some((row) => row.text.includes('这是一个 PR')),
    detail: '任务行=' + (ghSync1.rows || []).length + ' 条'
  });
  results.push({
    name: '0.10.0：同步汇总 Toast（成功/失败/新增）',
    ok: !!ghSync1.body && ghSync1.body.includes('新增 3 条任务') && ghSync1.body.includes('过滤掉 1 个 PR'),
    detail: (ghSync1.rows || []).length + ' 行，stub 请求 ' + githubCalls.length + ' 次'
  });

  const ghSync2 = await cdp.eval(\`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const before = [...document.querySelectorAll('.task-row')].map((row) => (row.innerText || '').trim());
    const btn = document.querySelector('.github-sync-btn');
    btn.click();
    for (let i = 0; i < 140; i += 1) {
      await sleep(150);
      if (!btn.classList.contains('loading')) break;
    }
    await sleep(700);
    const after = [...document.querySelectorAll('.task-row')].map((row) => (row.innerText || '').trim());
    return { beforeCount: before.length, afterCount: after.length, body: (document.body.innerText || '').slice(0, 400) };
  })()\`);
  results.push({
    name: '0.10.0：连续同步两次不会重复建任务（按 github_issue_id 去重）',
    ok: ghSync2.beforeCount === ghSync2.afterCount && ghSync2.afterCount === 3 && ghSync2.body.includes('新增 0 条任务'),
    detail: '第一次=' + ghSync2.beforeCount + ' 第二次=' + ghSync2.afterCount
  });
  results.push({
    name: '0.10.0：分页真的翻了页（per_page=100 且 page=2 被请求过）',
    ok: githubCalls.some((u) => u.includes('per_page=100')) && githubCalls.some((u) => u.includes('page=2')),
    detail: '请求 ' + githubCalls.length + ' 次，示例=' + (githubCalls[0] || '')
  });

  const ghAuth = await cdp.eval(\`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const inv = (ch, p) => window.api.invoke(ch, p);
    await inv('github:config:set', { repos: ['octo/expired'] });
    location.hash = '/tasks';
    await sleep(700);
    const btn = document.querySelector('.github-sync-btn');
    if (btn) btn.click();
    await sleep(1400);
    return { hash: location.hash, body: (document.body.innerText || '').slice(0, 400) };
  })()\`);
  results.push({
    name: '0.10.0：401 会提示「授权已过期」并自动回设置页',
    ok: ghAuth.hash.includes('/settings') && ghAuth.body.includes('授权已过期'),
    detail: 'hash=' + ghAuth.hash
  });

  await cdp.eval(\`(async () => {
    await window.api.invoke('github:config:set', { repos: [] });
    await window.api.invoke('github:logout');
    location.hash = '/settings';
    return true;
  })()\`);
  await sleep(420);
  await cdp.shot('github-settings');
`);
const endIndex = text.lastIndexOf(endAnchor);
if (endIndex < 0) throw new Error('end anchor missing');
const existing = text.lastIndexOf('第九版：GitHub Issues');
if (existing > 0) throw new Error('block already inserted');
text = text.slice(0, endIndex) + block + text.slice(endIndex);
fs.writeFileSync(file, text);
console.log('patched', file);
