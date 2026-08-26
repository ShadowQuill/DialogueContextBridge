import type { ConversationMessage, PreferenceScope, VerbatimKind } from '../types';
import {
  FENCED_CODE_PATTERN,
  NOISE_PATTERN,
  PREFERENCE_RULES,
  SHELL_LINE_PATTERN,
  VERBATIM_RULES,
} from './lexicon';

/** 分类结果：一条消息片段被归入的层与语义标签。 */
export interface Classification {
  /** 归属层。 */
  layer: 'verbatim' | 'summary' | 'preference';
  /** 片段文本（已 trim）。 */
  text: string;
  /** 原文类别（`layer === 'verbatim'` 时有值）。 */
  kind?: VerbatimKind;
  /** 代码语言（`kind === 'code'` 时有值）。 */
  language?: string;
  /** 偏好键（`layer === 'preference'` 时有值）。 */
  key?: string;
  /** 偏好作用域（`layer === 'preference'` 时有值）。 */
  scope?: PreferenceScope;
  /** 来源消息。 */
  source: ConversationMessage;
}

/** 句子/片段切分：按换行与中英文句末标点切开，保留标点。 */
const SEGMENT_PATTERN = /[^\n。！？；!?;]+[。！？；!?;]?/g;

/**
 * 把一段纯文本切分为语义片段。
 *
 * @param text - 输入文本。
 * @returns 去空后的片段数组。
 */
export function splitSegments(text: string): string[] {
  return (text.match(SEGMENT_PATTERN) ?? [])
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

/**
 * 判断片段是否为可忽略的噪声（纯寒暄、纯确认）。
 *
 * @param text - 片段文本。
 * @returns 是噪声则返回 true。
 */
export function isNoise(text: string): boolean {
  return NOISE_PATTERN.test(text);
}

/**
 * 抽取并剥离消息中的围栏代码块。
 *
 * @param content - 消息原文。
 * @returns `blocks` 为代码块列表，`rest` 为剥离代码块后的散文文本。
 */
export function extractCodeBlocks(content: string): {
  blocks: Array<{ language?: string; code: string }>;
  rest: string;
} {
  const blocks: Array<{ language?: string; code: string }> = [];
  const rest = content.replace(FENCED_CODE_PATTERN, (_match, lang: string, code: string) => {
    const trimmed = code.replace(/\s+$/, '');
    if (trimmed.trim().length > 0) {
      blocks.push({ language: lang?.trim() || undefined, code: trimmed });
    }
    return '\n';
  });
  return { blocks, rest };
}

/**
 * 匹配偏好规则。
 *
 * @param text - 片段文本。
 * @returns 命中的规则，未命中返回 undefined。
 */
function matchPreference(text: string): { key: string; scope: PreferenceScope } | undefined {
  const hit = PREFERENCE_RULES.find((rule) => rule.pattern.test(text));
  return hit ? { key: hit.key, scope: hit.scope } : undefined;
}

/**
 * 匹配原文规则，取权重最高的一条。
 *
 * @param text - 片段文本。
 * @returns 命中的原文类别，未命中返回 undefined。
 */
function matchVerbatimKind(text: string): VerbatimKind | undefined {
  const hits = VERBATIM_RULES.filter((rule) => rule.pattern.test(text));
  if (hits.length === 0) return undefined;
  return hits.reduce((best, rule) => (rule.weight > best.weight ? rule : best)).kind;
}

/**
 * 对单条对话消息做三层分类。
 *
 * 分类策略（Phase 1，纯规则）：
 * - 围栏代码块 / 命令行 → 原文层 `code`；
 * - 命中偏好词典 → 偏好层（用户消息优先视为明示偏好）；
 * - 命中硬性指令 / 决策 / 参数词典 → 原文层对应类别；
 * - 其余散文 → 摘要层候选。
 *
 * 该函数是纯函数，不做去重与预算控制，便于单测与后续替换为模型驱动实现。
 *
 * @param message - 待分类的对话消息。
 * @returns 分类结果数组，顺序与原文出现顺序一致。
 */
export function classifyMessage(message: ConversationMessage): Classification[] {
  const result: Classification[] = [];
  if (!message.content?.trim()) return result;

  const { blocks, rest } = extractCodeBlocks(message.content);

  blocks.forEach((block) => {
    result.push({
      layer: 'verbatim',
      kind: 'code',
      language: block.language,
      text: block.code,
      source: message,
    });
  });

  splitSegments(rest).forEach((segment) => {
    if (isNoise(segment)) return;

    if (SHELL_LINE_PATTERN.test(segment)) {
      result.push({ layer: 'verbatim', kind: 'code', language: 'bash', text: segment, source: message });
      return;
    }

    const preference = matchPreference(segment);
    if (preference) {
      result.push({
        layer: 'preference',
        text: segment,
        key: preference.key,
        scope: preference.scope,
        source: message,
      });
      return;
    }

    const kind = matchVerbatimKind(segment);
    if (kind) {
      result.push({ layer: 'verbatim', kind, text: segment, source: message });
      return;
    }

    result.push({ layer: 'summary', text: segment, source: message });
  });

  return result;
}

/**
 * 批量分类整段对话。
 *
 * @param messages - 对话消息列表（任意顺序）。
 * @returns 按消息时间升序排列的分类结果。
 */
export function classifyConversation(messages: readonly ConversationMessage[]): Classification[] {
  return [...messages]
    .sort((a, b) => a.createdAt - b.createdAt)
    .flatMap((message) => classifyMessage(message));
}
