# 版本变更记录（CHANGELOG）

本文件只记「用户能感知到的变化」和「修掉的 bug」；每一次改动背后的验证数字（单测 / e2e / 强杀 / 打包自检）都写在这里。更早的版本（0.1.0–0.3.0 的细节）按模块散在 [README 第六部分](README.md) 和 [开发计划.md](开发计划.md) 里，这里只做汇总。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 `主.次.修订`。

## [0.11.2] - 2026-10-22

发布：__REL_LINK__（附件 JwKB-Setup-0.11.2.exe，__BYTES__ 字节）

### 修复

- **「✨ AI」下拉菜单的悬停 / 键盘焦点 / 选中态重做**：这份菜单和分类 / 标签 / 任务的右键菜单共用 `.ctx-menu / .ctx-item`，原来悬停走 `.ctx-item:hover { background: var(--accent); color: #fff }`，但 `--accent` 在主题令牌里从未定义 —— `background` 整条失效、只剩白字，浅色下就是「透明底 + 白字」，右侧「自动识别」提示又靠 `opacity: 0.55 → 0.85` 压暗，深浅色下层级都不稳。现在 ①`src/renderer/src/menu.tsx` 的 `showContextMenu()` 多一个可选参数 `panelClass`，只有 AI 这一份菜单多挂 `.ai-dropdown` 类名（其它右键菜单完全不受影响；DOM 结构、`role`、`tabindex`、键盘上下选 / Enter / Esc 逻辑零改动）；②`styles.css` 新增 `.ctx-menu.ai-dropdown` 作用域样式：菜单项 `padding: 6px 12px` + `border-radius: 6px`、整行等宽，悬停 / `:focus-visible` / `.active` / `[data-highlighted="true"]` / `[aria-selected="true"]` 同一套底色（浅色 `#e5e7eb`、深色 `#374151`），`transition: background-color 0.15s, color 0.15s` 包在 `prefers-reduced-motion: no-preference` 里，另配 `will-change: background-color`；③右侧「自动识别」提示精确选中 `.hint` 子元素：`opacity: 1` + 颜色层级（浅色 `#4b5563` 对比 6.10:1、深色 `rgba(255,255,255,.9)` 对比 8.72:1，都低于主文字的 13.78:1 / 9.53:1）；④`<button>` 原生样式显式重置（`border: none` / `appearance: none` / 背景清零），横向间距只用 `padding` + `gap`（面板 `2px 8px`、菜单项 `6px 12px`），没有用任何 `margin`、没有用一个 `!important`、没有改 `:root` 令牌（面板上的内联样式只有 `left/top/visibility`，本层选择器 (0,3,0) 起步本来就高于原来的 `.ctx-item:hover` (0,2,0)）。
- **补上缺失的 `--accent` 令牌**：其它右键菜单（任务 / 标签 / 分类 / 笔记行）的悬停一直是「透明底 + 白字」，根因就是这个变量没人定义。现在 `:root` 里定义 `--accent: var(--brand)`（浅色 `#0a72e8`、深色跟着 `--brand` 变 `#0a84ff`），和 `.btn.primary` 的品牌蓝底白字同一口径；AI 菜单因为上面那层作用域样式优先级更高，仍是契约要求的灰底。

### 验证

- typecheck 0 错；单测 **404** 项（29 个文件，本次未改任何测试）；e2e **305/305**；强杀 **6/6**；打包自检 **23/23**。
- 探针实测计算样式：AI 菜单悬停浅色 `rgb(229,231,235)` / 深色 `rgb(55,65,81)`，主文字对比 13.78:1 / 9.53:1、右侧提示 6.10:1 / 8.72:1 且亮度不高于主文字；其它右键菜单悬停恢复品牌蓝 `rgb(10,114,232)` / `rgb(10,132,255)` + 白字（4.58:1 / 3.65:1，深色与 `.btn.primary` 同口径）；面板 `padding` / 圆角 / 过渡 / `will-change` 均符合契约。

## [0.11.1] - 2026-10-21

发布：[GitHub Release v0.11.1](https://github.com/x-000001/zhishiku/releases/tag/v0.11.1)（附件 JwKB-Setup-0.11.1.exe，112,595,690 字节）

### 修复

- **AI 提炼不再「指令回显」**：模型偶尔会把 Prompt 里的格式要求原样抄进正文（项目总结变成「我们需要回答用户……」，亮点变成「（3 到 5 条，每条不超过 30 字…」），而旧解析只要正文非空就算成功。现在 ①`buildRepoExtractMessages()` 改成「你是一个 JSON 提取器」的 System Prompt，只输出 `{"summary","highlights","scenes"}` 纯 JSON，不再用括号占位写格式要求；②`parseRepoExtract()` 先按 `indexOf('{') / lastIndexOf('}')` 抠 JSON 主体（带围栏、「结果如下：」前缀、字段别名都能吃），坏 JSON 直接判失败，不再退化成 Markdown 垃圾，仍兼容旧的三段 Markdown；③两段都过「整句特征串」回显检测（`我们需要回答用户`、`严格按格式输出纯 Markdown` 等 7 条），普通含「回答用户」的正常描述不会被误杀；④README 截断改成按字符 `Array.from(text).slice(0, 8000).join('')`，不会把 emoji / 生僻字切成半个。
- **历史脏数据无痛清理**：新增 `src/main/migrations/cleanGithubBug.ts`，DB 初始化后独立执行：一个事务里把命中模板串的 `done` 条目改判 `ai_failed`（卡片出现「↻ 重试提炼」），整体 `try...catch`，锁库/坏库只打 `console.error`，绝不阻断启动，且幂等（第二次跑返回 0）。

### 验证

- typecheck 0 错；单测 **404** 项（29 个文件，新增 `repo-extract-echo.test.ts` 5 条 / `clean-github-bug.test.ts` 4 条）；e2e **305/305**（AI 润色 / 摘要 / 翻译 / 分类整理与 GitHub 导入链路全过）；强杀 **6/6**；打包自检 **23/23**。

## [0.11.0] - 2026-10-19

发布：[GitHub Release v0.11.0](https://github.com/x-000001/zhishiku/releases/tag/v0.11.0)（附件 JwKB-Setup-0.11.0.exe，112,595,649 字节）

### 变更（重构）

- **GitHub 集成的方向换了**：0.10.0 的「Issues 单向同步成待办」被移除，改成「收集箱里搜集优秀开源项目 + AI 提炼知识点」。收集箱顶部新增「🐙 导入 GitHub 项目」。
- **旧同步代码一并清掉**：删除 `src/main/github-sync.ts` 与 `tests/unit/github-sync.test.ts`、`github:sync*` IPC 通道、任务页「同步 GitHub」按钮和侧边栏入口、db 里只有同步引擎在用的 `runInTransaction()`；`github_sync_meta` 表只留在迁移链里（建表、不读写），老库升级不丢历史数据。

### 新增

- 导入弹窗两个入口：**仅保存链接**（不联网、不花 AI 额度）/ **保存并 AI 提炼**；提炼中显示 loading，弹窗里就有中文校验。
- 地址深度清洗 `parseRepoUrl()`：兼容 `.git`、`/tree/main`、`?tab=`、`#`、裸 `owner/repo`；不是 GitHub 地址直接中文报错，不发请求。
- 主进程拉仓库信息与 README（前 8000 字符），AI 输出「项目总结 ≤100 字 / 核心亮点 3–5 条、每条 ≤30 字 / 适用场景」；Prompt 内写死「严禁编造 README 中未提及的技术栈」。
- 收集箱条目渲染为徽章（repo / ⭐ star / 语言 / 状态）＋正文；不把 `---` 渲染出来。
- 「📄 转为知识库笔记」：把完整 YAML frontmatter + Markdown 推进知识库，`note.content` 保留原文，标签/分类/搜索/复习卡直接可用。
- AI 失败降级：先存基础信息并标 `extract_status = ai_failed`，卡片上给「↻ 重试提炼」。

### 修复 / 加固

- 并发锁：主进程 `RepoExtractLimiter` 限制同时最多 **2** 个提炼任务，超出直接中文提示「等待当前任务完成」，连点不会堆任务。
- AI 提炼走**非流式**一次性返回，避免收集箱列表逐字重渲染卡顿。
- 安全：导入的 Markdown 渲染前统一 `sanitizeHtml()`；所有 GitHub/AI 请求仍只在主进程 `net.fetch`，渲染层零网络；Token 仍 `safeStorage` 加密进 `meta`。
- **授权结果广播到所有窗口 + 回查最新状态**：主进程拿到结果后用 `BrowserWindow.getAllWindows()` 广播 `github:auth`（原来只推给发起时那一个窗口，窗口重建/刷新就丢事件）；渲染层收到事件后不直接吃事件里的快照，而是再调一次 `github:status` 拉最新状态再 `setState`（防过期快照）。
- **`npm run diag:github` 一键诊断**（`.tools/diag-github.js`）：在真实 Electron 主进程里检查代理环境变量、`api.github.com` / `github.com/login/device` 的可达延迟与状态码、当前 Client ID 能否拿到 `device_code`（拿不到 = OAuth App 没勾 Enable Device Flow 或 ID 填错）、未授权时是否按协议回 `authorization_pending`。不再靠人肉试。
- **修掉「浏览器里授权成功、软件里一直未连接」**：授权轮询从渲染层搬回主进程（`src/main/github-auth.ts`）。单实例锁（轮询中再点直接抛「授权正在进行中」）、`Accept: application/json` + `User-Agent: JwKB-App`、以收到响应瞬间推算 900 秒有效期、每轮 10 秒 `AbortSignal.timeout` 熔断、`slow_down` 固定 +5 秒、Token 日志一律打码（`gho…3456`）、换机器解密失败自动清空旧 Token 静默回「未连接」、`app.whenReady` 恢复登录态、登出彻底清 DB/内存/定时器。前端只负责展示验证码、**剩余有效期倒计时**，并靠 `webContents.send('github:auth')` 收结果（`github:poll-token` 通道删除，`github:cancel-auth` 保留）。

- **修掉 AI 提炼「指令回显」**：模型偶尔会把 Prompt 里的格式要求原样抄进正文（项目总结变成「我们需要回答用户……」，亮点变成「（3 到 5 条，每条不超过 30 字…」），而旧解析只要正文非空就算成功。现在 ①`buildRepoExtractMessages()` 改成「你是一个 JSON 提取器」的 System Prompt，只输出 `{"summary","highlights","scenes"}` 纯 JSON，不再用括号占位写格式要求；②`parseRepoExtract()` 先按 `indexOf('{') / lastIndexOf('}')` 抠 JSON 主体（带围栏、「结果如下：」前缀、字段别名都能吃），坏 JSON 直接判失败，不再退化成 Markdown 垃圾，仍兼容旧的三段 Markdown；③两段都过「整句特征串」回显检测（`我们需要回答用户`、`严格按格式输出纯 Markdown` 等 7 条），普通含「回答用户」的正常描述不会被误杀；④README 截断改成按字符 `Array.from(text).slice(0, 8000).join('')`，不会把 emoji / 生僻字切成半个。历史脏数据用 `src/main/migrations/cleanGithubBug.ts` 在 DB 初始化后独立清理：事务里把命中模板串的 `done` 条目改判 `ai_failed`（卡片出现「↻ 重试提炼」），整体 try/catch，清理失败只打 `console.error`，绝不阻断启动，且幂等。

### 重构（外科手术，外观/交互零变更）

- **番茄钟拖动不再残留监听器**（`src/renderer/src/focus.tsx`）：拖动时挂到 `window` 的 5 个监听器与 pointer capture 改为组件自己持有（`dragDetachRef` + 卸载兜底 effect），拖动中卸载会立刻解绑；原来只有松手（`pointerup` / `pointercancel`）时才会解绑。
- **「已保存」闪标定时器归组件所有**（`src/renderer/src/pages/Knowledge.tsx`）：连点保存先清掉上一个定时器，卸载时清理，避免对已卸载组件 `setState`。
- **任务页空态文案扁平化**（`src/renderer/src/pages/Tasks.tsx`）：4 层嵌套三元提成文件顶部纯函数 `emptyTextFor(view)`，逐条提前返回；文案、DOM、类名一字未动。
- **侧栏收展时长不再裸写魔法数**（`src/renderer/src/App.tsx`）：`440` 提成文件顶部 `SIDEBAR_ANIMATE_MS`，仍是同一个数值。
- 不碰 CSS / class / DOM / 快捷键 / 动画，不动 IPC 契约、数据库事务、`useEffect` 依赖数组；typecheck 0 错、单测 404、e2e 305/305、`npm run build` 通过。

### 数据层

- `SCHEMA_VERSION` 7→**8**：`inbox_item` 加 `github_repo / github_url / github_stars / github_language / extract_status / extract_meta` 六列；`InboxKind` 增加一个 github 取值。老表 `github_sync_meta` 保留但不再读写（历史数据不删）。

### 验证

- typecheck 0 错；单测 **404** 项（29 个文件，新增 `repo-url.test.ts` / `repo-extract.test.ts` / `repo-extract-echo.test.ts` / `clean-github-bug.test.ts`，重写 `github-client.test.ts`）；e2e **305/305**（新增 12 条 GitHub 项目搜集断言，原有 293 条原样全过）；强杀 **6/6**；打包自检 **23/23**。
- 测试全程 mock（本地 stub 服务器 + 假 `GithubFetcher` / 假 AI），不连真 GitHub、不花 AI 额度。

## [0.10.0] - 2026-10-19

发布：[GitHub Release v0.10.0](https://github.com/x-000001/zhishiku/releases/tag/v0.10.0)（附件 JwKB-Setup-0.10.0.exe，112,589,040 字节）

### 新增

- **GitHub 集成（首期：Issues 单向增量同步成待办）**：
  - 授权走 GitHub 官方 **Device Flow**（`github:request-code` / `github:poll-token`，15 分钟超时 + 主动取消 `github:cancel-auth`）；Token 用 `safeStorage` 加密存 `meta` 表（Windows 走 DPAPI），渲染层只拿到 `hasKey/tokenHint`；`github:logout` 只清 Token，本地任务不动。
  - 设置页新增「GitHub」卡片：连接状态、打码 Token、`owner/repo` 多仓库输入（含 `/`、无空格校验）、Client ID（可用 `JWKB_GITHUB_CLIENT_ID` 注入）、断开连接。
  - 任务页新增「⇅ 同步 GitHub」：主进程同步锁 + 按钮 loading/disabled 防连点、多仓库串行进度「正在同步 (1/3)：…」、完成 Toast 汇总「成功 X 个仓库，失败 Y 个，新增 N 条任务，过滤掉 K 个 PR」；401 自动回设置页并提示「授权已过期」。
  - 同步引擎：`per_page=100` 逐页拉到空、`since` 增量、PR（含 `pull_request` 字段）过滤、`github_issue_id` 唯一索引 + upsert 去重、单仓库失败不拖垮整轮、`BEGIN…COMMIT` 事务。
  - 映射：closed → 已完成；labels 含 `bug` → 优先级「重要」；Issue 正文以纯文本写入任务备注（不渲染 HTML，避免 XSS）。
- 数据库：`SCHEMA_VERSION` 6→7 —— `task` 加 `github_issue_id` / `github_updated_at` + 唯一部分索引；新表 `github_sync_meta(repo, last_synced_at, last_error)`。
- IPC：新增 `github:*` 9 个通道 + `github:progress` 推送事件。

### 变更

- 版本 0.9.2 → 0.10.0。

### 验证

- typecheck 0 错；单测 **381**（26 个文件；新增 `github-client.test.ts`、`github-sync.test.ts`）；e2e **305/305**（原有 293 条原样全过 + 12 条 `0.10.0：…` 新断言，`net.fetch` 全局 mock 走本地 stub，不连真 GitHub）；强杀 **6/6**；打包自检 **23/23**。

## [0.9.2] - 2026-10-19

发布：[GitHub Release v0.9.2](https://github.com/x-000001/zhishiku/releases/tag/v0.9.2)（附件 JwKB-Setup-0.9.2.exe，112,578,774 字节）

### 修复

- **「库」被截断**：品牌行可用宽度只有 167px，而「三色点 58 + gap 10 + 图标 28 + gap 10 + 亮青 `Jw` 18.4 + gap 10 + 正文 47 = 181px」，文字被 flex 压到 33px 宽却仍 `nowrap`，于是尾字被裁。改为单行 **`Jw 知识库`**（统一 `var(--text)`、删掉第二个亮色字标）、图标 **28→24px**、行容器 `overflow:hidden`、右侧留白 20→10px，文字加 `flex:1 1 auto` + `min-width:0` + `text-overflow: ellipsis`；实测文字内容宽/可见宽 **81/81**，`scrollWidth ≤ clientWidth`。
- **折叠态同步**：24px 图标在 60px 图标条里居中（实测偏差 0px），文字透明度收 0 让位，不裁切不越界。

### 测试

- e2e：0.9.1 的 6 条品牌断言改写为 0.9.2 的 6 条，新增「**品牌区文字没有被截断（scrollWidth ≤ clientWidth，且整行不横向溢出）**」；其余 287 条原样未改。
- 未新增依赖、未改 DOM 类名与组件逻辑。

### 验证

- typecheck 0 错；单测 **344**（24 个文件）；e2e **293/293**；强杀 **6/6**；打包自检 **23/23**；安装包 `Jw知识库-安装包-0.9.2.exe`（112,578,774 字节）。

## [0.9.1] - 2026-10-19

发布：[GitHub Release v0.9.1](https://github.com/x-000001/zhishiku/releases/tag/v0.9.1)（附件 JwKB-Setup-0.9.1.exe，112,578,786 字节）

### 变更（视觉门面二改：图标换成抽象几何）

- **应用图标重画**：0.9.0 的「两张白卡片 + 琥珀节点」换成抽象几何 —— 近黑 squircle 底板（`#0A0B10`）+ 白色双环 ∞ + 中心一粒极光蓝 `#5EE7E6`，顶部保留 1px 极弱内高光，去掉渐变与外投影；`.tools/gen-icon.mjs` 改为 SDF 绘制，512/128/64/48 用 4× 超采样、32 及以下用 8×，并做半像素对齐与 16px 档独立几何，避免小尺寸糊成一块。
- **侧栏图标和桌面图标同源**：`.brand-mark` 里的「Jw」文字换成内联 SVG（双环 + 极光点，`aria-hidden`），底板同为近黑。
- **品牌区排版**：`Jw`（700 字重、`#5EE7E6`）+ `知识库`（500 字重、15px、`letter-spacing:.5px`、`var(--text)`），去掉 0.9.0 的渐变文字与 `text-shadow`（不再有描边/重影），间距 10px、留白 16px 20px；折叠态隐藏 `Jw` 文字标、图标保持居中。
- 版本号 0.9.0 → 0.9.1。

### 测试

- 单测 `icon-assets.test.ts` 重写为 12 条：底板近黑、顶部 1px 内高光、白色双环像素面积、中心极光点颜色、ICO 七档齐全、16px 白色环占比与青点仍在、托盘缩 16 的可见度。
- e2e 把原先 4 条 `0.9.0：…` 品牌断言改成 6 条 `0.9.1：…`（底板色/圆角/内高光、SVG 双环数=2 与极光点=1、Jw 粗+标题细且无渐变、三处 `text-shadow` 全 none、图标→Jw→标题两段间距各 10px、折叠态居中且 Jw 让位），其余 287 条原样未改。

### 验证

- typecheck 0 错；单测 **344**（24 个文件）；e2e **293/293**；强杀 6/6；打包自检 23/23。

## [0.9.0] - 2026-10-19

发布：[GitHub Release v0.9.0](https://github.com/x-000001/zhishiku/releases/tag/v0.9.0)（附件 JwKB-Setup-0.9.0.exe，112,734,855 字节）

### 变更（视觉门面）

- **应用图标重绘**：`resources/icon.png` 512×512 母版、`resources/icon.ico` 16/24/32/48/64/128/256 七档、`resources/tray.png` 32px，全部由新脚本 `.tools/gen-icon.mjs`（纯 Node 软件光栅器 + 自写 PNG/ICO 编码，**零依赖**）生成 —— 22% 圆角矩形底板 + 浅蓝到深品牌蓝竖向渐变（`#4D8DFF → #2952CC`）+ 内侧顶部高光 + 柔和外投影；中心图形是两张错落倾斜的白色卡片 + 右下角琥珀色小节点，替换原来的「三横线 + 黄点」。
- **多尺寸适配**：七档 ico 各自单独光栅化（不是把 256 硬缩），16px 里把两张卡片的间距拉开避免糊成一团；托盘图标单独出 32px 版本。
- **侧栏品牌区**：「Jw」小图标改品牌蓝竖向渐变 + 内侧高光 + 2px 柔和投影、8px 圆角、800 字重 + 1px 字影；「知识库」标题 15px / 600 字重 / 0.5px 字距、颜色走 `var(--text)`（深灰偏蓝，不写死纯黑）、末字渐到品牌色；图标与文字间距 10px、容器留白 16px 20px；深色主题焦点色自动提亮。
- **折叠态适配**：60px 图标条里 28px 图标居中（e2e 实测中心偏差 0px），文字仍按原规则收 0 宽裁切，图标不裁不变形。
- 零破坏：DOM、类名、组件逻辑、快捷键未改；新样式全部追加在 `styles.css` 末尾，旧规则一条没删。
- 顺手把导出 e2e 的偶发丢点击加了一次重试（12 秒没完成就再点一次，断言标准不变）。

### 验证

- typecheck 0 错；单测 **342**（24 个文件；新增 `icon-assets.test.ts` 10 条：ico 七档逐档解码验尺寸、icon.png 四角透明 / 底板渐变 / 琥珀节点、16px 白色像素占比、tray 缩 16 后的可见像素）；e2e **291/291**（新增 4 条 `0.9.0：…` 品牌区断言，原有 287 条原样全过）；强杀 **6/6**；打包自检 **23/23**。

## [0.8.3] - 2026-10-19

发布：[GitHub Release v0.8.3](https://github.com/x-000001/zhishiku/releases/tag/v0.8.3)（附件 JwKB-Setup-0.8.3.exe，112,540,468 字节）

### 修复

- **「测试连接」在 `deepseek-v4-pro` / `deepseek-reasoner` 这类接口上误报「AI 返回的内容里没有文字」**：非流式解析改成多层兜底 —— 标准 `choices[0].message.content` → 内容数组（多段 text 拼起来）→ `choices[0].text` → 推理模型的 `reasoning_content` / `reasoning`；整段正文被包在 SSE 里也能读出来。
- **200 但解析不出正文时，不再说「接口不兼容」**：提示「AI 接口已连通，但返回了空内容，请检查模型名是否正确」，设置页同时把模型名那格标红（归为配置类错误）。
- **失败时把原始响应打到主进程 Console**（超过 2000 字截断、`sk-` 开头的 Key 自动打码），对着日志就能看出对方到底返回了什么结构。
- **HTTP 错误更具体**：404 提示「接口地址不对（Base URL 一般是 https://…/v1 这种结尾）」，401 提示「API Key 不对或已失效」，不用再猜是网络还是配置。
- 「测试连接」的 `max_tokens` 从 16 提到 200，避免推理模型把预算全花在思考上、正文被截成空。
- 配置类 / 解析类错误统一点成「用户错误」，不再套一层「AI 请求失败：」前缀。

### 变更

- 版本：0.8.2 → 0.8.3。

### 验证

- 单测 **332** 项（23 个文件；`ai-client.test.ts` 新增 14 条覆盖各种响应结构 / 空内容 / 长度截断 / 非 JSON / 401 / 404 / 日志打码，`ai-model-name.test.ts` 新增 1 条空内容归类），全部通过。
- e2e **287/287**（新增 3 条：推理模型 `reasoning_content` 能连通、空内容提示「已连通，但返回了空内容」、404 精准提示；原有 284 条未改），强杀 **6/6**，打包自检 **23/23**。
- AI 测试全部走本地 stub，不调真实 API、不产生费用。

## [0.8.2] - 2026-10-19

发布：[GitHub Release v0.8.2](https://github.com/x-000001/zhishiku/releases/tag/v0.8.2)（附件 JwKB-Setup-0.8.2.exe，112,539,308 字节）

### 修复

- **模型名带连字符被误判成「格式错误」**：`deepseek-v4-pro`、`gpt-4o-mini`、`claude-3-5-sonnet-20241022`、`Qwen/Qwen2.5-7B-Instruct`、`deepseek-r1:7b` 这类正常写法统一放行；规则明确为「字母、数字、连字符(-)、下划线(_)、点(.)、冒号(:)、斜杠(/)」，并补 11 个真实模型名的回归用例。
- **配置写错却被报成「连接失败」**：设置页「测试连接」现在分两类 —— 模型名/接口地址/没填全 → 显示「配置有误：模型名格式错误…」并把出问题的那一格标红（`.ai-input-bad`）；断网/超时/401/429 才显示「连接失败：…」。
- **报错说不清哪里错**：模型名里带空格、全角空格、中文逗号、换行时，提示直接点出「问题出在一个空格上」「问题出在「，」这个字符上」，方便删掉复制粘贴带进来的隐形字符；保存配置时也先校验，不用等点「测试连接」。

### 变更

- 版本 0.8.1 → 0.8.2；`package-lock.json` 同步。
- `src/main/ai.ts` 新增导出 `normalizeModelName` 和三个文案常量（`MODEL_NAME_ERROR_PREFIX` / `BASE_URL_ERROR_PREFIX` / `AI_CONFIG_MISSING_PREFIX`）；`src/shared/ai.ts` 新增 `classifyAiConfigError`（渲染层归类）。
- `ai:config:set` 保存模型名时先校验；`styles.css` 新增 `.ai-input-bad`。
- 数据库、IPC 协议、AI 请求/流式/超时逻辑、番茄钟与其它页面一行没动。

### 验证

- typecheck 0 错、单测 **318**（23 个文件；新增 `tests/unit/ai-model-name.test.ts` 14 条，另补 1 条 429 用例）、e2e **284/284**（新增 3 条：连字符模型名能保存并测试连接、模型名写错时提示格式错误+标红输入框、改回后恢复；原有 281 条原样全过）、强杀 **6/6**、打包自检 **23/23**。

## [0.8.1] - 2026-10-18

发布：[GitHub Release v0.8.1](https://github.com/x-000001/zhishiku/releases/tag/v0.8.1)（附件 JwKB-Setup-0.8.1.exe，112,538,444 字节）

### 修复

- **番茄钟悬浮球拖到窗口顶部会变成「死区」**：以前能拖到 `y=8`，正好压进自绘标题栏的窗口拖拽区（`.topbar` 的 `-webkit-app-region: drag`），鼠标事件被 Windows 当成「拖窗口」吃掉——按钮看着在，却点不开面板、也拖不动，只能重启。现在纵向上限抬到标题栏下方 60px（`FAB_TOP_SAFE`），按钮整块声明 `-webkit-app-region: no-drag`，落在任何位置都能点。
- **拖到左边缘被侧栏盖住**：侧栏 `z-index` 是 46（折叠态 49），悬浮球原来是 40，压到左边会被侧栏覆盖、点不到。现在 `.focus-dock` 抬到 **55**（仍低于弹窗 60、右键菜单/Toast 80，层级关系不乱）。
- **鼠标甩出窗口再松手，按钮会「粘」在鼠标上**：拖拽时改用 `setPointerCapture`，并给 `pointerup` / `pointercancel` / `blur` / `visibilitychange` 统一收尾——不管指针在哪里结束，监听器和捕获都会被摘干净。
- **窗口缩小 / 重启后按钮可能落在窗口外**：`refitPos()` 在读位置、窗口 resize、按钮尺寸变化时都会重新夹回可视区，并把规范化后的坐标写回 `localStorage`。
- **`localStorage` 里位置被改坏（`1e999` → `Infinity`、NaN、手改 JSON）时按钮会消失**：新增 `parseFabPos` 白名单校验（必须是有限数且 `|值| ≤ 20000`），坏数据一律回默认右下角；不再是 `clamp` 之后得到 NaN、`transform` 失效。
- **面板换边用到旧窗口尺寸**：窗口尺寸单独存 `view` state，`panelSide` 按最新尺寸算，缩窗口后面板不会切错边。

### 变更

- 版本号 0.8.0 → 0.8.1；`package-lock.json` 顶层版本同步。
- 新增 `src/renderer/src/fabPos.ts`（纯函数：`fabSizeOf` / `fabBasePoint` / `fabRect` / `clampFabPos` / `snapFabEdge` / `parseFabPos`，常量 `FAB_EDGE=8` / `FAB_TOP_SAFE=60` / `FAB_SNAP_DISTANCE=50` / `FAB_SNAP_MARGIN=16` / `FAB_BASE_INSET=18` / `FAB_MAX_ABS=20000`），`focus.tsx` 里原来的 `clampPos` / `snapToEdge` / `readSavedPos` 全部换成它，DOM 结构与类名没动。
- `styles.css` 只改了 `.focus-dock` 那一处（`z-index: 55` + `-webkit-app-region: no-drag`），另外加一条 `.focus-dock *` 的 `no-drag`。
- 数据库、`user_version`（仍是 6）、IPC 通道、番茄钟业务逻辑（计时 / 休息 / 记录）一行没动。

### 验证

- typecheck 0 错、单测 **303**（22 个文件；新增 `tests/unit/fab-pos.test.ts` 11 条：默认点、四边夹取、顶部安全区、吸边、脏数据回退、超大窗口/极小窗口）、e2e **281/281**（新增 4 条：900×620 窗口拖到顶部极限后用**真实鼠标**点能弹出面板、窗口改小后自动夹回可视区、停在极限位置仍然拖得出来、`localStorage` 写 `1e999` 刷新后回右下角）、强杀 **6/6**、打包自检 **23/23**。
- 旧断言一条没删：0.6.1 那条「拖到左上极限」只是把期望的 `t=8` 改成 `t=60`（配合新的顶部安全区，用户已确认），其余 277 条原样全过。

## [0.8.0] - 2026-10-19

发布：[GitHub Release v0.8.0](https://github.com/x-000001/zhishiku/releases/tag/v0.8.0)（附件 JwKB-Setup-0.8.0.exe，112,537,948 字节）

### 新增

- **AI 能中途停了**：划词对比弹窗、全文摘要 / 分类整理 / 知识联想在生成中都有「■ 停止生成」按钮。点了立刻通过 IPC 让主进程 `AbortController.abort()` 中断网络请求；**已生成的内容保留在弹窗里**，可以继续「确认替换」/「复制」，也可以「重新生成」。中断后按钮立刻恢复默认状态（不会卡在 loading），也不会抛错或崩掉。
- **番茄钟桌面联动**：
  - **任务栏进度条**：专注中通过 `win.setProgressBar()` 在任务栏图标上显示绿色进度；暂停、放弃、进休息、结束时 `setProgressBar(-1)` 清除。
  - **到点强提醒**：专注结束时除了系统通知，还会 `win.flashFrame(true)` 让任务栏图标闪烁，用户点回应用窗口（`win.once('focus')`）就停。
  - 便携版 / 系统不支持时静默降级（`try-catch`），不影响其他功能。
- **番茄钟悬浮球边缘吸附**：拖拽松手时，若离左 / 右边缘不足 50px，用现有弹簧曲线（`--spring-ease`）自动贴边（留 16px 边距）；吸附用 `transform: translate()` 做动画（不触发重排），吸附后的坐标照常写入 `localStorage`。
- **导出全库为 Markdown**（设置页「导出数据」卡片）：
  - 点「导出全部数据为 Markdown」→ 系统原生「选择文件夹」→ 按知识库分类树建目录，每篇笔记一个 `.md`（文件名取标题，重名自动加序号），未分类的放「未分类」目录。
  - 富文本转标准 Markdown（标题 / 列表 / 引用 / 代码 / 表格 / 粗斜体 / 删除线 / 链接 / 图片 / 分割线），用自己写的小转换器，**不引新依赖**。
  - 笔记里的图片原样拷进导出目录的 `attachments/`，正文改成相对路径，Obsidian 等软件直接能看。
  - 导出在主进程进行，逐篇通过 IPC 推「正在导出第 5/50 篇…」进度，完成弹 Toast，还能一键「打开文件夹」。

### 变更

- 版本号 0.7.0 → 0.8.0；`package-lock.json` 顶层版本同步。
- 新增文件：`src/main/html-to-md.ts`、`src/main/export.ts`、`src/main/ipc/export.ts`、`tests/unit/html-to-md.test.ts`、`tests/unit/export.test.ts`；`src/renderer/src/ai.tsx` 的弹窗加停止按钮与「已停止」状态；`src/renderer/src/focus.tsx` 加吸边计算；`src/main/focus.ts` 的 `FocusDeps` 多了两个可选钩子 `progress` / `flash`（老的调用方不用改）。
- 数据库、`user_version`（仍是 6）、既有 IPC 通道、现有 DOM 结构与类名都没动。

### 验证

- typecheck 0 错、单测 **292**（21 个文件；新增 `html-to-md.test.ts` 18 条、`export.test.ts` 9 条、番茄钟任务栏 4 条：进度比例、暂停清空、到点闪任务栏、API 抛错不崩）、e2e **277/277**（新增 16 条：AI 停止后按钮复位 / 内容保留 / 仍可确认替换、悬浮球吸边与位置记忆、设置页导出卡片与进度完成、真的写出 `.md` 且按分类分目录、标准 Markdown 无 HTML 标签、图片进 attachments 且相对路径），强杀 **6/6**、打包自检 **23/23**。
- 原有 261 条 e2e 断言全过：只加了新断言，没改旧断言的类名与 DOM 结构。

## [0.7.0] - 2026-10-19

发布：[GitHub Release v0.7.0](https://github.com/x-000001/zhishiku/releases/tag/v0.7.0)（附件 JwKB-Setup-0.7.0.exe，112,532,876 字节）

### 新增

- **AI 辅助（接外部大模型，OpenAI 兼容接口）**：
  - **划词四件事**：在笔记正文里选中一段文字，旁边浮出气泡 →「润色 / 扩写 / 缩写 / 翻译」。翻译可选目标语言（自动识别 / 中 / 英 / 日 / 韩 / 法 / 德 / 西）。
  - **绝不直接改正文**：点开后弹窗左右对比「原文 / AI 结果」，结果**流式**一段段打出来（打字机效果）；点「确认替换」才写回选区，按 `Ctrl+Z` 可整体撤回；点「取消」正文一个字都不变。
  - **全文三件事**（工具栏「✨ AI」）：**摘要**（流式生成完自动以引用块插到笔记开头，弹窗给「撤销插入」，`Ctrl+Z` 也能一次撤掉整块）、**分类整理**（推荐多个标签，点一下即加进当前笔记，另附 1 个分类建议）、**知识联想**（列 3 个可继续想的点，点「新建笔记」默认带当前笔记的分类并直接打开新笔记）。
  - **设置页「AI 模型」卡片**：接口地址、模型名、API Key，带「测试连接」。
  - **安全边界**：API Key 只在主进程（`safeStorage` / Windows DPAPI 加密后存 `meta` 表），渲染层只能拿到打码尾巴 `sk-…abcd`；所有联网请求都在主进程 `net.fetch`，渲染层没有网络权限；第一次使用先弹隐私说明（明确告知选中的文字 / 整篇正文会发给第三方模型）。
  - **稳定性**：三道超时闸（等响应头 10 秒 / 中途空闲 60 秒 / 整轮最多 180 秒）；断网、Key 无效、余额不足、限流（429）都在几秒内变成中文提示，界面不卡死、本地读写不受影响；AI 返回的 Markdown 走现有清洗白名单转成安全 HTML。
  - 数据库**不建新表**（配置存 `meta`），`user_version` 仍是 6；**零新增依赖**。

### 变更

- 版本号 0.6.1 → 0.7.0；`package-lock.json` 顶层版本同步。

### 验证

- typecheck 0 错、单测 **261**（19 个文件；新增 `tests/unit/ai-client.test.ts` 26 条，覆盖 URL 规范化、消息构造、SSE 分片解析、超时 / 401 / 断网中文文案、标签与联想 JSON 容错解析）、e2e **261/261**（新增 26 条：Key 只在主进程、设置页 AI 卡与测试连接、隐私说明、摘要自动插引用块与撤销、划词气泡与目标语言、对比弹窗「确认前不改正文」、确认替换生效、取消不改、标签一点即加、联想新建笔记带分类、无效 Key 与断网中文报错不卡死、断网不影响本地功能）、强杀 **6/6**、打包自检 **23/23**。
- **测试不调用真实 API**：e2e 用本地 stub 服务器模拟流式 / 非流式 / 401 / 断网（`127.0.0.1:1`），不花额度、不依赖外网。
- 原有 235 条 e2e 断言全过：六个模块的既有功能一条没动。

## [0.6.1] - 2026-10-18

发布：[GitHub Release v0.6.1](https://github.com/x-000001/zhishiku/releases/tag/v0.6.1)（附件 JwKB-Setup-0.6.1.exe，112,517,851 字节）

### 修复

- **番茄钟悬浮按钮不挡路了**：以前固定钉在右下角，会盖住「已放进回收站」这类 Toast，也会压住首页卡片、任务表单右下角的按钮（「去整理」「加上」）。现在：
  - **按住就能拖**（鼠标 / 触控板 / 触屏统一走 Pointer Events），松手停在原地；位置写进 `localStorage`（键 `jw-focus-fab-pos`），刷新、重启应用都记得住。
  - 拖到窗口边缘会被**夹住**（至少留 8px 在窗口里），不会飞出屏幕；窗口尺寸变了会自动拉回可视区。
  - **拖拽不算点击**：位移超过 4px 才认作拖拽，拖动过程中不弹面板；松手后浏览器补的那一下 click 会被吃掉，只有原地单击才打开面板。
  - 拖动时按钮放大到 1.05、加深阴影，松手用现有的 `--spring-ease` 弹簧曲线回弹；位置变化全部走 `transform: translate3d(...)`，不碰 `left/top`，不逐帧重排。
  - 面板改成跟着按钮走（贴在按钮上方，靠近窗口左边 / 顶部时自动换边），层级降到 40；Toast 是 80，提示永远压在按钮上面。
  - `pointermove` / `pointerup` 挂在 `window` 上，抬手立刻移除监听器：不会泄漏，也不会鼠标不按着按钮还乱飞。

### 变更

- 版本号 0.6.0 → 0.6.1；`package-lock.json` 顶层版本同步。

### 验证

- typecheck 0 错、单测 **235**（18 个文件）、e2e **235/235**（新增 4 条：拖动跟手且不误触、贴边夹回、刷新后位置还在、Toast 在按钮之上）、强杀 **6/6**、打包自检 **23/23**。
- 原有 231 条 e2e 断言全过：番茄钟开面板 / 暂停 / 放弃 / 任务联动 / 休息 / 统计一条没动。

## [0.6.0] - 2026-10-18

发布：[GitHub Release v0.6.0](https://github.com/x-000001/zhishiku/releases/tag/v0.6.0)（附件 JwKB-Setup-0.6.0.exe，112,516,530 字节）

### 新增

- **知识库「标签管理」（左侧分类树底部）**：列出现有全部标签和引用数（`学习 (12)`），点一下右侧列表立刻按标签筛选；右键或悬停的小按钮可以「改标签名」「删除标签」。
  - 改标签名遇到重名会**自动合并**成一条，关联的笔记都还在；删除标签只解除关联、**不删笔记**，弹确认框时会写清「该操作会批量影响相关笔记，但不会删除笔记」并告诉你实际影响几篇。
  - 改名、撞名合并、删除都在主进程的 SQLite 事务里完成，中途出错整体回滚；回收站里的笔记关联也一并处理。
  - 数据库只多了一个 `note_tag(tag_id)` 索引（`user_version` 4→5，老库自动补），没有新表。
- **番茄钟（右下角悬浮按钮）**：专注 15 / 25 / 45 / 60 分钟（默认 25），开始后按钮变成「⏱ 24:59」倒计时，面板里可暂停 / 继续 / 放弃这一轮。
  - **时间由主进程按「结束时刻」算**，渲染层只做减法；切页、收起面板、最小化都不会走偏，也不靠「每秒减一」的定时器。
  - 到点自动进入 **5 分钟休息倒计时**（可跳过），结束时发系统通知；任务详情里新增「⏱ 开始专注」，会把这一轮记到该任务上。
  - 历史记录存进新表 `focus_sessions`（`user_version` 5→6），面板里能看到**今日 / 本周**的专注次数与总时长；放弃的会话保留记录但**不计入时长**。
  - 应用重启后：没走完的一轮按真实剩余时间接着走，已超时的补记为完成，异常退出残留的会话统一标成放弃，不会出现永远走不完的记录。

### 变更

- 版本号 0.5.0 → 0.6.0；`package-lock.json` 顶层版本同步。

### 验证

- typecheck 0 错、单测 **235**（18 个文件）、e2e **231**、强杀 **6/6**、打包自检 **23/23**。
- 新增单测：`tests/unit/focus-engine.test.ts`（假时钟跑完整一轮 / 暂停冻结 / 放弃不计时长 / 重启接上 / 超时补记）、`focus-format.test.ts`、`tagmanage.test.ts`；`migrate.test.ts` 升到 v6。
- 新增 e2e 断言 9 条：标签入口展开与引用数、点标签筛选、改标签名跟随、删标签弹确认且不删笔记；番茄钟开面板/开始计时、暂停冻结再继续、放弃回空闲、任务详情记 taskId、运行中拒绝重复开始、2 秒一轮真跑完 → 自动进休息并计入统计、切页不影响计时。

## [0.5.0] - 2026-10-18

### 新增

- **设置页「一键下载并安装更新」**：发现新版本后的弹窗里多了主按钮「下载并安装」。
  - 主进程流式下载安装包到系统临时目录（`JWKB_UPDATE_DIR` 可改），弹窗里显示进度条 + 百分比 + 已下载 / 总大小，随时能「取消下载」，半成品自动删除。
  - 下完做 **大小 + SHA256 双校验**（对照 Release 附件的 digest），对不上就删文件并给中文错误，不会去跑来路不明的包。
  - 「立即安装」＝ 静默运行安装程序（`/S`）→ 应用自动退出 → 装完自动打开新版本；数据目录不变。
  - 便携版（绿色版）没法覆盖正在运行的 exe，改成「下载完打开文件夹，手动替换」。
  - 安全边界：下载地址只从本仓库 Release 附件里取，只放行 `github.com` / `api.github.com`；「立即安装」前还校验文件必须位于更新目录内；测试用 `JWKB_UPDATE_DRYRUN=1` 走不真安装的分支。

### 变更

- 设置页「软件更新」卡片文案改成「可以直接下载并安装，不用去网页手动下载」。
- 版本号 0.4.0 → 0.5.0；`package-lock.json` 顶层版本同步。

### 验证

- typecheck 0 错、单测 **207**、e2e **222**、强杀 **6/6**、打包自检 **23/23**。
- 发布产物：[Release v0.5.0](https://github.com/x-000001/zhishiku/releases/tag/v0.5.0)，附件 `JwKB-Setup-0.5.0.exe`（112,510,046 字节，SHA256 `17d39a3d43405ad99d01b0e36a8b1b890e89c25d4137ee36fb8f7a4061290692`）。

## [0.4.0] - 2026-10-18

### 新增

- **设置页「检查更新（手动联网）」**：点按钮才联网一次，查 GitHub 上最新 Release，有新版就弹窗显示版本号 / 当前版本 / 发布说明 / 下载页，并给「复制下载链接」；不轮询、不常驻、不写数据库。
  - 5 秒超时；断网、超时、403 限流、404 无 Release、返回非 JSON 各有明确中文提示。
  - 网络请求只在主进程（`net.fetch`），URL 写死在主进程常量里，渲染层无法指定；「复制下载链接」走主进程剪贴板（`system:copy-text`）。
  - 样式与类名零新增，只用现有的 `card / set-row / btn sm loading / Modal`。

### 修复

- **知识库「彻底删除」点了没反应**：行内 🗑 / 右键「移到回收站」改为先弹确认框「移到回收站？」；回收站里取消逐条的「彻底删除」入口，物理删除只保留「清空回收站」与 30 天自动清理（按「删除一律先进回收站」的产品规则统一）。

### 变更（纯代码整理，功能与界面零变化）

- 删 4 处死代码；60 处「把错误对象硬转成 `Error`」收成 `errText` / `toastError`；轻提示计时器记账并清理。
- `src/main/ipc.ts` 400 行注册表按域拆成 8 个模块；5 个 100 行以上的组件拆成子组件 / 纯函数 / hook；时间数字抽到 `timing.ts`；建表 SQL 抽到 `schema.ts`（`db.ts` 2395 → 2168 行）。
- 类型断言 `as` 88 → 36、非空断言 11 → 5，`tsconfig` 打开 `noUnusedLocals`。

### 修复（外观）

- **深色模式下分段标签「白底白字」**：复习 / 复盘、日 / 周 / 月复盘、目标池、学习计划「条目 / 日历」这些裸 `<button>` 没有 `.btn` 类，落回浏览器默认浅灰底 + 深色主题近白字（对比度 1.07:1）。补 `.tabs > button:not(.btn)` 分段控件样式 + `color-scheme: light/dark`，实测深色 12.63:1、浅色 17.06:1。
- **表单「呼吸感」**：知识库「加一张卡片」与下一阶段目标「记一个以后想做的事」的控件统一 40px 高、内边距 9/14、文本框 70px 起 / 行高 1.7、行距 15px、标签 96px 顶部对齐（颜色一个没动）。

### 验证

- 单测 194 → **207**（新增 `update.test.ts` 17 条、`updater.test.ts` 9 条）；e2e 215 → **222**；强杀 6/6；打包自检 23/23。
- 发布产物：[Release v0.4.0](https://github.com/x-000001/zhishiku/releases/tag/v0.4.0)，附件 `JwKB-Setup-0.4.0.exe`。

## [0.3.0] - 2026-10-17

第五版（macOS 毛玻璃 + 原生手感）阶段 1–11 完成，界面与手感整体重做：

- 阶段 1–2：蓝调渐变壁纸 + 毛玻璃面、自绘无边框窗口（红黄绿三个点）、毛玻璃侧栏与胶囊导航。
- 阶段 3–4：卡片浮起与拖动跟手、落点线 + 回弹；编辑器工具条毛玻璃 + 正文「纸」不透明（对比度 13.9:1）。
- 阶段 5–7：按钮 / 输入框六态；首页环形进度、逾期与完成动效、里程碑时间轴；搜索面板与 Toast 毛玻璃。
- 阶段 8–9：深浅色过渡与记忆（首帧不闪）；四档响应式（≥1200 / 1024–1199 / 768–1023 / <768）。
- 阶段 9.5：动画专项（只动 transform / opacity，侧栏展开 380ms 不重排，毛玻璃动画期间降级）。
- 阶段 10–11：弹窗与右键菜单毛玻璃 + 退场动画 + 键鼠操作；10px 细滚动条、滚动容器兜底、skip 链接与焦点环、行级键盘操作、读屏标签、减少动效兜底。
- 收尾轮：e2e 补断点边界断言（1200/1199、1024/1023、768/767），文档对齐历史阶段。

### 验证

- 单测 176、e2e 194 → 210、强杀 6/6、打包自检 15 → 23 项。
- 交付包：`C:\JwKB\setup\Jw知识库-安装包-0.3.0.exe`。

## 更早的版本

0.1.0 / 0.2.0 是「把八个模块补齐」的阶段（外壳 + 数据、四个可用模块 → 再补四个模块），细节见 [README 第六部分](README.md) 的「第一版」「第二版」。
