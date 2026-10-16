// 手动获取 Electron 二进制（绕过 @electron/get 的全局缓存目录，沙箱只允许写工作区）
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const root = process.cwd();
const pkg = JSON.parse(
  fs.readFileSync(path.join(root, 'node_modules/electron/package.json'), 'utf8')
);
const version = pkg.version;
const mirror = process.env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/';
const file = `electron-v${version}-win32-x64.zip`;
const base = `${mirror}${version}/`;

const cacheDir = path.join(root, '.electron-cache');
fs.mkdirSync(cacheDir, { recursive: true });
const zipPath = path.join(cacheDir, file);

console.log('electron version :', version);
console.log('download url     :', base + file);

const sumsRes = await fetch(base + 'SHASUMS256.txt');
if (!sumsRes.ok) throw new Error('SHASUMS256 fetch failed: ' + sumsRes.status);
const sums = await sumsRes.text();
const line = sums.split('\n').find((l) => l.trim().endsWith(file));
const expected = line ? line.trim().split(/\s+/)[0] : null;
console.log('expected sha256  :', expected);

const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

let needDownload = true;
if (fs.existsSync(zipPath)) {
  const cur = sha256(zipPath);
  if (expected && cur === expected) {
    console.log('cached zip OK    :', cur);
    needDownload = false;
  }
}

if (needDownload) {
  const res = await fetch(base + file);
  if (!res.ok) throw new Error('zip download failed: ' + res.status);
  const total = Number(res.headers.get('content-length') || 0);
  const chunks = [];
  let got = 0;
  for await (const chunk of res.body) {
    chunks.push(chunk);
    got += chunk.length;
    if (total) process.stdout.write(`\r  ${(got / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB`);
  }
  process.stdout.write('\n');
  fs.writeFileSync(zipPath, Buffer.concat(chunks));
  console.log('downloaded bytes :', got);
}

const actual = sha256(zipPath);
console.log('actual sha256    :', actual);
if (expected && actual !== expected) throw new Error('CHECKSUM_MISMATCH');
console.log('CHECKSUM_OK');
console.log('ZIP_PATH=' + zipPath);
