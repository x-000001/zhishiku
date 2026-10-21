import { describe, expect, it } from 'vitest';
import { buildRepoExtractMessages, parseRepoExtract } from '../../src/main/ai';
import type { GithubRepoInfo } from '../../src/shared/github';

/** AI 把 Prompt 模板抄成正文（指令回显）的回归测试。
 *  四个核心用例：纯回显判失败 / 合法内容含敏感词也要成功 / 带包装的 JSON / 截断 JSON 不崩。 */

function info(overrides: Partial<GithubRepoInfo> = {}): GithubRepoInfo {
  return {
    repo: 'deepseek-ai/deepseek-harness',
    owner: 'deepseek-ai',
    name: 'deepseek-harness',
    description: '一个用来测试的仓库',
    stars: 256478,
    forks: 12,
    language: 'TypeScript',
    topics: ['plugin'],
    license: 'MIT',
    homepage: null,
    updatedAt: '2026-10-01T00:00:00Z',
    htmlUrl: 'https://github.com/deepseek-ai/deepseek-harness',
    defaultBranch: 'main',
    archived: false,
    readme: '# deepseek-harness\n\n一切皆插件架构，基于 Cordis。',
    readmeTruncated: false,
    ...overrides
  };
}

describe('TDD：指令回显 / JSON 包装 / 截断容错', () => {
  it('纯回显脏数据（正文全是提示词模板）→ 判解析失败，不许当成品', () => {
    const echo = [
      '我们需要回答用户：根据 README 提炼成三段，严格按格式输出纯 Markdown。必须只基于 README 内容。注意不要编造。仓库是 deepseek-ai/deepseek-harness。',
      '### 核心亮点',
      '- （3到5条，每条不超过30字，只写 README 里明确提到的能力）',
      '### 适用场景',
      '（一句话：什么情况下值得用，什么情况下不建议用）'
    ].join('\n');
    expect(() => parseRepoExtract(echo)).toThrow(/没有返回能看的提炼结果/);
  });

  it('合法内容里碰巧含「回答用户」也要成功（不能一刀切误伤）', () => {
    const reply = [
      '### 项目总结',
      '一个能自动回答用户问题的客服机器人，支持多轮会话与知识库检索。',
      '### 核心亮点',
      '- 自动回答用户问题',
      '- 支持多轮会话',
      '- 可接入知识库',
      '### 适用场景',
      '适合需要 7×24 自动回复用户的团队。'
    ].join('\n');
    const draft = parseRepoExtract(reply);
    expect(draft.summary).toContain('自动回答用户问题');
    expect(draft.highlights).toEqual(['自动回答用户问题', '支持多轮会话', '可接入知识库']);
    expect(draft.scenes).toContain('7×24');
  });

  it('带包装的 JSON（```json 围栏 / 「好的，结果如下：」前缀）能提取主体并解析成功', () => {
    const json = JSON.stringify({
      summary: '一个批量处理文件的命令行工具，内置进度条与配置模板。',
      highlights: ['批量处理文件', '内置进度条', '支持配置模板'],
      scenes: '适合需要重复处理大量文件时使用。'
    });
    const fenced = '```json\n' + json + '\n```';
    const prefixed = '好的，结果如下：' + json;
    const fencedDraft = parseRepoExtract(fenced);
    expect(fencedDraft.summary).toBe('一个批量处理文件的命令行工具，内置进度条与配置模板。');
    expect(fencedDraft.highlights).toEqual(['批量处理文件', '内置进度条', '支持配置模板']);
    expect(parseRepoExtract(prefixed).scenes).toBe('适合需要重复处理大量文件时使用。');
  });

  it('残缺 / 截断的 JSON 不崩溃，按失败降级（交给「重试提炼」）', () => {
    const truncated = '{"summary":"一个工具","highlights":["快","稳"],"scenes":"适合';
    expect(() => parseRepoExtract(truncated)).toThrow(/没有返回能看的提炼结果/);
    // 尾巴多一个逗号也算坏 JSON，同样走降级而不是抛原生 SyntaxError
    expect(() => parseRepoExtract('{"summary":"一个工具","highlights":["快"],}')).toThrow(
      /没有返回能看的提炼结果/
    );
  });

  it('Prompt 改成 JSON 提取器：system 禁止复述指令，user 直接给 JSON 字段', () => {
    const [system, user] = buildRepoExtractMessages(info());
    expect(system.role).toBe('system');
    expect(system.content).toContain('JSON');
    expect(system.content).toContain('严禁复述指令');
    expect(system.content).toContain('严禁编造 README 中未提及的技术栈');
    expect(user.content).toContain('"summary"');
    expect(user.content).toContain('"highlights"');
    expect(user.content).toContain('"scenes"');
    // 不再留「（一句话：……）」这类可被模型抄回去的括号占位说明
    expect(user.content).not.toContain('一句话：什么情况下值得用');
  });
});
