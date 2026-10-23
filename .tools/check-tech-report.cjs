/**
 * TECH_REPORT.md 自检：
 * 1) 文中所有仓库路径/关键文件是否真实存在
 * 2) 提到的函数/变量/通道是否在源码中存在
 * 3) 是否残留 path:line 行号引用
 * 4) Mermaid 代码块结构校验 + 在线渲染（mermaid.ink）
 * 5) 中文字数统计
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const root = process.cwd();
const file = path.join(root, 'TECH_REPORT.md');
const md = fs.readFileSync(file, 'utf8');

const fails = [];
const notes = [];

/* ---------- 1. 抽取并把代码片段粗分成「路径候选」 ---------- */
const spans = [...md.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]).filter(Boolean);
const uniq = [...new Set(spans)];

const REPO_PREFIX = /^(src|tests|docs|resources|\.tools|out|release|node_modules)\//;
const EXT = /\.(ts|tsx|css|mjs|cjs|json|yml|yaml|html|nsh|png|ico|md|log)$/;
const ROOT_FILES = new Set(['package.json', 'electron-builder.yml', 'electron.vite.config.ts', 'tsconfig.json', 'vitest.config.ts', '.npmrc']);
const isPath = (s) => {
  if (/^(npm|node|npx|git|taskkill|cmd|cd|npx)\s/.test(s)) return false; // 命令整串，不按路径校验
  if (/^https?:/.test(s)) return false;
  if (ROOT_FILES.has(s)) return true;
  if (!/[\\/]/.test(s)) return false; // 裸文件名不校验（正文里常只写文件名）
  return REPO_PREFIX.test(s) || EXT.test(s) || /^D:\\|^C:\\|^%APPDATA%/.test(s);
};

const runtime = new Set([
  '%APPDATA%\\Jw知识库\\locator.json',
  'D:\\Jw知识库',
  'C:\\JwKB\\setup',
  'C:\\jwkb',
  'tests/e2e/ud',
  '<file>',
  'out/renderer/index.html'
]);
const checkedPaths = [];
for (const raw of uniq) {
  if (!isPath(raw)) continue;
  if (raw.includes('…')) continue; // 省略号路径不做存在性校验
  const clean = raw.replace(/[，。；：、]$/, '').replace(/\/$/, '');
  const abs = path.isAbsolute(clean) ? clean : path.join(root, clean);
  if (clean.includes('*')) {
    const parent = path.join(root, clean.split('*')[0]);
    if (fs.existsSync(parent)) checkedPaths.push(clean + '（通配，父目录存在）');
    else fails.push('路径不存在：' + clean);
    continue;
  }
  if (runtime.has(clean)) { notes.push('运行时/示例路径：' + clean); continue; }
  if (fs.existsSync(abs)) checkedPaths.push(clean);
  else fails.push('路径不存在：' + clean);
}

/* ---------- 2. 函数/变量/通道核对 ---------- */
function allFiles(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === 'node_modules' || ent.name === 'out' || ent.name === 'release') continue;
      allFiles(p, out);
    } else out.push(p);
  }
  return out;
}
const corpusFiles = [
  ...allFiles(path.join(root, 'src')),
  ...allFiles(path.join(root, 'tests')),
  ...allFiles(path.join(root, '.tools')),
  path.join(root, 'electron-builder.yml'),
  path.join(root, 'electron.vite.config.ts'),
  path.join(root, 'package.json')
].filter((p) => fs.existsSync(p));
const corpus = corpusFiles.map((p) => fs.readFileSync(p, 'utf8')).join('\n');

const ids = [
  'DEFAULT_DATA_ROOT', 'resolveDataRoot', 'readLocator', 'writeLocator',
  'createMainWindow', 'createCaptureWindow', 'createTray', 'registerIpc', 'registerNotes', 'registerAi',
  'wrap', 'ALLOWED_EVENTS', 'getPathForFile', 'webUtils', 'contextBridge',
  'useHashRoute', 'NAV', 'TIMING', 'draftIdle', 'savedFlash',
  'manualSave', 'touchBody', 'htmlRef', 'editorEpoch', 'putIntoEditor', 'scheduleDraft', 'saveState',
  'saveNoteHtml', 'sanitizeHtml', 'writeNote', 'pruneVersions', 'note_version',
  'SCHEMA_VERSION', 'migrate', 'openDatabase', 'addColumnIfMissing',
  'api.saveNote', 'api.invoke', 'note:save', 'rollbackVersion',
  'createFocus', 'restore', 'endAt',
  'net.fetch', 'safeStorage', 'DatabaseSync', 'tightenCspInBuild', 'electronDist'
];
const missingIds = [];
for (const id of ids) {
  if (id === 'api.saveNote') { if (!corpus.includes('saveNote')) missingIds.push(id); continue; }
  if (id === 'api.invoke') { if (!corpus.includes('invoke')) missingIds.push(id); continue; }
  if (id === 'paths.DEFAULT_DATA_ROOT') continue;
  if (!corpus.includes(id)) missingIds.push(id);
}
if (missingIds.length) fails.push('源码中未找到这些标识符：' + missingIds.join('、'));

/* ---------- 3. 行号残留 ---------- */
const lineRefs = [...md.matchAll(/[\w./-]+\.(?:ts|tsx|css|mjs|js|json|yml):\d+/g)].map((m) => m[0]);
if (lineRefs.length) fails.push('仍残留 path:line 引用：' + lineRefs.join('、'));

/* ---------- 4. Mermaid ---------- */
const mermaidBlocks = [...md.matchAll(/```mermaid\n([\s\S]*?)```/g)].map((m) => m[1].trim());
const mermaidIssues = [];
const mermaidChecks = [];
mermaidBlocks.forEach((code, i) => {
  const first = code.split('\n')[0].trim();
  const okStart = /^(flowchart|graph|sequenceDiagram|stateDiagram-v2|erDiagram|classDiagram|gantt|pie|journey|gitGraph)\b/.test(first);
  if (!okStart) mermaidIssues.push(`第 ${i + 1} 张图首行不合法：${first}`);
  // 括号/引号配对（忽略引号内的内容）
  let depth = 0;
  let quote = null;
  for (const ch of code) {
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '[' || ch === '(' || ch === '{') depth++;
    if (ch === ']' || ch === ')' || ch === '}') depth--;
    if (depth < 0) break;
  }
  if (depth !== 0 || quote) mermaidIssues.push(`第 ${i + 1} 张图括号/引号不配对（depth=${depth}, quote=${quote}）`);
  mermaidChecks.push(`图 ${i + 1}: ${first}，${code.split('\n').length} 行`);
});

async function renderOne(code) {
  const payload = JSON.stringify({ code, mermaid: { theme: 'default' } });
  const deflated = zlib.deflateSync(Buffer.from(payload, 'utf8'));
  const variants = [
    deflated.toString('base64url'),
    Buffer.from(JSON.stringify({ code }), 'utf8').toString('base64url'),
    Buffer.from(code, 'utf8').toString('base64url')
  ];
  for (const v of variants) {
    const url = 'https://mermaid.ink/svg/' + v;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (res.ok) {
        const text = await res.text();
        if (/<svg/i.test(text)) return { ok: true, url };
      }
    } catch {
      /* 换下一种编码继续试 */
    }
  }
  return { ok: false };
}

(async () => {
  if (!mermaidIssues.length) {
    for (let i = 0; i < mermaidBlocks.length; i++) {
      const r = await renderOne(mermaidBlocks[i]);
      if (r.ok) mermaidChecks.push(`图 ${i + 1} 在线渲染通过：${r.url}`);
      else { mermaidIssues.push(`图 ${i + 1} 在线渲染失败（结构校验已通过）`); break; }
    }
  }

  /* ---------- 5. 字数 ---------- */
  const prose = md
    .split('\n')
    .filter((l) => !/^```/.test(l)) // 去掉代码围栏行（图/目录树/命令另列）
    .join('\n');
  const cjk = (prose.match(/[\u4e00-\u9fa5]/g) || []).length;
  const tableRows = md.split('\n').filter((l) => /^\|/.test(l)).length;

  console.log('===== TECH_REPORT.md 自检 =====');
  console.log('1) 路径核验：已核对', checkedPaths.length, '个，失败', fails.filter((f) => f.startsWith('路径不存在')).length, '个');
  console.log('   核对清单：');
  for (const p of checkedPaths) console.log('   ✓', p);
  console.log('2) 标识符核验：核对', ids.length, '个，缺失', missingIds.length, '个');
  console.log('3) path:line 残留：', lineRefs.length, '处');
  console.log('4) Mermaid：共', mermaidBlocks.length, '张');
  for (const c of mermaidChecks) console.log('   ·', c);
  if (mermaidIssues.length) console.log('   ✗', mermaidIssues.join(' | '));
  console.log('5) 中文字数（不含代码块围栏行）：', cjk, '字；表格行：', tableRows);
  console.log('===== 结论 =====');
  const allFails = [...fails, ...mermaidIssues];
  if (allFails.length) { console.log('FAIL'); for (const f of allFails) console.log(' -', f); process.exitCode = 1; }
  else console.log('PASS：路径、函数、无行号、Mermaid 渲染检查全部通过');
})();
