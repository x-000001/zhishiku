/**
 * 富文本编辑器的底层动作。全部收在这一个文件里：
 * 界面上点按钮只是调这里的函数，将来换掉 execCommand 也只需要改这里。
 *
 * 说明：execCommand 是浏览器里唯一「不用装库就能操作 contenteditable 选区」的接口，
 * 虽然被标成过时，但 Chromium（Electron）里一直可用，且撤销/重做栈是原生接好的。
 */

/** 正文字体颜色（红/橙/黄/绿/蓝/紫/灰/黑） */
export const TEXT_COLORS = [
  '#d1242f',
  '#bc4c00',
  '#9a6700',
  '#1a7f37',
  '#0969da',
  '#8250df',
  '#57606a',
  '#1f2328'
];

/** 背景高亮颜色 */
export const HIGHLIGHTS = ['#fff3b0', '#ffe0e0', '#ddf4e4', '#ddf0ff', '#efe2ff', '#eaeef2'];

export function exec(cmd: string, value?: string): boolean {
  try {
    return document.execCommand(cmd, false, value);
  } catch {
    return false;
  }
}

export function bold(): boolean {
  return exec('bold');
}

export function italic(): boolean {
  return exec('italic');
}

export function underline(): boolean {
  return exec('underline');
}

export function foreColor(color: string): boolean {
  // 默认会生成 <font color="…">；开一下 styleWithCSS 就会写成 <span style="color: …">，
  // 跟清洗规则（白名单只认 span+style）天然对得上。
  exec('styleWithCSS', 'true');
  return exec('foreColor', color);
}

export function hiliteColor(color: string): boolean {
  exec('styleWithCSS', 'true');
  // Chromium 认 hiliteColor；个别版本只认 backColor
  return exec('hiliteColor', color) || exec('backColor', color);
}

export function undo(): boolean {
  return exec('undo');
}

export function redo(): boolean {
  return exec('redo');
}

/** 光标处的格式状态，用来把工具栏按钮点亮。 */
export function stateOf(cmd: string): boolean {
  try {
    return document.queryCommandState(cmd);
  } catch {
    return false;
  }
}

/** 插入一张附件图片（src 用 jw-att://，由主进程的自定义协议解析到数据目录）。 */
export function insertImage(url: string, alt = ''): boolean {
  return exec('insertHTML', `<img src="${url}" alt="${alt.replace(/"/g, '')}">`);
}

/** 生成一张空表格的 HTML：第一行是表头，其余是空单元格。 */
export function buildTableHtml(rows: number, cols: number): string {
  const r = Math.min(Math.max(Math.round(rows), 1), 30);
  const c = Math.min(Math.max(Math.round(cols), 1), 10);
  const head = Array.from({ length: c }, (_v, i) => `<th>表头 ${i + 1}</th>`).join('');
  const body = Array.from(
    { length: r },
    () => `<tr>${Array.from({ length: c }, () => '<td><br></td>').join('')}</tr>`
  ).join('');
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table><p><br></p>`;
}

export function insertTable(rows: number, cols: number): boolean {
  return exec('insertHTML', buildTableHtml(rows, cols));
}

/* ------------------------------------------------------------------ */
/* 表格结构编辑：光标所在单元格为基准                                   */
/* ------------------------------------------------------------------ */

/** 光标现在是不是落在表格里（不在就返回 null）。 */
export function currentCell(): HTMLTableCellElement | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const node = sel.getRangeAt(0).startContainer;
  const el: Element | null =
    node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  const cell = el?.closest ? el.closest('td,th') : null;
  return (cell as HTMLTableCellElement | null) ?? null;
}

export function inTable(): boolean {
  return currentCell() != null;
}

function focusCell(el: HTMLElement | undefined | null): void {
  if (!el) return;
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(true);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

function blankCell(tag: 'td' | 'th'): HTMLTableCellElement {
  const el = document.createElement(tag);
  el.innerHTML = '<br>';
  return el as HTMLTableCellElement;
}

/** 在当前行的上面/下面插一行；光标在表头行时插到表体第一行。 */
export function addRow(after: boolean): boolean {
  const cell = currentCell();
  const row = cell?.closest('tr') as HTMLTableRowElement | null;
  const table = row?.closest('table') ?? null;
  if (!cell || !row || !row.parentElement || !table) return false;
  const inHead = row.closest('thead') != null;
  const count = row.children.length || 1;
  const tbody = table.querySelector('tbody');
  const tr = document.createElement('tr');
  for (let i = 0; i < count; i += 1) tr.appendChild(blankCell(inHead ? 'th' : 'td'));

  if (inHead) {
    // 表头不给复制第二行表头，改成在表体开头插一行
    if (!tbody) return false;
    const fresh = document.createElement('tr');
    for (let i = 0; i < count; i += 1) fresh.appendChild(blankCell('td'));
    tbody.insertBefore(fresh, tbody.firstChild);
    focusCell(fresh.children[0] as HTMLElement);
    return true;
  }
  row.parentElement.insertBefore(tr, after ? row.nextSibling : row);
  focusCell(tr.children[0] as HTMLElement);
  return true;
}

/** 删掉光标所在的那一行；如果整张表只剩这一行数据，就把表格删掉。 */
export function deleteRow(): boolean {
  const cell = currentCell();
  const row = cell?.closest('tr') as HTMLTableRowElement | null;
  if (!cell || !row) return false;
  if (row.closest('thead')) return false; // 表头不给删
  const table = row.closest('table');
  const bodyRows = table ? table.querySelectorAll('tbody tr') : [];
  if (bodyRows.length <= 1) {
    table?.remove();
    return true;
  }
  const next = (row.nextElementSibling ?? row.previousElementSibling) as HTMLElement | null;
  row.remove();
  focusCell(next?.children[0] as HTMLElement | undefined);
  return true;
}

/** 在当前列左边/右边插一列。 */
export function addColumn(after: boolean): boolean {
  const cell = currentCell();
  const table = cell?.closest('table');
  if (!cell || !cell.parentElement || !table) return false;
  const index = Array.from(cell.parentElement.children).indexOf(cell) + (after ? 1 : 0);
  for (const row of Array.from(table.querySelectorAll('tr'))) {
    const isHead = row.closest('thead') != null;
    const fresh = blankCell(isHead ? 'th' : 'td');
    const ref = row.children[index] ?? null;
    if (ref) row.insertBefore(fresh, ref);
    else row.appendChild(fresh);
  }
  return true;
}

/** 删掉光标所在的那一列；只剩一列时整张表删掉。 */
export function deleteColumn(): boolean {
  const cell = currentCell();
  const table = cell?.closest('table');
  if (!cell || !cell.parentElement || !table) return false;
  const index = Array.from(cell.parentElement.children).indexOf(cell);
  const rows = Array.from(table.querySelectorAll('tr'));
  const widest = rows.reduce((max, row) => Math.max(max, row.children.length), 0);
  if (widest <= 1) {
    table.remove();
    return true;
  }
  for (const row of rows) {
    const target = row.children[index];
    if (target) target.remove();
  }
  return true;
}
