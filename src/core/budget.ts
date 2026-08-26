import type { BudgetReport, ContextSnapshot, VerbatimKind } from '../types';
import { estimateTokens } from '../utils/tokens';

/**
 * 原文条目的保留优先级（数值越大越先保留）。
 *
 * 硬性指令与决策结论是「移植后立刻会被违反」的信息，因此优先级最高；
 * 代码次之；技术参数通常也在摘要中被提及，故最低。
 */
const KIND_PRIORITY: Record<VerbatimKind, number> = {
  directive: 40,
  decision: 30,
  code: 20,
  parameter: 10,
};

/** 偏好层永远优先保留，但仍设一个占比上限，避免偏好挤爆预算。 */
const PREFERENCE_BUDGET_RATIO = 0.2;

/**
 * 估算快照三层内容的 token 数（不含 Schema 头，头部开销固定且很小）。
 *
 * @param snapshot - 快照对象。
 * @returns token 估算值。
 */
export function estimateSnapshotTokens(snapshot: ContextSnapshot): number {
  const verbatim = snapshot.verbatim.reduce((sum, entry) => sum + estimateTokens(entry.content), 0);
  const summary = snapshot.summary.reduce(
    (sum, section) =>
      sum + estimateTokens(section.heading) + section.bullets.reduce((s, b) => s + estimateTokens(b), 0),
    0,
  );
  const preferences = snapshot.preferences.reduce(
    (sum, entry) => sum + estimateTokens(`${entry.key} ${entry.value}`),
    0,
  );
  return verbatim + summary + preferences;
}

/**
 * 按 token 预算裁剪快照。
 *
 * 裁剪顺序遵循「信息价值密度」原则：
 * 1. 偏好层最先入选（但不超过 {@link PREFERENCE_BUDGET_RATIO} 的预算占比）；
 * 2. 原文层按 {@link KIND_PRIORITY} 与时间倒序入选，单条超预算则整体丢弃
 *    （原文层禁止截断，截断的代码比没有代码更危险）；
 * 3. 摘要层用剩余预算逐要点填充，可按小节部分保留。
 *
 * @param snapshot - 待裁剪的快照（不会被修改）。
 * @param budget - token 上限。
 * @returns 裁剪后的新快照与裁剪报告。
 */
export function applyTokenBudget(
  snapshot: ContextSnapshot,
  budget: number,
): { snapshot: ContextSnapshot; report: BudgetReport } {
  if (budget <= 0) {
    return {
      snapshot: { ...snapshot, verbatim: [], summary: [], preferences: [] },
      report: {
        droppedVerbatim: snapshot.verbatim.length,
        droppedBullets: snapshot.summary.reduce((sum, s) => sum + s.bullets.length, 0),
        droppedPreferences: snapshot.preferences.length,
        tokenEstimate: 0,
        budget,
      },
    };
  }

  let used = 0;

  const preferenceCap = Math.floor(budget * PREFERENCE_BUDGET_RATIO);
  const preferences: ContextSnapshot['preferences'] = [];
  snapshot.preferences.forEach((entry) => {
    const cost = estimateTokens(`${entry.key} ${entry.value}`);
    if (used + cost > preferenceCap) return;
    used += cost;
    preferences.push(entry);
  });

  const verbatim = [...snapshot.verbatim]
    .sort((a, b) => KIND_PRIORITY[b.kind] - KIND_PRIORITY[a.kind] || b.createdAt - a.createdAt)
    .filter((entry) => {
      const cost = estimateTokens(entry.content);
      if (used + cost > budget) return false;
      used += cost;
      return true;
    })
    .sort((a, b) => a.createdAt - b.createdAt);

  let droppedBullets = 0;
  const summary = snapshot.summary
    .map((section) => {
      const headingCost = estimateTokens(section.heading);
      if (used + headingCost > budget) {
        droppedBullets += section.bullets.length;
        return { heading: section.heading, bullets: [] };
      }
      const bullets: string[] = [];
      let headingCounted = false;
      section.bullets.forEach((bullet) => {
        const cost = estimateTokens(bullet) + (headingCounted ? 0 : headingCost);
        if (used + cost > budget) {
          droppedBullets += 1;
          return;
        }
        used += cost;
        headingCounted = true;
        bullets.push(bullet);
      });
      return { heading: section.heading, bullets };
    })
    .filter((section) => section.bullets.length > 0);

  return {
    snapshot: { ...snapshot, verbatim, summary, preferences },
    report: {
      droppedVerbatim: snapshot.verbatim.length - verbatim.length,
      droppedBullets,
      droppedPreferences: snapshot.preferences.length - preferences.length,
      tokenEstimate: used,
      budget,
    },
  };
}
