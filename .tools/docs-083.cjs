/* 0.8.3 文档批量更新（一次性脚本，跑完删除） */
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const save = (name, text) => fs.writeFileSync(path.join(root, name), text, 'utf8');
const toLF = (text) => text.replace(/\r\n/g, '\n');
const toCRLF = (text) => text.replace(/\n/g, '\r\n');
const report = [];

function patch(name, fn) {
  const before = read(name);
  const next = fn(toLF(before));
  if (next === toLF(before)) {
    report.push(`${name}: NO CHANGE`);
    return;
  }
  save(name, toCRLF(next));
  report.push(`${name}: updated`);
}

function replaceOnce(text, from, to, label) {
  if (!text.includes(from)) {
    report.push(`MISS(${label})`);
    return text;
  }
  report.push(`ok(${label})`);
  return text.replace(from, to);
}

/* ---------- package.json / lock ---------- */
const pkgPath = path.join(root, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
pkg.version = '0.8.3';
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
const lockPath = path.join(root, 'package-lock.json');
const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
lock.version = '0.8.3';
if (lock.packages && lock.packages['']) lock.packages[''].version = '0.8.3';
fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n', 'utf8');
report.push('package.json / package-lock.json: 0.8.3');

/* ---------- README ---------- */
patch('README.md', (text) => {
  text = replaceOnce(text, '- 当前版本 **0.8.2**', '- 当前版本 **0.8.3**', 'readme-version');
  text = replaceOnce(
    text,
    'Jw知识库-安装包-0.8.2.exe',
    'Jw知识库-安装包-0.8.3.exe',
    'readme-installer'
  );
  text = replaceOnce(
    text,
    '单测 **318** 项（23 个文件）、e2e **284** 项',
    '单测 **332** 项（23 个文件）、e2e **287** 项',
    'readme-tests'
  );
  const anchor = '**0.8.1 修了一处真问题（2026-10-18）**';
  const paragraph = [
    '**0.8.3 修好了「测试连接」在深度求索这类接口上的误报（2026-10-19）**：以前填 `https://api.deepseek.com/v1` + `deepseek-v4-pro` 点「测试连接」，会报「AI 返回的内容里没有文字」—— 因为解析只认 `message.content`，而推理模型把正文放在 `reasoning_content` 里。现在非流式解析会依次兜底 `message.content`（含多段内容数组）→ `choices[0].text` → `reasoning_content` / `reasoning`；200 但真的没正文时提示「AI 接口已连通，但返回了空内容，请检查模型名是否正确」并把模型名那格标红；404 直接说「接口地址不对」，401 说「API Key 不对或已失效」；失败时主进程 Console 会打一行原始响应（截断 2000 字、Key 自动打码），排查不用猜。',
    '',
    ''
  ].join('\n');
  return replaceOnce(text, anchor, paragraph + anchor, 'readme-083-paragraph');
});

/* ---------- CHANGELOG ---------- */
patch('CHANGELOG.md', (text) => {
  const anchor = '## [0.8.2] - 2026-10-19';
  const entry = [
    '## [0.8.3] - 2026-10-19',
    '',
    '### 修复',
    '',
    '- **「测试连接」在 `deepseek-v4-pro` / `deepseek-reasoner` 这类接口上误报「AI 返回的内容里没有文字」**：非流式解析改成多层兜底 —— 标准 `choices[0].message.content` → 内容数组（多段 text 拼起来）→ `choices[0].text` → 推理模型的 `reasoning_content` / `reasoning`；整段正文被包在 SSE 里也能读出来。',
    '- **200 但解析不出正文时，不再说「接口不兼容」**：提示「AI 接口已连通，但返回了空内容，请检查模型名是否正确」，设置页同时把模型名那格标红（归为配置类错误）。',
    '- **失败时把原始响应打到主进程 Console**（超过 2000 字截断、`sk-` 开头的 Key 自动打码），对着日志就能看出对方到底返回了什么结构。',
    '- **HTTP 错误更具体**：404 提示「接口地址不对（Base URL 一般是 https://…/v1 这种结尾）」，401 提示「API Key 不对或已失效」，不用再猜是网络还是配置。',
    '- 「测试连接」的 `max_tokens` 从 16 提到 200，避免推理模型把预算全花在思考上、正文被截成空。',
    '- 配置类 / 解析类错误统一点成「用户错误」，不再套一层「AI 请求失败：」前缀。',
    '',
    '### 变更',
    '',
    '- 版本：0.8.2 → 0.8.3。',
    '',
    '### 验证',
    '',
    '- 单测 **332** 项（23 个文件；`ai-client.test.ts` 新增 14 条覆盖各种响应结构 / 空内容 / 长度截断 / 非 JSON / 401 / 404 / 日志打码，`ai-model-name.test.ts` 新增 1 条空内容归类），全部通过。',
    '- e2e **287/287**（新增 3 条：推理模型 `reasoning_content` 能连通、空内容提示「已连通，但返回了空内容」、404 精准提示；原有 284 条未改），强杀 **6/6**，打包自检 **23/23**。',
    '- AI 测试全部走本地 stub，不调真实 API、不产生费用。',
    '',
    ''
  ].join('\n');
  return replaceOnce(text, anchor, entry + anchor, 'changelog-083');
});

/* ---------- 验收清单 ---------- */
patch('验收清单.md', (text) => {
  const section = [
    '',
    '## 0.8.3 修正 · 「测试连接」解析（2026-10-19）',
    '',
    '| 验收项 | 怎么点 | 应该看到 |',
    '|---|---|---|',
    '| 推理模型也能连通 | 设置 → AI 模型，Base URL 填兼容地址，模型名 `deepseek-v4-pro` 或 `deepseek-reasoner`，点「测试连接」 | 显示「连通了：…」，不再报「AI 返回的内容里没有文字」 |',
    '| 内容在 reasoning_content 里也算连通 | 接口把正文放在 `reasoning_content` 里（推理模型常见） | 同样显示「连通了」 |',
    '| 空内容说人话 | 接口返回 200 但正文为空 | 提示「AI 接口已连通，但返回了空内容，请检查模型名是否正确」，模型名那格标红 |',
    '| 地址写错能说清 | Base URL 故意写错（返回 404） | 提示「连接失败：接口地址不对（HTTP 404），Base URL 一般是 https://…/v1 这种结尾」 |',
    '| Key 写错能说清 | Key 填错（返回 401） | 提示「API Key 不对或已失效（HTTP 401）」 |',
    '| 原始响应用于排查 | 测试失败后看主进程 Console | 有一行 `[AI] … 原始响应`，长内容截断、Key 打码，不泄漏 |',
    '| 流式与编辑器没被动 | AI 润色 / 摘要 / 翻译 / 分类 / 联想、停止生成、断网降级、编辑器、番茄钟、标签、导出全部照旧 | 原有 284 条 e2e 断言原样全过 |',
    '',
    '**这一版的验证数字**：typecheck 0 错；单测 **332**（23 个文件；新增 15 条）；e2e **287/287**（新增 3 条，原有 284 条未改）；强杀 **6/6**；打包自检 **23/23**。',
    ''
  ].join('\n');
  return text.replace(/\s*$/, '\n') + section;
});

/* ---------- 开发计划 ---------- */
patch('开发计划.md', (text) => {
  const section = [
    '',
    '## 修复轮 · 「测试连接」解析兼容（0.8.3，2026-10-19 晚）',
    '',
    '**为什么**：用户用 `https://api.deepseek.com/v1` + `deepseek-v4-pro` 点「测试连接」，报「连接失败：AI 请求失败：AI 返回的内容里没有文字，可能模型名不对或接口不兼容」。排查发现 `pickDelta` 只认 `delta.content` / `message.content` / `choices[0].text`，推理模型把正文放在 `reasoning_content` 里就读不到；空内容也没有区分「接口没通」和「通了但没文字」。',
    '',
    '**改了什么**（只动 AI 发送与解析模块，不碰业务）：',
    '',
    '1. `src/main/ai.ts`：`contentOf` 兼容字符串 / 内容数组；`pickReply` 依次兜底 `message.content` → `delta.content` → `choices[0].text` → `reasoning_content` / `reasoning`；`collectSseText` 让「网关无视 stream、整段 SSE 回包」也能拼出正文；`readNonStreamBody` 空内容抛 `AI_EMPTY_REPLY_MESSAGE`，`finish_reason=length` 追加提示；解析类错误打 `name=\'AiUserError\'`，`describeAiNetworkError` 原样放行（不再套「AI 请求失败：」）；`logRawAiResponse` 失败时 `console.warn` 原始响应（2000 字截断、`sk-` Key 打码）。',
    '2. `src/main/ipc/ai.ts`：`ai:config:test` 的 `maxTokens` 16 → 200，回复只回前 60 字。',
    '3. `src/shared/ai.ts`：`classifyAiConfigError` 把「返回了空内容」也归到模型名那一格（标红）。',
    '4. 测试：`ai-client.test.ts` 新增 14 条（非流式 payload 断言 `stream:false`、各种 content 结构、空内容、长度截断、错误对象、空响应体、SSE 回包兜底、401/404 文案、日志打码）；`ai-model-name.test.ts` 新增 1 条空内容归类；e2e 新增 3 条（stub 加 `/ai-reasoning/`、`/ai-empty/`、`/ai-404/` 三条路由）。',
    '',
    '**坑**：`deepseek-reasoner` 这类推理模型把大部分 token 花在思考上，测试连接只给 16 个 token 时正文可能被截成空 —— 所以把 `max_tokens` 提到 200；另外 e2e 断言里「配置有误」前缀是按 `classifyAiConfigError` 分的，空内容归到 model 后，断言要写「配置有误：AI 接口已连通…」。',
    '',
    '**验证**：typecheck 0 错、单测 332（23 文件）、e2e 287/287（新增 3 条，原有 284 条原样全过）、强杀 6/6、打包自检 23/23。',
    ''
  ].join('\n');
  return text.replace(/\s*$/, '\n') + section;
});

/* ---------- PRD ---------- */
patch('PRD.md', (text) => {
  const section = [
    '',
    '## 0.8.3 修正 · 「测试连接」解析兼容（2026-10-19）',
    '',
    '- 背景：兼容 OpenAI 的接口在响应结构上不统一 —— 有的把正文放 `choices[0].message.content`，有的放 `choices[0].text`，推理模型放 `message.reasoning_content`；「测试连接」曾把这些都当成「返回的内容里没有文字」。',
    '- 解析：非流式按 `message.content`（含内容数组）→ `choices[0].text` → `reasoning_content` / `reasoning` 兜底；正文被 SSE 包着也能读出来。',
    '- 提示：200 但正文为空 → 「AI 接口已连通，但返回了空内容，请检查模型名是否正确」（配置类，模型名标红）；404 → 「接口地址不对」；401 → 「API Key 不对或已失效」。',
    '- 排查：失败时主进程 Console 打原始响应（截断 2000 字、Key 打码），不落库、不外发。',
    '- 范围红线：只动 AI 请求发送与解析模块，流式生成、编辑器与其余功能不动；旧断言全过。',
    '- 验收：`deepseek-v4-pro` / `deepseek-reasoner` 测试连接显示「连通了」；空内容 / 404 / 401 各有明确提示；单测 332、e2e 287/287。',
    ''
  ].join('\n');
  return text.replace(/\s*$/, '\n') + section;
});

/* ---------- 功能分析文档 ---------- */
patch('功能分析文档.md', (text) => {
  const section = [
    '',
    '### 13.6 响应解析兼容（0.8.3）',
    '',
    '- `pickReply` 的兜底顺序：`choices[0].message.content`（字符串或多段内容数组）→ `choices[0].delta.content`（流式）→ `choices[0].text` → `message.reasoning_content` → `message.reasoning`。',
    '- 非流式请求固定 `stream: false`；若服务端仍把正文包在 SSE 里，`collectSseText` 会先从 `data:` 行拼出正文，拼不出再尝试整段 JSON。',
    '- 正文为空：抛 `AI_EMPTY_REPLY_MESSAGE`（「AI 接口已连通，但返回了空内容，请检查模型名是否正确」），错误 `name=\'AiUserError\'`；`classifyAiConfigError` 归到模型名，设置页标红。',
    '- 失败日志：`logRawAiResponse` 用 `console.warn` 打一行 `[AI] <label> 原始响应：…`，超 2000 字截断，正文里的 `sk-…` 由 `redactSecret` 打码。',
    '- 验证：单测 332（23 文件）、e2e 287/287。',
    ''
  ].join('\n');
  let next = text.replace(/\s*$/, '\n') + section;
  // 版本表若仍写 0.8.2，同步到 0.8.3（只动「当前版本」这种明确指向）
  if (next.includes('**0.8.2**')) {
    next = next.replace('**0.8.2**', '**0.8.3**');
    report.push('ok(analysis-version)');
  }
  return next;
});

console.log(report.join('\n'));
