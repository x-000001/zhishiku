#!/usr/bin/env node
/**
 * DEVELOPER_GUIDE.md 自检：验证文档里引用的每个仓库路径真实存在、行号不越界，
 * 并检查 Mermaid 图表数量与语法关键字。
 * 用法：node .tools/check-guide.cjs
 */
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const guidePath = path.join(root, 'DEVELOPER_GUIDE.md');
const text = fs.readFileSync(guidePath, 'utf8');

const ALLOWED_PREFIX = [
  'src/',
  'tests/',
  'docs/',
  'resources/',
  '.tools/',
  'out/',
  'node_modules/'
];
const ROOT_FILES = new Set([
  'README.md',
  'CHANGELOG.md',
  'DEVELOPER_GUIDE.md',
  'PRD.md',
  '验收清单.md',
  '开发计划.md',
  '功能分析文档.md',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'vitest.config.ts',
  'electron.vite.config.ts',
  'electron-builder.yml',
  '.npmrc',
  '.gitignore'
]);
// 构建产物 / 依赖目录：允许“仓库里暂时不存在”
const OPTIONAL_PREFIX = ['out/', 'node_modules/'];

const FILE_RE =
  /((?:src|tests|docs|resources|\.tools|out|node_modules)[\\/][A-Za-z0-9_./\\\u4e00-\u9fa5-]+\.(?:tsx|ts|css|mjs|cjs|json|yml|yaml|md|html|nsh|png|ico|txt|log)|(?:README|CHANGELOG|DEVELOPER_GUIDE|PRD|验收清单|开发计划|功能分析文档)\.md|package(?:-lock)?\.json|tsconfig\.json|vitest\.config\.ts|electron\.vite\.config\.ts|electron-builder\.yml|\.npmrc|\.gitignore)(?::([\d/,\-]+))?/g;

const lineCache = new Map();
function lineCount(rel) {
  if (lineCache.has(rel)) return lineCache.get(rel);
  const abs = path.join(root, rel);
  const n = fs.readFileSync(abs, 'utf8').split(/\r?\n/).length;
  lineCache.set(rel, n);
  return n;
}

function normalize(raw) {
  let p = raw.replace(/\\/g, '/');
  p = p.replace(/^\.\//, '');
  return p;
}

function isInside(p) {
  const norm = p + (p.endsWith('/') ? '' : '');
  return ALLOWED_PREFIX.some((pre) => norm.startsWith(pre)) || ROOT_FILES.has(norm);
}

function isOptional(p) {
  return OPTIONAL_PREFIX.some((pre) => p.startsWith(pre));
}

const checks = [];
const skipped = [];
let pending = null;
const seen = new Set();

function expandNumbers(spec) {
  const nums = [];
  for (const part of spec.split(/[/,]/)) {
    const rng = part.split('-');
    if (rng.length === 2) {
      const a = Number(rng[0]);
      const b = Number(rng[1]);
      if (Number.isFinite(a) && Number.isFinite(b)) {
        // 区间只校验两端，避免枚举上百行
        nums.push(a, b);
      }
    } else if (part.trim() !== '') {
      const n = Number(part);
      if (Number.isFinite(n)) nums.push(n);
    }
  }
  return nums;
}

for (const m of text.matchAll(FILE_RE)) {
  const rawPath = m[1];
  const numSpec = m[2] || '';
  const p = normalize(rawPath);
  if (!isInside(p)) {
    skipped.push(p);
    continue;
  }
  if (!p.includes('/') && !ROOT_FILES.has(p)) {
    skipped.push(p);
    continue;
  }
  const key = p + '|' + numSpec;
  if (seen.has(key)) continue;
  seen.add(key);

  const abs = path.join(root, p);
  const exists = fs.existsSync(abs);
  const entry = { path: p, numSpec, exists, lineIssues: [], optional: isOptional(p) };

  if (exists && numSpec) {
    const total = lineCount(p);
    const want = expandNumbers(numSpec);
    for (const n of want) {
      if (n < 1 || n > total) entry.lineIssues.push(`${n} > 总行数 ${total}`);
    }
  }
  checks.push(entry);
}

const mermaidBlocks = [...text.matchAll(/```mermaid\r?\n([\s\S]*?)```/g)].map((m) => m[1].trim());
const VALID_DIAGRAM = [
  'flowchart',
  'graph',
  'sequenceDiagram',
  'stateDiagram',
  'stateDiagram-v2',
  'classDiagram',
  'erDiagram',
  'gantt',
  'pie',
  'mindmap',
  'timeline',
  'journey',
  'block-beta'
];
const badMermaid = mermaidBlocks
  .map((body, i) => ({ i, first: (body.split('\n')[0] || '').trim() }))
  .filter((b) => !VALID_DIAGRAM.some((kw) => b.first.startsWith(kw)));

const missing = checks.filter((c) => !c.exists && !c.optional);
const optionalMissing = checks.filter((c) => !c.exists && c.optional);
const badLines = checks.filter((c) => c.lineIssues.length > 0);

console.log('===== DEVELOPER_GUIDE.md 路径核对报告 =====');
console.log(`文档：DEVELOPER_GUIDE.md（${text.length} 字符 / ${text.split(/\r?\n/).length} 行）`);
console.log(`引用检查：${checks.length} 处（唯一路径+行号组合），文件存在 ${checks.filter((c) => c.exists).length} 处`);
console.log(`Mermaid 图：${mermaidBlocks.length} 张，语法关键字合规 ${mermaidBlocks.length - badMermaid.length} 张`);
console.log('');

if (checks.length) {
  console.log('--- 逐条结果 ---');
  for (const c of checks) {
    const tags = [];
    if (!c.exists) tags.push(c.optional ? 'OPTIONAL-MISS' : 'MISSING');
    if (c.lineIssues.length) tags.push('BAD-LINE: ' + c.lineIssues.join('; '));
    const verdict = tags.length ? tags.join(' | ') : 'OK';
    console.log(`${verdict.padEnd(28)} ${c.path}${c.numSpec ? ':' + c.numSpec : ''}`);
  }
  console.log('');
}

if (skipped.length) {
  console.log(`跳过（非仓库路径/裸文件名）：${skipped.length} 处 → ${[...new Set(skipped)].slice(0, 12).join(', ')}`);
}

if (badMermaid.length) {
  console.log('');
  for (const b of badMermaid) console.log(`MERMAID-BAD  #${b.i + 1} 首行：${b.first}`);
}

const fail = missing.length + badLines.length + badMermaid.length + (mermaidBlocks.length < 2 ? 1 : 0);
console.log('');
console.log(
  `合计：路径 ${checks.length} 处，缺失 ${missing.length} 处，行号越界 ${badLines.length} 处，` +
    `可选缺失 ${optionalMissing.length} 处，Mermaid 问题 ${badMermaid.length + (mermaidBlocks.length < 2 ? 1 : 0)} 处`
);
if (fail === 0) {
  console.log('结论：PASS（文档中的路径与行号全部真实，Mermaid 图 ≥ 2 张）');
} else {
  console.log('结论：FAIL（见上面的 MISSING / BAD-LINE / MERMAID-BAD）');
}
process.exit(fail === 0 ? 0 : 1);
