import type { SummarySection } from '../types';
import type { Classification } from './classifier';
import { SUMMARY_BUCKETS } from './lexicon';

/** 摘要器输入。 */
export interface SummarizeInput {
  /** 摘要层候选片段（已由分类器筛除原文与偏好）。 */
  candidates: readonly Classification[];
  /** 每个小节最多保留的要点数。 */
  maxBulletsPerSection: number;
}

/**
 * 摘要器：把摘要层候选片段压缩成结构化小节。
 *
 * 设计为可注入的函数类型，宿主可传入基于 LLM 的实现以获得更高质量的摘要；
 * 插件内置 {@link createExtractiveSummarizer} 作为零依赖、可离线的默认实现。
 */
export type Summarizer = (input: SummarizeInput) => Promise<SummarySection[]>;

/** 通用停用词，参与关键词权重计算时剔除。 */
const STOP_WORDS = new Set([
  '的', '了', '和', '是', '在', '我', '我们', '你', '他', '它', '这', '那', '一个', '可以', '需要',
  'the', 'a', 'an', 'and', 'or', 'to', 'of', 'is', 'are', 'be', 'we', 'you', 'it', 'this', 'that',
]);

/**
 * 提取片段中的关键词（中文按 2-gram，英文按单词）。
 *
 * @param text - 输入文本。
 * @returns 关键词数组。
 */
function keywordsOf(text: string): string[] {
  const latin = text.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) ?? [];
  const cjk = text.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
  const bigrams = cjk.flatMap((run) =>
    Array.from({ length: Math.max(run.length - 1, 0) }, (_, i) => run.slice(i, i + 2)),
  );
  return [...latin, ...bigrams].filter((word) => !STOP_WORDS.has(word));
}

/**
 * 为片段选择所属小节。
 *
 * @param text - 片段文本。
 * @returns 小节标题。
 */
function bucketOf(text: string): string {
  const hit = SUMMARY_BUCKETS.find((bucket) => bucket.pattern?.test(text));
  return (hit ?? SUMMARY_BUCKETS[SUMMARY_BUCKETS.length - 1]).heading;
}

/**
 * 归一化要点文本：压缩空白、去掉行首列表符号、补齐句末标点。
 *
 * @param text - 原始片段。
 * @returns 适合作为要点呈现的单行文本。
 */
function normalizeBullet(text: string): string {
  const cleaned = text
    .replace(/\s+/g, ' ')
    .replace(/^(?:[-*+]|\d+[.)])\s*/, '')
    .replace(/^#+\s*/, '')
    .trim();
  return /[。！？.!?;；]$/.test(cleaned) ? cleaned : `${cleaned}。`;
}

/**
 * 创建内置的抽取式摘要器。
 *
 * 算法：
 * 1. 按 {@link SUMMARY_BUCKETS} 把候选片段分桶；
 * 2. 统计全局关键词词频（TF），以「片段内关键词 TF 之和 / 片段长度平方根」为
 *    信息密度得分，同时对靠后出现的片段给出轻微时间加权（近期结论更重要）；
 * 3. 每桶取 Top-N，再按原始出现顺序还原，保证叙述的时间逻辑；
 * 4. 同桶内做近似去重（归一化文本完全相同者只留一条）。
 *
 * 全过程无网络、无模型依赖，可在单测中确定性复现。
 *
 * @param options - 可选参数。
 * @param options.recencyWeight - 时间加权系数（0 表示不加权），默认 0.2。
 * @param options.minLength - 参与摘要的最短片段长度，默认 6。
 * @returns 摘要器函数。
 */
export function createExtractiveSummarizer(
  options: { recencyWeight?: number; minLength?: number } = {},
): Summarizer {
  const recencyWeight = options.recencyWeight ?? 0.2;
  const minLength = options.minLength ?? 6;

  return async ({ candidates, maxBulletsPerSection }) => {
    const usable = candidates.filter((item) => item.text.trim().length >= minLength);
    if (usable.length === 0) return [];

    const frequency = new Map<string, number>();
    usable.forEach((item) => {
      keywordsOf(item.text).forEach((word) => {
        frequency.set(word, (frequency.get(word) ?? 0) + 1);
      });
    });

    const scored = usable.map((item, index) => {
      const words = keywordsOf(item.text);
      const density =
        words.reduce((sum, word) => sum + (frequency.get(word) ?? 0), 0) /
        Math.sqrt(Math.max(item.text.length, 1));
      const recency = 1 + (recencyWeight * index) / usable.length;
      return { item, index, score: density * recency, bucket: bucketOf(item.text) };
    });

    return SUMMARY_BUCKETS.map(({ heading }) => {
      const seen = new Set<string>();
      const bullets = scored
        .filter((entry) => entry.bucket === heading)
        .sort((a, b) => b.score - a.score)
        .slice(0, maxBulletsPerSection)
        .sort((a, b) => a.index - b.index)
        .map((entry) => normalizeBullet(entry.item.text))
        .filter((bullet) => {
          if (seen.has(bullet)) return false;
          seen.add(bullet);
          return true;
        });
      return { heading, bullets };
    }).filter((section) => section.bullets.length > 0);
  };
}
