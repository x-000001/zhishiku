/* 重写 e2e 的 GitHub 断言块（CRLF 安全）：按 IPC 断言 + toast 文本，不再依赖任务列表 DOM */
const fs = require('node:fs');
const file = 'tests/e2e/cdp-check.mjs';
const raw = fs.readFileSync(file, 'utf8');
const crlf = raw.includes('\r\n');
let text = crlf ? raw.replace(/\r\n/g, '\n') : raw;

/* 1) stub 增加 octo/many：第一页正好 100 条，验证会翻 page=2 */
const stubAnchor = "    if (url.startsWith('/github/api/repos/')) {";
if (!text.includes(stubAnchor)) throw new Error('stub anchor missing');
if (!text.includes("'octo/many'")) {
  const manyBlock = `    if (repo === 'octo/many') {
      const rows = page === 1
        ? Array.from({ length: 100 }, (_, i) => ({
            number: 1000 + i,
            title: '批量 Issue ' + (1000 + i),
            body: '分页自检用。',
            state: 'open',
            labels: [],
            html_url: 'https://github.com/octo/many/issues/' + (1000 + i),
            updated_at: '2026-10-15T08:00:00Z',
            closed_at: null,
            milestone: null
          }))
        : [];
      setTimeout(() => send(rows), 120);
      return;
    }
`;
  text = text.replace(stubAnchor, manyBlock + stubAnchor);
}

/* 2) 替换整段 GitHub 断言 */
const startMark = '  // ---- 第九版：GitHub Issues 单向同步';
const startIndex = text.indexOf(startMark);
if (startIndex < 0) throw new Error('github block start missing');
const endAnchor = '  await cdp.eval("location.hash = \'/\'; true");';
const endIndex = text.lastIndexOf(endAnchor);
if (endIndex < startIndex) throw new Error('github block end missing');

const block = `  // ---- 第九版：GitHub Issues 单向同步（Device Flow / PR 过滤 / 串行容错 / 分页 / 去重 / 401）----
  const ghSetup = await cdp.eval(\`(async () => {
    const inv = (ch, p) => window.api.invoke(ch, p);
    const bad = await inv('github:config:set', { repos: ['not a repo', 'octo/demo', 'octo/second'] });
    const before = await inv('github:status');
    let code = null;
    let error = '';
    try { code = await inv('github:request-code'); } catch (err) { error = (err && err.message) || String(err); }
    const status = code ? await inv('github:poll-token') : before;
    return { bad, before, code, error, status };
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
    detail: 'userCode=' + (ghSetup.code && ghSetup.code.userCode) + ' error=' + ghSetup.error
  });
  results.push({
    name: '0.10.0：授权成功后 Token 只在主进程（前端只有打码状态）',
    ok: ghSetup.status.connected === true && !JSON.stringify(ghSetup.status).includes('gho_e2e_token_123456'),
    detail: 'hint=' + ghSetup.status.tokenHint + ' encrypted=' + ghSetup.status.encrypted
  });

  /* 串行同步：串行 3 个仓库，中间一个 500 失败也不应拖垮整轮 */
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
    const during = { disabled: btn.disabled === true, loading: btn.classList.contains('loading'), text: (document.body.innerText || '').includes('正在同步') };
    for (let i = 0; i < 140; i += 1) {
      await sleep(150);
      if (!btn.classList.contains('loading')) break;
    }
    await sleep(800);
    const toastText = ((document.querySelector('.toast-wrap') || {}).innerText || '').replace(/\\s+/g, ' ');
    const tasks = await inv('task:list', { status: 'all' });
    return {
      during,
      toastText,
      tasks: (tasks || []).map((t) => ({ title: t.title, status: t.status, priority: t.priority })),
      btnDisabledAfter: btn.disabled
    };
  })()\`);
  results.push({
    name: '0.10.0：同步进行中按钮被禁用（防连点），并显示「正在同步 (1/3)」',
    ok: ghSync1.during && ghSync1.during.disabled === true && ghSync1.during.text === true,
    detail: 'disabled=' + (ghSync1.during && ghSync1.during.disabled) + ' 文案=' + (ghSync1.during && ghSync1.during.text)
  });
  results.push({
    name: '0.10.0：三个仓库串行同步（一个 500 失败也不拖垮整轮）',
    ok: !!ghSync1.toastText && ghSync1.toastText.includes('成功 2 个仓库') && ghSync1.toastText.includes('失败 1 个'),
    detail: (ghSync1.toastText || '').slice(0, 120)
  });
  results.push({
    name: '0.10.0：Issue → 待办映射（closed→已完成，bug→重要），PR 被过滤',
    ok:
      Array.isArray(ghSync1.tasks) &&
      ghSync1.tasks.some((t) => t.title === '登录页在窄窗口下错位' && t.priority === 'important' && t.status === 'todo') &&
      ghSync1.tasks.some((t) => t.title === '补一份 Markdown 导出说明' && t.status === 'done') &&
      ghSync1.tasks.some((t) => t.title === '第二个仓库的 Issue') &&
      !ghSync1.tasks.some((t) => t.title === '这是一个 PR，不该变成待办'),
    detail: '任务 ' + (ghSync1.tasks || []).length + ' 条，PR 已过滤'
  });
  results.push({
    name: '0.10.0：同步汇总 Toast（成功/失败/新增）',
    ok: !!ghSync1.toastText && ghSync1.toastText.includes('新增 3 条任务') && ghSync1.toastText.includes('过滤掉 1 个 PR'),
    detail: '按钮已恢复=' + ghSync1.btnDisabledAfter + ' toast=' + (ghSync1.toastText || '').slice(0, 80)
  });

  /* 去重：再点一次同步，不应该重复建任务 */
  const ghSync2 = await cdp.eval(\`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const inv = (ch, p) => window.api.invoke(ch, p);
    const before = (await inv('task:list', { status: 'all' })).length;
    const btn = document.querySelector('.github-sync-btn');
    btn.click();
    for (let i = 0; i < 140; i += 1) {
      await sleep(150);
      if (!btn.classList.contains('loading')) break;
    }
    await sleep(800);
    const after = (await inv('task:list', { status: 'all' })).length;
    const toastText = ((document.querySelector('.toast-wrap') || {}).innerText || '').replace(/\\s+/g, ' ');
    return { before, after, toastText };
  })()\`);
  results.push({
    name: '0.10.0：连续同步两次不会重复建任务（按 github_issue_id 去重）',
    ok: ghSync2.before === ghSync2.after && ghSync2.toastText.includes('新增 0 条任务'),
    detail: '第一次=' + ghSync2.before + ' 第二次=' + ghSync2.after + ' toast=' + (ghSync2.toastText || '').slice(0, 60)
  });

  /* 分页：octo/many 第一页正好 100 条，应该继续请求 page=2 */
  const ghPage = await cdp.eval(\`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const inv = (ch, p) => window.api.invoke(ch, p);
    await inv('github:config:set', { repos: ['octo/many'] });
    location.hash = '/tasks';
    await sleep(600);
    const btn = document.querySelector('.github-sync-btn');
    btn.click();
    for (let i = 0; i < 160; i += 1) {
      await sleep(150);
      if (!btn.classList.contains('loading')) break;
    }
    await sleep(900);
    const toastText = ((document.querySelector('.toast-wrap') || {}).innerText || '').replace(/\\s+/g, ' ');
    return { toastText };
  })()\`);
  results.push({
    name: '0.10.0：分页真的翻了页（per_page=100，第一页满 100 条会继续请求 page=2）',
    ok:
      githubCalls.some((u) => u.includes('per_page=100')) &&
      githubCalls.some((u) => u.includes('page=2')) &&
      ghPage.toastText.includes('新增 100 条任务'),
    detail: '请求 ' + githubCalls.length + ' 次，示例=' + (githubCalls[0] || '')
  });

  /* 401：授权过期 → 中文提示 + 自动回设置页 */
  const ghAuth = await cdp.eval(\`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const inv = (ch, p) => window.api.invoke(ch, p);
    await inv('github:config:set', { repos: ['octo/expired'] });
    location.hash = '/tasks';
    await sleep(700);
    const btn = document.querySelector('.github-sync-btn');
    if (btn) btn.click();
    await sleep(1600);
    const toastText = ((document.querySelector('.toast-wrap') || {}).innerText || '').replace(/\\s+/g, ' ');
    return { hash: location.hash, toastText };
  })()\`);
  results.push({
    name: '0.10.0：401 会提示「授权已过期」并自动回设置页',
    ok: ghAuth.hash.includes('/settings') && ghAuth.toastText.includes('授权已过期'),
    detail: 'hash=' + ghAuth.hash + ' toast=' + (ghAuth.toastText || '').slice(0, 80)
  });

  await cdp.eval(\`(async () => {
    await window.api.invoke('github:config:set', { repos: [] });
    await window.api.invoke('github:logout');
    location.hash = '/settings';
    return true;
  })()\`);
  await sleep(500);
  await cdp.shot('github-settings');
`;

text = text.slice(0, startIndex) + block + text.slice(endIndex);
fs.writeFileSync(file, crlf ? text.replace(/\n/g, '\r\n') : text);
console.log('e2e github block rewritten');
