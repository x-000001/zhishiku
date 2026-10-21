import { describe, expect, it } from 'vitest';
import { buildRepoExtractMessages, parseRepoExtract, REPO_EXTRACT_MAX_TOKENS } from '../../src/main/ai';
import {
  RepoExtractLimiter,
  buildLinkOnlyNote,
  extractRepoNote,
  renderRepoNoteHtml,
  type RepoExtractDeps
} from '../../src/main/repo-extract';
import type { GithubRepoInfo } from '../../src/shared/github';

function info(overrides: Partial<GithubRepoInfo> = {}): GithubRepoInfo {
  return {
    repo: 'owner/repo',
    owner: 'owner',
    name: 'repo',
    description: '一个用来测试的仓库',
    stars: 4321,
    forks: 12,
    language: 'TypeScript',
    topics: ['cli', 'automation'],
    license: 'MIT',
    homepage: null,
    updatedAt: '2026-10-01T00:00:00Z',
    htmlUrl: 'https://github.com/owner/repo',
    defaultBranch: 'main',
    archived: false,
    readme: '# repo\n\n这是一个命令行工具，支持批量处理。',
    readmeTruncated: false,
    ...overrides
  };
}

describe('buildRepoExtractMessages：防幻觉 + 字数约束', () => {
  it('system prompt 明确禁止编造 README 未提及的技术栈', () => {
    const messages = buildRepoExtractMessages(info());
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('严禁编造 README 中未提及的技术栈');
  });

  it('user prompt 带三段格式与硬性字数（100 字 / 3-5 条 / 每条 30 字）', () => {
    const user = buildRepoExtractMessages(info())[1].content;
    expect(user).toContain('不超过 100 字');
    expect(user).toContain('3 到 5 条');
    expect(user).toContain('每条不超过 30 字');
    expect(user).toContain('owner/repo');
  });

  it('README 超长只发前 8000 字', () => {
    const huge = 'A'.repeat(12000);
    const user = buildRepoExtractMessages(info({ readme: huge }))[1].content;
    expect(user).toContain('A'.repeat(8000));
    expect(user).not.toContain('A'.repeat(8001));
  });

  it('没有 README 时明确要求写「README 未提及」', () => {
    const user = buildRepoExtractMessages(info({ readme: null }))[1].content;
    expect(user).toContain('README 未提及');
  });
});

describe('parseRepoExtract：模型返回格式容错', () => {
  it('标准三段 Markdown', () => {
    const draft = parseRepoExtract(
      ['### 项目总结', '一个命令行工具。', '### 核心亮点', '- 支持批量', '- 有进度条', '### 适用场景', '适合写脚本的人。'].join('\n')
    );
    expect(draft.summary).toBe('一个命令行工具。');
    expect(draft.highlights).toEqual(['支持批量', '有进度条']);
    expect(draft.scenes).toBe('适合写脚本的人。');
  });

  it('带 ``` 代码块围栏 / 标题写成加粗 / 星号列表也能认', () => {
    const reply = ['```markdown', '**项目总结**', '一个工具。', '**核心亮点**', '* 快', '* 稳', '**适用场景**', '日常用。', '```'].join('\n');
    const draft = parseRepoExtract(reply);
    expect(draft.summary).toBe('一个工具。');
    expect(draft.highlights).toEqual(['快', '稳']);
    expect(draft.scenes).toBe('日常用。');
  });

  it('缺「适用场景」不报错', () => {
    const draft = parseRepoExtract('### 项目总结\n一个工具。\n### 核心亮点\n- 快');
    expect(draft.summary).toBe('一个工具。');
    expect(draft.scenes).toBe('');
  });

  it('总结截到 100 字、亮点最多 5 条且每条截到 30 字', () => {
    const long = '很长的一句话'.repeat(40);
    const lines = ['### 项目总结', long, '### 核心亮点', ...Array.from({ length: 8 }, (_, i) => `- 亮点${i}${'补'.repeat(40)}`)];
    const draft = parseRepoExtract(lines.join('\n'));
    expect(draft.summary.length).toBeLessThanOrEqual(101); // 100 字 + 省略号
    expect(draft.highlights.length).toBe(5);
    for (const item of draft.highlights) expect(item.length).toBeLessThanOrEqual(31);
  });

  it('完全看不懂的内容抛错（让调用方降级保存）', () => {
    expect(() => parseRepoExtract('   ')).toThrow(/没有返回能看的提炼结果/);
  });

  it('maxTokens 常量合理', () => {
    expect(REPO_EXTRACT_MAX_TOKENS).toBeGreaterThanOrEqual(600);
  });
});

describe('extractRepoNote：成功与降级', () => {
  const okChat: RepoExtractDeps['chat'] = async () =>
    ['### 项目总结', '一个批处理工具。', '### 核心亮点', '- 批量处理', '### 适用场景', '适合自动化。'].join('\n');

  it('AI 成功 → done + YAML + 引用块', async () => {
    const outcome = await extractRepoNote({ chat: okChat, now: () => new Date('2026-10-19T00:00:00Z') }, info());
    expect(outcome.status).toBe('done');
    expect(outcome.markdown).toContain('repo: owner/repo');
    expect(outcome.markdown).toContain('stars: 4321');
    expect(outcome.markdown).toContain('> 💡 **项目总结**：一个批处理工具。');
    expect(outcome.meta.source).toBe('ai');
    expect(outcome.meta.extractedAt).toBe('2026-10-19T00:00:00.000Z');
  });

  it('AI 抛错 → ai_failed，但 Markdown 仍然可用（不丢条目）', async () => {
    const outcome = await extractRepoNote(
      {
        chat: async () => {
          throw new Error('模型服务 401');
        }
      },
      info()
    );
    expect(outcome.status).toBe('ai_failed');
    expect(outcome.markdown).toContain('repo: owner/repo');
    expect(outcome.meta.source).toBe('fallback');
    expect(outcome.meta.error).toContain('401');
    expect(outcome.meta.summary).toBeTruthy();
  });

  it('AI 返回空内容 → ai_failed', async () => {
    const outcome = await extractRepoNote({ chat: async () => '' }, info());
    expect(outcome.status).toBe('ai_failed');
    expect(outcome.markdown).toContain('owner/repo');
  });

  it('仅保存链接：不调 AI，状态 link_only', () => {
    const outcome = buildLinkOnlyNote(info({ description: null, topics: [] }));
    expect(outcome.status).toBe('link_only');
    expect(outcome.markdown).toContain('README 未提及简介');
    expect(outcome.meta.source).toBe('fallback');
  });
});

describe('RepoExtractLimiter：并发闸', () => {
  it('默认最多 2 个，超出直接抛中文错误', () => {
    const limiter = new RepoExtractLimiter();
    const releaseA = limiter.acquire();
    const releaseB = limiter.acquire();
    expect(limiter.running).toBe(2);
    expect(() => limiter.acquire()).toThrow(/同时最多提炼 2 个项目/);
    releaseA();
    expect(limiter.running).toBe(1);
    const releaseC = limiter.acquire();
    expect(limiter.running).toBe(2);
    releaseB();
    releaseC();
    expect(limiter.running).toBe(0);
  });

  it('重复释放不会把计数减成负数', () => {
    const limiter = new RepoExtractLimiter(1);
    const release = limiter.acquire();
    release();
    release();
    expect(limiter.running).toBe(0);
    expect(() => limiter.acquire()).not.toThrow();
  });
});

describe('renderRepoNoteHtml：转笔记时的富文本', () => {
  const markdown = [
    '---',
    'repo: owner/repo',
    'url: https://github.com/owner/repo',
    'stars: 4321',
    'language: TypeScript',
    'topics: cli, tools',
    '---',
    '',
    '> 💡 **项目总结**：一个工具。',
    '> 🎯 **核心亮点**：',
    '> - 快',
    '> ⚠️ **适用场景**：日常用。'
  ].join('\n');

  it('frontmatter 变成一行元信息，不出现 --- 分隔线', () => {
    const html = renderRepoNoteHtml(markdown);
    expect(html).toContain('owner/repo');
    expect(html).toContain('⭐');
    expect(html).toContain('TypeScript');
    expect(html).not.toContain('---');
  });

  it('正文走项目自带 Markdown 渲染，引用块能出 <blockquote>', () => {
    const html = renderRepoNoteHtml(markdown);
    expect(html).toContain('<blockquote>');
    expect(html).toContain('项目总结');
  });

  it('正文里的 HTML 被转义（防 XSS）', () => {
    const html = renderRepoNoteHtml('---\nrepo: a/b\n---\n<img src=x onerror=alert(1)>');
    expect(html).not.toContain('<img');
  });
});
