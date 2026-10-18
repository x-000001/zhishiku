## 这次修了什么

**「测试连接」在 `deepseek-v4-pro` / `deepseek-reasoner` 这类接口上误报「AI 返回的内容里没有文字」。**

原因是解析只认 `choices[0].message.content`，而推理模型把正文放在 `message.reasoning_content` 里；也有网关把正文塞在 `choices[0].text`、或把整段响应包成 SSE。

现在：

- **多层兜底**：`message.content`（含多段内容数组）→ `delta.content` → `choices[0].text` → `reasoning_content` / `reasoning`；正文被 SSE 包着也能读出来。
- **空内容说人话**：200 但真的没正文 → 「AI 接口已连通，但返回了空内容，请检查模型名是否正确」，模型名那格标红。
- **HTTP 错误更具体**：404 → 「接口地址不对（Base URL 一般是 https://…/v1 这种结尾）」；401 → 「API Key 不对或已失效」。
- **原始响应进日志**：失败时主进程 Console 打一行 `[AI] … 原始响应`，超 2000 字截断、`sk-` Key 自动打码，排查不用猜。
- 「测试连接」的 `max_tokens` 从 16 提到 200，避免推理模型把预算花在思考上、正文被截成空。

## 验证

- 单测 **332** 项（23 个文件；新增 15 条覆盖空 JSON、非标准 JSON、内容数组、`reasoning_content`、长度截断、401/404、日志打码）
- e2e **287/287**（新增 3 条：推理模型能连通、空内容提示、404 精准提示；原有 284 条未改）
- 强杀 **6/6**、打包自检 **23/23**
- AI 测试全部走本地 stub，不调真实 API、不产生费用

## 下载

- 安装包：`JwKB-Setup-0.8.3.exe`（约 107 MB）
- 绿色版：`C:\JwKB\portable\Jw知识库.exe`

装 0.8.2 的机器点「设置 → 软件更新 → 检查更新」也能升到 0.8.3。
