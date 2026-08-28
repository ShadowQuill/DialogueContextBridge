import { join } from 'node:path';
import type { Context as CordisContext } from '@deepseek-ai/cordis';
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings';
import { registerCommands } from './commands';
import { assertEncryptionConfig, Config } from './config';
import {
  createDshCommandRegistry,
  createDshConversationReader,
  createDshContextInjector,
} from './dsh/types';
import { createDshLlmClient } from './dsh/llm';
import { createExtractiveSummarizer, type Summarizer } from './core/summarize';
import { createLlmSummarizer } from './core/llm-summarizer';
import type { LlmRuntime } from '@deepseek-ai/dsh-llm';
import { createCipher, type Cipher } from './security/crypto';
import { createBridgeService, type BridgeService } from './service';
import { openDatabase } from './storage/database';
import { createSnapshotRepository } from './storage/repository';
import { createCliGitRunner } from './versioning/git';
import { createVersioningController, type VersioningController } from './versioning/store';
import { createLogger } from './utils/logger';
import { resolveDataDir } from './utils/paths';

/** 在 DSH 设置面板中占用的命名空间（lowercase kebab-case，与插件短名一致）。 */
const SETTINGS_NAMESPACE = settingsNamespace('dialogue-context-bridge');

/**
 * 把版本控制控制器包成「开关热更新」代理。
 *
 * `createVersioningController` 在构造时就把 `enabled` 固化进返回的控制器；但设置
 * 面板允许用户在运行时切换 `versioning.enabled`。这里用一层代理把"是否启用"改为
 * 读 live 配置：关闭时所有方法退化为 no-op，开启时委托给内部真实控制器（其真实
 * 方法在首次 `git` 操作时才惰性初始化仓库，构造期无副作用）。
 *
 * @param inner - 始终以 `enabled: true` 构造的内部控制器，持有真实实现。
 * @param isEnabled - 读取 live 配置的开关。
 * @returns 开关随配置变化的代理控制器。
 */
function makeLiveVersioning(inner: VersioningController, isEnabled: () => boolean): VersioningController {
  const noop = (): Promise<void> => Promise.resolve();
  return {
    get enabled() {
      return isEnabled();
    },
    recordSave: (id, markdown) => (isEnabled() ? inner.recordSave(id, markdown) : noop()),
    recordRemove: (id) => (isEnabled() ? inner.recordRemove(id) : noop()),
    history: (id) => (isEnabled() ? inner.history(id) : Promise.resolve([])),
    readAtRef: (id, ref) => (isEnabled() ? inner.readAtRef(id, ref) : Promise.resolve(undefined)),
  };
}

/**
 * 依据配置解析当前生效的摘要器。
 *
 * - `summary.mode === 'extractive'`（默认）：返回 `undefined`，由服务层退化为
 *   内置抽取式摘要器（离线、零依赖、确定性可复现）。
 * - `summary.mode === 'llm'`：用宿主 `ctx.llm` 构造 LLM 客户端，并包一层
 *   `createLlmSummarizer`（失败/空输出自动回退抽取式）。
 * - 若用户选了 `llm` 但宿主未提供 `ctx.llm`（llm 服务未加载），记录告警并回退
 *   抽取式，避免插件加载失败。
 *
 * @param current - 当前完整配置。
 * @param ctx - Cordis 上下文（用于读取可选 `ctx.llm`）。
 * @param log - 日志器。
 * @returns 摘要器函数；抽取式模式下返回 undefined（交给服务层默认实现）。
 */
function resolveSummarizer(current: Config, ctx: CordisContext, log: ReturnType<typeof createLogger>): Summarizer | undefined {
  if (current.summary.mode !== 'llm') return undefined;
  const runtime = (ctx as unknown as { llm?: LlmRuntime }).llm;
  if (!runtime) {
    log.warn('summary.mode=llm 但宿主未提供 ctx.llm，已回退为内置抽取式摘要。');
    return undefined;
  }
  const client = createDshLlmClient(runtime, {
    provider: current.summary.provider,
    model: current.summary.model,
    maxTokens: current.summary.maxTokens,
    temperature: current.summary.temperature,
  });
  return createLlmSummarizer({
    client,
    maxBulletsPerSection: current.maxBulletsPerSection,
    fallback: createExtractiveSummarizer(),
    logger: (message) => log.warn(message),
  });
}

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

  // —— 设置面板热更新所需的 live 状态 ——
  // 命令层与服务层读取的是下面这些「可变引用」，设置面板改动时由 setSource 就地更新，
  // 无需重启宿主（数据目录变更除外，见 applyLive 内的告警）。
  const liveConfig: Config = { ...config };
  const liveOptions = {
    maxTokens: config.maxTokens,
    maxBulletsPerSection: config.maxBulletsPerSection,
    indexPlaintextWhenEncrypted: config.encryption.indexPlaintext,
    mergePolicy: config.merge.policy,
  };
  let cipherRef = createCipher(
    config.encryption.enabled ? config.encryption.passphrase : undefined,
  );
  // 加解密器无法就地改密钥，用一层代理把方法委托给当前 cipherRef，使设置热更新生效。
  const cipher: Cipher = {
    get enabled() {
      return cipherRef.enabled;
    },
    seal: (text) => cipherRef.seal(text),
    open: (text) => cipherRef.open(text),
  };

  // 摘要器：用稳定包装器委托给 live 引用，使设置面板的 summary.mode 热更新即时生效。
  // 声明在函数作用域（而非 try 内），以便 applyLive 能更新 summarizeRef。
  const defaultExtractive = createExtractiveSummarizer();
  let summarizeRef = resolveSummarizer(config, ctx, logger);
  const liveSummarizer: Summarizer = (input) => (summarizeRef ?? defaultExtractive)(input);

  try {
    const repository = createSnapshotRepository(handle);

    // Phase 4：记忆库版本控制。git 仓库独立放在数据目录下的 `snapshots/`，
    // 避免把 SQLite 二进制也纳入版本历史。内部控制器始终以 enabled:true 构造（持有
    // 真实实现、惰性初始化仓库），再包成随 live 配置开关的代理，从而支持运行时切换。
    const snapshotsDir = join(resolveDataDir(config.dataDir), 'snapshots');
    const versioning = makeLiveVersioning(
      createVersioningController({
        dataDir: snapshotsDir,
        git: createCliGitRunner({ cwd: snapshotsDir }),
        enabled: true,
      }),
      () => liveConfig.versioning.enabled,
    );

    const service = createBridgeService({
      repository,
      cipher,
      logger,
      options: liveOptions,
      summarize: liveSummarizer,
      versioning,
      dataDir: resolveDataDir(config.dataDir),
    });

    // 把服务挂到 ctx.dcb：cordis 该 fork 要求先 provide 再 set，故直接用 provide
    // （一次性完成声明与赋值，并在 fiber 卸载时自动撤回服务）。
    ctx.provide('dcb', service);

    registerCommands({
      registry: createDshCommandRegistry(ctx),
      service,
      reader: createDshConversationReader(),
      injector: createDshContextInjector(name),
      config: liveConfig,
      logger,
    });

    // Phase 4：接入 DSH 设置面板。注册后宿主 web UI 的「插件设置」会自动渲染本插件
    // 的配置表单（由 Config Schema 描述），改动经 setSource 热更新到上面的 live 引用。
    installSettingsSection(ctx, SETTINGS_NAMESPACE, Config, config, {
      validate: assertEncryptionConfig,
      setSource: (current) => applyLive(current()),
      // 所有热更新逻辑都在 setSource 内完成，无需额外通知动作。
      onChange: () => {},
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

  /**
   * 把设置面板的解析结果热更新到 live 引用。
   *
   * @param next - 经 Schema 默认值 + 组合层 + 用户层解析后的完整配置。
   */
  function applyLive(next: Config): void {
    Object.assign(liveConfig, next);
    liveOptions.maxTokens = next.maxTokens;
    liveOptions.maxBulletsPerSection = next.maxBulletsPerSection;
    liveOptions.indexPlaintextWhenEncrypted = next.encryption.indexPlaintext;
    liveOptions.mergePolicy = next.merge.policy;
    summarizeRef = resolveSummarizer(next, ctx, logger);
    cipherRef = createCipher(next.encryption.enabled ? next.encryption.passphrase : undefined);
    logger.setLevel(next.logLevel);
    if (next.dataDir !== config.dataDir) {
      logger.warn(
        'dataDir 已变更，但数据库在加载期已打开，需重启 dsh web 方能切换到新数据目录；' +
          '当前仍使用原数据目录。',
      );
    }
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
export { createLlmSummarizer, parseLlmSummary, type LlmSummarizeClient } from './core/llm-summarizer';
export { createDshLlmClient } from './dsh/llm';
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
