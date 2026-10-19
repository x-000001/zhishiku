const fs = require('node:fs');
function withText(file, fn) {
  const raw = fs.readFileSync(file, 'utf8');
  const crlf = raw.includes('\r\n');
  const text = crlf ? raw.replace(/\r\n/g, '\n') : raw;
  const next = fn(text);
  fs.writeFileSync(file, crlf ? next.replace(/\n/g, '\r\n') : next);
}
withText('tests/e2e/cdp-check.mjs', (text) => {
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
  return text.replace(oldBody, newBody);
});
console.log('e2e diag patched');
