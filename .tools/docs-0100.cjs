/* 0.10.0 文档批量更新（CRLF 安全）。发布字节数回填由 .tools/docs-0100-link.cjs 做。
   说明：大段中文用单引号数组拼，避免模板字符串里的反引号被当成语法。 */
const fs = require('node:fs');
const L = (lines) => lines.join('\n');

function read(file) {
  const raw = fs.readFileSync(file, 'utf8');
  return { crlf: raw.includes('\r\n'), text: raw.includes('\r\n') ? raw.replace(/\r\n/g, '\n') : raw };
}
function save(file, ctx) {
  fs.writeFileSync(file, ctx.crlf ? ctx.text.replace(/\n/g, '\r\n') : ctx.text);
}
function patch(file, pairs) {
  const ctx = read(file);
  for (const [from, to] of pairs) {
    if (ctx.text.includes(to)) continue;
    if (!ctx.text.includes(from)) throw new Error('anchor missing in ' + file + ': ' + from.slice(0, 70));
    ctx.text = ctx.text.replace(from, to);
  }
  save(file, ctx);
  console.log('patched ' + file);
}

/* ---------- 版本号 ---------- */
patch('package.json', [['"version": "0.9.2"', '"version": "0.10.0"']]);
patch('package-lock.json', [
  ['"version": "0.9.2",\n  "lockfileVersion": 3', '"version": "0.10.0",\n  "lockfileVersion": 3'],
  [
    '"packages": {\n    "": {\n      "name": "jw-knowledge-base",\n      "version": "0.9.2"',
    '"packages": {\n    "": {\n      "name": "jw-knowledge-base",\n      "version": "0.10.0"'
  ]
]);

/* ---------- README ---------- */
const readmeGithubSection = L([
  '### 第十版（GitHub 集成：把 Issues 单向同步成待办，2026-10-19）',
  '',
  '把仓库里 Open / Closed 的 Issue 拉下来变成本地任务——**单向**：本地勾完、改优先级、删掉都不会回写 GitHub，误操作不会污染仓库。网络照旧只在主进程（`net.fetch`），渲染层零网络。',
  '',
  '**连接方式**：GitHub 官方 **Device Flow**（「在浏览器输入 8 位码」那种授权），不用手填 Token；拿到的 token 用 `safeStorage` 加密（Windows 上就是 DPAPI）后进 `kb.db`，**同机同用户**才能解，设置页只显示打码的 `gho…3456`。401 会提示「授权已过期」并自动把你带回设置页；403 限流会告诉你要等几分钟；404 说明仓库名错或没权限。',
  '',
  '| 部分 | 做了什么 | 你实际会看到什么 |',
  '|---|---|---|',
  '| **授权** | Device Flow 两个通道（拿设备码 / 轮询换 Token），轮询带 **15 分钟**超时和主动取消；断开连接只清 Token，本地任务一条不动。 | 设置页多一张「GitHub」卡片：连接 → 弹窗显示 8 位码 → 浏览器确认 → 卡片变「已连接 @你的账号」 |',
  '| **增量同步** | `per_page=100` 逐页拉到空，`since` 用 ISO 8601 只拉更新过的；按 `github_issue_id` 去重 **upsert**（存在就更新，不存在才新增），连续点两次不会多出一堆重复任务。 | 任务页「⇅ 同步 GitHub」点一下，完成后 toast：「同步完成：成功 2 个仓库，失败 1 个，新增 3 条任务，过滤掉 1 个 PR」 |',
  '| **多仓库与容错** | 仓库列表一行一个 `owner/repo`，前端校验格式（必须含 `/`、不能有空格）；主进程 `for...of` 串行拉，某个仓库 500 / 断网只记一行错误、**继续下一个**，不会整轮崩；主进程还有同步锁，正在同步时再点直接拒绝「同步正在进行中，请稍候」。 | 三个仓库同步时按钮显示「正在同步 (1/3)：owner/repo · 已拉取 N 条」，期间按钮 disabled 防连点 |',
  '| **映射与过滤** | `state=closed` → 已完成；`labels` 里有 `bug` → 优先级「重要」；带 `pull_request` 的对象是 PR，**过滤掉**（GitHub Issues API 会把 PR 混进来）；正文以纯文本写进任务备注（`来自 GitHub：owner/repo #N`），不把 Markdown 当 HTML 渲染。 | 同步下来的任务标题就是 Issue 标题，备注里有仓库、编号和链接；PR 不会变成任务 |',
  '| **数据库** | `SCHEMA_VERSION` 6→**7**：`task` 表加 `github_issue_id` / `github_updated_at` 两列 + 唯一部分索引；新表 `github_sync_meta` 存每个仓库的同步游标与上次错误。 | 老库打开自动迁移，不用重装、不用手动导数据 |',
  '',
  '**怎么验收这块**：见 [验收清单.md](验收清单.md) 的「第十版」；单测 `github-client.test.ts` / `github-sync.test.ts` 用假 `GithubFetcher` 验 PR 过滤、分页、401、串行部分失败、upsert 去重；e2e 用 `JWKB_GITHUB_CLIENT_ID` + 本地 stub 服务器把整条链路跑一遍（同步中按钮 disabled、连续两次不重复、401 自动回设置页、解绑不动任务）。',
  '',
  '逐条验收证据见 [验收清单.md](验收清单.md)，开发过程见 [开发计划.md](开发计划.md)，每个版本的变更见 [CHANGELOG.md](CHANGELOG.md)。'
]);

patch('README.md', [
  ['- 当前版本 **0.9.2**', '- 当前版本 **0.10.0**'],
  ['安装包：`C:\\JwKB\\setup\\Jw知识库-安装包-0.9.2.exe`', '安装包：`C:\\JwKB\\setup\\Jw知识库-安装包-0.10.0.exe`'],
  [
    '- 现在这一版：单测 **344** 项（24 个文件）、e2e **293** 项、强杀 **6** 项全过',
    '- 现在这一版：单测 **381** 项（26 个文件）、e2e **305** 项、强杀 **6** 项全过'
  ],
  [
    '逐条验收证据见 [验收清单.md](验收清单.md)，开发过程见 [开发计划.md](开发计划.md)，每个版本的变更见 [CHANGELOG.md](CHANGELOG.md)。',
    readmeGithubSection
  ],
  [
    '| ![品牌区](docs/screenshots/18-brand.png) | 侧栏左上角品牌区（0.9.2：24px 图标 + 单行「Jw 知识库」，不再被截断） |',
    L([
      '| ![品牌区](docs/screenshots/18-brand.png) | 侧栏左上角品牌区（0.9.2：24px 图标 + 单行「Jw 知识库」，不再被截断） |',
      '',
      '| GitHub 设置（授权状态 + Token 打码 + 仓库列表，0.10.0） |  |',
      '|---|---|',
      '| ![GitHub 设置](docs/screenshots/19-github.png) |  |'
    ])
  ]
]);

/* ---------- CHANGELOG ---------- */
const changelogEntry = L([
  '## [0.10.0] - 2026-10-19',
  '',
  '发布：[GitHub Release v0.10.0](https://github.com/x-000001/zhishiku/releases/tag/v0.10.0)（附件 JwKB-Setup-0.10.0.exe，__BYTES__ 字节）',
  '',
  '### 新增',
  '',
  '- **GitHub 集成（首期：Issues 单向增量同步成待办）**：',
  '  - 授权走 GitHub 官方 **Device Flow**（`github:request-code` / `github:poll-token`，15 分钟超时 + 主动取消 `github:cancel-auth`）；Token 用 `safeStorage` 加密存 `meta` 表（Windows 走 DPAPI），渲染层只拿到 `hasKey/tokenHint`；`github:logout` 只清 Token，本地任务不动。',
  '  - 设置页新增「GitHub」卡片：连接状态、打码 Token、`owner/repo` 多仓库输入（含 `/`、无空格校验）、Client ID（可用 `JWKB_GITHUB_CLIENT_ID` 注入）、断开连接。',
  '  - 任务页新增「⇅ 同步 GitHub」：主进程同步锁 + 按钮 loading/disabled 防连点、多仓库串行进度「正在同步 (1/3)：…」、完成 Toast 汇总「成功 X 个仓库，失败 Y 个，新增 N 条任务，过滤掉 K 个 PR」；401 自动回设置页并提示「授权已过期」。',
  '  - 同步引擎：`per_page=100` 逐页拉到空、`since` 增量、PR（含 `pull_request` 字段）过滤、`github_issue_id` 唯一索引 + upsert 去重、单仓库失败不拖垮整轮、`BEGIN…COMMIT` 事务。',
  '  - 映射：closed → 已完成；labels 含 `bug` → 优先级「重要」；Issue 正文以纯文本写入任务备注（不渲染 HTML，避免 XSS）。',
  '- 数据库：`SCHEMA_VERSION` 6→7 —— `task` 加 `github_issue_id` / `github_updated_at` + 唯一部分索引；新表 `github_sync_meta(repo, last_synced_at, last_error)`。',
  '- IPC：新增 `github:*` 9 个通道 + `github:progress` 推送事件。',
  '',
  '### 变更',
  '',
  '- 版本 0.9.2 → 0.10.0。',
  '',
  '### 验证',
  '',
  '- typecheck 0 错；单测 **381**（26 个文件；新增 `github-client.test.ts`、`github-sync.test.ts`）；e2e **305/305**（原有 293 条原样全过 + 12 条 `0.10.0：…` 新断言，`net.fetch` 全局 mock 走本地 stub，不连真 GitHub）；强杀 **6/6**；打包自检 **23/23**。',
  '',
  '## [0.9.2] - 2026-10-19'
]);
patch('CHANGELOG.md', [['## [0.9.2] - 2026-10-19', changelogEntry]]);

/* ---------- 验收清单 ---------- */
{
  const ctx = read('验收清单.md');
  ctx.text += '\n' + L([
    '## 第十版（0.10.0）· GitHub Issues 单向同步（2026-10-19）',
    '',
    '| # | 验收点 | 怎么验 | 结果 |',
    '|---|---|---|---|',
    '| 1 | 能连上 GitHub | 设置页点「连接 GitHub」→ 弹窗出 8 位码 → 浏览器确认 → 卡片变「已连接 @账号」 | 通过（e2e 用 stub 跑完整 Device Flow） |',
    '| 2 | Token 不进渲染层 | 设置页只显示 `gho…3456` + 「已加密」；`kb.db` 的 `meta.github.tokenEnc` 是密文 | 通过 |',
    '| 3 | 仓库格式校验 | 输入 `not a repo` 被丢掉，`octo/demo` 保留 | 通过 |',
    '| 4 | 同步出任务 | 任务页点同步 → 按钮 loading + disabled → 完成后 toast「成功 X / 失败 Y / 新增 N」 | 通过 |',
    '| 5 | 连续同步不重复 | 再点一次：新增 0 条，任务总数不变 | 通过 |',
    '| 6 | 映射正确 | closed 的 Issue → 已完成；labels 含 `bug` → 优先级「重要」；PR 不出现 | 通过 |',
    '| 7 | 多仓库容错 | 三个仓库其中一个 500：汇总「成功 2 / 失败 1」，不整轮崩 | 通过 |',
    '| 8 | 分页真的翻页 | 第一页正好 100 条时继续请求 `page=2` | 通过 |',
    '| 9 | 401 自愈 | Token 失效：中文提示「授权已过期」并自动跳设置页 | 通过 |',
    '| 10 | 解绑不动数据 | 断开连接后 Token 清空、任务一条不少 | 通过 |',
    '| 11 | 旧功能不回归 | typecheck 0；e2e 305/305（293 条旧断言原样全过） | 通过 |',
    '',
    '**验证**：typecheck 0 错；单测 381（26 个文件）；e2e 305/305（新增 12 条）；强杀 6/6；打包自检 23/23；安装包 `C:\\JwKB\\setup\\Jw知识库-安装包-0.10.0.exe`（__BYTES__ 字节）。',
    ''
  ]).replace(/\n$/, '\n');
  save('验收清单.md', ctx);
  console.log('appended 验收清单.md');
}

/* ---------- 开发计划 ---------- */
{
  const ctx = read('开发计划.md');
  ctx.text += '\n' + L([
    '## 第十版 · GitHub Issues 单向增量同步（0.10.0，2026-10-19）',
    '',
    '**为什么**：笔记、任务、复习都在本地闭环，唯一缺口是「代码仓库里的 issue 和待办之间要手动倒」。做成**单向**：GitHub → 本地任务，本地怎么改都不回写，避免把私人待办状态推到公共仓库。',
    '',
    '**架构决定**：',
    '- 网络照旧只在主进程：新建 `src/main/github.ts`（纯逻辑、`GithubFetcher` 可注入、单测用假 fetcher）+ `src/main/ipc/github.ts`（Device Flow、safeStorage、同步锁、`github:progress` 广播）；渲染层零网络。',
    '- Token 与 AI Key 同一套路（ADR-3）：`safeStorage.encryptString` → base64 存 `meta.github.tokenEnc`，跨用户 / 换机都解不开；设置页只有打码。',
    '- 同步引擎独立成 `src/main/github-sync.ts`（`syncGithubIssues(deps, repos)`），依赖注入 DB 的 `githubRepoMeta/saveGithubRepoMeta/runInTransaction/upsertGithubTask`，这样「串行 + 失败继续 + 单仓事务」能在单测里跑，不必起 Electron。',
    '',
    '**关键实现与坑**：',
    '- **PR 过滤**：GitHub Issues API 会把 PR 混进结果，判断依据是 `pull_request` 字段存在；过滤计入 `pruned`，汇总里显示「过滤掉 K 个 PR」。',
    '- **分页**：`per_page=100`，翻页直到空（短页也算到底，少发一次空请求）；`since` 用每个仓库上次的 `last_synced_at`（ISO 8601），只拉更新过的。',
    '- **防抖**：主进程模块级 `isSyncing` 锁，重复触发直接 reject「同步正在进行中，请稍候」；UI 侧按钮 loading + disabled 双保险。',
    '- **容错**：`for...of` 串行，单仓库抛错只记 `github_sync_meta.last_error` 并继续；只有**所有**仓库都 401 才当成授权失效回抛。',
    '- **去重**：`task.github_issue_id` 唯一部分索引 + `upsertGithubTask`（存在则更新标题/状态/优先级/截止日，已软删的跳过不复活）。',
    '- 正文只写纯文本进备注（`来自 GitHub：repo #N` + 链接），**不把 Issue 的 Markdown 当 HTML 渲染**——比「渲染后 sanitize」更安全，也少一条 XSS 面。',
    '',
    '**验证**：typecheck 0 错；单测 381（26 个文件，新增 `github-client.test.ts` / `github-sync.test.ts` 覆盖 PR 过滤、分页 100+空、401/403 限流、串行部分失败、upsert 去重）；e2e 305/305（本地 stub 模拟 OAuth + Issues，不连真 GitHub）；强杀 6/6；打包自检 23/23。',
    ''
  ]).replace(/\n$/, '\n');
  save('开发计划.md', ctx);
  console.log('appended 开发计划.md');
}

/* ---------- 功能分析文档 ---------- */
patch('功能分析文档.md', [
  [
    '| 对应版本 | 0.9.1（第五版 + 更新模块 + 标签全局管理 + 番茄钟 + AI 辅助 + 视觉门面） |',
    '| 对应版本 | 0.10.0（第五版 + 更新模块 + 标签全局管理 + 番茄钟 + AI 辅助 + 视觉门面 + GitHub 集成） |'
  ],
  ['### 4.1 18 张表', '### 4.1 20 张表'],
  ['- 当前 `SCHEMA_VERSION = 4`（`src/main/db.ts`）', '- 当前 `SCHEMA_VERSION = 7`（`src/main/db.ts`）'],
  [
    '| 数据层 | 19 张表、schema v6、幂等迁移（v2 补表补列 / v3 富文本与非空分类顺序回填 / v4 优先级文字化 / v5 标签索引 / v6 `focus_sessions`）',
    '| 数据层 | 20 张表、schema v7、幂等迁移（v2 补表补列 / v3 富文本与非空分类顺序回填 / v4 优先级文字化 / v5 标签索引 / v6 `focus_sessions` / v7 `github_sync_meta` + `task.github_issue_id`）'
  ],
  ['测试规模（当前）：单测 **261 项 / 19 个文件**、端到端 **261 项**', '测试规模（当前）：单测 **381 项 / 26 个文件**、端到端 **305 项**'],
  [
    '- **测试**（0.7.0 当前值）：`npm run test:unit`（**261** 项 / 19 个文件）、`npm run typecheck`（必须 0 错）、`node tests/e2e/cdp-check.mjs`（**261** 项）',
    '- **测试**（0.10.0 当前值）：`npm run test:unit`（**381** 项 / 26 个文件）、`npm run typecheck`（必须 0 错）、`node tests/e2e/cdp-check.mjs`（**305** 项）'
  ]
]);

{
  const ctx = read('功能分析文档.md');
  ctx.text += '\n' + L([
    '## 15. GitHub 集成（0.10.0，2026-10-19）',
    '',
    '### 15.1 边界与形态',
    '',
    '- **单向**：GitHub Issues → 本地任务。本地改状态 / 优先级 / 删除**都不回写** GitHub；接口里没有任何更新/删除远端 issue 的通道。',
    '- **首期只读 Issues**：不含 PR 评论、discussion、projects。',
    '- 网络请求只在主进程（ADR-4）：`src/main/github.ts` 用注入的 `GithubFetcher`（生产实现包 `net.fetch`）；渲染层只有 IPC。',
    '',
    '### 15.2 授权与安全',
    '',
    '- GitHub **OAuth Device Flow**：`github:request-code` 拿 `device_code / user_code / interval`，`github:poll-token` 轮询直到拿到 token（`authorization_pending` 继续、`slow_down` 加间隔、15 分钟超时），`github:cancel-auth` 主动取消。',
    '- Token 存 `meta.github.tokenEnc`（`safeStorage.encryptString` → base64；不可用时降级明文并标「未加密」）；`githubStatus()` 只回 `hasKey / tokenHint / encrypted`，渲染层拿不到明文。',
    '- Client ID 来源优先级：`JWKB_GITHUB_CLIENT_ID` 环境变量 → 设置页 `github.clientId`；没有时连接按钮禁用并说明原因。测试可用 `JWKB_GITHUB_API_BASE / JWKB_GITHUB_OAUTH_BASE` 指向本地 stub。',
    '- `github:open-url` 只放行 `https://github.com/**`（防止变成任意 URL 打开器）。',
    '',
    '### 15.3 同步语义',
    '',
    '- 仓库列表：`owner/repo`，`parseRepoList` 去重、丢非法项；前端与主进程都校验。',
    '- 每个仓库一次「拉取 → 事务写入」；`since` 取该仓库 `github_sync_meta.last_synced_at`（ISO 8601），成功后推进，失败只记 `last_error` 并继续下一个仓库。',
    '- 分页 `per_page=100`，逐页拉到空；带 `pull_request` 的对象是 PR，过滤并计数。',
    '- 写入：`upsertGithubTask` 按 `github_issue_id`（唯一部分索引）更新或新增；已软删的任务不复活。',
    "- 映射：`state === 'closed'` → 已完成（`completed_at = closed_at`）；labels 命中 `bug` → 优先级 `important`；`milestone.due_on` → `due_at`（取前 10 位）；正文转纯文本写进 `note`。",
    '- 主进程同步锁：同一次运行内重复触发直接失败（中文「同步正在进行中，请稍候」）。',
    '- 汇总：`{repoTotal, succeeded, failed, fetched, created, updated, skipped, pruned, authExpired}` 由 `formatSyncSummary()` 生成中文 toast。',
    '',
    '### 15.4 数据层与事件',
    '',
    '- `SCHEMA_VERSION = 7`：`task.github_issue_id`、`task.github_updated_at`、唯一部分索引 `idx_task_github_issue`；新表 `github_sync_meta(repo PK, last_synced_at, last_error)`。',
    "- 推送事件 `github:progress`（`{phase:'start'|'repo'|'done', repoIndex, repoTotal, repo, fetched}`）→ 任务页显示「正在同步 (i/n)：repo · 已拉取 k 条」。",
    ''
  ]).replace(/\n$/, '\n');
  save('功能分析文档.md', ctx);
  console.log('appended 功能分析文档.md');
}

/* ---------- DEVELOPER_GUIDE ---------- */
const guideGithubNavRow = L([
  '| **新增 IPC 通道** | 域文件 `src/main/ipc/*.ts` + 注册 `src/main/ipc/index.ts:37-47` + 渲染层封装 `src/renderer/src/api.ts:111` | 事件型通道还要加 `src/preload/index.ts:3-11` 白名单 |',
  '| **改 GitHub 同步 / 授权** | 主进程 `src/main/github.ts`（请求/分页/映射）、`src/main/github-sync.ts`（串行+事务）、`src/main/ipc/github.ts`（Device Flow/Token/锁）、渲染层 `src/renderer/src/github.tsx`（设置卡）、`src/renderer/src/pages/Tasks.tsx`（同步按钮） | 同步语义见 §5.5；Token 加密见 ADR-3 |'
]);

const guideEnvLine = L([
  '- 渲染层唯一的环境差异是 dev 地址（`ELECTRON_RENDERER_URL`），且只在主进程用（`src/main/index.ts:179`）。',
  '- GitHub 集成另有三个测试/自建 App 用的变量：`JWKB_GITHUB_CLIENT_ID`（OAuth App 的 Client ID）、`JWKB_GITHUB_API_BASE`、`JWKB_GITHUB_OAUTH_BASE`（默认 `https://api.github.com` / `https://github.com`，e2e 指向本地 stub），读取点在 `src/main/ipc/github.ts` 的 `clientIdOf/apiBase/oauthBase`。'
]);

const guideGitHubSection = L([
  '### 5.5 GitHub 同步的游标、锁与增量语义',
  '',
  '- 游标按仓库存在 `github_sync_meta.last_synced_at`；每次成功同步该仓库后推进，失败只写 `last_error` 并继续下一个仓库（`src/main/github-sync.ts`）。',
  '- 同步锁是主进程模块级开关（`src/main/ipc/github.ts`）：正在同步时再次 `github:sync` 直接失败，文案「同步正在进行中，请稍候」。',
  '- 去重键 `task.github_issue_id`（唯一部分索引）+ `upsertGithubTask`；已软删的任务不会被复活。',
  '- PR 混在 Issues API 里：任何带 `pull_request` 字段的对象都必须过滤，并计入 `pruned`。',
  '- `since` 必须 ISO 8601（`toSinceIso()` 负责转换），GitHub 会拒绝其它格式。',
  '- Issue 正文写成**纯文本**进 `note`，不要直接渲染 Markdown/HTML；确实要渲染时必须先过 `sanitizeHtml()`（§8.5）。'
]);

const guideSafeLine = L([
  '- 笔记 HTML 必须过 `sanitizeHtml()`（`src/shared/html.ts:201`），渲染时禁止直接 `dangerouslySetInnerHTML` 未经清洗的内容。',
  '- GitHub 同步是**单向**的：只允许「远端 → 本地」，不给渲染层任何回写远端 Issue 的通道；Token 只以密文存 `meta`（§ADR-3），不要把 token 放进 IPC 返回值。'
]);

patch('DEVELOPER_GUIDE.md', [
  [
    '表结构在 `src/main/schema.ts:9`（19 张表 + 1 张 FTS5 虚表 `note_fts`）。',
    '表结构在 `src/main/schema.ts:9`（20 张表 + 1 张 FTS5 虚表 `note_fts`；schema 版本 `SCHEMA_VERSION = 7`）。'
  ],
  ['### ADR-6 IPC 统一信封 + 单点注册（124 个通道）', '### ADR-6 IPC 统一信封 + 单点注册（133 个通道）'],
  [
    '- 通道规模（机器统计）：**124** 个；按域：notes 25、goals 20、review 15、tasks 15、system 15、plans 11、focus 7、update 6、ai 5、core 3、export 2。',
    '- 通道规模（机器统计）：**133** 个；按域：notes 25、goals 20、review 15、tasks 15、system 15、plans 11、focus 7、update 6、ai 5、core 3、export 2、github 9。'
  ],
  [
    '| **新增 IPC 通道** | 域文件 `src/main/ipc/*.ts` + 注册 `src/main/ipc/index.ts:37-47` + 渲染层封装 `src/renderer/src/api.ts:111` | 事件型通道还要加 `src/preload/index.ts:3-11` 白名单 |',
    guideGithubNavRow
  ],
  [
    '- 渲染层唯一的环境差异是 dev 地址（`ELECTRON_RENDERER_URL`），且只在主进程用（`src/main/index.ts:179`）。',
    guideEnvLine
  ],
  [
    '笔记正文里 `<img src="jw-att://attachments/2026-10/a.png">`，主进程把它映射到数据目录真实文件，并做「只在数据目录内」的越界检查（`src/main/index.ts:40-61`）。改附件路径逻辑要同时动 `src/shared/html.ts:22-49`（`attachmentUrl/attachmentRelFromUrl`）。',
    L([
      '笔记正文里 `<img src="jw-att://attachments/2026-10/a.png">`，主进程把它映射到数据目录真实文件，并做「只在数据目录内」的越界检查（`src/main/index.ts:40-61`）。改附件路径逻辑要同时动 `src/shared/html.ts:22-49`（`attachmentUrl/attachmentRelFromUrl`）。',
      '',
      guideGitHubSection
    ])
  ],
  [
    '同类实现：标签重命名合并 `src/main/db.ts:877-911`、标签删除 `src/main/db.ts:912-933`、迁移 v3 批量回填 `src/main/db.ts:244-252`。**新写多语句操作时照抄这个形状**，不要指望 `DatabaseSync` 自动事务。',
    '同类实现：标签重命名合并 `src/main/db.ts:877-911`、标签删除 `src/main/db.ts:912-933`、迁移 v3 批量回填 `src/main/db.ts:244-252`、GitHub 单仓库同步写入（`src/main/github-sync.ts` 的 `runInTransaction`）。**新写多语句操作时照抄这个形状**，不要指望 `DatabaseSync` 自动事务。'
  ],
  [
    '- 笔记 HTML 必须过 `sanitizeHtml()`（`src/shared/html.ts:201`），渲染时禁止直接 `dangerouslySetInnerHTML` 未经清洗的内容。',
    guideSafeLine
  ],
  [
    "4. 如果是**主进程主动推送**的事件：`webContents.send('域:事件', payload)` + 把通道名加进 `src/preload/index.ts:3-11` 的 `ALLOWED_EVENTS` + 在 `api.ts` 加 `onXxx(listener)`（参考 `onAiStream`）。",
    "4. 如果是**主进程主动推送**的事件：`webContents.send('域:事件', payload)` + 把通道名加进 `src/preload/index.ts:3-11` 的 `ALLOWED_EVENTS` + 在 `api.ts` 加 `onXxx(listener)`（参考 `onAiStream` / `onGithubProgress`）。"
  ],
  ['## 附录 B：IPC 通道按域（124 个）', '## 附录 B：IPC 通道按域（133 个）'],
  [
    '| export（导出 Markdown） | 2 | `src/main/ipc/export.ts` |',
    '| export（导出 Markdown） | 2 | `src/main/ipc/export.ts` |\n| github（授权/配置/同步/解绑） | 9 | `src/main/ipc/github.ts` |'
  ]
]);

/* ---------- 安装包使用说明模板 ---------- */
{
  const ctx = read('.tools/build-installer.mjs');
  const marker = '更多功能：';
  if (!ctx.text.includes(marker)) throw new Error('installer template marker missing');
  ctx.text = ctx.text.replace(
    marker,
    L([
      '更多功能：',
      '- 「任务待办」页右上角有「⇅ 同步 GitHub」：先在「设置 → GitHub」用 GitHub 官方授权连上，再把仓库写成 owner/repo、一行一个；点同步就把那边 Open / Closed 的 Issue 拉成待办（单向，不回写）。'
    ])
  );
  save('.tools/build-installer.mjs', ctx);
  console.log('patched installer template');
}

/* ---------- 截图 ---------- */
fs.copyFileSync('tests/e2e/shots/github-settings.png', 'docs/screenshots/19-github.png');
console.log('copied docs/screenshots/19-github.png');
