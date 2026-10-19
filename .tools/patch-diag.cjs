const fs = require('node:fs');
function patchMain() {
  const file = 'src/main/index.ts';
  let text = fs.readFileSync(file, 'utf8');
  const anchor = 'function startup(): void {';
  if (!text.includes(anchor)) throw new Error('startup anchor missing');
  if (!text.includes('[env] JWKB_GITHUB_CLIENT_ID')) {
    text = text.replace(
      anchor,
      anchor +
        "\n  console.log('[env] JWKB_GITHUB_CLIENT_ID=' + JSON.stringify(process.env.JWKB_GITHUB_CLIENT_ID || '') + ' API_BASE=' + JSON.stringify(process.env.JWKB_GITHUB_API_BASE || ''));"
    );
    fs.writeFileSync(file, text);
  }
  console.log('main patched');
}
function patchE2e() {
  const file = 'tests/e2e/cdp-check.mjs';
  let text = fs.readFileSync(file, 'utf8');
  const oldBody = [
    "    const inv = (ch, p) => window.api.invoke(ch, p);",
    "    const bad = await inv('github:config:set', { repos: ['not a repo', 'octo/demo', 'octo/second'] });",
    "    const code = await inv('github:request-code');",
    "    const status = await inv('github:poll-token');",
    '    return { bad, code, status };'
  ].join('\n');
  if (!text.includes(oldBody)) throw new Error('e2e ghSetup body missing');
  const newBody = [
    "    const inv = (ch, p) => window.api.invoke(ch, p);",
    "    const bad = await inv('github:config:set', { repos: ['not a repo', 'octo/demo', 'octo/second'] });",
    "    const before = await inv('github:status');",
    "    let code = null;",
    "    let error = '';",
    "    try { code = await inv('github:request-code'); } catch (err) { error = (err && err.message) || String(err); }",
    "    const status = code ? await inv('github:poll-token') : before;",
    '    return { bad, before, code, error, status };'
  ].join('\n');
  text = text.replace(oldBody, newBody);
  fs.writeFileSync(file, text);
  console.log('e2e patched');
}
patchMain();
patchE2e();
