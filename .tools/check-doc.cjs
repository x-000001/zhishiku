#!/usr/bin/env node
/**
 * 文档引用校验器：检查 Markdown 里所有反引号包裹的 `path:line` 引用
 *   1. 文件真实存在（支持全路径；也支持只写文件名，按唯一同名匹配解析）
 *   2. 行号不超过文件总行数（`a-b` 形式取 b；纯文件无行号则跳过）
 *   3. 统计 Mermaid 图数量（要求 >= 2）
 *
 * 用法：node .tools/check-doc.cjs DEVELOPER_GUIDE.md [TECH_REPORT.md ...]
 * 退出码：0 全部通过；1 有 MISSING / BAD-LINE / 图不足。
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const EXTS = 'ts|tsx|js|mjs|cjs|css|json|yml|yaml|md|nsh|txt|html';
// 只认这几种「像文件」的写法，避免把 `npm run dev`、`owner/repo` 当路径
const REF_RE = new RegExp('`([A-Za-z0-9_@./-]+\\.(?:' + EXTS + '))(:(\\d+)(?:-(\\d+))?)?`', 'g');

function walk(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git' || name === 'out' || name === 'dist') continue;
    const full = path.join(dir, name);
    let st;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(full, out);
    else out.push(full);
  }
}

const allFiles = [];
walk(ROOT, allFiles);
const byBase = new Map();
for (const f of allFiles) {
  const base = path.basename(f);
  if (!byBase.has(base)) byBase.set(base, []);
  byBase.get(base).push(f);
}

function lineCount(file) {
  const text = fs.readFileSync(file, 'utf8');
  if (text.length === 0) return 0;
  return text.split('\n').length;
}

function resolveRef(ref) {
  const abs = path.resolve(ROOT, ref);
  if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return abs;
  // 只写了文件名：按唯一同名文件解析（报告里常见 `styles.css:6` 这种简写）
  if (!ref.includes('/') && !ref.includes('\\')) {
    const hits = byBase.get(path.basename(ref)) || [];
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) return { ambiguous: hits.length };
  }
  return null;
}

let failed = 0;
const targets = process.argv.slice(2);
if (targets.length === 0) {
  console.error('用法：node .tools/check-doc.cjs <文件.md> [...更多.md]');
  process.exit(1);
}

for (const target of targets) {
  const docPath = path.resolve(process.cwd(), target);
  if (!fs.existsSync(docPath)) {
    console.error('MISSING-DOC ' + target);
    failed += 1;
    continue;
  }
  const text = fs.readFileSync(docPath, 'utf8');
  const lines = text.split('\n');
  const mermaid = (text.match(/```mermaid/g) || []).length;
  const refs = [];
  let m;
  REF_RE.lastIndex = 0;
  while ((m = REF_RE.exec(text))) {
    const ref = m[1];
    const start = m[3] ? Number.parseInt(m[3], 10) : null;
    const end = m[4] ? Number.parseInt(m[4], 10) : start;
    const lineNo = (text.slice(0, m.index).match(/\n/g) || []).length + 1;
    refs.push({ ref, start, end, line: lineNo });
  }

  const missing = [];
  const badLine = [];
  const ambiguous = [];
  const checked = new Set();
  for (const item of refs) {
    const key = item.ref;
    if (!checked.has(key)) checked.add(key);
    const resolved = resolveRef(item.ref);
    if (resolved && typeof resolved === 'object' && resolved.ambiguous) {
      ambiguous.push(item);
      continue;
    }
    if (!resolved) {
      missing.push(item);
      continue;
    }
    if (item.start != null) {
      const total = lineCount(resolved);
      if (item.start > total || item.end > total || item.start < 1) {
        badLine.push({ ...item, total });
      }
    }
  }

  const uniqMissing = [...new Map(missing.map((x) => [x.ref, x])).values()];
  const uniqBad = [...new Map(badLine.map((x) => [x.ref + ':' + x.start, x])).values()];
  const uniqAmb = [...new Map(ambiguous.map((x) => [x.ref, x])).values()];

  const name = path.basename(docPath);
  const needMermaid = /DEVELOPER_GUIDE|TECH_REPORT/.test(name);
  console.log('== ' + name + ' ==');
  console.log('字符数 ' + text.length + ' · 行数 ' + lines.length + ' · 路径引用 ' + checked.size + ' 处 · Mermaid ' + mermaid + ' 张');
  if (needMermaid && mermaid < 2) {
    console.log('FAIL Mermaid 图不足 2 张（实际 ' + mermaid + '）');
    failed += 1;
  }
  if (uniqMissing.length) {
    failed += 1;
    console.log('FAIL 找不到的文件（' + uniqMissing.length + '）：');
    for (const x of uniqMissing) console.log('  MISSING ' + x.ref + '  （第 ' + x.line + ' 行引用）');
  }
  if (uniqBad.length) {
    failed += 1;
    console.log('FAIL 行号越界（' + uniqBad.length + '）：');
    for (const x of uniqBad) console.log('  BAD-LINE ' + x.ref + ':' + x.start + '  文件只有 ' + x.total + ' 行（第 ' + x.line + ' 行引用）');
  }
  if (uniqAmb.length) {
    failed += 1;
    console.log('FAIL 同名文件不唯一，请写全路径（' + uniqAmb.length + '）：');
    for (const x of uniqAmb) console.log('  AMBIGUOUS ' + x.ref + '  （第 ' + x.line + ' 行引用）');
  }
  if (!uniqMissing.length && !uniqBad.length && !uniqAmb.length && mermaid >= 2) {
    console.log('PASS 全部引用真实存在、行号未越界、Mermaid ' + mermaid + ' 张');
  }
}

process.exit(failed === 0 ? 0 : 1);
