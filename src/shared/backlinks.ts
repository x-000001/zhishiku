/* ------------------------------------------------------------------ */
/* 智能上下文关联（0.12.0 阶段3）的纯逻辑                              */
/*                                                                     */
/* 作用：从「当前笔记」的标题 + 正文里提取关键词，再交给主进程做 FTS5  */
/* 相关检索。关键词必须是「有意义的二元词/英文词」——提取前先过停用词，  */
/* 否则「的 / 了 / 是 / 这个 / 因为」这类词会把所有笔记都搜出来。        */
/* 纯函数、不碰 DOM / DB，可直接单测（tests/unit/backlinks.test.ts）。   */
/* ------------------------------------------------------------------ */

/** 一次最多给 FTS5 几个关键词（关键词越多 OR 越长，排序越容易被噪声带偏）。 */
export const BACKLINK_MAX_TERMS = 10;

/** 中文单字停用词：含这些字的二元词直接丢掉（「的是」「这个」「工作」不受影响）。 */
export const BACKLINK_STOP_CHARS = new Set<string>([
  '的', '了', '是', '在', '和', '与', '或', '也', '就', '都', '而', '又', '被', '把',
  '让', '给', '对', '从', '到', '于', '为', '以', '之', '其', '这', '那', '我', '你',
  '他', '她', '它', '个', '些', '很', '更', '最', '再', '才', '只', '便', '则', '者',
  '等', '有', '无', '不', '没', '太', '常', '中', '内', '外', '上', '下', '大', '小',
  '多', '少', '好', '可', '能', '要', '会', '该', '吗', '呢', '吧', '啊', '呀', '嘛',
  '哦', '嗯', '着', '过', '地', '得', '里', '如', '若', '并', '且', '即', '则', '所',
  '第', '每', '各', '某', '该', '咱', '俺', '您', '它', '们', '么', '什', '怎'
]);

/** 多字停用词（中文功能词 + 英文常见词）。命中的词整条丢弃。 */
export const BACKLINK_STOPWORDS: string[] = [
  '这个', '那个', '我们', '你们', '他们', '她们', '它们', '自己', '什么', '怎么', '如何',
  '因为', '所以', '但是', '如果', '虽然', '然后', '而且', '并且', '以及', '这些', '那些',
  '一个', '一些', '一样', '这样', '那样', '已经', '可以', '可能', '应该', '需要', '没有',
  '不是', '就是', '还是', '只是', '还有', '时候', '现在', '之后', '之前', '里面', '上面',
  '下面', '非常', '特别', '主要', '一定', '大家', '东西', '事情', '通过', '进行', '使用',
  'the', 'and', 'for', 'are', 'was', 'were', 'been', 'being', 'with', 'from', 'this',
  'that', 'these', 'those', 'its', 'not', 'but', 'then', 'than', 'such', 'can', 'will',
  'would', 'should', 'could', 'may', 'might', 'have', 'has', 'had', 'does', 'did', 'you',
  'your', 'our', 'their', 'they', 'them', 'his', 'her', 'she', 'him', 'all', 'any'
];

export interface BacklinkSource {
  title: string;
  text: string;
}

/** 去掉 Markdown 标记 / 链接 / 代码块，避免把 `https://…` 或 ``` 里的符号当关键词。 */
function stripMarkup(text: string): string {
  return String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[#>*_~|]/g, ' ');
}

/** 候选词：中文连续片段取 2 字滑窗（与 FTS5 的逐字 token 对齐），英文取长度 ≥2 的单词。 */
function candidateTerms(text: string): string[] {
  const plain = stripMarkup(text);
  const out: string[] = [];
  const cjkRuns = plain.match(/[\u4e00-\u9fa5]{2,}/g) ?? [];
  for (const run of cjkRuns) {
    for (let i = 0; i + 2 <= run.length; i += 1) out.push(run.slice(i, i + 2));
  }
  const latin = plain.match(/[A-Za-z][A-Za-z0-9_'-]{1,}/g) ?? [];
  for (const word of latin) out.push(word.toLowerCase());
  return out;
}

function isUsableTerm(term: string): boolean {
  if (term.length < 2) return false;
  if (/^[0-9]+$/.test(term)) return false;
  if (BACKLINK_STOPWORDS.indexOf(term) >= 0) return false;
  if (/^[\u4e00-\u9fa5]{2}$/.test(term)) {
    for (const ch of term) {
      if (BACKLINK_STOP_CHARS.has(ch)) return false;
    }
  }
  return true;
}

/**
 * 提取关键词：标题里的词权重 3、正文里的词权重 1；按权重 → 词长 → 首次出现顺序排序。
 * 停用词（单字 + 多字）在进入排序前就被过滤掉。
 */
export function extractBacklinkKeywords(source: BacklinkSource, limit = BACKLINK_MAX_TERMS): string[] {
  const weights = new Map<string, number>();
  const firstSeen = new Map<string, number>();
  let order = 0;

  const add = (raw: string, weight: number): void => {
    const term = raw.trim().toLowerCase();
    if (!isUsableTerm(term)) return;
    if (!weights.has(term)) firstSeen.set(term, order++);
    weights.set(term, (weights.get(term) ?? 0) + weight);
  };

  for (const term of candidateTerms(source.title)) add(term, 3);
  for (const term of candidateTerms(source.text)) add(term, 1);

  const capped = Math.min(Math.max(limit, 1), BACKLINK_MAX_TERMS * 2);
  return [...weights.keys()]
    .sort((a, b) => {
      const diff = (weights.get(b) ?? 0) - (weights.get(a) ?? 0);
      if (diff !== 0) return diff;
      if (b.length !== a.length) return b.length - a.length;
      return (firstSeen.get(a) ?? 0) - (firstSeen.get(b) ?? 0);
    })
    .slice(0, capped);
}
