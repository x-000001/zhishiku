const fs = require('node:fs');
const sizes = '112,589,040';
for (const f of ['CHANGELOG.md', '验收清单.md']) {
  let t = fs.readFileSync(f, 'utf8');
  const crlf = t.includes('\r\n');
  if (crlf) t = t.replace(/\r\n/g, '\n');
  const before = (t.match(/__BYTES__/g) || []).length;
  t = t.replace(/__BYTES__/g, sizes);
  fs.writeFileSync(f, crlf ? t.replace(/\n/g, '\r\n') : t);
  console.log(f, 'replaced', before);
}
