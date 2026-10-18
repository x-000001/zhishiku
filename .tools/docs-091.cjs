const fs = require('node:fs');

function edit(file, fn) {
  const raw = fs.readFileSync(file, 'utf8');
  const crlf = raw.includes('\r\n');
  const text = raw.replace(/\r\n/g, '\n');
  const next = fn(text);
  if (next === text) throw new Error('nothing changed in ' + file);
  fs.writeFileSync(file, crlf ? next.replace(/\n/g, '\r\n') : next);
  console.log('updated', file, next.length);
}

// ---------- README ----------
edit('README.md', (t) => {
  t = t.replace('当前版本 **0.9.0**', '当前版本 **0.9.1**');
  t = t.replace('安装包：`C:\\JwKB\\setup\\Jw知识库-安装包-0.9.0.exe`', '安装包：`C:\\JwKB\\setup\\Jw知识库-安装包-0.9.1.exe`');
  t = t.replace('单测 **342** 项（24 个文件）、e2e **291** 项', '单测 **344** 项（24 个文件）、e2e **293** 项');

  const start = t.indexOf('### 第九版（视觉门面：应用图标 + 侧栏品牌区，2026-10-19）');
  const end = t.indexOf('**怎么验收这块**：见 [验收清单.md](验收清单.md) 里「第九版（0.9.0）」一节');
  if (start < 0 || end < 0) throw new Error('README 第九版 anchor not found');
  const tailStart = t.indexOf('\n\n', end);
  const section = `### 第九版（视觉门面：应用图标 + 侧栏品牌区，2026-10-19）

图标和左上角那片门面，是每次打开应用第一眼看到的东西，这一版把它们按 macOS 桌面应用的手感重做了一遍。**只动外观**：DOM、类名、组件逻辑、快捷键一个没动。

**0.9.1 又把图标重画了一次**：0.9.0 那版画的是「两张叠放的白色卡片」，还是笔记本/卡片的具象隐喻；这一版按你的反馈换成抽象几何 —— 近黑底板 + 白色双环 ∞ + 中心一粒极光蓝。两个「面」折叠成无限，隐喻知识越滚越大；既避开笔记本/卡片，也避开 macOS 备忘录那三根横线。

| 部分 | 做了什么 | 你实际会看到什么 |
|---|---|---|
| **应用图标** | 近黑 squircle 底板（\`#0A0B10\`，22% 圆角）+ **白色双环 ∞** + 中心一粒**极光蓝 \`#5EE7E6\`**；顶部只有一条 1px 的极弱内高光（\`rgba(255,255,255,.15)\`），不做渐变、不做投影。图形不是手点的：\`.tools/gen-icon.mjs\` 用**纯 Node 软件光栅器**画（SDF + 超采样 + 直通道 alpha 合成 + 自写 PNG/ICO 编码），**零新增依赖**。 | 任务栏、桌面快捷方式、开始菜单、Alt+Tab 里都是这张新图；缩到 16px 仍是两个白环 + 中间一点青 |
| **多尺寸** | \`resources/icon.ico\` 里打包 **16 / 24 / 32 / 48 / 64 / 128 / 256** 七档，**每档单独渲染**（不是把 256 硬缩）；\`resources/tray.png\` 是单独的 32px 版本，托盘缩到 16 也清楚；\`resources/icon.png\` 是 512×512 母版。 | 小图标不糊、大图标不糙；单测 \`icon-assets.test.ts\` 会把 ico 拆开逐档验尺寸，还量 16px 里白色环的像素占比、以及中心那粒青色还在不在 |
| **侧栏品牌区** | 侧栏那枚 28px 图标**画的是同一张图**（内联 SVG 双环 + 极光点、近黑底板），与桌面图标同源；右边文案改成 **\`Jw\` 粗（700、\`#5EE7E6\`）+ \`知识库\` 细（500、15px、0.5px 字距、\`var(--text)\`）**，去掉 0.9.0 的渐变字与文字阴影（不再有描边/重影感）；间距 10px、品牌区留白 16px 20px。 | 左上角是「黑色小图标 + 青色 Jw + 深灰细体知识库」的粗细对比，像 macOS 原生应用的标题栏门面；切深色也不刺眼 |
| **折叠态** | 侧栏收成 60px 图标条时，28px 图标水平居中（e2e 实测中心偏差 **0px**），\`Jw\` 文字标让位隐藏、\`知识库\` 收成 0 宽被裁掉，图标不裁切不撑变形。 | 收起侧栏后左上角只剩一个居中的黑色小图标 |

**怎么验收这块**：见 [验收清单.md](验收清单.md) 里「0.9.1 修正」一节（6 条验收点）；\`tests/unit/icon-assets.test.ts\`（12 条）会解开 ico 逐档验证，e2e 里 6 条 \`0.9.1：…\` 断言会把品牌区的计算样式量出来（底板色、SVG 双环与极光点、字重字色、无字影、两段间距、折叠居中）。`;

  t = t.slice(0, start) + section + t.slice(tailStart);

  // 发布记录：0.9.1 插到最前
  const rec = t.indexOf('**发布记录**：0.9.0 已发到');
  if (rec < 0) throw new Error('发布记录 anchor not found');
  const line = '**发布记录**：0.9.1 已发到 [GitHub Release v0.9.1](https://github.com/x-000001/zhishiku/releases/tag/v0.9.1)，附带 JwKB-Setup-0.9.1.exe；装 0.9.0 的机器点「检查更新」会看到「发现新版本 0.9.1」。\n\n';
  t = t.slice(0, rec) + line + t.slice(rec);
  return t;
});

// ---------- CHANGELOG ----------
edit('CHANGELOG.md', (t) => {
  const anchor = '## [0.9.0] - 2026-10-19';
  const idx = t.indexOf(anchor);
  if (idx < 0) throw new Error('CHANGELOG anchor missing');
  const entry = `## [0.9.1] - 2026-10-19

发布：[GitHub Release v0.9.1](https://github.com/x-000001/zhishiku/releases/tag/v0.9.1)（附件 JwKB-Setup-0.9.1.exe）

### 变更（视觉门面二改：图标换成抽象几何）

- **应用图标重画**：0.9.0 的「两张白卡片 + 琥珀节点」换成抽象几何 —— 近黑 squircle 底板（\`#0A0B10\`）+ 白色双环 ∞ + 中心一粒极光蓝 \`#5EE7E6\`，顶部保留 1px 极弱内高光，去掉渐变与外投影；\`.tools/gen-icon.mjs\` 改为 SDF 绘制，512/128/64/48 用 4× 超采样、32 及以下用 8×，并做半像素对齐与 16px 档独立几何，避免小尺寸糊成一块。
- **侧栏图标和桌面图标同源**：\`.brand-mark\` 里的「Jw」文字换成内联 SVG（双环 + 极光点，\`aria-hidden\`），底板同为近黑。
- **品牌区排版**：\`Jw\`（700 字重、\`#5EE7E6\`）+ \`知识库\`（500 字重、15px、\`letter-spacing:.5px\`、\`var(--text)\`），去掉 0.9.0 的渐变文字与 \`text-shadow\`（不再有描边/重影），间距 10px、留白 16px 20px；折叠态隐藏 \`Jw\` 文字标、图标保持居中。
- 版本号 0.9.0 → 0.9.1。

### 测试

- 单测 \`icon-assets.test.ts\` 重写为 12 条：底板近黑、顶部 1px 内高光、白色双环像素面积、中心极光点颜色、ICO 七档齐全、16px 白色环占比与青点仍在、托盘缩 16 的可见度。
- e2e 把原先 4 条 \`0.9.0：…\` 品牌断言改成 6 条 \`0.9.1：…\`（底板色/圆角/内高光、SVG 双环数=2 与极光点=1、Jw 粗+标题细且无渐变、三处 \`text-shadow\` 全 none、图标→Jw→标题两段间距各 10px、折叠态居中且 Jw 让位），其余 287 条原样未改。

### 验证

- typecheck 0 错；单测 **344**（24 个文件）；e2e **293/293**；强杀 6/6；打包自检 23/23。

`;

  return t.slice(0, idx) + entry + t.slice(idx);
});

// ---------- 验收清单 ----------
edit('验收清单.md', (t) => {
  const addition = `

## 0.9.1 修正 · 视觉门面二改：近黑 ∞ 图标 + 品牌区粗细对比（2026-10-19）

| 验收项 | 怎么点 | 应该看到 |
|---|---|---|
| 桌面图标换了 | 看任务栏 / 桌面快捷方式 / 开始菜单 / Alt+Tab | 近黑圆角方块里两个白色圆环咬成 ∞，中间一粒青点；不再是蓝底和叠放的卡片 |
| 小图标仍清楚 | 把任务栏图标调小，或看文件属性里 16 / 32 | 16px 仍是两个白环 + 一点青，不糊成一团、不丢点；单测 \`icon-assets.test.ts\` 逐档解开 ico 验证 |
| 左上角与图标同源 | 看侧栏左上角 | 28px 黑色小方块里也是那两个白环 + 青点（内联 SVG），不是旧的蓝色 Jw 渐变块 |
| 文字粗细对比 | 看左上角文字 | \`Jw\` 是青色粗体（700），\`知识库\` 是深灰细体（500 / 15px / 0.5px 字距）；没有渐变、没有描边或重影 |
| 间距与留白 | 看 / 量 | 图标→Jw→知识库 每段约 10px，品牌区留白 16px 20px 不贴边 |
| 折叠态 | 点左下角「收起侧栏」 | 收成 60px 时只剩居中的黑色小图标（偏差 0px）；\`Jw\` 让位、\`知识库\` 收成 0 宽被裁掉，不撑变形 |

**这一版的验证数字**：typecheck 0 错；单测 **344**（24 个文件；\`icon-assets.test.ts\` 12 条）；e2e **293/293**（把 0.9.0 的 4 条品牌断言改写成 6 条 \`0.9.1：…\`，其余 287 条原样全过）；强杀 **6/6**；打包自检 **23/23**。截图：\`tests/e2e/shots/home.png\`、\`sidebar-expanded.png\`、\`sidebar-collapsed.png\`，以及 \`.tools/icon-preview.png\`（多尺寸预览）。
`;
  return t.trimEnd() + addition + '\n';
});

// ---------- 开发计划 ----------
edit('开发计划.md', (t) => {
  const addition = `

## 修复轮 · 视觉门面二改：图标换成「无尽折叠」（0.9.1，2026-10-19 晚）

**痛点**：0.9.0 的图标是「两张叠放的白色卡片」，属于具象的笔记本/卡片隐喻，方向被否；要求抽象几何、极简黑白、避开 macOS 备忘录与竞品，中心带一点高亮。

**做法**：

1. \`.tools/gen-icon.mjs\` 整个重写：底板近黑 \`#0A0B10\` squircle（SDF 圆角矩形），顶部 1px 白色内高光；主图形用两个「环」的 SDF（\`|dist-R|-halfStroke\`）叠成 ∞，中心一粒极光蓝实心点；不再有渐变和外投影。
2. 小尺寸单独一套参数：16px 只保留两个环 + 点，环壁加粗、两环中心距缩小，保证「∞」不断开；超采样 512/128/64/48 用 4×、32 及以下用 8×，并做半像素对齐（\`+ 0.5*ss\`）避免 16px 边缘发灰。
3. 侧栏不再显示「Jw」文字块：\`.brand-mark\` 里放同源内联 SVG（\`<circle>\` ×3 + \`aria-hidden\`），容器近黑、\`overflow:hidden\`；文案拆成 \`.brand-jw\`（700 / \`#5EE7E6\`）+ \`.brand-text\`（500 / 15px / \`var(--text)\`），并显式清掉 \`text-shadow\` 与渐变字（\`background:none\`、\`-webkit-text-fill-color:currentColor\`）。
4. 折叠态隐藏 \`.brand-jw\`，图标沿用原列布局居中。

**踩坑**：

1. 512 画布里 1px 内高光渲染后只占 1 个物理像素，单测不能用「某一像素更亮」硬判，改成「顶边 4 行最亮值 vs 板内深处」比。
2. 16px 的中心小点会和白色环混色，单测不能等纯 \`#5EE7E6\`，要用「青绿明显压过红」的相对判据。
3. 品牌区加了 \`.brand-jw\` 后，原先「图标到标题」的间距变成「图标→Jw→标题」两段，断言要分别量两段；标题自然宽用 \`scrollWidth\` 更稳（\`getBoundingClientRect\` 会受过渡/变换影响）。

**验证**：typecheck 0 错、单测 **344**（24 文件，\`icon-assets.test.ts\` 12 条）、e2e **293/293**（6 条 \`0.9.1：…\`，其余 287 条原样全过）、强杀 6/6、打包自检 23/23。
`;
  return t.trimEnd() + addition + '\n';
});

// ---------- 功能分析文档 ----------
edit('功能分析文档.md', (t) => {
  t = t.replace('| 对应版本 | 0.9.0（第五版 + 更新模块 + 标签全局管理 + 番茄钟 + AI 辅助 + 视觉门面） |', '| 对应版本 | 0.9.1（第五版 + 更新模块 + 标签全局管理 + 番茄钟 + AI 辅助 + 视觉门面） |');
  const start = t.indexOf('## 14. 视觉门面（应用图标 + 侧栏品牌区，0.9.0）');
  if (start < 0) throw new Error('14 anchor missing');
  const section = `## 14. 视觉门面（应用图标 + 侧栏品牌区，0.9.1）

### 14.1 图标生成管线（零依赖）

- 生成器：\`.tools/gen-icon.mjs\`，纯 Node（只用内置 \`zlib\`）。流程：按尺寸决定超采样倍数（512/128/64/48 用 4×、≤32 用 8×）→ 逐子像素算颜色与 alpha（圆角矩形 SDF、两个环的 SDF 叠成 ∞、中心圆点、顶部 1px 内高光）→ \`+0.5*ss\` 半像素对齐后盒式降采样 → 自写 PNG 编码（RGBA8、filter 0、CRC32 + \`zlib.deflateSync\`）。
- 产物：\`resources/icon.png\`（512 母版，窗口与打包用）、\`resources/icon.ico\`（16/24/32/48/64/128/256 七档，PNG-in-ICO）、\`resources/tray.png\`（32px 透明底，托盘用；主进程 \`nativeImage.resize({width:16})\` 后显示）。
- 视觉：底板近黑 \`#0A0B10\`、22% 圆角，顶部一条 1px 白色内高光（\`rgba(255,255,255,.15)\`），无渐变、无外投影；主图形是白色双环 ∞（环壁约为底板宽的 10%），中心一粒极光蓝 \`#5EE7E6\`。
- 小尺寸策略：≤32px 换一套几何（环壁加粗、两环中心距缩小、点放大），保证 16px 下「∞」不断开、中心点不丢。

### 14.2 侧栏品牌区

- 只追加样式、不改 DOM 结构：\`.brand\`（gap 10px / padding 16px 20px / 500 字重 / 0.5px 字距）、\`.brand-mark\`（28px、8px 圆角、近黑 \`#0A0B10\`、\`inset 0 1px 1px rgba(255,255,255,.15)\`、\`overflow:hidden\`，内部是同源内联 SVG：两个白描边 \`<circle>\` + 一个极光蓝 \`<circle>\`，\`aria-hidden\`）、\`.brand-jw\`（700、\`#5EE7E6\`）、\`.brand-text\`（15px / 500 / 0.5px 字距、\`var(--text)\`、无 \`text-shadow\`、无渐变）。
- 渐变文字的教训（0.9.0 遗留）：\`background-clip: text\` + \`-webkit-text-fill-color: transparent\` 必须和 \`background-image\` 一起生效；若渐变里引用了不存在的 CSS 变量，\`background\` 简写在计算值阶段整条失效而文字填充仍是透明 → 标题会「凭空消失」。0.9.1 已改成单色文字，不再有这条依赖。
- 折叠态：60px 图标条内 28px 图标靠 \`.sidebar.collapsed .brand\` 的列布局 \`align-items: center\` 居中（实测中心偏差 0px），\`.brand-jw\` 隐退，\`.brand-text\` 沿用原规则收 0 宽裁切。

### 14.3 测试口径

- 单测 \`tests/unit/icon-assets.test.ts\`（12 条）：解 PNG 验尺寸 / 四角透明 / 底板近黑 / 顶部 1px 内高光 / 白色双环像素面积 / 中心极光点颜色；解 ICO 目录验七档齐全、每档 PNG 尺寸正确、16px 白色像素占比在合理区间且中心青点仍在；托盘 32px 透明底、缩 16 后的可见像素下限。
- e2e 6 条 \`0.9.1：…\`：品牌区计算样式（底板色 + 圆角 + 内高光、SVG 白环数=2 与极光点=1、Jw 粗+标题细且无渐变、三处 \`text-shadow\` 全 none、图标→Jw→标题两段间距、折叠态居中且 Jw 让位）。
- 验证数字：typecheck 0；单测 344（24 文件）；e2e 293/293；强杀 6/6；打包自检 23/23。
`;
  return t.slice(0, start) + section;
});

console.log('docs done');
