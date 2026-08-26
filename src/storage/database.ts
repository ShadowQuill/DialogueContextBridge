import Database from 'better-sqlite3';
import { resolveDatabasePath } from '../utils/paths';
import { silentLogger, type Logger } from '../utils/logger';
import { detectTokenizer, runMigrations, type FtsTokenizer } from './migrations';

/** 打开数据库的参数。 */
export interface OpenDatabaseOptions {
  /** 数据目录（相对路径挂到 `~/.dsh` 下）。 */
  dataDir?: string;
  /** 数据库文件名。 */
  fileName?: string;
  /** 直接指定完整路径或 `:memory:`（优先级高于 dataDir / fileName）。 */
  file?: string;
  /** 日志器。 */
  logger?: Logger;
}

/** 数据库句柄。 */
export interface DatabaseHandle {
  /** better-sqlite3 连接实例。 */
  db: Database.Database;
  /** 实际生效的 FTS5 分词器。 */
  tokenizer: FtsTokenizer;
  /** 数据库文件路径。 */
  file: string;
  /** 关闭连接（幂等）。 */
  close(): void;
}

/**
 * 打开（并在需要时初始化）快照数据库。
 *
 * 连接参数说明：
 * - `journal_mode = WAL`：读写并发更友好，DSH 主进程与后台任务可同时访问；
 * - `synchronous = NORMAL`：在 WAL 下兼顾安全与写入吞吐；
 * - `foreign_keys = ON`：为后续 Phase 的关联表预留约束能力。
 *
 * @param options - 打开参数。
 * @returns 数据库句柄，调用方负责在插件卸载时 `close()`。
 */
export function openDatabase(options: OpenDatabaseOptions = {}): DatabaseHandle {
  const logger = options.logger ?? silentLogger;
  const file = options.file ?? resolveDatabasePath(options.dataDir, options.fileName);

  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  const tokenizer = detectTokenizer(db);
  const applied = runMigrations(db, { tokenizer });
  if (applied.length > 0) {
    logger.info(`已应用数据库迁移: ${applied.join(', ')}（分词器: ${tokenizer}）`);
  }

  let closed = false;
  return {
    db,
    tokenizer,
    file,
    close() {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}

/**
 * 打开一个纯内存数据库，用于单元测试。
 *
 * @returns 数据库句柄。
 */
export function openMemoryDatabase(): DatabaseHandle {
  return openDatabase({ file: ':memory:' });
}
