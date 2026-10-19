/* 给 GitHub 卡片的按钮加稳定 class + e2e 补充「设置页授权/解绑」断言与截图 */
const fs = require('node:fs');

function edit(file, pairs) {
  const raw = fs.readFileSync(file, 'utf8');
  const crlf = raw.includes('\r\n');
  let t = crlf ? raw.replace(/\r\n/g, '\n') : raw;
  for (const [from, to] of pairs) {
    if (!t.includes(from)) throw new Error('anchor missing in ' + file + ': ' + from.slice(0, 60));
    t = t.replace(from, to);
  }
  fs.writeFileSync(file, crlf ? t.replace(/\n/g, '\r\n') : t);
}

edit('src/renderer/src/github.tsx', [
  [
    "            className={busy === 'logout' ? 'btn loading' : 'btn'}",
    "            className={busy === 'logout' ? 'btn loading github-logout-btn' : 'btn github-logout-btn'}"
  ],
  [
    "            className={busy === 'connect' ? 'btn primary loading' : 'btn primary'}",
    "            className={busy === 'connect' ? 'btn primary loading github-connect-btn' : 'btn primary github-connect-btn'}"
  ]
]);

const e2eFile = 'tests/e2e/cdp-check.mjs';
const raw = fs.readFileSync(e2eFile, 'utf8');
const crlf = raw.includes('\r\n');
let t = crlf ? raw.replace(/\r\n/g, '\n') : raw;

const anchor = `  await cdp.eval(\`(async () => {
    await window.api.invoke('github:config:set', { repos: [] });
    await window.api.invoke('github:logout');
    location.hash = '/settings';
    return true;
  })()\`);
  await sleep(500);
  await cdp.shot('github-settings');
`;
if (!t.includes(anchor)) throw new Error('e2e tail anchor missing');

const block = `  /* 设置页：连接状态 / Token 打码 / 仓库列表（截图后再解绑） */
  const ghSettings = await cdp.eval(\`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    location.hash = '/settings';
    await sleep(900);
    const card = document.querySelector('.github-card');
    if (card) card.scrollIntoView({ block: 'center' });
    await sleep(500);
    return { cardText: card ? card.innerText.replace(/\\s+/g, ' ') : '' };
  })()\`);
  await sleep(300);
  await cdp.shot('github-settings');
  results.push({
    name: '0.10.0：设置页显示授权状态（已连接 + Token 打码 + 仓库列表）',
    ok:
      ghSettings.cardText.includes('已连接') &&
      ghSettings.cardText.includes('gho…3456') &&
      ghSettings.cardText.includes('octo/expired') &&
      !ghSettings.cardText.includes('gho_e2e_token_123456'),
    detail: (ghSettings.cardText || '').slice(0, 120)
  });

  /* 解绑：只清 Token，本地任务一条不动 */
  const ghLogout = await cdp.eval(\`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const inv = (ch, p) => window.api.invoke(ch, p);
    const before = (await inv('task:list', {})).length;
    const logoutBtn = document.querySelector('.github-logout-btn');
    if (logoutBtn) logoutBtn.click();
    await sleep(1300);
    const status = await inv('github:status');
    const after = (await inv('task:list', {})).length;
    const card = document.querySelector('.github-card');
    const text = card ? card.innerText.replace(/\\s+/g, ' ') : '';
    return { before, after, connected: status.connected, text };
  })()\`);
  results.push({
    name: '0.10.0：解绑 GitHub 只清 Token，本地任务一条不动',
    ok: ghLogout.connected === false && ghLogout.before === ghLogout.after && ghLogout.text.includes('未连接'),
    detail: '解绑前=' + ghLogout.before + ' 解绑后=' + ghLogout.after + ' connected=' + ghLogout.connected
  });
  await cdp.eval(\`(async () => {
    await window.api.invoke('github:config:set', { repos: [] });
    return true;
  })()\`);
`;

t = t.replace(anchor, block);
fs.writeFileSync(e2eFile, crlf ? t.replace(/\n/g, '\r\n') : t);
console.log('github settings assertions added');
