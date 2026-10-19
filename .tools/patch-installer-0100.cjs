const fs = require('node:fs');
const f = '.tools/build-installer.mjs';
let t = fs.readFileSync(f, 'utf8');
const crlf = t.includes('\r\n');
if (crlf) t = t.replace(/\r\n/g, '\n');

const anchor = "      '',\n      '0.8.2 顺手把 AI 设置的报错说清楚了：";
if (!t.includes(anchor)) throw new Error('anchor missing');

const addLines = [
  "      '0.10.0 加了「GitHub 同步」：设置页「GitHub」卡片用官方授权连上（Token 只在主进程、加密存本地），',",
  "      '  把仓库写成 owner/repo 一行一个；任务页右上角「⇅ 同步 GitHub」一点，就把那边 Open / Closed 的 Issue',",
  "      '  拉成本地待办（单向，不回写 GitHub；PR 会自动过滤；连着点两次不会重复建任务）。',",
  "      '',"
].join('\n');

t = t.replace(anchor, "      '',\n" + addLines + "\n      '0.8.2 顺手把 AI 设置的报错说清楚了：");
fs.writeFileSync(f, crlf ? t.replace(/\n/g, '\r\n') : t);
console.log('installer template patched');
