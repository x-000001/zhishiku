import { describe, expect, it } from 'vitest';
import {
  buildRepoNoteMarkdown,
  formatImportResult,
  isValidRepoName,
  parseRepoNoteMarkdown,
  parseRepoUrl,
  splitRepo
} from '../../src/shared/github';

describe('parseRepoUrl：脏地址清洗', () => {
  it('标准地址', () => {
    expect(parseRepoUrl('https://github.com/facebook/react')).toBe('facebook/react');
  });

  it('带 .git 后缀', () => {
    expect(parseRepoUrl('https://github.com/vuejs/core.git')).toBe('vuejs/core');
    expect(parseRepoUrl('github.com/vuejs/core.git/')).toBe('vuejs/core');
  });

  it('带目录 / 分支 / query / 锚点', () => {
    expect(parseRepoUrl('https://github.com/microsoft/vscode/tree/main/src/vs')).toBe('microsoft/vscode');
    expect(parseRepoUrl('https://github.com/microsoft/vscode/blob/main/README.md')).toBe('microsoft/vscode');
    expect(parseRepoUrl('https://github.com/torvalds/linux?tab=readme-ov-file')).toBe('torvalds/linux');
    expect(parseRepoUrl('https://github.com/torvalds/linux#readme')).toBe('torvalds/linux');
    expect(parseRepoUrl('http://www.github.com/rust-lang/rust/')).toBe('rust-lang/rust');
  });

  it('裸 owner/repo 也接受', () => {
    expect(parseRepoUrl('owner/repo')).toBe('owner/repo');
    expect(parseRepoUrl('  owner/repo  ')).toBe('owner/repo');
  });

  it('非法地址抛中文错误', () => {
    expect(() => parseRepoUrl('')).toThrow(/粘贴 GitHub/);
    expect(() => parseRepoUrl('https://gitlab.com/a/b')).toThrow(/只支持 github\.com/);
    expect(() => parseRepoUrl('github.com/onlyowner')).toThrow(/只支持 github\.com/);
    expect(() => parseRepoUrl('https://github.com/a/b c')).toThrow(/不能有空格/);
    expect(() => parseRepoUrl('owner/repo/extra')).toThrow(/只支持 github\.com/);
    expect(() => parseRepoUrl('x'.repeat(600))).toThrow(/太长/);
  });

  it('isValidRepoName / splitRepo', () => {
    expect(isValidRepoName('owner/repo')).toBe(true);
    expect(isValidRepoName('owner/repo/extra')).toBe(false);
    expect(isValidRepoName('owner repo')).toBe(false);
    expect(splitRepo('owner/repo')).toEqual({ owner: 'owner', name: 'repo' });
    expect(splitRepo('bad')).toBeNull();
  });
});

describe('YAML frontmatter 组装与反解', () => {
  const base = {
    repo: 'owner/repo',
    url: 'https://github.com/owner/repo',
    stars: 1234,
    language: 'TypeScript',
    topics: ['cli', 'tools']
  };

  it('固定字段顺序，stars 取整、语言缺失写未知', () => {
    const md = buildRepoNoteMarkdown({
      ...base,
      summary: '一个东西',
      highlights: ['亮点一'],
      scenes: '想偷懒时用'
    });
    expect(md.startsWith('---\nrepo: owner/repo\nurl: https://github.com/owner/repo\nstars: 1234\nlanguage: TypeScript\ntopics: cli, tools\n---')).toBe(true);
    expect(md).toContain('> 💡 **项目总结**：一个东西');
    expect(md).toContain('> - 亮点一');
    expect(md).toContain('> ⚠️ **适用场景**：想偷懒时用');

    const missing = buildRepoNoteMarkdown({ ...base, stars: 0, language: null, summary: '', highlights: [], scenes: '' });
    expect(missing).toContain('language: 未知');
  });

  it('parseRepoNoteMarkdown 能反解（含 CRLF）', () => {
    const md = buildRepoNoteMarkdown({ ...base, summary: '总结文本', highlights: ['a', 'b'], scenes: '场景' }).replace(/\n/g, '\r\n');
    const parsed = parseRepoNoteMarkdown(md);
    expect(parsed.repo).toBe('owner/repo');
    expect(parsed.stars).toBe(1234);
    expect(parsed.language).toBe('TypeScript');
    expect(parsed.summary).toBe('总结文本');
    expect(parsed.highlights).toEqual(['a', 'b']);
    expect(parsed.scenes).toBe('场景');
    expect(parsed.topics).toEqual(['cli', 'tools']);
  });

  it('坏内容也不抛错（卡片容错展示）', () => {
    const parsed = parseRepoNoteMarkdown('随便一段文字，没有 YAML');
    expect(parsed.repo).toBe('');
    expect(parsed.highlights).toEqual([]);
  });
});

describe('结果文案', () => {
  it('四种状态的汇总都有中文', () => {
    expect(formatImportResult({ repo: 'a/b', status: 'done', warning: null })).toContain('已导入并提炼');
    expect(formatImportResult({ repo: 'a/b', status: 'link_only', warning: null })).toContain('仅保存');
    expect(formatImportResult({ repo: 'a/b', status: 'ai_failed', warning: null })).toContain('AI');
  });
});
