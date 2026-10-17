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
  log(`安装包（构建产物，别在这儿双击）：${path.join(targetDir, file)}（${(fs.statSync(path.join(targetDir, file)).size / 1048576).toFixed(1)} MB）`);
}

// 6.1 绿色版目录也同步回来 —— 否则 release\win-unpacked 会一直停在上一次 npm run pack 的旧版本
const unpackedSrc = path.join(outDir, 'win-unpacked');
if (fs.existsSync(unpackedSrc)) {
  const unpackedDst = path.join(targetDir, 'win-unpacked');
  fs.rmSync(unpackedDst, { recursive: true, force: true });
  fs.cpSync(unpackedSrc, unpackedDst, { recursive: true });
  log(`绿色版目录：${unpackedDst}（已同步成这次构建）`);
}

// 7. 交付目录：必须在**项目目录之外**，否则双击会安装失败（见文件头说明）。
//    默认放 C:\JwKB（纯英文、路径短、好找），可用 JWKB_OUT_DIR 改。
//    注意：不要把交付目录设到「桌面」—— DSH 沙箱对工作区外的写入可能被重定向，
//    从命令行看到「写成功了」并不代表真实桌面上真有那份文件。
const handoffRoot = process.env.JWKB_OUT_DIR || path.join(path.parse(project).root, 'JwKB');
const setupDir = path.join(handoffRoot, 'setup');
const portableDir = path.join(handoffRoot, 'portable');

try {
  fs.rmSync(setupDir, { recursive: true, force: true });
  fs.mkdirSync(setupDir, { recursive: true });
  for (const file of produced) {
    fs.copyFileSync(path.join(outDir, file), path.join(setupDir, file));
  }
  if (fs.existsSync(unpackedSrc)) {
    fs.rmSync(portableDir, { recursive: true, force: true });
    fs.cpSync(unpackedSrc, portableDir, { recursive: true });
  }
  fs.writeFileSync(
    path.join(handoffRoot, '使用说明.txt'),
    [
      'Jw 知识库 —— 两个都在这儿，任选一个用：',
      '',
      '  办法一（推荐，免安装）：双击 portable\\Jw知识库.exe',
      '  办法二（正式安装）：双击 setup\\' + produced[0],
      '',
      '重要：不要到项目目录 C:\\Users\\29785\\Desktop\\Jw的app\\release\\ 里双击安装包。',
      '项目目录被加了「拒绝删除文件」的权限（沙箱保护工作区），安装器要在自己所在目录',
      '写临时文件，会被拒，于是弹出：',
      '  NSIS Error: Error writing temporary file. Make sure your temp folder is valid.',
      '把安装包放在任何别的目录（比如这个文件夹）就正常。',
      '',
      '数据默认存在 D:\\Jw知识库\\ ，两个办法共用同一份数据，可以随便混着用。',
      '',
      '以后有新版本怎么更新：打开应用 → 左侧「设置」→ 卡片「软件更新」→ 点「检查更新」；',
      '  发现有新版本就点「下载并安装」，它会自己下载、校验、静默装好并重新打开新版本，',
      '  数据目录不变。也可以到 https://github.com/x-000001/zhishiku/releases 手动下载安装包覆盖安装。',
      ''
    ].join('\r\n'),
    'utf8'
  );
  log(`交付目录：${handoffRoot}（setup\\ 安装包 + portable\\ 绿色版 + 使用说明.txt）`);
} catch (err) {
  log('写交付目录失败（不影响后面 release\\ 里的产物）：' + err.message);
}

// 7.1 顺手把项目目录里的安装包删掉，避免手滑在项目目录里双击（删失败的旧版本也一并清）
try {
  const stale = fs
    .readdirSync(targetDir)
    .filter((f) => f.endsWith('.exe') || f.endsWith('.nsis.7z'));
  for (const file of stale) {
    fs.rmSync(path.join(targetDir, file), { force: true });
  }
  fs.writeFileSync(
    path.join(targetDir, '请先看这里.txt'),
    [
      '这个 release 目录里没有可以直接双击的安装包——是故意的。',
      '',
      '项目目录带「拒绝删除文件」权限（沙箱保护工作区），安装器要在自己所在目录写临时文件，',
      '在这儿双击一定报：NSIS Error: Error writing temporary file. Make sure your temp folder is valid.',
      '',
      `安装包和绿色版都在：${handoffRoot}\\`,
      '  setup\\     —— 安装程序',
      '  portable\\  —— 免安装绿色版，双击 Jw知识库.exe 即用',
      ''
    ].join('\r\n'),
    'utf8'
  );
  if (stale.length) log(`已清掉项目目录里的安装包：${stale.join('、')}`);
} catch (err) {
  log('清理项目目录里的安装包失败：' + err.message);
}

console.log('');
console.log(`完成。两个办法任选一个：`);
console.log(`  免安装：${path.join(portableDir, 'Jw知识库.exe')}`);
console.log(`  装一下：${path.join(setupDir, produced[0])}`);
console.log('（别在项目目录 release\\ 里双击安装包，那里会报 NSIS 临时文件错误。）');
