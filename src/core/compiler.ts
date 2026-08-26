import {
  SNAPSHOT_SCHEMA_VERSION,
  type BudgetReport,
  type ContextSnapshot,
  type ConversationMessage,
  type PreferenceEntry,
  type VerbatimEntry,
} from '../types';
import { createEntryId, createSnapshotId } from '../utils/id';
import { applyTokenBudget, estimateSnapshotTokens } from './budget';
import { classifyConversation, type Classification } from './classifier';
import { serializeSnapshot } from './serializer';
import { createExtractiveSummarizer, type Summarizer } from './summarize';

/** `/compile` 的输入参数。 */
export interface CompileOptions {
  /** 来源对话 id。 */
  conversationId: string;
  /** 待编译的对话消息。 */
  messages: readonly ConversationMessage[];
  /** 快照标题；缺省时从首条用户消息推导。 */
  title?: string;
  /** 快照描述；缺省时从摘要首条要点推导。 */
  description?: string;
  /** 标签。 */
  tags?: readonly string[];
  /** token 上限，默认 4096。 */
  maxTokens?: number;
  /** 每个摘要小节保留的最大要点数，默认 6。 */
  maxBulletsPerSection?: number;
  /** 自定义摘要器；缺省使用内置抽取式摘要器。 */
  summarize?: Summarizer;
  /** 生成时间（epoch 毫秒），注入以便测试可复现。 */
  now?: number;
}

/** `/compile` 的产出。 */
export interface CompileResult {
  /** 编译后的快照对象。 */
  snapshot: ContextSnapshot;
  /** 快照的 Markdown 文档（已写入正确的 checksum）。 */
  markdown: string;
  /** token 预算裁剪报告。 */
  report: BudgetReport;
}

/** 默认 token 预算。 */
export const DEFAULT_MAX_TOKENS = 4096;

/** 标题的最大显示长度。 */
const TITLE_MAX_LENGTH = 48;

/**
 * 归一化文本用于去重比较（压缩空白、去除标点差异）。
 *
 * @param text - 原始文本。
 * @returns 归一化结果。
 */
function dedupeKey(text: string): string {
  return text.replace(/\s+/g, '').replace(/[。，、；：！？.,;:!?]/g, '').toLowerCase();
}

/**
 * 从分类结果构造原文层条目（去重、按时间升序）。
 *
 * @param classifications - 全量分类结果。
 * @returns 原文条目数组。
 */
function buildVerbatimLayer(classifications: readonly Classification[]): VerbatimEntry[] {
  const seen = new Set<string>();
  const entries: VerbatimEntry[] = [];

  classifications
    .filter((item) => item.layer === 'verbatim')
    .forEach((item) => {
      const key = `${item.kind}:${dedupeKey(item.text)}`;
      if (seen.has(key)) return;
      seen.add(key);
      entries.push({
        id: createEntryId('v', entries.length + 1),
        sourceMessageId: item.source.id,
        sourceRole: item.source.role,
        kind: item.kind ?? 'decision',
        language: item.language,
        content: item.text,
        createdAt: item.source.createdAt,
      });
    });

  return entries.sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * 从分类结果构造偏好层条目。
 *
 * 同一 `key` 只保留**最新**的一条：这与 Phase 3 融合引擎的默认裁决规则
 * （新信息覆盖旧信息）保持一致，避免快照内部自相矛盾。
 *
 * @param classifications - 全量分类结果。
 * @returns 偏好条目数组。
 */
function buildPreferenceLayer(classifications: readonly Classification[]): PreferenceEntry[] {
  const latest = new Map<string, PreferenceEntry>();

  classifications
    .filter((item) => item.layer === 'preference' && item.key && item.scope)
    .forEach((item) => {
      const key = item.key as string;
      const candidate: PreferenceEntry = {
        key,
        value: item.text,
        scope: item.scope!,
        // 用户亲口说的视为明示，助手复述的视为推断。
        explicit: item.source.role === 'user',
        createdAt: item.source.createdAt,
      };
      const existing = latest.get(key);
      if (!existing || candidate.createdAt >= existing.createdAt) latest.set(key, candidate);
    });

  return [...latest.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * 推导快照标题。
 *
 * @param messages - 对话消息。
 * @param fallback - 无法推导时的兜底标题。
 * @returns 标题文本。
 */
function deriveTitle(messages: readonly ConversationMessage[], fallback: string): string {
  const firstUser = [...messages]
    .sort((a, b) => a.createdAt - b.createdAt)
    .find((message) => message.role === 'user' && message.content.trim().length > 0);
  if (!firstUser) return fallback;
  const line = firstUser.content
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!line) return fallback;
  return line.length > TITLE_MAX_LENGTH ? `${line.slice(0, TITLE_MAX_LENGTH)}…` : line;
}

/**
 * 把一段对话编译为三层结构快照（`/compile` 的核心实现）。
 *
 * 流程：分类 → 分层构造 → 摘要压缩 → token 预算裁剪 → 序列化。
 * 整个过程是**纯函数式**的：不写磁盘、不改动入参，便于单测与预览确认。
 *
 * @param options - 编译参数，见 {@link CompileOptions}。
 * @returns 快照对象、Markdown 文档与裁剪报告。
 */
export async function compileSnapshot(options: CompileOptions): Promise<CompileResult> {
  const now = options.now ?? Date.now();
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const summarize = options.summarize ?? createExtractiveSummarizer();

  const classifications = classifyConversation(options.messages);
  const verbatim = buildVerbatimLayer(classifications);
  const preferences = buildPreferenceLayer(classifications);
  const summary = await summarize({
    candidates: classifications.filter((item) => item.layer === 'summary'),
    maxBulletsPerSection: options.maxBulletsPerSection ?? 6,
  });

  const title = options.title?.trim() || deriveTitle(options.messages, '未命名对话快照');
  const description =
    options.description?.trim() || summary[0]?.bullets[0] || '由 DialogueContextBridge 自动编译。';

  const draft: ContextSnapshot = {
    meta: {
      snapshotId: createSnapshotId(now),
      sourceConversationId: options.conversationId,
      title,
      description,
      tags: [...(options.tags ?? [])],
      createdAt: now,
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      tokenEstimate: 0,
      encrypted: false,
      checksum: '',
    },
    verbatim,
    summary,
    preferences,
  };

  const { snapshot: trimmed, report } = applyTokenBudget(draft, maxTokens);
  const finalSnapshot: ContextSnapshot = {
    ...trimmed,
    meta: { ...trimmed.meta, tokenEstimate: estimateSnapshotTokens(trimmed) },
  };

  const { markdown, checksum } = serializeSnapshot(finalSnapshot);
  return {
    snapshot: { ...finalSnapshot, meta: { ...finalSnapshot.meta, checksum } },
    markdown,
    report,
  };
}
