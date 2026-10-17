import fs from "node:fs";
import path from "node:path";
const roots = ["src/main", "src/renderer/src", "src/shared", "src/preload"];
const files = [];
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(ts|tsx)$/.test(e.name)) files.push(p); } };
roots.forEach(walk);
const rows = [];
for (const f of files) {
  const src = fs.readFileSync(f, "utf8");
  const count = (re) => (src.match(re) || []).length;
  rows.push({
    file: f.replace(/\\/g, "/"),
    as: count(/\bas\s+[A-Z][\w<>,.[\] ]*/g),
    nonNull: count(/[)\w\]]!/g),
    useCallback: count(/useCallback\(/g),
    useMemo: count(/useMemo\(/g),
    useEffect: count(/useEffect\(/g),
    useState: count(/useState\(/g),
    lines: src.split(/\r?\n/).length
  });
}
rows.sort((a, b) => b.as + b.nonNull - (a.as + a.nonNull));
console.log(JSON.stringify(rows.filter((r) => r.as + r.nonNull > 0).slice(0, 18), null, 1));
console.log("TOTAL as=", rows.reduce((s, r) => s + r.as, 0), "nonNull=", rows.reduce((s, r) => s + r.nonNull, 0));
