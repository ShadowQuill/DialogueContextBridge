/**
 * 对话内卡片渲染助手。
 *
 * DSH web 客户端把命令回执当作纯文本渲染（不解析 Markdown），所以这里刻意
 * 不使用任何 Markdown 标记（无 **、*、_、`、|、>、#），改用 emoji + 缩进 +
 * 分隔线的纯文本排版，保证在任意终端 / 聊天界面都清爽精致、且不会暴露源码符号。
 */

/** 卡片头部配置。 */
export interface CardOptions {
  /** 标题前的图标（emoji）。 */
  icon?: string;
  /** 卡片标题。 */
  title: string;
  /** 标题下方的副标题（状态行，缩进显示）。 */
  subtitle?: string;
  /** 卡片正文（纯文本）。 */
  body?: string;
  /** 卡片底部的提示 / 快捷操作（用分隔线与正文隔开）。 */
  footerNote?: string;
}

/** 分隔线，用于划分卡片区块。 */
const RULE = '─'.repeat(22);

/** 渲染一张卡片。 */
export function card(opts: CardOptions): string {
  const head = [`${opts.icon ? `${opts.icon} ` : ''}${opts.title}`];
  if (opts.subtitle) head.push(`  ${opts.subtitle}`);
  const parts = [head.join('\n')];
  if (opts.body) parts.push(RULE, opts.body);
  if (opts.footerNote) parts.push('', RULE, opts.footerNote);
  return parts.join('\n');
}

/** 渲染两列键值表（无表格线，用 `·` 项目符号）。 */
export function kvTable(rows: ReadonlyArray<readonly [string, string]>): string {
  if (rows.length === 0) return '（无）';
  return rows.map(([key, value]) => `· ${key}  ${value}`).join('\n');
}

/** 快照清单行结构。 */
export interface SnapshotRow {
  id: string;
  title: string;
  tokens: number;
  status?: string;
}

/** 渲染快照清单（每条快照一个缩进区块，无表格线）。 */
export function snapshotTable(rows: ReadonlyArray<SnapshotRow>): string {
  if (rows.length === 0) return '（无快照）';
  return rows
    .map((r) => `▸ ${r.id}\n    ${r.title} · ${r.tokens} tokens · ${r.status ?? '—'}`)
    .join('\n');
}

/** 渲染快捷操作清单（标签 → 命令，无加粗、无反引号）。 */
export function actionList(items: ReadonlyArray<readonly [string, string]>): string {
  return items.map(([label, command]) => `▸ ${label}  →  ${command}`).join('\n');
}

/** 把布尔值渲染为带图标的开关状态。 */
export function flag(on: boolean, onText = '开', offText = '关'): string {
  return on ? `🟢 ${onText}` : `⚪ ${offText}`;
}
