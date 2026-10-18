/* 一次性发布脚本：创建 GitHub Release v0.8.3（跑完删除） */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const owner = 'x-000001';
const repo = 'zhishiku';
const tag = 'v0.8.3';
const name = '0.8.3 - AI「测试连接」解析兼容';
const body = fs.readFileSync(path.join(root, '.tools/release-083-notes.md'), 'utf8');

function token() {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN.trim();
  const out = execFileSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
    cwd: root
  });
  const line = out.split(/\r?\n/).find((item) => item.startsWith('password='));
  if (!line) throw new Error('拿不到 GitHub token');
  return line.slice('password='.length).trim();
}

(async () => {
  const gh = token();
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${gh}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'jw-kb-release'
    },
    body: JSON.stringify({ tag_name: tag, name, body, draft: false, prerelease: false })
  });
  const text = await res.text();
  console.log('status=', res.status);
  if (!res.ok) {
    console.log(text.slice(0, 600));
    process.exit(1);
  }
  const json = JSON.parse(text);
  console.log('release id=', json.id);
  console.log('url=', json.html_url);
  fs.writeFileSync(path.join(root, '.tools', '.release-083.json'), JSON.stringify({ id: json.id, url: json.html_url }, null, 2));
})().catch((err) => {
  console.error('FAILED', err.message);
  process.exit(1);
});
