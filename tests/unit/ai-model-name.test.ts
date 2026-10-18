import { describe, expect, it } from 'vitest';
import {
  AI_CONFIG_MISSING_PREFIX,
  BASE_URL_ERROR_PREFIX,
  MODEL_NAME_ERROR_PREFIX,
  assertAiConfig,
  buildChatRequest,
  normalizeBaseUrl,
  normalizeModelName
} from '../../src/main/ai';
import { classifyAiConfigError } from '../../src/shared/ai';

/**
 * 0.8.2：模型名校验的回归测试。
 * 真实世界里带连字符、斜杠、冒号的模型名很常见（deepseek-v4-pro、Qwen/Qwen2.5-7B-Instruct、
 * deepseek-r1:7b），校验必须放行；空格/中文/引号这类会被拼进请求体的字符必须拒绝，
 * 而且报错文案要能明确告诉用户「是模型名格式错误」，不能混进「连接失败」。
 */

const CONFIG = { baseUrl: 'https://api.example.com/v1', model: 'deepseek-chat', apiKey: 'sk-test-1234567890' };

describe('normalizeModelName：带连字符/斜杠/冒号的常见模型名要放行', () => {
  it('deepseek-v4-pro（连字符）不会被误判', () => {
    expect(normalizeModelName('deepseek-v4-pro')).toBe('deepseek-v4-pro');
  });

  it('常见服务商的真实模型 id 全部通过', () => {
    const names = [
      'deepseek-chat',
      'deepseek-v4-pro',
      'gpt-4o-mini',
      'gpt-4.1',
      'claude-3-5-sonnet-20241022',
      'Qwen/Qwen2.5-7B-Instruct',
      'openai/gpt-4o',
      'models/gemini-1.5-pro',
      'deepseek-r1:7b',
      'glm-4.5-flash',
      'kimi-k2-0905-preview'
    ];
    for (const name of names) {
      expect(normalizeModelName(name), name).toBe(name);
    }
  });

  it('前后空格会先 trim，再验字符', () => {
    expect(normalizeModelName('  deepseek-v4-pro  ')).toBe('deepseek-v4-pro');
  });
});

describe('normalizeModelName：危险/写错的字符仍然拒绝，并说清原因', () => {
  it('空模型名给「不能为空」', () => {
    for (const bad of ['', '   ', '\n\t']) {
      expect(() => normalizeModelName(bad)).toThrow(new RegExp(MODEL_NAME_ERROR_PREFIX));
    }
    expect(() => normalizeModelName('')).toThrow(/不能为空/);
  });

  it('空格、中文、引号、分号、逗号、井号都拒绝', () => {
    const bads = ['deepseek v4', '深度求索', 'a<script>', 'a"b', "a'b", 'a;b', 'a,b', 'a#b', 'a=b', 'a*b', 'a&b'];
    for (const bad of bads) {
      expect(() => normalizeModelName(bad), bad).toThrow(new RegExp(MODEL_NAME_ERROR_PREFIX));
    }
  });

  it('报错文案点名「连字符（-）」，用户照着改就行', () => {
    let message = '';
    try {
      normalizeModelName('deepseek v4');
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message.startsWith(MODEL_NAME_ERROR_PREFIX)).toBe(true);
    expect(message).toContain('连字符');
    expect(message).toContain('-');
  });

  it('把第一个不认识的字符点出来（复制粘贴常见的全角空格/中文逗号）', () => {
    expect(() => normalizeModelName('deepseek v4')).toThrow(/空格/);
    expect(() => normalizeModelName('deepseek，v4')).toThrow(/「，」/);
    expect(() => normalizeModelName('deepseek　v4')).toThrow(/「　」/);
    expect(() => normalizeModelName('deepseek-v4\npro')).toThrow(/换行/);
  });
});

describe('模型名校验与请求体的接线', () => {
  it('带连字符的模型名能真正进到请求 JSON 里（不会在发出前就被拦）', () => {
    const req = buildChatRequest({ ...CONFIG, model: 'deepseek-v4-pro' }, [{ role: 'user', content: '你好' }], {
      stream: true
    });
    expect(JSON.parse(req.body).model).toBe('deepseek-v4-pro');
    expect(req.url).toBe('https://api.example.com/v1/chat/completions');
    expect(req.headers.Authorization).toBe('Bearer sk-test-1234567890');
  });

  it('斜杠+点+冒号组合模型名也能进请求体', () => {
    const req = buildChatRequest({ ...CONFIG, model: 'Qwen/Qwen2.5-7B-Instruct' }, [], { stream: false });
    expect(JSON.parse(req.body).model).toBe('Qwen/Qwen2.5-7B-Instruct');
  });

  it('空格模型名在发出前就被拦住，不会打网络请求', () => {
    expect(() => buildChatRequest({ ...CONFIG, model: 'a b' }, [], { stream: true })).toThrow(
      new RegExp(MODEL_NAME_ERROR_PREFIX)
    );
  });
});

describe('错误类型可区分：配置错 ≠ 连接失败', () => {
  it('缺 Key/模型/地址时统一带「AI 设置不完整：」前缀', () => {
    expect(() => assertAiConfig({ ...CONFIG, apiKey: '' })).toThrow(new RegExp('^' + AI_CONFIG_MISSING_PREFIX));
    expect(() => assertAiConfig({ ...CONFIG, model: '' })).toThrow(new RegExp('^' + AI_CONFIG_MISSING_PREFIX));
    expect(() => assertAiConfig({ ...CONFIG, baseUrl: '' })).toThrow(new RegExp('^' + AI_CONFIG_MISSING_PREFIX));
  });

  it('接口地址写错时带「接口地址格式错误：」前缀', () => {
    expect(() => normalizeBaseUrl('')).toThrow(new RegExp('^' + BASE_URL_ERROR_PREFIX));
    expect(() => normalizeBaseUrl('not-a-url')).toThrow(new RegExp('^' + BASE_URL_ERROR_PREFIX));
    expect(() => normalizeBaseUrl('ftp://api.example.com/v1')).toThrow(new RegExp('^' + BASE_URL_ERROR_PREFIX));
  });

  it('渲染层能把三种配置错误归类到对应输入框', () => {
    expect(classifyAiConfigError(MODEL_NAME_ERROR_PREFIX + '只能包含字母')).toBe('model');
    expect(classifyAiConfigError(BASE_URL_ERROR_PREFIX + '不像一个网址')).toBe('baseUrl');
    expect(classifyAiConfigError(AI_CONFIG_MISSING_PREFIX + '还没填 API Key')).toBe('config');
  });

  it('网络/超时/服务端错误不会被误判成配置错（仍算「连接失败」）', () => {
    const networkLike = [
      '连不上 AI 服务，请检查网络或代理设置（本地功能不受影响）',
      '网络连接超时（60 秒内没有响应），请检查网络后重试',
      'AI 服务拒绝了这次请求（HTTP 401），通常是 API Key 不对',
      '请求被 AI 服务限流了（HTTP 429），等一会儿再试'
    ];
    for (const message of networkLike) {
      expect(classifyAiConfigError(message), message).toBeNull();
    }
  });
});
