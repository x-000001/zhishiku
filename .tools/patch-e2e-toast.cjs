/* 把 e2e 里「读整个 toast 容器文本」改成「只读最新一条 toast」，断言更准 */
const fs = require('node:fs');
const file = 'tests/e2e/cdp-check.mjs';
const raw = fs.readFileSync(file, 'utf8');
const crlf = raw.includes('\r\n');
let t = crlf ? raw.replace(/\r\n/g, '\n') : raw;

const oldExpr = "((document.querySelector('.toast-wrap') || {}).innerText || '').replace(/\\s+/g, ' ')";
const newExpr = "((Array.from(document.querySelectorAll('.toast-wrap .toast')).pop() || {}).innerText || '').replace(/\\s+/g, ' ')";

const count = t.split(oldExpr).length - 1;
if (count === 0) throw new Error('toast expression not found');
t = t.split(oldExpr).join(newExpr);

fs.writeFileSync(file, crlf ? t.replace(/\n/g, '\r\n') : t);
console.log('patched ' + count + ' toast reads');
