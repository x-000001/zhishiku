import { describe, expect, it } from 'vitest';
import { htmlToMarkdown, plainToMarkdown } from '../../src/main/html-to-md';

/**
 * 第八版任务四：富文本 → Markdown 转换。
 * 这里只测纯函数，不碰文件系统（写盘那部分在 export 的测试里用临时目录测）。
 */

describe('富文本转 Markdown：基础块', () => {
  it('标题按级别给 #，段落之间空一行', () => {
    const md = htmlToMarkdown('<h1>总标题</h1><p>第一段</p><h3>小标题</h3><p>第二段</p>');
    expect(md).toBe('# 总标题\n\n第一段\n\n### 小标题\n\n第二段\n');
  });

  it('加粗 / 斜体 / 删除线 / 高亮 / 行内代码一一对应', () => {
    const md = htmlToMarkdown(
      '<p><strong>粗</strong>和<em>斜</em>、<s>删</s>、<mark>高亮</mark>、<code>const a = 1</code></p>'
    );
    expect(md).toBe('**粗**和*斜*、~~删~~、==高亮==、`const a = 1`\n');
  });

  it('多个空行会被压成一个，行尾空格会去掉', () => {
    const md = htmlToMarkdown('<p>a</p><div><br/><br/></div><p>b   </p>');
    expect(md).toBe('a\n\nb\n');
  });

  it('空正文导出空字符串', () => {
    expect(htmlToMarkdown('')).toBe('');
    expect(htmlToMarkdown('   \n ')).toBe('');
  });

  it('HTML 实体还原成字符', () => {
    expect(htmlToMarkdown('<p>a &amp; b &lt;c&gt; &quot;d&quot;</p>')).toBe('a & b <c> "d"\n');
  });
});

describe('富文本转 Markdown：列表 / 引用 / 代码块', () => {
  it('无序列表和有序列表各自成行', () => {
    expect(htmlToMarkdown('<ul><li>甲</li><li>乙</li></ul>')).toBe('- 甲\n- 乙\n');
    expect(htmlToMarkdown('<ol><li>一</li><li>二</li></ol>')).toBe('1. 一\n2. 二\n');
  });

  it('嵌套列表用两个空格缩进', () => {
    const md = htmlToMarkdown('<ul><li>甲<ul><li>甲一</li><li>甲二</li></ul></li><li>乙</li></ul>');
    expect(md).toBe('- 甲\n  - 甲一\n  - 甲二\n- 乙\n');
  });

  it('引用块每行加 > 前缀', () => {
    const md = htmlToMarkdown('<blockquote><p>第一句</p><p>第二句</p></blockquote>');
    expect(md).toBe('> 第一句\n>\n> 第二句\n');
  });

  it('代码块用三个反引号包起来且保留换行', () => {
    const md = htmlToMarkdown('<pre><code>line1\nline2</code></pre>');
    expect(md).toBe('```\nline1\nline2\n```\n');
  });

  it('分割线变成 ---', () => {
    expect(htmlToMarkdown('<p>上</p><hr/><p>下</p>')).toBe('上\n\n---\n\n下\n');
  });
});

describe('富文本转 Markdown：链接 / 图片 / 表格 / 保留标签', () => {
  it('普通链接转成 [文字](地址)', () => {
    expect(htmlToMarkdown('<p><a href="https://example.com">点我</a></p>')).toBe('[点我](https://example.com)\n');
  });

  it('jw-att:// 图片交给 resolveImage 换成相对路径', () => {
    const md = htmlToMarkdown('<p><img src="jw-att://2026-10/a.png" alt="示意图"/></p>', {
      resolveImage: (rel, alt) => `../attachments/${rel}?alt=${alt}`
    });
    expect(md).toBe('![示意图](../attachments/2026-10/a.png?alt=示意图)\n');
  });

  it('找不到原图时只留 alt 文字，不产生坏链接', () => {
    expect(htmlToMarkdown('<p><img src="jw-att://2026-10/gone.png" alt="丢了"/></p>', { resolveImage: () => '' })).toBe(
      '丢了\n'
    );
  });

  it('表格转成管道表格，第一行自动补分隔行', () => {
    const md = htmlToMarkdown(
      '<table><tr><th>名字</th><th>数量</th></tr><tr><td>苹果</td><td>3</td></tr></table>'
    );
    expect(md).toBe('| 名字 | 数量 |\n| --- | --- |\n| 苹果 | 3 |\n');
  });

  it('下划线保留成 <u>（Obsidian 认这个）', () => {
    expect(htmlToMarkdown('<p><u>重点</u></p>')).toBe('<u>重点</u>\n');
  });

  it('未知标签只保留里面的文字', () => {
    expect(htmlToMarkdown('<div><span style="color:red">红字</span></div>')).toBe('红字\n');
  });
});

describe('纯文字正文转 Markdown', () => {
  it('段落之间空一行，末尾补换行', () => {
    expect(plainToMarkdown('第一段\n\n\n第二段\n')).toBe('第一段\n\n第二段\n');
  });

  it('空文字返回空字符串', () => {
    expect(plainToMarkdown('')).toBe('');
  });
});
