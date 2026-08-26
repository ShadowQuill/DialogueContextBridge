/**
 * 对话内卡片渲染助手。
 *
 * DSH web 客户端按 Markdown 渲染命令回执，这里用「引用块标题带 + GFM 表格 +
 * 分隔线」组合出统一、清爽的卡片视觉，避免零散的 `- 字段：值` 列表带来的杂乱感。
 * 全部为纯 Markdown，任何 Markdown 渲染器都可正确呈现。
 */

/** 卡片头部：引用块渲染为带左边框的标题带。 */
export interface CardOptions {
  /** 标题前的图标（emoji）。 */
  icon?: string;
  /** 卡片标题（加粗）。 */
  title: string;
  /** 标题下方的副标题（状态行）。 */
  subtitle?: string;
  /** 卡片正文（Markdown）。 */
  body: string;
}

/** 渲染一张卡片。 */
export function card(opts: CardOptions): string {
  const head = [`> ${opts.icon ? `${opts.icon} ` : ''}**${opts.title}**`];
  if (opts.subtitle) head.push(`> ${opts.subtitle}`);
  return [...head, '', opts.body].join('\n');
}

/** 渲染两列键值表。 */
export function kvTable(rows: ReadonlyArray<readonly [string, string]>): string {
  if (rows.length === 0) return '_（无）_';
  const lines = ['| 字段 | 值 |', '| --- | --- |'];
  for (const [key, value] of rows) lines.push(`| ${key} | ${value} |`);
  return lines.join('\n');
}

/** 渲染近期快照清单表。 */
export interface SnapshotRow {
  id: string;
  title: string;
  tokens: number;
  status?: string;
}

/** 渲染快照清单表（ID / 标题 / Tokens / 状态）。 */
export function snapshotTable(rows: ReadonlyArray<SnapshotRow>): string {
  const lines = ['| 快照 ID | 标题 | Tokens | 状态 |', '| --- | --- | --- | --- |'];
  for (const row of rows) {
    lines.push(`| \`${row.id}\` | ${row.title} | ${row.tokens} | ${row.status ?? '—'} |`);
  }
  return lines.join('\n');
}

/** 渲染快捷操作清单。 */
export function actionList(items: ReadonlyArray<readonly [string, string]>): string {
  return items.map(([label, command]) => `▸ **${label}**： \`${command}\``).join('\n');
}

/** 把布尔值渲染为带图标的开关状态。 */
export function flag(on: boolean, onText = '开', offText = '关'): string {
  return on ? `🟢 ${onText}` : `⚪ ${offText}`;
}
