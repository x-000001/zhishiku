/**
 * 「GitHub 项目 → 收集箱条目」的提炼流水线（纯逻辑，不 import electron）。
 *
 * 分两层：
 * - `RepoExtractLimiter`：主进程级并发闸，同时最多 2 个 AI 提炼（需求里的防连点/防雪崩）；
 * - `extractRepoNote()`：把 README 交给 AI → 解析三段 → 拼成 YAML + Markdown；
 *   AI 失败不丢数据：降级成「基础信息 + 状态 ai_failed」，前端可以重试提炼。
 */
import {
  GITHUB_MAX_EXTRACT_JOBS,
  buildRepoNoteMarkdown,
  type GithubRepoInfo,
  type RepoExtractMeta,
  type RepoExtractStatus,
  parseRepoNoteMarkdown
} from '../shared/github';
import { buildRepoExtractMessages, parseRepoExtract, REPO_EXTRACT_MAX_TOKENS } from './ai';
import type { AiMessage } from './ai';
import { escapeHtml } from '../shared/html';
import { renderMarkdown } from '../shared/markdown';

/** AI 侧的最小依赖：单测注入假 chat，不联网也不碰 Electron。 */
export interface RepoExtractDeps {
  chat(messages: AiMessage[], options: { maxTokens: number }): Promise<string>;
  now?(): Date;
}

/** 主进程里只造一个实例（见 ipc/github.ts），保证闸门是全局的。 */
export class RepoExtractLimiter {
  private active = 0;

  constructor(private readonly max = GITHUB_MAX_EXTRACT_JOBS) {}

  get running(): number {
    return this.active;
  }

  /**
   * 占一个名额；满了直接抛中文错误（IPC 会原样带给前端 toast）。
   * 返回值是释放函数，调用方必须放在 finally 里。
   */
  acquire(): () => void {
    if (this.active >= this.max) {
      throw new Error(`同时最多提炼 ${this.max} 个项目，请等待当前任务完成`);
    }
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active = Math.max(0, this.active - 1);
    };
  }
}

/** AI 不可用 / 失败时的降级文案：只用仓库元信息，绝不编造 README 里没有的东西。 */
function fallbackDraft(info: GithubRepoInfo): {
  summary: string;
  highlights: string[];
  scenes: string;
} {
  const summary = (info.description ?? '').trim() || `README 未提及简介，主语言 ${info.language ?? '未知'}。`;
  const highlights = (info.topics.length ? info.topics : []).slice(0, 5);
  return {
    summary: summary.length > 100 ? summary.slice(0, 100) + '…' : summary,
    highlights: highlights.map((item) => (item.length > 30 ? item.slice(0, 30) + '…' : item)),
    scenes: 'README 未提及适用场景（AI 提炼失败，可点“重试提炼”）。'
  };
}

export interface ExtractOutcome {
  status: ExtractRepoStatus;
  markdown: string;
  meta: RepoExtractMeta;
}

type ExtractRepoStatus = Extract<RepoExtractStatus, 'done' | 'ai_failed' | 'link_only'>;

/** 仅保存链接：元信息 + 简介，不调用 AI。 */
export function buildLinkOnlyNote(info: GithubRepoInfo): ExtractOutcome {
  const draft = fallbackDraft(info);
  return {
    status: 'link_only',
    markdown: buildRepoNoteMarkdown({
      repo: info.repo,
      url: info.htmlUrl,
      stars: info.stars,
      language: info.language,
      topics: info.topics,
      summary: draft.summary,
      highlights: draft.highlights,
      scenes: '(仅保存了链接，还没有做 AI 提炼。可以点“重试提炼”补上。)'
    }),
    meta: {
      summary: draft.summary,
      highlights: draft.highlights,
      scenes: '',
      topics: info.topics,
      language: info.language,
      stars: info.stars,
      source: 'fallback',
      readmeChars: info.readme?.length ?? 0
    }
  };
}

/**
 * 调 AI 提炼：成功 → done；任何失败 → ai_failed + 降级 Markdown（不丢条目）。
 * 注意：这里不负责并发闸（由调用方用 {@link RepoExtractLimiter} 包起来）。
 */
export async function extractRepoNote(
  deps: RepoExtractDeps,
  info: GithubRepoInfo
): Promise<ExtractOutcome> {
  const now = deps.now ?? (() => new Date());
  try {
    const reply = await deps.chat(buildRepoExtractMessages(info), {
      maxTokens: REPO_EXTRACT_MAX_TOKENS
    });
    const draft = parseRepoExtract(reply);
    const markdown = buildRepoNoteMarkdown({
      repo: info.repo,
      url: info.htmlUrl,
      stars: info.stars,
      language: info.language,
      topics: info.topics,
      summary: draft.summary,
      highlights: draft.highlights,
      scenes: draft.scenes
    });
    return {
      status: 'done',
      markdown,
      meta: {
        summary: draft.summary,
        highlights: draft.highlights,
        scenes: draft.scenes,
        topics: info.topics,
        language: info.language,
        stars: info.stars,
        source: 'ai',
        readmeChars: info.readme?.length ?? 0,
        extractedAt: now().toISOString()
      }
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err ?? '');
    const draft = fallbackDraft(info);
    return {
      status: 'ai_failed',
      markdown: buildRepoNoteMarkdown({
        repo: info.repo,
        url: info.htmlUrl,
        stars: info.stars,
        language: info.language,
        topics: info.topics,
        summary: draft.summary,
        highlights: draft.highlights,
        scenes: draft.scenes
      }),
      meta: {
        summary: draft.summary,
        highlights: draft.highlights,
        scenes: draft.scenes,
        topics: info.topics,
        language: info.language,
        stars: info.stars,
        source: 'fallback',
        error: message.slice(0, 300) || 'AI 提炼失败',
        readmeChars: info.readme?.length ?? 0,
        extractedAt: now().toISOString()
      }
    };
  }
}

/**
 * 转成知识库笔记时的富文本：frontmatter 变成一行元信息，正文走项目自带的
 * Markdown 渲染器（与「预览」完全一致），避免另写一套 HTML 生成。
 * 注意：YAML 原文在 content（plain）里完整保留，这里只负责「看起来好看」。
 */
export function renderRepoNoteHtml(markdown: string): string {
  const parsed = parseRepoNoteMarkdown(markdown);
  const body = markdown.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
  const meta = [
    '<p><b>' + escapeHtml(parsed.repo || 'GitHub 项目') + '</b>',
    ' · ⭐ ' + Math.max(0, Math.round(parsed.stars)),
    ' · ' + escapeHtml(parsed.language || '未知语言'),
    parsed.topics.length ? ' · ' + escapeHtml(parsed.topics.slice(0, 6).join(' / ')) : '',
    '</p>'
  ].join('');
  return meta + renderMarkdown(body);
}
