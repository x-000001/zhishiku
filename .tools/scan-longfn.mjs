import fs from "node:fs";
import path from "node:path";
const roots = ["src/main", "src/renderer/src", "src/shared", "src/preload"];
const files = [];
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(ts|tsx)$/.test(e.name)) files.push(p); } };
roots.forEach(walk);
const out = [];
for (const f of files) {
  const lines = fs.readFileSync(f, "utf8").split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(/^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)|^\s*(?:export\s+)?const\s+(\w+)\s*=\s*(?:useCallback|useMemo)?\(?/);
    if (!m) continue;
    const name = m[1] || m[2];
    if (!name) continue;
    if (/^(?:useMemo|useCallback)$/.test(name)) continue;
    let depth = 0; let started = false; let end = i;
    for (let j = i; j < lines.length; j += 1) {
      for (const ch of lines[j]) { if (ch === "{") { depth += 1; started = true; } else if (ch === "}") depth -= 1; }
      if (started && depth <= 0) { end = j; break; }
      if (j - i > 400) { end = j; break; }
    }
    const len = end - i + 1;
    if (len >= 70) out.push({ file: f.replace(/\\/g, "/"), name, line: i + 1, len });
  }
}
out.sort((a, b) => b.len - a.len);
console.log(JSON.stringify(out.slice(0, 25), null, 1));
