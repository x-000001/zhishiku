const fs = require('node:fs');
const file = 'tests/e2e/cdp-check.mjs';
const raw = fs.readFileSync(file, 'utf8');
const crlf = raw.includes('\r\n');
let t = crlf ? raw.replace(/\r\n/g, '\n') : raw;

const misplaced = `    if (repo === 'octo/many') {
      const rows = page === 1
        ? Array.from({ length: 100 }, (_, i) => ({
            number: 1000 + i,
            title: '批量 Issue ' + (1000 + i),
            body: '分页自检用。',
            state: 'open',
            labels: [],
            html_url: 'https://github.com/octo/many/issues/' + (1000 + i),
            updated_at: '2026-10-15T08:00:00Z',
            closed_at: null,
            milestone: null
          }))
        : [];
      setTimeout(() => send(rows), 120);
      return;
    }
`;
if (!t.includes(misplaced)) throw new Error('misplaced block not found');
t = t.replace(misplaced, '');

const anchor = `      const repo = url.replace('/github/api/repos/', '').split('/issues')[0];
`;
if (!t.includes(anchor)) throw new Error('repos anchor not found');
t = t.replace(anchor, anchor + misplaced);

fs.writeFileSync(file, crlf ? t.replace(/\n/g, '\r\n') : t);
console.log('stub block moved into repos handler');
