import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

/**
 * DSH 本地数据根目录。
 *
 * 默认为 `~/.dsh`，可通过环境变量 `DSH_HOME` 覆盖（便于测试与多环境隔离）。
 * 所有快照数据只落本地磁盘，绝不上传服务器。
 *
 * @returns DSH 数据根目录的绝对路径。
 */
export function dshHome(): string {
  const custom = process.env.DSH_HOME?.trim();
  return custom ? resolve(custom) : join(homedir(), '.dsh');
}

/**
 * 解析本插件的数据目录。
 *
 * @param dataDir - 用户配置的数据目录；相对路径会挂到 {@link dshHome} 之下。
 * @returns 数据目录的绝对路径。
 */
export function resolveDataDir(dataDir = 'dialogue-context-bridge'): string {
  return isAbsolute(dataDir) ? dataDir : join(dshHome(), dataDir);
}

/**
 * 确保目录存在（递归创建）。
 *
 * @param dir - 目标目录。
 * @returns 传入的目录路径，便于链式调用。
 */
export function ensureDir(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 解析快照数据库文件路径，并确保其所在目录已创建。
 *
 * @param dataDir - 数据目录（可为相对路径）。
 * @param fileName - 数据库文件名。
 * @returns 数据库文件的绝对路径。
 */
export function resolveDatabasePath(dataDir?: string, fileName = 'snapshots.db'): string {
  return join(ensureDir(resolveDataDir(dataDir)), fileName);
}
