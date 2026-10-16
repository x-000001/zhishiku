import { describe, expect, it } from 'vitest';
import { diffLines, renderMarkdown } from '../../src/renderer/src/markdown';

describe('Markdown 预览', () => {
  it('标题、粗体、行内代码能渲染成 HTML', () => {
    const html = renderMarkdown('# 大标题\n\n这是**重点**和`code`。');
    expect(html).toContain('<h1');
    expect(html).toContain('大标题');
    expect(html).toContain('<strong>重点</strong>');
    expect(html).toContain('<code>code</code>');
  });

  it('无序列表与有序列表能渲染', () => {
    const ul = renderMarkdown('- 第一\n- 第二');
    expect(ul).toContain('<ul>');
    expect(ul).toContain('<li>第一</li>');
    const ol = renderMarkdown('1. 甲\n2. 乙');
    expect(ol).toContain('<ol>');
  });

  it('引用与分割线能渲染', () => {
    expect(renderMarkdown('> 引用一句话')).toContain('<blockquote>');
    expect(renderMarkdown('---')).toContain('<hr');
  });

  it('代码块原样保留，里面的 ** 不会被当成粗体', () => {
    const html = renderMarkdown('```\nconst a = **b**;\n```');
    expect(html).toContain('<pre>');
    expect(html).toContain('**b**');
    expect(html).not.toContain('<strong>');
  });

  it('把 HTML 尖括号转义掉，不会真的注入标签', () => {
    const html = renderMarkdown('普通文字 <img src=x onerror=alert(1)>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('链接渲染成 a 标签', () => {
    const html = renderMarkdown('[官网](https://example.com)');
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('>官网<');
  });

  it('空内容不会报错', () => {
    expect(() => renderMarkdown('')).not.toThrow();
    expect(renderMarkdown('').trim()).toBe('');
  });
});

describe('版本对比', () => {
  it('完全一样时全是 same', () => {
    const d = diffLines('第一行\n第二行', '第一行\n第二行');
    expect(d.every((x) => x.type === 'same')).toBe(true);
    expect(d).toHaveLength(2);
  });

  it('能标出改动的行', () => {
    const d = diffLines('第一行\n第二行\n第三行', '第一行\n改过的第二行\n第三行');
    expect(d.filter((x) => x.type === 'del').map((x) => x.text)).toEqual(['第二行']);
    expect(d.filter((x) => x.type === 'add').map((x) => x.text)).toEqual(['改过的第二行']);
    expect(d.filter((x) => x.type === 'same')).toHaveLength(2);
  });

  it('新增的行只标 add', () => {
    const d = diffLines('甲', '甲\n乙');
    expect(d.filter((x) => x.type === 'add').map((x) => x.text)).toEqual(['乙']);
    expect(d.filter((x) => x.type === 'del')).toHaveLength(0);
  });

  it('删掉的行只标 del', () => {
    const d = diffLines('甲\n乙', '甲');
    expect(d.filter((x) => x.type === 'del').map((x) => x.text)).toEqual(['乙']);
    expect(d.filter((x) => x.type === 'add')).toHaveLength(0);
  });

  it('两版都空时不炸', () => {
    const d = diffLines('', '');
    expect(d.every((x) => x.type === 'same')).toBe(true);
  });

  it('超长内容走降级路径，仍然给出全部行且不卡死', () => {
    const before = Array.from({ length: 700 }, (_, i) => `旧第${i}行`).join('\n');
    const after = Array.from({ length: 700 }, (_, i) => `新第${i}行`).join('\n');
    const d = diffLines(before, after);
    expect(d.length).toBe(1400);
    expect(d.filter((x) => x.type === 'del')).toHaveLength(700);
    expect(d.filter((x) => x.type === 'add')).toHaveLength(700);
  });
});
