import {
  SNAPSHOT_SCHEMA_VERSION,
  type ContextSnapshot,
  type MessageRole,
  type PreferenceEntry,
  type PreferenceScope,
  type SnapshotMeta,
  type SummarySection,
  type VerbatimEntry,
  type VerbatimKind,
} from '../types';
import { checksum } from '../utils/id';

/**
 * 快照文档的 Markdown 序列化 / 反序列化。
 *
 * 磁盘格式的三条硬约束：
 * 1. **自描述**：文档头是 YAML 风格的 Schema 头，任何解析器无需外部信息即可
 *    还原结构；
 * 2. **可读**：正文是标准 Markdown，人类可直接阅读与手工编辑；
 * 3. **可移植**：不含任何平台专有字段，任何能读纯文本的 Agent 都能接手。
 *
 * 层边界用 HTML 注释标记（`<!-- dcb:layer:* -->`），既不影响渲染，也便于
 * 机械切分。
 *
 * @packageDocumentation
 */

/** 层分隔标记。 */
const LAYER_MARKER = {
  verbatim: '<!-- dcb:layer:verbatim -->',
  summary: '<!-- dcb:layer:summary -->',
  preference: '<!-- dcb:layer:preference -->',
  end: '<!-- dcb:end -->',
} as const;

/** 正文中出现字面量 `<!--` 时的转义形式，避免破坏层标记解析。 */
const COMMENT_ESCAPE = '&lt;!--';

/** 序列化失败 / 解析失败时抛出的错误码前缀。 */
const PARSE_ERROR = 'DCB_SNAPSHOT_PARSE_ERROR';

/**
 * 转义正文中的 HTML 注释起始符。
 *
 * @param text - 原始文本。
 * @returns 转义后的文本。
 */
function escapeBody(text: string): string {
  return text.replaceAll('<!--', COMMENT_ESCAPE);
}

/**
 * 还原被 {@link escapeBody} 转义的文本。
 *
 * @param text - 转义后的文本。
 * @returns 原始文本。
 */
function unescapeBody(text: string): string {
  return text.replaceAll(COMMENT_ESCAPE, '<!--');
}

/**
 * 为代码内容计算安全的围栏长度（长于内容中最长的连续反引号串）。
 *
 * @param code - 代码内容。
 * @returns 围栏字符串，例如 '```'。
 */
function fenceFor(code: string): string {
  const longest = (code.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0);
  return '`'.repeat(Math.max(3, longest + 1));
}

/**
 * 序列化单行标量值（压缩换行，避免破坏 Schema 头）。
 *
 * @param value - 任意标量。
 * @returns 单行字符串。
 */
function scalar(value: string): string {
  return value.replace(/\r?\n/g, ' ').trim();
}

/**
 * 渲染自描述 Schema 头。
 *
 * @param meta - 快照元信息。
 * @returns Markdown front matter 文本（含首尾 `---`）。
 */
function renderFrontMatter(meta: SnapshotMeta): string {
  const lines = [
    '---',
    `dcb_schema: ${meta.schemaVersion}`,
    `snapshot_id: ${meta.snapshotId}`,
    `source_conversation_id: ${meta.sourceConversationId}`,
    `title: ${scalar(meta.title)}`,
    `description: ${scalar(meta.description)}`,
    `tags: [${meta.tags.map(scalar).join(', ')}]`,
    `created_at: ${new Date(meta.createdAt).toISOString()}`,
    `token_estimate: ${meta.tokenEstimate}`,
    `encrypted: ${meta.encrypted}`,
    `checksum: ${meta.checksum}`,
    `weight: ${meta.weight ?? 0}`,
    'layers: [verbatim, summary, preference]',
    '---',
  ];
  return lines.join('\n');
}

/**
 * 渲染单条原文条目。
 *
 * @param entry - 原文条目。
 * @returns Markdown 片段。
 */
function renderVerbatimEntry(entry: VerbatimEntry): string {
  const attrs = [
    `id=${entry.id}`,
    `kind=${entry.kind}`,
    entry.language ? `lang=${entry.language}` : '',
    `role=${entry.sourceRole}`,
    `src=${entry.sourceMessageId}`,
    `at=${entry.createdAt}`,
  ]
    .filter(Boolean)
    .join(' ');

  const header = `<!-- dcb:entry ${attrs} -->`;
  if (entry.kind === 'code') {
    const fence = fenceFor(entry.content);
    return `${header}\n${fence}${entry.language ?? ''}\n${entry.content}\n${fence}`;
  }
  return `${header}\n${escapeBody(entry.content)}`;
}

/**
 * 渲染偏好条目。
 *
 * @param entry - 偏好条目。
 * @returns Markdown 列表项。
 */
function renderPreference(entry: PreferenceEntry): string {
  const flag = entry.explicit ? 'explicit' : 'inferred';
  return `- **[${entry.scope}] ${entry.key}** (${flag}) — ${escapeBody(scalar(entry.value))} <!-- at=${entry.createdAt} -->`;
}

/**
 * 把快照序列化为 Markdown 文档。
 *
 * 校验和在序列化过程中就地重算并写入 Schema 头，因此返回文档的
 * `checksum` 始终与正文一致；调用方无需自行维护。
 *
 * @param snapshot - 待序列化的快照。
 * @returns `{ markdown, checksum }`，markdown 为完整文档。
 */
export function serializeSnapshot(snapshot: ContextSnapshot): {
  markdown: string;
  checksum: string;
} {
  const sections: string[] = [];

  sections.push(`# ${scalar(snapshot.meta.title) || '未命名快照'}`);
  if (snapshot.meta.description.trim()) {
    sections.push(`> ${escapeBody(scalar(snapshot.meta.description))}`);
  }

  sections.push(LAYER_MARKER.verbatim);
  sections.push('## 1. 关键消息原文');
  if (snapshot.verbatim.length === 0) {
    sections.push('_（本快照没有需要逐字保留的内容。）_');
  } else {
    snapshot.verbatim.forEach((entry) => sections.push(renderVerbatimEntry(entry)));
  }

  sections.push(LAYER_MARKER.summary);
  sections.push('## 2. 结构化摘要');
  if (snapshot.summary.length === 0) {
    sections.push('_（无摘要内容。）_');
  } else {
    snapshot.summary.forEach((section) => {
      sections.push(`### ${scalar(section.heading)}`);
      sections.push(section.bullets.map((bullet) => `- ${escapeBody(scalar(bullet))}`).join('\n'));
    });
  }

  sections.push(LAYER_MARKER.preference);
  sections.push('## 3. 用户偏好与设定');
  if (snapshot.preferences.length === 0) {
    sections.push('_（未识别到显式偏好。）_');
  } else {
    sections.push(snapshot.preferences.map(renderPreference).join('\n'));
  }

  sections.push(LAYER_MARKER.end);

  const body = `${sections.join('\n\n')}\n`;
  const digest = checksum(body);
  const markdown = `${renderFrontMatter({ ...snapshot.meta, checksum: digest })}\n\n${body}`;
  return { markdown, checksum: digest };
}

/**
 * Schema 头匹配正则。
 *
 * 末尾 `(?:\r?\n)+` 会吞掉 `---` 之后的所有空行，确保切出的正文与序列化时
 * 参与校验和计算的正文**逐字节一致**。
 */
const FRONT_MATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---[^\S\r\n]*(?:\r?\n)+/;

/**
 * 切分 Schema 头与正文。
 *
 * @param markdown - 快照文档。
 * @returns 头部键值对与正文；无 Schema 头时返回 undefined。
 */
function parseFrontMatter(raw: string): Record<string, string> {
  return raw.split(/\r?\n/).reduce<Record<string, string>>((acc, line) => {
    const index = line.indexOf(':');
    if (index <= 0) return acc;
    acc[line.slice(0, index).trim()] = line.slice(index + 1).trim();
    return acc;
  }, {});
}

/**
 * 切分 Schema 头与正文。
 *
 * @param markdown - 快照文档。
 * @returns 头部键值对与正文；无 Schema 头时返回 undefined。
 */
function splitDocument(markdown: string): { head: Record<string, string>; body: string } | undefined {
  const match = FRONT_MATTER_PATTERN.exec(markdown);
  if (!match) return undefined;
  return { head: parseFrontMatter(match[1]), body: markdown.slice(match[0].length) };
}

/**
 * 解析形如 `[a, b]` 的数组字面量。
 *
 * @param raw - 字面量文本。
 * @returns 字符串数组。
 */
function parseList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

/** 条目头注释的属性解析正则。 */
const ENTRY_HEADER_PATTERN = /^<!--\s*dcb:entry\s+([^>]*?)\s*-->$/;

/**
 * 解析条目头注释的属性。
 *
 * @param line - 注释行。
 * @returns 属性映射，非条目头返回 undefined。
 */
function parseEntryAttrs(line: string): Record<string, string> | undefined {
  const match = ENTRY_HEADER_PATTERN.exec(line.trim());
  if (!match) return undefined;
  return match[1].split(/\s+/).reduce<Record<string, string>>((acc, pair) => {
    const [key, ...rest] = pair.split('=');
    if (key && rest.length > 0) acc[key] = rest.join('=');
    return acc;
  }, {});
}

/**
 * 解析原文层。
 *
 * @param block - 原文层文本块。
 * @returns 原文条目数组。
 */
function parseVerbatimLayer(block: string): VerbatimEntry[] {
  const lines = block.split(/\r?\n/);
  const entries: VerbatimEntry[] = [];
  let cursor = 0;

  while (cursor < lines.length) {
    const attrs = parseEntryAttrs(lines[cursor] ?? '');
    cursor += 1;

    if (attrs) {
      let content = '';
      const fenceMatch = /^(`{3,})(.*)$/.exec(lines[cursor]?.trim() ?? '');
      if (fenceMatch) {
        const fence = fenceMatch[1];
        cursor += 1;
        const collected: string[] = [];
        while (cursor < lines.length && lines[cursor].trim() !== fence) {
          collected.push(lines[cursor]);
          cursor += 1;
        }
        cursor += 1;
        content = collected.join('\n');
      } else {
        const collected: string[] = [];
        while (cursor < lines.length && !parseEntryAttrs(lines[cursor] ?? '')) {
          collected.push(lines[cursor]);
          cursor += 1;
        }
        content = unescapeBody(collected.join('\n').trim());
      }

      entries.push({
        id: attrs.id ?? `v-${entries.length + 1}`,
        sourceMessageId: attrs.src ?? '',
        sourceRole: (attrs.role as MessageRole) ?? 'user',
        kind: (attrs.kind as VerbatimKind) ?? 'decision',
        language: attrs.lang,
        content,
        createdAt: Number(attrs.at ?? 0),
      });
    }
  }

  return entries;
}

/**
 * 解析摘要层。
 *
 * @param block - 摘要层文本块。
 * @returns 摘要小节数组。
 */
function parseSummaryLayer(block: string): SummarySection[] {
  const sections: SummarySection[] = [];
  block.split(/\r?\n/).forEach((line) => {
    const heading = /^###\s+(.+)$/.exec(line.trim());
    if (heading) {
      sections.push({ heading: heading[1].trim(), bullets: [] });
      return;
    }
    const bullet = /^-\s+(.+)$/.exec(line.trim());
    if (bullet && sections.length > 0) {
      sections[sections.length - 1].bullets.push(unescapeBody(bullet[1].trim()));
    }
  });
  return sections.filter((section) => section.bullets.length > 0);
}

/** 偏好条目行的解析正则。 */
const PREFERENCE_PATTERN =
  /^-\s+\*\*\[(style|role|constraint)\]\s+(\S+)\*\*\s*(?:\((explicit|inferred)\))?\s*—\s*(.*?)\s*(?:<!--\s*at=(\d+)\s*-->)?$/;

/**
 * 解析偏好层。
 *
 * @param block - 偏好层文本块。
 * @returns 偏好条目数组。
 */
function parsePreferenceLayer(block: string): PreferenceEntry[] {
  return block
    .split(/\r?\n/)
    .map((line) => PREFERENCE_PATTERN.exec(line.trim()))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({
      scope: match[1] as PreferenceScope,
      key: match[2],
      explicit: match[3] !== 'inferred',
      value: unescapeBody(match[4]),
      createdAt: Number(match[5] ?? 0),
    }));
}

/**
 * 从 Markdown 文档还原快照对象。
 *
 * 解析是宽容的：缺失的可选字段会退化为默认值，但缺少 Schema 头或层标记会
 * 抛错——因为那意味着文档不是本插件生成的快照。
 *
 * @param markdown - 快照 Markdown 文档。
 * @returns 快照对象。
 * @throws 当文档缺少 Schema 头或层标记时抛出 `DCB_SNAPSHOT_PARSE_ERROR`。
 */
export function parseSnapshot(markdown: string): ContextSnapshot {
  const document = splitDocument(markdown);
  if (!document) {
    throw new Error(`${PARSE_ERROR}: 缺少自描述 Schema 头`);
  }
  const { head, body } = document;

  const verbatimAt = body.indexOf(LAYER_MARKER.verbatim);
  const summaryAt = body.indexOf(LAYER_MARKER.summary);
  const preferenceAt = body.indexOf(LAYER_MARKER.preference);
  if (verbatimAt < 0 || summaryAt < 0 || preferenceAt < 0) {
    throw new Error(`${PARSE_ERROR}: 缺少三层结构分隔标记`);
  }
  const endAt = body.indexOf(LAYER_MARKER.end);

  const meta: SnapshotMeta = {
    schemaVersion: head.dcb_schema ?? SNAPSHOT_SCHEMA_VERSION,
    snapshotId: head.snapshot_id ?? '',
    sourceConversationId: head.source_conversation_id ?? '',
    title: head.title ?? '',
    description: head.description ?? '',
    tags: parseList(head.tags),
    createdAt: head.created_at ? Date.parse(head.created_at) : 0,
    tokenEstimate: Number(head.token_estimate ?? 0),
    encrypted: head.encrypted === 'true',
    checksum: head.checksum ?? '',
    weight: Number(head.weight ?? 0),
  };

  return {
    meta,
    verbatim: parseVerbatimLayer(body.slice(verbatimAt + LAYER_MARKER.verbatim.length, summaryAt)),
    summary: parseSummaryLayer(body.slice(summaryAt + LAYER_MARKER.summary.length, preferenceAt)),
    preferences: parsePreferenceLayer(
      body.slice(preferenceAt + LAYER_MARKER.preference.length, endAt < 0 ? undefined : endAt),
    ),
  };
}

/**
 * 校验快照文档的正文完整性。
 *
 * @param markdown - 快照 Markdown 文档。
 * @returns 校验和一致返回 true；文档无 Schema 头时返回 false。
 */
export function verifySnapshotDocument(markdown: string): boolean {
  const document = splitDocument(markdown);
  if (!document) return false;
  return Boolean(document.head.checksum) && checksum(document.body) === document.head.checksum;
}

/**
 * 提取用于 FTS5 索引的纯文本字段。
 *
 * 索引只取明文，且与文档存储解耦：当启用加密存储时，调用方可以选择不写入
 * 这些字段，从而避免密文快照通过索引泄漏内容。
 *
 * @param snapshot - 快照对象。
 * @returns 三层各自拼接后的检索文本。
 */
export function extractIndexText(snapshot: ContextSnapshot): {
  summaryText: string;
  verbatimText: string;
  preferenceText: string;
} {
  return {
    summaryText: snapshot.summary
      .map((section) => `${section.heading}\n${section.bullets.join('\n')}`)
      .join('\n'),
    verbatimText: snapshot.verbatim.map((entry) => entry.content).join('\n'),
    preferenceText: snapshot.preferences.map((entry) => `${entry.key} ${entry.value}`).join('\n'),
  };
}
