import { describe, expect, it, vi } from 'vitest';
import {
  AI_EMPTY_REPLY_MESSAGE,
  AI_TIMEOUTS,
  buildChatRequest,
  buildMessages,
  chatEndpoint,
  chatOnce,
  describeAiHttpError,
  describeAiNetworkError,
  maskAiKey,
  normalizeBaseUrl,
  parseSseDataLine,
  streamChat,
  type AiFetcher,
  type AiHttpResponse
} from '../../src/main/ai';
import { extractAiJson, parseRelatedItems, parseTagSuggestion } from '../../src/shared/ai';

/** 第七版：AI 请求的纯逻辑（不联网、不起 Electron）。 */

const CONFIG = { baseUrl: 'https://api.example.com/v1', model: 'test-model', apiKey: 'sk-test-1234567890' };

/** 假 fetcher：把预置的分片当成 ReadableStream 吐出来。 */
function streamFetcher(chunks: string[], status = 200): AiFetcher {
  return async (): Promise<AiHttpResponse> => ({
    status,
    ok: status === 200,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      }
    }),
    text: async () => chunks.join('')
  });
}

function sse(delta: string): string {
  return 'data: ' + JSON.stringify({ choices: [{ delta: { content: delta } }] }) + '\n\n';
}

function jsonFetcher(bodyText: string, status = 200): AiFetcher {
  return async (): Promise<AiHttpResponse> => ({
    status,
    ok: status === 200,
    body: null,
    text: async () => bodyText
  });
}

describe('normalizeBaseUrl / chatEndpoint', () => {
  it('去掉结尾斜杠，拼出 /chat/completions', () => {
    expect(normalizeBaseUrl('https://api.example.com/v1/')).toBe('https://api.example.com/v1');
    expect(chatEndpoint('https://api.example.com/v1/')).toBe('https://api.example.com/v1/chat/completions');
  });

  it('用户直接贴完整的 /chat/completions 也不会拼两次', () => {
    expect(chatEndpoint('https://api.example.com/v1/chat/completions')).toBe(
      'https://api.example.com/v1/chat/completions'
    );
  });

  it('不是 http/https 或不是网址就中文报错', () => {
    expect(() => normalizeBaseUrl('')).toThrow(/不能为空/);
    expect(() => normalizeBaseUrl('随便写点什么')).toThrow(/https:\/\//);
    expect(() => normalizeBaseUrl('file:///c:/temp')).toThrow(/http\/https/);
  });
});

describe('buildMessages', () => {
  it('每个动作都带上系统约束，且正文进 user 消息', () => {
    const polish = buildMessages('polish', { action: 'polish', text: '这句话要润色。' });
    expect(polish[0].role).toBe('system');
    expect(polish[0].content).toContain('只输出');
    expect(polish[1].content).toContain('这句话要润色。');

    const summary = buildMessages('summary', { action: 'summary', title: '我的标题', noteText: '正文内容' });
    expect(summary[1].content).toContain('我的标题');
    expect(summary[1].content).toContain('正文内容');
  });

  it('翻译：自动识别时说清「中文→英文，其他→中文」，指定语言时点名', () => {
    const auto = buildMessages('translate', { action: 'translate', text: 'hello world', targetLang: 'auto' });
    expect(auto[1].content).toContain('原文是中文就翻成英文');
    const japanese = buildMessages('translate', { action: 'translate', text: '你好', targetLang: 'ja' });
    expect(japanese[1].content).toContain('日文');
  });

  it('标签/联想要求「只输出 JSON」，并把已有标签分类带上', () => {
    const tags = buildMessages('tags', {
      action: 'tags',
      noteText: '笔记正文',
      tags: ['已有的标签'],
      categories: ['工作', '学习']
    });
    expect(tags[1].content).toContain('只输出一个 JSON 对象');
    expect(tags[1].content).toContain('已有的标签');
    expect(tags[1].content).toContain('工作、学习');

    const related = buildMessages('related', { action: 'related', noteText: '正文' });
    expect(related[1].content).toContain('"items"');
  });

  it('笔记超长时截断，不会把整本书发出去', () => {
    const long = 'X'.repeat(30000);
    const messages = buildMessages('summary', { action: 'summary', noteText: long });
    expect(messages[1].content.length).toBeLessThan(10000);
  });
});

describe('buildChatRequest', () => {
  it('带上 Authorization，body 里 stream 如实传', () => {
    const built = buildChatRequest(CONFIG, [{ role: 'user', content: 'hi' }], { stream: true, maxTokens: 88 });
    expect(built.url).toBe('https://api.example.com/v1/chat/completions');
    expect(built.headers.Authorization).toBe('Bearer sk-test-1234567890');
    const body = JSON.parse(built.body) as Record<string, unknown>;
    expect(body.stream).toBe(true);
    expect(body.max_tokens).toBe(88);
    expect(body.model).toBe('test-model');
  });

  it('配置不全 / 模型名乱写时中文报错，不会发出去', () => {
    expect(() => buildChatRequest({ ...CONFIG, apiKey: '' }, [], { stream: true })).toThrow(/API Key/);
    expect(() => buildChatRequest({ ...CONFIG, model: 'a b<script>' }, [], { stream: true })).toThrow(/模型名/);
  });
});

describe('streamChat', () => {
  it('把分片拼成全文，并逐段回调（打字机效果）', async () => {
    const deltas: string[] = [];
    const text = await streamChat({
      fetcher: streamFetcher([sse('你好'), sse('，'), sse('世界'), 'data: [DONE]\n\n']),
      config: CONFIG,
      messages: [{ role: 'user', content: 'hi' }],
      onDelta: (delta) => deltas.push(delta)
    });
    expect(text).toBe('你好，世界');
    expect(deltas).toEqual(['你好', '，', '世界']);
  });

  it('分片被切断（半个 JSON）时也能靠行缓冲拼回来', async () => {
    const line = sse('完整一句话');
    const cut = Math.floor(line.length / 2);
    const text = await streamChat({
      fetcher: streamFetcher([line.slice(0, cut), line.slice(cut), 'data: [DONE]\n\n']),
      config: CONFIG,
      messages: [{ role: 'user', content: 'hi' }]
    });
    expect(text).toBe('完整一句话');
  });

  it('网关无视 stream 直接回整段 JSON 时兜底取 content', async () => {
    const body = JSON.stringify({ choices: [{ message: { content: '整段结果' } }] });
    const text = await streamChat({
      fetcher: streamFetcher([body]),
      config: CONFIG,
      messages: [{ role: 'user', content: 'hi' }]
    });
    expect(text).toBe('整段结果');
  });

  it('HTTP 401 翻成「Key 不对」，不把请求体/Key 泄露到提示里', async () => {
    await expect(
      streamChat({
        fetcher: jsonFetcher('{"error":{"message":"invalid key sk-test-1234567890"}}', 401),
        config: CONFIG,
        messages: [{ role: 'user', content: 'hi' }]
      })
    ).rejects.toThrow(/Key 不对或已失效（HTTP 401）/);
  });

  it('HTTP 429 翻成「限流」，并给等一会儿再试的建议', async () => {
    await expect(
      streamChat({
        fetcher: jsonFetcher('{"error":{"message":"rate limited (stub)"}}', 429),
        config: CONFIG,
        messages: [{ role: 'user', content: 'hi' }]
      })
    ).rejects.toThrow(/429|限流/);
  });

  it('等响应头超时：说清几秒没响应', async () => {
    const neverFetcher: AiFetcher = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      });
    await expect(
      streamChat({
        fetcher: neverFetcher,
        config: CONFIG,
        messages: [{ role: 'user', content: 'hi' }],
        timeouts: { headersMs: 30, idleMs: 60_000, totalMs: 60_000 }
      })
    ).rejects.toThrow(/30 毫秒没有响应|没有响应/);
  });

  it('外部取消（ai:cancel）时抛「已取消」', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      streamChat({
        fetcher: jsonFetcher('{}'),
        config: CONFIG,
        messages: [{ role: 'user', content: 'hi' }],
        signal: controller.signal
      })
    ).rejects.toThrow(/已取消|取消/);
  });
});

describe('chatOnce', () => {
  it('非流式直接取 message.content', async () => {
    const body = JSON.stringify({ choices: [{ message: { content: '{"tags":["a"]}' } }] });
    const text = await chatOnce({
      fetcher: jsonFetcher(body),
      config: CONFIG,
      messages: [{ role: 'user', content: 'hi' }]
    });
    expect(text).toBe('{"tags":["a"]}');
  });

  it('不是 JSON / 没有内容时给中文错误', async () => {
    await expect(
      chatOnce({ fetcher: jsonFetcher('<html>'), config: CONFIG, messages: [] })
    ).rejects.toThrow(/AI 返回的内容/);
    await expect(
      chatOnce({ fetcher: jsonFetcher('{"choices":[]}'), config: CONFIG, messages: [] })
    ).rejects.toThrow(/已连通，但返回了空内容/);
  });

  /* ---------------- 0.8.3：测试连接解析兼容层 ---------------- */

  it('测试连接用非流式请求：stream=false，不会去读 SSE', async () => {
    let sent: Record<string, unknown> = {};
    const fetcher: AiFetcher = async (_url, init) => {
      sent = JSON.parse(String(init.body)) as Record<string, unknown>;
      return { status: 200, ok: true, body: null, text: async () => '{"choices":[{"message":{"content":"可用"}}]}' };
    };
    const text = await chatOnce({ fetcher, config: CONFIG, messages: [{ role: 'user', content: 'hi' }] });
    expect(text).toBe('可用');
    expect(sent.stream).toBe(false);
    expect(JSON.stringify(sent)).not.toContain('data:');
  });

  it('标准 OpenAI / DeepSeek：取 choices[0].message.content', async () => {
    const text = await chatOnce({
      fetcher: jsonFetcher(JSON.stringify({ choices: [{ message: { content: '可用' } }] })),
      config: CONFIG,
      messages: []
    });
    expect(text).toBe('可用');
  });

  it('content 是分段数组（部分网关 / 新版接口）时拼起来', async () => {
    const text = await chatOnce({
      fetcher: jsonFetcher(
        JSON.stringify({
          choices: [{ message: { content: [{ type: 'text', text: '可' }, { type: 'text', text: '用' }] } }]
        })
      ),
      config: CONFIG,
      messages: []
    });
    expect(text).toBe('可用');
  });

  it('推理模型：content 为空时退到 message.reasoning_content', async () => {
    const text = await chatOnce({
      fetcher: jsonFetcher(
        JSON.stringify({ choices: [{ message: { content: '', reasoning_content: '可用' }, finish_reason: 'stop' }] })
      ),
      config: CONFIG,
      messages: []
    });
    expect(text).toBe('可用');
  });

  it('reasoning 字段名不同（reasoning）也能认', async () => {
    const text = await chatOnce({
      fetcher: jsonFetcher(JSON.stringify({ choices: [{ message: { content: null, reasoning: '可用' } }] })),
      config: CONFIG,
      messages: []
    });
    expect(text).toBe('可用');
  });

  it('补全接口的老写法 choices[0].text 也能读', async () => {
    const text = await chatOnce({
      fetcher: jsonFetcher(JSON.stringify({ choices: [{ text: '可用' }] })),
      config: CONFIG,
      messages: []
    });
    expect(text).toBe('可用');
  });

  it('真的空内容 → 说「已连通但返回了空内容」，而不是「接口不兼容」', async () => {
    await expect(
      chatOnce({
        fetcher: jsonFetcher(JSON.stringify({ choices: [{ message: { content: '' }, finish_reason: 'stop' }] })),
        config: CONFIG,
        messages: []
      })
    ).rejects.toThrow(AI_EMPTY_REPLY_MESSAGE);
  });

  it('被 max_tokens 截断（finish_reason=length）时多给一句提示', async () => {
    await expect(
      chatOnce({
        fetcher: jsonFetcher(JSON.stringify({ choices: [{ message: { content: '' }, finish_reason: 'length' }] })),
        config: CONFIG,
        messages: []
      })
    ).rejects.toThrow(/截断/);
  });

  it('HTTP 200 里带 error 对象 → 「AI 服务返回错误：…」', async () => {
    await expect(
      chatOnce({
        fetcher: jsonFetcher(JSON.stringify({ error: { message: 'model not exist' } })),
        config: CONFIG,
        messages: []
      })
    ).rejects.toThrow(/AI 服务返回错误：model not exist/);
  });

  it('正文是空字符串（连 JSON 都没有）也不会崩', async () => {
    await expect(chatOnce({ fetcher: jsonFetcher(''), config: CONFIG, messages: [] })).rejects.toThrow(
      AI_EMPTY_REPLY_MESSAGE
    );
  });

  it('网关无视 stream:false 仍回 SSE 时，把 data 行拼成正文', async () => {
    const body = sse('可') + sse('用') + 'data: [DONE]\n\n';
    const text = await chatOnce({ fetcher: jsonFetcher(body), config: CONFIG, messages: [] });
    expect(text).toBe('可用');
  });

  it('404 / 401 直接给精准文案（不会笼统说「没有文字」）', async () => {
    await expect(
      chatOnce({ fetcher: jsonFetcher('not found', 404), config: CONFIG, messages: [] })
    ).rejects.toThrow(/接口地址不对（HTTP 404）/);
    await expect(
      chatOnce({ fetcher: jsonFetcher('{"error":{"message":"bad key"}}', 401), config: CONFIG, messages: [] })
    ).rejects.toThrow(/API Key 不对或已失效（HTTP 401）/);
  });

  it('解析失败时把原始响应打到控制台，且 Key 被打码', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(
        chatOnce({
          fetcher: jsonFetcher(JSON.stringify({ choices: [], echo: 'sk-test-1234567890' })),
          config: CONFIG,
          messages: []
        })
      ).rejects.toThrow(AI_EMPTY_REPLY_MESSAGE);
      const logged = warn.mock.calls.map((args) => args.join(' ')).join('\n');
      expect(logged).toContain('原始响应');
      expect(logged).toContain('choices');
      expect(logged).not.toContain('sk-test-1234567890');
    } finally {
      warn.mockRestore();
    }
  });
});

describe('错误文案与打码', () => {
  it('常见状态码都有 actionable 的中文', () => {
    expect(describeAiHttpError(402).message).toContain('余额不足');
    expect(describeAiHttpError(403).message).toContain('没有调用权限');
    expect(describeAiHttpError(404).message).toContain('接口地址不对');
    expect(describeAiHttpError(429).message).toContain('限流');
    expect(describeAiHttpError(400, 'model not found').message).toContain('模型名');
    expect(describeAiHttpError(500).message).toContain('服务端出错');
  });

  it('报错正文里出现的 Key 会被打码', () => {
    const error = describeAiHttpError(400, 'bad key: sk-test-1234567890', 'sk-test-1234567890');
    expect(error.message).not.toContain('sk-test-1234567890');
    expect(error.message).toContain('sk-…7890');
  });

  it('网络异常分得清「连不上」和「未知」', () => {
    expect(describeAiNetworkError(new Error('fetch failed ECONNREFUSED')).message).toContain('连不上 AI 服务');
    expect(describeAiNetworkError(new Error('ENOTFOUND api.example.com')).message).toContain('连不上 AI 服务');
    expect(describeAiNetworkError(new Error('奇怪的错误')).message).toContain('奇怪的错误');
  });

  it('maskAiKey 只留头尾', () => {
    expect(maskAiKey('sk-1234567890abcdef')).toBe('sk-…cdef');
    expect(maskAiKey('short')).toBe('…rt');
    expect(maskAiKey('')).toBe('');
  });

  it('SSE 行解析：[DONE] / 增量 / 无关行', () => {
    expect(parseSseDataLine('data: [DONE]')).toEqual({ done: true, delta: '' });
    expect(parseSseDataLine('data: {"choices":[{"delta":{"content":"嗨"}}]}')).toEqual({ done: false, delta: '嗨' });
    expect(parseSseDataLine(': keep-alive')).toBeNull();
    expect(parseSseDataLine('event: message')).toBeNull();
  });

  it('默认超时符合约定（10s 响应头 / 60s 空闲 / 180s 总）', () => {
    expect(AI_TIMEOUTS.headersMs).toBe(10_000);
    expect(AI_TIMEOUTS.idleMs).toBe(60_000);
    expect(AI_TIMEOUTS.totalMs).toBe(180_000);
  });
});

describe('shared 的 JSON 解析（容错）', () => {
  it('标签结果：代码块包裹、带前后废话、去重、category=null', () => {
    const text = '好的，结果如下：\n```json\n{"tags":["读书","#读书"," 效率 "],"category":"null","reason":"主题相关"}\n```';
    const parsed = parseTagSuggestion(text);
    expect(parsed.tags).toEqual(['读书', '效率']);
    expect(parsed.category).toBeNull();
    expect(parsed.reason).toBe('主题相关');
  });

  it('联想结果：正常三条，字段缺失的跳过', () => {
    const items = parseRelatedItems(
      '{"items":[{"title":"追问一","detail":"说明"},{"detail":"没有标题"},{"title":"追问二"}]}'
    );
    expect(items).toEqual([
      { title: '追问一', detail: '说明' },
      { title: '追问二', detail: '' }
    ]);
  });

  it('完全解析不出来时抛中文错误', () => {
    expect(extractAiJson('完全不是 JSON')).toBeNull();
    expect(() => parseTagSuggestion('看不懂')).toThrow(/再试一次/);
    expect(() => parseRelatedItems('{"items":[]}')).toThrow(/再试一次/);
  });
});
