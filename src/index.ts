import { join } from 'node:path';
import type { Context as CordisContext } from '@deepseek-ai/cordis';
import { registerCommands } from './commands';
import { assertEncryptionConfig, Config } from './config';
import {
  createDshCommandRegistry,
  createDshConversationReader,
  createDshContextInjector,
} from './dsh/types';
import { createCipher } from './security/crypto';
import { createBridgeService, type BridgeService } from './service';
import { openDatabase } from './storage/database';
import { createSnapshotRepository } from './storage/repository';
import { createCliGitRunner } from './versioning/git';
import { createVersioningController } from './versioning/store';
import { createLogger } from './utils/logger';
import { resolveDataDir } from './utils/paths';

/**
 * DialogueContextBridge —— DSH 对话上下文桥接插件。
 *
 * Phase 1 提供「快照导出」闭环：把一次对话的已了解信息编译为三层结构的
 * Markdown 快照，存入本地 SQLite（FTS5 索引），并支持关键词检索。
 * Phase 2 提供「导入注入」：把历史快照渲染为只读背景简报（`inject` 模式），
 * 或按可配置规则（`newWins` / `snapshotWins` / `timestamp`）融合当前对话上下文
 * （`merge` 模式），注入新对话。
 * Phase 4 提供「记忆库版本控制」：每次保存/删除快照后自动 git 提交，并可经
 * `/snapshot.rollback` 回滚到历史版本。
 *
 * @packageDocumentation
 */

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 对话上下文桥接服务，供其他插件复用（如 Phase 2 的导入注入）。 */
    dcb: BridgeService;
  }
}

/** 插件名（DSH 设置面板与日志中显示）。 */
export const name = 'dialogue-context-bridge';

/** 服务注入声明：依赖 dsh 的命令注册服务（人类命令）。 */
export const inject = ['commands'];

export { Config } from './config';

/**
 * 插件入口。
 *
 * 生命周期：
 * 1. 校验配置（加密口令等跨字段约束）；
 * 2. 打开本地数据库并执行迁移（幂等）；
 * 3. 组装服务并挂到 `ctx.dcb`；
 * 4. 注册命令；
 * 5. 在 `dispose` 时关闭数据库连接——配置热更新会走「dispose + 重新 apply」，
 *    因此这里必须彻底释放句柄，否则 WAL 文件会被重复持有。
 *
 * @param ctx - Cordis 上下文。
 * @param config - 插件配置（已由 Schema 校验并填充默认值）。
 */
export function apply(ctx: CordisContext, config: Config): void {
  assertEncryptionConfig(config);

  const logger = createLogger(name, config.logLevel);
  const handle = openDatabase({ dataDir: config.dataDir, logger });

  try {
    const repository = createSnapshotRepository(handle);
    const cipher = createCipher(
      config.encryption.enabled ? config.encryption.passphrase : undefined,
    );

    // Phase 4：记忆库版本控制。git 仓库独立放在数据目录下的 `snapshots/`，
    // 避免把 SQLite 二进制也纳入版本历史。
    const versioning = createVersioningController({
      dataDir: join(resolveDataDir(config.dataDir), 'snapshots'),
      git: createCliGitRunner({ cwd: join(resolveDataDir(config.dataDir), 'snapshots') }),
      enabled: config.versioning.enabled,
    });

    const service = createBridgeService({
      repository,
      cipher,
      logger,
      options: {
        maxTokens: config.maxTokens,
        maxBulletsPerSection: config.maxBulletsPerSection,
        indexPlaintextWhenEncrypted: config.encryption.indexPlaintext,
        mergePolicy: config.merge.policy,
      },
      versioning,
    });

    // 把服务挂到 ctx.dcb：cordis 该 fork 要求先 provide 再 set，故直接用 provide
    // （一次性完成声明与赋值，并在 fiber 卸载时自动撤回服务）。
    ctx.provide('dcb', service);

    registerCommands({
      registry: createDshCommandRegistry(ctx),
      service,
      reader: createDshConversationReader(),
      injector: createDshContextInjector(name),
      config,
      logger,
    });

    logger.info(
      `已就绪：数据库 ${handle.file}，分词器 ${handle.tokenizer}，` +
        `token 预算 ${config.maxTokens}，加密 ${config.encryption.enabled ? '开' : '关'}，` +
        `版本控制 ${config.versioning.enabled ? '开' : '关'}`,
    );
  } catch (error) {
    handle.close();
    throw error;
  }

  // 该 fork 的 Cordis 不会 emit 'dispose' 事件，清理需注册为 fiber effect：
  // 返回的 disposer 会在 fiber 卸载（含配置热更新的 dispose+重新 apply）时运行。
  ctx.effect(() => () => {
      handle.close();
      logger.debug('已释放数据库连接');
    });
}

export default { name, inject, Config, apply };

// ---------------------------------------------------------------------------
// 公共 API：允许其他插件 / 脚本直接复用核心能力，而不经过命令层。
// ---------------------------------------------------------------------------
export { compileSnapshot, DEFAULT_MAX_TOKENS, type CompileResult } from './core/compiler';
export {
  extractIndexText,
  parseSnapshot,
  serializeSnapshot,
  verifySnapshotDocument,
} from './core/serializer';
export { createExtractiveSummarizer, type Summarizer } from './core/summarize';
export { applyTokenBudget, estimateSnapshotTokens } from './core/budget';
export { createCipher, decryptText, encryptText, isEncrypted, type Cipher } from './security/crypto';
export { openDatabase, openMemoryDatabase, type DatabaseHandle } from './storage/database';
export {
  createSnapshotRepository,
  toMatchExpression,
  type SearchHit,
  type SnapshotRecord,
  type SnapshotRepository,
} from './storage/repository';
export { createBridgeService, type BridgeService } from './service';
export {
  buildBrief,
  buildInjectBrief,
  buildMergeBrief,
  fuseSnapshots,
  type ImportMode,
  type InjectBrief,
  type MergePolicy,
  type MergeConflict,
  type FusionResult,
} from './core/inject';
export {
  createVersioningController,
  type VersioningController,
  type VersionEntry,
} from './versioning/store';
export {
  createCliGitRunner,
  createMemoryGitRunner,
  type GitRunner,
  type GitResult,
} from './versioning/git';
export * from './types';
