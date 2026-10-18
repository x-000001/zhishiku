/** 0.9.0 发布后回填：CHANGELOG 段首「发布：…」+ README 发布记录置顶。跑完可删。 */
const fs = require('node:fs');
const path = require('node:path');
const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
const write = (file, text) => fs.writeFileSync(path.join(root, file), text.replace(/\n/g, '\r\n'), 'utf8');

const LINK = 'https://github.com/x-000001/zhishiku/releases/tag/v0.9.0';
const ASSET = 'JwKB-Setup-0.9.0.exe';
const BYTES = '112,734,855';

let changelog = read('CHANGELOG.md');
const anchor = '## [0.9.0] - 2026-10-19\n';
if (!changelog.includes(anchor)) throw new Error('CHANGELOG 找不到 0.9.0 锚点');
changelog = changelog.replace(
  anchor,
  anchor + `\n发布：[GitHub Release v0.9.0](${LINK})（附件 ${ASSET}，${BYTES} 字节）\n`
);
write('CHANGELOG.md', changelog);

let readme = read('README.md');
const recordAnchor = '**发布记录**：0.8.3 已发到';
if (!readme.includes(recordAnchor)) throw new Error('README 找不到发布记录锚点');
readme = readme.replace(
  recordAnchor,
  `**发布记录**：0.9.0 已发到 [GitHub Release v0.9.0](${LINK})，附带 ${ASSET}（${BYTES} 字节）；0.8.3 已发到`
);
const tailAnchor = '装 0.8.2 的机器点「检查更新」会看到「发现新版本 0.8.3」；';
if (!readme.includes(tailAnchor)) throw new Error('README 找不到更新提示锚点');
readme = readme.replace(
  tailAnchor,
  '装 0.8.2 的机器点「检查更新」会看到「发现新版本 0.8.3」；装 0.8.3 的机器点「检查更新」会看到「发现新版本 0.9.0」；'
);
write('README.md', readme);
console.log('发布链接已回填');
