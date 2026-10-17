import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

const files = walk('src');
let total = 0;
let casts = 0;
let nonNull = 0;
let errCast = 0;
let catchCast = 0;
let setTimeoutCount = 0;
let disables = 0;
const per = [];
for (const f of files) {
  const src = readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
  const n = src.split('\n').length;
  total += n;
  const c = (src.match(/\bas\s+[A-Z][A-Za-z0-9_<>,.[\] |]*/g) || []).length;
  const nn = (src.match(/[A-Za-z0-9_)\]]!(?=[.;,)\s])/g) || []).length;
  const ec = (src.match(/\(err as Error\)/g) || []).length;
  const cc = (src.match(/\.catch\(\(err: Error\)/g) || []).length;
  const st = (src.match(/setTimeout\(/g) || []).length;
  const dis = (src.match(/eslint-disable-next-line react-hooks\/exhaustive-deps/g) || []).length;
  casts += c; nonNull += nn; errCast += ec; catchCast += cc; setTimeoutCount += st; disables += dis;
  per.push([f, n, c, nn]);
}
per.sort((a, b) => b[1] - a[1]);
console.log(`文件数=${files.length} 总行数=${total}`);
console.log(`as 断言=${casts}  非空断言=${nonNull}  (err as Error)=${errCast}  .catch((err: Error)=${catchCast}  setTimeout=${setTimeoutCount}  deps禁用=${disables}`);
console.log('--- 最大 8 个文件 ---');
for (const [f, n, c, nn] of per.slice(0, 8)) console.log(`${f}  ${n} 行  as=${c} ! =${nn}`);
