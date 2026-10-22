#!/usr/bin/env node
/**
 * 发版脚本：把「建 GitHub Release + 上传安装包 + 回填发布链接/字节数」这三步自动化。
 *
 * 用法（Windows PowerShell 5.1 下 `npm run release -- --apply` 的 `--apply` 会被 npm 吞掉、只跑预演，
 *      所以真发一律直接跑 node；cmd.exe 下两种写法都行）：
 *   node .tools/release.mjs                 # 预演（只读：核对版本/tag/安装包/Release 现状，不发写请求）
 *   node .tools/release.mjs --apply         # 真发：建（或更新）Release、上传/替换安装包、回填文档占位符
 *   node .tools/release.mjs --apply --asset "D:\\path\\Jw知识库-安装包-0.11.2.exe"
 *
 * 前置条件（按 DEVELOPER_GUIDE.md §10.1 发版 SOP）：
 *   1. npm run dist 已经产出安装包到 C:\JwKB\setup\Jw知识库-安装包-<版本>.exe
 *   2. package.json / package-lock.json 版本号已改好
 *   3. CHANGELOG.md 里已有 `## [<版本>]` 小节（脚本用它当 Release 说明，自动去掉「发布：」占位行）
 *   4. 版本 tag 已创建并 push（脚本只校验，不替你 push）
 *   5. 有 GitHub 写权限：优先读环境变量 GITHUB_TOKEN，否则用本机 git 凭据（git credential fill）
 *
 * 本机 TLS 的证书吊销检查会失败，所以脚本内部统一调 `curl.exe --ssl-no-revoke`（和 SOP 一致）。
 * Token 不会打印，也不会落盘。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const REPO = 'x-000001/zhishiku';
const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const assetArgIdx = args.indexOf('--asset');
const ASSET_OVERRIDE = assetArgIdx >= 0 ? args[assetArgIdx + 1] : '';
const PLACEHOLDER_FILES = ['CHANGELOG.md', 'README.md', '验收清单.md', '开发计划.md'];

function log(msg) {
  console.log(msg);
}
function fail(msg) {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
}
function readText(file) {
  return fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
}
function writeText(file, text) {
  fs.writeFileSync(path.join(REPO_ROOT, file), text);
}

function git(args2, { allowFail = false, input = undefined, encoding = 'utf8' } = {}) {
  try {
    return execFileSync('git', args2, { cwd: REPO_ROOT, encoding, input, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch (err) {
    if (allowFail) return '';
    throw new Error(`git ${args2.join(' ')} 失败：${(err.stderr || err.message).toString().trim()}`);
  }
}

/** 调 curl（本机吊销检查会失败，统一 --ssl-no-revoke；--fail-with-body 让非 2xx 走异常但保留响应体）。 */
function curl(args2) {
  try {
    return execFileSync(
      'curl.exe',
      ['-sS', '--ssl-no-revoke', '--fail-with-body', '--max-time', '300', ...args2],
      { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
    ).trim();
  } catch (err) {
    const body = (err.stdout || '').toString().trim();
    throw new Error(`curl 失败：${body.slice(0, 400) || (err.stderr || err.message).toString().trim()}`);
  }
}

function readToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN.trim();
  const out = git(['credential', 'fill'], { input: 'protocol=https\nhost=github.com\n\n' });
  const line = out.split(/\r?\n/).find((l) => l.startsWith('password='));
  if (!line) fail('取不到 GitHub 凭据：请设置 GITHUB_TOKEN，或先 `git push` 登录一次让本机记住凭据。');
  return line.slice('password='.length);
}

function api(token, method, apiPath, body) {
  const args2 = [
    '-X', method,
    '-H', `Authorization: Bearer ${token}`,
    '-H', 'Accept: application/vnd.github+json',
    '-H', 'Content-Type: application/json',
  ];
  if (body !== undefined) args2.push('--data-binary', JSON.stringify(body));
  args2.push(`https://api.github.com${apiPath}`);
  const text = curl(args2);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`GitHub API 返回的不是 JSON：${text.slice(0, 300)}`);
  }
}

function uploadAsset(token, releaseId, file, assetName) {
  const text = curl([
    '-X', 'POST',
    '-H', `Authorization: Bearer ${token}`,
    '-H', 'Content-Type: application/octet-stream',
    '--data-binary', `@${file}`,
    `https://uploads.github.com/repos/${REPO}/releases/${releaseId}/assets?name=${encodeURIComponent(assetName)}`,
  ]);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`上传接口返回的不是 JSON：${text.slice(0, 300)}`);
  }
}

/** 从 CHANGELOG 里抠出某个版本的小节，去掉「发布：」占位行，作为 Release 说明。 */
function changelogSection(version) {
  const text = readText('CHANGELOG.md');
  const header = new RegExp(`^## \\[${version.replace(/\./g, '\\.')}\\][^\\n]*$`, 'm');
  const m = header.exec(text);
  if (!m) fail(`CHANGELOG.md 里找不到 \`## [${version}]\` 小节，请先写发布说明。`);
  const rest = text.slice(m.index + m[0].length);
  const end = rest.search(/^## \[/m);
  const raw = (end === -1 ? rest : rest.slice(0, end)).trim();
  const cleaned = raw
    .split(/\r?\n/)
    .filter((line) => !line.includes('__REL_LINK__') && !line.includes('__BYTES__'))
    .filter((line) => !line.trim().startsWith('发布：'))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!cleaned) fail(`CHANGELOG.md 的 ${version} 小节是空的，没法当发布说明。`);
  return cleaned;
}

function formatBytes(n) {
  return n.toLocaleString('en-US');
}

function main() {
  const pkg = JSON.parse(readText('package.json'));
  const version = String(pkg.version || '');
  if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`package.json 里的版本号不合法：${version}`);

  log(`\n=== 发布预演（${APPLY ? 'APPLY：会真的写 GitHub' : 'DRY-RUN：只读'}）===`);
  log(`仓库：${REPO}`);
  log(`版本：${version}`);

  // 1. 安装包
  const defaultInstaller = `C:\\JwKB\\setup\\Jw知识库-安装包-${version}.exe`;
  const installer = ASSET_OVERRIDE || defaultInstaller;
  if (!fs.existsSync(installer)) {
    fail(`找不到安装包：${installer}\n先跑 \`npm run dist\`，或用 --asset 指定路径。`);
  }
  const size = fs.statSync(installer).size;
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(installer)).digest('hex');
  const assetName = `JwKB-Setup-${version}.exe`;
  log(`安装包：${installer}（${formatBytes(size)} 字节）`);
  log(`SHA256：${sha256}`);
  log(`Release 附件名：${assetName}`);

  // 2. tag：本地必须存在，远端必须已存在（脚本不替你 push）
  const tag = `v${version}`;
  const localTag = git(['rev-parse', '-q', '--verify', `refs/tags/${tag}`], { allowFail: true });
  if (!localTag) fail(`本地没有 tag ${tag}，先按 SOP 建 annotated tag 并 push。`);
  const remoteTag = git(['ls-remote', '--tags', 'origin', tag], { allowFail: true });
  if (!remoteTag) fail(`远端没有 tag ${tag}，先 \`git push origin ${tag}\`。`);
  log(`tag：${tag}（本地 + 远端都有）`);
  const head = git(['rev-parse', '--short', 'HEAD']);
  const tagCommit = git(['rev-parse', '--short', `refs/tags/${tag}^{commit}`]);
  log(`HEAD=${head}，tag 指向=${tagCommit}${head === tagCommit ? '' : '（注意：tag 不在 HEAD 上）'}`);

  // 3. 凭证
  const token = readToken();
  log(`凭证：已取到（长度 ${token.length}，不打印）`);

  // 4. Release 现状
  let release = null;
  try {
    release = api(token, 'GET', `/repos/${REPO}/releases/tags/${tag}`);
  } catch {
    release = null;
  }
  const existingAsset = release?.assets?.find((a) => a.name === assetName);
  if (release) {
    log(`Release：已存在（id=${release.id}，附件 ${release.assets.length} 个）`);
    if (existingAsset) log(`  - 已有附件 ${existingAsset.name}：${formatBytes(existingAsset.size)} 字节（state=${existingAsset.state}）`);
  } else {
    log('Release：还不存在，--apply 时会新建');
  }

  // 5. 发布说明
  const section = changelogSection(version);
  const body = `${section}\n\n### 安装包\n\n- 附件 \`${assetName}\`：${formatBytes(size)} 字节，SHA256 \`${sha256}\`\n- 已装旧版本的机器可在设置页点「检查更新」升级（版本号按数字段比较）。`;
  log(`发布说明：从 CHANGELOG 抠到 ${section.split('\n').length} 行 + 安装包信息`);

  // 6. 文档占位符
  const placeholders = PLACEHOLDER_FILES.map((file) => {
    const text = readText(file);
    return { file, rel: (text.match(/__REL_LINK__/g) || []).length, bytes: (text.match(/__BYTES__/g) || []).length };
  }).filter((x) => x.rel || x.bytes);
  if (placeholders.length === 0) {
    log('文档占位符：没有（可能已经回填过，跳过回填）');
  } else {
    log('文档占位符：' + placeholders.map((p) => `${p.file} rel=${p.rel} bytes=${p.bytes}`).join('，'));
  }

  if (!APPLY) {
    log('\n以上只是预演。确认无误后跑：npm run release -- --apply');
    return;
  }

  // 7. 建 / 更新 Release
  let releaseId = release?.id;
  if (!release) {
    const created = api(token, 'POST', `/repos/${REPO}/releases`, {
      tag_name: tag,
      name: `${version} — ${pkg.productName || 'Jw 知识库'} ${version}`,
      body,
      draft: false,
      prerelease: false,
    });
    releaseId = created.id;
    log(`✓ 已新建 Release：${created.html_url}（id=${releaseId}）`);
  } else {
    if (args.includes('--update-body')) {
      api(token, 'PATCH', `/repos/${REPO}/releases/${releaseId}`, { body });
      log(`✓ 已覆盖 Release 说明（id=${releaseId}）`);
    } else {
      log('Release 已存在：默认不动说明，保留手写的补丁段落；要覆盖请加 --update-body');
    }
  }

  // 8. 上传 / 替换附件
  if (existingAsset && existingAsset.size === size) {
    log(`✓ 附件已是最新（${formatBytes(size)} 字节），跳过上传`);
  } else {
    if (existingAsset) {
      api(token, 'DELETE', `/repos/${REPO}/releases/assets/${existingAsset.id}`);
      log(`✓ 已删旧附件（id=${existingAsset.id}）`);
    }
    const uploaded = uploadAsset(token, releaseId, installer, assetName);
    log(`✓ 已上传附件：${uploaded.name}（${formatBytes(uploaded.size)} 字节，state=${uploaded.state}）`);
  }

  // 9. 回填文档
  if (placeholders.length > 0) {
    const link = `[GitHub Release ${tag}](https://github.com/${REPO}/releases/tag/${tag})`;
    const bytes = formatBytes(size);
    for (const p of placeholders) {
      const text = readText(p.file).split('__REL_LINK__').join(link).split('__BYTES__').join(bytes);
      writeText(p.file, text);
      log(`✓ 已回填 ${p.file}`);
    }
    log('下一步：node .tools/check-doc.cjs DEVELOPER_GUIDE.md TECH_REPORT.md README.md → git add/commit/push 文档');
  }
  log(`\n发布完成：https://github.com/${REPO}/releases/tag/${tag}`);
}

try {
  main();
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}
