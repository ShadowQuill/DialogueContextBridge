import type { ContextSnapshot } from '../types';
import type { DatabaseHandle } from './database';

/** 数据库中的一条快照记录。 */
export interface SnapshotRecord {
  /** 快照 id。 */
  snapshotId: string;
  /** 来源对话 id。 */
  sourceConversationId: string;
  /** 标题。 */
  title: string;
  /** 描述。 */
  description: string;
  /** 标签。 */
  tags: string[];
  /** 文档 Schema 版本。 */
  schemaVersion: string;
  /** token 估算值。 */
  tokenEstimate: number;
  /** 正文是否为密文。 */
  encrypted: boolean;
  /** 正文校验和。 */
  checksum: string;
  /** 落盘正文（可能是密文）。 */
  document: string;
  /** 创建时间（epoch 毫秒）。 */
  createdAt: number;
  /** 更新时间（epoch 毫秒）。 */
  updatedAt: number;
}

/** 检索命中项。 */
export interface SearchHit {
  /** 快照 id。 */
  snapshotId: string;
  /** 标题。 */
  title: string;
  /** 描述。 */
  description: string;
  /** 标签。 */
  tags: string[];
  /** 命中片段（含 `[...]` 高亮标记）。 */
  excerpt: string;
  /** 相关性得分，越大越相关（由 bm25 取负得到）。 */
  score: number;
  /** 创建时间。 */
  createdAt: number;
  /** token 估算值。 */
  tokenEstimate: number;
}

/** 落库入参。 */
export interface SaveSnapshotInput {
  /** 快照对象（提供元信息）。 */
  snapshot: ContextSnapshot;
  /** 落盘正文，可能已被加密。 */
  document: string;
  /**
   * 明文检索字段。
   *
   * 省略时不写入 FTS 索引——这是加密存储场景下的正确行为：密文快照不应
   * 通过全文索引泄漏明文内容。
   */
  index?: {
    summaryText: string;
    verbatimText: string;
    preferenceText: string;
  };
}

/** 列表查询参数。 */
export interface ListOptions {
  /** 返回条数上限，默认 20。 */
  limit?: number;
  /** 偏移量，默认 0。 */
  offset?: number;
  /** 仅列出某个来源对话的快照。 */
  conversationId?: string;
}

/** 检索参数。 */
export interface SearchOptions {
  /** 返回条数上限，默认 10。 */
  limit?: number;
}

/** 数据库原始行结构。 */
interface RawSnapshotRow {
  snapshot_id: string;
  source_conversation_id: string;
  title: string;
  description: string;
  tags: string;
  schema_version: string;
  token_estimate: number;
  encrypted: number;
  checksum: string;
  document: string;
  created_at: number;
  updated_at: number;
}

/**
 * 安全解析 JSON 数组字段。
 *
 * @param raw - 数据库中的 JSON 文本。
 * @returns 字符串数组；解析失败返回空数组。
 */
function parseTags(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * 行 → 领域对象。
 *
 * @param row - 数据库行。
 * @returns 快照记录。
 */
function toRecord(row: RawSnapshotRow): SnapshotRecord {
  return {
    snapshotId: row.snapshot_id,
    sourceConversationId: row.source_conversation_id,
    title: row.title,
    description: row.description,
    tags: parseTags(row.tags),
    schemaVersion: row.schema_version,
    tokenEstimate: row.token_estimate,
    encrypted: row.encrypted === 1,
    checksum: row.checksum,
    document: row.document,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * 把用户输入的关键词转换为 FTS5 MATCH 表达式。
 *
 * 处理两件事：
 * 1. **转义**：所有词项用双引号包裹（内部 `"` 双写），避免用户输入的
 *    `AND` / `*` / `:` 等被当作 FTS 语法执行；
 * 2. **可用性判定**：trigram 分词器要求词项长度 ≥ 3，短词直接返回
 *    `undefined`，由调用方回退到 LIKE 扫描。
 *
 * @param query - 用户输入的关键词串（空格分隔）。
 * @param tokenizer - 当前生效的分词器。
 * @returns MATCH 表达式；不可用时返回 undefined。
 */
export function toMatchExpression(
  query: string,
  tokenizer: DatabaseHandle['tokenizer'],
): string | undefined {
  const minLength = tokenizer === 'trigram' ? 3 : 1;
  const terms = query
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= minLength);
  if (terms.length === 0) return undefined;
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(' AND ');
}

/**
 * 创建快照仓储。
 *
 * 采用工厂函数而非 class：所有语句在创建时预编译一次，闭包持有，既拿到了
 * 「实例状态」的收益，又不引入继承与 this 语义。
 *
 * @param handle - 数据库句柄。
 * @returns 仓储方法集合。
 */
export function createSnapshotRepository(handle: DatabaseHandle): SnapshotRepository {
  const { db, tokenizer } = handle;

  const insertSnapshot = db.prepare(`
    INSERT INTO snapshots (
      snapshot_id, source_conversation_id, title, description, tags,
      schema_version, token_estimate, encrypted, checksum, document,
      created_at, updated_at
    ) VALUES (
      @snapshotId, @sourceConversationId, @title, @description, @tags,
      @schemaVersion, @tokenEstimate, @encrypted, @checksum, @document,
      @createdAt, @updatedAt
    )
    ON CONFLICT(snapshot_id) DO UPDATE SET
      title = excluded.title,
      description = excluded.description,
      tags = excluded.tags,
      token_estimate = excluded.token_estimate,
      encrypted = excluded.encrypted,
      checksum = excluded.checksum,
      document = excluded.document,
      updated_at = excluded.updated_at
  `);

  const deleteIndex = db.prepare('DELETE FROM snapshot_fts WHERE snapshot_id = ?');
  const insertIndex = db.prepare(`
    INSERT INTO snapshot_fts (
      snapshot_id, title, description, tags, summary_text, verbatim_text, preference_text
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const selectById = db.prepare('SELECT * FROM snapshots WHERE snapshot_id = ?');
  const deleteById = db.prepare('DELETE FROM snapshots WHERE snapshot_id = ?');
  const countAll = db.prepare('SELECT COUNT(*) AS total FROM snapshots');

  const searchByMatch = db.prepare(`
    SELECT
      f.snapshot_id AS snapshot_id,
      s.title       AS title,
      s.description AS description,
      s.tags        AS tags,
      s.created_at  AS created_at,
      s.token_estimate AS token_estimate,
      bm25(snapshot_fts, 0.0, 10.0, 6.0, 4.0, 3.0, 2.0, 2.5) AS rank_score,
      snippet(snapshot_fts, -1, '[', ']', '…', 16) AS excerpt
    FROM snapshot_fts f
    JOIN snapshots s ON s.snapshot_id = f.snapshot_id
    WHERE snapshot_fts MATCH ?
    ORDER BY rank_score
    LIMIT ?
  `);

  const searchByLike = db.prepare(`
    SELECT
      f.snapshot_id AS snapshot_id,
      s.title       AS title,
      s.description AS description,
      s.tags        AS tags,
      s.created_at  AS created_at,
      s.token_estimate AS token_estimate,
      0.0 AS rank_score,
      substr(f.summary_text, 1, 160) AS excerpt
    FROM snapshot_fts f
    JOIN snapshots s ON s.snapshot_id = f.snapshot_id
    WHERE f.title LIKE @like
       OR f.description LIKE @like
       OR f.tags LIKE @like
       OR f.summary_text LIKE @like
       OR f.verbatim_text LIKE @like
       OR f.preference_text LIKE @like
    ORDER BY s.created_at DESC
    LIMIT @limit
  `);

  const save = db.transaction((input: SaveSnapshotInput) => {
    const { meta } = input.snapshot;
    const now = Date.now();
    insertSnapshot.run({
      snapshotId: meta.snapshotId,
      sourceConversationId: meta.sourceConversationId,
      title: meta.title,
      description: meta.description,
      tags: JSON.stringify(meta.tags),
      schemaVersion: meta.schemaVersion,
      tokenEstimate: meta.tokenEstimate,
      encrypted: meta.encrypted ? 1 : 0,
      checksum: meta.checksum,
      document: input.document,
      createdAt: meta.createdAt,
      updatedAt: now,
    });

    deleteIndex.run(meta.snapshotId);
    if (input.index) {
      insertIndex.run(
        meta.snapshotId,
        meta.title,
        meta.description,
        meta.tags.join(' '),
        input.index.summaryText,
        input.index.verbatimText,
        input.index.preferenceText,
      );
    }
  });

  const remove = db.transaction((snapshotId: string): boolean => {
    deleteIndex.run(snapshotId);
    return deleteById.run(snapshotId).changes > 0;
  });

  return {
    /** 实际生效的 FTS5 分词器（便于上层给出检索提示）。 */
    tokenizer,

    /**
     * 保存（或覆盖）一条快照。
     *
     * @param input - 落库入参。
     */
    save(input: SaveSnapshotInput): void {
      save(input);
    },

    /**
     * 按 id 读取快照记录。
     *
     * @param snapshotId - 快照 id。
     * @returns 记录；不存在返回 undefined。
     */
    findById(snapshotId: string): SnapshotRecord | undefined {
      const row = selectById.get(snapshotId) as RawSnapshotRow | undefined;
      return row ? toRecord(row) : undefined;
    },

    /**
     * 列出快照（按创建时间倒序）。
     *
     * @param options - 列表参数。
     * @returns 快照记录数组。
     */
    list(options: ListOptions = {}): SnapshotRecord[] {
      const limit = options.limit ?? 20;
      const offset = options.offset ?? 0;
      const rows = options.conversationId
        ? db
            .prepare(
              `SELECT * FROM snapshots WHERE source_conversation_id = ?
               ORDER BY created_at DESC LIMIT ? OFFSET ?`,
            )
            .all(options.conversationId, limit, offset)
        : db
            .prepare('SELECT * FROM snapshots ORDER BY created_at DESC LIMIT ? OFFSET ?')
            .all(limit, offset);
      return (rows as RawSnapshotRow[]).map(toRecord);
    },

    /**
     * 全文检索快照。
     *
     * 优先走 FTS5 `MATCH`（带 bm25 列权重：标题 > 描述 > 标签 > 摘要 > 偏好 > 原文）；
     * 当关键词因 trigram 长度限制无法构造 MATCH 表达式时，自动回退到 LIKE 扫描，
     * 保证「搜两个汉字」这种常见输入不会直接返回空结果。
     *
     * @param query - 关键词串。
     * @param options - 检索参数。
     * @returns 命中项数组，按相关性倒序。
     */
    search(query: string, options: SearchOptions = {}): SearchHit[] {
      const limit = options.limit ?? 10;
      const keyword = query.trim();
      if (!keyword) return [];

      const expression = toMatchExpression(keyword, tokenizer);
      const rows = expression
        ? searchByMatch.all(expression, limit)
        : searchByLike.all({ like: `%${keyword}%`, limit });

      return (
        rows as Array<{
          snapshot_id: string;
          title: string;
          description: string;
          tags: string;
          created_at: number;
          token_estimate: number;
          rank_score: number;
          excerpt: string;
        }>
      ).map((row) => ({
        snapshotId: row.snapshot_id,
        title: row.title,
        description: row.description,
        tags: parseTags(row.tags),
        excerpt: row.excerpt ?? '',
        // bm25 返回负值且越小越相关，这里取负号转成「越大越相关」。
        score: -row.rank_score,
        createdAt: row.created_at,
        tokenEstimate: row.token_estimate,
      }));
    },

    /**
     * 删除快照及其索引。
     *
     * @param snapshotId - 快照 id。
     * @returns 实际删除返回 true。
     */
    remove(snapshotId: string): boolean {
      return remove(snapshotId);
    },

    /**
     * 统计快照总数。
     *
     * @returns 快照数量。
     */
    count(): number {
      return (countAll.get() as { total: number }).total;
    },
  };
}

/** 快照仓储对外暴露的方法集合。 */
export interface SnapshotRepository {
  /** 实际生效的 FTS5 分词器（trigram / unicode61）。 */
  tokenizer: DatabaseHandle['tokenizer'];
  /** 保存或覆盖一条快照（及其 FTS 索引）。 */
  save(input: SaveSnapshotInput): void;
  /** 按 id 读取快照记录；不存在返回 undefined。 */
  findById(snapshotId: string): SnapshotRecord | undefined;
  /** 列出快照，按创建时间倒序，支持分页与来源过滤。 */
  list(options?: ListOptions): SnapshotRecord[];
  /** 全文检索快照，按相关性倒序。 */
  search(query: string, options?: SearchOptions): SearchHit[];
  /** 删除快照及其索引；实际删除返回 true。 */
  remove(snapshotId: string): boolean;
  /** 统计快照总数。 */
  count(): number;
}
