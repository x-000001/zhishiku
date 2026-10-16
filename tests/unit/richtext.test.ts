import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as db from '../../src/main/db';
import { ensureDirs } from '../../src/main/paths';
import {
  attachmentRelFromUrl,
  attachmentUrl,
  htmlToPlainText,
  sanitizeHtml,
  textToHtml
} from '../../src/shared/html';

/**
 * 第三版第一批：富文本笔记的存储与工具函数。
 * 这里管的是「HTML 怎么存、纯文字怎么抽、脏 HTML 怎么洗、顺序怎么改」，
 * 编辑器界面本身在 e2e 里验。
 */

let root = '';

afterEach(() => {
  try {
    db.closeDatabase();
  } catch {
    /* 没打开 */
  }
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = '';
});

function newDb(): void {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'jwkb-rt-'));
  db.openDatabase(ensureDirs(root));
}

describe('富文本工具', () => {
  it('抽纯文字：段落之间空一行、图片取 alt、实体还原', () => {
    expect(htmlToPlainText('<p>第一段</p><p>第二段</p>')).toBe('第一段\n\n第二段');
    expect(htmlToPlainText('<p>上面</p><img src="jw-att://a.png" alt="示意图"><p>下面</p>')).toContain(
      '示意图'
    );
    expect(htmlToPlainText('<p>a &amp; b &lt;c&gt;</p>')).toBe('a & b <c>');
    expect(htmlToPlainText('<p>粗<b>体</b></p>')).toBe('粗体');
    expect(htmlToPlainText('')).toBe('');
  });

  it('纯文字转 HTML 会转义，不会把尖括号当标签', () => {
    const html = textToHtml('一行\n两行 <b>假的</b>');
    expect(html).toContain('&lt;b&gt;');
    expect(html).not.toContain('<b>假的</b>');
  });

  it('清洗：脚本、事件属性、javascript: 全被拿掉，颜色与附件图保留', () => {
    const dirty =
      '<p onclick="alert(1)">正文</p><script>alert(2)</script>' +
      '<img src="jw-att://attachments/2026-10/a.png" onerror="alert(3)" alt="图">' +
      '<a href="javascript:alert(4)">链接</a>' +
      '<span style="color:#c00;background-color:yellow;position:absolute">标红</span>' +
      '<iframe src="https://evil.test"></iframe>';
    const clean = sanitizeHtml(dirty);
    expect(clean).not.toContain('<script');
    expect(clean).not.toContain('onclick');
    expect(clean).not.toContain('onerror');
    expect(clean).not.toContain('iframe');
    expect(clean.toLowerCase()).not.toContain('javascript:');
    expect(clean).toContain('jw-att://attachments/2026-10/a.png');
    expect(clean).toContain('color: #c00');
    expect(clean).toContain('background-color: yellow');
    // 不在白名单里的样式属性（定位）要丢掉，否则能把编辑器搞乱
    expect(clean).not.toContain('position');
    expect(clean).toContain('正文');
  });

  it('清洗：<font color> 会翻译成 span 样式，颜色不会丢（Chromium 与 Word 都这么给颜色）', () => {
    const fromEditor = '<p><font color="#d1242f">从编辑器里标红的字</font></p>';
    const clean = sanitizeHtml(fromEditor);
    expect(clean).toContain('color: #d1242f');
    expect(clean).toContain('从编辑器里标红的字');
    expect(clean).not.toContain('<font');

    const fromWord = '<p><font face="宋体" color="rgb(209, 36, 47)" size="3">Word 粘的</font></p>';
    const clean2 = sanitizeHtml(fromWord);
    expect(clean2).toContain('color: rgb(209, 36, 47)');
    expect(clean2).toContain('Word 粘的');
    expect(clean2).not.toContain('face=');
  });

  it('附件 URL 用了正斜杠，能反解回相对路径', () => {
    const url = attachmentUrl('attachments\\2026-10\\a b.png');
    expect(url).toBe('jw-att://attachments/2026-10/a b.png');
    expect(attachmentRelFromUrl(url)).toBe('attachments/2026-10/a b.png');
    expect(attachmentRelFromUrl('https://example.com/a.png')).toBe('');
  });
});

describe('富文本笔记落库', () => {
  it('createNote 带 html：正文存富文本，content 抽出纯文字给搜索用', () => {
    newDb();
    const id = db.createNote({
      title: '带格式的笔记',
      html: '<p>这是<b>重点</b></p><p>第二段</p>'
    });
    const note = db.getNote(id)!;
    expect(note.content_html).toContain('<b>重点</b>');
    expect(note.content).toBe('这是重点\n\n第二段');
    expect(note.excerpt).toContain('重点');
    // 全文搜索吃的是纯文字那份
    expect(db.searchNotes('重点').map((h) => h.note_id)).toContain(id);
    expect(db.searchNotes('第二段').map((h) => h.note_id)).toContain(id);
  });

  it('saveNoteHtml 洗完再存，并留一个带富文本的版本点', () => {
    newDb();
    const id = db.createNote({ title: '草稿', content: '' });
    db.saveDraft(id, '草稿', '<p>草稿正文</p>');
    const version = db.saveNoteHtml(id, '正式标题', '<p>正式<b>正文</b></p><script>x</script>');
    const note = db.getNote(id)!;
    expect(note.title).toBe('正式标题');
    expect(note.content_html).not.toContain('script');
    expect(note.content_html).toContain('<b>正文</b>');
    expect(note.content).toBe('正式正文');
    // 手动保存要顺手清掉草稿
    expect(note.draft_content).toBeNull();
    expect(version?.content_html).toContain('<b>正文</b>');
    expect(db.listVersions(id)[0].content_html).toContain('<b>正文</b>');
  });

  it('回滚到老版本会把富文本正文一起恢复', () => {
    newDb();
    const id = db.createNote({ title: '流程', content: '' });
    const first = db.saveNoteHtml(id, '流程', '<p>第一版</p>');
    expect(first).not.toBeNull();
    db.saveNoteHtml(id, '流程', '<p>第二版</p>');
    db.rollbackVersion(first!.id);
    expect(db.getNote(id)!.content_html).toContain('第一版');
  });

  it('老调用 saveNote（Markdown）照样能用，会自动补一份 HTML', () => {
    newDb();
    const id = db.createNote({ title: '老路径', content: '' });
    db.saveNote(id, '老路径', '## 小标题\n\n**粗**字');
    const note = db.getNote(id)!;
    expect(note.content).toBe('## 小标题\n\n**粗**字');
    expect(note.content_html).toContain('<h2');
    expect(note.content_html).toContain('<strong>粗</strong>');
  });

  it('拖动排序：reorderNotes 按给定顺序写位次，只影响传进来的那些', () => {
    newDb();
    const a = db.createNote({ title: '甲', content: 'a' });
    const b = db.createNote({ title: '乙', content: 'b' });
    const c = db.createNote({ title: '丙', content: 'c' });
    expect(db.listNotes({}).map((n) => n.title)).toEqual(['甲', '乙', '丙']);

    expect(db.reorderNotes([c, a, b])).toBe(3);
    expect(db.listNotes({}).map((n) => n.title)).toEqual(['丙', '甲', '乙']);
    expect(db.listNotes({}).map((n) => n.sort_order)).toEqual([1, 2, 3]);

    // 按乙、丙、甲再拖一次
    db.reorderNotes([b, c, a]);
    expect(db.listNotes({}).map((n) => n.title)).toEqual(['乙', '丙', '甲']);
  });

  it('换分类后排到新分类的最后，不抢别人位次', () => {
    newDb();
    const work = db.createCategory(null, '工作');
    const life = db.createCategory(null, '生活');
    const a = db.createNote({ categoryId: work, title: '工作的甲', content: 'a' });
    const b = db.createNote({ categoryId: work, title: '工作的乙', content: 'b' });
    const x = db.createNote({ categoryId: life, title: '生活的甲', content: 'x' });

    db.moveNote(a, life);

    expect(db.listNotes({ categoryId: life }).map((n) => n.title)).toEqual(['生活的甲', '工作的甲']);
    expect(db.listNotes({ categoryId: life }).map((n) => n.sort_order)).toEqual([1, 2]);
    expect(db.listNotes({ categoryId: work }).map((n) => n.title)).toEqual(['工作的乙']);
    // 留在原分类的笔记位次不动，不会因为别人搬走就被重排
    expect(db.getNote(b)!.sort_order).toBe(2);
    expect(db.getNote(x)!.sort_order).toBe(1);
  });

  it('新笔记排在分类最后，不会插到最前面', () => {
    newDb();
    const cat = db.createCategory(null, '学习');
    db.createNote({ categoryId: cat, title: '早的', content: '1' });
    db.createNote({ categoryId: cat, title: '晚的', content: '2' });
    expect(db.listNotes({ categoryId: cat }).map((n) => n.title)).toEqual(['早的', '晚的']);
  });
});
