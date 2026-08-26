import type Database from 'better-sqlite3';

/** FTS5 分词器类型。 */
export type FtsTokenizer = 'trigram' | 'unicode61';

/** 迁移执行上下文。 */
export interface MigrationContext {
  /** 建表时实际可用的 FTS5 分词器。 */
  tokenizer: FtsTokenizer;
}

/** 一次数据库迁移。 */
export interface Migration {
  /** 版本号，必须单调递增。 */
  version: number;
  /** 迁移名称（用于日志与审计）。 */
  name: string;
  /**
   * 执行迁移。
   *
   * @param db - 数据库连接。
   * @param context - 迁移上下文。
   */
  up(db: Database.Database, context: MigrationContext): void;
}

/**
 * 全量迁移列表。
 *
 * 约定：**只增不改**。任何结构调整都以新增 migration 的方式表达，保证已有
 * 本地数据可无损升级（用户的记忆库不可被破坏性重建）。
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'create-snapshots-and-fts',
    up(db: Database.Database, { tokenizer }: MigrationContext): void {
      db.exec(`
        CREATE TABLE IF NOT EXISTS snapshots (
          snapshot_id            TEXT PRIMARY KEY,
          source_conversation_id TEXT    NOT NULL,
          title                  TEXT    NOT NULL,
          description            TEXT    NOT NULL DEFAULT '',
          tags                   TEXT    NOT NULL DEFAULT '[]',
          schema_version         TEXT    NOT NULL,
          token_estimate         INTEGER NOT NULL DEFAULT 0,
          encrypted              INTEGER NOT NULL DEFAULT 0,
          checksum               TEXT    NOT NULL,
          document               TEXT    NOT NULL,
          created_at             INTEGER NOT NULL,
          updated_at             INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_snapshots_created_at
          ON snapshots (created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_snapshots_conversation
          ON snapshots (source_conversation_id, created_at DESC);
      `);

      // FTS5 独立内容表：写入时由仓储层显式同步。
      // 相比 external-content + trigger 的方案，这里牺牲少量存储换取
      // 「加密快照可以选择不建索引」的能力——密文不应通过索引泄漏明文。
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS snapshot_fts USING fts5(
          snapshot_id UNINDEXED,
          title,
          description,
          tags,
          summary_text,
          verbatim_text,
          preference_text,
          tokenize = '${tokenizer}'
        );
      `);
    },
  },
];

/**
 * 探测当前 SQLite 构建可用的 FTS5 分词器。
 *
 * 优先选择 `trigram`：`unicode61` 不对中文分词，会把整段中文当成一个 token，
 * 导致中文关键词检索几乎不可用；`trigram` 以 3 字符滑窗建索引，天然支持中文
 * 子串匹配。仅当 SQLite 版本过低（< 3.34）时回退到 `unicode61`。
 *
 * @param db - 数据库连接。
 * @returns 可用的分词器名称。
 */
export function detectTokenizer(db: Database.Database): FtsTokenizer {
  try {
    db.exec(
      "CREATE VIRTUAL TABLE IF NOT EXISTS temp.dcb_tokenizer_probe USING fts5(c, tokenize='trigram');",
    );
    db.exec('DROP TABLE IF EXISTS temp.dcb_tokenizer_probe;');
    return 'trigram';
  } catch {
    return 'unicode61';
  }
}

/**
 * 执行所有未应用的迁移。
 *
 * @param db - 数据库连接。
 * @param context - 迁移上下文。
 * @returns 本次实际应用的迁移版本号列表。
 */
export function runMigrations(db: Database.Database, context: MigrationContext): number[] {
  db.exec(`
    CREATE TABLE IF NOT EXISTS dcb_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT    NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);

  const applied = new Set(
    db
      .prepare('SELECT version FROM dcb_migrations')
      .all()
      .map((row) => (row as { version: number }).version),
  );

  const record = db.prepare(
    'INSERT INTO dcb_migrations (version, name, applied_at) VALUES (?, ?, ?)',
  );

  const pending = MIGRATIONS.filter((migration) => !applied.has(migration.version)).sort(
    (a, b) => a.version - b.version,
  );

  const apply = db.transaction((migrations: readonly Migration[]) => {
    migrations.forEach((migration) => {
      migration.up(db, context);
      record.run(migration.version, migration.name, Date.now());
    });
  });

  apply(pending);
  return pending.map((migration) => migration.version);
}
