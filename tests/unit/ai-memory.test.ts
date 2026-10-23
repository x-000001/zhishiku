import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as db from '../../src/main/db';
import { ensureDirs, type DataPaths } from '../../src/main/paths';
import {
  AI_MEMORY_HINT,
  AI_MEMORY_MAX_INJECT,
  buildMemoryExtractPrompt,
  buildPreferenceBlock,
  parseMemoryJson,
  sanitizeMemoryText,
  shouldSkipMemoryExtraction,
  type AiMemoryExtractContext
} from '../../src/shared/ai-memory';
import { buildMemoryExtractionMessages, buildMessages, buildSystemPrompt } from '../../src/main/ai';

const ctx = (sourceText: string, outputText = '这是一段完全不同的输出内容，用来表示 AI 产生了新东西。'): AiMemoryExtractContext => ({
  moduleTarget: 'polish',
  sourceText,
  outputText
});

describe('sanitizeMemoryText：入库/注入前剥离特殊符号', () => {
  it('尖括号被清掉，HTML 片段无法带进记忆', () => {
    const clean = sanitizeMemoryText('喜欢 <b>加粗</b> 和 <script>alert(1)</script>');
    expect(clean).not.toContain('<');
    expect(clean).not.toContain('>');
    expect(clean).toContain('加粗');
  });

  it('控制字符与连续空白被压成一个空格，长度截到 120', () => {
    const clean = sanitizeMemoryText('第一行\n\n第二行\t\t第三行' + 'x'.repeat(300));
    expect(clean.startsWith('第一行 第二行 第三行')).toBe(true);
    expect(clean.length).toBeLessThanOrEqual(120);
  });
});

describe('parseMemoryJson：剥离脏 JSON', () => {
  it('普通 JSON 对象能取到 preferences', () => {
    expect(parseMemoryJson('{"preferences":["喜欢简短分点","不要客套话"]}')).toEqual([
      '喜欢简短分点',
      '不要客套话'
    ]);
  });

  it('带 ```json 围栏和前缀废话也能抠出 JSON', () => {
    const raw = '好的，结果如下：\n```json\n{"preferences":["代码块标注 js"]}\n```\n以上。';
    expect(parseMemoryJson(raw)).toEqual(['代码块标注 js']);
  });

  it('完全不是 JSON 或 JSON 坏了 → 返回空数组，不抛错', () => {
    expect(parseMemoryJson('AI 回复')).toEqual([]);
    expect(parseMemoryJson('{"preferences": [坏}')).toEqual([]);
  });

  it('去重且最多 3 条，并且入库值已 sanitize', () => {
    const raw = JSON.stringify({ preferences: ['a<b', 'a<b', '二', '三', '四'] });
    const result = parseMemoryJson(raw);
    expect(result.length).toBe(AI_MEMORY_MAX_INJECT);
    expect(result[0]).not.toContain('<');
  });
});

describe('shouldSkipMemoryExtraction：本地拦截省 API 钱', () => {
  it('原文少于 20 字直接跳过', () => {
    expect(shouldSkipMemoryExtraction(ctx('太短了'))).toBe(true);
    expect(shouldSkipMemoryExtraction(ctx('这是一段超过二十个字的原文内容，用来测试不会跳过的情况。'))).toBe(false);
  });

  it('输出和原文完全一致（只是没有新信息）也跳过', () => {
    const source = '这是一段超过二十个字的原文内容，用来测试不会跳过的情况。';
    expect(shouldSkipMemoryExtraction(ctx(source, source))).toBe(true);
    expect(shouldSkipMemoryExtraction(ctx(source, ''))).toBe(true);
  });

  it('只改了一两个字的简单替换不提取', () => {
    const source = '我喜欢用简洁的列表来记录每天的工作重点和复盘结论。';
    expect(shouldSkipMemoryExtraction(ctx(source, source.replace('简洁', '简单')))).toBe(true);
  });
});

describe('buildPreferenceBlock / buildSystemPrompt：注入隔离与优先级声明', () => {
  it('没有记忆时返回空串（零行为变化）', () => {
    expect(buildPreferenceBlock([])).toBe('');
    expect(buildSystemPrompt()).not.toContain('<user_preferences>');
  });

  it('有记忆时用 <user_preferences> 包裹并声明优先级低于核心指令', () => {
    const block = buildPreferenceBlock(['喜欢简短分点', '回答不要客套话']);
    expect(block).toContain('<user_preferences>');
    expect(block).toContain('优先级低于');
    expect(block).toContain('喜欢简短分点');
  });

  it('注入前二次 sanitize，最多 3 条', () => {
    const block = buildPreferenceBlock(['<b>加粗</b>', '二', '三', '四']);
    expect(block).not.toContain('<b>');
    expect(block.match(/^- /gm)?.length ?? 0).toBe(3);
  });

  it('buildMessages 会把记忆放进 system 消息；不传时和旧提示词一致', () => {
    const withMemory = buildMessages('polish', { action: 'polish', text: '帮我润色' }, ['喜欢简短']);
    expect(withMemory[0].role).toBe('system');
    expect(withMemory[0].content).toContain('喜欢简短');
    const without = buildMessages('polish', { action: 'polish', text: '帮我润色' });
    expect(without[0].content).not.toContain('<user_preferences>');
  });

  it('后台提取消息带固定标记，便于 stub/测试分流', () => {
    const messages = buildMemoryExtractionMessages(ctx('这是一段超过二十个字的原文内容，用来测试后台提取。'));
    expect(messages[0].role).toBe('system');
    expect(messages[1].content).toContain('请从下面这次 AI 交互里提取用户稳定的写作/格式偏好');
    expect(buildMemoryExtractPrompt(ctx('正文')).length).toBeGreaterThan(40);
  });
});

describe('ai_memory 表：迁移、领域隔离、分页与增删', () => {
  let root = '';
  let paths: DataPaths;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'jwkb-ai-memory-'));
    paths = ensureDirs(root);
    db.openDatabase(paths);
  });

  afterAll(() => {
    try {
      db.closeDatabase();
    } catch {
      /* 已关闭 */
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    const raw = db.getRawDb();
    try {
      raw.exec('delete from ai_memory');
    } catch {
      /* 表不存在时由迁移用例证明降级行为 */
    }
  });

  it('新库打开后建好 ai_memory 表（幂等补齐，不占用 user_version），开关默认开启', () => {
    const row = db.getRawDb().prepare('PRAGMA user_version').get() as { user_version: number };
    // ai_memory 走「每次打开幂等建表」而不是版本号迁移，所以 0.12.1 老库的 user_version 仍是 8。
    expect(Number(row.user_version)).toBe(8);
    const table = db
      .getRawDb()
      .prepare("select name from sqlite_master where type = 'table' and name = 'ai_memory'")
      .get();
    expect(table).toBeTruthy();
    expect(db.aiMemoryEnabled()).toBe(true);
  });

  it('addAiMemory 写入时二次 sanitize，重复只累加 hit_count', () => {
    expect(db.addAiMemory('polish', ['喜欢 <b>简短</b> 回答'])).toBe(1);
    expect(db.addAiMemory('polish', ['喜欢 <b>简短</b> 回答'])).toBe(0);
    const rows = db.listAiMemory('polish');
    expect(rows.length).toBe(1);
    expect(rows[0].content).not.toContain('<');
    expect(rows[0].hit_count).toBe(2);
  });

  it('listAiMemory 严格按 module_target 隔离，且最多注入 3 条', () => {
    db.addAiMemory('polish', ['p1', 'p2', 'p3', 'p4']);
    db.addAiMemory('summary', ['s1']);
    const polish = db.listAiMemory('polish');
    expect(polish.length).toBe(3);
    expect(polish.every((row) => row.module_target === 'polish')).toBe(true);
    expect(db.listAiMemory('summary').map((row) => row.content)).toEqual(['s1']);
    expect(db.listAiMemory('translate')).toEqual([]);
  });

  it('分页：6 条时第 1 页 5 条、第 2 页 1 条', () => {
    db.addAiMemory('summary', ['a', 'b', 'c', 'd', 'e', 'f']);
    expect(db.aiMemoryPage(1, 5)).toMatchObject({ total: 6 });
    expect(db.aiMemoryPage(1, 5).items.length).toBe(5);
    expect(db.aiMemoryPage(2, 5).items.length).toBe(1);
    expect(db.aiMemoryPage(99, 5).items.length).toBe(1);
  });

  it('单条删除与一键清空', () => {
    db.addAiMemory('polish', ['一', '二']);
    const rows = db.listAiMemory('polish');
    expect(db.deleteAiMemory(rows[0].id)).toBe(true);
    expect(db.deleteAiMemory(rows[1].id)).toBe(true);
    expect(db.listAiMemory('polish')).toEqual([]);
    db.addAiMemory('polish', ['三']);
    expect(db.clearAiMemory()).toBe(1);
    expect(db.aiMemoryCount()).toBe(0);
  });

  it('开关可以关掉；表被删（迁移失败场景）时所有读写静默降级', () => {
    db.setAiMemoryEnabled(false);
    expect(db.aiMemoryEnabled()).toBe(false);
    db.setAiMemoryEnabled(true);
    db.getRawDb().exec('drop table ai_memory');
    expect(db.listAiMemory('polish')).toEqual([]);
    expect(db.aiMemoryPage(1, 5)).toEqual({ items: [], total: 0 });
    expect(db.addAiMemory('polish', ['x'])).toBe(0);
    expect(db.deleteAiMemory(1)).toBe(false);
    expect(db.clearAiMemory()).toBe(0);
    expect(AI_MEMORY_HINT).toContain('已记住');
  });
});
