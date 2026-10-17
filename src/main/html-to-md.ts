/**
 * 富文本 HTML → Markdown（第八版 / 任务四：导出全库）。
 *
 * 为什么自己写而不引库：笔记正文是我们自己编辑器产出的、而且已经过 sanitizeHtml 白名单，
 * 标签种类很有限；引 remark / turndown 这类库会让安装包再大一圈，这里用一个小解析器就够。
 *
 * 支持的语法（够 Obsidian / Typora 直接看）：
 *   标题 h1-h4、段落、换行、加粗、斜体、删除线、高亮、行内代码、代码块、引用、有序/无序列表（可嵌套）、
 *   链接、图片（jw-att:// 转成相对路径）、分割线、管道表格。
 * 其余标签（span/font/div/section…）只保留里面的文字。
 */

export interface HtmlToMarkdownOptions {
  /**
   * 把笔记里的图片地址转成导出后的相对路径（由 export.ts 提供，顺便登记要拷贝的附件）。
   * 返回空字符串表示这张图在 disk 上找不到，正文里就只留 alt。
   */
  resolveImage?: (relPath: string, alt: string) => string;
}

interface ElementNode {
  tag: string;
  attrs: string;
  children: HtmlNode[];
}

interface TextNode {
  text: string;
}

type HtmlNode = ElementNode | TextNode;

const VOID_TAGS = new Set(['br', 'img', 'hr', 'input', 'meta', 'link', 'source']);

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  middot: '·'
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, name: string) => {
    if (name.startsWith('#')) {
      const code = name.startsWith('#x') || name.startsWith('#X') ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    return ENTITIES[name] ?? whole;
  });
}

function parseHtml(html: string): HtmlNode[] {
  const root: ElementNode = { tag: '#root', attrs: '', children: [] };
  const stack: ElementNode[] = [root];
  const re = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^'">])*?)(\/?)>|([^<]+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    if (match[5] !== undefined) {
      const text = decodeEntities(match[5]);
      if (text) stack[stack.length - 1].children.push({ text });
      continue;
    }
    if (!match[2]) continue; // 注释
    const tag = match[2].toLowerCase();
    if (match[1]) {
      for (let i = stack.length - 1; i > 0; i -= 1) {
        if (stack[i].tag === tag) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    const node: ElementNode = { tag, attrs: match[3] || '', children: [] };
    stack[stack.length - 1].children.push(node);
    if (!VOID_TAGS.has(tag) && !match[4]) stack.push(node);
  }
  return root.children;
}

function attrOf(attrs: string, name: string): string {
  const re = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i');
  const m = re.exec(attrs);
  if (!m) return '';
  return decodeEntities(m[1] ?? m[2] ?? m[3] ?? '');
}

function isText(node: HtmlNode): node is TextNode {
  return (node as TextNode).text !== undefined;
}

function textOf(nodes: HtmlNode[]): string {
  let out = '';
  for (const node of nodes) {
    if (isText(node)) out += node.text;
    else out += textOf(node.children);
  }
  return out;
}

/** 行内元素：加粗/斜体/高亮/代码/链接等，不处理块级换行。 */
function renderInline(nodes: HtmlNode[], opts: HtmlToMarkdownOptions): string {
  let out = '';
  for (const node of nodes) {
    if (isText(node)) {
      out += node.text.replace(/\s+/g, ' ');
      continue;
    }
    const inner = renderInline(node.children, opts);
    switch (node.tag) {
      case 'strong':
      case 'b':
        out += inner.trim() ? `**${inner.trim()}**` : '';
        break;
      case 'em':
      case 'i':
        out += inner.trim() ? `*${inner.trim()}*` : '';
        break;
      case 'del':
      case 's':
      case 'strike':
        out += inner.trim() ? `~~${inner.trim()}~~` : '';
        break;
      case 'mark':
        out += inner.trim() ? `==${inner.trim()}==` : '';
        break;
      case 'code': {
        const text = textOf(node.children);
        const ticks = text.includes('`') ? '``' : '`';
        out += text ? `${ticks}${text}${ticks}` : '';
        break;
      }
      case 'u':
        out += inner ? `<u>${inner}</u>` : '';
        break;
      case 'br':
        out += '\n';
        break;
      case 'img': {
        const src = attrOf(node.attrs, 'src');
        const alt = attrOf(node.attrs, 'alt');
        const rel = src.startsWith('jw-att://') ? decodeURIComponentSafe(src.slice('jw-att://'.length)) : '';
        const target = rel && opts.resolveImage ? opts.resolveImage(rel, alt) : '';
        out += target ? `![${alt}](${target})` : alt;
        break;
      }
      case 'a': {
        const href = attrOf(node.attrs, 'href');
        const text = inner.trim();
        out += href && !href.startsWith('jw-att://') && !href.startsWith('#') ? `[${text || href}](${href})` : text;
        break;
      }
      default:
        out += inner;
    }
  }
  return out.replace(/[ \t]+\n/g, '\n').replace(/ {2,}/g, ' ');
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function renderList(node: ElementNode, depth: number, opts: HtmlToMarkdownOptions): string {
  const ordered = node.tag === 'ol';
  const items = node.children.filter((child): child is ElementNode => !isText(child) && child.tag === 'li');
  const lines: string[] = [];
  items.forEach((li, index) => {
    const nested = li.children.filter((child): child is ElementNode => !isText(child) && (child.tag === 'ul' || child.tag === 'ol'));
    const own = li.children.filter((child) => !nested.includes(child as ElementNode));
    const body = renderInline(own, opts)
      .split('\n')
      .map((line) => line.trim())
      .filter((line, i) => i === 0 || line !== '')
      .join(' ')
      .trim();
    const pad = '  '.repeat(depth);
    lines.push(`${pad}${ordered ? `${index + 1}. ` : '- '}${body}`);
    for (const sub of nested) lines.push(renderList(sub, depth + 1, opts));
  });
  return lines.join('\n');
}

function renderTable(node: ElementNode, opts: HtmlToMarkdownOptions): string {
  const rows = node.children.filter((child): child is ElementNode => !isText(child) && child.tag === 'tr');
  if (rows.length === 0) return '';
  const cellsOf = (row: ElementNode): string[] =>
    row.children
      .filter((child): child is ElementNode => !isText(child) && (child.tag === 'td' || child.tag === 'th'))
      .map((cell) => renderInline(cell.children, opts).replace(/\|/g, '\\|').replace(/\n/g, ' ').trim());
  const body = rows.map(cellsOf);
  const columns = Math.max(...body.map((cells) => cells.length));
  const line = (cells: string[]): string => `| ${Array.from({ length: columns }, (_, i) => cells[i] ?? '').join(' | ')} |`;
  const out = [line(body[0]), `| ${Array.from({ length: columns }, () => '---').join(' | ')} |`];
  for (const cells of body.slice(1)) out.push(line(cells));
  return out.join('\n');
}

function renderBlock(nodes: HtmlNode[], opts: HtmlToMarkdownOptions): string {
  let out = '';
  for (const node of nodes) {
    if (isText(node)) {
      out += node.text.replace(/\s+/g, ' ');
      continue;
    }
    switch (node.tag) {
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6': {
        const level = Number(node.tag.slice(1));
        const body = renderInline(node.children, opts).trim();
        if (body) out += `\n\n${'#'.repeat(level)} ${body}\n\n`;
        break;
      }
      case 'p':
      case 'div':
      case 'section':
      case 'article': {
        const body = renderInline(node.children, opts).trim();
        if (body) out += `\n\n${body}\n\n`;
        break;
      }
      case 'br':
        out += '\n';
        break;
      case 'hr':
        out += '\n\n---\n\n';
        break;
      case 'pre': {
        const text = textOf(node.children).replace(/\n+$/, '');
        if (text.trim()) out += `\n\n\`\`\`\n${text}\n\`\`\`\n\n`;
        break;
      }
      case 'blockquote': {
        // 里面的 <p> 自己带前后空行，先压成一个空行，再统一加 "> " 前缀
        const body = renderBlock(node.children, opts).trim().replace(/\n{2,}/g, '\n\n');
        if (body) out += `\n\n${body.split('\n').map((line) => (line ? `> ${line}` : '>')).join('\n')}\n\n`;
        break;
      }
      case 'ul':
      case 'ol': {
        const body = renderList(node, 0, opts);
        if (body) out += `\n\n${body}\n\n`;
        break;
      }
      case 'table': {
        const body = renderTable(node, opts);
        if (body) out += `\n\n${body}\n\n`;
        break;
      }
      case 'img':
      case 'a':
      case 'strong':
      case 'b':
      case 'em':
      case 'i':
      case 'u':
      case 's':
      case 'del':
      case 'mark':
      case 'code':
      case 'span':
      case 'font':
      case 'sup':
      case 'sub': {
        const body = renderInline([node], opts).trim();
        if (body) out += body;
        break;
      }
      default: {
        const body = renderBlock(node.children, opts);
        if (body) out += body;
      }
    }
  }
  return out;
}

/** 收尾：把多余空行压成一个、去掉行尾空格。 */
function tidy(markdown: string): string {
  return markdown
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .concat('\n');
}

export function htmlToMarkdown(html: string, options: HtmlToMarkdownOptions = {}): string {
  const source = String(html ?? '');
  if (!source.trim()) return '';
  return tidy(renderBlock(parseHtml(source), options));
}

/** 纯文字正文（没存富文本的老笔记）也能导出成 Markdown：段落之间空一行。 */
export function plainToMarkdown(text: string): string {
  const body = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map((para) => para.trim())
    .filter(Boolean)
    .join('\n\n');
  return body ? `${body}\n` : '';
}
