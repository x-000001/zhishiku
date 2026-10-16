/**
 * 在 Windows 上打安装包。
 *
 * 为什么不能直接在当前目录跑 electron-builder：
 * electron-builder 会调用 NSIS 的 makensis.exe，而它的 `!tempfile` 宏会在「当前脚本所在目录」
 * 建临时文件。只要这个路径里有中文（本项目目录叫 `Jw的app`），makensis 就会报
 * `!tempfile: Unable to create temporary file!` 然后中止。
 * 所以这里把打包需要的东西复制/软链到一个纯英文路径下，在那里完成打包，再把安装包拷回来。
 *
 * 还有一件同样重要的事：**打包好的安装包不能放在项目目录里双击运行。**
 * 项目目录 `C:\Users\29785\Desktop\Jw的app` 上有一条「Everyone 拒绝 删除子目录和文件」的权限项
 * （DSH 沙箱为保护工作区加的，属于预期行为，不要手动删除）。NSIS 安装程序运行时会先在自己
 * 所在目录做一次「写临时文件再替换」的动作，被这条权限拒绝，于是弹出
 * `Error writing temporary file. Make sure your temp folder is valid.` 安装失败。
 * 所以第 6 步除了拷回 release\，还会把安装包另存一份到桌面上的英文目录，
 * 并提示用户从那里运行。装载位置可以用环境变量 JWKB_OUT_DIR 改。
 *
 * 用法：node .tools/build-installer.mjs
 * 可用环境变量 JWKB_BUILD_DIR 改暂存目录（必须是没有中文的路径）。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const project = path.resolve(here, '..');
const stage = process.env.JWKB_BUILD_DIR || path.join(path.parse(project).root, 'jwkb-build');
const ebCache = path.join(path.parse(project).root, 'jwkb-ebcache');

const log = (...args) => console.log('[打包]', ...args);

if (/[^\x20-\x7e]/.test(stage)) {
  console.error(`暂存目录必须是纯英文路径，现在是：${stage}`);
  process.exit(1);
}

// 0. 先确认编译产物存在
if (!fs.existsSync(path.join(project, 'out', 'main', 'index.js'))) {
  console.error('没有找到 out/，请先运行 npm run build');
  process.exit(1);
}

// 1. 清掉上一次的暂存目录（release 单独保留，最后会被覆盖）
fs.rmSync(path.join(stage, 'out'), { recursive: true, force: true });
fs.rmSync(path.join(stage, 'resources'), { recursive: true, force: true });
fs.rmSync(path.join(stage, 'release'), { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });

// 2. 复制打包真正需要的东西
for (const item of ['out', 'resources']) {
  fs.cpSync(path.join(project, item), path.join(stage, item), { recursive: true });
  log('已复制', item);
}
for (const file of ['package.json', 'electron-builder.yml']) {
  fs.copyFileSync(path.join(project, file), path.join(stage, file));
}

// 3. node_modules 用目录联接（junction），不占空间也不用等复制
const nmLink = path.join(stage, 'node_modules');
fs.rmSync(nmLink, { recursive: true, force: true });
try {
  fs.symlinkSync(path.join(project, 'node_modules'), nmLink, 'junction');
  log('已联接 node_modules');
} catch (err) {
  log('联接失败，改为直接复制 node_modules：' + err.message);
  fs.cpSync(path.join(project, 'node_modules'), nmLink, { recursive: true });
}

// 4. electron-builder 自己的缓存（NSIS 编译器）也必须在英文路径下
if (fs.existsSync(path.join(project, '.eb-cache')) && !fs.existsSync(ebCache)) {
  fs.cpSync(path.join(project, '.eb-cache'), ebCache, { recursive: true });
  log('已复制 electron-builder 缓存');
}

// 5. 开始打包
const cli = path.join(project, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js');
log('暂存目录：' + stage);
log('开始生成安装包（这一步通常要 1–3 分钟）…');

const res = spawnSync(process.execPath, [cli, '--win', 'nsis', '--x64'], {
  cwd: stage,
  stdio: 'inherit',
  env: {
    ...process.env,
    ELECTRON_BUILDER_CACHE: ebCache,
    ELECTRON_BUILDER_BINARIES_MIRROR:
      process.env.ELECTRON_BUILDER_BINARIES_MIRROR || 'https://npmmirror.com/mirrors/electron-builder-binaries/',
    ELECTRON_CACHE: process.env.ELECTRON_CACHE || path.join(project, '.electron-cache')
  }
});

if (res.status !== 0) {
  console.error('打包失败，退出码 ' + res.status);
  process.exit(res.status ?? 1);
}

// 6. 把安装包拷回项目目录
const outDir = path.join(stage, 'release');
const produced = fs.readdirSync(outDir).filter((f) => f.endsWith('.exe'));
if (produced.length === 0) {
  console.error('打包结束但没有找到 .exe，请检查上面的日志');
  process.exit(1);
}

const targetDir = path.join(project, 'release');
fs.mkdirSync(targetDir, { recursive: true });
for (const file of produced) {
  fs.copyFileSync(path.join(outDir, file), path.join(targetDir, file));
  log(`安装包：${path.join(targetDir, file)}（${(fs.statSync(path.join(targetDir, file)).size / 1048576).toFixed(1)} MB）`);
}

// 7. 再另存一份到项目目录之外 —— 项目目录里的那份双击会安装失败，见文件头说明
const handoffDir =
  process.env.JWKB_OUT_DIR || path.join(os.homedir(), 'Desktop', 'Jw知识库安装包');
try {
  fs.mkdirSync(handoffDir, { recursive: true });
  for (const file of produced) {
    fs.copyFileSync(path.join(outDir, file), path.join(handoffDir, file));
  }
  log(`可直接运行的副本：${handoffDir}`);
} catch (err) {
  log('另存副本失败（不影响 release\\ 里的产物）：' + err.message);
}

console.log('');
console.log(`完成。请双击这个文件安装：${path.join(handoffDir, produced[0])}`);
console.log('（release\\ 里那份是构建产物，留在项目目录里双击会报 NSIS 临时文件错误，别从那运行。）');
