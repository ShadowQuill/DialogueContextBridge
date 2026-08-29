import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { compileSnapshot, type CompileResult } from './core/compiler';
import { buildBrief, type ImportMode, type MergePolicy } from './core/inject';
import {
  extractIndexText,
  parseSnapshot,
  serializeSnapshot,
  verifySnapshotDocument,
} from './core/serializer';
import type { Summarizer } from './core/summarize';
import type { Cipher } from './security/crypto';
import type { SearchHit, SnapshotRecord, SnapshotRepository } from './storage/repository';
import type { VersionEntry, VersioningController } from './versioning/store';
import type { ContextSnapshot, ConversationMessage } from './types';
import { createSnapshotId } from './utils/id';
import { ensureDir } from './utils/paths';
import type { Logger } from './utils/logger';

/** 服务层依赖。 */
export interface BridgeServiceDeps {
  /** 快照仓储。 */
  repository: SnapshotRepository;
  /** 加解密器。 */
  cipher: Cipher;
  /** 日志器。 */
  logger: Logger;
  /** 编译相关配置。 */
  options: {
    /** token 上限。 */
    maxTokens: number;
    /** 每小节最大要点数。 */
    maxBulletsPerSection: number;
    /** 加密时是否仍写入明文索引。 */
    indexPlaintextWhenEncrypted: boolean;
    /** 合并模式缺省冲突裁决规则。 */
    mergePolicy: MergePolicy;
  };
  /** 可选的自定义摘要器（例如接入宿主 LLM）。 */
  summarize?: Summarizer;
  /** 可选的记忆库版本控制（Phase 4 git 自动提交与回滚）；未注入则不做版本化。 */
  versioning?: VersioningController;
  /** 插件数据目录（绝对路径），导出文件的默认落盘位置。 */
  dataDir: string;
}

/** 编译请求。 */
export interface CompileRequest {
  /** 对话 id。 */
  conversationId: string;
  /** 对话消息。 */
  messages: readonly ConversationMessage[];
  /** 标题覆盖。 */
  title?: string;
  /** 描述覆盖。 */
  description?: string;
  /** 标签。 */
  tags?: readonly string[];
  /** token 上限覆盖。 */
  maxTokens?: number;
}

/** 落库结果。 */
export interface SaveOutcome {
  /** 快照 id。 */
  snapshotId: string;
  /** 标题。 */
  title: string;
  /** token 估算值。 */
  tokenEstimate: number;
  /** 是否加密落库。 */
  encrypted: boolean;
  /** 是否建立了全文索引。 */
  indexed: boolean;
}

/** 读取结果。 */
export interface ReadOutcome {
  /** 数据库记录（`document` 为落盘原文，可能是密文）。 */
  record: SnapshotRecord;
  /** 解密后的 Markdown 文档。 */
  markdown: string;
  /** 解析后的快照对象。 */
  snapshot: ContextSnapshot;
  /** 正文校验和是否一致。 */
  intact: boolean;
}

/** 导出结果（文件导入/导出功能）。 */
export interface ExportOutcome {
  /** 被导出的快照 id。 */
  snapshotId: string;
  /** 标题。 */
  title: string;
  /** token 估算值。 */
  tokenEstimate: number;
  /** 源快照在库内是否为密文（导出文件统一为明文）。 */
  encrypted: boolean;
  /** 导出的文件是否为明文（总是 true：文件格式可被任意 Agent 接手）。 */
  writtenPlaintext: boolean;
  /** 落盘的绝对文件路径。 */
  path: string;
}

/** 从 Markdown 文档导入的结果（文件导入/导出功能）。 */
export interface ImportFileOutcome {
  /** 落库后新分配的快照 id（避免覆盖本地已有 id）。 */
  snapshotId: string;
  /** 文件中原始的快照 id。 */
  fromSnapshotId: string;
  /** 标题。 */
  title: string;
  /** token 估算值。 */
  tokenEstimate: number;
  /** 文件正文校验和是否与声明一致。 */
  intact: boolean;
  /** 是否为预演（未落库）。 */
  dryRun: boolean;
}

/** 导入请求（Phase 2 导入注入）。 */
export interface ImportRequest {
  /** 要引入的快照 id。 */
  snapshotId: string;
  /** 导入模式，`merge` 需配合 `currentMessages`。 */
  mode?: ImportMode;
  /** `merge` 模式下当前对话的消息，用于编译当前上下文。 */
  currentMessages?: readonly ConversationMessage[];
  /** 当前对话 id（仅用于 `merge` 编译的产物标记）。 */
  currentConversationId?: string;
  /** 合并模式下的冲突裁决规则，缺省用配置中的 `merge.policy`。 */
  policy?: MergePolicy;
}

/** 导入简报结果。 */
export interface ImportOutcome {
  /** 被引入的快照 id。 */
  snapshotId: string;
  /** 实际采用的导入模式。 */
  mode: ImportMode;
  /** 可直接注入系统提示的 Markdown 简报。 */
  brief: string;
  /** 简报 token 估算值。 */
  tokenEstimate: number;
  /** 合并模式下被自动裁决的冲突数（inject 模式为 0）。 */
  conflictCount: number;
}

/** 草稿缓存上限：超过后按 LRU 淘汰最旧的对话草稿。 */
const DRAFT_CACHE_LIMIT = 32;

/**
 * 创建桥接服务。
 *
 * 服务层负责编排「编译 → 预览 → 落库 → 检索」的完整链路，是命令层与核心
 * 能力之间唯一的耦合点。`/compile` 的产物先进入内存草稿区，只有 `/save`
 * 才会写盘——这是有意的两段式设计：快照一旦落库就会被其他对话引入，必须
 * 由用户确认后再持久化。
 *
 * @param deps - 依赖集合。
 * @returns 服务方法集合。
 */
export function createBridgeService(deps: BridgeServiceDeps): BridgeService {
  const { repository, cipher, logger, options } = deps;

  /** 对话 id → 最近一次编译结果。 */
  const drafts = new Map<string, CompileResult>();

  /**
   * 写入草稿缓存并做容量控制。
   *
   * @param conversationId - 对话 id。
   * @param result - 编译结果。
   */
  const rememberDraft = (conversationId: string, result: CompileResult): void => {
    if (drafts.has(conversationId)) drafts.delete(conversationId);
    drafts.set(conversationId, result);
    while (drafts.size > DRAFT_CACHE_LIMIT) {
      const oldest = drafts.keys().next().value;
      if (oldest === undefined) break;
      drafts.delete(oldest);
    }
  };

  /**
   * 落库单个快照（内部复用）。
   *
   * 负责「加密 → 写库 → 版本提交」的统一编排，被编译落库与文件导入共用。
   *
   * @param snapshot - 已就绪的快照对象（其 `meta.snapshotId` 决定落库键）。
   * @param markdown - 与快照一致的明文 Markdown 文档（用于加密落盘与版本提交）。
   * @returns 落库结果。
   */
  const storeSnapshot = (snapshot: ContextSnapshot, markdown: string): SaveOutcome => {
    const encrypted = cipher.enabled;
    const document = cipher.seal(markdown);
    const shouldIndex = !encrypted || options.indexPlaintextWhenEncrypted;

    const sealed: ContextSnapshot = {
      ...snapshot,
      meta: { ...snapshot.meta, encrypted },
    };

    repository.save({
      snapshot: sealed,
      document,
      index: shouldIndex ? extractIndexText(sealed) : undefined,
    });

    logger.info(
      `已保存快照 ${sealed.meta.snapshotId}（${sealed.meta.tokenEstimate} tokens，` +
        `加密=${encrypted}，索引=${shouldIndex}）`,
    );

    return {
      snapshotId: sealed.meta.snapshotId,
      title: sealed.meta.title,
      tokenEstimate: sealed.meta.tokenEstimate,
      encrypted,
      indexed: shouldIndex,
    };
  };

  /**
   * 落库单个快照。
   *
   * @param result - 编译结果。
   * @returns 落库结果。
   */
  const persist = (result: CompileResult): SaveOutcome => storeSnapshot(result.snapshot, result.markdown);

  /**
   * 落库后提交一次版本（Phase 4 记忆库版本控制）。
   *
   * best-effort：版本控制未启用或提交失败都只告警，不影响落库结果。
   *
   * @param snapshotId - 快照 id。
   * @param markdown - 已落库的快照 markdown 明文。
   * @returns 提交 promise（调用方可决定是否 await）。
   */
  const versionSave = (snapshotId: string, markdown: string): Promise<void> => {
    if (!deps.versioning?.enabled) return Promise.resolve();
    return deps.versioning
      .recordSave(snapshotId, markdown)
      .catch((error) => logger.warn(`快照版本提交失败（忽略）: ${String(error)}`));
  };

  /**
   * 编译对话为快照草稿，并写入草稿缓存。
   *
   * @param request - 编译请求。
   * @returns 编译结果。
   */
  const compile = async (request: CompileRequest): Promise<CompileResult> => {
    const result = await compileSnapshot({
      conversationId: request.conversationId,
      messages: request.messages,
      title: request.title,
      description: request.description,
      tags: request.tags,
      maxTokens: request.maxTokens ?? options.maxTokens,
      maxBulletsPerSection: options.maxBulletsPerSection,
      summarize: deps.summarize,
    });
    rememberDraft(request.conversationId, result);
    logger.debug(
      `编译完成: ${result.snapshot.meta.snapshotId}，` +
        `原文 ${result.snapshot.verbatim.length} 条 / 摘要 ${result.snapshot.summary.length} 节 / ` +
        `偏好 ${result.snapshot.preferences.length} 条`,
    );
    return result;
  };

  /**
   * 读取、解密并解析快照（内部复用）。
   *
   * @param snapshotId - 快照 id。
   * @returns 读取结果；不存在返回 undefined。
   */
  const openSnapshot = (snapshotId: string): ReadOutcome | undefined => {
    const record = repository.findById(snapshotId);
    if (!record) return undefined;
    const markdown = cipher.open(record.document);
    return {
      record,
      markdown,
      snapshot: parseSnapshot(markdown),
      intact: verifySnapshotDocument(markdown),
    };
  };

  /**
   * 设置快照的合并权重（用户主动标记，供 `weighted` 策略使用）。
   *
   * 复用 `openSnapshot` 读取、`storeSnapshot` 重存（按 id 覆盖、重算校验和、
   * 重新索引），并触发一次版本提交。权重只落在 `meta.weight`，不动三层内容。
   *
   * @param snapshotId - 快照 id。
   * @param weight - 权重值（合并冲突时高者胜）。
   * @returns 快照存在并已更新返回 true；不存在返回 false。
   */
  const setWeight = (snapshotId: string, weight: number): boolean => {
    const read = openSnapshot(snapshotId);
    if (!read) return false;
    const updated: ContextSnapshot = {
      ...read.snapshot,
      meta: { ...read.snapshot.meta, weight },
    };
    const { markdown } = serializeSnapshot(updated);
    storeSnapshot(updated, markdown);
    void versionSave(snapshotId, markdown);
    logger.info(`已更新快照 ${snapshotId} 权重为 ${weight}`);
    return true;
  };

  /**
   * 构建导入简报（Phase 2 导入注入）。
   *
   * 仅做渲染与编排，不触发任何宿主副作用（注入由命令层负责）。`merge` 模式下
   * 若提供了 `currentMessages`，会先现场编译当前对话，再与历史快照融合。
   *
   * @param request - 导入请求。
   * @returns 导入简报结果；快照不存在返回 undefined。
   */
  const buildImport = async (request: ImportRequest): Promise<ImportOutcome | undefined> => {
    const outcome = openSnapshot(request.snapshotId);
    if (!outcome) return undefined;

    let current: ContextSnapshot | undefined;
    if (request.mode === 'merge' && request.currentMessages && request.currentMessages.length > 0) {
      current = (
        await compileSnapshot({
          conversationId: request.currentConversationId ?? 'current',
          messages: request.currentMessages,
          maxTokens: options.maxTokens,
          maxBulletsPerSection: options.maxBulletsPerSection,
          summarize: deps.summarize,
        })
      ).snapshot;
    }

    const policy = request.policy ?? options.mergePolicy;
    const brief = buildBrief(outcome.snapshot, request.mode ?? 'inject', current, policy);
    logger.debug(
      `构建导入简报: ${brief.snapshotId}（模式 ${brief.mode}，策略 ${policy}，` +
        `${brief.tokenEstimate} tokens，冲突 ${brief.conflictCount}）`,
    );
    return {
      snapshotId: brief.snapshotId,
      mode: brief.mode,
      brief: brief.brief,
      tokenEstimate: brief.tokenEstimate,
      conflictCount: brief.conflictCount,
    };
  };

  return {
    /**
     * 编译对话为快照草稿（`/compile`）。
     *
     * 结果只进内存，不写盘。
     *
     * @param request - 编译请求。
     * @returns 编译结果（含 Markdown 预览与裁剪报告）。
     */
    compile,

    /**
     * 读取某个对话最近一次编译的草稿。
     *
     * @param conversationId - 对话 id。
     * @returns 草稿；不存在返回 undefined。
     */
    getDraft(conversationId: string): CompileResult | undefined {
      return drafts.get(conversationId);
    },

    /**
     * 丢弃草稿。
     *
     * @param conversationId - 对话 id。
     * @returns 存在并已删除返回 true。
     */
    discardDraft(conversationId: string): boolean {
      return drafts.delete(conversationId);
    },

    /**
     * 保存草稿（`/save`）。
     *
     * @param conversationId - 对话 id。
     * @returns 落库结果；无草稿时返回 undefined。
     */
    saveDraft(conversationId: string): SaveOutcome | undefined {
      const draft = drafts.get(conversationId);
      if (!draft) return undefined;
      const outcome = persist(draft);
      drafts.delete(conversationId);
      void versionSave(outcome.snapshotId, draft.markdown);
      return outcome;
    },

    /**
     * 编译并立即保存（`/save` 在无草稿时的行为，或 `autoSave` 场景）。
     *
     * @param request - 编译请求。
     * @returns 落库结果。
     */
    async compileAndSave(request: CompileRequest): Promise<SaveOutcome> {
      const result = await compile(request);
      drafts.delete(request.conversationId);
      const outcome = persist(result);
      await versionSave(outcome.snapshotId, result.markdown);
      return outcome;
    },

    /**
     * 全文检索快照。
     *
     * @param query - 关键词串。
     * @param limit - 结果条数上限。
     * @returns 命中项数组。
     */
    search(query: string, limit?: number): SearchHit[] {
      return repository.search(query, { limit });
    },

    /**
     * 列出快照。
     *
     * @param limit - 条数上限。
     * @param conversationId - 可选的来源对话过滤。
     * @returns 快照记录数组。
     */
    list(limit?: number, conversationId?: string): SnapshotRecord[] {
      return repository.list({ limit, conversationId });
    },

  /**
   * 读取并解密、解析快照。
   *
   * @param snapshotId - 快照 id。
   * @returns 读取结果；不存在返回 undefined。
   * @throws 加密快照在口令缺失或错误时抛出解密错误。
   */
  read(snapshotId: string): ReadOutcome | undefined {
    return openSnapshot(snapshotId);
  },

  /**
   * 把单个快照导出为独立 `.md` 文件（跨设备 / 跨账号可移植）。
   *
   * 无论库内是否加密，导出文件统一为**明文**快照文档——这正是 `parseSnapshot`
   * 可直接接手的格式，也满足 spec 的「任何能读文本的 Agent 都能接手」。
   * 加密快照会先在本机解密再写出，因此导出即代表你有意把该内容落到文件。
   *
   * @param snapshotId - 快照 id。
   * @param outDir - 可选的导出目录；缺省为 `<dataDir>/exports`。
   * @returns 导出结果；快照不存在抛出可读错误。
   */
  exportSnapshot(snapshotId: string, outDir?: string): ExportOutcome {
    const read = openSnapshot(snapshotId);
    if (!read) throw new Error(`未找到快照 ${snapshotId}`);
    const dir = ensureDir(outDir ?? join(deps.dataDir, 'exports'));
    const safeTitle = read.record.title.replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 40) || 'snapshot';
    const fileName = `${snapshotId}__${safeTitle}.md`;
    const filePath = join(dir, fileName);
    writeFileSync(filePath, read.markdown, 'utf8');
    logger.info(`已导出快照 ${snapshotId} 到 ${filePath}`);
    return {
      snapshotId,
      title: read.record.title,
      tokenEstimate: read.record.tokenEstimate,
      encrypted: read.record.encrypted,
      writtenPlaintext: true,
      path: filePath,
    };
  },

  /**
   * 导出记忆库内全部快照。
   *
   * @param outDir - 可选的导出目录。
   * @returns 每条快照的导出结果（单条失败只告警，不影响其余）。
   */
  exportAll(outDir?: string): ExportOutcome[] {
    const results: ExportOutcome[] = [];
    for (const record of repository.list({ limit: 1000 })) {
      try {
        results.push(this.exportSnapshot(record.snapshotId, outDir));
      } catch (error) {
        logger.warn(`导出快照 ${record.snapshotId} 失败（已跳过）: ${String(error)}`);
      }
    }
    return results;
  },

  /**
   * 从 Markdown 文档导入快照。
   *
   * 解析后**重新分配一个新 id** 落库，避免与本地已有快照（或同一文件重复导入）
   * 发生覆盖；正文校验和会重算并写回，保证跨机迁移不丢信息。目标库若开启加密，
   * 导入内容会按本地策略重新加密落盘。
   *
   * @param markdown - 快照 Markdown 文档。
   * @param options.dryRun - 为 true 时只解析与校验、不落库。
   * @returns 导入结果；文档非本插件快照时抛出可读错误。
   */
  importMarkdown(markdown: string, opts: { dryRun?: boolean } = {}): ImportFileOutcome {
    const original = parseSnapshot(markdown);
    const intact = verifySnapshotDocument(markdown);
    const newId = createSnapshotId();
    // 换 id 并重算校验和，得到可安全落库的文档。
    const reDoc = serializeSnapshot({
      ...original,
      meta: { ...original.meta, snapshotId: newId },
    }).markdown;
    const snapshot = parseSnapshot(reDoc);

    if (opts.dryRun) {
      logger.info(`[dry-run] 解析快照 ${original.meta.snapshotId} → 将分配 ${newId}（未落库）`);
      return {
        snapshotId: newId,
        fromSnapshotId: original.meta.snapshotId,
        title: original.meta.title,
        tokenEstimate: original.meta.tokenEstimate,
        intact,
        dryRun: true,
      };
    }

    const outcome = storeSnapshot(snapshot, reDoc);
    void versionSave(outcome.snapshotId, reDoc);
    return {
      snapshotId: outcome.snapshotId,
      fromSnapshotId: original.meta.snapshotId,
      title: outcome.title,
      tokenEstimate: outcome.tokenEstimate,
      intact,
      dryRun: false,
    };
  },

  /**
   * 从 `.md` 文件导入快照（读盘后委托 {@link createBridgeService} 内部的
   * `importMarkdown`）。
   *
   * @param filePath - 快照 `.md` 文件的绝对或相对路径。
   * @param opts.dryRun - 为 true 时只解析与校验、不落库。
   * @returns 导入结果；文件不存在或解析失败抛出可读错误。
   */
  importFile(filePath: string, opts: { dryRun?: boolean } = {}): ImportFileOutcome {
    const markdown = readFileSync(filePath, 'utf8');
    return this.importMarkdown(markdown, opts);
  },

  /**
   * 构建导入简报（Phase 2 导入注入）。
   *
   * 仅做渲染与编排，不触发任何宿主副作用（注入由命令层负责）。`merge` 模式下
   * 若提供了 `currentMessages`，会先现场编译当前对话，再与历史快照融合。
   *
   * @param request - 导入请求。
   * @returns 简报结果；快照不存在返回 undefined。
   */
  buildImport(request: ImportRequest): Promise<ImportOutcome | undefined> {
    return buildImport(request);
  },

    /**
     * 设置快照的合并权重（用户主动标记，用于 `--policy weighted`）。
     *
     * @param snapshotId - 快照 id。
     * @param weight - 权重值（合并冲突时高者胜）。
     * @returns 快照存在并已更新返回 true；不存在返回 false。
     */
    setWeight(snapshotId: string, weight: number): boolean {
      return setWeight(snapshotId, weight);
    },

    /**
     * 删除快照。
     *
     * @param snapshotId - 快照 id。
     * @returns 实际删除返回 true。
     */
    remove(snapshotId: string): boolean {
      const removed = repository.remove(snapshotId);
      if (removed) logger.info(`已删除快照 ${snapshotId}`);
      if (removed && deps.versioning?.enabled) {
        void deps.versioning
          .recordRemove(snapshotId)
          .catch((error) => logger.warn(`快照删除版本提交失败（忽略）: ${String(error)}`));
      }
      return removed;
    },

    /**
     * 记忆库概览。
     *
     * @returns 快照总数与生效的分词器。
     */
    stats(): { total: number; tokenizer: string } {
      return { total: repository.count(), tokenizer: repository.tokenizer };
    },

    history(snapshotId: string): Promise<VersionEntry[]> {
      return deps.versioning?.enabled
        ? deps.versioning.history(snapshotId)
        : Promise.resolve([]);
    },

    async rollback(snapshotId: string, ref: string): Promise<SnapshotRecord | undefined> {
      if (!deps.versioning?.enabled) return undefined;
      const markdown = await deps.versioning.readAtRef(snapshotId, ref);
      if (markdown === undefined) return undefined;

      const snapshot = parseSnapshot(markdown);
      const document = cipher.seal(markdown);
      const shouldIndex = !cipher.enabled || options.indexPlaintextWhenEncrypted;
      repository.save({
        snapshot,
        document,
        index: shouldIndex ? extractIndexText(snapshot) : undefined,
      });
      logger.info(`已回滚快照 ${snapshotId} 至版本 ${ref}`);
      // 把回滚动作本身也记一笔，使历史可继续追溯。
      await deps.versioning
        .recordSave(snapshotId, markdown)
        .catch((error) => logger.warn(`回滚版本提交失败（忽略）: ${String(error)}`));
      return repository.findById(snapshotId);
    },
  };
}

/** 桥接服务对外暴露的方法集合。 */
export interface BridgeService {
  /** 编译对话为快照草稿（仅进内存，不写盘）。 */
  compile(request: CompileRequest): Promise<CompileResult>;
  /** 读取某个对话最近一次编译的草稿。 */
  getDraft(conversationId: string): CompileResult | undefined;
  /** 丢弃草稿，存在并已删除返回 true。 */
  discardDraft(conversationId: string): boolean;
  /** 保存草稿落库；无草稿返回 undefined。 */
  saveDraft(conversationId: string): SaveOutcome | undefined;
  /** 编译并立即保存。 */
  compileAndSave(request: CompileRequest): Promise<SaveOutcome>;
  /** 全文检索快照。 */
  search(query: string, limit?: number): SearchHit[];
  /** 列出快照，可按来源对话过滤。 */
  list(limit?: number, conversationId?: string): SnapshotRecord[];
  /** 读取并解密、解析快照。 */
  read(snapshotId: string): ReadOutcome | undefined;
  /** 把单个快照导出为独立 `.md` 文件（默认落 `<dataDir>/exports`）。 */
  exportSnapshot(snapshotId: string, outDir?: string): ExportOutcome;
  /** 导出记忆库内全部快照。 */
  exportAll(outDir?: string): ExportOutcome[];
  /** 从 Markdown 文档导入快照（可 `--dry-run` 只解析不落库）。 */
  importMarkdown(markdown: string, options?: { dryRun?: boolean }): ImportFileOutcome;
  /** 从 `.md` 文件导入快照（读盘后委托 `importMarkdown`）。 */
  importFile(filePath: string, options?: { dryRun?: boolean }): ImportFileOutcome;
  /** 构建导入简报（不触发宿主注入）。 */
  buildImport(request: ImportRequest): Promise<ImportOutcome | undefined>;
  /** 设置快照的合并权重（用于 `--policy weighted`），权重高者胜。 */
  setWeight(snapshotId: string, weight: number): boolean;
  /** 删除快照，实际删除返回 true。 */
  remove(snapshotId: string): boolean;
  /** 记忆库概览。 */
  stats(): { total: number; tokenizer: string };
  /** 列出某快照的版本历史（未启用版本控制返回空数组）。 */
  history(snapshotId: string): Promise<VersionEntry[]>;
  /**
   * 回滚某快照到指定历史版本，并重新落库。
   *
   * @param snapshotId - 快照 id。
   * @param ref - 目标提交引用（来自 `history` 的 `ref`）。
   * @returns 回滚后的记录；版本控制未启用或引用不存在返回 undefined。
   */
  rollback(snapshotId: string, ref: string): Promise<SnapshotRecord | undefined>;
}
