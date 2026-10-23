import { describe, expect, it } from 'vitest';
import {
  buildLocateMessages,
  extractCoreChars,
  findQuoteRanges,
  parseLocateQuote,
  takeAround
} from '../../src/shared/locate';

describe('0.12.3 搜索直达：纯函数层', () => {
  it('extractCoreChars 剥掉标点 / 空格 / 全角并保留原文下标映射', () => {
    const text = '先配置 WAL，模式！';
    const core = extractCoreChars(text);
    expect(core.text).toBe('先配置wal模式');
    // 每个核心字符都能映射回原文，且原文切片非空
    for (let i = 0; i < core.text.length; i += 1) {
      expect(text.slice(core.map[i], core.ends[i]).length).toBeGreaterThan(0);
    }
    expect(text.slice(core.map[core.text.indexOf('w')], core.ends[core.text.indexOf('l')])).toBe('WAL');
  });

  it('findQuoteRanges 能跨过原文里的标点和空格命中', () => {
    const text = '先配置 WAL 模式，再重启';
    const spans = findQuoteRanges(text, '配置WAL模式');
    expect(spans).toHaveLength(1);
    expect(text.slice(spans[0].start, spans[0].end)).toBe('配置 WAL 模式');
  });

  it('findQuoteRanges 全半角 / 大小写折叠后仍能命中', () => {
    const text = '打开ＷＡＬ模式看看';
    const spans = findQuoteRanges(text, 'wal');
    expect(spans).toHaveLength(1);
    expect(text.slice(spans[0].start, spans[0].end)).toBe('ＷＡＬ');
  });

  it('引文完全匹配失败时按多词联合匹配', () => {
    const text = '今天先做复盘，然后配置 WAL 模式。';
    const spans = findQuoteRanges(text, '复盘 WAL');
    expect(spans).toHaveLength(1);
    const hit = text.slice(spans[0].start, spans[0].end);
    expect(hit).toContain('复盘');
    expect(hit).toContain('WAL');
  });

  it('引文多抄了尾巴时按前 15 个核心字符兜底', () => {
    const text = '间隔重复与主动回忆是复习的两条主线，表格和代码也要能保存。';
    const quote = '间隔重复与主动回忆是复习的两条主线，另外这句原文里没有。';
    const spans = findQuoteRanges(text, quote);
    expect(spans.length).toBeGreaterThan(0);
    expect(spans[0].start).toBe(0);
  });

  it('同一段话出现多次时返回多个命中（供全部高亮）', () => {
    const text = '配置 WAL 模式。配置 WAL 模式。';
    const spans = findQuoteRanges(text, '配置 WAL 模式');
    expect(spans).toHaveLength(2);
    expect(spans[1].start).toBeGreaterThan(spans[0].end - 1);
  });

  it('单字 Query 也能定位（不走核心字符阈值）', () => {
    const text = '甲乙丙丁';
    const spans = findQuoteRanges(text, '丙');
    expect(spans).toEqual([{ start: 2, end: 3 }]);
  });

  it('找不到时返回空数组，不抛错', () => {
    expect(findQuoteRanges('上面这段文字', '完全不存在的词')).toEqual([]);
    expect(findQuoteRanges('', '随便')).toEqual([]);
    expect(findQuoteRanges('随便', '   ')).toEqual([]);
  });

  it('代理对（emoji / 生僻字）的下标不被劈开', () => {
    const text = '𠮷野家很好吃';
    const spans = findQuoteRanges(text, '野家');
    expect(spans).toHaveLength(1);
    expect(text.slice(spans[0].start, spans[0].end)).toBe('野家');
  });

  it('takeAround 短文本原样返回，长文本围绕锚点截取并标 truncated', () => {
    const short = '配置 WAL 模式';
    expect(takeAround(short, 'WAL')).toEqual({ text: short, start: 0, end: short.length, truncated: false });

    const long = Array.from({ length: 200 }, (_, i) => `第 ${i} 行：这里是用来测试窗口截取的正文内容。`).join('\n');
    const around = takeAround(long, '第 150 行', 400);
    expect(around.truncated).toBe(true);
    expect(around.text).toContain('第 150 行');
    expect(around.start).toBeGreaterThan(0);
    expect(around.end).toBeLessThan(long.length);
  });

  it('takeAround 锚点找不到时也不崩，仍返回合法窗口', () => {
    const long = '开头一段文字。'.repeat(500);
    const around = takeAround(long, '根本没有的锚点', 300);
    expect(around.text.length).toBeGreaterThan(0);
    expect(around.text.length).toBeLessThanOrEqual(600);
  });

  it('parseLocateQuote 能剥掉 ```json 围栏与解释前缀', () => {
    expect(parseLocateQuote('好的，结果如下：\n```json\n{"quote":"配置 WAL 模式"}\n```')).toBe('配置 WAL 模式');
    expect(parseLocateQuote('{"quote":"  「主动回忆」  "}')).toBe('主动回忆');
  });

  it('parseLocateQuote 遇到坏 JSON / 纯解释时丢弃（返回空串）', () => {
    expect(parseLocateQuote('{"quote": ')).toBe('');
    expect(parseLocateQuote('我觉得大概是第一段吧')).toBe('');
    expect(parseLocateQuote('{"quote":""}')).toBe('');
  });

  it('buildLocateMessages 的提示词包含关键词与原文窗口，并要求只回 JSON', () => {
    const messages = buildLocateMessages('配置 WAL', '原文里写着配置 WAL 模式。');
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('{"quote"');
    expect(messages[1].content).toContain('配置 WAL');
    expect(messages[1].content).toContain('配置 WAL 模式');
  });
});
