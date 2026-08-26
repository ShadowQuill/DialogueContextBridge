import type { CompileResult } from '../core/compiler';
import type { SearchHit, SnapshotRecord } from '../storage/repository';
import type { BudgetReport } from '../types';

/**
 * 命令层的输出渲染。
 *
 * 命令回调只负责编排，所有面向用户的文案集中在此，便于统一措辞与后续 i18n。
 *
 * @packageDocumentation
 */

/**
 * 格式化时间戳为本地可读字符串。
 *
 * @param timestamp - epoch 毫秒。
 * @returns `YYYY-MM-DD HH:mm` 形式的字符串。
 */
export function formatTime(timestamp: number): string {
  if (!timestamp) return '未知时间';
  const date = new Date(timestamp);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

/**
 * 渲染 token 预算裁剪提示。
 *
 * @param report - 裁剪报告。
 * @returns 提示文本；无裁剪时返回空串。
 */
export function formatBudgetNotice(report: BudgetReport): string {
  const dropped =
    report.droppedVerbatim + report.droppedBullets + report.droppedPreferences;
  if (dropped === 0) return '';
  return [
    `> ⚠️ 受 token 预算（${report.budget}）限制，已丢弃`,
    `原文 ${report.droppedVerbatim} 条、摘要要点 ${report.droppedBullets} 条、偏好 ${report.droppedPreferences} 条。`,
    '可通过设置面板调大 `maxTokens`（建议不超过 8192）后重新编译。',
  ].join(' ');
}

/**
 * 渲染 `/compile` 的预览输出。
 *
 * @param result - 编译结果。
 * @param options - 渲染选项。
 * @param options.full - 是否附上完整快照文档。
 * @returns Markdown 文本。
 */
export function formatCompilePreview(
  result: CompileResult,
  options: { full?: boolean } = {},
): string {
  const { snapshot, report } = result;
  const lines = [
    `**已编译快照草稿** \`${snapshot.meta.snapshotId}\``,
    '',
    `- 标题：${snapshot.meta.title}`,
    `- 来源对话：\`${snapshot.meta.sourceConversationId}\``,
    `- 三层规模：原文 ${snapshot.verbatim.length} 条 / 摘要 ${snapshot.summary.length} 节（${snapshot.summary.reduce(
      (sum, section) => sum + section.bullets.length,
      0,
    )} 要点）/ 偏好 ${snapshot.preferences.length} 条`,
    `- token 估算：${snapshot.meta.tokenEstimate} / ${report.budget}`,
    `- 标签：${snapshot.meta.tags.length > 0 ? snapshot.meta.tags.join('、') : '（无）'}`,
  ];

  const notice = formatBudgetNotice(report);
  if (notice) lines.push('', notice);

  lines.push('', '执行 `/save` 落库，或 `/compile --discard` 丢弃草稿。');

  if (options.full) {
    lines.push('', '<details><summary>查看完整快照文档</summary>', '', result.markdown, '</details>');
  }
  return lines.join('\n');
}

/**
 * 渲染检索结果列表。
 *
 * @param query - 查询关键词。
 * @param hits - 命中项。
 * @param tokenizer - 生效的分词器（用于给出提示）。
 * @returns Markdown 文本。
 */
export function formatSearchResults(query: string, hits: SearchHit[], tokenizer: string): string {
  if (hits.length === 0) {
    const hint =
      tokenizer === 'trigram'
        ? '（trigram 索引要求关键词长度 ≥ 3，更短的词会自动退化为模糊扫描）'
        : '（当前 SQLite 不支持 trigram 分词，中文检索已退化为模糊扫描）';
    return `未找到与 **${query}** 相关的快照。${hint}`;
  }

  const rows = hits.map((hit, index) => {
    const tags = hit.tags.length > 0 ? ` \`#${hit.tags.join('` `#')}\`` : '';
    const excerpt = hit.excerpt.replace(/\s+/g, ' ').trim();
    return [
      `${index + 1}. **${hit.title}** — \`${hit.snapshotId}\`${tags}`,
      `   ${formatTime(hit.createdAt)} · ${hit.tokenEstimate} tokens · 相关度 ${hit.score.toFixed(2)}`,
      excerpt ? `   > ${excerpt}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  });

  return [`找到 ${hits.length} 条与 **${query}** 相关的快照：`, '', ...rows].join('\n');
}

/**
 * 渲染快照列表。
 *
 * @param records - 快照记录。
 * @returns Markdown 文本。
 */
export function formatSnapshotList(records: SnapshotRecord[]): string {
  if (records.length === 0) {
    return '记忆库为空。在需要留存上下文的对话里执行 `/compile` 即可生成第一个快照。';
  }
  const rows = records.map((record) => {
    const flags = [record.encrypted ? '🔒' : '', ...record.tags.map((tag) => `#${tag}`)]
      .filter(Boolean)
      .join(' ');
    return `- \`${record.snapshotId}\` **${record.title}** · ${formatTime(record.createdAt)} · ${record.tokenEstimate} tokens ${flags}`;
  });
  return [`共 ${records.length} 条快照：`, '', ...rows].join('\n');
}
