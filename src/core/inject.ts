import {
  type ContextSnapshot,
  type PreferenceEntry,
  type PreferenceScope,
  type SummarySection,
  type VerbatimEntry,
  type VerbatimKind,
} from '../types';
import { estimateTokens } from '../utils/tokens';

/**
 * 快照导入模式。
 *
 * - `inject`：Phase 2 的「仅新信息」模式——把快照当作静态、只读的背景情报，
 *   完整置入新对话的系统提示，新对话产出不回写快照。
 * - `merge`：Phase 3 的「合并」模式——把快照三层与当前对话上下文做语义层
 *   融合，偏好冲突按可配置规则（见 {@link MergePolicy}）自动裁决，产出统一上下文。
 */
export type ImportMode = 'inject' | 'merge';

/**
 * 合并模式下的冲突裁决规则。
 *
 * - `newWins`：当前对话（新信息一方）永远获胜，对应「新信息覆盖旧信息」。
 * - `snapshotWins`：历史快照永远获胜，对应「快照优先」。
 * - `timestamp`：按 `createdAt` 先后裁决（较新者胜）；时间戳相同再比 `explicit`
 *   权重（用户明示胜系统推断）；仍相同则当前对话胜（本就是更近的交互）。
 */
export type MergePolicy = 'newWins' | 'snapshotWins' | 'timestamp';

/** 导入简报的渲染结果。 */
export interface InjectBrief {
  /** 被导入的快照 id。 */
  snapshotId: string;
  /** 采用的导入模式。 */
  mode: ImportMode;
  /** 可直接注入系统提示的 Markdown 简报。 */
  brief: string;
  /** 简报的 token 估算值。 */
  tokenEstimate: number;
  /** 合并模式下被自动裁决的冲突数（inject 模式为 0）。 */
  conflictCount: number;
}

/** 各原文类别在简报中的小节标题。 */
const VERBATIM_HEADING: Record<VerbatimKind, string> = {
  decision: '决策',
  parameter: '参数',
  directive: '指令',
  code: '代码',
};

/** 各偏好作用域在简报中的标签。 */
const PREFERENCE_TAG: Record<PreferenceScope, string> = {
  style: 'style',
  role: 'role',
  constraint: 'constraint',
};

/**
 * 渲染原文条目为简报片段。
 *
 * 代码类用围栏块保留原样；其余类用要点行。每条都附带来源角色与时间，便于
 * 回溯而不必回写快照。
 *
 * @param entries - 原文条目数组。
 * @returns Markdown 片段（可能为空串）。
 */
function renderVerbatim(entries: readonly VerbatimEntry[]): string {
  if (entries.length === 0) return '';
  const byKind = new Map<VerbatimKind, VerbatimEntry[]>();
  for (const entry of entries) {
    const bucket = byKind.get(entry.kind) ?? [];
    bucket.push(entry);
    byKind.set(entry.kind, bucket);
  }

  const parts: string[] = [];
  for (const kind of ['decision', 'parameter', 'directive', 'code'] as const) {
    const group = byKind.get(kind);
    if (group && group.length > 0) {
      parts.push(`### ${VERBATIM_HEADING[kind]}`);
      for (const entry of group) {
        if (entry.kind === 'code') {
          const lang = entry.language ?? '';
          const meta = [
            entry.sourceRole,
            entry.createdAt ? new Date(entry.createdAt).toISOString().slice(0, 10) : undefined,
          ]
            .filter(Boolean)
            .join(' @ ');
          parts.push(lang ? `- **${lang}**${meta ? `（${meta}）` : ''}` : `- ${meta}`);
          parts.push(`\`\`\`${lang}`, entry.content, '```');
        } else {
          parts.push(`- ${entry.content}`);
        }
      }
    }
  }
  return parts.join('\n');
}

/**
 * 渲染结构化摘要为简报片段。
 *
 * @param sections - 摘要小节数组。
 * @returns Markdown 片段（可能为空串）。
 */
function renderSummary(sections: readonly SummarySection[]): string {
  if (sections.length === 0) return '';
  return sections
    .map((section) => {
      const bullets = section.bullets.map((bullet) => `- ${bullet}`).join('\n');
      return `### ${section.heading}\n${bullets}`;
    })
    .join('\n');
}

/**
 * 渲染偏好层为简报片段。
 *
 * @param preferences - 偏好条目数组。
 * @returns Markdown 片段（可能为空串）。
 */
function renderPreferences(preferences: readonly PreferenceEntry[]): string {
  if (preferences.length === 0) return '';
  return preferences.map((pref) => `- \`[${PREFERENCE_TAG[pref.scope]}]\` ${pref.value}`).join('\n');
}

/**
 * 把快照渲染为「仅新信息」模式下的只读背景简报。
 *
 * 简报以 HTML 注释标记来源与模式，便于宿主 / 下游 Agent 解析；正文分为三层
 * （原文 / 摘要 / 偏好），并明确声明「只读、不回写」。
 *
 * @param snapshot - 已解析的快照对象。
 * @returns Markdown 简报文本。
 */
export function buildInjectBrief(snapshot: ContextSnapshot): string {
  const { meta } = snapshot;
  const verbatim = renderVerbatim(snapshot.verbatim);
  const summary = renderSummary(snapshot.summary);
  const preferences = renderPreferences(snapshot.preferences);

  const parts = [
    `<!-- dcb:import mode=inject snapshotId=${meta.snapshotId} srcConv=${meta.sourceConversationId} -->`,
    '# 📦 对话上下文桥接 · 只读背景情报',
    '',
    `> **来源快照**：\`${meta.snapshotId}\` · **来源对话**：\`${meta.sourceConversationId}\``,
    `> **生成时间**：${meta.createdAt ? new Date(meta.createdAt).toLocaleString() : '未知'} · **token 估算**：${meta.tokenEstimate}`,
    '> ⚠️ 本简报为**只读背景情报**，新对话的所有产出都不会回写该快照。',
    '',
    '## 一、关键上下文（原文，禁止压缩）',
    verbatim || '_（无）_',
    '',
    '## 二、背景与来龙去脉（摘要）',
    summary || '_（无）_',
    '',
    '## 三、风格与约束（偏好）',
    preferences || '_（无）_',
  ];
  return parts.join('\n');
}

/** 融合过程中被自动裁决的一处冲突。 */
export interface MergeConflict {
  /** 发生冲突的层（当前仅偏好层参与自动裁决）。 */
  layer: 'preference';
  /** 冲突的偏好稳定键。 */
  key: string;
  /** 历史快照一方的取值。 */
  baseValue: string;
  /** 当前对话一方的取值。 */
  overlayValue: string;
  /** 裁决后的取值（即最终保留的一方）。 */
  resolvedValue: string;
  /** 裁决依据。 */
  reason: 'snapshotWins' | 'newWins' | 'timestamp-newer' | 'timestamp-tie-explicit' | 'timestamp-tie';
}

/** 融合结果。 */
export interface FusionResult {
  /** 融合后的统一快照（不修改入参）。 */
  snapshot: ContextSnapshot;
  /** 被自动裁决的冲突清单（供简报与审计）。 */
  conflicts: MergeConflict[];
}

/**
 * 在偏好层冲突中按规则选出获胜方。
 *
 * @param base - 历史快照偏好。
 * @param overlay - 当前对话偏好。
 * @param policy - 裁决规则。
 * @returns 获胜方及其依据。
 */
function resolvePreference(
  base: PreferenceEntry,
  overlay: PreferenceEntry,
  policy: MergePolicy,
): { entry: PreferenceEntry; reason: MergeConflict['reason'] } {
  switch (policy) {
    case 'snapshotWins':
      return { entry: base, reason: 'snapshotWins' };
    case 'newWins':
      return { entry: overlay, reason: 'newWins' };
    case 'timestamp': {
      if (overlay.createdAt > base.createdAt) return { entry: overlay, reason: 'timestamp-newer' };
      if (base.createdAt > overlay.createdAt) return { entry: base, reason: 'timestamp-newer' };
      if (overlay.explicit && !base.explicit) return { entry: overlay, reason: 'timestamp-tie-explicit' };
      if (base.explicit && !overlay.explicit) return { entry: base, reason: 'timestamp-tie-explicit' };
      return { entry: overlay, reason: 'timestamp-tie' };
    }
    default:
      return { entry: overlay, reason: 'newWins' };
  }
}

/**
 * 把两条快照融合为 Phase 3 的统一上下文。
 *
 * 融合语义：
 *
 * - 偏好层：按 `key` 去重；发生值冲突时按 `policy` 自动裁决（详见
 *   {@link resolvePreference}），冲突清单记入 `conflicts`；
 * - 原文层：取并集，按内容近似去重（折叠重复结论）；
 * - 摘要层：按 `heading` 合并小节，同一小节的要点取并集并去重。
 *
 * 原文与摘要属于「可叠加」内容，不参与冲突裁决——它们只是把更多背景并入
 * 新对话，真正的取舍留给人（新对话）判断。
 *
 * @param base - 历史快照（被引入的一方）。
 * @param overlay - 当前对话快照（新信息一方）。
 * @param policy - 冲突裁决规则，缺省 `newWins`。
 * @returns 融合结果与冲突清单。
 */
export function fuseSnapshots(
  base: ContextSnapshot,
  overlay: ContextSnapshot,
  policy: MergePolicy = 'newWins',
): FusionResult {
  const conflicts: MergeConflict[] = [];
  const prefs = new Map<string, PreferenceEntry>();
  for (const pref of base.preferences) prefs.set(pref.key, pref);
  for (const pref of overlay.preferences) {
    const prev = prefs.get(pref.key);
    if (!prev) {
      prefs.set(pref.key, pref);
    } else if (pref.value === prev.value) {
      // 同值无需裁决，保留按策略应保留的一方（用于对齐时间戳/权重）。
      prefs.set(pref.key, resolvePreference(prev, pref, policy).entry);
    } else {
      const { entry, reason } = resolvePreference(prev, pref, policy);
      conflicts.push({
        layer: 'preference',
        key: pref.key,
        baseValue: prev.value,
        overlayValue: pref.value,
        resolvedValue: entry.value,
        reason,
      });
      prefs.set(pref.key, entry);
    }
  }

  const normalize = (text: string): string => text.replace(/\s+/g, '').toLowerCase();

  const seenVerbatim = new Set(base.verbatim.map((v) => normalize(v.content)));
  const verbatim = [
    ...base.verbatim,
    ...overlay.verbatim.filter((v) => {
      const key = normalize(v.content);
      if (seenVerbatim.has(key)) return false;
      seenVerbatim.add(key);
      return true;
    }),
  ];

  const summaryMap = new Map<string, Set<string>>();
  const summary: SummarySection[] = [];
  for (const section of [...base.summary, ...overlay.summary]) {
    let target = summary.find((s) => s.heading === section.heading);
    const bullets = summaryMap.get(section.heading) ?? new Set<string>();
    if (!target) {
      target = { heading: section.heading, bullets: [] };
      summary.push(target);
      summaryMap.set(section.heading, bullets);
    }
    for (const bullet of section.bullets) {
      const key = normalize(bullet);
      if (!bullets.has(key)) {
        bullets.add(key);
        target.bullets.push(bullet);
      }
    }
  }

  return {
    snapshot: {
      meta: {
        ...base.meta,
        title: `融合上下文：${base.meta.title}`,
        description: `快照 ${base.meta.snapshotId} 与当前对话按策略「${policy}」合并`,
        tags: [...new Set([...base.meta.tags, ...overlay.meta.tags])],
        tokenEstimate: verbatim.length + summary.length + prefs.size,
      },
      verbatim,
      summary,
      preferences: [...prefs.values()],
    },
    conflicts,
  };
}

/**
 * 把融合结果渲染为「合并」模式的导入简报。
 *
 * @param base - 历史快照（提供 baseSnapshot id）。
 * @param overlay - 当前对话快照（提供 overlayConv id）。
 * @param fusion - 融合结果（含冲突清单）。
 * @param policy - 采用的裁决规则，用于头部标记与说明。
 * @returns Markdown 简报文本。
 */
function renderMergeBrief(
  base: ContextSnapshot,
  overlay: ContextSnapshot,
  fusion: FusionResult,
  policy: MergePolicy,
): string {
  const { snapshot, conflicts } = fusion;
  const verbatim = renderVerbatim(snapshot.verbatim);
  const summary = renderSummary(snapshot.summary);
  const preferences = renderPreferences(snapshot.preferences);

  const conflictLines =
    conflicts.length === 0
      ? '> 偏好层无键冲突，无需裁决。'
      : [
          '> | 键 | 历史快照 | 当前对话 | 裁决结果 | 依据 |',
          '> | --- | --- | --- | --- | --- |',
          ...conflicts.map(
            (c) =>
              `> | \`${c.key}\` | ${c.baseValue} | ${c.overlayValue} | **${c.resolvedValue}** | ${c.reason} |`,
          ),
        ].join('\n');

  return [
    `<!-- dcb:import mode=merge baseSnapshot=${base.meta.snapshotId} overlayConv=${overlay.meta.sourceConversationId} policy=${policy} -->`,
    '# 🔗 对话上下文桥接 · 融合上下文（Phase 3）',
    '',
    `> **裁决规则**：\`${policy}\`。本节列出被自动裁决的偏好冲突，供你复核——如需人工覆盖，直接在新对话里下指令即可。`,
    '',
    '## 〇、冲突裁决报告',
    conflictLines,
    '',
    '## 一、关键上下文（原文，并集去重）',
    verbatim || '_（无）_',
    '',
    '## 二、背景与来龙去脉（摘要，合并去重）',
    summary || '_（无）_',
    '',
    '## 三、风格与约束（偏好，键合并 + 裁决）',
    preferences || '_（无）_',
  ].join('\n');
}

/**
 * 把两条快照融合为「合并」模式的导入简报。
 *
 * @param base - 历史快照。
 * @param overlay - 当前对话快照。
 * @param policy - 冲突裁决规则，缺省 `newWins`。
 * @returns Markdown 简报文本。
 */
export function buildMergeBrief(
  base: ContextSnapshot,
  overlay: ContextSnapshot,
  policy: MergePolicy = 'newWins',
): string {
  return renderMergeBrief(base, overlay, fuseSnapshots(base, overlay, policy), policy);
}

/**
 * 统一入口：根据模式渲染导入简报。
 *
 * @param snapshot - 被引入的历史快照。
 * @param mode - 导入模式，`merge` 需额外提供 `current` 与 `policy`。
 * @param current - `merge` 模式下的当前对话快照（缺省时退化为 `inject`）。
 * @param policy - `merge` 模式下的冲突裁决规则，缺省 `newWins`。
 * @returns 导入简报结果。
 */
export function buildBrief(
  snapshot: ContextSnapshot,
  mode: ImportMode,
  current?: ContextSnapshot,
  policy?: MergePolicy,
): InjectBrief {
  const useMerge = mode === 'merge' && current !== undefined;
  if (!useMerge) {
    return {
      snapshotId: snapshot.meta.snapshotId,
      mode: 'inject',
      brief: buildInjectBrief(snapshot),
      tokenEstimate: estimateTokens(buildInjectBrief(snapshot)),
      conflictCount: 0,
    };
  }
  const effective = policy ?? 'newWins';
  const fusion = fuseSnapshots(snapshot, current, effective);
  const brief = renderMergeBrief(snapshot, current, fusion, effective);
  return {
    snapshotId: snapshot.meta.snapshotId,
    mode: 'merge',
    brief,
    tokenEstimate: estimateTokens(brief),
    conflictCount: fusion.conflicts.length,
  };
}
