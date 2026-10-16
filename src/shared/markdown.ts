/**
 * 极简 Markdown 预览渲染器。
 * 只覆盖笔记里真正会用到的语法：标题、列表、引用、代码块、行内代码、
 * 加粗、斜体、删除线、链接、分割线、管道表格。
 * 先做 HTML 转义，再把 Markdown 记号换成标签，所以笔记里写 <script> 也只会显示成文字。
 */

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function safeUrl(url: string): string {
  return /^(https?:|mailto:|file:|#)/i.test(url.trim()) ? url.trim() : '#';
}

function inline(text: string): string {
  let out = escapeHtml(text);
  // 行内代码先占位，免得里面的星号被当成粗体
  const codes: string[] = [];
  out = out.replace(/`([^`]+)`/g, (_m, code: string) => {
    codes.push(code);
    return `\u0000${codes.length - 1}\u0000`;
  });
  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '<em>[图片：$1]</em>');
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label: string, url: string) => {
    return `<a href="${safeUrl(url)}" target="_blank" rel="noreferrer">${label}</a>`;
  });
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  out = out.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  out = out.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => `<code>${codes[Number(i)] ?? ''}</code>`);
  return out;
}

function renderTable(rows: string[]): string {
  const cellsOf = (line: string) =>
    line
      .replace(/^\s*\|/, '')
      .replace(/\|\s*$/, '')
      .split('|')
      .map((c) => c.trim());
  const head = cellsOf(rows[0]);
  const body = rows.slice(2).map(cellsOf);
  const thead = `<tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr>`;
  const tbody = body
    .map((cells) => `<tr>${cells.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`)
    .join('');
  return `<table><thead>${thead}</thead><tbody>${tbody}</tbody></table>`;
}

export function renderMarkdown(src: string): string {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const html: string[] = [];
  let i = 0;

  const isTableSep = (line: string) => /^\s*\|?[\s:-]*-[\s|:-]*\|?\s*$/.test(line) && line.includes('-');

  while (i < lines.length) {
    const line = lines[i] ?? '';

    // 代码块
    if (/^\s*```/.test(line)) {
      const buf: string[] = [];
      i += 1;
      while (i < lines.length && !/^\s*```/.test(lines[i] ?? '')) {
        buf.push(lines[i] ?? '');
        i += 1;
      }
      i += 1;
      html.push(`<pre><code>${escapeHtml(buf.join('\n'))}</code></pre>`);
      continue;
    }

    // 空行
    if (!line.trim()) {
      i += 1;
      continue;
    }

    // 分割线
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
      html.push('<hr />');
      i += 1;
      continue;
    }

    // 标题
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = Math.min(3, heading[1]?.length ?? 1);
      html.push(`<h${level}>${inline(heading[2] ?? '')}</h${level}>`);
      i += 1;
      continue;
    }

    // 表格
    if (line.includes('|') && isTableSep(lines[i + 1] ?? '')) {
      const rows: string[] = [line, lines[i + 1] ?? ''];
      i += 2;
      while (i < lines.length && (lines[i] ?? '').includes('|') && (lines[i] ?? '').trim()) {
        rows.push(lines[i] ?? '');
        i += 1;
      }
      html.push(renderTable(rows));
      continue;
    }

    // 引用
    if (/^\s*>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i] ?? '')) {
        buf.push((lines[i] ?? '').replace(/^\s*>\s?/, ''));
        i += 1;
      }
      html.push(`<blockquote>${buf.map(inline).join('<br />')}</blockquote>`);
      continue;
    }

    // 无序列表
    if (/^\s*[-*+]\s+/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i] ?? '')) {
        buf.push(`<li>${inline((lines[i] ?? '').replace(/^\s*[-*+]\s+/, ''))}</li>`);
        i += 1;
      }
      html.push(`<ul>${buf.join('')}</ul>`);
      continue;
    }

    // 有序列表
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i] ?? '')) {
        buf.push(`<li>${inline((lines[i] ?? '').replace(/^\s*\d+[.)]\s+/, ''))}</li>`);
        i += 1;
      }
      html.push(`<ol>${buf.join('')}</ol>`);
      continue;
    }

    // 普通段落
    const buf: string[] = [];
    while (
      i < lines.length &&
      (lines[i] ?? '').trim() &&
      !/^\s*(```|#{1,6}\s|>|[-*+]\s|\d+[.)]\s)/.test(lines[i] ?? '')
    ) {
      buf.push(lines[i] ?? '');
      i += 1;
    }
    html.push(`<p>${buf.map(inline).join('<br />')}</p>`);
  }

  return html.join('\n');
}

/** 逐行对比两份文本，返回带 +/- 标记的行序列（最朴素的 LCS 差异）。 */
export function diffLines(before: string, after: string): { type: 'same' | 'add' | 'del'; text: string }[] {
  const a = before.replace(/\r\n?/g, '\n').split('\n');
  const b = after.replace(/\r\n?/g, '\n').split('\n');
  const n = a.length;
  const m = b.length;
  // 内容太大时退化成整块对比，避免 O(n*m) 卡住界面
  if (n * m > 400_000) {
    return [
      ...a.map((text) => ({ type: 'del' as const, text })),
      ...b.map((text) => ({ type: 'add' as const, text }))
    ];
  }
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i]![j] = a[i] === b[j] ? (dp[i + 1]![j + 1] ?? 0) + 1 : Math.max(dp[i + 1]![j] ?? 0, dp[i]![j + 1] ?? 0);
    }
  }
  const out: { type: 'same' | 'add' | 'del'; text: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: 'same', text: a[i] ?? '' });
      i += 1;
      j += 1;
    } else if ((dp[i + 1]![j] ?? 0) >= (dp[i]![j + 1] ?? 0)) {
      out.push({ type: 'del', text: a[i] ?? '' });
      i += 1;
    } else {
      out.push({ type: 'add', text: b[j] ?? '' });
      j += 1;
    }
  }
  while (i < n) {
    out.push({ type: 'del', text: a[i] ?? '' });
    i += 1;
  }
  while (j < m) {
    out.push({ type: 'add', text: b[j] ?? '' });
    j += 1;
  }
  return out;
}
