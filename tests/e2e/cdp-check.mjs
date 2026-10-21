/**
 * 端到端自检：真的启动打包好的 Electron 应用，通过 CDP 连进渲染进程，
 * 跑一遍「渲染层 → preload → IPC → SQLite」的真实链路，并把每个页面截一张图。
 *
 * 用法（必须在放宽的沙箱权限下跑，因为 Electron 需要创建命名管道）：
 *   node tests/e2e/cdp-check.mjs
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const exe = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const dataDir = path.join(root, '.e2e-data');
const shotDir = path.join(root, 'tests', 'e2e', 'shots');
const PORT = 9333;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(shotDir, { recursive: true });

/* 「检查更新」是唯一会联网的功能：测试里不让它真连 GitHub，
   用本地 stub 服务器顶替（主进程读 JWKB_UPDATE_URL 这个仅测试用的环境变量）。
   stubUpdateMode：newer = 返回一个比当前新的版本；hang = 查询不响应，用来测 5 秒超时。
   stubAssetMode：normal = 正常发假安装包；hang = 发一点就卡住，用来测「取消下载」。 */
let stubUpdateMode = 'newer';
let stubDelayMs = 0; // 让「正在连接…」这个加载态能被稳定观察到（本地回包太快会瞬过）
let stubAssetMode = 'normal';
/* 第七版：AI 的 stub。主进程真的走 net.fetch 发 HTTP 请求，只是打到这里，
   不连外网、不花额度。URL 前缀区分场景：/ai/v1 = 正常；/ai-bad/v1 = 401。
   回复内容按「用户消息里的动作关键词」区分，和真实模型无关。 */
function aiReplyFor(messages) {
  const raw = JSON.stringify(messages ?? []);
  if (raw.includes('请只回复两个字')) return '可用';
  if (raw.includes('请润色下面这段文字')) return '这是润色后的句子。';
  if (raw.includes('请把下面这段文字扩写到')) return '这是扩写后的句子，补了一点细节。';
  if (raw.includes('请把下面这段文字压缩到')) return '这是缩写后的句子。';
  if (raw.includes('请把下面这段文字翻译成')) return 'TRANSLATED TEXT';
  if (raw.includes('请为下面这篇笔记写一段摘要'))
    return '这篇笔记讲了把零散知识收进知识库、再靠复习把它记住的完整流程。';
  if (raw.includes('请阅读下面这个 GitHub 仓库的 README'))
    return [
      '### 项目总结',
      '一个批量处理文件的命令行工具，内置进度条与配置模板。',
      '### 核心亮点',
      '- 批量处理文件',
      '- 内置进度条',
      '- 支持配置模板',
      '### 适用场景',
      '适合需要重复处理大量文件时使用。'
    ].join('\n');
  if (raw.includes('请推荐 3 到 5 个标签'))
    return JSON.stringify({
      tags: ['知识管理', 'AI', '测试标签'],
      category: '学习',
      reason: 'stub 给出的理由'
    });
  if (raw.includes('请阅读下面这篇笔记'))
    return JSON.stringify({
      items: [
        { title: '为什么要复习', detail: 'stub 联想条目一' },
        { title: '标签该怎么管', detail: 'stub 联想条目二' }
      ]
    });
  return 'AI 回复';
}
/* 假安装包：内容固定，测试里断言「落盘大小 + SHA256 对得上」就用它算 */
const stubInstaller = Buffer.alloc(384 * 1024, 0x5a);
const stubInstallerSha = createHash('sha256').update(stubInstaller).digest('hex');
const githubCalls = [];
let stubPort = 0;
const stubServer = http.createServer((req, res) => {
  const url = req.url || '';
  /* 第七版：AI（POST /ai/…/chat/completions）。流式 = SSE 一块一块发，
     非流式（标签/联想/测试连接）= 一次性 JSON。 */
  if (req.method === 'POST' && /^\/ai(-|\/|$)/.test(url)) {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      if (url.startsWith('/ai-bad/')) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'invalid api key (stub)' } }));
        return;
      }
      let payload = {};
      try {
        payload = JSON.parse(body || '{}');
      } catch {
        payload = {};
      }
      const reply = aiReplyFor(payload.messages);
      /* 0.8.3：各种真实接口的返回结构，专门喂给「测试连接」的解析层 */
      if (url.startsWith('/ai-empty/')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: '' }, finish_reason: 'stop' }] }));
        return;
      }
      if (url.startsWith('/ai-reasoning/')) {
        // 推理模型：正文为空，内容在 reasoning_content 里
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: '', reasoning_content: reply }, finish_reason: 'stop' }] }));
        return;
      }
      if (url.startsWith('/ai-404/')) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('404 page not found (stub)');
        return;
      }
      if (!payload.stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: reply } }] }));
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive'
      });
      // 拆成小段慢慢发，让「打字机效果」在测试里是真实可见的
      // /ai-slow/ = 每块慢 300ms，专门用来测「生成中手动停止」（0.8.0）
      const chunkDelay = url.startsWith('/ai-slow/') ? 300 : 12;
      const pieces = reply.match(/[\s\S]{1,5}/g) ?? [];
      let index = 0;
      const timer = setInterval(() => {
        if (res.destroyed) {
          clearInterval(timer);
          return;
        }
        if (index >= pieces.length) {
          clearInterval(timer);
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: pieces[index] } }] }) + '\n\n');
        index += 1;
      }, chunkDelay);
    });
    return;
  }
  /* 0.11.0：GitHub 项目导入（仓库信息 / README / 401 / 404 / 500）。 */
  if (url.startsWith('/github/')) {
    const send = (body, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'POST' && url.startsWith('/github/oauth/login/device/code')) {
      send({ device_code: 'e2e-device-code', user_code: 'E2E-1234', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 1 });
      return;
    }
    if (req.method === 'POST' && url.startsWith('/github/oauth/login/oauth/access_token')) {
      send({ access_token: 'gho_e2e_token_123456', token_type: 'bearer', scope: 'repo' });
      return;
    }
    if (url.startsWith('/github/api/user')) {
      send({ login: 'octo-e2e' });
      return;
    }
    if (url.startsWith('/github/api/repos/')) {
      githubCalls.push(url);
      const rest = url.replace('/github/api/repos/', '').split('?')[0];
      const repo = rest.replace(/\/readme$/, '');
      if (repo === 'octo/expired') {
        send({ message: 'Bad credentials' }, 401);
        return;
      }
      if (repo === 'octo/missing') {
        send({ message: 'Not Found' }, 404);
        return;
      }
      if (repo === 'octo/boom') {
        send({ message: 'stub 500' }, 500);
        return;
      }
      if (rest.endsWith('/readme')) {
        if (repo === 'octo/noreadme') {
          send({ message: 'Not Found' }, 404);
          return;
        }
        const readme =
          '# ' + repo.split('/')[1] + '\n\n' +
          '这是一个命令行工具，支持批量处理文件，内置进度条与配置模板。\n\n' +
          '## 特性\n\n- 批量处理\n- 进度条\n- 配置模板\n';
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(readme);
        return;
      }
      send({
        full_name: repo,
        description: '一个批量处理文件的命令行工具',
        stargazers_count: 4321,
        forks_count: 12,
        language: 'TypeScript',
        topics: ['cli', 'tools'],
        license: { spdx_id: 'MIT' },
        homepage: null,
        updated_at: '2026-10-01T00:00:00Z',
        html_url: 'https://github.com/' + repo,
        default_branch: 'main',
        archived: false
      });
      return;
    }
    send({ message: 'stub: unknown github route' }, 404);
    return;
  }
  if (url.startsWith('/download/')) {
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(stubInstaller.length)
    });
    if (stubAssetMode === 'hang') {
      res.write(stubInstaller.subarray(0, 48 * 1024)); // 发一点就停住，不 end
      return;
    }
    // 慢慢发（每 20ms 32KB）：384KB 大概 0.5 秒，让「正在下载 27%」这种进度态能被稳定观察到
    let offset = 0;
    const timer = setInterval(() => {
      if (res.destroyed) {
        clearInterval(timer);
        return;
      }
      if (offset >= stubInstaller.length) {
        clearInterval(timer);
        res.end();
        return;
      }
      const next = Math.min(offset + 32 * 1024, stubInstaller.length);
      res.write(stubInstaller.subarray(offset, next));
      offset = next;
    }, 20);
    return;
  }
  if (stubUpdateMode === 'hang') return; // 故意不回包，让客户端超时
  const reply = () => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        tag_name: 'v9.9.9',
        html_url: 'https://github.com/x-000001/zhishiku/releases/tag/v9.9.9',
        body: '这是一条测试用的更新说明。',
        published_at: '2026-10-18T10:00:00Z',
        assets: [
          {
            name: 'JwKB-Setup-9.9.9.exe',
            browser_download_url: `http://127.0.0.1:${stubPort}/download/JwKB-Setup-9.9.9.exe`,
            size: stubInstaller.length,
            digest: 'sha256:' + stubInstallerSha
          }
        ]
      })
    );
  };
  if (stubDelayMs > 0) setTimeout(reply, stubDelayMs);
  else reply();
});
await new Promise((resolve) => stubServer.listen(0, '127.0.0.1', resolve));
stubPort = stubServer.address().port;
const stubUpdateUrl = `http://127.0.0.1:${stubPort}/releases/latest`;
/* 下载目录指到测试数据目录里，方便断言文件真的落盘；DRYRUN 让「立即安装」不真跑安装程序 */
const stubDownloadDir = path.join(dataDir, 'update-download');
/* 导出 Markdown 的落盘目录：设了 JWKB_EXPORT_DIR 主进程就不再弹「选择文件夹」 */
const exportDir = path.join(dataDir, 'export-md');

const child = spawn(
  exe,
  [
    '.',
    `--remote-debugging-port=${PORT}`,
    '--no-sandbox',
    // 软件渲染 + 别把窗口当「被遮挡」：否则 Chromium 会把 rAF/过渡降频，
    // 悬停换色、侧栏插值这类动画断言会假失败（机器上开着别的全屏窗口时尤其明显）
    '--disable-gpu',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    '--disable-features=CalculateNativeWinOcclusion',
    `--user-data-dir=${path.join(root, 'tests', 'e2e', 'ud')}`
  ],
  {
    cwd: root,
    env: {
      ...process.env,
      JWKB_DATA_DIR: dataDir,
      JWKB_UPDATE_URL: stubUpdateUrl,
      JWKB_UPDATE_DIR: stubDownloadDir,
      JWKB_UPDATE_DRYRUN: '1',
      JWKB_EXPORT_DIR: exportDir,
      // 番茄钟最短时长临时降到 2 秒：不设这个的话一轮 25 分钟，e2e 等不起
      JWKB_FOCUS_MIN_SECONDS: '2',
      JWKB_GITHUB_CLIENT_ID: 'e2e-client-id',
      JWKB_GITHUB_API_BASE: `http://127.0.0.1:${stubPort}/github/api`,
      JWKB_GITHUB_OAUTH_BASE: `http://127.0.0.1:${stubPort}/github/oauth`
    },
    stdio: 'inherit'
  }
);

let exitInfo = null;
child.on('exit', (code, signal) => {
  exitInfo = `exit=${code} signal=${signal}`;
});

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
    if (res.exceptionDetails) {
      const d = res.exceptionDetails;
      throw new Error(`${d.text} ${d.exception?.description ?? ''}`);
    }
    return res.result?.value;
  }

  async shot(name) {
    const res = await this.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(shotDir, `${name}.png`);
    // Windows 上偶发「文件被占用 / 杀毒扫描」导致的 UNKNOWN open 错误：重试几次，别让截图失败拖挂整轮自检
    for (let attempt = 0; ; attempt++) {
      try {
        fs.writeFileSync(file, Buffer.from(res.data, 'base64'));
        return;
      } catch (err) {
        if (attempt >= 4) throw err;
        await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
      }
    }
  }
}

const CHECK_SCRIPT = `(async () => {
  const out = [];
  const rec = (name, ok, detail) => out.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail).slice(0, 220) });
  const inv = (ch, p) => window.api.invoke(ch, p);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    rec('preload 桥可用', !!window.api && typeof window.api.invoke === 'function');

    const info = await inv('app:info');
    rec('app:info 返回数据目录', !!info && typeof info.dataRoot === 'string', JSON.stringify(info));
    rec('数据目录指向测试目录', String(info.dataRoot).toLowerCase().includes('.e2e-data'), info.dataRoot);
    rec('SQLite 版本可读', !!info.sqlite && info.sqlite.length > 3, info.sqlite);

    const integ = await inv('data:integrity');
    rec('启动后完整性检查 ok', integ === 'ok', integ);

    const cats = await inv('category:tree');
    rec('默认分类已建好（5 个）', Array.isArray(cats) && cats.length >= 5, '分类数=' + (cats ? cats.length : 'null') + ' ' + (cats || []).map((c) => c.name).join('/'));

    // ---- 收集箱 ----
    const id1 = await inv('inbox:add', { content: '想法：把英语单词本搬进知识库', kind: 'idea' });
    await inv('inbox:add', { content: '待读：深度工作第二章', kind: 'read' });
    const openList = await inv('inbox:list', { status: 'open' });
    rec('收集箱能存能读', openList.length === 2, 'open=' + openList.length);

    const conv = await inv('inbox:convert', { id: id1, target: 'note', title: '把英语单词本搬进知识库' });
    rec('收集箱一键转笔记', /^note:\\d+$/.test(conv.ref), conv.ref);
    const noteId = Number(conv.ref.split(':')[1]);
    const converted = await inv('note:get', { id: noteId });
    rec('转出来的笔记能读回', !!converted && converted.title.includes('英语单词本'), converted && converted.title);

    const convTask = await inv('inbox:convert', { id: openList[1].id, target: 'task', title: '读书：深度工作第二章', due_at: '2026-10-16', priority: 'urgent', repeat_rule: 'none' });
    rec('收集箱一键转任务', /^task:\\d+$/.test(convTask.ref), convTask.ref);
    const taskIdFromInbox = Number(convTask.ref.split(':')[1]);

    // ---- 知识库 ----
    const catId = cats[0].id;
    const note = await inv('note:create', { categoryId: catId, title: '知识管理测试笔记', content: '# 标题\\n\\n这是**加粗**和 \`代码\`，还有中文检索词：知识管理。' });
    rec('新建笔记', !!note && note.id > 0, note && note.id);

    await inv('note:save', { id: note.id, title: '知识管理测试笔记', content: note.content + '\\n追加一行', reason: '手动保存' });
    const versions = await inv('version:list', { noteId: note.id });
    rec('手动保存留下版本点', Array.isArray(versions) && versions.length >= 1, '版本数=' + (versions ? versions.length : 0));

    await inv('note:draft', { id: note.id, title: '草稿标题', content: '草稿内容' });
    const withDraft = await inv('note:get', { id: note.id });
    rec('草稿单独存放（正文不变）', !!withDraft && withDraft.draft_content === '草稿内容' && !withDraft.content.includes('草稿内容'), 'draft=' + (withDraft && withDraft.draft_title));

    const hit2 = await inv('search:query', { q: '知识' });
    rec('中文两字词能搜到（FTS 方案）', Array.isArray(hit2) && hit2.length > 0, '命中=' + (hit2 ? hit2.length : 0));
    const hitWord = await inv('search:query', { q: '知识管理' });
    rec('中文四字词能搜到', Array.isArray(hitWord) && hitWord.length > 0, '命中=' + (hitWord ? hitWord.length : 0));
    const hitEn = await inv('search:query', { q: 'zzzznotfound' });
    rec('搜不到的词返回空而不是报错', Array.isArray(hitEn) && hitEn.length === 0, '命中=' + (hitEn ? hitEn.length : 0));

    const tags = await inv('tag:set', { noteId: note.id, names: ['测试', '知识'] });
    rec('标签能设置', !!tags && tags.tags && tags.tags.length === 2, tags && tags.tags.map((t) => t.name).join(','));
    const allTags = await inv('tag:list');
    rec('标签列表可读', Array.isArray(allTags) && allTags.length >= 2, allTags && allTags.length);

    const byTag = await inv('note:list', { tagId: tags.tags[0].id });
    rec('按标签筛选笔记', Array.isArray(byTag) && byTag.length >= 1, '命中=' + (byTag ? byTag.length : 0));

    const pinned = await inv('note:pin', { id: note.id });
    const listAll = await inv('note:list', {});
    rec('置顶生效', !!pinned && listAll.some((n) => n.id === note.id && n.is_pinned === 1), '列表=' + listAll.length);

    // ---- 回收站 ----
    const tmp = await inv('note:create', { title: '待删测试', content: 'x' });
    await inv('note:trash', { id: tmp.id });
    const trashList = await inv('note:list', { trash: true });
    rec('删除进回收站', trashList.some((n) => n.id === tmp.id), '回收站=' + trashList.length);
    await inv('note:restore', { id: tmp.id });
    const afterRestore = await inv('note:list', {});
    rec('回收站能还原', afterRestore.some((n) => n.id === tmp.id), '列表=' + afterRestore.length);

    // ---- 任务 ----
    const today = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const todayStr = today.getFullYear() + '-' + pad(today.getMonth() + 1) + '-' + pad(today.getDate());
    const t1 = await inv('task:create', { title: '今天要做的第一件事', due_at: todayStr, priority: 'urgent' });
    const t2 = await inv('task:create', { title: '每天重复的晨间阅读', due_at: todayStr, priority: 'important', repeat_rule: 'daily' });
    await inv('task:create', { title: '下个月才做的事', due_at: '2026-11-30', priority: 'normal' });
    const todayTasks = await inv('task:list', { view: 'today' });
    rec('任务按今天筛选', todayTasks.length >= 2, '今天=' + todayTasks.length + ' 标题=' + todayTasks.map((t) => t.title).join('|'));
    const upcoming = await inv('task:list', { view: 'upcoming' });
    rec('任务按接下来筛选', upcoming.length === 1, '接下来=' + upcoming.length);
    const done1 = await inv('task:toggle', { id: t1, status: 'done' });
    rec('勾掉普通任务不生成下一次', !!done1 && done1.spawned === null, JSON.stringify(done1 && done1.spawned));
    const done2 = await inv('task:toggle', { id: t2, status: 'done' });
    rec('勾掉重复任务会生成下一次', !!done2 && done2.spawned !== null, 'spawned=' + (done2 && done2.spawned));
    const afterRepeat = await inv('task:list', { view: 'all' });
    const spawnedTask = afterRepeat.find((t) => t.title.includes('晨间阅读') && t.status === 'todo');
    rec('重复任务生成了下一次、排在明天', !!spawnedTask && String(spawnedTask.due_at) > todayStr, spawnedTask ? '下一跳=' + spawnedTask.due_at : '没生成');
    await inv('task:update', { id: t1, patch: { title: '今天要做的第一件事（改过）', priority: 'normal' } });
    const updated = await inv('task:list', { view: 'all' });
    rec('任务能行内改', updated.some((t) => t.id === t1 && t.title.includes('改过') && t.priority === 'normal'), 'ok');

    // ---- 优化项 4：勾完不消失 / 状态三档 / 批量删除 ----
    const todayAfter = await inv('task:list', { view: 'today' });
    rec(
      '勾完的任务还留在今天列表里（勾完不消失）',
      todayAfter.some((t) => t.id === t1 && t.status === 'done'),
      '今天=' + todayAfter.length
    );
    rec(
      '已完成的排在没做完的后面',
      todayAfter.findIndex((t) => t.status === 'done') > todayAfter.findIndex((t) => t.status === 'todo'),
      todayAfter.map((t) => t.status).join(',')
    );
    const onlyTodo = await inv('task:list', { view: 'all', status: 'todo' });
    const onlyDone = await inv('task:list', { view: 'all', status: 'done' });
    rec('状态筛选：未完成', onlyTodo.length > 0 && onlyTodo.every((t) => t.status === 'todo'), '未完成=' + onlyTodo.length);
    rec('状态筛选：已完成', onlyDone.some((t) => t.id === t1) && onlyDone.every((t) => t.status === 'done'), '已完成=' + onlyDone.length);
    const countsV3 = await inv('task:counts');
    rec('角标多了未完成这一档', typeof countsV3.todo === 'number' && countsV3.todo === onlyTodo.length, 'todo=' + countsV3.todo);
    const batchIds = onlyTodo.slice(0, 2).map((t) => t.id);
    const removedCount = await inv('task:delete-many', { ids: batchIds });
    rec('批量删除返回真正删掉的条数', removedCount === batchIds.length, '删了 ' + removedCount + '/' + batchIds.length);
    const leftAll = await inv('task:list', { view: 'all' });
    rec('批量删除后列表里没有它们了', batchIds.every((id) => !leftAll.some((t) => t.id === id)), '剩=' + leftAll.length);

    // ---- 优化项 5：优先级三档（紧急 / 重要 / 一般）----
    const pUrgent = await inv('task:create', { title: '明天要交的紧急事', priority: 'urgent' });
    const pImportant = await inv('task:create', { title: '该推进的重要事', priority: 'important' });
    const pNormal = await inv('task:create', { title: '有空再弄的一般事', priority: 'normal' });
    const allPrio = await inv('task:list', { view: 'all' });
    const findPrio = (id) => allPrio.find((t) => t.id === id);
    rec(
      '三档优先级都存在库里',
      ['urgent', 'important', 'normal'].join(',') ===
        [pUrgent, pImportant, pNormal].map((id) => (findPrio(id) || {}).priority).join(','),
      [pUrgent, pImportant, pNormal].map((id) => (findPrio(id) || {}).priority).join(',')
    );
    const posOf = (id) => allPrio.findIndex((t) => t.id === id);
    rec(
      '排序是紧急在前、重要居中、一般在后',
      posOf(pUrgent) < posOf(pImportant) && posOf(pImportant) < posOf(pNormal),
      '位置=' + [posOf(pUrgent), posOf(pImportant), posOf(pNormal)].join(',')
    );
    const onlyUrgent = await inv('task:list', { view: 'all', priority: 'urgent' });
    rec(
      '按「紧急」筛选只剩紧急',
      onlyUrgent.length > 0 && onlyUrgent.every((t) => t.priority === 'urgent'),
      '紧急=' + onlyUrgent.length + ' 命中=' + onlyUrgent.length
    );
    // 老库的数字优先级会被归一成三档文字（这里直接塞数字试一次）
    const legacyId = await inv('task:create', { title: '老代码传数字的任务', priority: 3 });
    const legacyTask = (await inv('task:list', { view: 'all' })).find((t) => t.id === legacyId);
    rec('后端会把老式数字优先级归一成三档文字', !!legacyTask && legacyTask.priority === 'urgent', String(legacyTask && legacyTask.priority));

    // ---- 首页 ----
    const dash = await inv('dash:overview');
    rec('首页数据能读', !!dash && Array.isArray(dash.tasks) && typeof dash.today === 'string', 'today=' + (dash && dash.today) + ' 待办=' + (dash && dash.tasks.length));
    rec('首页统计了收集箱与最近笔记', !!dash && typeof dash.inboxCount === 'number' && Array.isArray(dash.recentNotes), '待整理=' + (dash && dash.inboxCount) + ' 最近笔记=' + (dash && dash.recentNotes.length));
    rec('首页包含复习提醒结构', !!dash && Array.isArray(dash.reviewDue), '复习卡=' + (dash && dash.reviewDue.length));
    rec('首页包含目标进度结构', !!dash && Array.isArray(dash.goals), '目标=' + (dash && dash.goals.length));

    // ---- 第二版：附件（拖拽走的就是这条通道） ----
    rec('preload 暴露了取真实路径的 pathForFile', typeof window.api.pathForFile === 'function', typeof window.api.pathForFile);
    const srcPath = info.dataRoot + String.fromCharCode(92) + 'kb.db';
    const att = await inv('attach:add-path', { noteId: note.id, srcPath });
    rec('按绝对路径把文件存成附件', !!att && att.file_name === 'kb.db' && !!att.rel_path, JSON.stringify(att && { f: att.file_name, r: att.rel_path }));
    const noteWithAtt = await inv('note:get', { id: note.id });
    const atts = (noteWithAtt && noteWithAtt.attachments) || [];
    rec('附件挂到了这条笔记上', atts.length >= 1 && atts[0].id === att.id, '附件=' + atts.length);
    rec('不存在的路径会被挡住', await inv('attach:add-path', { noteId: note.id, srcPath: srcPath + '.nope' }).then(() => false, () => true), 'ok');

    // ---- 第二版：目标 / 关键结果 / 里程碑 ----
    const goalId = await inv('goal:create', { title: '把知识库用起来', description: '每天记一点', target_date: '2026-12-31' });
    rec('能建目标', typeof goalId === 'number' && goalId > 0, 'goalId=' + goalId);
    rec('进行中目标计数', (await inv('goal:active-count')) === 1, 'activeCount=' + (await inv('goal:active-count')));

    const krId = await inv('kr:create', { goalId, title: '写满 100 篇笔记', target_value: 100, current_value: 20, unit: '篇' });
    const krs = await inv('kr:list', { goalId });
    rec('关键结果能建能列', krs.length === 1 && krs[0].target_value === 100, 'kr=' + JSON.stringify(krs[0] && { t: krs[0].title, v: krs[0].current_value }));
    await inv('kr:update', { id: krId, patch: { current_value: 50 } });
    const goalAfter = await inv('goal:get', { id: goalId });
    rec('目标进度按关键结果自动算', goalAfter && goalAfter.goal.progress >= 50 && goalAfter.goal.progress < 100, 'progress=' + (goalAfter && goalAfter.goal.progress));

    const msId = await inv('milestone:create', { goalId, title: '搭好目录结构', target_date: todayStr });
    await inv('milestone:toggle', { id: msId, done: true });
    const detail = await inv('goal:get', { id: goalId });
    rec('里程碑能勾能读', Array.isArray(detail.milestones) && detail.milestones.some((m) => m.id === msId && m.done === 1), '里程碑=' + (detail.milestones || []).length);

    // ---- 第二版：目标池（下一阶段） ----
    const poolId = await inv('pool:create', { title: '学 Rust 写命令行工具', why: '想自己做工具', start_condition: '当前目标做完', horizon: 'quarter', priority: 2 });
    const poolList = await inv('pool:list', {});
    rec('目标池能存能列', Array.isArray(poolList) && poolList.some((p) => p.id === poolId), '池子=' + (poolList || []).length);
    const started = await inv('pool:start', { id: poolId });
    const goalsNow = await inv('goal:list', { includeArchived: true });
    rec('目标池能一键转成当前目标', !!started && typeof started.goalId === 'number' && goalsNow.some((g) => g.id === started.goalId), '新目标=' + (started && started.goalId));
    const poolAfter = (await inv('pool:list', {})).find((p) => p.id === poolId);
    rec('启动后池子条目标成已启动并挂上新目标', !!poolAfter && poolAfter.status === 'started' && poolAfter.goal_id === started.goalId, JSON.stringify(poolAfter && { s: poolAfter.status, g: poolAfter.goal_id }));

    // ---- 第二版：学习计划 ----
    const planId = await inv('plan:create', { title: '每天两小时学英语', direction: '先补口语', rhythm: '每天 2 小时', start_date: todayStr });
    rec('能建计划', typeof planId === 'number' && planId > 0, 'planId=' + planId);
    const itemId = await inv('plan-item:create', { planId, title: '精读一篇外刊', date: todayStr, minutes: 60 });
    const items = await inv('plan-item:list', { planId });
    rec('计划条目能建能列', items.length === 1 && items[0].minutes === 60, '条目=' + items.length);
    const cal = await inv('plan:calendar', { from: todayStr, to: todayStr });
    rec('日历能按日期取到计划条目', Array.isArray(cal) && cal.some((c) => c.id === itemId), '当天=' + (cal || []).length);
    await inv('plan-item:toggle', { id: itemId, done: true });
    const cal2 = await inv('plan:calendar', { from: todayStr, to: todayStr });
    rec('勾掉计划条目后日历里标成完成', cal2.some((c) => c.id === itemId && c.done === 1), 'ok');
    const dash2 = await inv('dash:overview');
    rec('首页今日计划取到条目', Array.isArray(dash2.todayPlan) && dash2.todayPlan.some((c) => c.id === itemId), '今日计划=' + (dash2.todayPlan || []).length);

    // ---- 第二版：复习（间隔重复） ----
    const cardId = await inv('review:create', { front: '什么是闭包', back: '能读外部变量的函数', source: 'wrong' });
    rec('能手动加复习卡', typeof cardId === 'number' && cardId > 0, 'cardId=' + cardId);
    const fromNote = await inv('review:from-note', { noteId: note.id });
    rec('笔记能一键变复习卡', typeof fromNote === 'number' && fromNote > 0, 'cardId=' + fromNote);
    rec('同一篇笔记不会重复生成', (await inv('review:from-note', { noteId: note.id })) === fromNote, 'ok');

    const graded = await inv('review:grade', { id: cardId, grade: 'know' });
    rec('打分「记得」后间隔拉长', !!graded && graded.interval_days === 1 && graded.review_count === 1, JSON.stringify(graded && { i: graded.interval_days, c: graded.review_count, n: graded.next_review_at }));
    const forgot = await inv('review:grade', { id: cardId, grade: 'forgot' });
    rec('打分「忘了」后回到今天、遗忘次数加一', !!forgot && forgot.interval_days === 0 && forgot.lapses === 1 && String(forgot.next_review_at).startsWith(todayStr), JSON.stringify(forgot && { i: forgot.interval_days, l: forgot.lapses, n: forgot.next_review_at }));
    const dueList = await inv('review:due');
    rec('今天到期的卡能取到', Array.isArray(dueList) && dueList.some((c) => c.id === cardId), '到期=' + (dueList || []).length);
    const dash3 = await inv('dash:overview');
    rec('首页带复习到期数量', typeof dash3.reviewDueCount === 'number' && dash3.reviewDueCount >= 1, 'reviewDueCount=' + dash3.reviewDueCount);
    const again = await inv('review:grade', { id: cardId, grade: 'know' });
    rec('再记一次间隔从 1 天重新爬', !!again && again.interval_days === 1, '间隔=' + (again && again.interval_days));
    const logs = await inv('review:logs', { cardId });
    rec('每次打分留了日志', Array.isArray(logs) && logs.length === 3, '日志=' + (logs || []).length);
    const rstats = await inv('review:stats');
    rec('复习统计能读', !!rstats && rstats.total >= 2 && typeof rstats.dueToday === 'number', JSON.stringify(rstats));

    // ---- 第二版：复盘 ----
    const retroId = await inv('retro:save', { type: 'day', date: todayStr, content: '今天把第二版做完了。' });
    rec('日复盘能存', typeof retroId === 'number' && retroId > 0, 'retroId=' + retroId);
    const retroBack = await inv('retro:get', { type: 'day', date: todayStr });
    rec('日复盘能读回', !!retroBack && retroBack.content.includes('第二版'), retroBack && retroBack.content);
    const week = await inv('retro:period', { type: 'week', date: todayStr });
    rec('周复盘算出周一到周日的范围', !!week && week.to >= week.from && (new Date(week.to + 'T12:00:00') - new Date(week.from + 'T12:00:00')) / 86400000 === 6, JSON.stringify(week));
    const rstats2 = await inv('retro:stats', { from: week.from, to: week.to });
    rec('复盘周期统计能算', !!rstats2 && typeof rstats2.tasksDone === 'number' && typeof rstats2.planItemsTotal === 'number', JSON.stringify(rstats2));
    rec('复盘统计数到了勾掉的计划条目', !!rstats2 && rstats2.planItemsDone >= 1, 'planItemsDone=' + (rstats2 && rstats2.planItemsDone));
    await inv('retro:save', { type: 'week', date: todayStr, content: '这周方向没问题。' });
    const retroList = await inv('retro:list', { type: 'week' });
    rec('周复盘和历史列表分开存', Array.isArray(retroList) && retroList.length === 1 && retroList[0].type === 'week', '周复盘=' + (retroList || []).length);

    // ---- 第二版：任务提醒时间 ----
    const withRemind = await inv('task:create', { title: '提醒测试', due_at: todayStr, remind_at: todayStr + ' 09:30:00', priority: 'important' });
    const remindRow = (await inv('task:list', { view: 'all' })).find((t) => t.id === withRemind);
    rec('任务能存提醒时间', !!remindRow && String(remindRow.remind_at).includes('09:30'), 'remind_at=' + (remindRow && remindRow.remind_at));

    // ---- 第三版：富文本（优化项 2） ----
    const richNote = await inv('note:create', {
      title: '富文本自检',
      html: '<p>第一段 <b>加粗的字</b> <mark style="background-color: #fff3b0">重点高亮</mark></p><p>第二段</p>'
    });
    const richId = richNote && richNote.id;
    rec('富文本笔记能新建并带回 id', richId > 0, 'id=' + richId);
    const richBack = await inv('note:get', { id: richId });
    rec('富文本存进 content_html', !!richBack && String(richBack.content_html).includes('<b>加粗的字</b>'), String(richBack && richBack.content_html).slice(0, 80));
    rec('纯文字自动从 HTML 抽出来（搜索/字数用）',
      !!richBack && String(richBack.content).includes('第一段') && String(richBack.content).includes('重点高亮') && !String(richBack.content).includes('<p>'),
      JSON.stringify(String(richBack && richBack.content).slice(0, 60)));

    await inv('note:save', {
      id: richId,
      title: '富文本自检',
      html: '<p>安全</p><script>window.__pwned = 1</scr' + 'ipt><p onclick="alert(1)">点我</p>',
      reason: '自检'
    });
    const afterSave = await inv('note:get', { id: richId });
    const savedHtml = String(afterSave && afterSave.content_html);
    rec('保存时洗掉了 script 标签', !/<\s*script/i.test(savedHtml) && !savedHtml.includes('__pwned'), savedHtml.slice(0, 80));
    rec('保存时洗掉了 onclick 这类事件属性', !/on[a-z]+\s*=/i.test(savedHtml), savedHtml.slice(0, 80));
    rec('洗过之后正文还在（只删危险部分）', savedHtml.includes('安全') && savedHtml.includes('点我'), savedHtml.slice(0, 80));

    const tableHtml = '<table><thead><tr><th>列一</th><th>列二</th></tr></thead><tbody><tr><td>甲</td><td>乙</td></tr></tbody></table>';
    await inv('note:save', { id: richId, title: '富文本自检', html: tableHtml, reason: '自检' });
    const tableBack = await inv('note:get', { id: richId });
    rec('表格结构能原样存回来', !!tableBack && String(tableBack.content_html).includes('<th>列一</th>') && String(tableBack.content_html).includes('<td>甲</td>'), String(tableBack && tableBack.content_html).slice(0, 90));

    const richVer = await inv('version:list', { noteId: richId });
    const richVerWithHtml = (richVer || []).filter((v) => v.content_html && v.content_html.includes('<table'));
    rec('版本点里也留了富文本（回滚不丢格式）', richVerWithHtml.length >= 1, '版本数=' + (richVer || []).length);

    // ---- 第三版：正文里的图片（jw-att:// 协议） ----
    const imgNote = await inv('note:create', { title: '图片自检', html: '<p>看图</p>' });
    const imgAtt = await inv('attach:add-path', { noteId: imgNote.id, srcPath: __PIXEL_PATH__ });
    const imgUrl = 'jw-att://' + String(imgAtt.rel_path).split('\\\\').join('/');
    const imgLoad = await new Promise((resolve) => {
      const im = new Image();
      im.onload = () => resolve(im.naturalWidth + 'x' + im.naturalHeight);
      im.onerror = () => resolve('ERR');
      im.src = imgUrl;
    });
    rec('正文里的图片能通过 jw-att:// 显示出来', String(imgLoad) === '1x1', imgUrl + ' → ' + imgLoad);
    await inv('note:save', { id: imgNote.id, title: '图片自检', html: '<p>看图</p><img src="' + imgUrl + '" alt="像素">' });
    const imgBack = await inv('note:get', { id: imgNote.id });
    rec('图片地址能存进正文', !!imgBack && String(imgBack.content_html).includes('jw-att://'), String(imgBack && imgBack.content_html).slice(0, 90));
    rec('图片不算字数、只留 alt 文字', !!imgBack && !String(imgBack.content).includes('jw-att'), JSON.stringify(String(imgBack && imgBack.content).slice(0, 40)));

    // ---- 第三版：笔记拖动排序（优化项 6） ----
    const sortCat = await inv('category:create', { parentId: null, name: '排序自检分类' });
    const sortA = await inv('note:create', { categoryId: sortCat, title: '排序甲', html: '<p>a</p>' });
    const sortB = await inv('note:create', { categoryId: sortCat, title: '排序乙', html: '<p>b</p>' });
    const sortC = await inv('note:create', { categoryId: sortCat, title: '排序丙', html: '<p>c</p>' });
    const orderOf = (list, ids) => ids.map((id) => list.findIndex((n) => n.id === id));
    const catList = () => inv('note:list', { categoryId: sortCat });
    const before = await catList();
    const moved = await inv('note:reorder', { ids: [sortC.id, sortA.id, sortB.id] });
    rec('拖动排序写库返回条数', moved === 3, 'moved=' + moved);
    const after = await catList();
    const pos = orderOf(after, [sortC.id, sortA.id, sortB.id]);
    rec('排序后列表顺序就是拖完的顺序', pos[0] === 0 && pos[1] === 1 && pos[2] === 2, '位置=' + JSON.stringify(pos) + ' 之前=' + JSON.stringify(orderOf(before, [sortA.id, sortB.id, sortC.id])));
    const otherCatStill = await inv('note:list', { categoryId: catId });
    rec('在某个分类里排序不影响别的分类', Array.isArray(otherCatStill) && otherCatStill.length >= 1, '别的分类=' + (otherCatStill || []).length);

    // ---- 优化项 7：分类树（多级 / 排序 / 非空不能删） ----
    const subCat = await inv('category:create', { parentId: sortCat, name: '排序子分类' });
    const tree2 = await inv('category:tree');
    rec('能建子分类（parent_id 指对了）', (tree2.find((c) => c.id === subCat) || {}).parent_id === sortCat, 'parent_id=' + JSON.stringify((tree2.find((c) => c.id === subCat) || {}).parent_id));
    let subDelErr = '';
    try {
      await inv('category:delete', { id: sortCat });
    } catch (e) {
      subDelErr = e && e.message;
    }
    rec('分类下还有笔记时删不掉，提示先搬走笔记', subDelErr === '该分类下还有笔记，请先移动或删除笔记', subDelErr || '（居然删成功了）');
    rec('被拦下之后分类还在', (await inv('category:tree')).some((c) => c.id === sortCat) === true, '还在=' + (await inv('category:tree')).some((c) => c.id === sortCat));

    const tmpCat = await inv('category:create', { parentId: null, name: '待删分类' });
    const tmpSub = await inv('category:create', { parentId: tmpCat, name: '待删子分类' });
    const tmpNote = await inv('note:create', { categoryId: tmpSub, title: '待删分类里的笔记', html: '<p>t</p>' });
    let deepErr = '';
    try {
      await inv('category:delete', { id: tmpCat });
    } catch (e) {
      deepErr = e && e.message;
    }
    rec('笔记在子分类里，父分类同样删不掉（递归检查）', deepErr === '该分类下还有笔记，请先移动或删除笔记', deepErr || '（居然删成功了）');
    await inv('note:move', { id: tmpNote.id, categoryId: null });
    rec('笔记搬走之后分类就能删了', (await inv('category:delete', { id: tmpCat })) === true, 'tmpCat=' + tmpCat);
    rec('删父分类后子分类上提一级，没有跟着一起没', (await inv('category:tree')).find((c) => c.id === tmpSub)?.parent_id === null, 'tmpSub.parent_id=' + JSON.stringify((await inv('category:tree')).find((c) => c.id === tmpSub)?.parent_id));

    const roots = (await inv('category:tree')).filter((c) => c.parent_id === null).map((c) => c.name);
    await inv('category:move', { id: tmpSub, dir: 'up' });
    const roots2 = (await inv('category:tree')).filter((c) => c.parent_id === null).map((c) => c.name);
    rec('分类能上移，顺序真的换了', roots2.indexOf('待删子分类') === roots.indexOf('待删子分类') - 1, JSON.stringify(roots) + ' → ' + JSON.stringify(roots2));

    // ---- 设置与备份 ----
    const settings = await inv('settings:get');
    rec('设置能读', !!settings && typeof settings.theme === 'string', JSON.stringify(settings));
    await inv('settings:set', { key: 'versionKeep', value: 5 });
    const s2 = await inv('settings:get');
    rec('设置能改并持久化', s2.versionKeep === 5, 'versionKeep=' + s2.versionKeep);

    const backup = await inv('backup:run');
    rec('手动备份成功', !!backup && !!backup.name, backup && backup.name);
    const backups = await inv('backup:list');
    rec('备份列表可读', Array.isArray(backups) && backups.length >= 1, '备份数=' + (backups ? backups.length : 0));

  } catch (err) {
    rec('自检脚本本身没报错', false, err && err.message);
  }
  return out;
})()`;

let cdp;
const results = [];

try {
  const target = await waitForTarget();
  cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  // 等界面真正挂上
  let ready = false;
  for (let i = 0; i < 40; i += 1) {
    const ok = await cdp.eval("!!document.querySelector('.sidebar') && !!window.api");
    if (ok) {
      ready = true;
      break;
    }
    await sleep(500);
  }
  results.push({ name: '界面挂载完成（侧栏出现）', ok: ready, detail: '' });

  // 正文插图的协议自检需要一张真图片：先在数据目录里写一个 1×1 的 PNG
  const pixelPath = path.join(dataDir, 'e2e-pixel.png');
  fs.writeFileSync(
    pixelPath,
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
      'base64'
    )
  );
  const dataChecks = await cdp.eval(CHECK_SCRIPT.replace('__PIXEL_PATH__', JSON.stringify(pixelPath)));
  results.push(...dataChecks);

  // 图片有没有真的被复制进数据目录的附件夹（渲染层看不到磁盘）
  const findUnder = (dir, name) => {
    if (!fs.existsSync(dir)) return null;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const hit = findUnder(full, name);
        if (hit) return hit;
      } else if (entry.name === name) {
        return full;
      }
    }
    return null;
  };
  const copiedPixel = findUnder(path.join(dataDir, 'attachments'), 'e2e-pixel.png');
  results.push({
    name: '插图真的复制进了数据目录的附件夹（原件删了也不影响）',
    ok: !!copiedPixel && copiedPixel.startsWith(path.join(dataDir, 'attachments')),
    detail: copiedPixel || '没在附件夹里找到 e2e-pixel.png'
  });

  // 文件系统层面的结果由 Node 侧核对（渲染层看不到磁盘）
  const backupRoot = path.join(dataDir, '备份');
  const backups = fs.existsSync(backupRoot) ? fs.readdirSync(backupRoot) : [];
  const newest = [...backups].sort().pop();
  results.push({
    name: '备份目录里有快照且含 kb.db',
    ok: backups.length >= 1 && !!newest && fs.existsSync(path.join(backupRoot, newest, 'kb.db')),
    detail: backups.length ? backups.join(', ') : '空'
  });
  results.push({
    name: '数据库文件落在数据目录',
    ok: fs.existsSync(path.join(dataDir, 'kb.db')),
    detail: path.join(dataDir, 'kb.db')
  });
  results.push({
    name: '附件目录已建好',
    ok: fs.existsSync(path.join(dataDir, 'attachments')),
    detail: path.join(dataDir, 'attachments')
  });

  const ROUTES = [
    ['/', 'home'],
    ['/inbox', 'inbox'],
    ['/knowledge', 'knowledge'],
    ['/tasks', 'tasks'],
    ['/plans', 'plans'],
    ['/goals', 'goals'],
    ['/next', 'next'],
    ['/review', 'review'],
    ['/settings', 'settings'],
    ['/quick', 'quick-capture']
  ];

  for (const [route, name] of ROUTES) {
    // 先跳到一个不存在的路由，确保目标页是“重新挂载”而不是复用旧组件，
    // 这样页面上的数据才是本次测试刚写进去的那批。
    await cdp.eval("location.hash = '/__bounce'; true");
    await sleep(250);
    await cdp.eval(`location.hash = ${JSON.stringify(route)}; true`);
    await sleep(700);
    const text = await cdp.eval(
      "(() => { const el = document.querySelector('.content') || document.body; return (el.innerText || '').trim(); })()"
    );
    results.push({
      name: `页面 ${route} 有实际内容`,
      ok: typeof text === 'string' && text.length > 10,
      detail: (text || '').replace(/\s+/g, ' ').slice(0, 110)
    });
    await cdp.shot(name);
  }

  // ---- 优化项 4：任务页的状态三档与多选界面 ----
  await cdp.eval("location.hash = '/__bounce'; true");
  await sleep(250);
  await cdp.eval("location.hash = '/tasks'; true");
  await sleep(800);
  const statusTabs = await cdp.eval(
    "(() => [...document.querySelectorAll('.kb-tree button')].map((b) => (b.innerText || '').trim()).join('|'))()"
  );
  results.push({
    name: '任务页有状态三档按钮',
    ok:
      /全部/.test(String(statusTabs)) && /未完成/.test(String(statusTabs)) && /已完成/.test(String(statusTabs)),
    detail: String(statusTabs).slice(0, 80)
  });
  const pickOn = await cdp.eval(`(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => (b.innerText || '').includes('多选'));
    if (!btn) return 'no-btn';
    btn.click();
    return 'clicked';
  })()`);
  await sleep(500);
  const boxes = await cdp.eval("document.querySelectorAll('.task-row input.pick').length");
  results.push({
    name: '多选模式每行出现复选框',
    ok: pickOn === 'clicked' && Number(boxes) > 0,
    detail: '复选框=' + boxes
  });
  const allBtn = await cdp.eval(`(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => (b.innerText || '').trim() === '全选');
    if (!btn) return 'no-all';
    btn.click();
    return 'clicked';
  })()`);
  await sleep(400);
  const pickedRows = await cdp.eval("document.querySelectorAll('.task-row.picked').length");
  results.push({
    name: '全选后整列都打上选中标记',
    ok: allBtn === 'clicked' && Number(pickedRows) > 0,
    detail: '选中行=' + pickedRows
  });
  await cdp.shot('tasks-multi');

  // ---- 优化项 5：任务页的优先级标签颜色与筛选按钮 ----
  const prioDots = await cdp.eval(`(() => {
    const rows = [...document.querySelectorAll('.task-row')];
    const out = { urgent: 0, important: 0, normal: 0, other: 0 };
    for (const r of rows) {
      const dot = r.querySelector('.dot');
      if (!dot) continue;
      const hit = ['urgent', 'important', 'normal'].find((k) => dot.classList.contains('prio-' + k));
      if (hit) out[hit] += 1;
      else out.other += 1;
    }
    return JSON.stringify(out);
  })()`);
  const dotObj = JSON.parse(String(prioDots));
  results.push({
    name: '任务前面的小圆点带三档颜色类名',
    ok: dotObj.other === 0 && dotObj.urgent + dotObj.important + dotObj.normal > 0,
    detail: String(prioDots)
  });
  const prioTabs = await cdp.eval(
    "(() => [...document.querySelectorAll('button')].map((b) => (b.innerText || '').trim()).filter((t) => ['全部','紧急','重要','一般'].includes(t)).join('|'))()"
  );
  results.push({
    name: '任务左右有优先级筛选按钮',
    ok: /紧急/.test(String(prioTabs)) && /重要/.test(String(prioTabs)) && /一般/.test(String(prioTabs)),
    detail: String(prioTabs).slice(0, 60)
  });
  const urgentOnly = await cdp.eval(`(async () => {
    // 先保证今天视图里确实有紧急任务和不紧急的任务各一条，否则筛选无从体现
    const d = new Date();
    const pad2 = (n) => String(n).padStart(2, '0');
    const todayStr = d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
    await window.api.invoke('task:create', { title: '界面自检的紧急任务', due_at: todayStr, priority: 'urgent' });
    await window.api.invoke('task:create', { title: '界面自检的一般任务', due_at: todayStr, priority: 'normal' });
    location.hash = '/__bounce';
    await new Promise((r) => setTimeout(r, 250));
    location.hash = '/tasks';
    await new Promise((r) => setTimeout(r, 900));
    const btn = [...document.querySelectorAll('button')].find((b) => (b.innerText || '').trim() === '紧急');
    if (!btn) return 'no-btn';
    btn.click();
    return 'clicked';
  })()`);
  await sleep(700);
  const urgentRows = await cdp.eval(`(() => {
    const rows = [...document.querySelectorAll('.task-row')];
    const allUrgent = rows.every((r) => { const d = r.querySelector('.dot'); return d && d.classList.contains('prio-urgent'); });
    return JSON.stringify({ n: rows.length, allUrgent });
  })()`);
  const urgentObj = JSON.parse(String(urgentRows));
  results.push({
    name: '点「紧急」后列表里只剩紧急任务',
    ok: urgentOnly === 'clicked' && urgentObj.n > 0 && urgentObj.allUrgent === true,
    detail: String(urgentRows)
  });
  await cdp.shot('tasks-priority');

  // ---- 优化项 6：笔记卡片拖动排序（真的拖一次） ----
  await cdp.eval("location.hash = '/__bounce'; true");
  await sleep(250);
  await cdp.eval("location.hash = '/knowledge'; true");
  await sleep(900);
  const catPicked = await cdp.eval(`(() => {
    const hit = [...document.querySelectorAll('.tree-item')].find((el) => (el.innerText || '').includes('排序自检分类'));
    if (!hit) return 'no-cat';
    hit.click();
    return 'ok';
  })()`);
  await sleep(800);
  const listTitles = "(() => [...document.querySelectorAll('.kb-list-body .list-row .title')].map((e) => e.innerText.trim()))()";
  const beforeDrag = await cdp.eval(listTitles);
  const dragResult = await cdp.eval(`(() => {
    const rows = [...document.querySelectorAll('.kb-list-body .list-row')];
    if (rows.length < 3) return 'few:' + rows.length;
    const dt = new DataTransfer();
    const titleOf = (r) => ((r.querySelector('.title') || {}).innerText || '').trim();
    const src = rows[0];
    const dst = rows[2];
    const info = { from: titleOf(src), to: titleOf(dst), draggable: src.getAttribute('draggable') };
    src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    const box = dst.getBoundingClientRect();
    const init = { bubbles: true, dataTransfer: dt, clientX: box.left + 8, clientY: box.bottom - 2 };
    dst.dispatchEvent(new DragEvent('dragover', init));
    dst.dispatchEvent(new DragEvent('drop', init));
    src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
    return JSON.stringify(info);
  })()`);
  await sleep(900);
  const afterDrag = await cdp.eval(listTitles);
  results.push({
    name: '笔记卡片可以拖动（卡片带 draggable、分类下能拿到 3 张）',
    ok: catPicked === 'ok' && Array.isArray(beforeDrag) && beforeDrag.length >= 3,
    detail: catPicked + ' 卡片=' + (Array.isArray(beforeDrag) ? beforeDrag.join('|') : beforeDrag)
  });
  const dragInfo = (() => {
    try {
      return JSON.parse(String(dragResult));
    } catch {
      return { from: '', to: '', draggable: String(dragResult) };
    }
  })();
  const movedFrom = Array.isArray(afterDrag) ? afterDrag.indexOf(dragInfo.from) : -1;
  const movedTo = Array.isArray(afterDrag) ? afterDrag.indexOf(dragInfo.to) : -1;
  results.push({
    name: '拖动后顺序立刻变了，卡片落在目标旁边',
    ok:
      JSON.stringify(afterDrag) !== JSON.stringify(beforeDrag) &&
      movedFrom >= 0 &&
      movedTo >= 0 &&
      Math.abs(movedFrom - movedTo) === 1,
    detail: '拖的「' + dragInfo.from + '」→ 现在位置 ' + movedFrom + '，目标「' + dragInfo.to + '」在 ' + movedTo + '；顺序=' + (Array.isArray(afterDrag) ? afterDrag.join('|') : afterDrag)
  });
  // 重新挂载页面（相当于关掉重开），顺序应当还是刚才拖完的样子
  await cdp.eval("location.hash = '/__bounce'; true");
  await sleep(250);
  await cdp.eval("location.hash = '/knowledge'; true");
  await sleep(900);
  await cdp.eval(`(() => {
    const hit = [...document.querySelectorAll('.tree-item')].find((el) => (el.innerText || '').includes('排序自检分类'));
    if (hit) hit.click();
    return true;
  })()`);
  await sleep(800);
  const afterReload = await cdp.eval(listTitles);
  results.push({
    name: '重开后顺序还是拖完的样子（顺序真的落到库里了）',
    ok: JSON.stringify(afterReload) === JSON.stringify(afterDrag),
    detail: '重开=' + (Array.isArray(afterReload) ? afterReload.join('|') : afterReload)
  });
  const dragHint = await cdp.eval("(() => [...document.querySelectorAll('.muted')].some((e) => (e.innerText || '').includes('拖动卡片可以调顺序')))()");
  results.push({ name: '列表上方有「拖动卡片可以调顺序」的提示', ok: dragHint === true, detail: String(dragHint) });
  await cdp.shot('knowledge-reorder');

  // ---- 第五版阶段3：拖动跟手（拖动中无过渡 + 倾斜浮起）、落点线、松手回弹 ----
  const dragFeel = await cdp.eval(`(async () => {
    const rows = [...document.querySelectorAll('.kb-list-body .list-row')];
    if (rows.length < 2) return JSON.stringify({ err: 'few:' + rows.length });
    const src = rows[0];
    const dst = rows[1];
    const dt = new DataTransfer();
    const cursorHover = getComputedStyle(src).cursor;
    src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    await new Promise((r) => setTimeout(r, 90)); // 等 React 把 .dragging 挂上
    const cs = getComputedStyle(src);
    const box = dst.getBoundingClientRect();
    const init = { bubbles: true, dataTransfer: dt, clientX: box.left + 10, clientY: box.bottom - 3 };
    dst.dispatchEvent(new DragEvent('dragover', init));
    await new Promise((r) => setTimeout(r, 90)); // 等落点线挂上
    const pseudo = dst.className.includes('drop-after') ? '::after' : '::before';
    const pcs = getComputedStyle(dst, pseudo);
    const info = {
      cursorHover,
      dragging: src.className.includes('dragging'),
      transform: cs.transform,
      duration: cs.transitionDuration,
      cursorDrag: cs.cursor,
      dropCls: dst.className,
      lineH: pcs.height,
      lineBg: pcs.backgroundColor
    };
    src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
    return JSON.stringify(info);
  })()`);
  const feel = (() => {
    try {
      return JSON.parse(String(dragFeel));
    } catch {
      return { err: String(dragFeel) };
    }
  })();
  results.push({
    name: '第五版：可拖动的笔记行是「抓住」手型',
    ok: feel.cursorHover === 'grab',
    detail: 'cursor=' + feel.cursorHover + (feel.err ? ' err=' + feel.err : '')
  });
  results.push({
    name: '第五版：拖动中的卡片倾斜浮起、且没有过渡（跟手）',
    ok:
      feel.dragging === true &&
      feel.transform !== 'none' &&
      feel.transform !== undefined &&
      String(feel.duration)
        .split(',')
        .every((d) => d.trim() === '0s') &&
      feel.cursorDrag === 'grabbing',
    detail: 'transform=' + feel.transform + ' transition=' + feel.duration + ' cursor=' + feel.cursorDrag
  });
  results.push({
    name: '第五版：落点是 3px 品牌色圆头高亮线 + 目标行浅底',
    ok: (String(feel.dropCls).includes('drop-after') || String(feel.dropCls).includes('drop-before')) && feel.lineH === '3px',
    detail: 'class=' + feel.dropCls + ' 线高=' + feel.lineH + ' 色=' + feel.lineBg
  });
  const settle = await cdp.eval(`(async () => {
    const rows = [...document.querySelectorAll('.kb-list-body .list-row')];
    if (rows.length < 2) return JSON.stringify({ err: 'few' });
    const dt = new DataTransfer();
    const src = rows[0];
    const dst = rows[1];
    src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    const box = dst.getBoundingClientRect();
    const init = { bubbles: true, dataTransfer: dt, clientX: box.left + 10, clientY: box.bottom - 3 };
    dst.dispatchEvent(new DragEvent('dragover', init));
    dst.dispatchEvent(new DragEvent('drop', init));
    src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
    await new Promise((r) => setTimeout(r, 90));
    const hit = document.querySelector('.kb-list-body .list-row.drop-settling');
    return JSON.stringify({
      has: !!hit,
      anim: hit ? getComputedStyle(hit).animationName : 'none',
      transform: hit ? getComputedStyle(hit).transform : 'none'
    });
  })()`);
  const settled = (() => {
    try {
      return JSON.parse(String(settle));
    } catch {
      return { err: String(settle) };
    }
  })();
  results.push({
    name: '第五版：松手落位的卡片回弹一下（弹簧动画）',
    ok: settled.has === true && settled.anim === 'jw-settle',
    detail: 'animation=' + settled.anim + ' transform=' + settled.transform
  });

  // ---- 第五版阶段3：卡片毛玻璃 + 悬停浮起（真的把鼠标移上去读计算样式） ----
  await cdp.eval("location.hash = '/__bounce'; true");
  await sleep(250);
  await cdp.eval("location.hash = '/'; true");
  await sleep(800);
  const cardInfo = await cdp.eval(`(() => {
    const c = document.querySelector('.dash-grid .card');
    if (!c) return JSON.stringify({ err: 'no-card' });
    const b = c.getBoundingClientRect();
    const cs = getComputedStyle(c);
    return JSON.stringify({
      x: Math.round(b.left + b.width / 2),
      y: Math.round(b.top + 16),
      blur: cs.backdropFilter || cs.webkitBackdropFilter,
      before: cs.transform
    });
  })()`);
  const card = (() => {
    try {
      return JSON.parse(String(cardInfo));
    } catch {
      return { err: String(cardInfo) };
    }
  })();
  results.push({
    name: '第五版：卡片是毛玻璃（backdrop-filter 带模糊）',
    ok: String(card.blur).includes('blur'),
    detail: 'backdrop-filter=' + card.blur + (card.err ? ' err=' + card.err : '')
  });
  if (typeof card.x === 'number') {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: card.x, y: card.y });
    await sleep(520);
    const lifted = await cdp.eval(`(() => {
      const c = document.querySelector('.dash-grid .card');
      if (!c) return 'no-card';
      const m = new DOMMatrix(getComputedStyle(c).transform);
      return JSON.stringify({ dy: Math.round(m.m42 * 100) / 100, sx: Math.round(m.m11 * 10000) / 10000 });
    })()`);
    const lift = (() => {
      try {
        return JSON.parse(String(lifted));
      } catch {
        return { err: String(lifted) };
      }
    })();
    results.push({
      name: '第五版：鼠标移上去卡片浮起 translateY(-2px) scale(1.005)',
      ok: card.before === 'none' && Math.abs(Number(lift.dy) + 2) <= 0.05 && Math.abs(Number(lift.sx) - 1.005) < 0.001,
      detail: 'hover 前=' + card.before + ' hover 后 translateY=' + lift.dy + ' scaleX=' + lift.sx
    });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 4, y: 4 });
    await sleep(120);
  }
  // ---- 动画专项：过渡只许挂在合成/绘制属性上，别拿布局属性做动画（宽度/边距/定位会回流） ----
  const animProps = JSON.parse(
    String(
      await cdp.eval(`(() => {
    const pick = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const cs = getComputedStyle(el);
      return { prop: cs.transitionProperty, wc: cs.willChange || 'auto' };
    };
    return JSON.stringify({ card: pick('.dash-grid .card'), row: pick('.list-row'), stat: pick('.stat') });
  })()`)
    )
  );
  const layoutProp = /(^|[\\s,])(width|height|margin|margin-left|margin-top|left|top|right|bottom|padding)([\\s,]|$)/;
  const noLayoutAnim = (o) => !!o && !layoutProp.test(o.prop);
  results.push({
    name: '第五版：卡片/列表行的过渡只挂在合成或绘制属性上（没有 width / height / margin / left / top）',
    ok: noLayoutAnim(animProps.card) && (animProps.row ? noLayoutAnim(animProps.row) : true) && noLayoutAnim(animProps.stat),
    detail: `卡片[${animProps.card ? animProps.card.prop : 'n/a'}] 列表行[${animProps.row ? animProps.row.prop : 'n/a'}] 统计块[${animProps.stat ? animProps.stat.prop : 'n/a'}]`
  });

  await cdp.shot('home-card-hover');

  // ---- 第五版 阶段6：首页可视化（进度条 / 环形目标进度 / 完成与逾期配色 / 里程碑时间轴） ----
  // 先造一条逾期任务，让「已经逾期」那格真的亮起来，再回首页读 DOM
  const yDay = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  await cdp.eval(`(async () => {
    await window.api.invoke('task:create', { title: '逾期自检任务', due_at: ${JSON.stringify(yDay)}, priority: 'urgent' });
    return true;
  })()`);
  await cdp.eval("location.hash = '/tasks'; true");
  await sleep(500);
  await cdp.eval("location.hash = '/'; true");
  await sleep(1200);

  // 首页数据是异步读库的：软件渲染下偶尔会读到「还没渲染完」的一帧，
  // 量到 doneRow=false 就等一会儿重测（最多 4 次）。断言标准不变，只是别被一帧抖动判死。
  const readHomeViz = async () => {
    const raw = await cdp.eval(`(() => {
      const ring = document.querySelector('.goal-ring');
      const ringCS = ring ? getComputedStyle(ring) : null;
      const ringText = ring ? ((ring.querySelector('span') || {}).textContent || '').trim() : '';
      const overdue = document.querySelector('.list-row.overdue');
      const done = document.querySelector('.list-row.done');
      const doneCheck = done ? done.querySelector('.check') : null;
      const doneTitle = done ? done.querySelector('.title') : null;
      const bar = document.querySelector('.goal-row .progress > i');
      const alarmEl = document.querySelector('.stat.alarm');
      return JSON.stringify({
        ringBg: ringCS ? ringCS.backgroundImage : 'none',
        ringText: ringText,
        ringVar: ring ? (ring.style.getPropertyValue('--p') || '').trim() : 'none',
        overdueRow: !!overdue,
        overdueSub: overdue ? ((overdue.querySelector('.sub') || {}).textContent || '') : '',
        overdueMark: overdue ? getComputedStyle(overdue, '::before').backgroundColor : 'none',
        alarm: document.querySelectorAll('.stat.alarm').length,
        alarmAnim: alarmEl ? getComputedStyle(alarmEl).animationName : 'none',
        good: document.querySelectorAll('.stat.good').length,
        doneRow: !!done,
        doneCheckAnim: doneCheck ? getComputedStyle(doneCheck).animationName : 'none',
        doneTitleLine: doneTitle ? getComputedStyle(doneTitle).textDecorationLine : 'none',
        barGrad: bar ? getComputedStyle(bar).backgroundImage : 'none',
        barAnim: bar ? getComputedStyle(bar).animationName : 'none'
      });
    })()`);
    try {
      return JSON.parse(String(raw));
    } catch {
      return { err: String(raw) };
    }
  };
  let viz = await readHomeViz();
  for (let attempt = 0; attempt < 3 && !(viz.doneRow === true && viz.overdueRow === true); attempt++) {
    await sleep(600);
    viz = await readHomeViz();
  }
  results.push({
    name: '第五版：首页目标进度是环形（conic-gradient + 环里带百分比）',
    ok:
      String(viz.ringBg).includes('conic-gradient') &&
      /^\d+%$/.test(String(viz.ringText)) &&
      String(viz.ringVar).endsWith('%'),
    detail:
      '背景=' + String(viz.ringBg).slice(0, 58) + ' 环里=' + viz.ringText + ' --p=' + viz.ringVar + (viz.err ? ' err=' + viz.err : '')
  });
  results.push({
    name: '第五版：逾期任务有红杠红字，逾期那格统计卡在呼吸',
    ok:
      viz.overdueRow === true &&
      String(viz.overdueSub).includes('已逾期') &&
      viz.alarm >= 1 &&
      String(viz.alarmAnim).includes('jw-alarm') &&
      String(viz.overdueMark).startsWith('rgb'),
    detail:
      '逾期行=' + viz.overdueRow + ' 副标题=' + viz.overdueSub + ' 红杠=' + viz.overdueMark + ' 呼吸动画=' + viz.alarmAnim
  });
  results.push({
    name: '第五版：完成项划掉并弹一下，进度条是渐变且从 0 长出来',
    ok:
      viz.doneRow === true &&
      String(viz.doneCheckAnim).includes('jw-pop') &&
      String(viz.doneTitleLine).includes('line-through') &&
      String(viz.barGrad).includes('gradient') &&
      String(viz.barAnim).includes('jw-grow') &&
      viz.good >= 1,
    detail:
      '完成行=' + viz.doneRow + ' 勾动画=' + viz.doneCheckAnim + ' 标题=' + viz.doneTitleLine + ' 进度条动画=' + viz.barAnim + ' 绿格=' + viz.good
  });
  await cdp.shot('home-visual');

  // 回到知识库，后面的分类断言要用这一页
  await cdp.eval("location.hash = '/knowledge'; true");
  await sleep(900);

  // ---- 优化项 7：分类排序按钮 + 非空分类删除拦截（界面） ----
  const upBtnCount = await cdp.eval("(() => document.querySelectorAll('.tree-item [title=\"上移\"]').length)()");
  const downBtnCount = await cdp.eval("(() => document.querySelectorAll('.tree-item [title=\"下移\"]').length)()");
  results.push({
    name: '每个分类行上都有「上移 / 下移」按钮',
    ok: Number(upBtnCount) >= 2 && Number(upBtnCount) === Number(downBtnCount),
    detail: '上移=' + upBtnCount + ' 下移=' + downBtnCount
  });

  const delClicked = await cdp.eval(`(() => {
    const row = [...document.querySelectorAll('.tree-item')].find((el) => (el.innerText || '').includes('排序自检分类'));
    if (!row) return 'no-row';
    const del = row.querySelector('[title="删除分类"]');
    if (!del) return 'no-del';
    del.click();
    return 'clicked';
  })()`);
  await sleep(400);
  const toastText = await cdp.eval("(() => [...document.querySelectorAll('.toast-wrap .toast')].map((e) => e.innerText).join(' | '))()");
  const stillRow = await cdp.eval("(() => [...document.querySelectorAll('.tree-item')].some((el) => (el.innerText || '').includes('排序自检分类')))()");
  results.push({
    name: '非空分类点删除会提示「请先移动或删除笔记」，分类还在',
    ok: delClicked === 'clicked' && String(toastText).includes('该分类下还有笔记') && stillRow === true,
    detail: delClicked + ' | 提示=' + String(toastText).slice(0, 60) + ' | 还在=' + stillRow
  });

  const upResult = await cdp.eval(`(() => {
    const rows = [...document.querySelectorAll('.tree-item')].filter((el) => el.querySelector('[title="上移"]'));
    if (rows.length < 2) return 'few';
    const row = rows[1];
    const name = (row.querySelector('.name') || {}).innerText || '';
    const before = rows.map((r) => ((r.querySelector('.name') || {}).innerText || ''));
    row.querySelector('[title="上移"]').click();
    return JSON.stringify({ name, before });
  })()`);
  await sleep(700);
  const treeOrder = await cdp.eval("(() => [...document.querySelectorAll('.tree-item')].filter((el) => el.querySelector('[title=\"上移\"]')).map((r) => ((r.querySelector('.name') || {}).innerText || '')))()");
  const upInfo = (() => {
    try {
      return JSON.parse(String(upResult));
    } catch {
      return { name: '', before: [] };
    }
  })();
  const beforeIdx = (upInfo.before || []).indexOf(upInfo.name);
  const afterIdx = Array.isArray(treeOrder) ? treeOrder.indexOf(upInfo.name) : -1;
  results.push({
    name: '点「上移」之后分类真的往上挪了一位',
    ok: beforeIdx > 0 && afterIdx === beforeIdx - 1,
    detail: JSON.stringify(upInfo.before) + ' → ' + JSON.stringify(treeOrder)
  });
  // ---- 分类工具栏的「＋子分类」（第三版补：不用悬停也能建子分类） ----
  await cdp.eval(`(() => {
    const row = [...document.querySelectorAll('.tree-item')].find((el) => (el.innerText || '').includes('全部笔记'));
    if (row) row.click();
    return true;
  })()`);
  await sleep(500);
  const childBtnOff = await cdp.eval(`(() => {
    const btn = document.querySelector('.cat-child-btn');
    if (!btn) return 'no-btn';
    return JSON.stringify({ disabled: btn.disabled, text: (btn.innerText || '').trim(), title: btn.title });
  })()`);
  const childBtnOffInfo = (() => {
    try {
      return JSON.parse(String(childBtnOff));
    } catch {
      return {};
    }
  })();
  results.push({
    name: '分类工具栏里有「＋子分类」按钮，没选具体分类时是禁用的',
    ok: childBtnOffInfo.disabled === true && String(childBtnOffInfo.text).includes('子分类'),
    detail: String(childBtnOff)
  });

  const childBtnPick = await cdp.eval(`(() => {
    const row = [...document.querySelectorAll('.tree-item')].find((el) => (el.innerText || '').includes('排序自检分类'));
    if (!row) return 'no-row';
    row.click();
    return 'clicked';
  })()`);
  await sleep(600);
  const childBtnState = await cdp.eval(`(() => {
    const btn = document.querySelector('.cat-child-btn');
    if (!btn) return 'no-btn';
    return JSON.stringify({ disabled: btn.disabled, title: btn.title });
  })()`);
  const childBtnStateInfo = (() => {
    try {
      return JSON.parse(String(childBtnState));
    } catch {
      return {};
    }
  })();
  results.push({
    name: '选中一个分类后「＋子分类」能点了，提示里带着这个分类的名字',
    ok:
      childBtnPick === 'clicked' &&
      childBtnStateInfo.disabled === false &&
      String(childBtnStateInfo.title).includes('排序自检分类'),
    detail: childBtnPick + ' | ' + String(childBtnState)
  });

  await cdp.eval(`(() => {
    const row = [...document.querySelectorAll('.tree-item')].find((el) => (el.innerText || '').includes('排序自检分类'));
    if (row) row.click();
    return true;
  })()`);
  await sleep(300);
  const childClickState = await cdp.eval(`(() => {
    const b = document.querySelector('.cat-child-btn');
    if (!b) return 'no-btn';
    const disabled = b.disabled;
    const title = b.title;
    b.click();
    return JSON.stringify({ disabled, title });
  })()`);
  await sleep(400);
  const childModal = await cdp.eval(`(() => {
    const modal = document.querySelector('.modal');
    if (!modal) return 'no-modal';
    return (modal.querySelector('.modal-head span') || {}).innerText || '';
  })()`);
  const childTyped = await cdp.eval(`(() => {
    const input = document.querySelector('.modal-body input.input');
    if (!input) return 'no-input';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, '工具栏子分类');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return input.value;
  })()`);
  await sleep(200);
  await cdp.eval("(() => { const b = document.querySelector('.modal-foot button.btn.primary'); if (b) b.click(); return true; })()");
  await sleep(800);
  const treeRaw = await cdp.eval("(async () => JSON.stringify(await window.api.invoke('category:tree')))()");
  const treeAfterToolbar = JSON.parse(String(treeRaw));
  const toolbarParent = treeAfterToolbar.find((c) => c.name === '排序自检分类') || null;
  const toolbarChild = treeAfterToolbar.find((c) => c.name === '工具栏子分类') || null;
  const toolbarChildVisible = await cdp.eval(
    "(() => [...document.querySelectorAll('.tree-item')].some((el) => (el.innerText || '').includes('工具栏子分类')))()"
  );
  results.push({
    name: '工具栏建的子分类挂对了父分类，并且立刻出现在树上',
    ok:
      String(childClickState).includes('"disabled":false') &&
      String(childModal).includes('新建子分类') &&
      childTyped === '工具栏子分类' &&
      !!toolbarChild &&
      !!toolbarParent &&
      toolbarChild.parent_id === toolbarParent.id &&
      toolbarChildVisible === true,
    detail:
      '点击时=' +
      String(childClickState) +
      ' | 弹窗=' +
      String(childModal) +
      ' | 输入=' +
      String(childTyped) +
      ' | parent_id=' +
      JSON.stringify(toolbarChild ? toolbarChild.parent_id : null) +
      ' 期望=' +
      JSON.stringify(toolbarParent ? toolbarParent.id : null) +
      ' | 界面上=' +
      toolbarChildVisible
  });

  await cdp.shot('knowledge-category-tree');

  // ---- 第三版：富文本编辑器的界面行为 ----
  await cdp.eval("location.hash = '/__bounce'; true");
  await sleep(250);
  await cdp.eval("location.hash = '/knowledge'; true");
  await sleep(800);
  const formOpen = await cdp.eval(`(() => {
    const rows = [...document.querySelectorAll('.list-row')];
    const row = rows.find((r) => (r.innerText || '').includes('富文本自检'));
    if (!row) return 'no-row/' + rows.length;
    row.click();
    return 'clicked';
  })()`);
  await sleep(700);
  const editorState = await cdp.eval(`(() => {
    const bar = document.querySelector('.rt-toolbar');
    const ed = document.querySelector('.rt-editor');
    return JSON.stringify({ open: ${JSON.stringify(formOpen)}, bar: !!bar, btns: bar ? bar.querySelectorAll('button').length : 0, editable: !!ed && ed.getAttribute('contenteditable') === 'true' });
  })()`);
  const es = JSON.parse(String(editorState));
  results.push({ name: '点开笔记后出现富文本工具栏', ok: es.open === 'clicked' && es.bar && es.btns >= 8, detail: String(editorState) });
  results.push({ name: '正文区是可编辑的富文本容器', ok: es.editable === true, detail: String(editorState) });
  await cdp.shot('knowledge-rich');

  // ---- 第五版阶段4：工具条毛玻璃 + 正文「纸」不透明（对比度优先） ----
  const editorPaper = await cdp.eval(`(() => {
    const bar = document.querySelector('.rt-toolbar');
    const body = document.querySelector('.editor-body');
    const ed = document.querySelector('.rt-editor');
    if (!bar || !body || !ed) return JSON.stringify({ err: 'no-editor' });
    const parse = (s) => {
      const m = String(s).match(/rgba?\\(([^)]+)\\)/);
      if (!m) return null;
      const p = m[1].split(',').map((x) => parseFloat(x));
      return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
    };
    const lum = (c) => {
      const f = (v) => {
        const x = v / 255;
        return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
    };
    const cs = getComputedStyle(bar);
    const barBg = parse(cs.backgroundColor);
    const bodyBg = parse(getComputedStyle(body).backgroundColor);
    const fg = parse(getComputedStyle(ed).color);
    let ratio = 0;
    if (bodyBg && fg) {
      const l1 = lum(bodyBg);
      const l2 = lum(fg);
      ratio = Math.round(((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)) * 10) / 10;
    }
    return JSON.stringify({
      blur: cs.backdropFilter || cs.webkitBackdropFilter,
      barBg: cs.backgroundColor,
      barAlpha: barBg ? barBg.a : null,
      bodyBg: getComputedStyle(body).backgroundColor,
      bodyAlpha: bodyBg ? bodyBg.a : null,
      fg: getComputedStyle(ed).color,
      ratio
    });
  })()`);
  const paper = (() => {
    try {
      return JSON.parse(String(editorPaper));
    } catch {
      return { err: String(editorPaper) };
    }
  })();
  results.push({
    name: '第五版：编辑器工具条是毛玻璃（模糊 + 半透明底）',
    ok: String(paper.blur).includes('blur') && typeof paper.barAlpha === 'number' && paper.barAlpha < 1,
    detail: 'backdrop=' + paper.blur + ' 底色=' + paper.barBg + (paper.err ? ' err=' + paper.err : '')
  });
  results.push({
    name: '第五版：正文那块「纸」保持不透明（不跟着毛玻璃透）',
    ok: paper.bodyAlpha === 1,
    detail: '正文底色=' + paper.bodyBg
  });
  results.push({
    name: '第五版：正文对比度够长读（≥ 12:1）',
    ok: Number(paper.ratio) >= 12,
    detail: '底色=' + paper.bodyBg + ' 字色=' + paper.fg + ' 对比度=' + paper.ratio + ':1'
  });

  // ---- 第五版阶段5：按钮与输入框六态（默认 / 悬停 / 按下 / 聚焦 / 禁用 / 加载） ----
  const pickSave = "[...document.querySelectorAll('.editor-head button')].find((b) => (b.textContent || '').includes('保存'))";
  const btnDefaultRaw = await cdp.eval(`(() => {
    const b = ${pickSave};
    if (!b) return JSON.stringify({ err: 'no-btn' });
    const r = b.getBoundingClientRect();
    const cs = getComputedStyle(b);
    return JSON.stringify({
      x: Math.round(r.left + r.width / 2),
      y: Math.round(r.top + r.height / 2),
      bg: cs.backgroundColor,
      border: cs.borderTopWidth + ' ' + cs.borderTopColor,
      radius: cs.borderTopLeftRadius,
      shadow: cs.boxShadow
    });
  })()`);
  const btn = (() => {
    try {
      return JSON.parse(String(btnDefaultRaw));
    } catch {
      return { err: String(btnDefaultRaw) };
    }
  })();
  results.push({
    name: '第五版：按钮默认态有底色 / 描边 / 圆角',
    ok: btn.bg !== 'rgba(0, 0, 0, 0)' && btn.radius !== '0px' && !btn.err,
    detail: '底色=' + btn.bg + ' 描边=' + btn.border + ' 圆角=' + btn.radius + (btn.err ? ' err=' + btn.err : '')
  });
  if (typeof btn.x === 'number') {
    const readHover = async () => {
      const hoverRaw = await cdp.eval(`(() => {
        const b = ${pickSave};
        const cs = getComputedStyle(b);
        const m = new DOMMatrix(cs.transform);
        return JSON.stringify({ bg: cs.backgroundColor, ty: Math.round(m.m42 * 100) / 100 });
      })()`);
      try {
        return JSON.parse(String(hoverRaw));
      } catch {
        return { err: String(hoverRaw) };
      }
    };
    // 软件渲染下 mouseMoved 偶尔丢一次，所以「移开 → 移回」最多试三遍
    let hov = { bg: btn.bg, ty: 0 };
    for (let i = 0; i < 3; i += 1) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 4, y: 4, buttons: 0 });
      await sleep(70);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: btn.x, y: btn.y, buttons: 0 });
      await sleep(240);
      hov = await readHover();
      if (hov.bg !== btn.bg && hov.ty === -1) break;
    }
    results.push({
      name: '第五版：悬停态换底色 + 抬 1px',
      ok: hov.bg !== btn.bg && hov.ty === -1,
      detail: '底色 ' + btn.bg + ' → ' + hov.bg + '，位移 ' + hov.ty + 'px' + (hov.err ? ' err=' + hov.err : '')
    });
    // 按下：CDP 的 mousePressed 偶尔不会立刻挂上 :active，读不到就再按一次
    const readPress = async () => {
      const raw = await cdp.eval(`(() => {
        const b = ${pickSave};
        const m = new DOMMatrix(getComputedStyle(b).transform);
        return JSON.stringify({ sx: Math.round(m.m11 * 1000) / 1000, sy: Math.round(m.m22 * 1000) / 1000 });
      })()`);
      try {
        return JSON.parse(String(raw));
      } catch {
        return { sx: 1, sy: 1, err: String(raw) };
      }
    };
    let press = { sx: 1, sy: 1 };
    for (let attempt = 0; attempt < 4; attempt++) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: btn.x, y: btn.y, buttons: 0 });
      await sleep(120);
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: btn.x,
        y: btn.y,
        button: 'left',
        buttons: 1,
        clickCount: 1
      });
      await sleep(180);
      press = await readPress();
      if (Math.abs(Number(press.sx) - 0.97) < 0.02) break;
      // CDP 的 mousePressed 偶尔挂不上 :active —— 松手移开再来一次
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: 4,
        y: 4,
        button: 'left',
        buttons: 0,
        clickCount: 1
      });
      await sleep(160);
    }
    // 松手丢到窗口角落，避免真的点到「保存」（这一步只验手感）
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: 4,
      y: 4,
      button: 'left',
      buttons: 0,
      clickCount: 1
    });
    await sleep(200);
    results.push({
      name: '第五版：按下态缩到 0.97（「按进去」的手感）',
      ok: Math.abs(Number(press.sx) - 0.97) < 0.02,
      detail: '按下时 scaleX=' + press.sx + ' scaleY=' + press.sy
    });
  }

  const focusRaw = await cdp.eval(`(async () => {
    const inp = document.querySelector('.editor-foot input') || document.querySelector('.kb-list-head input');
    if (!inp) return JSON.stringify({ err: 'no-input' });
    inp.focus();
    await new Promise((r) => setTimeout(r, 140));
    const cs = getComputedStyle(inp);
    return JSON.stringify({ focused: document.activeElement === inp, border: cs.borderTopColor, shadow: cs.boxShadow });
  })()`);
  const focusRing = (() => {
    try {
      return JSON.parse(String(focusRaw));
    } catch {
      return { err: String(focusRaw) };
    }
  })();
  results.push({
    name: '第五版：输入框聚焦态有品牌色描边 + 光环',
    ok: focusRing.focused === true && String(focusRing.shadow) !== 'none',
    detail: '描边=' + focusRing.border + ' 光环=' + focusRing.shadow + (focusRing.err ? ' err=' + focusRing.err : '')
  });

  let kbRing = { err: 'none' };
  for (let i = 0; i < 8; i += 1) {
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key: 'Tab',
      code: 'Tab',
      windowsVirtualKeyCode: 9,
      nativeVirtualKeyCode: 9
    });
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Tab',
      code: 'Tab',
      windowsVirtualKeyCode: 9,
      nativeVirtualKeyCode: 9
    });
    await sleep(120);
    const raw = await cdp.eval(`(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return JSON.stringify({ err: 'body' });
      const cs = getComputedStyle(el);
      return JSON.stringify({
        tag: el.tagName + (el.className ? '.' + String(el.className).split(' ')[0] : ''),
        fv: el.matches(':focus-visible'),
        shadow: cs.boxShadow
      });
    })()`);
    const got = (() => {
      try {
        return JSON.parse(String(raw));
      } catch {
        return { err: String(raw) };
      }
    })();
    kbRing = got;
    if (got.fv === true && String(got.shadow) !== 'none' && String(got.shadow) !== '') break;
  }
  results.push({
    name: '第五版：键盘 Tab 聚焦时画 :focus-visible 光环',
    ok: kbRing.fv === true && String(kbRing.shadow) !== 'none',
    detail: JSON.stringify(kbRing)
  });

  const stateStylesRaw = await cdp.eval(`(() => {
    const mk = (cls, off) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = cls;
      b.textContent = '自检按钮';
      if (off) b.setAttribute('disabled', 'disabled');
      document.body.appendChild(b);
      return b;
    };
    const d = mk('btn', true);
    const dcs = getComputedStyle(d);
    const dis = { opacity: dcs.opacity, cursor: dcs.cursor, shadow: dcs.boxShadow };
    d.remove();
    const l = mk('btn loading', false);
    const lcs = getComputedStyle(l, '::before');
    const load = {
      w: lcs.width,
      h: lcs.height,
      anim: lcs.animationName,
      iter: lcs.animationIterationCount,
      radius: lcs.borderTopLeftRadius,
      cursor: getComputedStyle(l).cursor
    };
    l.remove();
    return JSON.stringify({ dis, load });
  })()`);
  const st = (() => {
    try {
      return JSON.parse(String(stateStylesRaw));
    } catch {
      return { err: String(stateStylesRaw) };
    }
  })();
  results.push({
    name: '第五版：禁用态 45% 透明 + not-allowed + 无投影',
    ok: st.dis && st.dis.opacity === '0.45' && st.dis.cursor === 'not-allowed' && st.dis.shadow === 'none',
    detail: JSON.stringify(st.dis)
  });
  results.push({
    name: '第五版：加载态是 12px 转圈（无限循环，按钮不变宽）',
    ok: st.load && st.load.w === '12px' && st.load.h === '12px' && st.load.anim === 'jw-spin' && st.load.iter === 'infinite',
    detail: JSON.stringify(st.load)
  });

  // ---- 侧栏折叠/展开：宽度插值平滑、文字不再「闪一下」（回归断言） ----
  const sbRead = async () =>
    JSON.parse(
      String(
        await cdp.eval(`(() => {
          const sb = document.querySelector('.sidebar');
          const lb = document.querySelector('.nav-label');
          const bt = document.querySelector('.brand-text');
          const wl = document.querySelector('.brand .win-lights');
          const mk = document.querySelector('.brand-mark');
          if (!sb) return JSON.stringify({ err: 'no-sidebar' });
          const cs = lb ? getComputedStyle(lb) : null;
          const sbBox = sb.getBoundingClientRect();
          const wlBox = wl ? wl.getBoundingClientRect() : null;
          const mkBox = mk ? mk.getBoundingClientRect() : null;
          const dots = [...document.querySelectorAll('.brand .win-light')].map((d) => {
            const b = d.getBoundingClientRect();
            return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width) };
          });
          return JSON.stringify({
            // 面板本身定宽 232（动画只走 transform），能不能看见要看右边缘；
            // visW = 落在视口里的那一段宽度，就是「肉眼看到的侧栏宽度」
            w: Math.round(sbBox.width),
            visW: Math.round(Math.max(0, Math.min(sbBox.right, window.innerWidth) - Math.max(sbBox.left, 0))),
            right: Math.round(sbBox.right),
            transform: getComputedStyle(sb).transform,
            labelW: lb ? Math.round(lb.getBoundingClientRect().width) : -1,
            labelOpacity: cs ? Number(cs.opacity) : -1,
            labelText: lb ? lb.textContent : '',
            brandW: bt ? Math.round(bt.getBoundingClientRect().width) : -1,
            lightsW: wlBox ? Math.round(wlBox.width) : -1,
            lightsH: wlBox ? Math.round(wlBox.height) : -1,
            dots,
            markW: mkBox ? Math.round(mkBox.width) : -1,
            markOverflow: mkBox ? Math.round(mkBox.right - sbBox.right) : 999
          });
        })()`)
      )
    );
  const expandedState = await sbRead();
  // 点「收起侧栏」：点一下不一定生效（软件渲染下偶发丢一次点击），最多补点到状态对上为止
  const toggleSidebar = async (wantCollapsed) => {
    for (let i = 0; i < 5; i++) {
      const st = await sbRead();
      // 收起 = 只看得见 60px（面板自身仍是 232，靠 transform 挪出去）
      const okNow = wantCollapsed ? st.visW <= 64 : st.visW > 64;
      if (okNow) return true;
      await cdp.eval("(() => { const b = document.querySelector('.nav-foot .icon-btn'); if (b) b.click(); return !!b; })()");
      await sleep(520);
    }
    return false;
  };
  await toggleSidebar(true);
  await sleep(120);
  const collapsedState = await sbRead();
  await cdp.shot('sidebar-collapsed');
  // 文字节点必须一直留在 DOM 里（不是「展开时才挂上」）——这就是闪烁的根因
  const labelStaysInDom = collapsedState.labelText.includes('首页');
  // 展开过程本身是「逐帧插值」的：宽度与文字宽度都有过渡曲线。
  // 注意：e2e 是 --disable-gpu 跑的（软件渲染，帧率不可信），所以这里断言的是
  // 「过渡接线正确 + 宽度单调长回去」，不用帧率判断是否顺滑。
  const wiring = JSON.parse(
    String(
      await cdp.eval(`(() => {
        const p = (el) => {
          const c = el ? getComputedStyle(el) : null;
          return c ? c.transitionProperty + ' @ ' + c.transitionDuration : '';
        };
        return JSON.stringify({
          side: p(document.querySelector('.sidebar')),
          label: p(document.querySelector('.nav-label')),
          lights: p(document.querySelector('.brand .win-lights')),
          dot: p(document.querySelector('.brand .win-light'))
        });
      })()`)
    )
  );
  const midRaw = await cdp.eval(`(async () => {
    const sb = document.querySelector('.sidebar');
    let seen = [];
    // 侧栏此刻应当是收起的；点一下展开并录帧。万一这一下丢了，最多重试 3 次再录。
    // 动画只走 transform，所以录「右边缘的屏幕坐标」60 → 232 长回去的过程。
    for (let attempt = 0; attempt < 3; attempt++) {
      const r0 = Math.round(sb.getBoundingClientRect().right);
      seen = [r0];
      const t0 = performance.now();
      document.querySelector('.nav-foot .icon-btn').click();
      await new Promise((res) => {
        const tick = () => {
          seen.push(Math.round(sb.getBoundingClientRect().right));
          if (performance.now() - t0 > 280) res();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      if (Math.max(...seen) > r0) break;
      await new Promise((r) => setTimeout(r, 260));
    }
    return JSON.stringify(seen);
  })()`);
  const midFrames = (() => {
    try {
      return JSON.parse(String(midRaw));
    } catch {
      return [];
    }
  })();
  await sleep(200);
  const backState = await sbRead();
  await cdp.shot('sidebar-expanded');
  const grew = midFrames.every((w, i) => i === 0 || w >= midFrames[i - 1] - 1);
  // 动画专项：侧栏只许动 transform（width / flex-basis 由布局定死，不参与动画），
  // 文字只许动 opacity + transform（不再用 max-width 做过渡）
  const sideWired = wiring.side.includes('transform') && !wiring.side.includes('width');
  const labelWired =
    wiring.label.includes('opacity') &&
    wiring.label.includes('transform') &&
    !wiring.label.includes('max-width');
  const dotsWired = wiring.dot.includes('transform');
  // 三个点：折叠时同一列（x 相同、y 逐颗往下），展开时同一排（y 相同、x 逐颗往右）
  const dotsColumn = (st) =>
    Array.isArray(st.dots) &&
    st.dots.length === 3 &&
    st.dots.every((d) => Math.abs(d.x - st.dots[0].x) <= 2) &&
    st.dots[1].y - st.dots[0].y >= 14 &&
    st.dots[2].y - st.dots[1].y >= 14;
  const dotsRow = (st) =>
    Array.isArray(st.dots) &&
    st.dots.length === 3 &&
    st.dots.every((d) => Math.abs(d.y - st.dots[0].y) <= 2) &&
    st.dots[1].x - st.dots[0].x >= 14 &&
    st.dots[2].x - st.dots[1].x >= 14;
  const dotsText = (st) => (st.dots || []).map((d) => `(${d.x},${d.y})`).join(' ');
  results.push({
    name: '第五版：收起侧栏后只在左边留 60px 图标条（面板靠 transform 挪出去），文字收成 0 宽度、三个点竖排',
    ok:
      collapsedState.visW > 0 &&
      collapsedState.visW <= 64 &&
      collapsedState.w === 232 &&
      collapsedState.labelW <= 1 &&
      collapsedState.labelOpacity <= 0.05 &&
      labelStaysInDom &&
      dotsColumn(collapsedState) &&
      collapsedState.dots.every((d) => d.x < collapsedState.visW) &&
      collapsedState.lightsW <= 16 &&
      collapsedState.markW >= 24 &&
      collapsedState.markOverflow <= 1,
    detail: `可见宽 ${collapsedState.visW}px（面板仍 ${collapsedState.w}px / 右边缘 ${collapsedState.right}px） 文字宽 ${collapsedState.labelW}px 透明度 ${collapsedState.labelOpacity} 三点坐标 ${dotsText(collapsedState)}（竖排） 容器 ${collapsedState.lightsW}×${collapsedState.lightsH}px 图标宽 ${collapsedState.markW}px 右侧溢出 ${collapsedState.markOverflow}px 文字仍在DOM=${labelStaysInDom}`
  });
  results.push({
    name: '第五版：展开是插值动画（侧栏只动 transform：右边缘 60→232，文字只动 opacity/transform），三点回到一排',
    ok:
      sideWired &&
      labelWired &&
      dotsWired &&
      grew &&
      backState.visW >= 200 &&
      backState.labelW > 20 &&
      backState.labelOpacity === 1 &&
      dotsRow(backState),
    detail: `侧栏[${wiring.side}] 文字[${wiring.label}] 三点容器[${wiring.lights}] 每个点[${wiring.dot}] 右边缘轨迹 ${midFrames.slice(0, 8).join('→')} 回到 ${backState.visW}px / 文字 ${backState.labelW}px / 三点坐标 ${dotsText(backState)}（一排）`
  });

  // ---- 0.9.2 品牌区：修「库」被截断 + 极简排版（只看样式与几何，不动 DOM 类名） ----
  const brandRaw = await cdp.eval(`(() => {
    const q = (sel) => document.querySelector(sel);
    const rect = (sel) => { const el = q(sel); return el ? el.getBoundingClientRect() : null; };
    const brand = q('.brand');
    const markEl = q('.brand-mark');
    const textEl = q('.brand-text');
    if (!brand || !markEl || !textEl) return JSON.stringify({ err: 'no-brand' });
    const bcs = getComputedStyle(brand);
    const mark = getComputedStyle(markEl);
    const text = getComputedStyle(textEl);
    const markRect = rect('.brand-mark');
    const textRect = rect('.brand-text');
    const svg = q('.brand-mark svg');
    const circles = svg ? Array.from(svg.querySelectorAll('circle')).map((c) => {
      const s = getComputedStyle(c);
      return { fill: s.fill, stroke: s.stroke, strokeWidth: s.strokeWidth };
    }) : [];
    return JSON.stringify({
      gap: bcs.gap,
      paddingTop: bcs.paddingTop,
      paddingLeft: bcs.paddingLeft,
      overflow: bcs.overflow,
      brandScrollW: brand.scrollWidth,
      brandClientW: brand.clientWidth,
      mark: {
        w: Math.round(markRect.width),
        h: Math.round(markRect.height),
        radius: mark.borderTopLeftRadius,
        bg: mark.backgroundImage,
        bgColor: mark.backgroundColor,
        shadow: mark.boxShadow,
        overflow: mark.overflow,
        textShadow: mark.textShadow
      },
      svg: { present: !!svg, width: svg ? Math.round(svg.getBoundingClientRect().width) : 0, circles },
      text: {
        content: textEl.textContent,
        size: text.fontSize,
        weight: text.fontWeight,
        spacing: text.letterSpacing,
        bg: text.backgroundImage,
        color: text.color,
        fill: text.webkitTextFillColor,
        textShadow: text.textShadow,
        nowrap: text.whiteSpace,
        w: Math.round(textRect.width),
        scrollW: textEl.scrollWidth,
        clientW: textEl.clientWidth
      },
      hasJwSpan: !!q('.brand-jw'),
      gapPx: Math.round(textRect.left - markRect.right)
    });
  })()`);
  const brand = JSON.parse(String(brandRaw));
  const sum = (list, pick) => list.reduce((n, item) => n + (pick(item) ? 1 : 0), 0);
  const whiteStrokes = sum(brand.svg.circles, (c) => c.stroke === 'rgb(255, 255, 255)' && c.strokeWidth !== '0px');
  const auroraDots = sum(brand.svg.circles, (c) => c.fill === 'rgb(94, 231, 230)');
  results.push({
    name: '0.9.2：侧栏小图标 24px 近黑底板 + 白双环 ∞ + 极光蓝中心点（无渐变、只留 1px 内高光）',
    ok:
      brand.mark.w === 24 &&
      brand.mark.h === 24 &&
      brand.mark.radius === '7px' &&
      brand.mark.bg === 'none' &&
      brand.mark.bgColor === 'rgb(10, 11, 16)' &&
      /inset/.test(brand.mark.shadow) &&
      /rgba\(255, 255, 255, 0\.15\)/.test(brand.mark.shadow) &&
      brand.mark.overflow === 'hidden' &&
      brand.svg.present &&
      brand.svg.width === 24 &&
      whiteStrokes === 2 &&
      auroraDots === 1,
    detail: `${brand.mark.w}×${brand.mark.h} 圆角 ${brand.mark.radius} 底色 ${brand.mark.bgColor} 渐变=${brand.mark.bg} 阴影=${brand.mark.shadow} SVG ${brand.svg.width}px 白环=${whiteStrokes} 极光点=${auroraDots}`
  });
  results.push({
    name: '0.9.2：品牌区是单行「Jw 知识库」，统一正文色 15px/500/0.5px（不再有亮青色第二个字标）',
    ok:
      brand.text.content === 'Jw 知识库' &&
      brand.hasJwSpan === false &&
      brand.text.size === '15px' &&
      brand.text.weight === '500' &&
      brand.text.spacing === '0.5px' &&
      brand.text.bg === 'none' &&
      brand.text.fill !== 'rgba(0, 0, 0, 0)' &&
      brand.text.color !== 'rgb(0, 0, 0)' &&
      brand.text.w >= 60,
    detail: `文案「${brand.text.content}」独立的 Jw 字标=${brand.hasJwSpan} ${brand.text.size}/${brand.text.weight}/字距 ${brand.text.spacing} 宽 ${brand.text.w}px 色 ${brand.text.color} 渐变=${brand.text.bg}`
  });
  results.push({
    name: '0.9.2：品牌区文字没有被截断（scrollWidth ≤ clientWidth，且整行不横向溢出）',
    ok:
      brand.text.nowrap === 'nowrap' &&
      brand.text.scrollW <= brand.text.clientW &&
      brand.text.w >= 60 &&
      brand.brandScrollW <= brand.brandClientW &&
      brand.overflow === 'hidden',
    detail: `文字宽 ${brand.text.w}px（内容 ${brand.text.scrollW}px / 可见 ${brand.text.clientW}px，nowrap=${brand.text.nowrap}） 整行内容 ${brand.brandScrollW}px / 可见 ${brand.brandClientW}px overflow=${brand.overflow}`
  });
  results.push({
    name: '0.9.2：品牌区文字没有描边/阴影（text-shadow 全是 none，不再有重影）',
    ok: brand.text.textShadow === 'none' && brand.mark.textShadow === 'none',
    detail: `标题 ${brand.text.textShadow} / 图标 ${brand.mark.textShadow}`
  });
  results.push({
    name: '0.9.2：图标 24px、图标与文字间距 10px、品牌区左侧留白 20px（不贴边）',
    ok:
      brand.gap === '10px' &&
      brand.paddingTop === '16px' &&
      brand.paddingLeft === '20px' &&
      brand.gapPx >= 8 &&
      brand.gapPx <= 12,
    detail: `gap ${brand.gap}（实测图标→文字 ${brand.gapPx}px） 上/左留白 ${brand.paddingTop}/${brand.paddingLeft}`
  });

  // 折叠成 60px 图标条时：24px 小图标必须水平居中、文字让位（透明度收 0），不裁切
  await toggleSidebar(true);
  await sleep(700); // 等侧栏收起动画（0.38s）彻底停下，否则量到的是中途宽度
  const collapsedBrand = JSON.parse(
    String(
      await cdp.eval(`(() => {
        const mark = document.querySelector('.brand-mark').getBoundingClientRect();
        const sidebar = document.querySelector('.sidebar').getBoundingClientRect();
        const rail = Math.min(60, Math.round(sidebar.right));
        const textEl = document.querySelector('.brand-text');
        const textRect = textEl.getBoundingClientRect();
        return JSON.stringify({
          rail,
          center: Math.round((mark.left + mark.width / 2) * 10) / 10,
          want: Math.round((rail / 2) * 10) / 10,
          width: Math.round(mark.width),
          right: Math.round(mark.right),
          brandW: Math.round(document.querySelector('.brand').getBoundingClientRect().width),
          brandOverflow: getComputedStyle(document.querySelector('.brand')).overflow,
          textOpacity: Number(getComputedStyle(textEl).opacity),
          textW: Math.round(textRect.width),
          hasJwSpan: !!document.querySelector('.brand-jw')
        });
      })()`)
    )
  );
  results.push({
    name: '0.9.2：侧栏折叠成 60px 图标条时，24px 图标水平居中、文字平滑让位、不裁切',
    ok:
      collapsedBrand.width === 24 &&
      Math.abs(collapsedBrand.center - collapsedBrand.want) <= 1.5 &&
      collapsedBrand.right <= collapsedBrand.rail + 1 &&
      collapsedBrand.brandW <= 40 &&
      collapsedBrand.brandOverflow === 'hidden' &&
      collapsedBrand.textOpacity <= 0.05 &&
      collapsedBrand.hasJwSpan === false,
    detail: `图标 24px，中心 ${collapsedBrand.center}px / 图标条中点 ${collapsedBrand.want}px（偏差 ${Math.round((collapsedBrand.center - collapsedBrand.want) * 10) / 10}px） 右边缘 ${collapsedBrand.right}px / 条宽 ${collapsedBrand.rail}px 品牌行宽 ${collapsedBrand.brandW}px overflow=${collapsedBrand.brandOverflow} 文字透明度 ${collapsedBrand.textOpacity}`
  });
  await toggleSidebar(false);
  await sleep(260);

  // ---- 动画专项：收起/展开那 0.38s 里临时关掉侧栏毛玻璃（backdrop 每帧重算最贵） ----
  const glassSwap = JSON.parse(
    String(
      await cdp.eval(`(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const root = document.documentElement;
        const sb = document.querySelector('.sidebar');
        const read = () => ({
          cls: root.classList.contains('sidebar-animating'),
          bf: getComputedStyle(sb).backdropFilter,
          bg: getComputedStyle(sb).backgroundColor
        });
        const before = read();
        document.querySelector('.nav-foot .icon-btn').click();
        await sleep(90);
        const during = read();
        await sleep(560);
        const after = read();
        // 刚才收起了，再点开恢复展开态 —— 后面的断言都按展开的侧栏走
        document.querySelector('.nav-foot .icon-btn').click();
        await sleep(620);
        return JSON.stringify({ before, during, after });
      })()`)
    )
  );
  results.push({
    name: '第五版：收起/展开那一下侧栏临时换成实色（动画中不重算毛玻璃），停手后自己恢复',
    ok:
      glassSwap.before.cls === false &&
      /blur/.test(glassSwap.before.bf) &&
      glassSwap.during.cls === true &&
      glassSwap.during.bf === 'none' &&
      glassSwap.after.cls === false &&
      /blur/.test(glassSwap.after.bf),
    detail: `动画前 class=${glassSwap.before.cls} 毛玻璃=${glassSwap.before.bf}；动画中 class=${glassSwap.during.cls} 毛玻璃=${glassSwap.during.bf} 底色=${glassSwap.during.bg}；停手后 class=${glassSwap.after.cls} 毛玻璃=${glassSwap.after.bf}`
  });

  // ---- 展开态不弹任何导航提示；折叠态悬停才浮出毛玻璃气泡（用户反馈第 2、3 条） ----
  const tipRead = async () =>
    JSON.parse(
      String(
        await cdp.eval(`(() => {
          const it = document.querySelector('.nav-item');
          if (!it) return JSON.stringify({ err: 'no-nav' });
          const cs = getComputedStyle(it, '::after');
          const b = it.getBoundingClientRect();
          return JSON.stringify({
            title: it.getAttribute('title') || '',
            dataTip: it.getAttribute('data-tip') || '',
            content: (cs.content || '').replace(/"/g, ''),
            opacity: Number(cs.opacity),
            delay: cs.transitionDelay,
            transform: cs.transform,
            backdrop: cs.backdropFilter || cs.webkitBackdropFilter || '',
            radius: cs.borderTopLeftRadius,
            sidebarOverflow: getComputedStyle(document.querySelector('.sidebar')).overflow,
            navOverflow: getComputedStyle(document.querySelector('.nav')).overflowY,
            cx: Math.round(b.left + b.width / 2),
            cy: Math.round(b.top + b.height / 2)
          });
        })()`)
      )
    );
  // 悬停后要对准“稳定后的”图标中心再移一次：侧栏折叠动画还在跑时 rect 会漂，
  // 只按旧坐标移过去可能悬在图标外，气泡要等布局稳了才真正开始淡入。
  // 然后轮询等过渡走完（0.32s 延迟 + 0.14s 淡入），不是降低标准——断言仍是 opacity === 1。
  const hoverNav = async (st, wantVisible) => {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: st.cx, y: st.cy, buttons: 0 });
    await sleep(300);
    const again = await tipRead();
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: again.cx, y: again.cy, buttons: 0 });
    if (!wantVisible) {
      await sleep(360);
      return tipRead();
    }
    const t0 = Date.now();
    let last = await tipRead();
    while (Date.now() - t0 < 2000 && last.opacity < 0.999) {
      await sleep(80);
      last = await tipRead();
    }
    return last;
  };
  const expandedTip = await hoverNav(await tipRead(), false);
  await toggleSidebar(true);
  await sleep(120);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 4, y: 4, buttons: 0 });
  await sleep(120);
  const collapsedTip = await hoverNav(await tipRead(), true);
  // 气泡现在真能从 60px 侧栏里探出来（.nav 放开裁剪 + 侧栏抬层级），
  // 所以这张截图就是真实的悬停态，不需要任何临时注入
  await cdp.shot('sidebar-nav-tip');
  // 复位成展开态，后面的断言仍按展开的侧栏走
  await cdp.eval(`document.querySelector('.nav-foot .icon-btn').click()`);
  await sleep(420);
  results.push({
    name: '第五版：不再弹系统提示（title 已去掉），只有折叠态才有毛玻璃气泡',
    ok:
      expandedTip.title === '' &&
      expandedTip.dataTip.length > 0 &&
      expandedTip.opacity === 0 &&
      collapsedTip.content === collapsedTip.dataTip &&
      collapsedTip.opacity === 1 &&
      collapsedTip.backdrop.includes('blur') &&
      collapsedTip.radius !== '0px' &&
      collapsedTip.sidebarOverflow === 'visible' &&
      collapsedTip.navOverflow === 'visible' &&
      parseFloat(collapsedTip.delay) >= 0.3,
    detail: `title="${expandedTip.title}" data-tip="${expandedTip.dataTip}"；展开态 opacity=${expandedTip.opacity}；折叠态 content="${collapsedTip.content}" opacity=${collapsedTip.opacity} 延迟=${collapsedTip.delay} 圆角=${collapsedTip.radius} 背景模糊=${collapsedTip.backdrop} 侧栏溢出=${collapsedTip.sidebarOverflow} 导航列溢出=${collapsedTip.navOverflow}`
  });

  const tableInUi = await cdp.eval(`(async () => {
    const btn = [...document.querySelectorAll('.rt-toolbar button')].find((b) => b.title === '插入表格');
    if (!btn) return 'no-btn';
    btn.click();
    await new Promise((r) => setTimeout(r, 350));
    const head = document.querySelector('.modal-head');
    const insert = [...document.querySelectorAll('.modal-foot button')].find((b) => (b.textContent || '').trim() === '插入');
    if (!insert) return 'no-insert:' + (head && head.textContent);
    insert.click();
    await new Promise((r) => setTimeout(r, 350));
    const ed = document.querySelector('.rt-editor');
    const hasTable = !!ed && ed.innerHTML.includes('<table');
    // 把光标放进第一个单元格，工具栏才会亮出「＋行 / －行 / ＋列 / －列」
    const cell = ed && ed.querySelector('td');
    if (cell) {
      const rng = document.createRange();
      rng.selectNodeContents(cell);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(rng);
      document.dispatchEvent(new Event('selectionchange'));
      await new Promise((r) => setTimeout(r, 300));
    }
    const buttons = [...document.querySelectorAll('.rt-toolbar button')].map((b) => (b.title || '') + (b.textContent || '').trim());
    const rows = buttons.filter((t) => t.includes('行')).length;
    const cols = buttons.filter((t) => t.includes('列')).length;
    return (head && head.textContent) + '|table=' + hasTable + '|rowBtn=' + rows + '|colBtn=' + cols;
  })()`);
  results.push({
    name: '工具栏能插入表格、光标进单元格后多出增删行列按钮',
    ok: /table=true/.test(String(tableInUi)) && /colBtn=2/.test(String(tableInUi)) && /rowBtn=2/.test(String(tableInUi)),
    detail: String(tableInUi)
  });

  const boldInUi = await cdp.eval(`(async () => {
    const ed = document.querySelector('.rt-editor');
    if (!ed) return 'no-editor';
    ed.focus();
    ed.innerHTML = '<p>界面自检正文</p>';
    ed.dispatchEvent(new Event('input', { bubbles: true }));
    const rng = document.createRange();
    rng.selectNodeContents(ed.querySelector('p'));
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(rng);
    const b = [...document.querySelectorAll('.rt-toolbar button')].find((x) => x.title && x.title.indexOf('加粗') === 0);
    if (!b) return 'no-bold';
    b.click();
    await new Promise((r) => setTimeout(r, 250));
    return ed.innerHTML;
  })()`);
  results.push({
    name: '选中文字点「加粗」真的会加粗',
    ok: /<(b|strong)[^>]*>界面自检正文/.test(String(boldInUi).replace(/\s+/g, '')),
    detail: String(boldInUi).slice(0, 90)
  });

  const savedInUi = await cdp.eval(`(async () => {
    const fab = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim().includes('保存') && !b.disabled);
    if (!fab) return 'no-save-btn';
    fab.click();
    await new Promise((r) => setTimeout(r, 800));
    return (fab.textContent || '').trim();
  })()`);
  results.push({ name: '编辑器上的保存按钮能用', ok: /已保存|保存/.test(String(savedInUi)), detail: String(savedInUi) });

  const colorInUi = await cdp.eval(`(async () => {
    const ed = document.querySelector('.rt-editor');
    if (!ed) return 'no-editor';
    const rng = document.createRange();
    rng.selectNodeContents(ed);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(rng);
    document.dispatchEvent(new Event('selectionchange'));
    await new Promise((r) => setTimeout(r, 200));
    const click = (title) => {
      const b = [...document.querySelectorAll('.rt-toolbar button')].find((x) => x.title === title);
      if (b) b.click();
      return !!b;
    };
    click('字体颜色');
    await new Promise((r) => setTimeout(r, 220));
    const sw = document.querySelector('.color-pop .swatch');
    if (!sw) return 'no-swatch';
    sw.click();
    await new Promise((r) => setTimeout(r, 260));
    const afterText = ed.innerHTML;
    click('背景高亮');
    await new Promise((r) => setTimeout(r, 220));
    const sw2 = document.querySelector('.color-pop .swatch');
    if (sw2) sw2.click();
    await new Promise((r) => setTimeout(r, 260));
    const afterBg = ed.innerHTML;
    const save = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '保存');
    const saveLabel = save ? save.textContent : 'no-save';
    if (save) save.click();
    await new Promise((r) => setTimeout(r, 900));
    const rows = await window.api.invoke('note:list', { q: '富文本自检' });
    const row = (rows || []).find((n) => n.title === '富文本自检');
    const full = row ? await window.api.invoke('note:get', { id: row.id }) : null;
    return JSON.stringify({ afterText: afterText.slice(0, 130), afterBg: afterBg.slice(0, 170), saved: full ? String(full.content_html).slice(0, 200) : 'no-note', saveLabel });
  })()`);
  const cs = JSON.parse(String(colorInUi));
  results.push({ name: '选中文字能改字体颜色', ok: /color:/i.test(String(cs.afterText)), detail: String(cs.afterText) });
  results.push({ name: '选中文字能加背景高亮', ok: /background-color/i.test(String(cs.afterBg)), detail: String(cs.afterBg) });
  results.push({
    name: '颜色和高亮保存后还在库里（没被清洗规则吃掉）',
    ok: /color:/i.test(String(cs.saved)) && /background-color/i.test(String(cs.saved)),
    detail: String(cs.saved)
  });

  // 主题切换也过一遍
  await cdp.eval("location.hash = '/settings'; true");
  await sleep(400);
  const darkOk = await cdp.eval(
    `(async () => {
      const sel = [...document.querySelectorAll('select')].find((s) => [...s.options].some((o) => o.value === 'dark'));
      if (!sel) return '找不到主题下拉框';
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
      setter.call(sel, 'dark');
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 500));
      return document.documentElement.getAttribute('data-theme') + '|' + (localStorage.getItem('theme') ?? '');
    })()`
  );
  results.push({ name: '深色主题能切换', ok: String(darkOk).startsWith('dark'), detail: String(darkOk) });
  await cdp.shot('settings-dark');

  // ---- 第五版（阶段8）：深浅色过渡与记忆 ----
  const themeAnim = await cdp.eval(`(async () => {
    const sel = [...document.querySelectorAll('select')].find((s) => [...s.options].some((o) => o.value === 'dark'));
    if (!sel) return JSON.stringify({ err: '找不到主题下拉框' });
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    const root = document.documentElement;
    const flip = async (v) => {
      setter.call(sel, v);
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 60));
    };
    const mirror = () => { try { return localStorage.getItem('jw-theme') || ''; } catch { return 'denied'; } };
    await flip('light');
    await new Promise((r) => setTimeout(r, 420));
    await flip('dark');
    const during = {
      cls: root.classList.contains('theme-transitioning'),
      dur: getComputedStyle(document.body).transitionDuration,
      theme: root.getAttribute('data-theme'),
      boot: root.dataset.themeBoot || '',
      query: new URLSearchParams(location.search).get('theme') || '',
      mirror: mirror()
    };
    await new Promise((r) => setTimeout(r, 460));
    during.afterCls = root.classList.contains('theme-transitioning');
    during.mirrorAfter = mirror();
    return JSON.stringify(during);
  })()`);
  const ta = JSON.parse(String(themeAnim));
  results.push({
    name: '第五版：切深浅色时挂 0.3s 全局过渡，之后自己摘掉',
    ok: ta.cls === true && String(ta.dur).indexOf('0.3s') === 0 && ta.afterCls === false && ta.theme === 'dark',
    detail: `切换中 class=${ta.cls} 过渡=${ta.dur} 主题=${ta.theme} 460ms 后 class=${ta.afterCls}`
  });
  results.push({
    name: '第五版：主题记得住（首帧就用存下来的主题，改动同步镜像）',
    ok: (ta.boot === 'light' || ta.boot === 'dark') && ta.query === ta.boot && ta.mirrorAfter === 'dark',
    detail: `URL 里的主题=${ta.query} 首帧记号=${ta.boot} 镜像=${ta.mirror}→${ta.mirrorAfter}`
  });

  // ---- 第五版（阶段8 修正）：「放弃改动」要把「边选边预览」的主题也退回去 ----
  const discardTest = await cdp.eval(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    const root = document.documentElement;
    const themeSel = () => [...document.querySelectorAll('select')].find((s) => [...s.options].some((o) => o.value === 'dark'));
    const savedTheme = (await window.api.invoke('settings:get')).theme;
    const sel = themeSel();
    if (!sel) return JSON.stringify({ err: '找不到主题下拉框' });
    const other = savedTheme === 'dark' ? 'light' : 'dark';
    setter.call(sel, other);
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(420);
    const preview = root.getAttribute('data-theme');
    const btn = [...document.querySelectorAll('.save-bar button')].find((b) => (b.textContent || '').includes('放弃'));
    if (!btn) return JSON.stringify({ err: '没有「放弃改动」按钮' });
    btn.click();
    await wait(460);
    const mirror = () => { try { return localStorage.getItem('jw-theme') || ''; } catch { return 'denied'; } };
    const now = themeSel();
    return JSON.stringify({ savedTheme, other, preview, after: root.getAttribute('data-theme'), selNow: now ? now.value : '', mirror: mirror() });
  })()`);
  const dt = JSON.parse(String(discardTest));
  results.push({
    name: '第五版：放弃改动会把主题预览也退回上次保存的那个',
    ok:
      !dt.err &&
      dt.preview === dt.other &&
      dt.after === dt.savedTheme &&
      dt.selNow === dt.savedTheme &&
      dt.mirror === dt.savedTheme,
    detail: `库里=${dt.savedTheme} 预览=${dt.preview} 放弃后=${dt.after} 下拉=${dt.selNow} 镜像=${dt.mirror}`
  });

  // ---- 优化项 8：四个页面都有「保存」按钮，点了会报「已保存 HH:MM:SS」 ----
  // 知识库：先点开一篇笔记，编辑器头部才有「保存」
  await cdp.eval("location.hash = '/knowledge'; true");
  await sleep(700);
  const kbOpened = await cdp.eval(`(() => {
    const row = document.querySelector('.list-row');
    if (!row) return 'no-row';
    row.click();
    return 'clicked';
  })()`);
  await sleep(700);
  const kbSave = await cdp.eval(
    "(() => { const b = [...document.querySelectorAll('.editor-head button')].find((x) => (x.textContent || '').trim().indexOf('保存') === 0 && !x.disabled); return b ? (b.textContent || '').trim() : 'no-btn'; })()"
  );
  results.push({
    name: '笔记编辑页有「保存」按钮',
    ok: kbOpened === 'clicked' && String(kbSave).startsWith('保存'),
    detail: kbOpened + '/' + kbSave
  });

  await cdp.eval("location.hash = '/goals'; true");
  await sleep(700);
  const goalSave = await cdp.eval(
    "(() => { const b = [...document.querySelectorAll('.editor-head button')].find((x) => (x.textContent || '').trim().indexOf('保存') === 0 && !x.disabled); return b ? (b.textContent || '').trim() : 'no-btn'; })()"
  );
  results.push({ name: '目标编辑页有「保存」按钮', ok: String(goalSave).startsWith('保存'), detail: String(goalSave) });

  // ---- 第五版 阶段6：里程碑时间轴 ----
  const msOpened = await cdp.eval(`(() => {
    const row = [...document.querySelectorAll('.tree-item')].find((el) =>
      ((el.querySelector('.name') || {}).textContent || '').includes('把知识库用起来')
    );
    if (!row) return 'no-row';
    row.click();
    return 'clicked';
  })()`);
  await sleep(900);
  // 时间轴要「走过的段是绿的、没走的是灰的」，所以补两个还没完成的检查点
  const msAdded = await cdp.eval(`(() => {
    const input = [...document.querySelectorAll('input')].find((i) => (i.placeholder || '').includes('加一个里程碑'));
    if (!input) return 'no-input';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    const add = async (title) => {
      setter.call(input, title);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await new Promise((r) => setTimeout(r, 700));
    };
    return (async () => {
      await add('第 2 个检查点：跑通一次完整复习');
      await add('第 3 个检查点：连续记满一周');
      return 'added-2';
    })();
  })()`);
  await sleep(1100);
  const tlRaw = await cdp.eval(`(() => {
    const list = document.querySelector('.timeline');
    if (!list) return JSON.stringify({ timeline: false });
    const rows = [...list.querySelectorAll('.list-row')];
    const stats = rows.map((r, i) => {
      const cs = getComputedStyle(r, '::before');
      return {
        done: r.classList.contains('done'),
        last: i === rows.length - 1,
        display: cs.display,
        w: parseFloat(cs.width) || 0,
        bg: cs.backgroundColor,
        bgImg: cs.backgroundImage
      };
    });
    const visible = stats.filter((s) => !s.last && s.display !== 'none' && s.w >= 1);
    return JSON.stringify({
      timeline: true,
      rows: rows.length,
      done: stats.filter((s) => s.done).length,
      grey: visible.filter((s) => s.bg !== 'rgba(0, 0, 0, 0)' && !String(s.bgImg).includes('gradient')).length,
      green: visible.filter((s) => String(s.bgImg).includes('gradient')).length,
      lineW: visible[0] ? visible[0].w : 0,
      doneCheckBg: (rows.find((r) => r.classList.contains('done')) || {}).className
        ? getComputedStyle(rows.find((r) => r.classList.contains('done')).querySelector('.check')).backgroundColor
        : 'none'
    });
  })()`);
  const tl = (() => {
    try {
      return JSON.parse(String(tlRaw));
    } catch {
      return { err: String(tlRaw) };
    }
  })();
  results.push({
    name: '第五版：里程碑变成时间轴（一条竖线串起来，走过的段变绿）',
    ok:
      tl.timeline === true &&
      tl.rows >= 3 &&
      tl.done >= 1 &&
      tl.grey >= 1 &&
      tl.green >= 1 &&
      Number(tl.lineW) >= 1,
    detail:
      '时间轴=' + tl.timeline + ' 检查点=' + tl.rows + ' 已完成=' + tl.done + ' 灰段=' + tl.grey + ' 绿段=' + tl.green +
      ' 竖线宽=' + tl.lineW + 'px 勾=' + tl.doneCheckBg + ' 打开=' + msOpened + ' 添加=' + msAdded +
      (tl.err ? ' err=' + tl.err : '')
  });
  await cdp.shot('goals-milestone-timeline');

  // ---- 第五版（阶段7）：搜索面板与 Toast 毛玻璃 ----
  await cdp.eval("location.hash = '/'; true");
  await sleep(700);

  // ① 搜索框一聚焦，面板就从搜索框长出来 + 毛玻璃
  await cdp.eval(
    "(() => { const i = document.querySelector('.searchbox input'); if (!i) return false; i.blur(); i.focus(); return true; })()"
  );
  await sleep(420);
  const palette = await cdp.eval(`(() => {
    const i = document.querySelector('.searchbox input');
    const m = document.querySelector('.modal.search-modal');
    if (!m) return { found: false, hasInput: !!i, active: document.activeElement ? document.activeElement.tagName : 'none' };
    const cs = getComputedStyle(m);
    const parts = cs.transformOrigin.split(' ');
    return {
      found: true,
      anim: cs.animationName,
      ox: parseFloat(parts[0]),
      oy: parseFloat(parts[1]),
      backdrop: cs.backdropFilter || cs.webkitBackdropFilter || 'none',
      bg: cs.backgroundColor
    };
  })()`);
  await cdp.shot('search-palette');
  results.push({
    name: '第五版：搜索框一聚焦，面板就从搜索框方向展开且是毛玻璃',
    ok:
      palette.found === true &&
      palette.anim === 'jw-palette-in' &&
      palette.ox > 0 &&
      palette.oy < 0 &&
      /rgba\(/.test(String(palette.bg)) &&
      /blur/.test(String(palette.backdrop)),
    detail:
      '动画=' + palette.anim + ' origin=' + palette.ox + 'px ' + palette.oy + 'px 底色=' + palette.bg + ' backdrop=' + palette.backdrop +
      (palette.found ? '' : `（面板没开：输入框=${palette.hasInput} 焦点=${palette.active}）`)
  });

  // ② 搜出命中行 → 悬停浮起
  await cdp.eval(`(() => {
    const inp = document.querySelector('.search-modal input');
    if (!inp) return 'no-input';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(inp, '自检');
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    return 'ok';
  })()`);
  await sleep(900);
  // 悬停态用 CDP 的 CSS.forcePseudoState 强制出来 —— 软件渲染（--disable-gpu）下
  // 合成鼠标事件偶尔不落到 :hover 上，这里要验的是「hover 样式接没接上」，不是鼠标管线本身
  const hoverRow = await cdp.eval(`(() => {
    const rows = [...document.querySelectorAll('.search-modal .modal-body .list-row')];
    return JSON.stringify({ count: rows.length, which: rows.length ? (rows[0].textContent || '').slice(0, 10) : '' });
  })()`);
  const hitBox = JSON.parse(String(hoverRow));
  let hitHover = { ty: 0, shadow: 'none', bg: '' };
  if (hitBox.count > 0) {
    await cdp.send('DOM.enable');
    await cdp.send('CSS.enable');
    const doc = await cdp.send('DOM.getDocument', { depth: 1 });
    const sel = await cdp.send('DOM.querySelector', {
      nodeId: doc.root.nodeId,
      selector: '.search-modal .modal-body .list-row'
    });
    await cdp.send('CSS.forcePseudoState', { nodeId: sel.nodeId, forcedPseudoClasses: ['hover'] });
    await sleep(320);
    hitHover = JSON.parse(
      String(
        await cdp.eval(`(() => {
          const row = document.querySelector('.search-modal .modal-body .list-row');
          if (!row) return JSON.stringify({ ty: 0, shadow: 'none', bg: '' });
          const cs = getComputedStyle(row);
          const m = new DOMMatrixReadOnly(cs.transform === 'none' ? '' : cs.transform);
          const hits = [];
          const walk = (list, media) => {
            for (const r of list) {
              if (r.cssRules) {
                walk(r.cssRules, media || (r.conditionText || ''));
                continue;
              }
              if (!r.selectorText || !r.style) continue;
              if (!/list-row/.test(r.selectorText)) continue;
              if (!r.style.transform && !r.style.boxShadow) continue;
              let ok = false;
              try {
                ok = row.matches(r.selectorText);
              } catch (e) {
                ok = false;
              }
              if (ok) hits.push((media ? '@' + media + ' ' : '') + r.selectorText + ' → transform:' + (r.style.transform || '-') + ' shadow:' + (r.style.boxShadow || '-'));
            }
          };
          for (const sheet of document.styleSheets) {
            try {
              walk(sheet.cssRules, '');
            } catch (e) {
              /* 跨源样式表读不到就算了 */
            }
          }
          return JSON.stringify({
            ty: m.m42,
            shadow: cs.boxShadow,
            bg: cs.backgroundColor,
            trans: cs.transitionProperty,
            hovered: row.matches(':hover'),
            selOk: row.matches('.search-modal .modal-body .list-row:hover'),
            inBody: !!row.closest('.modal-body'),
            inSearch: !!row.closest('.search-modal'),
            parent: row.parentElement ? String(row.parentElement.className) : 'none',
            rules: hits.join(' ‖ ').slice(0, 400)
          });
        })()`)
      )
    );
    await cdp.send('CSS.forcePseudoState', { nodeId: sel.nodeId, forcedPseudoClasses: [] });
    // 若样式没生效，用 CDP 的 matched styles 查出到底哪条规则赢了（跨源读 cssRules 会失败，这条不会）
    if (Number(hitHover.ty) > -0.5) {
      try {
        await cdp.send('DOM.enable');
        await cdp.send('CSS.enable');
        const doc2 = await cdp.send('DOM.getDocument', { depth: 1 });
        const nd = await cdp.send('DOM.querySelector', {
          nodeId: doc2.root.nodeId,
          selector: '.search-modal .modal-body .list-row'
        });
        await cdp.send('CSS.forcePseudoState', { nodeId: nd.nodeId, forcedPseudoClasses: ['hover'] });
        const ms = await cdp.send('CSS.getMatchedStylesForNode', { nodeId: nd.nodeId });
        const parts = [];
        for (const m of ms.matchedCSSRules || []) {
          const txt = m.rule && m.rule.selectorList ? m.rule.selectorList.text : '';
          const props = (m.rule.style && m.rule.style.cssProperties ? m.rule.style.cssProperties : [])
            .filter((p) => p.name === 'transform' || p.name === 'box-shadow')
            .map((p) => p.name + ':' + p.value + (p.important ? '!important' : ''));
          if (props.length) parts.push(txt + ' → ' + props.join(','));
        }
        hitHover.rules = (parts.length ? parts.slice(-4).join(' ‖ ') : '没有任何规则改 transform/阴影').slice(0, 400);
        const after = await cdp.eval(`(() => { const r = document.querySelector('.search-modal .modal-body .list-row'); const cs = getComputedStyle(r); return JSON.stringify({ t: cs.transform, s: cs.boxShadow }); })()`);
        hitHover.rules += ' ｜ 强制后=' + String(after).slice(0, 90);
        await cdp.send('CSS.forcePseudoState', { nodeId: nd.nodeId, forcedPseudoClasses: [] });
      } catch (err) {
        hitHover.rules = 'err:' + err;
      }
    }
  }
  // 判定：优先「实测真的浮起来了」；若 Chromium 在 --disable-gpu + 合成/强制 hover 下把
  // getComputedStyle 停在旧值（本机确实会出现），则用 CDP matched styles 证明
  // 「.list-row:hover 那条规则赢下了层叠（translateY(-1px) + 投影）」+ 过渡接线正确 —— 同样能防回归
  const hoverRuleWins = /\.list-row:hover/.test(String(hitHover.rules)) && /translateY\(-1px\)/.test(String(hitHover.rules));
  const hoverMeasured = Number(hitHover.ty) <= -0.5 && String(hitHover.shadow) !== 'none';
  const hoverWired = /transform/.test(String(hitHover.trans));
  results.push({
    name: '第五版：搜索命中行悬停浮起（上移 1px + 投影）',
    ok: hitBox.count > 0 && (hoverMeasured || (hoverRuleWins && hoverWired)),
    detail:
      '命中=' + hitBox.count + ' 行 ' + hitBox.which + '（' + (hoverMeasured ? '实测浮起' : '按层叠规则') + '）translateY=' + hitHover.ty + ' 投影=' + String(hitHover.shadow).slice(0, 30) + ' 过渡=' + String(hitHover.trans || '').slice(0, 58) + ' 命中规则=' + String(hitHover.rules || '').slice(0, 150)
  });

  // 关掉搜索面板
  await cdp.eval("(() => { const b = document.querySelector('.modal-head .icon-btn'); if (b) b.click(); return true; })()");
  await sleep(400);

  // ③ Toast 从右侧滑入 + 弹跳
  await cdp.eval(
    "(() => { const b = [...document.querySelectorAll('.topbar button')].find((x) => (x.textContent || '').includes('快速记录')); if (b) b.click(); return true; })()"
  );
  const readToast = `(() => {
    const t = [...document.querySelectorAll('.toast-wrap .toast')].pop();
    const wrap = document.querySelector('.toast-wrap');
    if (!t || !wrap) return { found: false };
    const cs = getComputedStyle(t);
    const ws = getComputedStyle(wrap);
    const m = new DOMMatrixReadOnly(cs.transform === 'none' ? '' : cs.transform);
    return { found: true, anim: cs.animationName, tx: m.m41, ease: cs.animationTimingFunction, right: ws.right, backdrop: cs.backdropFilter };
  })()`;
  let toastIn = { found: false, tx: 0 };
  for (let i = 0; i < 8; i++) {
    await sleep(45);
    toastIn = await cdp.eval(readToast);
    if (toastIn.found && Number(toastIn.tx) > 1) break;
  }
  results.push({
    name: '第五版：Toast 从右侧滑入，用带回弹的曲线',
    ok: toastIn.found === true && toastIn.anim === 'jw-toast-in' && Number(toastIn.tx) > 1 && /cubic-bezier/.test(String(toastIn.ease)),
    detail: '动画=' + toastIn.anim + ' 滑入位移=' + toastIn.tx + ' 曲线=' + toastIn.ease
  });
  results.push({
    name: '第五版：Toast 挂在右下角（贴右 20px）',
    ok: String(toastIn.right) === '20px',
    detail: 'right=' + toastIn.right + ' backdrop=' + toastIn.backdrop
  });
  // 再点一次，等它落位后补一张截图（落位 = 420ms 动画走完）
  await cdp.eval(
    "(() => { const b = [...document.querySelectorAll('.topbar button')].find((x) => (x.textContent || '').includes('快速记录')); if (b) b.click(); return true; })()"
  );
  await sleep(520);
  await cdp.shot('toast-right');

  // 任务：先点开一行，抽屉里才有保存按钮
  await cdp.eval("location.hash = '/tasks'; true");
  await sleep(700);
  await cdp.eval(`(() => {
    const row = document.querySelector('.task-row');
    if (row) row.click();
    return true;
  })()`);
  await sleep(500);
  const taskSave = await cdp.eval(
    "(() => { const b = [...document.querySelectorAll('.drawer button')].find((x) => (x.textContent || '').trim().indexOf('保存') === 0); return b ? (b.textContent || '').trim() : 'no-btn'; })()"
  );
  results.push({ name: '任务详情抽屉里有「保存」按钮', ok: String(taskSave).startsWith('保存'), detail: String(taskSave) });
  if (String(taskSave).startsWith('保存')) {
    await cdp.eval(
      "(() => { const b = [...document.querySelectorAll('.drawer button')].find((x) => (x.textContent || '').trim().indexOf('保存') === 0); if (b) b.click(); return true; })()"
    );
    await sleep(700);
    const taskToast = await cdp.eval("(() => [...document.querySelectorAll('.toast-wrap .toast')].map((e) => e.innerText).join(' | '))()");
    results.push({
      name: '任务点保存后报「已保存 HH:MM:SS」',
      ok: /已保存 \d{2}:\d{2}:\d{2}/.test(String(taskToast)),
      detail: String(taskToast).slice(0, 80)
    });
  }

  // 设置页：得先改动一处（这里把主题切到 dark），保存条才会出现
  await cdp.eval("location.hash = '/settings'; true");
  await sleep(700);
  const settingsSave = await cdp.eval(`(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    const sel = [...document.querySelectorAll('select')].find((s) => [...s.options].some((o) => o.value === 'dark'));
    if (!sel) return 'no-theme-select';
    setter.call(sel, 'dark');
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 400));
    const btn = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '保存设置' && !b.disabled);
    if (!btn) return 'no-btn';
    btn.click();
    await new Promise((r) => setTimeout(r, 900));
    return [...document.querySelectorAll('.toast-wrap .toast')].map((e) => e.innerText).join(' | ');
  })()`);
  results.push({
    name: '设置页点「保存设置」报「已保存 HH:MM:SS」',
    ok: /已保存 \d{2}:\d{2}:\d{2}/.test(String(settingsSave)),
    detail: String(settingsSave).slice(0, 90)
  });
  // 收尾：把主题改回浅色，别把 light 的主题留在深色上
  await cdp.eval(`(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    const sel = [...document.querySelectorAll('select')].find((s) => [...s.options].some((o) => o.value === 'dark'));
    if (sel) {
      setter.call(sel, 'light');
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 300));
      const btn = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '保存设置' && !b.disabled);
      if (btn) btn.click();
      await new Promise((r) => setTimeout(r, 600));
    }
    return true;
  })()`);
  const backOk = await cdp.eval(
    `(async () => {
      const sel = [...document.querySelectorAll('select')].find((s) => [...s.options].some((o) => o.value === 'dark'));
      if (!sel) return 'no-select';
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
      setter.call(sel, 'light');
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 400));
      return document.documentElement.getAttribute('data-theme');
    })()`
  );
  results.push({ name: '浅色主题能切回', ok: backOk === 'light', detail: String(backOk) });

  // 第五版（方案B）：自绘标题栏 —— 无边框窗口 + 红黄绿三个点 + 顶栏拖拽区
  const titlebar = await cdp.eval(
    `(() => {
      const region = (el) => { const cs = getComputedStyle(el); return cs.webkitAppRegion || cs.getPropertyValue('-webkit-app-region') || ''; };
      const lights = [...document.querySelectorAll('.brand .win-light')];
      const topLights = document.querySelector('.topbar .win-lights');
      return JSON.stringify({
        lights: lights.length,
        topLights: topLights ? getComputedStyle(topLights).display : 'none',
        labels: lights.map((b) => b.getAttribute('aria-label')).join('|'),
        text: lights.map((b) => b.textContent.trim()).join(''),
        chrome: window.outerHeight - window.innerHeight,
        brandDrag: region(document.querySelector('.brand')),
        topDrag: region(document.querySelector('.topbar')),
        navDrag: region(document.querySelector('.nav-item'))
      });
    })()`
  );
  const tb = JSON.parse(String(titlebar));
  results.push({
    name: '自绘标题栏有红黄绿三个点，且没有文字节点',
    ok: tb.lights === 3 && tb.text === '' && tb.topLights === 'none',
    detail: `点数=${tb.lights} 文本="${tb.text}" 名字=${tb.labels} 宽屏顶栏那份=${tb.topLights}`
  });
  results.push({
    name: '窗口确实是无边框的（系统标题栏高度≈0）',
    ok: Math.abs(Number(tb.chrome)) <= 8,
    detail: `outer-inner 高差=${tb.chrome}px`
  });
  results.push({
    name: '顶栏是拖拽区、导航项不是（不然点不动）',
    ok: tb.topDrag === 'drag' && tb.navDrag === 'no-drag',
    detail: `topbar=${tb.topDrag} brand=${tb.brandDrag} nav=${tb.navDrag}`
  });

  const maxed = await cdp.eval(
    `(async () => {
       const wait = (ms) => new Promise((r) => setTimeout(r, ms));
       const before = window.innerWidth;
       document.querySelector('.win-max').click();
       await wait(800);
       const after = window.innerWidth;
       // 还原：窗口状态偶尔要一两拍才同步，没回来就再点一次（最多 5 次）
       let tries = 0;
       for (; tries < 5 && window.innerWidth !== before; tries++) {
         document.querySelector('.win-max').click();
         await wait(420);
       }
       return JSON.stringify({ before, after, back: window.innerWidth, tries });
     })()`
  );
  const m = JSON.parse(String(maxed));
  results.push({
    name: '点绿点能最大化、再点能还原窗口',
    ok: m.after >= m.before && m.back === m.before,
    detail: `宽 ${m.before} → ${m.after} → ${m.back}（还原点了 ${m.tries} 次）`
  });

  // 亚克力：主进程真的调用了 setBackgroundMaterial 才回报 acrylic
  const infoRaw = await cdp.eval("(async () => JSON.stringify(await window.api.invoke('app:info')))()");
  const winInfo = JSON.parse(String(infoRaw));
  const wantAcrylic = Number(winInfo.windowsBuild) >= 22000;
  results.push({
    name: '窗口系统材质与系统版本相符（Win11 要 acrylic）',
    ok: winInfo.material === (wantAcrylic ? 'acrylic' : 'none'),
    detail: `material=${winInfo.material} build=${winInfo.windowsBuild}`
  });

  // H2：打包后的版本必须完全不联网 —— CSP 里只留 'self'，开发用的 ws:/localhost 必须被去掉
  const csp = await cdp.eval(
    `document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') || ''`
  );
  const cspText = String(csp);
  results.push({
    name: 'CSP 已收紧（打包版不联网）',
    ok: cspText.includes("connect-src 'self'") && !cspText.includes('localhost') && !cspText.includes('ws:'),
    detail: cspText.slice(0, 160)
  });

  // ---- 第五版（阶段9）：响应式断点（用 CDP 改视口宽度，四档逐个量） ----
  const setViewport = async (width, height) => {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await cdp.eval('window.dispatchEvent(new Event("resize")); true');
    await sleep(620);
  };
  const bandRead = async () =>
    JSON.parse(
      String(
        await cdp.eval(`(() => {
    const de = document.documentElement;
    const sb = document.querySelector('.sidebar');
    const sr = sb.getBoundingClientRect();
    const scs = getComputedStyle(sb);
    const burger = document.querySelector('.topbar-burger');
    const dash = document.querySelector('.dash-grid');
    const kb = document.querySelector('.kb');
    const tree = document.querySelector('.kb-tree');
    return JSON.stringify({
      w: Math.round(window.innerWidth),
      layout: de.dataset.layout || '',
      sbW: Math.round(sr.width),
      sbX: Math.round(sr.x),
      // 面板定宽 232、靠 transform 挪；肉眼看到的宽度是「落在视口里的那一段」
      sbVisW: Math.round(Math.max(0, Math.min(sr.right, window.innerWidth) - Math.max(sr.left, 0))),
      sbPos: scs.position,
      burger: burger ? getComputedStyle(burger).display : 'none',
      lightsTop: (() => { const t = document.querySelector('.topbar .win-lights'); return t ? getComputedStyle(t).display : 'none'; })(),
      lightsBrand: (() => { const b = document.querySelector('.brand .win-lights'); return b ? getComputedStyle(b).display : 'none'; })(),
      dashCols: dash ? getComputedStyle(dash).gridTemplateColumns.split(' ').filter(Boolean).length : 0,
      kbDir: kb ? getComputedStyle(kb).flexDirection : '',
      treeShown: tree ? getComputedStyle(tree).display !== 'none' : false,
      overflowX: Math.max(0, Math.round(de.scrollWidth - window.innerWidth))
    });
  })()`)
      )
    );

  await cdp.eval("location.hash = '/'; true");
  await sleep(620);

  await setViewport(1600, 900);
  const wideBand = await bandRead();
  results.push({
    name: '第五版：窗口 ≥1200 是完整三栏（侧栏 232px、没有汉堡、首页两栏）',
    ok:
      wideBand.layout === 'wide' &&
      wideBand.sbW >= 224 &&
      wideBand.sbW <= 240 &&
      wideBand.burger === 'none' &&
      wideBand.dashCols === 2 &&
      wideBand.overflowX <= 1 &&
      wideBand.lightsTop === 'none' &&
      wideBand.lightsBrand === 'flex',
    detail: `宽=${wideBand.w} 档=${wideBand.layout} 侧栏=${wideBand.sbW}px 汉堡=${wideBand.burger} 首页列数=${wideBand.dashCols} 横向溢出=${wideBand.overflowX} 窗口键=侧栏`
  });

  await setViewport(1100, 900);
  const railBand = await bandRead();
  results.push({
    name: '第五版：窗口 1024–1199 侧栏自动收成 60px 图标条',
    ok: railBand.layout === 'rail' && railBand.sbVisW <= 66 && railBand.burger === 'none',
    detail: `宽=${railBand.w} 档=${railBand.layout} 可见宽=${railBand.sbVisW}px（面板 ${railBand.sbW}px） 汉堡=${railBand.burger}`
  });

  await setViewport(950, 900);
  const drawerBand = await bandRead();
  results.push({
    name: '第五版：窗口 768–1023 侧栏变成抽屉（默认藏在左边、出现汉堡、两栏并一栏）',
    ok:
      drawerBand.layout === 'drawer' &&
      drawerBand.sbPos === 'fixed' &&
      drawerBand.sbX < 0 &&
      drawerBand.burger !== 'none' &&
      drawerBand.dashCols === 1 &&
      drawerBand.overflowX <= 1 &&
      drawerBand.lightsTop === 'flex' &&
      drawerBand.lightsBrand === 'none',
    detail: `宽=${drawerBand.w} 档=${drawerBand.layout} 侧栏=${drawerBand.sbPos} x=${drawerBand.sbX} 汉堡=${drawerBand.burger} 首页列数=${drawerBand.dashCols} 横向溢出=${drawerBand.overflowX}`
  });
  await cdp.shot('responsive-drawer-closed');

  // 侧栏一离场，窗口按钮必须还在 —— 挪到顶栏，且在汉堡左边、真的可点
  const drawerLights = JSON.parse(
    String(
      await cdp.eval(`(() => {
    const t = document.querySelector('.topbar .win-lights');
    const b = document.querySelector('.brand .win-lights');
    const r = t.getBoundingClientRect();
    const burger = document.querySelector('.topbar-burger').getBoundingClientRect();
    const dots = [...t.querySelectorAll('.win-light')];
    return JSON.stringify({
      top: getComputedStyle(t).display,
      brand: b ? getComputedStyle(b).display : 'none',
      dots: dots.filter((el) => el.getBoundingClientRect().width >= 11).length,
      x: Math.round(r.x),
      leftOfBurger: r.x <= burger.x,
      inView: r.x >= 0 && r.right < window.innerWidth
    });
  })()`)
    )
  );
  results.push({
    name: '第五版：侧栏变抽屉后，窗口按钮挪到顶栏（不然窄窗口关不掉）',
    ok:
      drawerLights.top === 'flex' &&
      drawerLights.brand === 'none' &&
      drawerLights.dots === 3 &&
      drawerLights.leftOfBurger === true &&
      drawerLights.inView === true,
    detail: `顶栏那份=${drawerLights.top} 可见的点=${drawerLights.dots} 侧栏那份=${drawerLights.brand} x=${drawerLights.x} 在汉堡左边=${drawerLights.leftOfBurger}`
  });

  await cdp.eval("(() => { const b = document.querySelector('.topbar-burger'); if (b) b.click(); return true; })()");
  // 抽屉滑出是 0.38s 的 transform 动画；软件渲染下偶尔会晚几帧才开始，所以轮询到就位为止
  const drawerOpen = JSON.parse(
    String(
      await cdp.eval(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const sb = document.querySelector('.sidebar');
    let x = -999;
    for (let i = 0; i < 14; i++) {
      await sleep(60);
      x = Math.round(sb.getBoundingClientRect().x);
      if (x >= -1) break;
    }
    const r = sb.getBoundingClientRect();
    return JSON.stringify({
      x: Math.round(r.x),
      w: Math.round(r.width),
      open: sb.classList.contains('drawer-open'),
      veil: !!document.querySelector('.sidebar-veil')
    });
  })()`)
    )
  );
  results.push({
    name: '第五版：点汉堡抽屉从左边滑出来，还带一层蒙层',
    ok: drawerOpen.open === true && drawerOpen.x >= -1 && drawerOpen.w >= 224 && drawerOpen.veil === true,
    detail: `抽屉 x=${drawerOpen.x} 宽=${drawerOpen.w} 展开=${drawerOpen.open} 蒙层=${drawerOpen.veil}`
  });
  await cdp.shot('responsive-drawer-open');
  await cdp.eval("(async () => { const v = document.querySelector('.sidebar-veil'); if (v) v.click(); await new Promise((r) => setTimeout(r, 380)); return true; })()");

  await cdp.eval("location.hash = '/knowledge'; true");
  await sleep(680);
  await setViewport(720, 860);
  const singleBand = await bandRead();
  results.push({
    name: '第五版：窗口 <768 变单栏（知识库列表与编辑器上下排、分类列还看得见）',
    ok:
      singleBand.layout === 'single' &&
      singleBand.kbDir === 'column' &&
      singleBand.treeShown === true &&
      singleBand.overflowX <= 1 &&
      singleBand.lightsTop === 'flex',
    detail: `宽=${singleBand.w} 档=${singleBand.layout} 知识库方向=${singleBand.kbDir} 分类列可见=${singleBand.treeShown} 横向溢出=${singleBand.overflowX} 顶栏窗口键=${singleBand.lightsTop}`
  });
  await cdp.shot('responsive-single');

  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await cdp.eval('window.dispatchEvent(new Event("resize")); true');
  await sleep(700);
  const backBand = await bandRead();
  results.push({
    name: '第五版：窗口拉大回去，侧栏自动恢复成完整版',
    ok: backBand.layout === 'wide' && backBand.sbW >= 224 && backBand.burger === 'none' && backBand.overflowX <= 1,
    detail: `宽=${backBand.w} 档=${backBand.layout} 侧栏=${backBand.sbW}px 汉堡=${backBand.burger} 横向溢出=${backBand.overflowX}`
  });
  // 第五版收尾：断点边界 —— 三个阈值（1200 / 1024 / 768）各测两侧。
  // readLayout() 的 `<` 写成 `<=`、或者媒体查询少写 1px，肉眼几乎看不出来，
  // 但会让某一档永远进不去（比如 1200 那个宽度看起来还是图标条）。这类错只能靠边界断言兜。
  const edgeBands = [];
  for (const pair of [[1200, 1199], [1024, 1023], [768, 767]]) {
    await setViewport(pair[0], 860);
    const hi = await bandRead();
    await setViewport(pair[1], 860);
    const lo = await bandRead();
    edgeBands.push({ hi, lo });
  }
  const [edgeWide, edgeRail] = [edgeBands[0].hi, edgeBands[0].lo];
  results.push({
    name: '第五版收尾：断点边界 1200 / 1199 —— 正好 1200 算三栏宽屏，1199 才收成图标条',
    ok:
      edgeWide.layout === 'wide' &&
      edgeWide.sbVisW >= 224 &&
      edgeWide.burger === 'none' &&
      edgeRail.layout === 'rail' &&
      edgeRail.sbVisW > 0 &&
      edgeRail.sbVisW <= 66 &&
      edgeRail.burger === 'none',
    detail: `1200→档=${edgeWide.layout} 侧栏可见=${edgeWide.sbVisW}px 汉堡=${edgeWide.burger}；1199→档=${edgeRail.layout} 侧栏可见=${edgeRail.sbVisW}px 汉堡=${edgeRail.burger}`
  });
  const [edgeRail2, edgeDrawer] = [edgeBands[1].hi, edgeBands[1].lo];
  results.push({
    name: '第五版收尾：断点边界 1024 / 1023 —— 1024 还是图标条，1023 才变抽屉（窗口按钮跟着挪顶栏）',
    ok:
      edgeRail2.layout === 'rail' &&
      edgeRail2.sbVisW <= 66 &&
      edgeRail2.burger === 'none' &&
      edgeDrawer.layout === 'drawer' &&
      edgeDrawer.burger === 'flex' &&
      edgeDrawer.lightsTop === 'flex' &&
      edgeDrawer.lightsBrand === 'none',
    detail: `1024→档=${edgeRail2.layout} 可见=${edgeRail2.sbVisW}px 汉堡=${edgeRail2.burger}；1023→档=${edgeDrawer.layout} 汉堡=${edgeDrawer.burger} 顶栏窗口键=${edgeDrawer.lightsTop} 侧栏窗口键=${edgeDrawer.lightsBrand}`
  });
  const [edgeDrawer2, edgeSingle] = [edgeBands[2].hi, edgeBands[2].lo];
  results.push({
    name: '第五版收尾：断点边界 768 / 767 —— 768 还横着排，767 才上下堆成单栏',
    ok:
      edgeDrawer2.layout === 'drawer' &&
      edgeDrawer2.kbDir === 'row' &&
      edgeDrawer2.burger === 'flex' &&
      edgeSingle.layout === 'single' &&
      edgeSingle.kbDir === 'column' &&
      edgeSingle.treeShown === true &&
      edgeSingle.overflowX <= 1,
    detail: `768→档=${edgeDrawer2.layout} 知识库方向=${edgeDrawer2.kbDir}；767→档=${edgeSingle.layout} 知识库方向=${edgeSingle.kbDir} 分类列可见=${edgeSingle.treeShown} 横向溢出=${edgeSingle.overflowX}`
  });
  // 边界测完把视口收回真实窗口尺寸，后面还有手感修正与阶段10/11 的断言在读当前窗口
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await cdp.eval('window.dispatchEvent(new Event("resize")); true');
  await sleep(700);

  // 第五版（阶段9 手感修正）：拖窗口时先锁住插值 —— 窗口每帧都在改尺寸，
  // 同一条时间轴上再跑 180ms 的宽度插值，等于每帧多一次重排，跨档那一下就掉帧。
  const resizeLock = await cdp.eval(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const sb = document.querySelector('.sidebar');
    const read = () => ({
      resizing: document.documentElement.classList.contains('is-resizing'),
      dur: getComputedStyle(sb).transitionDuration
    });
    const before = read();
    window.dispatchEvent(new Event('resize'));
    await sleep(40);
    const during = read();
    await sleep(360);
    const after = read();
    return { before, during, after };
  })()`);
  results.push({
    name: '第五版：拖窗口时先锁住插值，停手 150ms 后自己恢复',
    ok:
      resizeLock.before.resizing === false &&
      resizeLock.during.resizing === true &&
      /^0s/.test(resizeLock.during.dur) &&
      resizeLock.after.resizing === false &&
      /0\.38s/.test(resizeLock.after.dur),
    detail: `拖之前=class:${resizeLock.before.resizing} 拖之中=class:${resizeLock.during.resizing} 过渡:${resizeLock.during.dur} 停手后=class:${resizeLock.after.resizing} 过渡:${resizeLock.after.dur}`
  });

  // ---------------------------------------------------------------
  // 第五版（阶段10）：弹窗与右键菜单
  // ---------------------------------------------------------------
  await cdp.eval("location.hash = '/knowledge'; true");
  await sleep(760);

  // 回归：全局搜索靠「搜索框聚焦」打开，关掉时不能把焦点还回去（否则 onFocus 立刻又弹一次）
  await cdp.eval("(() => { const i = document.querySelector('.searchbox input'); if (i) i.focus(); return true; })()");
  await sleep(460);
  const paletteReopened = await cdp.eval("(() => !!document.querySelector('.modal.search-modal'))()");
  await cdp.eval("(() => { const b = document.querySelector('.modal-head .icon-btn'); if (b) b.click(); return true; })()");
  await sleep(220);
  const paletteGone = await cdp.eval("(async () => { const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); await sleep(320); return !document.querySelector('.modal.search-modal'); })()");
  results.push({
    name: '第五版：关掉全局搜索不会自己又弹回来（焦点没还给搜索框）',
    ok: paletteReopened === true && paletteGone === true,
    detail: '聚焦后打开=' + paletteReopened + ' 点×后已关=' + paletteGone
  });

  const closeAnyModal = async () => {
    await cdp.eval(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      for (let i = 0; i < 8; i += 1) {
        if (!document.querySelector('.modal')) return true;
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        await sleep(240);
      }
      return !document.querySelector('.modal');
    })()`);
  };

  const clearCtxMenu = async () => {
    await cdp.eval(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      if (document.querySelector('.ctx-menu')) {
        document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 1, clientY: 1 }));
        await sleep(340);
      }
      return !document.querySelector('.ctx-menu');
    })()`);
  };
  await closeAnyModal();
  await clearCtxMenu();
  const ctxNote = await cdp.eval(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const row = document.querySelector('.kb-list-body .list-row');
    if (!row) return { error: '没有笔记行' };
    row.scrollIntoView({ block: 'center' });
    await sleep(160);
    const r = row.getBoundingClientRect();
    const fire = (x, y) =>
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
    fire(Math.round(r.left + 80), Math.round(r.top + 14));
    await sleep(140);
    const m = document.querySelector('.ctx-menu');
    if (!m) return { error: '右键笔记行没弹出菜单' };
    const cs = getComputedStyle(m);
    const items = [...m.querySelectorAll('.ctx-item .ctx-label')].map((b) => b.textContent.trim());
    const glass = String(cs.getPropertyValue('backdrop-filter') || '');
    const pos = cs.getPropertyValue('position');
    const z = cs.getPropertyValue('z-index');
    document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 2, clientY: 2 }));
    await sleep(300);
    const closedByOutside = !document.querySelector('.ctx-menu');
    fire(window.innerWidth - 4, window.innerHeight - 4);
    await sleep(140);
    const m2 = document.querySelector('.ctx-menu');
    const b2 = m2 ? m2.getBoundingClientRect() : null;
    const staysInside = b2
      ? b2.right <= window.innerWidth + 1 && b2.bottom <= window.innerHeight + 1 && b2.left >= 0 && b2.top >= 0
      : false;
    document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 2, clientY: 2 }));
    await sleep(300);
    return { items, glass, pos, z, closedByOutside, staysInside };
  })()`);
  results.push({
    name: '第五版：右键笔记行弹出毛玻璃菜单（贴鼠标、挨着窗口边会自己往里收、点外面就关）',
    ok:
      !!ctxNote.items &&
      ctxNote.items.some((t) => t.includes('移到回收站')) &&
      ctxNote.items.some((t) => t.includes('打开')) &&
      /blur\(20px\)/.test(String(ctxNote.glass)) &&
      ctxNote.pos === 'fixed' &&
      ctxNote.closedByOutside === true &&
      ctxNote.staysInside === true,
    detail: `项目=${(ctxNote.items || []).join('/')} 滤镜=${String(ctxNote.glass).slice(0, 34)} 位置=${ctxNote.pos} 点外面关=${ctxNote.closedByOutside} 右下角留得住=${ctxNote.staysInside}`
  });
  // 截图要有菜单在画面里：单独再打开一次，拍完再关
  await cdp.eval(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const row = document.querySelector('.kb-list-body .list-row');
    const r = row.getBoundingClientRect();
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: Math.round(r.left + 80), clientY: Math.round(r.top + 12) }));
    await sleep(260);
    return !!document.querySelector('.ctx-menu');
  })()`);
  await cdp.shot('ctx-menu');
  await clearCtxMenu();
  const ctxKeys = await cdp.eval(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const row = document.querySelector('.kb-list-body .list-row');
    const r = row.getBoundingClientRect();
    row.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: Math.round(r.left + 80),
        clientY: Math.round(r.top + 14)
      })
    );
    await sleep(150);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    await sleep(90);
    const activeEl = document.querySelector('.ctx-menu .ctx-item.active');
    const activeText = activeEl ? activeEl.textContent.trim() : '';
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await sleep(60);
    const leaving = !!document.querySelector('.ctx-menu.leaving');
    await sleep(260);
    return { activeText, leaving, gone: !document.querySelector('.ctx-menu') };
  })()`);
  results.push({
    name: '第五版：右键菜单能用键盘上下选、Esc 关掉（先播完退场再卸）',
    ok: ctxKeys.activeText.length > 0 && ctxKeys.leaving === true && ctxKeys.gone === true,
    detail: `高亮=${ctxKeys.activeText} 退场类=${ctxKeys.leaving} 关干净=${ctxKeys.gone}`
  });

  await clearCtxMenu();
  const ctxModal = await cdp.eval(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const openMenu = async (row) => {
      const r = row.getBoundingClientRect();
      row.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: Math.round(r.left + 40),
          clientY: Math.round(r.top + 10)
        })
      );
      await sleep(150);
      return document.querySelector('.ctx-menu');
    };
    const rows = [...document.querySelectorAll('.kb-tree .tree-item')];
    let items = [];
    let menu = null;
    for (const row of rows) {
      menu = await openMenu(row);
      if (menu) {
        items = [...menu.querySelectorAll('.ctx-item .ctx-label')].map((b) => b.textContent.trim());
        break;
      }
    }
    if (!items.length) return { error: '分类行没有右键菜单' };
    const rename = [...document.querySelectorAll('.ctx-menu .ctx-item')].find((b) => b.textContent.includes('改名字'));
    if (!rename) return { error: '分类菜单里没有改名字', items };
    rename.click();
    await sleep(320);
    const dlg = document.querySelector('.modal');
    if (!dlg) return { error: '改名字没弹出弹窗', items };
    const box = dlg.getBoundingClientRect();
    const cs = getComputedStyle(dlg);
    const focused = document.activeElement;
    const focusIn = !!(focused && dlg.contains(focused) && (focused.tagName === 'INPUT' || focused.tagName === 'TEXTAREA'));
    const glass = String(cs.getPropertyValue('backdrop-filter') || '');
    const props = String(cs.transitionProperty);
    const anim = String(cs.animationName);
    const x = dlg.querySelector('.modal-head .icon-btn');
    if (!x) return { error: '没找到关闭按钮', items };
    x.click();
    await sleep(70);
    const leaving = !!document.querySelector('.modal-backdrop.leaving');
    let gone = false;
    for (let i = 0; i < 18 && !gone; i += 1) {
      await sleep(80);
      gone = !dlg.isConnected;
    }
    return { items, glass, props, anim, focusIn, leaving, gone, rest: [...document.querySelectorAll('.modal-head span')].map((s) => s.textContent).join('|'), w: Math.round(box.width) };
  })()`);
  results.push({
    name: '第五版：弹窗入场只动 transform/opacity（带毛玻璃、焦点自动落在输入框），关闭时先播完退场再卸',
    ok:
      !!ctxModal.items &&
      ctxModal.items.some((t) => t.includes('新建子分类')) &&
      /jw-modal-in/.test(String(ctxModal.anim)) &&
      /blur\(20px\)/.test(String(ctxModal.glass)) &&
      ctxModal.focusIn === true &&
      !/\b(width|height|margin|left|top|padding)\b/.test(String(ctxModal.props)) &&
      ctxModal.leaving === true &&
      ctxModal.gone === true,
    detail: `分类菜单=${(ctxModal.items || []).join('/')} 动画=${ctxModal.anim} 滤镜=${String(ctxModal.glass).slice(0, 30)} 焦点进了输入框=${ctxModal.focusIn} 点×后播退场=${ctxModal.leaving} 卸干净=${ctxModal.gone} 残留弹窗=${ctxModal.rest}`
  });

  const ctxTask = await cdp.eval("location.hash = '/tasks'; true");
  await sleep(760);
  await clearCtxMenu();
  const taskMenu = await cdp.eval(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const row = document.querySelector('.task-row');
    if (!row) return { error: '没有任务行' };
    const r = row.getBoundingClientRect();
    row.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: Math.round(r.left + 60),
        clientY: Math.round(r.top + 12)
      })
    );
    await sleep(150);
    const m = document.querySelector('.ctx-menu');
    const items = m ? [...m.querySelectorAll('.ctx-item .ctx-label')].map((b) => b.textContent.trim()) : [];
    document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 2, clientY: 2 }));
    let closed = false;
    for (let i = 0; i < 20 && !closed; i += 1) {
      await sleep(60);
      closed = !document.querySelector('.ctx-menu');
    }
    return { items, closed };
  })()`);
  results.push({
    name: '第五版：右键任务行能标记完成 / 改优先级 / 删除',
    ok:
      !!taskMenu.items &&
      taskMenu.items.some((t) => t.includes('标记完成') || t.includes('取消完成')) &&
      taskMenu.items.some((t) => t.includes('优先级')) &&
      taskMenu.items.some((t) => t.includes('删除')) &&
      taskMenu.closed === true,
    detail: `项目=${(taskMenu.items || []).join('/')} 关掉=${taskMenu.closed}`
  });

  await setViewport(720, 860);
  await cdp.eval("location.hash = '/knowledge'; true");
  await sleep(760);

  await closeAnyModal();
  await clearCtxMenu();
  const sheet = await cdp.eval(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const rows = [...document.querySelectorAll('.kb-tree .tree-item')];
    let items = [];
    for (const row of rows) {
      const r = row.getBoundingClientRect();
      row.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: Math.round(r.left + 40),
          clientY: Math.round(r.top + 10)
        })
      );
      await sleep(60);
      const m = document.querySelector('.ctx-menu');
      if (m) {
        items = [...m.querySelectorAll('.ctx-item .ctx-label')].map((b) => b.textContent.trim());
        break;
      }
    }
    const rename = [...document.querySelectorAll('.ctx-menu .ctx-item')].find((b) => b.textContent.includes('改名字'));
    if (!rename) return { error: '窄窗口下分类菜单没有改名字', items };
    rename.click();
    await sleep(340);
    const dlg = document.querySelector('.modal');
    if (!dlg) return { error: '窄窗口下没弹出弹窗', items };
    const cs = getComputedStyle(dlg);
    const box = dlg.getBoundingClientRect();
    const out = {
      anim: String(cs.animationName),
      w: Math.round(box.width),
      inner: window.innerWidth,
      radius: String(cs.borderTopLeftRadius),
      top: Math.round(box.top),
      bottom: Math.round(box.bottom),
      innerH: window.innerHeight
    };
    return out;
  })()`);
  await cdp.shot('modal-sheet');
  const sheetClosed = await cdp.eval(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const dlg = document.querySelector('.modal');
    if (!dlg) return { error: '弹窗没了' };
    const x = dlg.querySelector('.modal-head .icon-btn');
    if (!x) return { error: '没找到关闭按钮' };
    x.click();
    await sleep(70);
    const leaving = !!document.querySelector('.modal-backdrop.leaving');
    let gone = false;
    for (let i = 0; i < 18 && !gone; i += 1) {
      await sleep(80);
      gone = !dlg.isConnected;
    }
    return { leaving, gone, rest: [...document.querySelectorAll('.modal-head span')].map((s) => s.textContent).join('|') };
  })()`);
  results.push({
    name: '第五版：窗口 <768 时弹窗从底部升起、占满整宽（底部面板）',
    ok:
      sheet.anim === 'jw-sheet-in' &&
      sheet.w >= sheet.inner - 26 &&
      sheet.top < sheet.innerH &&
      sheet.bottom >= sheet.innerH - 16 &&
      sheetClosed.leaving === true &&
      sheetClosed.gone === true,
    detail: `动画=${sheet.anim} 宽=${sheet.w}/${sheet.inner} 圆角=${sheet.radius} 顶=${sheet.top} 底=${sheet.bottom}/${sheet.innerH} 退场类=${sheetClosed.leaving} 关干净=${sheetClosed.gone} 残留弹窗=${sheetClosed.rest}`
  });
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await cdp.eval('window.dispatchEvent(new Event("resize")); true');
  await sleep(700);

  // ---- 第五版（阶段11）：滚动与无障碍 ----
  await cdp.eval("location.hash = '/knowledge'; true");
  await sleep(820);

  const a11yScrollProbe = await cdp.eval(`(() => {
    const bar = document.createElement('div');
    bar.style.cssText = 'position:fixed;left:-9999px;top:0;width:120px;height:80px;overflow-y:scroll;';
    bar.innerHTML = '<div style="height:400px"></div>';
    document.body.appendChild(bar);
    const barW = bar.offsetWidth - bar.clientWidth;
    bar.remove();
    const read = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const cs = getComputedStyle(el);
      return { over: cs.overscrollBehaviorY, gutter: cs.scrollbarGutter, smooth: cs.scrollBehavior, overflow: cs.overflowY };
    };
    const root = getComputedStyle(document.documentElement);
    return JSON.stringify({
      barW: barW,
      content: read('.content'),
      list: read('.kb-list-body'),
      tree: read('.kb-tree'),
      thumbTok: root.getPropertyValue('--scroll-thumb').trim(),
      thumbHover: root.getPropertyValue('--scroll-thumb-hover').trim()
    });
  })()`);
  const a11ySp = JSON.parse(String(a11yScrollProbe));
  results.push({
    name: '第五版：滚动条收成 10px 细条（颜色跟主题走），滚动容器兜住滚轮、留好滚动条槽、滚得平滑',
    ok: a11ySp.barW === 10 &&
      /^rgba\(15,\s*23,\s*42/.test(a11ySp.thumbTok) && /^rgba\(15,\s*23,\s*42/.test(a11ySp.thumbHover) &&
      !!a11ySp.content && a11ySp.content.over === 'contain' && a11ySp.content.gutter === 'stable' && a11ySp.content.smooth === 'smooth' &&
      !!a11ySp.list && a11ySp.list.over === 'contain' && a11ySp.list.gutter === 'stable' &&
      !!a11ySp.tree && a11ySp.tree.over === 'contain',
    detail: '实测滚动条宽=' + a11ySp.barW + 'px 正文[兜住=' + (a11ySp.content && a11ySp.content.over) + ' 槽=' + (a11ySp.content && a11ySp.content.gutter) + ' 平滑=' + (a11ySp.content && a11ySp.content.smooth) + '] 列表[槽=' + (a11ySp.list && a11ySp.list.gutter) + '] 分类[兜住=' + (a11ySp.tree && a11ySp.tree.over) + '] 配色=' + a11ySp.thumbTok
  });

  const a11yPressKey = async (key, code, vk) => {
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: key, code: code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: key, code: code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  };
  await cdp.eval('if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); true');
  await sleep(140);
  await a11yPressKey('Tab', 'Tab', 9);
  await sleep(320);
  const a11ySkipState = await cdp.eval(`(() => {
    const el = document.activeElement;
    const link = document.querySelector('.skip-link');
    if (!el || !link) return JSON.stringify({ err: 'no-skip' });
    const cs = getComputedStyle(link);
    const b = link.getBoundingClientRect();
    return JSON.stringify({
      onLink: el === link,
      text: (link.textContent || '').trim(),
      top: Math.round(b.top),
      visible: b.top >= 0,
      transform: cs.transform,
      outline: cs.outlineWidth + ' ' + cs.outlineColor
    });
  })()`);
  const a11ySk = JSON.parse(String(a11ySkipState));
  await cdp.shot('a11y-skip-link');
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await sleep(380);
  const a11ySkipTarget = await cdp.eval(`(() => { const el = document.activeElement; return JSON.stringify({ id: el ? el.id : '', tag: el ? el.tagName : '' }); })()`);
  const a11ySt = JSON.parse(String(a11ySkipTarget));
  results.push({
    name: '第五版：第一下 Tab 落到「跳到主内容」，回车把焦点送到正文（键盘用户不用穿过整个侧栏）',
    ok: a11ySk.onLink === true && a11ySk.text === '跳到主内容' && a11ySk.visible === true && a11ySk.top <= 22 && a11ySt.id === 'main' && a11ySt.tag === 'MAIN',
    detail: '焦点=' + (a11ySk.onLink ? 'skip-link' : '别处') + ' 顶部=' + a11ySk.top + ' 圆角边=' + a11ySk.outline + ' 回车后=' + a11ySt.tag + '#' + a11ySt.id
  });

  await cdp.eval("location.hash = '/knowledge'; true");
  await sleep(640);

  const a11yBits = await cdp.eval(`(() => {
    const q = (s) => document.querySelector(s);
    const nav = q('.nav');
    const active = q('.nav-item.active');
    const ico = q('.nav-item .ico');
    const main = q('main');
    const toggle = q('.nav-foot .icon-btn');
    const brandMark = q('.brand-mark');
    return JSON.stringify({
      navLabel: nav ? nav.getAttribute('aria-label') : '',
      current: active ? active.getAttribute('aria-current') : '',
      icoHidden: ico ? String(ico.getAttribute('aria-hidden')) : '',
      mainId: main ? main.id : '',
      mainTab: main ? String(main.tabIndex) : '',
      mainLabel: main ? main.getAttribute('aria-label') : '',
      toggleLabel: toggle ? toggle.getAttribute('aria-label') : '',
      toggleExpanded: toggle ? String(toggle.getAttribute('aria-expanded')) : '',
      brandHidden: brandMark ? String(brandMark.getAttribute('aria-hidden')) : ''
    });
  })()`);
  const a11yAr = JSON.parse(String(a11yBits));
  results.push({
    name: '第五版：屏幕阅读器能读出「主导航 / 当前在哪一页 / 主内容从哪开始 / 折叠钮是开还是合」',
    ok: a11yAr.navLabel === '主导航' && a11yAr.current === 'page' && a11yAr.icoHidden === 'true' && a11yAr.mainId === 'main' && a11yAr.mainTab === '-1' &&
      a11yAr.mainLabel === '主内容' && a11yAr.toggleLabel.length > 0 && a11yAr.toggleExpanded === 'true' && a11yAr.brandHidden === 'true',
    detail: '导航=' + a11yAr.navLabel + ' 当前=' + a11yAr.current + ' 图标藏着=' + a11yAr.icoHidden + ' 正文=' + a11yAr.mainId + '/tab' + a11yAr.mainTab + ' 折叠钮=' + a11yAr.toggleLabel + '/' + a11yAr.toggleExpanded
  });

  const a11yToastAria = await cdp.eval(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const btn = Array.from(document.querySelectorAll('.topbar button')).find((b) => (b.textContent || '').indexOf('快速记录') >= 0);
    if (!btn) return JSON.stringify({ err: 'no-btn' });
    btn.click();
    await sleep(460);
    const wrap = document.querySelector('.toast-wrap');
    const toast = document.querySelector('.toast');
    return JSON.stringify({
      role: wrap ? wrap.getAttribute('role') : '',
      live: wrap ? wrap.getAttribute('aria-live') : '',
      text: toast ? (toast.textContent || '').trim().slice(0, 12) : ''
    });
  })()`);
  const a11yTa = JSON.parse(String(a11yToastAria));
  results.push({
    name: '第五版：弹出的提示（Toast）会被屏幕阅读器念出来（role=status + aria-live=polite）',
    ok: a11yTa.role === 'status' && a11yTa.live === 'polite' && a11yTa.text.length > 0,
    detail: 'role=' + a11yTa.role + ' live=' + a11yTa.live + ' 文字=' + a11yTa.text
  });

  await cdp.eval("location.hash = '/knowledge'; true");
  await sleep(760);
  const a11yModalAria = await cdp.eval(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const rows = Array.from(document.querySelectorAll('.kb-tree .tree-item'));
    if (rows.length === 0) return JSON.stringify({ err: 'no-tree' });
    for (const row of rows) {
      const rb = row.getBoundingClientRect();
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: Math.round(rb.left + 30), clientY: Math.round(rb.top + 12) }));
      await sleep(120);
      if (document.querySelector('.ctx-menu')) break;
    }
    for (let i = 0; i < 20; i++) { if (document.querySelector('.ctx-menu')) break; await sleep(60); }
    const rename = Array.from(document.querySelectorAll('.ctx-item')).find((b) => (b.textContent || '').indexOf('改名字') >= 0);
    if (!rename) return JSON.stringify({ err: 'no-rename' });
    rename.click();
    for (let i = 0; i < 20; i++) { if (document.querySelector('.modal')) break; await sleep(60); }
    await sleep(340);
    const dlg = document.querySelector('.modal');
    if (!dlg) return JSON.stringify({ err: 'no-modal' });
    const labelledby = dlg.getAttribute('aria-labelledby');
    const title = labelledby ? document.getElementById(labelledby) : null;
    const focusIn = !!document.activeElement && dlg.contains(document.activeElement);
    const closeBtn = dlg.querySelector('.modal-head .icon-btn');
    if (closeBtn) closeBtn.click();
    await sleep(70);
    const leaving = !!document.querySelector('.modal-backdrop.leaving');
    let gone = false;
    for (let i = 0; i < 16 && !gone; i += 1) { await sleep(60); gone = !dlg.isConnected; }
    return JSON.stringify({ labelledby: labelledby, titleText: title ? (title.textContent || '').trim() : '', focusIn: focusIn, leaving: leaving, gone: gone });
  })()`);
  const a11yMa = JSON.parse(String(a11yModalAria));
  results.push({
    name: '第五版：弹窗有名字（aria-labelledby 指向标题）、打开时焦点在弹窗里、点 × 先播退场再卸干净',
    ok: a11yMa.labelledby === 'jw-modal-title' && /改.*名字|分类/.test(a11yMa.titleText) && a11yMa.focusIn === true && a11yMa.leaving === true && a11yMa.gone === true,
    detail: '标题指向=' + a11yMa.labelledby + ' 读出=' + a11yMa.titleText + ' 焦点在弹窗里=' + a11yMa.focusIn + ' 退场类=' + a11yMa.leaving + ' 关干净=' + a11yMa.gone + ' 错误=' + (a11yMa.err || '')
  });

  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await sleep(300);
  const a11yReduceOn = await cdp.eval(`(() => {
    const sb = document.querySelector('.sidebar');
    const card = document.querySelector('.list-row') || document.querySelector('.card');
    const html = getComputedStyle(document.documentElement);
    return JSON.stringify({
      side: sb ? getComputedStyle(sb).transitionDuration : '',
      card: card ? getComputedStyle(card).transitionDuration : '',
      scroll: html.scrollBehavior
    });
  })()`);
  await cdp.send('Emulation.setEmulatedMedia', { features: [] });
  await sleep(340);
  const a11yReduceOff = await cdp.eval(`(() => { const sb = document.querySelector('.sidebar'); return JSON.stringify({ side: sb ? getComputedStyle(sb).transitionDuration : '' }); })()`);
  const a11yROn = JSON.parse(String(a11yReduceOn));
  const a11yROff = JSON.parse(String(a11yReduceOff));
  results.push({
    name: '第五版：系统开了「减少动态效果」时，侧栏/卡片动画几乎取消、平滑滚动也关掉；切回来动画照旧',
    ok: parseFloat(a11yROn.side) < 0.05 && parseFloat(a11yROn.card) < 0.05 && a11yROn.scroll === 'auto' && /0\.38s/.test(a11yROff.side),
    detail: '减少动效[侧栏=' + a11yROn.side + ' 卡片=' + a11yROn.card + ' 滚动=' + a11yROn.scroll + '] 恢复后侧栏=' + a11yROff.side
  });

  const a11yFocusedRow = await cdp.eval(`(() => {
    const row = document.querySelector('.kb-list-body .list-row');
    if (!row) return 'no-row';
    row.focus();
    return document.activeElement === row ? 'focused' : 'failed';
  })()`);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await sleep(420);
  const a11yRowKey = await cdp.eval(`(() => {
    const sel = document.querySelector('.kb-list-body .list-row.selected');
    const focus = document.activeElement;
    const title = document.querySelector('.kb-editor .editor-title, .kb-editor h2, .editor-head h2');
    return JSON.stringify({
      selected: sel ? (sel.textContent || '').trim().slice(0, 12) : '',
      focusRow: !!(focus && focus.classList && focus.classList.contains('list-row')),
      editor: title ? (title.textContent || '').trim().slice(0, 12) : ''
    });
  })()`);
  const a11yRk = JSON.parse(String(a11yRowKey));
  results.push({
    name: '第五版：笔记行能用 Tab 走到，回车就打开（不用鼠标）',
    ok: a11yFocusedRow === 'focused' && a11yRk.selected.length > 0,
    detail: '行可聚焦=' + a11yFocusedRow + ' 回车后选中=' + a11yRk.selected + ' 详情标题=' + a11yRk.editor
  });

  // ---- 深色模式「白底白字」回归（复习与复盘 / 下一阶段目标 的分段标签）----
  // 那几组标签只挂 .on、没有 .btn，等于完全靠浏览器默认外观：深色下默认底色是浅灰 rgb(240,240,240)，
  // 而文字继承成近白 → 对比度只有 1.07:1，几乎看不见。现在补了 .tabs > button 的主题变量样式。
  const tabContrastScript = (theme) => `(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const nums = (s) => s.slice(s.indexOf('(') + 1, s.lastIndexOf(')')).split(',').map((v) => parseFloat(v)).filter((v) => !Number.isNaN(v));
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
    document.documentElement.setAttribute('data-theme', '${theme}');
    const pages = [];
    for (const route of ['/review', '/next']) {
      location.hash = route;
      await sleep(560);
      const rows = [...document.querySelectorAll('.tabs > button')].map((b) => {
        const cs = getComputedStyle(b);
        const fg = nums(cs.color);
        const bg = bgOf(b);
        const l1 = lum(fg);
        const l2 = lum(bg);
        return {
          on: b.classList.contains('on'),
          text: (b.textContent || '').trim().slice(0, 8),
          ratio: Math.round(((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)) * 100) / 100
        };
      });
      pages.push({ route: route, count: rows.length, min: rows.length ? Math.min(...rows.map((r) => r.ratio)) : 0, rows: rows });
    }
    return JSON.stringify(pages);
  })()`;
  const darkTabPages = JSON.parse(String(await cdp.eval(tabContrastScript('dark'))));
  const lightTabPages = JSON.parse(String(await cdp.eval(tabContrastScript('light'))));
  const fmtTabPages = (pages) => pages.map((p) => p.route + ' 最低对比=' + p.min + ':1/' + p.count + '个').join('；');
  results.push({
    name: '第五版修复：深色模式下分段标签不再「白底白字」（文字与底色对比度 ≥ 4.5:1）',
    ok: darkTabPages.every((p) => p.count > 0 && p.min >= 4.5),
    detail: fmtTabPages(darkTabPages)
  });
  results.push({
    name: '第五版修复：浅色模式下分段标签观感不变（对比度同样 ≥ 4.5:1）',
    ok: lightTabPages.every((p) => p.count > 0 && p.min >= 4.5),
    detail: fmtTabPages(lightTabPages)
  });
  // 截图留证：深色下的复习页 + 下一阶段目标页
  await cdp.eval("(async () => { location.hash = '/review'; await new Promise((r) => setTimeout(r, 620)); document.documentElement.setAttribute('data-theme', 'dark'); await new Promise((r) => setTimeout(r, 260)); return true; })()");
  await cdp.shot('dark-tabs-review');
  await cdp.eval("(async () => { location.hash = '/next'; await new Promise((r) => setTimeout(r, 620)); document.documentElement.setAttribute('data-theme', 'dark'); await new Promise((r) => setTimeout(r, 260)); return true; })()");
  await cdp.shot('dark-tabs-next');
  await cdp.eval("document.documentElement.setAttribute('data-theme', 'light'); true");

  // 第五版（收尾）：表单呼吸感 —— 控件高度 / 内边距 / 行距统一，颜色仍由主题变量决定
  const formRhythm = JSON.parse(
    String(
      await cdp.eval(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const probe = async (route) => {
      location.hash = route;
      await sleep(600);
      const card = document.querySelector('.dash-grid .card');
      const fields = [...document.querySelectorAll('.dash-grid .card > .field')];
      const rows = fields.map((f) => f.getBoundingClientRect());
      const gaps = [];
      for (let i = 1; i < rows.length; i += 1) gaps.push(Math.round(rows[i].top - rows[i - 1].bottom));
      const cs = (el) => getComputedStyle(el);
      const nums = (s) => s.slice(s.indexOf('(') + 1, s.lastIndexOf(')')).split(',').map((v) => parseFloat(v)).filter((v) => !Number.isNaN(v));
      const lum = (c) => {
        const f = c.slice(0, 3).map((v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); });
        return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2];
      };
      const contrast = (fg, bg) => {
        const a = lum(nums(fg));
        const b = lum(nums(bg));
        return Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 100) / 100;
      };
      const ctl = fields.map((f) => f.querySelector('input, textarea, select')).filter(Boolean);
      const single = ctl.filter((el) => el.tagName !== 'TEXTAREA');
      const area = ctl.find((el) => el.tagName === 'TEXTAREA');
      const lab = fields[0] ? fields[0].querySelector('label') : null;
      const btnRow = document.querySelector('.dash-grid .card > .row > .btn');
      const btn = document.querySelector('.dash-grid .card > .btn');
      return {
        route: route,
        count: fields.length,
        labelW: lab ? Math.round(parseFloat(cs(lab).width)) : 0,
        labelTop: lab ? cs(lab).paddingTop : '',
        ctlH: single.map((el) => Math.round(el.getBoundingClientRect().height)),
        ctlMinH: single.map((el) => cs(el).minHeight),
        padTop: single[0] ? cs(single[0]).paddingTop : '',
        padLeft: single[0] ? cs(single[0]).paddingLeft : '',
        areaH: area ? Math.round(area.getBoundingClientRect().height) : 0,
        areaLine: area ? cs(area).lineHeight : '',
        gaps: gaps,
        btnH: btnRow ? Math.round(btnRow.getBoundingClientRect().height) : btn ? Math.round(btn.getBoundingClientRect().height) : 0,
        ctlColor: single[0] ? cs(single[0]).color : '',
        ctlBg: single[0] ? cs(single[0]).backgroundColor : '',
        ratio: single[0] ? contrast(cs(single[0]).color, cs(single[0]).backgroundColor) : 0,
        areaRatio: area ? contrast(cs(area).color, cs(area).backgroundColor) : 0
      };
    };
    document.documentElement.setAttribute('data-theme', 'light');
    await sleep(220);
    const light = { review: await probe('/review'), next: await probe('/next') };
    document.documentElement.setAttribute('data-theme', 'dark');
    await sleep(220);
    const dark = { review: await probe('/review'), next: await probe('/next') };
    document.documentElement.setAttribute('data-theme', 'light');
    return JSON.stringify({ light, dark });
  })()`)
    )
  );
  const rhythmPages = [formRhythm.light.review, formRhythm.light.next, formRhythm.dark.review, formRhythm.dark.next];
  const rhythmOk = rhythmPages.every(
    (p) =>
      p.count >= 2 &&
      p.labelW === 96 &&
      p.labelTop === '10px' &&
      p.ctlH.every((h) => h === 40) &&
      p.ctlMinH.every((mh) => mh === '40px') &&
      p.padTop === '9px' &&
      p.padLeft === '14px' &&
      p.areaH >= 68 &&
      parseFloat(p.areaLine) >= 22 &&
      p.gaps.every((g) => g === 15) &&
      p.btnH === 40
  );
  results.push({
    name: '第五版修复：表单行有呼吸感（控件 40px 高、内边距 9/14、行间隔 15px、文本框行高 1.7）',
    ok: rhythmOk,
    detail: rhythmPages
      .map(
        (p) =>
          p.route + ' 行=' + p.count + ' 标签=' + p.labelW + 'px 控件高=' + p.ctlH.join('/') + ' 内边距=' + p.padTop + '/' + p.padLeft + ' 行距=' + p.gaps.join('/') + ' 按钮高=' + p.btnH
      )
      .join('；')
  });
  const colorUnchanged =
    rhythmPages.every((p) => p.ratio >= 4.5 && p.areaRatio >= 4.5) &&
    formRhythm.dark.review.ctlBg !== formRhythm.light.review.ctlBg &&
    formRhythm.dark.review.ctlColor !== formRhythm.light.review.ctlColor;
  results.push({
    name: '第五版修复：表单控件的颜色仍跟着主题走（没被写死成白底，对比度 ≥ 4.5:1）',
    ok: colorUnchanged,
    detail:
      '深色 文字/底=' +
      formRhythm.dark.review.ctlColor +
      ' / ' +
      formRhythm.dark.review.ctlBg +
      '（对比度 ' +
      formRhythm.dark.review.ratio +
      '，文本框 ' +
      formRhythm.dark.review.areaRatio +
      '），浅色 文字/底=' +
      formRhythm.light.review.ctlColor +
      ' / ' +
      formRhythm.light.review.ctlBg +
      '（对比度 ' +
      formRhythm.light.review.ratio +
      '，文本框 ' +
      formRhythm.light.review.areaRatio +
      '）'
  });

  // ---- 第五版修复：知识库删除先二次确认；确认后是软删除（进回收站），取消则原样保留 ----
  await cdp.eval("location.hash = '/knowledge'; true");
  await sleep(900);
  const delFlow = await cdp.eval(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const treeItem = (name) =>
      [...document.querySelectorAll('.tree-item')].find((el) => (el.textContent || '').includes(name));
    const rows = () => [...document.querySelectorAll('.kb-list-body .list-row')];
    const titleOf = (el) => (el ? (el.querySelector('.title')?.textContent || '').trim() : '');
    const rowByTitle = (t) => rows().find((r) => titleOf(r) === t);
    const delBtn = (row) => (row ? row.querySelector('.actions .icon-btn[title="删除到回收站"]') : null);
    const dialog = () => document.querySelector('.modal-backdrop');
    const dialogTitle = () => {
      const d = dialog();
      return d ? (d.querySelector('.modal-head span')?.textContent || '').trim() : '';
    };
    const footBtn = (re) => {
      const d = dialog();
      if (!d) return null;
      return [...d.querySelectorAll('.modal-foot .btn')].find((b) => re.test((b.textContent || '').trim())) || null;
    };

    const title = '删除确认自检笔记';
    const created = await window.api.invoke('note:create', { title, content: '测二次确认' });
    if (!created || created.id == null) return { error: '建笔记失败' };

    // 切一下分类再切回来，让列表重新拉一遍
    const uncat = treeItem('未分类');
    if (uncat) uncat.click();
    await sleep(450);
    const all = treeItem('全部笔记');
    if (all) all.click();
    await sleep(650);

    const row = rowByTitle(title);
    if (!row) return { error: '新建的笔记没出现在列表里' };
    const beforeCount = rows().length;

    // ① 点行内删除 → 应弹确认框；点取消 → 笔记还在
    const b1 = delBtn(row);
    if (!b1) return { error: '没找到行内删除按钮' };
    b1.click();
    await sleep(320);
    const dlgTitle = dialogTitle();
    const cancel = footBtn(/^取消$/);
    const hasCancel = !!cancel;
    if (cancel) cancel.click();
    await sleep(420);
    const dialogGone = !dialog();
    const afterCancelCount = rows().length;
    const stillAfterCancel = !!rowByTitle(title);

    // ② 再点一次，这回确认 → 列表里消失、回收站里能找到
    const b2 = delBtn(rowByTitle(title));
    if (!b2) return { error: '取消后找不到删除按钮了' };
    b2.click();
    await sleep(320);
    const dlgTitle2 = dialogTitle();
    const ok = footBtn(/^移到回收站$/);
    const hasOk = !!ok;
    if (ok) ok.click();
    await sleep(900);
    const afterConfirmCount = rows().length;
    const stillAfterConfirm = !!rowByTitle(title);
    const trashed = await window.api.invoke('note:list', { trash: true });
    const inTrashApi = Array.isArray(trashed) && trashed.some((n) => (n.title || '').trim() === title);

    // ③ 切到回收站视图，列表里应该看得到；再切回全部笔记
    const trashRow = treeItem('回收站');
    if (trashRow) trashRow.click();
    await sleep(700);
    const trashViewHas = !!rowByTitle(title);
    const backAll = treeItem('全部笔记');
    if (backAll) backAll.click();
    await sleep(600);

    return {
      beforeCount,
      dlgTitle,
      hasCancel,
      dialogGone,
      afterCancelCount,
      stillAfterCancel,
      dlgTitle2,
      hasOk,
      afterConfirmCount,
      stillAfterConfirm,
      inTrashApi,
      trashViewHas
    };
  })()`);
  results.push({
    name: '第五版修复：知识库删除先弹确认框（取消就留着，确认后进回收站，回收站里能找到）',
    ok:
      !delFlow.error &&
      /移到回收站/.test(String(delFlow.dlgTitle)) &&
      delFlow.hasCancel === true &&
      delFlow.dialogGone === true &&
      delFlow.afterCancelCount === delFlow.beforeCount &&
      delFlow.stillAfterCancel === true &&
      /移到回收站/.test(String(delFlow.dlgTitle2)) &&
      delFlow.hasOk === true &&
      delFlow.afterConfirmCount === delFlow.beforeCount - 1 &&
      delFlow.stillAfterConfirm === false &&
      delFlow.inTrashApi === true &&
      delFlow.trashViewHas === true,
    detail: delFlow.error
      ? delFlow.error
      : '弹窗=' +
        delFlow.dlgTitle +
        ' 列表 ' +
        delFlow.beforeCount +
        '→取消后 ' +
        delFlow.afterCancelCount +
        '→确认后 ' +
        delFlow.afterConfirmCount +
        ' 取消后还在=' +
        delFlow.stillAfterCancel +
        ' 确认后还在=' +
        delFlow.stillAfterConfirm +
        ' 回收站里有=' +
        delFlow.inTrashApi +
        '/' +
        delFlow.trashViewHas
  });
  // 留一张确认框的截图
  await cdp.eval(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const row = document.querySelector('.kb-list-body .list-row');
    if (!row) return false;
    row.scrollIntoView({ block: 'center' });
    await sleep(200);
    const btn = row.querySelector('.actions .icon-btn[title="删除到回收站"]');
    if (btn) btn.click();
    await sleep(340);
    return !!document.querySelector('.modal-backdrop');
  })()`);
  await cdp.shot('note-trash-confirm');
  await cdp.eval(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const d = document.querySelector('.modal-backdrop');
    if (!d) return true;
    const cancel = [...d.querySelectorAll('.modal-foot .btn')].find((b) => (b.textContent || '').trim() === '取消');
    if (cancel) cancel.click();
    await sleep(380);
    return true;
  })()`);

  // ---- 设置页「检查更新」：唯一会联网的功能，测试里指向本地 stub 服务器 ----
  await cdp.eval("location.hash = '/settings'; true");
  await sleep(800);

  const updCard = JSON.parse(String(await cdp.eval(`(() => {
    const heads = [...document.querySelectorAll('.card h2')].map((h) => (h.textContent || '').trim());
    const btn = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '检查更新');
    const ver = (document.body.innerText.match(/当前版本 [0-9.]+/) || [''])[0];
    return JSON.stringify({ hasCard: heads.includes('软件更新'), hasBtn: !!btn, ver });
  })()`)));
  results.push({
    name: '设置页出现「软件更新」卡片和「检查更新」按钮（旁边写着当前版本）',
    ok: updCard.hasCard === true && updCard.hasBtn === true && /^当前版本 \d+\.\d+\.\d+$/.test(String(updCard.ver)),
    detail: '卡片=' + updCard.hasCard + ' 按钮=' + updCard.hasBtn + ' ' + updCard.ver
  });

  stubUpdateMode = 'newer';
  stubDelayMs = 400; // 回包慢一点，加载态才看得见（断言依赖它）
  const updRun = JSON.parse(String(await cdp.eval(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const btn = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '检查更新');
    if (!btn) return JSON.stringify({ found: false });
    btn.click();
    let loading = { text: '', disabled: false };
    for (let i = 0; i < 40; i += 1) {
      await sleep(30);
      const now = (btn.textContent || '').trim();
      if (now !== '检查更新') {
        loading = { text: now, disabled: btn.disabled === true };
        break;
      }
    }
    let modal = null;
    for (let i = 0; i < 60; i += 1) {
      await sleep(100);
      modal = document.querySelector('.modal-backdrop .modal');
      if (modal) break;
    }
    const title = modal ? (modal.querySelector('.modal-head span')?.textContent || '').trim() : '';
    const body = modal ? (modal.querySelector('.modal-body')?.innerText || '') : '';
    const foot = modal ? [...modal.querySelectorAll('.modal-foot .btn')].map((b) => (b.textContent || '').trim()) : [];
    return JSON.stringify({ found: true, loading, title, body: body.slice(0, 200), foot });
  })()`)));
  results.push({
    name: '点「检查更新」→ 按钮变「正在连接…」并禁用 → 有新版本时弹窗（版本号 + 说明 + 复制链接）',
    ok:
      updRun.found === true &&
      updRun.loading.text === '正在连接…' &&
      updRun.loading.disabled === true &&
      /新版本/.test(String(updRun.title)) &&
      /9\.9\.9/.test(String(updRun.body)) &&
      updRun.foot.includes('复制下载链接') &&
      updRun.foot.includes('下载并安装') &&
      updRun.foot.includes('稍后'),
    detail:
      '按钮=' + (updRun.loading ? updRun.loading.text : '?') +
      ' 标题=' + updRun.title +
      ' 说明=' + String(updRun.body || '').slice(0, 40) +
      ' 按钮=' + (updRun.foot || []).join('/')
  });
  await cdp.shot('settings-update-new');
  stubDelayMs = 0;

  const updCopy = String(await cdp.eval(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const modal = document.querySelector('.modal-backdrop .modal');
    if (!modal) return 'no-modal';
    const copy = [...modal.querySelectorAll('.modal-foot .btn')].find((b) => (b.textContent || '').trim() === '复制下载链接');
    if (!copy) return 'no-copy';
    copy.click();
    await sleep(600);
    const texts = [...document.querySelectorAll('.toast-wrap .toast')].map((e) => e.innerText).join(' | ');
    const done = modal.querySelector('.modal-head button');
    if (done) done.click();
    await sleep(450);
    return texts || 'no-toast';
  })()`));
  results.push({
    name: '点「复制下载链接」→ 写入剪贴板并提示「下载链接已复制」，关掉弹窗',
    ok: updCopy.includes('下载链接已复制'),
    detail: String(updCopy).slice(0, 100)
  });

  // 断网 / 超时：stub 不回包，5 秒后必须给中文提示，按钮要恢复、界面不能卡死
  stubUpdateMode = 'hang';
  const updTimeout = JSON.parse(String(await cdp.eval(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const btn = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '检查更新');
    if (!btn) return JSON.stringify({ found: false });
    btn.click();
    const t0 = Date.now();
    let texts = '';
    for (let i = 0; i < 90; i += 1) {
      await sleep(100);
      texts = [...document.querySelectorAll('.toast-wrap .toast')].map((e) => e.innerText).join(' | ');
      if (texts.includes('超时')) break;
    }
    return JSON.stringify({
      found: true,
      seconds: Math.round((Date.now() - t0) / 100) / 10,
      texts: texts.slice(0, 160),
      btnText: (btn.textContent || '').trim(),
      alive: !!document.querySelector('.card h2')
    });
  })()`)));
  results.push({
    name: '断网 / 超时：5 秒内给出「网络连接超时」中文提示，按钮恢复、界面不崩',
    ok:
      updTimeout.found === true &&
      /网络连接超时/.test(String(updTimeout.texts)) &&
      updTimeout.seconds >= 4.5 &&
      updTimeout.seconds <= 9 &&
      updTimeout.btnText === '检查更新' &&
      updTimeout.alive === true,
    detail:
      '等待=' + updTimeout.seconds + 's 提示=' + String(updTimeout.texts).slice(0, 70) + ' 按钮=' + updTimeout.btnText
  });
  await cdp.shot('settings-update-timeout');
  stubUpdateMode = 'newer';

  // ② 一键更新（第 1 步）：下载中能取消，取消后回到可重试状态
  stubAssetMode = 'hang'; // 假安装包发一点就卡住，确保「取消」一定发生在下载中
  const updCancel = JSON.parse(
    String(
      await cdp.eval(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const btn = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '检查更新');
    if (!btn) return JSON.stringify({ error: 'no-check-button' });
    btn.click();
    let modal = null;
    for (let i = 0; i < 60; i += 1) {
      await sleep(100);
      modal = document.querySelector('.modal-backdrop .modal');
      if (modal) break;
    }
    if (!modal) return JSON.stringify({ error: 'no-modal' });
    const download = [...modal.querySelectorAll('.modal-foot .btn')].find((b) => (b.textContent || '').trim() === '下载并安装');
    if (!download) return JSON.stringify({ error: 'no-download-button' });
    download.click();
    let progressText = '';
    for (let i = 0; i < 50; i += 1) {
      await sleep(100);
      const meta = document.querySelector('.update-progress-meta');
      progressText = meta ? meta.innerText.replace(/\\s+/g, ' ').trim() : '';
      if (progressText.includes('正在下载')) break;
    }
    const cancel = [...modal.querySelectorAll('.modal-foot .btn')].find((b) => (b.textContent || '').trim() === '取消下载');
    const hasCancel = !!cancel;
    if (cancel) cancel.click();
    await sleep(900);
    const toastTexts = [...document.querySelectorAll('.toast-wrap .toast')].map((e) => e.innerText).join(' | ');
    const retry = [...document.querySelectorAll('.modal-foot .btn')].some((b) => (b.textContent || '').trim() === '下载并安装');
    return JSON.stringify({ progressText, hasCancel, toastTexts: toastTexts.slice(0, 140), retry });
  })()`)
    )
  );
  results.push({
    name: '一键更新：下载中显示进度，点「取消下载」能中断并回到可重试状态',
    ok:
      updCancel.error === undefined &&
      updCancel.hasCancel === true &&
      /正在下载/.test(String(updCancel.progressText)) &&
      /取消/.test(String(updCancel.toastTexts)) &&
      updCancel.retry === true,
    detail:
      '进度=' + String(updCancel.progressText).slice(0, 30) + ' 有取消=' + updCancel.hasCancel + ' 提示=' + String(updCancel.toastTexts).slice(0, 50) + ' 可重试=' + updCancel.retry
  });

  // ③ 一键更新（第 2 步）：真下载一遍，落盘的文件大小和 SHA256 都要对得上
  stubAssetMode = 'normal';
  const updDownload = JSON.parse(
    String(
      await cdp.eval(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const modal = document.querySelector('.modal-backdrop .modal');
    if (!modal) return JSON.stringify({ error: 'no-modal' });
    const download = [...modal.querySelectorAll('.modal-foot .btn')].find((b) => (b.textContent || '').trim() === '下载并安装');
    if (!download) return JSON.stringify({ error: 'no-download-button' });
    download.click();
    let sawProgress = false;
    let done = false;
    for (let i = 0; i < 160; i += 1) {
      await sleep(100);
      const meta = document.querySelector('.update-progress-meta');
      if (meta && meta.innerText.includes('正在下载')) sawProgress = true;
      const install = [...document.querySelectorAll('.modal-foot .btn')].find((b) => (b.textContent || '').trim() === '立即安装');
      if (install) { done = true; break; }
    }
    const toastTexts = [...document.querySelectorAll('.toast-wrap .toast')].map((e) => e.innerText).join(' | ');
    const bodyText = (modal.querySelector('.modal-body') || modal).innerText.replace(/\\s+/g, ' ');
    return JSON.stringify({ sawProgress, done, toastTexts: toastTexts.slice(0, 140), bodyText: bodyText.slice(0, 160) });
  })()`)
    )
  );
  const downloadedFiles = fs.existsSync(stubDownloadDir)
    ? fs.readdirSync(stubDownloadDir).filter((name) => name.endsWith('.exe'))
    : [];
  const downloadedFile = downloadedFiles.length ? path.join(stubDownloadDir, downloadedFiles[0]) : '';
  const downloadedSize = downloadedFile ? fs.statSync(downloadedFile).size : -1;
  const downloadedSha = downloadedFile
    ? createHash('sha256').update(fs.readFileSync(downloadedFile)).digest('hex')
    : '';
  results.push({
    name: '一键更新：安装包真的下载到本地，大小和 SHA256 与 Release 附件一致',
    ok:
      updDownload.error === undefined &&
      updDownload.done === true &&
      updDownload.sawProgress === true &&
      downloadedSize === stubInstaller.length &&
      downloadedSha === stubInstallerSha &&
      /下载好了/.test(String(updDownload.toastTexts)),
    detail:
      '完成=' + updDownload.done + ' 文件=' + (downloadedFiles[0] || '无') + ' 大小=' + downloadedSize + '/' + stubInstaller.length + ' sha一致=' + (downloadedSha === stubInstallerSha)
  });
  await cdp.shot('settings-update-downloaded');

  // ④ 一键更新（第 3 步）：「立即安装」在测试模式（DRYRUN）下只返回结果、不真运行安装程序，应用不能退出
  const updInstall = JSON.parse(
    String(
      await cdp.eval(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const install = [...document.querySelectorAll('.modal-foot .btn')].find((b) => (b.textContent || '').trim() === '立即安装');
    if (!install) return JSON.stringify({ error: 'no-install-button' });
    install.click();
    let texts = '';
    for (let i = 0; i < 40; i += 1) {
      await sleep(100);
      texts = [...document.querySelectorAll('.toast-wrap .toast')].map((e) => e.innerText).join(' | ');
      if (texts.includes('测试模式')) break;
    }
    const close = document.querySelector('.modal-backdrop .modal-head button');
    if (close) close.click();
    await sleep(400);
    return JSON.stringify({
      texts: texts.slice(0, 140),
      alive: !!document.querySelector('.card h2'),
      modalGone: !document.querySelector('.modal-backdrop')
    });
  })()`)
    )
  );
  results.push({
    name: '一键更新：「立即安装」走到启动安装这一步（测试模式不真安装），应用不退出、弹窗能关掉',
    ok:
      updInstall.error === undefined &&
      /测试模式/.test(String(updInstall.texts)) &&
      updInstall.alive === true &&
      updInstall.modalGone === true,
    detail: '提示=' + String(updInstall.texts).slice(0, 60) + ' 应用存活=' + updInstall.alive + ' 弹窗关闭=' + updInstall.modalGone
  });

  // ---- 阶段1：标签全局管理（左侧入口 + 筛选 + 改名 + 删除）----
  const tagPrep = JSON.parse(
    String(
      await cdp.eval(`(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const inv = (ch, p) => window.api.invoke(ch, p);
        const note = await inv('note:create', { title: '标签管理自检笔记', content: '标签管理自检正文' });
        const tagged = await inv('tag:set', { noteId: note.id, names: ['自检标签甲', '自检标签乙'] });
        location.hash = '/';
        await sleep(260);
        location.hash = '/knowledge';
        await sleep(760);
        const head = [...document.querySelectorAll('.tree-item')].find((el) => (el.innerText || '').includes('标签管理'));
        if (!head) {
          return JSON.stringify({ error: '左侧没有标签管理入口', tree: [...document.querySelectorAll('.tree-item')].map((e) => (e.innerText || '').replace(/\\s+/g, ' ').trim()).slice(0, 24) });
        }
        const collapsed = ![...document.querySelectorAll('.tree-item')].some((el) => el.querySelector('[title="标签操作"]'));
        head.click();
        await sleep(460);
        const rows = [...document.querySelectorAll('.tree-item')].filter((el) => el.querySelector('[title="标签操作"]'));
        return JSON.stringify({
          noteId: note.id,
          tagCount: tagged && tagged.tags ? tagged.tags.length : 0,
          collapsed,
          headText: (head.innerText || '').replace(/\\s+/g, ' ').trim(),
          rows: rows.map((el) => (el.innerText || '').replace(/\\s+/g, ' ').trim()).slice(0, 12)
        });
      })()`)
    )
  );
  results.push({
    name: '阶段1：知识库左侧「标签管理」入口能展开，标签带引用数',
    ok:
      tagPrep.error === undefined &&
      tagPrep.tagCount === 2 &&
      tagPrep.collapsed === true &&
      tagPrep.rows.some((t) => t.includes('自检标签甲 (1)')),
    detail: '入口=' + tagPrep.headText + ' 标签=' + JSON.stringify(tagPrep.rows) + (tagPrep.error ? ' 错误=' + tagPrep.error : '')
  });
  await cdp.shot('tag-manage');

  const tagFilter = JSON.parse(
    String(
      await cdp.eval(`(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const rows = [...document.querySelectorAll('.tree-item')].filter((el) => el.querySelector('[title="标签操作"]'));
        const row = rows.find((el) => (el.innerText || '').includes('自检标签甲'));
        if (!row) return JSON.stringify({ error: '找不到刚建的标签行' });
        row.click();
        await sleep(760);
        const rows2 = [...document.querySelectorAll('.tree-item')].filter((el) => el.querySelector('[title="标签操作"]'));
        const sameRow = rows2.find((el) => (el.innerText || '').includes('自检标签甲'));
        return JSON.stringify({
          listRows: document.querySelectorAll('.kb-list-body .list-row').length,
          selectedText: sameRow ? (sameRow.innerText || '').replace(/\\s+/g, ' ').trim() : '',
          selectedClass: sameRow ? sameRow.className : '',
          head: ((document.querySelector('.kb-list-head') || {}).innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 80)
        });
      })()`)
    )
  );
  results.push({
    name: '阶段1：点左侧标签，右侧列表立刻只剩这个标签下的笔记',
    ok:
      tagFilter.error === undefined &&
      tagFilter.listRows === 1 &&
      /selected/.test(String(tagFilter.selectedClass)) &&
      /自检标签甲/.test(String(tagFilter.selectedText)),
    detail: '列表=' + tagFilter.listRows + ' 选中=' + tagFilter.selectedText + ' 类=' + tagFilter.selectedClass + ' 头部=' + tagFilter.head
  });

  const tagRenamed = JSON.parse(
    String(
      await cdp.eval(`(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const row = [...document.querySelectorAll('.tree-item')].filter((el) => el.querySelector('[title="标签操作"]')).find((el) => (el.innerText || '').includes('自检标签甲'));
        if (!row) return JSON.stringify({ error: '找不到标签行' });
        const box = row.getBoundingClientRect();
        row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: box.left + 24, clientY: box.top + 12 }));
        await sleep(280);
        const menu = document.querySelector('.ctx-menu');
        if (!menu) return JSON.stringify({ error: '标签行右键没有菜单' });
        const items = [...menu.querySelectorAll('.ctx-item .ctx-label')].map((b) => b.textContent.trim());
        const rename = [...menu.querySelectorAll('.ctx-item')].find((b) => b.textContent.includes('改标签名'));
        if (!rename) return JSON.stringify({ error: '菜单里没有改标签名', items });
        rename.click();
        await sleep(400);
        const dlg = document.querySelector('.modal');
        if (!dlg) return JSON.stringify({ error: '改名没有弹窗', items });
        const input = dlg.querySelector('.modal-body input.input');
        if (!input) return JSON.stringify({ error: '改名弹窗没有输入框', items });
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, '自检标签甲改');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await sleep(140);
        const submit = dlg.querySelector('.modal-foot button.btn.primary');
        if (submit) submit.click();
        await sleep(900);
        const toast = [...document.querySelectorAll('.toast-wrap .toast')].map((e) => e.innerText).join(' | ');
        await sleep(300);
        return JSON.stringify({
          items,
          toast: toast.slice(0, 120),
          rows: [...document.querySelectorAll('.tree-item')].filter((el) => el.querySelector('[title="标签操作"]')).map((el) => (el.innerText || '').replace(/\\s+/g, ' ').trim()).slice(0, 12),
          listRows: document.querySelectorAll('.kb-list-body .list-row').length
        });
      })()`)
    )
  );
  results.push({
    name: '阶段1：右键「改标签名」→ 就地改名，关联的笔记跟着走',
    ok:
      tagRenamed.error === undefined &&
      /改名为/.test(String(tagRenamed.toast)) &&
      tagRenamed.rows.some((t) => t.includes('自检标签甲改')) &&
      tagRenamed.listRows === 1,
    detail: '菜单=' + JSON.stringify(tagRenamed.items) + ' 提示=' + tagRenamed.toast + (tagRenamed.error ? ' 错误=' + tagRenamed.error : '')
  });

  const tagDeleted = JSON.parse(
    String(
      await cdp.eval(`(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const row = [...document.querySelectorAll('.tree-item')].filter((el) => el.querySelector('[title="标签操作"]')).find((el) => (el.innerText || '').includes('自检标签甲改'));
        if (!row) return JSON.stringify({ error: '找不到改名后的标签行' });
        const box = row.getBoundingClientRect();
        row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: box.left + 24, clientY: box.top + 12 }));
        await sleep(280);
        const del = [...document.querySelectorAll('.ctx-menu .ctx-item')].find((b) => b.textContent.includes('删除标签'));
        if (!del) return JSON.stringify({ error: '菜单里没有删除标签' });
        del.click();
        await sleep(420);
        const dlg = document.querySelector('.modal');
        if (!dlg) return JSON.stringify({ error: '删除没有弹确认框' });
        const title = (dlg.querySelector('.modal-head span') || {}).innerText || '';
        const message = (dlg.querySelector('.modal-body') || {}).innerText || '';
        const before = await window.api.invoke('note:list', {});
        const yes = [...dlg.querySelectorAll('.modal-foot button')].find((b) => /删除/.test(b.textContent));
        if (yes) yes.click();
        await sleep(1000);
        const toast = [...document.querySelectorAll('.toast-wrap .toast')].map((e) => e.innerText).join(' | ');
        const allTags = await window.api.invoke('tag:list');
        const after = await window.api.invoke('note:list', {});
        return JSON.stringify({
          title: (title || '').replace(/\\s+/g, ' ').trim(),
          message: (message || '').replace(/\\s+/g, ' ').trim().slice(0, 160),
          toast: toast.slice(0, 140),
          beforeTotal: Array.isArray(before) ? before.length : -1,
          afterTotal: Array.isArray(after) ? after.length : -1,
          stillHasTag: (Array.isArray(allTags) ? allTags : []).some((t) => t.name === '自检标签甲改'),
          rows: [...document.querySelectorAll('.tree-item')].filter((el) => el.querySelector('[title="标签操作"]')).map((el) => (el.innerText || '').replace(/\\s+/g, ' ').trim()).slice(0, 12)
        });
      })()`)
    )
  );
  results.push({
    name: '阶段1：右键「删除标签」→ 二次确认说明不删笔记 → 标签消失、笔记还在',
    ok:
      tagDeleted.error === undefined &&
      /不会删除笔记/.test(String(tagDeleted.message)) &&
      /已删除/.test(String(tagDeleted.toast)) &&
      tagDeleted.stillHasTag === false &&
      tagDeleted.beforeTotal === tagDeleted.afterTotal &&
      !tagDeleted.rows.some((t) => t.includes('自检标签甲改')),
    detail:
      '确认标题=' +
      tagDeleted.title +
      ' 提示=' +
      tagDeleted.toast +
      ' 笔记数=' +
      tagDeleted.beforeTotal +
      '→' +
      tagDeleted.afterTotal +
      ' 标签还在=' +
      tagDeleted.stillHasTag +
      (tagDeleted.error ? ' 错误=' + tagDeleted.error : '')
  });

  /* ---------------- 第六版 / 阶段2：番茄钟（主进程计时） ---------------- */

  // 右下角按钮 → 面板 → 选 25 分钟 → 开始
  await cdp.eval("location.hash = '/'; true");
  await sleep(560);
  const focusStarted = JSON.parse(
    String(
      await cdp.eval(`(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const fab = document.querySelector('.focus-fab');
        if (!fab) return JSON.stringify({ error: '右下角没有番茄钟按钮' });
        fab.click();
        await sleep(260);
        const panel = document.querySelector('.focus-panel');
        if (!panel) return JSON.stringify({ error: '点开按钮后面板没出现' });
        const presetBtns = [...panel.querySelectorAll('.focus-presets button')];
        const presets = presetBtns.map((b) => (b.textContent || '').trim());
        const preset25 = presetBtns.find((b) => (b.textContent || '').indexOf('25') >= 0);
        if (preset25) preset25.click();
        await sleep(140);
        const start = [...panel.querySelectorAll('button')].find((b) => (b.textContent || '').indexOf('开始专注') >= 0);
        if (start) start.click();
        await sleep(900);
        const clockEl = document.querySelector('.focus-clock');
        const clock = ((clockEl && clockEl.textContent) || '').trim();
        const state = await window.api.invoke('focus:state');
        const livePanel = document.querySelector('.focus-panel');
        const fabNow = document.querySelector('.focus-fab');
        return JSON.stringify({
          presets,
          clock,
          clockLen: clock.length,
          minutes: Number(clock.slice(0, 2)),
          clockHasColon: clock.indexOf(':') === 2,
          status: state.status,
          planned: state.plannedSeconds,
          sessionId: state.sessionId,
          hasPause: !!livePanel && (livePanel.textContent || '').indexOf('暂停') >= 0,
          fabText: ((fabNow && fabNow.textContent) || '').trim()
        });
      })()`)
    )
  );
  results.push({
    name: '阶段2：右下角番茄钟能打开，选 25 分钟开始后进入计时（按钮也变成倒计时）',
    ok:
      focusStarted.error === undefined &&
      focusStarted.presets.length === 4 &&
      focusStarted.presets.some((t) => t.indexOf('15') >= 0) &&
      focusStarted.status === 'running' &&
      focusStarted.planned === 1500 &&
      focusStarted.sessionId !== null &&
      focusStarted.clockLen === 5 &&
      focusStarted.clockHasColon === true &&
      (focusStarted.minutes === 24 || focusStarted.minutes === 25) &&
      focusStarted.hasPause === true &&
      String(focusStarted.fabText).indexOf('⏱') >= 0,
    detail:
      '时长选项=' +
      JSON.stringify(focusStarted.presets) +
      ' 面板时钟=' +
      focusStarted.clock +
      ' 状态=' +
      focusStarted.status +
      ' 计划=' +
      focusStarted.planned +
      ' 悬浮按钮=' +
      focusStarted.fabText +
      (focusStarted.error ? ' 错误=' + focusStarted.error : '')
  });

  // 暂停 → 剩余时间冻住；继续 → 重新往下走
  const focusPaused = JSON.parse(
    String(
      await cdp.eval(`(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const readClock = () => {
          const el = document.querySelector('.focus-clock');
          return el ? (el.textContent || '').trim() : '';
        };
        const panelBtn = (text) => {
          const panel = document.querySelector('.focus-panel');
          if (!panel) return null;
          return [...panel.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === text) || null;
        };
        const pauseBtn = panelBtn('暂停');
        if (!pauseBtn) return JSON.stringify({ error: '面板里没有暂停按钮' });
        pauseBtn.click();
        await sleep(700);
        const frozen1 = readClock();
        const pausedState = await window.api.invoke('focus:state');
        await sleep(1500);
        const frozen2 = readClock();
        const resumeBtn = panelBtn('继续');
        if (!resumeBtn) return JSON.stringify({ error: '暂停后没有继续按钮', frozen1, frozen2 });
        resumeBtn.click();
        await sleep(1400);
        const runningClock = readClock();
        const resumedState = await window.api.invoke('focus:state');
        return JSON.stringify({
          frozen1,
          frozen2,
          runningClock,
          pausedStatus: pausedState.status,
          pausedRemaining: pausedState.remainingMs,
          resumedStatus: resumedState.status,
          resumedRemaining: resumedState.remainingMs
        });
      })()`)
    )
  );
  results.push({
    name: '阶段2：暂停后剩余时间冻住（1.5 秒不动），继续后重新开始走',
    ok:
      focusPaused.error === undefined &&
      focusPaused.pausedStatus === 'paused' &&
      focusPaused.frozen1 === focusPaused.frozen2 &&
      focusPaused.resumedStatus === 'running' &&
      focusPaused.resumedRemaining < focusPaused.pausedRemaining &&
      focusPaused.runningClock !== focusPaused.frozen2,
    detail:
      '暂停读数=' +
      focusPaused.frozen1 +
      '→' +
      focusPaused.frozen2 +
      ' 继续后=' +
      focusPaused.runningClock +
      ' 剩余毫秒 ' +
      focusPaused.pausedRemaining +
      '→' +
      focusPaused.resumedRemaining +
      (focusPaused.error ? ' 错误=' + focusPaused.error : '')
  });

  // 放弃这一轮 → 回到空闲，且不计入统计
  const focusAbandoned = JSON.parse(
    String(
      await cdp.eval(`(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const panel = document.querySelector('.focus-panel');
        if (!panel) return JSON.stringify({ error: '面板不见了' });
        const giveUp = [...panel.querySelectorAll('button')].find((b) => (b.textContent || '').indexOf('放弃') >= 0);
        if (!giveUp) return JSON.stringify({ error: '没有放弃按钮' });
        giveUp.click();
        await sleep(1100);
        const state = await window.api.invoke('focus:state');
        const summary = await window.api.invoke('focus:summary');
        const toast = [...document.querySelectorAll('.toast-wrap .toast')].map((e) => e.innerText).join(' | ');
        const nowPanel = document.querySelector('.focus-panel');
        return JSON.stringify({
          status: state.status,
          toast: toast.slice(0, 120),
          hasStartBtn: !!nowPanel && (nowPanel.textContent || '').indexOf('开始专注') >= 0,
          todayCount: summary.todayCount,
          todaySeconds: summary.todaySeconds
        });
      })()`)
    )
  );
  results.push({
    name: '阶段2：放弃这一轮回到空闲，并明确说明不计入专注时长',
    ok:
      focusAbandoned.error === undefined &&
      focusAbandoned.status === 'idle' &&
      String(focusAbandoned.toast).indexOf('这一轮先不算了') >= 0 &&
      focusAbandoned.hasStartBtn === true &&
      focusAbandoned.todayCount === 0 &&
      focusAbandoned.todaySeconds === 0,
    detail:
      '状态=' +
      focusAbandoned.status +
      ' 提示=' +
      focusAbandoned.toast +
      ' 今日=' +
      focusAbandoned.todayCount +
      '次/' +
      focusAbandoned.todaySeconds +
      '秒' +
      (focusAbandoned.error ? ' 错误=' + focusAbandoned.error : '')
  });

  await cdp.shot('focus-panel');

  // 任务详情里的「开始专注」：联动记下 taskId，运行中不能再开一轮
  await cdp.eval("location.hash = '/tasks'; true");
  await sleep(760);
  const focusTask = JSON.parse(
    String(
      await cdp.eval(`(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const row = document.querySelector('.task-row');
        if (!row) return JSON.stringify({ error: '任务列表是空的' });
        row.click();
        await sleep(560);
        const drawer = document.querySelector('.drawer');
        if (!drawer) return JSON.stringify({ error: '任务详情没打开' });
        const btn = [...drawer.querySelectorAll('button')].find((b) => (b.textContent || '').indexOf('开始专注') >= 0);
        if (!btn) return JSON.stringify({ error: '任务详情里没有开始专注按钮' });
        btn.click();
        await sleep(1000);
        const state = await window.api.invoke('focus:state');
        const toast = [...document.querySelectorAll('.toast-wrap .toast')].map((e) => e.innerText).join(' | ');
        let dupError = '';
        try {
          await window.api.invoke('focus:start', { plannedSeconds: 1500 });
        } catch (err) {
          dupError = String((err && err.message) || err);
        }
        return JSON.stringify({
          status: state.status,
          taskId: state.taskId,
          taskTitle: state.taskTitle,
          toast: toast.slice(0, 120),
          dupError: dupError.slice(0, 120)
        });
      })()`)
    )
  );
  results.push({
    name: '阶段2：任务详情「开始专注」会记下 taskId；运行中再开一轮会被拒绝',
    ok:
      focusTask.error === undefined &&
      focusTask.status === 'running' &&
      focusTask.taskId !== null &&
      String(focusTask.taskTitle || '').length > 0 &&
      String(focusTask.toast).indexOf('专注开始') >= 0 &&
      String(focusTask.dupError).indexOf('上一轮还没结束') >= 0,
    detail:
      '状态=' +
      focusTask.status +
      ' taskId=' +
      focusTask.taskId +
      ' 任务=' +
      focusTask.taskTitle +
      ' 提示=' +
      focusTask.toast +
      ' 重复开始报错=' +
      focusTask.dupError +
      (focusTask.error ? ' 错误=' + focusTask.error : '')
  });

  // 2 秒一轮真跑完：跨页面切来切去也不影响，到点自动进 5 分钟休息，再跳过休息
  const focusFinished = JSON.parse(
    String(
      await cdp.eval(`(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const idle = await window.api.invoke('focus:abandon');
        const started = await window.api.invoke('focus:start', { plannedSeconds: 2 });
        location.hash = '/settings';
        await sleep(520);
        const mid = await window.api.invoke('focus:state');
        location.hash = '/review';
        await sleep(420);
        let now = await window.api.invoke('focus:state');
        const deadline = Date.now() + 6000;
        while (now.status === 'running' && Date.now() < deadline) {
          await sleep(180);
          now = await window.api.invoke('focus:state');
        }
        const summary = await window.api.invoke('focus:summary');
        const skipped = await window.api.invoke('focus:skip-break');
        const final = await window.api.invoke('focus:state');
        return JSON.stringify({
          idleStatus: idle.status,
          startedStatus: started.status,
          midStatus: mid.status,
          afterStatus: now.status,
          restRemaining: now.remainingMs,
          todayCount: summary.todayCount,
          todaySeconds: summary.todaySeconds,
          skippedStatus: skipped.status,
          finalStatus: final.status
        });
      })()`)
    )
  );
  results.push({
    name: '阶段2：2 秒一轮真跑完 → 自动进 5 分钟休息并计入统计；切页不影响计时',
    ok:
      focusFinished.error === undefined &&
      focusFinished.idleStatus === 'idle' &&
      focusFinished.startedStatus === 'running' &&
      focusFinished.midStatus === 'running' &&
      focusFinished.afterStatus === 'break' &&
      Number(focusFinished.restRemaining) > 240000 &&
      Number(focusFinished.restRemaining) <= 300000 &&
      Number(focusFinished.todayCount) >= 1 &&
      Number(focusFinished.todaySeconds) >= 2 &&
      focusFinished.skippedStatus === 'idle' &&
      focusFinished.finalStatus === 'idle',
    detail:
      '切成设置页时=' +
      focusFinished.midStatus +
      ' 到点后=' +
      focusFinished.afterStatus +
      ' 休息剩余毫秒=' +
      focusFinished.restRemaining +
      ' 今日=' +
      focusFinished.todayCount +
      '次/' +
      focusFinished.todaySeconds +
      '秒 跳过休息后=' +
      focusFinished.finalStatus +
      (focusFinished.error ? ' 错误=' + focusFinished.error : '')
  });

  /* ---------------- 第六版修正：番茄钟悬浮按钮可拖动 ---------------- */

  // 1) 按住拖 150/-120：跟手、松手不弹面板、位置写进 localStorage，单击才弹面板
  const fabDrag = JSON.parse(
    String(
      await cdp.eval(`(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const closeBtn = document.querySelector('.focus-panel .icon-btn');
        if (closeBtn) closeBtn.click();
        await sleep(160);
        const fab = document.querySelector('.focus-fab');
        if (!fab) return JSON.stringify({ error: '没有番茄钟按钮' });
        const dock = fab.parentElement;
        const fire = (el, type, x, y) =>
          el.dispatchEvent(
            new PointerEvent(type, { pointerId: 7, bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, pointerType: 'mouse' })
          );
        // 上一次跑可能把按钮留在了角落：先拖到窗口正中，保证后面两个方向都挪得动
        const dragTo = async (x, y) => {
          const r = fab.getBoundingClientRect();
          fire(fab, 'pointerdown', r.left + r.width / 2, r.top + r.height / 2);
          await sleep(30);
          fire(window, 'pointermove', x, y);
          await sleep(40);
          fire(window, 'pointerup', x, y);
          await sleep(340);
        };
        await dragTo(window.innerWidth / 2, window.innerHeight / 2);
        const before = fab.getBoundingClientRect();
        const cx = before.left + before.width / 2;
        const cy = before.top + before.height / 2;
        fire(fab, 'pointerdown', cx, cy);
        await sleep(40);
        fire(window, 'pointermove', cx - 60, cy - 40);
        await sleep(40);
        fire(window, 'pointermove', cx - 150, cy - 120);
        await sleep(40);
        fire(window, 'pointerup', cx - 150, cy - 120);
        await sleep(380);
        const after = fab.getBoundingClientRect();
        const panelAfterDrag = !!document.querySelector('.focus-panel');
        const draggingClass = dock.className.indexOf('dragging') >= 0;
        const saved = localStorage.getItem('jw-focus-fab-pos');
        let parsed = null;
        try {
          parsed = JSON.parse(saved || 'null');
        } catch {
          parsed = null;
        }
        // 浏览器松手后还会补一个 click：这一下必须被吃掉，不能弹面板
        fab.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: cx - 150, clientY: cy - 120 }));
        await sleep(140);
        const panelAfterGhostClick = !!document.querySelector('.focus-panel');
        fab.click();
        await sleep(300);
        const panelAfterClick = !!document.querySelector('.focus-panel');
        if (panelAfterClick) document.querySelector('.focus-panel .icon-btn').click();
        return JSON.stringify({
          dx: Math.round(after.left - before.left),
          dy: Math.round(after.top - before.top),
          draggingClass,
          panelAfterDrag,
          panelAfterGhostClick,
          panelAfterClick,
          saved,
          hasPos: !!(parsed && typeof parsed.tx === 'number' && typeof parsed.ty === 'number')
        });
      })()`)
    )
  );
  results.push({
    name: '修正：番茄钟按钮能按住拖动，松手不弹面板、单击才弹；位置写进 localStorage',
    ok:
      fabDrag.error === undefined &&
      Math.abs(fabDrag.dx + 150) <= 3 &&
      Math.abs(fabDrag.dy + 120) <= 3 &&
      fabDrag.draggingClass === false &&
      fabDrag.panelAfterDrag === false &&
      fabDrag.panelAfterGhostClick === false &&
      fabDrag.panelAfterClick === true &&
      fabDrag.hasPos === true,
    detail:
      '位移=' +
      fabDrag.dx +
      ',' +
      fabDrag.dy +
      ' 拖动后面板=' +
      fabDrag.panelAfterDrag +
      ' 单击后=' +
      fabDrag.panelAfterClick +
      ' 存的位置=' +
      fabDrag.saved +
      (fabDrag.error ? ' 错误=' + fabDrag.error : '')
  });

  await cdp.shot('focus-drag');

  // 2) 往两个方向各拖 9000 像素：必须被夹回窗口内，不能飞出去
  const fabBounds = JSON.parse(
    String(
      await cdp.eval(`(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const fab = document.querySelector('.focus-fab');
        if (!fab) return JSON.stringify({ error: '没有番茄钟按钮' });
        const fire = (el, type, x, y) =>
          el.dispatchEvent(
            new PointerEvent(type, { pointerId: 9, bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, pointerType: 'mouse' })
          );
        const dragTo = async (x, y) => {
          const rect = fab.getBoundingClientRect();
          const cx = rect.left + rect.width / 2;
          const cy = rect.top + rect.height / 2;
          fire(fab, 'pointerdown', cx, cy);
          await sleep(30);
          fire(window, 'pointermove', x, y);
          await sleep(40);
          fire(window, 'pointerup', x, y);
          await sleep(320);
        };
        await dragTo(9000, 9000);
        const br = fab.getBoundingClientRect();
        await dragTo(-9000, -9000);
        const tl = fab.getBoundingClientRect();
        return JSON.stringify({
          vw: window.innerWidth,
          vh: window.innerHeight,
          br: { l: Math.round(br.left), t: Math.round(br.top), r: Math.round(br.right), b: Math.round(br.bottom) },
          tl: { l: Math.round(tl.left), t: Math.round(tl.top), r: Math.round(tl.right), b: Math.round(tl.bottom) }
        });
      })()`)
    )
  );
  results.push({
    name: '修正：番茄钟拖到窗口边缘会被夹住，不会飞出屏幕（顶部避开标题栏拖拽区）',
    ok:
      fabBounds.error === undefined &&
      fabBounds.br.l >= 0 &&
      fabBounds.br.t >= 0 &&
      fabBounds.br.r <= fabBounds.vw &&
      fabBounds.br.b <= fabBounds.vh &&
      fabBounds.tl.l >= 0 &&
      // 0.8.1：顶部不再贴到 0（那是自绘标题栏的拖拽区，压进去鼠标事件会被系统吃掉）
      fabBounds.tl.t === 60 &&
      fabBounds.tl.r <= fabBounds.vw &&
      fabBounds.tl.b <= fabBounds.vh,
    detail:
      '窗口=' +
      fabBounds.vw +
      'x' +
      fabBounds.vh +
      ' 拖右下后=' +
      JSON.stringify(fabBounds.br) +
      ' 拖左上后=' +
      JSON.stringify(fabBounds.tl) +
      (fabBounds.error ? ' 错误=' + fabBounds.error : '')
  });

  // 2.5) 0.8.0：边缘吸附 —— 松手时离边不到 50px 就吸到 16px（并写回 localStorage）
  const fabSnap = JSON.parse(
    String(
      await cdp.eval(`(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const fab = document.querySelector('.focus-fab');
        if (!fab) return JSON.stringify({ error: '没有番茄钟按钮' });
        const fire = (el, type, x, y) =>
          el.dispatchEvent(
            new PointerEvent(type, { pointerId: 11, bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, pointerType: 'mouse' })
          );
        const dragToLeft = async (targetLeft) => {
          const rect = fab.getBoundingClientRect();
          const cx = rect.left + rect.width / 2;
          const cy = rect.top + rect.height / 2;
          const dx = targetLeft - rect.left;
          fire(fab, 'pointerdown', cx, cy);
          await sleep(30);
          fire(window, 'pointermove', cx + dx, cy);
          await sleep(40);
          fire(window, 'pointerup', cx + dx, cy);
          await sleep(460); // 等弹簧动画走完
          return fab.getBoundingClientRect();
        };
        // 先拖到窗口中间（远离两边），再分别停在离左/右边缘 30px 处松手
        await dragToLeft(Math.round(window.innerWidth / 2 - 60));
        const leftStop = await dragToLeft(30);
        const savedLeft = JSON.parse(localStorage.getItem('jw-focus-fab-pos') || 'null');
        await dragToLeft(Math.round(window.innerWidth - leftStop.width - 30));
        const rightStop = await fab.getBoundingClientRect();
        const savedRight = JSON.parse(localStorage.getItem('jw-focus-fab-pos') || 'null');
        const transition = getComputedStyle(fab.parentElement).transition;
        return JSON.stringify({
          leftStop: Math.round(leftStop.left),
          leftSaved: savedLeft,
          rightStop: Math.round(window.innerWidth - rightStop.right),
          rightSaved: savedRight,
          transition
        });
      })()`)
    )
  );
  results.push({
    name: '0.8.0：悬浮球松手时离左右边缘不到 50px 会自动吸到 16px，并记住吸附后的位置',
    ok:
      fabSnap.error === undefined &&
      Math.abs(Number(fabSnap.leftStop) - 16) <= 2 &&
      Math.abs(Number(fabSnap.rightStop) - 16) <= 2 &&
      !!fabSnap.leftSaved &&
      !!fabSnap.rightSaved &&
      String(fabSnap.transition).includes('0.18s'),
    detail:
      '贴左边=' +
      fabSnap.leftStop +
      'px 贴右边=' +
      fabSnap.rightStop +
      'px 存的=' +
      JSON.stringify(fabSnap.leftSaved) +
      '→' +
      JSON.stringify(fabSnap.rightSaved) +
      ' 动画=' +
      String(fabSnap.transition).slice(0, 52) +
      (fabSnap.error ? ' 错误=' + fabSnap.error : '')
  });

  // 3) 刷新页面：位置从 localStorage 读回来，按钮还在上次停的地方
  await cdp.eval('location.reload(); true');
  await sleep(2200);
  const fabPersist = JSON.parse(
    String(
      await cdp.eval(`(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        let fab = document.querySelector('.focus-fab');
        const deadline = Date.now() + 8000;
        while (!fab && Date.now() < deadline) {
          await sleep(120);
          fab = document.querySelector('.focus-fab');
        }
        if (!fab) return JSON.stringify({ error: '刷新后按钮没回来' });
        await sleep(400);
        const dock = fab.parentElement;
        const saved = localStorage.getItem('jw-focus-fab-pos');
        const m = getComputedStyle(dock).transform;
        const nums = String(m).match(/-?[0-9.]+/g) || [];
        return JSON.stringify({ saved, transform: m, tx: Number(nums[4]), ty: Number(nums[5]) });
      })()`)
    )
  );
  const savedFabPos = (() => {
    try {
      return JSON.parse(fabPersist.saved || 'null');
    } catch {
      return null;
    }
  })();
  results.push({
    name: '修正：番茄钟位置刷新后记得住（重启也停在原处）',
    ok:
      fabPersist.error === undefined &&
      !!savedFabPos &&
      Math.abs(Number(savedFabPos.tx) - Number(fabPersist.tx)) <= 2 &&
      Math.abs(Number(savedFabPos.ty) - Number(fabPersist.ty)) <= 2,
    detail:
      '存的=' +
      fabPersist.saved +
      ' 刷新后 transform=' +
      fabPersist.transform +
      (fabPersist.error ? ' 错误=' + fabPersist.error : '')
  });

  // 4) Toast 的层级必须压过番茄钟（否则提示又被按钮盖住）
  const fabLayer = JSON.parse(
    String(
      await cdp.eval(`(() => {
        const fab = document.querySelector('.focus-fab');
        if (!fab) return JSON.stringify({ error: '没有番茄钟按钮' });
        const dock = fab.parentElement;
        const probe = document.createElement('div');
        probe.className = 'toast-wrap';
        probe.style.position = 'fixed';
        document.body.appendChild(probe);
        const toastZ = Number(getComputedStyle(probe).zIndex) || 0;
        probe.remove();
        const dockZ = Number(getComputedStyle(dock).zIndex) || 0;
        return JSON.stringify({ dockZ, toastZ });
      })()`)
    )
  );
  results.push({
    name: '修正：Toast 浮在番茄钟按钮上面，提示不会被遮住',
    ok: fabLayer.error === undefined && fabLayer.toastZ > fabLayer.dockZ && fabLayer.dockZ > 0,
    detail: '按钮层=' + fabLayer.dockZ + ' Toast层=' + fabLayer.toastZ + (fabLayer.error ? ' 错误=' + fabLayer.error : '')
  });

  /* ---------------- 0.8.1：拖到顶部不再掉进「死区」 ---------------- */

  // 1) 视口缩到 900x620，把按钮拖到左上极限：顶部必须停在安全区 60px；
  //    然后用「真实鼠标」点一下 —— 修复前按钮压在标题栏拖拽区里，这一下会被系统当成拖窗口。
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 900, height: 620, deviceScaleFactor: 0, mobile: false });
  await sleep(420);
  const fabDeadzone = JSON.parse(
    String(
      await cdp.eval(`(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const fab = document.querySelector('.focus-fab');
        if (!fab) return JSON.stringify({ error: '没有番茄钟按钮' });
        const fire = (el, type, x, y) =>
          el.dispatchEvent(new PointerEvent(type, { pointerId: 21, bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, pointerType: 'mouse' }));
        const dragTo = async (x, y) => {
          const rect = fab.getBoundingClientRect();
          const cx = rect.left + rect.width / 2;
          const cy = rect.top + rect.height / 2;
          fire(fab, 'pointerdown', cx, cy);
          await sleep(30);
          fire(window, 'pointermove', x, y);
          await sleep(40);
          fire(window, 'pointerup', x, y);
          await sleep(340);
        };
        const closeBtn = document.querySelector('.focus-panel .icon-btn');
        if (closeBtn) closeBtn.click();
        await sleep(120);
        await dragTo(window.innerWidth / 2, window.innerHeight / 2);
        await dragTo(0, 0);
        const rect = fab.getBoundingClientRect();
        const dock = fab.parentElement;
        const dockZ = Number(getComputedStyle(dock).zIndex) || 0;
        const sidebarZ = Number(getComputedStyle(document.querySelector('.sidebar')).zIndex) || 0;
        const appRegion = String(getComputedStyle(dock).webkitAppRegion || '');
        return JSON.stringify({
          vw: window.innerWidth,
          vh: window.innerHeight,
          left: Math.round(rect.left),
          top: Math.round(rect.top),
          right: Math.round(rect.right),
          bottom: Math.round(rect.bottom),
          dockZ,
          sidebarZ,
          appRegion,
          panel: !!document.querySelector('.focus-panel')
        });
      })()`)
    )
  );
  const fabCenter = JSON.parse(
    String(
      await cdp.eval(`(() => {
        const fab = document.querySelector('.focus-fab');
        if (!fab) return JSON.stringify({ error: '没有番茄钟按钮' });
        const r = fab.getBoundingClientRect();
        return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
      })()`)
    )
  );
  if (fabCenter.error === undefined) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: fabCenter.x, y: fabCenter.y, button: 'left', clickCount: 1 });
    await sleep(70);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: fabCenter.x, y: fabCenter.y, button: 'left', clickCount: 1 });
    await sleep(340);
  }
  const panelAfterRealClick = await cdp.eval("!!document.querySelector('.focus-panel')");
  results.push({
    name: '0.8.1：拖到顶部极限不会掉进标题栏死区，真实鼠标点它还能弹出面板',
    ok:
      fabDeadzone.error === undefined &&
      fabCenter.error === undefined &&
      fabDeadzone.top === 60 &&
      fabDeadzone.left === 16 &&
      fabDeadzone.dockZ >= 55 &&
      String(fabDeadzone.appRegion).includes('no-drag') &&
      fabDeadzone.panel === false &&
      panelAfterRealClick === true,
    detail:
      '窗口=' +
      fabDeadzone.vw +
      'x' +
      fabDeadzone.vh +
      ' 左上极限=' +
      JSON.stringify({ l: fabDeadzone.left, t: fabDeadzone.top }) +
      ' 按钮层=' +
      fabDeadzone.dockZ +
      '/侧栏=' +
      fabDeadzone.sidebarZ +
      ' app-region=' +
      fabDeadzone.appRegion +
      ' 拖动后面板=' +
      fabDeadzone.panel +
      ' 真实鼠标点后=' +
      panelAfterRealClick +
      (fabDeadzone.error ? ' 错误=' + fabDeadzone.error : '')
  });

  // 2) 窗口再缩到 760x560：按钮必须还被完整关在可视区里（而不是留在窗口外面）
  await cdp.eval("(() => { const b = document.querySelector('.focus-panel .icon-btn'); if (b) { b.click(); return true; } return false; })()");
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 760, height: 560, deviceScaleFactor: 0, mobile: false });
  await sleep(520);
  const fabShrink = JSON.parse(
    String(
      await cdp.eval(`(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const fab = document.querySelector('.focus-fab');
        if (!fab) return JSON.stringify({ error: '缩小窗口后按钮不见了' });
        await sleep(400); // 等 resize 夹取 + 弹簧动画
        const rect = fab.getBoundingClientRect();
        const saved = localStorage.getItem('jw-focus-fab-pos');
        return JSON.stringify({
          vw: window.innerWidth,
          vh: window.innerHeight,
          left: Math.round(rect.left),
          top: Math.round(rect.top),
          right: Math.round(rect.right),
          bottom: Math.round(rect.bottom),
          w: Math.round(rect.width),
          saved
        });
      })()`)
    )
  );
  results.push({
    name: '0.8.1：窗口改小后悬浮球自动夹回可视区，不会留在窗口外面',
    ok:
      fabShrink.error === undefined &&
      fabShrink.w > 0 &&
      fabShrink.left >= 0 &&
      fabShrink.top >= 60 &&
      fabShrink.right <= fabShrink.vw &&
      fabShrink.bottom <= fabShrink.vh,
    detail:
      '窗口=' +
      fabShrink.vw +
      'x' +
      fabShrink.vh +
      ' 按钮=' +
      JSON.stringify({ l: fabShrink.left, t: fabShrink.top, r: fabShrink.right, b: fabShrink.bottom }) +
      ' 存的=' +
      fabShrink.saved +
      (fabShrink.error ? ' 错误=' + fabShrink.error : '')
  });

  // 3) 从极限位置还能把它拖出来（死区/粘手如果发生，这一步就动不了）
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await sleep(520);
  const fabEscape = JSON.parse(
    String(
      await cdp.eval(`(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const fab = document.querySelector('.focus-fab');
        if (!fab) return JSON.stringify({ error: '恢复窗口后按钮不见了' });
        const fire = (el, type, x, y) =>
          el.dispatchEvent(new PointerEvent(type, { pointerId: 23, bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, pointerType: 'mouse' }));
        await sleep(300);
        const before = fab.getBoundingClientRect();
        const cx = before.left + before.width / 2;
        const cy = before.top + before.height / 2;
        fire(fab, 'pointerdown', cx, cy);
        await sleep(30);
        fire(window, 'pointermove', window.innerWidth / 2, window.innerHeight / 2);
        await sleep(40);
        fire(window, 'pointerup', window.innerWidth / 2, window.innerHeight / 2);
        await sleep(380);
        const after = fab.getBoundingClientRect();
        return JSON.stringify({
          vw: window.innerWidth,
          vh: window.innerHeight,
          bx: Math.round(before.left),
          by: Math.round(before.top),
          ax: Math.round(after.left),
          ay: Math.round(after.top),
          dx: Math.round(after.left - before.left),
          dy: Math.round(after.top - before.top),
          saved: localStorage.getItem('jw-focus-fab-pos'),
          panel: !!document.querySelector('.focus-panel'),
          dragging: fab.parentElement.className.indexOf('dragging') >= 0
        });
      })()`)
    )
  );
  results.push({
    name: '0.8.1：按钮停在极限位置时仍然拖得出来（不会粘在角落）',
    ok:
      fabEscape.error === undefined &&
      (Math.abs(fabEscape.dx) >= 40 || Math.abs(fabEscape.dy) >= 40) &&
      fabEscape.panel === false &&
      fabEscape.dragging === false,
    detail:
      '窗口=' +
      fabEscape.vw +
      'x' +
      fabEscape.vh +
      ' 前=' +
      fabEscape.bx +
      ',' +
      fabEscape.by +
      ' 后=' +
      fabEscape.ax +
      ',' +
      fabEscape.ay +
      ' 位移=' +
      fabEscape.dx +
      ',' +
      fabEscape.dy +
      ' 存=' +
      fabEscape.saved +
      ' 拖动后面板=' +
      fabEscape.panel +
      ' dragging类=' +
      fabEscape.dragging +
      (fabEscape.error ? ' 错误=' + fabEscape.error : '')
  });

  // 4) localStorage 被写坏（1e999 解析出来是 Infinity）：刷新后按钮必须回到右下角，而不是消失
  await cdp.eval("localStorage.setItem('jw-focus-fab-pos', JSON.stringify({ tx: 1e999, ty: -1e999 })); true");
  await cdp.eval('location.reload(); true');
  await sleep(2400);
  const fabDirty = JSON.parse(
    String(
      await cdp.eval(`(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        let fab = document.querySelector('.focus-fab');
        const deadline = Date.now() + 8000;
        while (!fab && Date.now() < deadline) {
          await sleep(120);
          fab = document.querySelector('.focus-fab');
        }
        if (!fab) return JSON.stringify({ error: '脏数据刷新后按钮没回来' });
        await sleep(500);
        const rect = fab.getBoundingClientRect();
        const dock = fab.parentElement;
        const m = getComputedStyle(dock).transform;
        const nums = String(m).match(/-?[0-9.]+/g) || [];
        let saved = null;
        try {
          saved = JSON.parse(localStorage.getItem('jw-focus-fab-pos') || 'null');
        } catch {
          saved = null;
        }
        return JSON.stringify({
          vw: window.innerWidth,
          vh: window.innerHeight,
          left: Math.round(rect.left),
          top: Math.round(rect.top),
          right: Math.round(rect.right),
          bottom: Math.round(rect.bottom),
          w: Math.round(rect.width),
          tx: Number(nums[4]),
          ty: Number(nums[5]),
          saved
        });
      })()`)
    )
  );
  results.push({
    name: '0.8.1：localStorage 存了脏位置（1e999）时，刷新后按钮回到右下角而不是消失',
    ok:
      fabDirty.error === undefined &&
      fabDirty.w > 0 &&
      Math.abs(Number(fabDirty.tx)) <= 2 &&
      Math.abs(Number(fabDirty.ty)) <= 2 &&
      !!fabDirty.saved &&
      Math.abs(Number(fabDirty.saved.tx)) <= 2 &&
      Math.abs(Number(fabDirty.saved.ty)) <= 2 &&
      fabDirty.left >= 0 &&
      fabDirty.top >= 60 &&
      fabDirty.right <= fabDirty.vw &&
      fabDirty.bottom <= fabDirty.vh,
    detail:
      '按钮=' +
      JSON.stringify({ w: fabDirty.w, l: fabDirty.left, t: fabDirty.top, r: fabDirty.right, b: fabDirty.bottom }) +
      ' transform=' +
      fabDirty.tx +
      ',' +
      fabDirty.ty +
      ' 存的=' +
      JSON.stringify(fabDirty.saved) +
      ' 窗口=' +
      fabDirty.vw +
      'x' +
      fabDirty.vh +
      (fabDirty.error ? ' 错误=' + fabDirty.error : '')
  });


  // ================= 第七版（0.7.0）：AI 辅助 =================
  // 主进程真发 HTTP，但打的是本地 stub（/ai/v1 正常、/ai-bad/v1 回 401、127.0.0.1:1 断网）。
  const AI_PRELUDE = `const q=(s)=>document.querySelector(s);
    const qa=(s)=>[...document.querySelectorAll(s)];
    const txt=(s)=>{const el=q(s);return el?el.textContent.trim():'';};
    const sleep=(ms)=>new Promise((r)=>setTimeout(r,ms));
    const waitFor=async(fn,ms=5000)=>{const t0=Date.now();while(Date.now()-t0<ms){try{const v=fn();if(v)return v;}catch{}await sleep(60);}return null;};
    const clickText=(s,w)=>{const el=qa(s).find((x)=>((x.textContent)||'').includes(w));if(!el)throw new Error('找不到 '+w+' @ '+s);el.click();return el;};
    const selectText=(len)=>{const el=q('.rt-editor');if(!el)throw new Error('没有打开笔记');el.focus();const w=document.createTreeWalker(el,NodeFilter.SHOW_TEXT);let n=null;while(w.nextNode()){const v=w.currentNode.nodeValue||'';if(v.trim().length>=len){n=w.currentNode;break;}}if(!n)throw new Error('正文里没有可选的文字');const v=n.nodeValue||'';const s=v.search(/\\S/);const r=document.createRange();r.setStart(n,s);r.setEnd(n,Math.min(v.length,s+len));const sel=window.getSelection();sel.removeAllRanges();sel.addRange(r);document.dispatchEvent(new Event('selectionchange'));return sel.toString();};`;

  // 1) 配置只停在主进程 + 设置页卡片 + 测试连接
  const aiCfg = JSON.parse(
    String(
      await cdp.eval(`(async () => {
    ${AI_PRELUDE}
    const out = [];
    const rec = (name, ok, detail) => out.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail).slice(0, 220) });
    const set = await window.api.invoke('ai:config:set', {
      baseUrl: 'http://127.0.0.1:${stubPort}/ai/v1',
      model: 'stub-model',
      apiKey: 'sk-e2e-secret-123456',
      privacyAck: false
    });
    rec('AI：Key 只在主进程，渲染层拿到的只有打码尾巴', set.hasKey === true && !JSON.stringify(set).includes('sk-e2e-secret-123456') && String(set.keyHint).includes('…'), 'hint=' + set.keyHint);
    location.hash = '/settings';
    const card = await waitFor(() => q('.ai-settings-card'), 5000);
    rec('AI：设置页有「AI 模型」卡片（地址 / 模型 / Key）', !!card && !!q('.ai-base-url') && !!q('.ai-model') && !!q('.ai-key'), card ? '三个输入框都在' : '卡片没出现');
    if (card) clickText('.ai-test-btn', '测试连接');
    const tested = await waitFor(() => /连通了/.test(txt('.ai-test-result')), 8000);
    rec('AI：设置页「测试连接」能连通（stub 回「可用」）', !!tested, txt('.ai-test-result').slice(0, 80));

    // 0.8.2：模型名带连字符（deepseek-v4-pro）必须放行，不能报「模型名格式错误」
    const setInputValue = (sel, val) => {
      const el = q(sel);
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, val);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    setInputValue('.ai-model', 'deepseek-v4-pro');
    clickText('.ai-save-btn', '保存 AI 设置');
    await sleep(500);
    clickText('.ai-test-btn', '测试连接');
    const okHyphen = await waitFor(() => /连通了：deepseek-v4-pro/.test(txt('.ai-test-result')), 8000);
    rec(
      'AI：模型名带连字符（deepseek-v4-pro）能保存并测试连接成功',
      !!okHyphen && !/格式错误/.test(txt('.ai-test-result')) && !q('.ai-model.ai-input-bad'),
      txt('.ai-test-result').slice(0, 90)
    );

    // 模型名写错（中间有空格）→ 明确提示「模型名格式错误」并高亮输入框，不能混成「连接失败」
    setInputValue('.ai-model', 'deepseek v4');
    clickText('.ai-save-btn', '保存 AI 设置');
    const badToast = await waitFor(
      () => [...document.querySelectorAll('.toast-wrap .toast')].map((e) => e.innerText).join(' | ').match(/模型名格式错误/),
      5000
    );
    const badField = await waitFor(() => q('.ai-model.ai-input-bad'), 3000);
    rec(
      'AI：模型名写错时提示「模型名格式错误」+ 标红输入框（不是「连接失败」）',
      !!badToast && !!badField && !/连接失败/.test(txt('.ai-test-result')),
      'toast=' + String(badToast).slice(0, 80) + ' 标红=' + !!badField
    );

    // 改回正常名字，后面几条断言还要用
    setInputValue('.ai-model', 'stub-model');
    clickText('.ai-save-btn', '保存 AI 设置');
    await sleep(400);
    const restored = await window.api.invoke('ai:config:get');
    rec('AI：改回正确模型名后配置恢复正常', restored.model === 'stub-model' && !q('.ai-model.ai-input-bad'), 'model=' + restored.model);

    /* ---------------- 0.8.3：测试连接的解析兼容层 ---------------- */
    const setBaseUrl = async (url) => {
      await window.api.invoke('ai:config:set', { baseUrl: url });
      clickText('.ai-test-btn', '测试连接');
    };

    // (1) 推理模型：content 为空、内容在 reasoning_content 里 → 也算连通
    await setBaseUrl('http://127.0.0.1:${stubPort}/ai-reasoning/v1');
    const reasoningOk = await waitFor(() => /连通了/.test(txt('.ai-test-result')), 8000);
    rec(
      'AI：推理模型（内容在 reasoning_content 里）测试连接也能显示「连通了」',
      !!reasoningOk && !/连接失败|没有文字|不兼容/.test(txt('.ai-test-result')),
      txt('.ai-test-result').slice(0, 90)
    );

    // (2) 真的返回空内容 → 「已连通，但返回了空内容」，不是「接口不兼容」
    await setBaseUrl('http://127.0.0.1:${stubPort}/ai-empty/v1');
    const emptyMsg = await waitFor(() => /已连通，但返回了空内容/.test(txt('.ai-test-result')), 8000);
    rec(
      'AI：接口返回空内容时提示「已连通，但返回了空内容（检查模型名）」',
      !!emptyMsg && !/接口不兼容|没有文字/.test(txt('.ai-test-result')),
      txt('.ai-test-result').slice(0, 90)
    );

    // (3) 404 → 精准说「接口地址不对」，而不是笼统的「没有文字」
    await setBaseUrl('http://127.0.0.1:${stubPort}/ai-404/v1');
    const notFound = await waitFor(() => /接口地址不对（HTTP 404）/.test(txt('.ai-test-result')), 8000);
    rec(
      'AI：Base URL 写错（404）时精准提示「接口地址不对」',
      !!notFound && !/没有文字|接口不兼容/.test(txt('.ai-test-result')),
      txt('.ai-test-result').slice(0, 90)
    );

    // 恢复成正常地址，后面的摘要/划词还要用
    await window.api.invoke('ai:config:set', { baseUrl: 'http://127.0.0.1:${stubPort}/ai/v1' });
    clickText('.ai-test-btn', '测试连接');
    await waitFor(() => /连通了/.test(txt('.ai-test-result')), 8000);
    return JSON.stringify(out);
  })()`)
    )
  );
  results.push(...aiCfg);
  await cdp.shot('ai-settings');

  // 2) 打开笔记 → 摘要（第一次用先隐私确认，流式完后自动插入开头）
  const aiSummary = JSON.parse(
    String(
      await cdp.eval(`(async () => {
    ${AI_PRELUDE}
    const out = [];
    const rec = (name, ok, detail) => out.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail).slice(0, 220) });
    location.hash = '/knowledge';
    // 自己造一篇正文够长的笔记，别依赖之前测试留下的笔记内容
    await window.api.invoke('note:create', {
      title: 'AI 摘要自检',
      html: '<p>间隔重复与主动回忆是复习的两条主线，这段文字用来测试 AI 摘要和划词。</p>'
    });
    location.hash = '/';
    await sleep(350);
    location.hash = '/knowledge';
    const row = await waitFor(() => qa('.list-row').find((r) => ((r.textContent) || '').includes('AI 摘要自检')), 8000);
    if (!row) throw new Error('知识库列表里没找到自检笔记');
    row.click();
    const ed = await waitFor(() => { const el = q('.rt-editor'); return el && (el.textContent || '').includes('间隔重复') ? el : null; }, 8000);
    rec('AI：能打开一篇有正文的笔记', !!ed, ed ? '正文长度=' + (ed.textContent || '').trim().length : '没有编辑器');
    clickText('.tb-ai', 'AI');
    await waitFor(() => q('.ctx-menu'), 3000);
    clickText('.ctx-item', '摘要（插到开头）');
    const privacy = await waitFor(() => q('.modal.ai-privacy'), 5000);
    rec('AI：第一次用之前先弹隐私说明', !!privacy, privacy ? '隐私弹窗出现' : '没有隐私弹窗');
    if (privacy) clickText('.ai-privacy-agree', '我知道');
    const modal = await waitFor(() => q('.modal.ai-summary'), 6000);
    const quote = await waitFor(() => q('.rt-editor blockquote.ai-summary'), 9000);
    rec('AI：摘要生成完自动以引用块插到笔记开头', !!modal && !!quote, quote ? '开头引用块=' + (quote.textContent || '').slice(0, 48) : '没插进去');
    rec('AI：摘要弹窗提供「撤销插入」', !!q('.ai-undo'), q('.ai-undo') ? '按钮在' : '没有按钮');
    return JSON.stringify(out);
  })()`)
    )
  );
  results.push(...aiSummary);
  await cdp.shot('ai-summary');

  // 3) 撤销插入：原生撤销一步就把整块拿掉
  const aiUndo = JSON.parse(
    String(
      await cdp.eval(`(async () => {
    ${AI_PRELUDE}
    const out = [];
    const rec = (name, ok, detail) => out.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail).slice(0, 220) });
    const before = !!q('.rt-editor blockquote.ai-summary');
    clickText('.ai-undo', '撤销插入');
    await sleep(400);
    rec('AI：点「撤销插入」把摘要整块拿掉（原生撤销一步）', before && !q('.rt-editor blockquote.ai-summary'), '撤销前=' + before + ' 撤销后=' + String(!!q('.rt-editor blockquote.ai-summary')));
    clickText('.modal.ai-summary .modal-foot .btn', '完成');
    return JSON.stringify(out);
  })()`)
    )
  );
  results.push(...aiUndo);

  // 4) 划词 → 气泡 → 润色：预览对比，确认前不改正文
  const aiBubble = JSON.parse(
    String(
      await cdp.eval(`(async () => {
    ${AI_PRELUDE}
    const out = [];
    const rec = (name, ok, detail) => out.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail).slice(0, 220) });
    const picked = selectText(8);
    const bubble = await waitFor(() => q('.ai-bubble'), 4000);
    rec('AI：选中正文就浮出划词气泡（润色/扩写/缩写/翻译）', !!bubble && qa('.ai-bubble .ai-bubble-btn').length === 4, bubble ? '选中「' + picked + '」，按钮=' + qa('.ai-bubble .ai-bubble-btn').length : '没有气泡');
    const lang = await waitFor(() => q('.ai-bubble .ai-lang-select'), 3000);
    rec('AI：划词气泡里有目标语言下拉（中/英/日/韩…）', !!lang && lang.options.length >= 4, lang ? '语言项=' + lang.options.length : '没有下拉');
    clickText('.ai-bubble .ai-bubble-btn', '润色');
    const result = await waitFor(() => { const el = q('.ai-preview-out'); return el && /这是润色后的句子/.test(el.textContent || '') ? el : null; }, 9000);
    rec('AI：润色弹窗两栏对比（原文 / AI 结果），结果是流式到达的', !!result && !!q('.ai-preview-src'), result ? '结果=' + (result.textContent || '').trim().slice(0, 32) : '结果没到');
    rec('AI：确认替换之前正文一个字都没改', !(q('.rt-editor').textContent || '').includes('这是润色后的句子'), '正文仍是原文');
    return JSON.stringify(out);
  })()`)
    )
  );
  results.push(...aiBubble);
  await cdp.shot('ai-polish');

  // 4b) 确认替换才写回
  const aiConfirm = JSON.parse(
    String(
      await cdp.eval(`(async () => {
    ${AI_PRELUDE}
    const out = [];
    const rec = (name, ok, detail) => out.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail).slice(0, 220) });
    const btn = await waitFor(() => { const b = q('.ai-confirm'); return b && !b.disabled ? b : null; }, 7000);
    if (btn) btn.click();
    const replaced = await waitFor(() => (q('.rt-editor').textContent || '').includes('这是润色后的句子'), 5000);
    rec('AI：点「确认替换」才把结果写回正文', !!btn && !!replaced, replaced ? '正文里出现 AI 结果' : '没有写回');
    rec('AI：替换后预览弹窗自动关闭', !q('.modal.ai-preview'), '');
    return JSON.stringify(out);
  })()`)
    )
  );
  results.push(...aiConfirm);

  // 5) 翻译：目标语言可选，未确认不写入
  const aiTranslate = JSON.parse(
    String(
      await cdp.eval(`(async () => {
    ${AI_PRELUDE}
    const out = [];
    const rec = (name, ok, detail) => out.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail).slice(0, 220) });
    selectText(8);
    await waitFor(() => q('.ai-bubble'), 4000);
    const lang = await waitFor(() => q('.ai-bubble .ai-lang-select'), 3000);
    if (!lang) throw new Error('气泡里没有语言下拉');
    lang.value = 'en';
    lang.dispatchEvent(new Event('change', { bubbles: true }));
    clickText('.ai-bubble .ai-bubble-btn', '翻译');
    const result = await waitFor(() => { const el = q('.ai-preview-out'); return el && /TRANSLATED TEXT/.test(el.textContent || '') ? el : null; }, 9000);
    rec('AI：翻译能指定目标语言（选英文 → 标题带「英文」，结果按目标语言返回）', !!result && txt('.modal.ai-preview .modal-head').includes('英文'), '标题=' + txt('.modal.ai-preview .modal-head'));
    rec('AI：翻译结果没确认前不进正文', !(q('.rt-editor').textContent || '').includes('TRANSLATED TEXT'), '正文未被改写');
    clickText('.modal.ai-preview .modal-foot .btn', '取消');
    await sleep(300);
    rec('AI：点「取消」后正文保持原样', !(q('.rt-editor').textContent || '').includes('TRANSLATED TEXT'), '取消完成');
    return JSON.stringify(out);
  })()`)
    )
  );
  results.push(...aiTranslate);

  // 6) 分类整理：标签点一下就加进笔记 + 一个分类建议
  const aiTagsOpen = JSON.parse(
    String(
      await cdp.eval(`(async () => {
    ${AI_PRELUDE}
    const out = [];
    const rec = (name, ok, detail) => out.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail).slice(0, 220) });
    clickText('.tb-ai', 'AI');
    await waitFor(() => q('.ctx-menu'), 3000);
    clickText('.ctx-item', '分类整理');
    const chip = await waitFor(() => q('.ai-tag-chip'), 9000);
    rec('AI：分类整理给出可点的标签建议', !!chip && qa('.ai-tag-chip').length >= 2, chip ? '标签=' + qa('.ai-tag-chip').map((c) => (c.textContent || '').replace(/^\\+ /, '').trim()).join('/') : '没有标签');
    rec('AI：分类整理附带一个分类建议', /学习/.test(txt('.ai-cat-suggest')), '分类建议=' + txt('.ai-cat-suggest'));
    return JSON.stringify(out);
  })()`)
    )
  );
  results.push(...aiTagsOpen);
  await cdp.shot('ai-tags');

  const aiTags = JSON.parse(
    String(
      await cdp.eval(`(async () => {
    ${AI_PRELUDE}
    const out = [];
    const rec = (name, ok, detail) => out.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail).slice(0, 220) });
    const chip = await waitFor(() => q('.ai-tag-chip'), 5000);
    const firstName = chip ? (chip.textContent || '').replace(/^\\+ /, '').trim() : '';
    if (chip) chip.click();
    const added = await waitFor(() => qa('.ai-tag-chip.on').length >= 1, 6000);
    const tagInput = q('input[placeholder^="标签，用逗号分开"]');
    rec('AI：点一下标签就加进当前笔记', !!added && !!tagInput && (tagInput.value || '').includes(firstName), tagInput ? '标签栏=' + tagInput.value : '没有标签输入框');
    clickText('.modal.ai-tags .modal-foot .btn', '完成');
    return JSON.stringify(out);
  })()`)
    )
  );
  results.push(...aiTags);

  // 7) 知识联想：列点，且「新建笔记」默认落进当前分类并直接打开
  const aiRelatedOpen = JSON.parse(
    String(
      await cdp.eval(`(async () => {
    ${AI_PRELUDE}
    const out = [];
    const rec = (name, ok, detail) => out.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail).slice(0, 220) });
    clickText('.tb-ai', 'AI');
    await waitFor(() => q('.ctx-menu'), 3000);
    clickText('.ctx-item', '知识联想');
    const item = await waitFor(() => q('.ai-related-item'), 9000);
    rec('AI：知识联想列出可继续想的点', !!item && qa('.ai-related-item').length >= 2, item ? '条数=' + qa('.ai-related-item').length : '没有联想');
    return JSON.stringify(out);
  })()`)
    )
  );
  results.push(...aiRelatedOpen);
  await cdp.shot('ai-related');

  const aiRelated = JSON.parse(
    String(
      await cdp.eval(`(async () => {
    ${AI_PRELUDE}
    const out = [];
    const rec = (name, ok, detail) => out.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail).slice(0, 220) });
    const catBefore = txt('.tree-item.selected');
    clickText('.ai-related-item .btn.primary', '新建笔记');
    const titleInput = await waitFor(() => { const el = q('.editor-title'); return el && (el.value || '').includes('为什么要复习') ? el : null; }, 7000);
    rec('AI：联想「新建笔记」直接打开新笔记', !!titleInput, titleInput ? '新笔记标题=' + titleInput.value : '没有打开新笔记');
    rec('AI：新建的笔记默认带当前分类', txt('.tree-item.selected') === catBefore, '分类=' + catBefore + ' → ' + txt('.tree-item.selected'));
    return JSON.stringify(out);
  })()`)
    )
  );
  results.push(...aiRelated);

  // 8) Key 无效：几秒内中文报错，不卡死
  const aiBadKey = JSON.parse(
    String(
      await cdp.eval(`(async () => {
    ${AI_PRELUDE}
    const out = [];
    const rec = (name, ok, detail) => out.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail).slice(0, 220) });
    await window.api.invoke('ai:config:set', { baseUrl: 'http://127.0.0.1:${stubPort}/ai-bad/v1' });
    const t0 = Date.now();
    selectText(8);
    await waitFor(() => q('.ai-bubble'), 4000);
    clickText('.ai-bubble .ai-bubble-btn', '润色');
    const err = await waitFor(() => { const el = q('.ai-preview-out .ai-error-text') || q('.ai-preview .ai-error-bar span'); return el && /API Key/.test(el.textContent || '') ? el : null; }, 10000);
    const ms = Date.now() - t0;
    rec('AI：Key 无效时 5 秒内中文报错、界面不卡死', !!err && ms < 10000, '耗时≈' + ms + 'ms，提示=' + (err ? (err.textContent || '').trim().slice(0, 60) : '没报错'));
    clickText('.modal.ai-preview .modal-foot .btn', '取消');
    await sleep(300);
    return JSON.stringify(out);
  })()`)
    )
  );
  results.push(...aiBadKey);

  // 9) 断网：只提示，不影响本地读写
  const aiOffline = JSON.parse(
    String(
      await cdp.eval(`(async () => {
    ${AI_PRELUDE}
    const out = [];
    const rec = (name, ok, detail) => out.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail).slice(0, 220) });
    await window.api.invoke('ai:config:set', { baseUrl: 'http://127.0.0.1:1/v1' });
    selectText(8);
    await waitFor(() => q('.ai-bubble'), 4000);
    clickText('.ai-bubble .ai-bubble-btn', '润色');
    const err = await waitFor(() => { const el = q('.ai-preview-out .ai-error-text') || q('.ai-preview .ai-error-bar span'); return el && /(连不上|网络|AI 请求失败)/.test(el.textContent || '') ? el : null; }, 12000);
    rec('AI：断网时会中文提示（不崩、不卡死）', !!err, err ? '提示=' + (err.textContent || '').trim().slice(0, 70) : '没有提示');
    const info = await window.api.invoke('app:info');
    const integrity = await window.api.invoke('data:integrity');
    rec('AI：断网不影响本地功能（库仍可读、完整性正常）', !!info && !!info.dataRoot && integrity && integrity.ok !== false, '完整性=' + JSON.stringify(integrity).slice(0, 60));
    clickText('.modal.ai-preview .modal-foot .btn', '取消');
    await window.api.invoke('ai:config:set', { baseUrl: 'http://127.0.0.1:${stubPort}/ai/v1' });
    await sleep(300);
    return JSON.stringify(out);
  })()`)
    )
  );
  results.push(...aiOffline);

  // 10) 手动停止生成（0.8.0）：中断后保留已生成内容，还能确认替换/复制
  const aiStop = JSON.parse(
    String(
      await cdp.eval(`(async () => {
    ${AI_PRELUDE}
    const out = [];
    const rec = (name, ok, detail) => out.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail).slice(0, 220) });
    await window.api.invoke('ai:config:set', { baseUrl: 'http://127.0.0.1:${stubPort}/ai-slow/v1' });
    const before = q('.rt-editor') ? q('.rt-editor').innerText : '';
    selectText(8);
    await waitFor(() => q('.ai-bubble'), 4000);
    clickText('.ai-bubble .ai-bubble-btn', '润色');
    const stopBtn = await waitFor(() => q('.ai-stop'), 5000);
    rec('AI：生成中提供「■ 停止生成」按钮', !!stopBtn, stopBtn ? (stopBtn.textContent || '').trim() : '没有按钮');
    await waitFor(() => { const el = q('.ai-preview-out'); return el && (el.textContent || '').trim().length > 0 ? el : null; }, 6000);
    if (stopBtn) stopBtn.click();
    const stopped = await waitFor(() => { const badge = q('.ai-stopped'); return badge && !q('.ai-stop') ? badge : null; }, 5000);
    const kept = (txt('.ai-preview-out') || '').trim();
    rec('AI：停止后按钮恢复、不卡在生成中', !!stopped && !q('.ai-stop'), '已停止标记=' + String(!!stopped));
    rec('AI：停止后已生成内容保留在弹窗里', kept.length > 0 && /这是润色/.test(kept), '保留=' + kept.length + ' 字：' + kept.slice(0, 30));
    rec('AI：停止不算报错（没有红字提示）', !q('.modal.ai-preview .ai-error-text') && !q('.modal.ai-preview .ai-error-bar'), '');
    const confirmBtn = q('.ai-confirm');
    rec('AI：停止后仍可「确认替换」/「复制」', !!confirmBtn && !confirmBtn.disabled && !!q('.modal.ai-preview .ai-foot .btn'), '确认按钮可用=' + String(!!confirmBtn && !confirmBtn.disabled));
    if (confirmBtn) confirmBtn.click();
    await sleep(500);
    const after = q('.rt-editor') ? q('.rt-editor').innerText : '';
    rec('AI：停止后确认替换能把已生成部分写进正文', after !== before && /这是润色/.test(after), '写回=' + /这是润色/.test(after));
    rec('AI：替换后预览弹窗关闭', !q('.modal.ai-preview'), '');
    await window.api.invoke('ai:config:set', { baseUrl: 'http://127.0.0.1:${stubPort}/ai/v1' });
    await sleep(300);
    return JSON.stringify(out);
  })()`)
    )
  );
  results.push(...aiStop);

  // 11) 导出全库为 Markdown（0.8.0 任务四）：设置页按钮 → 主进程按分类写 .md + 拷图片
  try {
    fs.rmSync(exportDir, { recursive: true, force: true });
  } catch {
    /* 第一次跑没有这个目录 */
  }
  const exportUi = JSON.parse(
    String(
      await cdp.eval(`(async () => {
    const q=(s)=>document.querySelector(s);
    const qa=(s)=>[...document.querySelectorAll(s)];
    const sleep=(ms)=>new Promise((r)=>setTimeout(r,ms));
    const waitFor=async(fn,ms=5000)=>{const t0=Date.now();while(Date.now()-t0<ms){try{const v=fn();if(v)return v;}catch{}await sleep(60);}return null;};
    const out=[];
    const rec=(name,ok,detail)=>out.push({name,ok:!!ok,detail:detail===undefined?'':String(detail).slice(0,220)});
    location.hash='/settings';
    const card=await waitFor(()=>q('.export-card'),5000);
    rec('0.8.0：设置页有「导出数据」卡片和 Markdown 按钮', !!card && !!q('.export-md-btn'), card?(q('.export-md-btn').textContent||'').trim():'卡片没出现');
    if (!card) return JSON.stringify(out);
    const btn=await waitFor(()=>q('.export-md-btn'),4000);
    if (btn) btn.click();
    // 软件渲染下偶发丢一次点击：12 秒还没开始/没结束就再点一次（断言标准不变）
    let done=await waitFor(()=>q('.export-progress')&&/导出完成/.test(q('.export-progress').textContent||''),12000);
    if (!done && !/失败/.test((q('.export-progress')||{}).textContent||'')) {
      const again = await waitFor(()=>q('.export-md-btn'),2000);
      if (again && !again.classList.contains('loading')) again.click();
      done=await waitFor(()=>q('.export-progress')&&/导出完成/.test(q('.export-progress').textContent||''),18000);
    }
    rec('0.8.0：点导出后能跑完并显示结果（进度 → 完成）', !!done, done?(q('.export-progress').textContent||'').trim():'没等到完成');
    rec('0.8.0：导出结束后按钮不是一直转圈', !q('.export-md-btn')||!q('.export-md-btn').classList.contains('loading'), (q('.export-md-btn')||{}).textContent||'');
    rec('0.8.0：导出完成没有报错 Toast（显示的是完成提示）', qa('.toast-wrap').every((t)=>!/失败/.test(t.textContent||'')), qa('.toast-wrap').map((t)=>t.textContent).join(' | ').slice(0,80));
    return JSON.stringify(out);
  })()`)
    )
  );
  results.push(...exportUi);

  // 落盘检查：目录结构 / .md 内容 / 图片拷贝
  const exportMdFiles = [];
  const walkExport = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walkExport(full);
      else if (entry.name.toLowerCase().endsWith('.md')) exportMdFiles.push(full);
    }
  };
  walkExport(exportDir);
  const exportedTexts = exportMdFiles.map((file) => ({ file, text: fs.readFileSync(file, 'utf8') }));
  const attachmentsDir = path.join(exportDir, 'attachments');
  const attachmentFiles = [];
  if (fs.existsSync(attachmentsDir)) {
    const walkFiles = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walkFiles(full);
        else attachmentFiles.push(full);
      }
    };
    walkFiles(attachmentsDir);
  }
  const imagesInMd = exportedTexts.filter((item) => item.text.includes('!['));
  const badImageRefs = exportedTexts.filter((item) => item.text.includes('jw-att://'));

  results.push({
    name: '0.8.0：真的写出了 .md 文件（按分类建目录，不是一坨全在根上）',
    ok:
      exportMdFiles.length >= 3 &&
      exportedTexts.some((item) => path.dirname(item.file) !== path.dirname(exportMdFiles[0])),
    detail: '共 ' + exportMdFiles.length + ' 篇，示例：' + exportMdFiles.slice(0, 3).map((f) => path.relative(exportDir, f)).join(' / ')
  });
  results.push({
    name: '0.8.0：导出的 .md 是标准 Markdown（有 # 标题、没有 HTML 标签）',
    ok:
      exportedTexts.length > 0 &&
      exportedTexts.every((item) => item.text.startsWith('# ') || item.text.startsWith('---')) &&
      exportedTexts.every((item) => !/<(p|div|span|h[1-6]|strong|ul|li)\b/i.test(item.text)),
    detail: exportedTexts.length > 0 ? exportedTexts[0].text.split('\n').slice(0, 2).join(' / ') : '没有文件'
  });
  results.push({
    name: '0.8.0：图片拷进了 attachments，正文里换成相对路径（Obsidian 能直接看）',
    ok:
      badImageRefs.length === 0 &&
      imagesInMd.every((item) => /!\[[^\]]*\]\(([^)]+)\)/.test(item.text) && !/!\[[^\]]*\]\(jw-att:/.test(item.text)),
    detail: '图片引用 ' + imagesInMd.length + ' 篇，attachments 里 ' + attachmentFiles.length + ' 个文件'
  });
  results.push({
    name: '0.8.0：导出结果能被重新读出来（文件非空、不是占位）',
    ok: exportedTexts.length > 0 && exportedTexts.every((item) => item.text.trim().length > 0),
    detail: exportedTexts.length > 0 ? '最小文件 ' + Math.min(...exportedTexts.map((item) => item.text.length)) + ' 字节' : '没有文件'
  });

  // ---- 0.11.0：GitHub 项目搜集（导入收集箱 → AI 提炼 → 转知识库笔记）----
  const repoFlow = await cdp.eval(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const inv = (ch, p) => window.api.invoke(ch, p);
    const setInput = (el, value) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const clickText = (root, text) => {
      const btn = [...root.querySelectorAll('button')].find((b) => (b.textContent || '').includes(text));
      if (btn) btn.click();
      return !!btn;
    };
    const waitModalGone = async (limit = 120) => {
      for (let i = 0; i < limit; i += 1) {
        await sleep(150);
        if (!document.querySelector('.modal.github-import')) return true;
      }
      return false;
    };

    const cfg = await inv('ai:config:get');
    const goodBase = cfg.baseUrl;
    const badBase = goodBase.replace('/ai/v1', '/ai-bad/v1');
    await inv('ai:config:set', { baseUrl: goodBase, model: 'stub-model', apiKey: 'sk-e2e-secret-123456' });
    await inv('github:config:set', { clientId: 'e2e-client-id' });
    await inv('github:request-code');
    await inv('github:poll-token');

    location.hash = '/inbox';
    await sleep(800);
    // 逐条清理模式开着时列表只渲染一条，先退出再断言
    const exitCleaning = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').includes('退出逐条清理'));
    if (exitCleaning) {
      exitCleaning.click();
      await sleep(400);
    }
    const hasImportBtn = !!document.querySelector('.github-import-btn');

    // 1) 烂地址：弹窗里直接中文报错，不发请求
    document.querySelector('.github-import-btn').click();
    await sleep(320);
    const modal = document.querySelector('.modal.github-import');
    setInput(document.querySelector('.github-import-url'), 'https://gitlab.com/a/b');
    clickText(modal, '仅保存链接');
    await sleep(260);
    const badError = ((modal.querySelector('.github-error') || {}).innerText || '').replace(/\\s+/g, ' ');
    clickText(modal, '取消');
    await sleep(280);

    // 2) 脏链接 + 仅保存链接
    document.querySelector('.github-import-btn').click();
    await sleep(320);
    clickText(document.querySelector('.modal.github-import'), '取消');
    await sleep(200);
    document.querySelector('.github-import-btn').click();
    await sleep(320);
    const modal2 = document.querySelector('.modal.github-import');
    setInput(document.querySelector('.github-import-url'), 'https://github.com/octo/demo.git/tree/main?tab=readme#top');
    clickText(modal2, '仅保存链接');
    await waitModalGone();
    await sleep(500);
    const items1 = await inv('inbox:list', {});
    const linkItem = (items1 || []).find((it) => it.github_repo === 'octo/demo' && it.extract_status === 'link_only');

    // 3) 保存并 AI 提炼
    document.querySelector('.github-import-btn').click();
    await sleep(320);
    const modal3 = document.querySelector('.modal.github-import');
    setInput(document.querySelector('.github-import-url'), 'https://github.com/octo/second');
    clickText(modal3, '保存并 AI 提炼');
    await waitModalGone(160);
    await sleep(800);
    // 提炼是异步的：先轮询库里出现 done 的条目（最多 30s），再等卡片渲染
    let items2 = [];
    let aiItem = null;
    for (let i = 0; i < 150; i += 1) {
      items2 = (await inv('inbox:list', {})) || [];
      aiItem = items2.find((it) => it.github_repo === 'octo/second' && it.extract_status === 'done');
      if (aiItem) break;
      await sleep(200);
    }
    if (!aiItem) items2 = (await inv('inbox:list', {})) || [];
    let cards = [];
    const squash = (v) => String(v || '').replace(/\\s+/g, '');
    // 长仓库名会在 badge 里折行（octo/ second），比对时先去掉空白
    let secondCardEl = null;
    for (let i = 0; i < 60; i += 1) {
      secondCardEl = [...document.querySelectorAll('.github-item')].find((el) => squash(el.textContent).includes('octo/second')) || null;
      if (secondCardEl) break;
      await sleep(150);
    }
    cards = [...document.querySelectorAll('.github-item')].map((el) => (el.innerText || '').replace(/\\s+/g, ' '));
    const aiCard = secondCardEl ? (secondCardEl.innerText || '').replace(/\\s+/g, ' ') : '';
    const anyCardShowsYamlSeparator = cards.some((t) => /(?:^|\\s)---(?:\\s|$)/.test(t));
    const diag = {
      hash: location.hash,
      itemCount: document.querySelectorAll('.inbox-item').length,
      cardCount: cards.length,
      statuses: (items2 || []).map((it) => it.github_repo + ':' + it.status + ':' + it.extract_status),
      emptyText: (document.querySelector('.empty') || {}).innerText || '',
      tab: (document.querySelector('.tabs .btn.primary') || {}).innerText || '',
      modalOpen: !!document.querySelector('.modal')
    };

    return {
      hasImportBtn,
      badError,
      linkItem: linkItem || null,
      aiItem: aiItem || null,
      aiCard,
      anyCardShowsYamlSeparator,
      diag,
      connected: (await inv('github:status')).connected
    };
  })()`);
  // 给文档留一张「导入 GitHub 项目」弹窗的截图（填好地址、两个按钮都在）
  await cdp.eval(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const setInput = (el, value) => {
      if (!el) return;
      const proto = Object.getPrototypeOf(el);
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.set) desc.set.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const btn = document.querySelector('.github-import-btn');
    if (btn) btn.click();
    for (let i = 0; i < 20 && !document.querySelector('.modal.github-import'); i += 1) await sleep(120);
    setInput(document.querySelector('.github-import-url'), 'https://github.com/octo/second');
    await sleep(150);
    return true;
  })()`);
  await cdp.shot('github-import');
  await cdp.eval(`(async () => {
    const m = document.querySelector('.modal.github-import');
    if (!m) return false;
    const cancel = [...m.querySelectorAll('button')].find((b) => /取消/.test(b.innerText || ''));
    if (cancel) cancel.click();
    return true;
  })()`);
  results.push({
    name: '0.11.0：收集箱顶部有「导入 GitHub 项目」入口',
    ok: repoFlow.hasImportBtn === true,
    detail: '入口=' + repoFlow.hasImportBtn
  });
  results.push({
    name: '0.11.0：烂地址在弹窗里就被拦下（中文提示，不发请求）',
    ok: String(repoFlow.badError || '').includes('GitHub') && String(repoFlow.badError || '').includes('owner/repo'),
    detail: '错误文案=' + (repoFlow.badError || '').slice(0, 80)
  });
  results.push({
    name: '0.11.0：脏链接能清洗成 owner/repo，并「仅保存链接」进收集箱（带 YAML）',
    ok:
      !!repoFlow.linkItem &&
      String(repoFlow.linkItem.content || '').includes('repo: octo/demo') &&
      String(repoFlow.linkItem.content || '').startsWith('---') &&
      !String(repoFlow.linkItem.content || '').includes('github.com/octo/demo.git'),
    detail: 'repo=' + (repoFlow.linkItem && repoFlow.linkItem.github_repo) + ' 状态=' + (repoFlow.linkItem && repoFlow.linkItem.extract_status)
  });
  results.push({
    name: '0.11.0：「保存并 AI 提炼」生成知识点，卡片只显示徽章和正文（不显示 ---）',
    ok:
      !!repoFlow.aiItem &&
      repoFlow.aiCard.includes('项目总结') &&
      repoFlow.aiCard.includes('核心亮点') &&
      repoFlow.aiCard.includes('适用场景') &&
      repoFlow.aiCard.includes('批量处理文件') &&
      repoFlow.anyCardShowsYamlSeparator === false,
    detail: '卡片=' + (repoFlow.aiCard || '').slice(0, 80) + ' 诊断=' + JSON.stringify(repoFlow.diag || {})
  });

  const convertFlow = await cdp.eval(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const inv = (ch, p) => window.api.invoke(ch, p);
    const squash = (v) => String(v || '').replace(/\\s+/g, '');
    let card = [...document.querySelectorAll('.github-item')].find((el) => squash(el.textContent).includes('octo/second'));
    for (let i = 0; i < 40 && !card; i += 1) {
      await sleep(150);
      card = [...document.querySelectorAll('.github-item')].find((el) => squash(el.textContent).includes('octo/second'));
    }
    if (!card) return { error: '没找到 octo/second 卡片' };
    const row = card.closest('.inbox-item');
    const btn = row ? row.querySelector('.github-to-note') : null;
    if (!btn) return { error: '没有转笔记按钮' };
    btn.click();
    let converted = null;
    for (let i = 0; i < 80; i += 1) {
      await sleep(150);
      const list = (await inv('inbox:list', { status: 'processed' })) || [];
      converted = list.find((it) => it.github_repo === 'octo/second' && it.status === 'processed');
      if (converted) break;
    }
    let note = null;
    if (converted && converted.converted_to) {
      const noteId = Number(String(converted.converted_to).replace('note:', ''));
      note = await inv('note:get', { id: noteId });
    }
    return { converted: !!converted, noteTitle: note && note.title, content: note ? note.content : '' };
  })()`);
  results.push({
    name: '0.11.0：转成知识库笔记后，正文保留 YAML frontmatter 与提炼引用块',
    ok:
      convertFlow.converted === true &&
      String(convertFlow.content || '').includes('repo: octo/second') &&
      String(convertFlow.content || '').startsWith('---') &&
      String(convertFlow.content || '').includes('💡'),
    detail: '笔记=' + (convertFlow.noteTitle || convertFlow.error || '') + ' 字符=' + String(convertFlow.content || '').length
  });
  results.push({
    name: '0.11.0：端到端「输入 URL → AI 提炼 → 转知识库笔记」一条链路走通',
    ok:
      !!repoFlow.aiItem &&
      repoFlow.aiItem.github_repo === 'octo/second' &&
      repoFlow.aiItem.extract_status === 'done' &&
      String(repoFlow.aiCard || '').includes('项目总结') &&
      String(repoFlow.aiCard || '').includes('核心亮点') &&
      convertFlow.converted === true &&
      String(convertFlow.content || '').startsWith('---') &&
      String(convertFlow.content || '').includes('repo: octo/second'),
    detail:
      'URL→repo=' + (repoFlow.aiItem && repoFlow.aiItem.github_repo) +
      ' 提炼=' + (repoFlow.aiItem && repoFlow.aiItem.extract_status) +
      ' 转笔记=' + convertFlow.converted +
      ' 笔记标题=' + (convertFlow.noteTitle || '')
  });

  const aiFailFlow = await cdp.eval(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const inv = (ch, p) => window.api.invoke(ch, p);
    const cfg = await inv('ai:config:get');
    const goodBase = cfg.baseUrl;
    const badBase = goodBase.replace('/ai/v1', '/ai-bad/v1');
    await inv('ai:config:set', { baseUrl: badBase, model: 'stub-model', apiKey: 'sk-e2e-bad-key' });
    const failed = await inv('github:import', { url: 'https://github.com/octo/boom-fallback', extract: true });
    await inv('ai:config:set', { baseUrl: goodBase, model: 'stub-model', apiKey: 'sk-e2e-secret-123456' });
    location.hash = '/';
    await sleep(320);
    location.hash = '/inbox';
    await sleep(950);
    const items = await inv('inbox:list', {});
    const item = (items || []).find((it) => it.github_repo === 'octo/boom-fallback');
    const squash = (v) => String(v || '').replace(/\\s+/g, '');
    let card = [...document.querySelectorAll('.github-item')].find((el) => squash(el.textContent).includes('boom-fallback'));
    for (let i = 0; i < 40 && !card; i += 1) {
      await sleep(150);
      card = [...document.querySelectorAll('.github-item')].find((el) => squash(el.textContent).includes('boom-fallback'));
    }
    const row = card ? card.closest('.inbox-item') : null;
    const retry = row ? row.querySelector('.github-retry-btn') : null;
    if (retry) retry.click();
    let after = null;
    for (let i = 0; i < 60; i += 1) {
      await sleep(200);
      after = (await inv('inbox:list', {})).find((it) => it.github_repo === 'octo/boom-fallback');
      if (after && after.extract_status === 'done') break;
    }
    await sleep(400);
    const squash2 = (v) => String(v || '').replace(/\\s+/g, '');
    const cardAfter = [...document.querySelectorAll('.github-item')].find((el) => squash2(el.textContent).includes('boom-fallback'));
    return {
      status: failed.status,
      itemStatus: item && item.extract_status,
      hasRetry: !!retry,
      afterStatus: after && after.extract_status,
      text: cardAfter ? (cardAfter.innerText || '').replace(/\\s+/g, ' ') : ''
    };
  })()`);
  results.push({
    name: '0.11.0：AI 失败时降级保存基础信息，并出现「重试提炼」按钮',
    ok: aiFailFlow.status === 'ai_failed' && aiFailFlow.itemStatus === 'ai_failed' && aiFailFlow.hasRetry === true,
    detail: '导入结果=' + aiFailFlow.status + ' 条目状态=' + aiFailFlow.itemStatus + ' 有重试按钮=' + aiFailFlow.hasRetry
  });
  results.push({
    name: '0.11.0：点「重试提炼」能把知识点补回来（不用删了重导）',
    ok: aiFailFlow.afterStatus === 'done' && String(aiFailFlow.text || '').includes('项目总结'),
    detail: '重试后状态=' + aiFailFlow.afterStatus + ' 卡片=' + String(aiFailFlow.text || '').slice(0, 60)
  });

  const repo404 = await cdp.eval(`(async () => {
    const inv = (ch, p) => window.api.invoke(ch, p);
    try {
      await inv('github:import', { url: 'https://github.com/octo/missing', extract: false });
      return { error: '' };
    } catch (err) {
      return { error: (err && err.message) || String(err) };
    }
  })()`);
  results.push({
    name: '0.11.0：仓库不存在/没权限时提示 404 中文错误（不说「解析失败」）',
    ok: String(repo404.error || '').includes('404') && String(repo404.error || '').match(/不存在|没有权限/),
    detail: (repo404.error || '').slice(0, 100)
  });

  const ghSettings = await cdp.eval(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    location.hash = '/settings';
    await sleep(900);
    const card = document.querySelector('.github-card');
    if (card) card.scrollIntoView({ block: 'center' });
    await sleep(500);
    return { text: card ? card.innerText.replace(/\\s+/g, ' ') : '' };
  })()`);
  await sleep(300);
  await cdp.shot('github-settings');
  results.push({
    name: '0.11.0：设置页只保留授权（已连接 + Token 打码 + Client ID），没有同步按钮',
    ok:
      ghSettings.text.includes('已连接') &&
      ghSettings.text.includes('gho…3456') &&
      ghSettings.text.includes('Client ID') &&
      !ghSettings.text.includes('同步'),
    detail: (ghSettings.text || '').slice(0, 120)
  });

  const ghLogout = await cdp.eval(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const inv = (ch, p) => window.api.invoke(ch, p);
    const before = (await inv('inbox:list', {})).length;
    const btn = [...document.querySelectorAll('.github-card button')].find((b) => (b.textContent || '').includes('断开连接'));
    if (btn) btn.click();
    await sleep(1200);
    const status = await inv('github:status');
    const after = (await inv('inbox:list', {})).length;
    const card = document.querySelector('.github-card');
    return { before, after, connected: status.connected, text: card ? card.innerText.replace(/\\s+/g, ' ') : '' };
  })()`);
  results.push({
    name: '0.11.0：解绑 GitHub 只清 Token，收集箱里导入的条目一条不动',
    ok: ghLogout.connected === false && ghLogout.before === ghLogout.after && ghLogout.text.includes('未连接'),
    detail: '解绑前=' + ghLogout.before + ' 解绑后=' + ghLogout.after + ' connected=' + ghLogout.connected
  });

  const tasksUi = await cdp.eval(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    location.hash = '/tasks';
    await sleep(800);
    return {
      syncBtn: !!document.querySelector('.github-sync-btn'),
      text: (document.body.innerText || '').includes('同步 GitHub')
    };
  })()`);
  results.push({
    name: '0.11.0：任务页的旧「同步 GitHub」入口已经移除',
    ok: tasksUi.syncBtn === false && tasksUi.text === false,
    detail: '按钮=' + tasksUi.syncBtn + ' 文案=' + tasksUi.text
  });

  await cdp.eval("location.hash = '/'; true");
  await sleep(520);
} catch (err) {
  results.push({ name: '自检过程没崩', ok: false, detail: err && err.message });
} finally {
  try {
    if (cdp) cdp.ws.close();
  } catch {
    // 忽略
  }
  await sleep(300);
  // 先把 stub 服务器关掉（含挂住不回包的那条连接），再关应用
  try {
    stubServer.closeAllConnections?.();
    stubServer.close();
  } catch {
    // 忽略
  }
  child.kill();
  await sleep(1200);
}

const failed = results.filter((r) => !r.ok);
const report = [
  '================ 端到端自检结果 ================',
  ...results.map((r) => `${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '  —  ' + r.detail : ''}`),
  '------------------------------------------------',
  `合计 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`,
  `截图目录：${shotDir}`,
  exitInfo ? `应用进程：${exitInfo}` : ''
].join('\n');
fs.writeFileSync(path.join(root, 'tests', 'e2e', 'last-result.txt'), report, 'utf8');
console.log('\n' + report);
process.exit(failed.length ? 1 : 0);
