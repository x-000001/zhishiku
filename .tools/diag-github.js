// GitHub Device Flow 一键诊断（在真实 Electron 主进程运行时里跑，不走 npm/curl）
//
// 用法：
//   npm run diag:github                     # 用默认 Client ID（当前设置里的那个）
//   JWKB_DIAG_CLIENT_ID=你的ClientId npm run diag:github   （Windows PowerShell 用 $env:JWKB_DIAG_CLIENT_ID="..."）
//
// 它回答三个问题（对应「浏览器授权成功但应用一直未连接」的三层排查）：
//   1. 本机代理设置（环境变量 / 系统 WinINET）——PowerShell 里另外看一眼 hosts 有没有把 github 指到 127.0.0.1；
//   2. 主进程能不能访问 api.github.com 与 github.com/login/device（延迟 + 状态码）；
//   3. 用当前 Client ID 发起一次真实 Device Flow，看是否回 device_code（不回 =
//      这个 OAuth App 没在后台勾 Enable Device Flow / Client ID 填错），以及未授权时
//      access_token 是否按协议回 authorization_pending（说明请求头/请求体格式没问题）。
//
// 注意：这个脚本不会保存任何 Token，也不会打印 device_code 全文。
const { app, net } = require('electron');

const CID = process.env.JWKB_DIAG_CLIENT_ID || 'Ov23liRUw3KF7zipf7b5';
const UA = 'JwKB-App';
const HEADERS = { Accept: 'application/json', 'User-Agent': UA };
const TIMEOUT = 10000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mask = (s) => (s && s.length > 8 ? `${s.slice(0, 3)}…${s.slice(-4)}` : '…');

async function step(label, fn) {
  const t = Date.now();
  try {
    const out = await fn();
    console.log(`[诊断] ${label}: OK ${Date.now() - t}ms → HTTP ${out.status} ${out.hint ?? ''}`);
    return out;
  } catch (err) {
    console.log(`[诊断] ${label}: 失败 ${Date.now() - t}ms → ${err && (err.message || err)}`);
    return null;
  }
}

async function main() {
  console.log('[诊断] Electron', process.versions.electron, '· Node', process.versions.node, '· Chrome', process.versions.chrome);
  console.log('[诊断] Client ID =', CID);

  console.log('[诊断] 环境变量代理：', {
    HTTPS_PROXY: process.env.HTTPS_PROXY || '(空)',
    HTTP_PROXY: process.env.HTTP_PROXY || '(空)',
    ALL_PROXY: process.env.ALL_PROXY || '(空)',
    NO_PROXY: process.env.NO_PROXY || '(空)'
  });

  await step('GET https://api.github.com/', async () => {
    const r = await net.fetch('https://api.github.com/', { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT) });
    return { status: r.status, hint: r.ok ? '（GitHub API 可达）' : '（GitHub API 返回异常）' };
  });

  await step('GET https://github.com/login/device', async () => {
    const r = await net.fetch('https://github.com/login/device', { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT) });
    return { status: r.status, hint: '(302/200 都算可达)' };
  });

  const dc = await step('POST https://github.com/login/device/code', async () => {
    const r = await net.fetch('https://github.com/login/device/code', {
      method: 'POST',
      headers: { ...HEADERS, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: CID, scope: 'repo' }).toString(),
      signal: AbortSignal.timeout(TIMEOUT)
    });
    const body = await r.text();
    return { status: r.status, body };
  });

  let parsed = null;
  try {
    parsed = dc ? JSON.parse(dc.body) : null;
  } catch {
    parsed = null;
  }
  if (!parsed) {
    console.log('[诊断] 结论：拿不到 device/code 的 JSON，先查网络/代理（上面两步）。');
    app.quit();
    return;
  }
  if (!parsed.device_code) {
    console.log('[诊断] device/code 返回错误：', parsed.error, parsed.error_description ?? '');
    console.log(
      '[诊断] 结论：Client ID 大概率没用对，或者这个 OAuth App 后台没勾「Enable Device Flow」。' +
        '这两项必须由你在 GitHub 上确认，任何代码都改不了它。'
    );
    app.quit();
    return;
  }

  console.log('[诊断] device/code OK：', {
    user_code: parsed.user_code,
    device_code: mask(parsed.device_code),
    interval: parsed.interval,
    expires_in: parsed.expires_in,
    verification_uri: parsed.verification_uri
  });
  // 立刻问一次 token：没授权时 GitHub 按协议应回 authorization_pending（HTTP 200 + JSON）。
  const at = await step('POST https://github.com/login/oauth/access_token（未授权，期望 authorization_pending）', async () => {
    const r = await net.fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { ...HEADERS, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CID,
        device_code: parsed.device_code,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
      }).toString(),
      signal: AbortSignal.timeout(TIMEOUT)
    });
    return { status: r.status, body: await r.text() };
  });
  let err = null;
  try {
    err = at ? JSON.parse(at.body).error : null;
  } catch {
    err = null;
  }
  if (err === 'authorization_pending') {
    console.log('[诊断] 结论：整条协议链路正常（device code 能拿、pending 能按协议回）。');
    console.log('[诊断] 如果应用里仍然「未连接」，问题在应用侧：要么跑的是旧安装包，要么授权轮询被取消。');
  } else {
    console.log('[诊断] 结论：access_token 端点返回异常（error =', err, '），把上面这段发给我。');
  }
  await sleep(10);
  app.quit();
}

app.whenReady().then(main).catch((err) => {
  console.error('[诊断] 意外错误：', err);
  app.quit();
});
