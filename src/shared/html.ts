/**
 * 富文本 HTML 的通用工具：抽纯文字、白名单清洗、附件 URL 拼装。
 * 主进程（迁移老笔记、写全文搜索）和渲染进程（编辑器回显、粘贴）共用同一份规则，
 * 避免两边对「什么算安全内容」的理解跑偏。
 *
 * 这里不依赖 DOM：主进程的 node:sqlite 迁移阶段也会调用。
 */

/** 附件在渲染进程里的假 URL 前缀，例：jw-att://attachments/2026-10/pic.png */
export const ATTACH_SCHEME = 'jw-att';

export function escapeHtml(text: string): string {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 把库里的附件相对路径（Windows 反斜杠）变成渲染进程可用的 URL。 */
export function attachmentUrl(relPath: string): string {
  return (
    ATTACH_SCHEME +
    '://' +
    String(relPath ?? '')
      .replace(/\\/g, '/')
      .replace(/^\/+/, '')
  );
}

/** 反向：从 jw-att:// URL 取回相对路径（保持正斜杠，交给 path.join 处理）。 */
export function attachmentRelFromUrl(url: string): string {
  const s = String(url ?? '');
  const prefix = ATTACH_SCHEME + '://';
  if (!s.startsWith(prefix)) return '';
  try {
    return decodeURIComponent(s.slice(prefix.length));
  } catch {
    return s.slice(prefix.length);
  }
}

const BLOCK_BREAK =
  /<\/?(p|div|br|tr|li|h[1-6]|blockquote|pre|table|thead|tbody|tfoot|ul|ol|hr|caption)\b[^>]*>/gi;

/**
 * 富文本 HTML → 纯文字。
 * 全文搜索、字数统计、摘要、版本对比都吃纯文字，只保存 HTML 会让这些功能变瞎。
 */
export function htmlToPlainText(html: string): string {
  if (!html) return '';
  let s = String(html);
  s = s.replace(/<(script|style)[\s\S]*?<\/\1\s*>/gi, '');
  s = s.replace(/<img\b[^>]*alt\s*=\s*"([^"]*)"[^>]*>/gi, ' $1 ');
  s = s.replace(/<img\b[^>]*>/gi, ' ');
  s = s.replace(BLOCK_BREAK, '\n');
  s = s.replace(/<td\b[^>]*>/gi, '\t');
  s = s.replace(/<[^>]*>/g, '');
  s = s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/gi, '&');
  s = s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

/** 纯文字 → 富文本 HTML（迁移兜底：Markdown 解析失败时至少不丢内容）。 */
export function textToHtml(text: string): string {
  const raw = String(text ?? '');
  if (!raw.trim()) return '';
  const blocks = raw.split(/\n{2,}/);
  return blocks
    .map((block) => `<p>${escapeHtml(block).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

/* ------------------------------------------------------------------ */
/* 白名单清洗                                                          */
/* ------------------------------------------------------------------ */

/** 编辑器会长出来的标签白名单。 */
const ALLOWED_TAGS = new Set([
  'p',
  'br',
  'div',
  'span',
  'strong',
  'b',
  'em',
  'i',
  'u',
  's',
  'del',
  'mark',
  'code',
  'pre',
  'blockquote',
  'h1',
  'h2',
  'h3',
  'h4',
  'ul',
  'ol',
  'li',
  'hr',
  'a',
  'img',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'td',
  'th',
  'caption',
  'sub',
  'sup'
]);

const COMMON_ATTRS = ['class', 'style', 'title'];

const TAG_ATTRS: Record<string, string[]> = {
  img: ['src', 'alt', 'width', 'height'],
  a: ['href', 'target', 'rel'],
  td: ['colspan', 'rowspan'],
  th: ['colspan', 'rowspan']
};

/** style 里只放行这几样，值里不许出现 url()/expression。 */
const ALLOWED_STYLE_PROPS = [
  'color',
  'background-color',
  'text-align',
  'font-weight',
  'font-style',
  'text-decoration',
  'font-size'
];

function safeStyle(value: string): string {
  const out: string[] = [];
  for (const part of String(value ?? '').split(';')) {
    const idx = part.indexOf(':');
    if (idx <= 0) continue;
    const prop = part.slice(0, idx).trim().toLowerCase();
    const val = part.slice(idx + 1).trim();
    if (!ALLOWED_STYLE_PROPS.includes(prop)) continue;
    if (/url\s*\(|expression|javascript:/i.test(val)) continue;
    if (!/^[#a-zA-Z0-9(),.%\s+-]+$/.test(val)) continue;
    out.push(`${prop}: ${val}`);
  }
  return out.join('; ');
}

function isSafeSrc(value: string): boolean {
  const v = String(value ?? '').trim();
  if (!v) return false;
  if (v.startsWith(`${ATTACH_SCHEME}://`)) return true;
  if (/^data:image\/(png|jpe?g|gif|webp);base64,/i.test(v)) return true;
  if (/^https?:\/\//i.test(v)) return true;
  return false;
}

function isSafeHref(value: string): boolean {
  const v = String(value ?? '').trim();
  if (!v) return false;
  if (v.startsWith('#')) return true;
  return /^(https?:|mailto:)/i.test(v);
}

function filterAttrs(tag: string, attrs: string): string {
  const allowed = new Set([...COMMON_ATTRS, ...(TAG_ATTRS[tag] ?? [])]);
  const out: string[] = [];
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(attrs)) !== null) {
    const name = m[1].toLowerCase();
    const value = (m[2] ?? '').replace(/^["']|["']$/g, '');
    if (name.startsWith('on')) continue;
    if (!allowed.has(name)) continue;
    if (name === 'style') {
      const st = safeStyle(value);
      if (st) out.push(`style="${st.replace(/"/g, '&quot;')}"`);
      continue;
    }
    if (name === 'src' && !isSafeSrc(value)) continue;
    if (name === 'href' && !isSafeHref(value)) continue;
    out.push(`${name}="${escapeHtml(value)}"`);
  }
  return out.length ? ' ' + out.join(' ') : '';
}

/**
 * 白名单清洗富文本。存库前和渲染前各过一次：
 * 粘贴进来的内容、老数据、手工改过的库都可能带脚本。
 */
export function sanitizeHtml(html: string): string {
  if (!html) return '';
  let s = String(html);
  s = s.replace(
    /<(script|style|iframe|object|embed|link|meta|form|input|button|textarea|select|svg|math)\b[\s\S]*?(<\/\1\s*>|$)/gi,
    ''
  );
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  // Chromium 的 execCommand('foreColor') 与从 Word 粘进来的内容都会给颜色套 <font color="…">，
  // 而 font 不在白名单里，不先转成 span 会把颜色丢掉。所以这里先翻译一遍。
  s = s.replace(
    /<font\b([^>]*)>/gi,
    (_full: string, attrs: string) => {
      const color = /color\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
      const value = color ? color[2] ?? color[3] ?? color[4] ?? '' : '';
      if (!value) return '';
      return `<span style="color: ${value.replace(/["'<>]/g, '')}">`;
    }
  );
  s = s.replace(/<\/font\s*>/gi, '</span>');
  s = s.replace(
    /<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g,
    (full: string, rawName: string, attrs: string) => {
      const tag = String(rawName).toLowerCase();
      if (!ALLOWED_TAGS.has(tag)) return '';
      if (full.startsWith('</')) return `</${tag}>`;
      return `<${tag}${filterAttrs(tag, attrs)}>`;
    }
  );
  s = s.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  s = s.replace(/(href|src)\s*=\s*(["'])\s*javascript:[^"']*\2/gi, '$1=$2#$2');
  return s;
}
