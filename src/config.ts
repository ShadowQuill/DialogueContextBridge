import Schema from '@deepseek-ai/schemastery';

/**
 * 插件配置 Schema。
 *
 * 使用 schemastery 描述配置，DSH 设置面板可据此自动渲染表单并**热更新**，
 * 无需重启宿主进程（Cordis 会以新配置重新 apply 插件）。
 *
 * @packageDocumentation
 */
export const Config = Schema.object({
  dataDir: Schema.string()
    .default('dialogue-context-bridge')
    .description('快照数据目录。相对路径会挂到 `~/.dsh` 之下；数据永不上传服务器。'),

  maxTokens: Schema.natural()
    .min(256)
    .max(32768)
    .default(4096)
    .description('单个快照的 token 上限。默认 4096，可按模型上下文窗口调大（建议不超过 8192）。'),

  maxBulletsPerSection: Schema.natural()
    .min(1)
    .max(30)
    .default(6)
    .description('结构化摘要中每个小节保留的最大要点数。'),

  maxHistoryMessages: Schema.natural()
    .min(1)
    .max(5000)
    .default(400)
    .description('`/compile` 单次读取的对话消息上限，避免超长会话拖慢编译。'),

  autoSave: Schema.boolean()
    .default(false)
    .description('`/compile` 后是否自动落库。关闭时需要再执行 `/save` 确认，避免误存草稿。'),

  searchLimit: Schema.natural()
    .min(1)
    .max(50)
    .default(10)
    .description('`/snapshot.search` 默认返回的结果条数。'),

  encryption: Schema.object({
    enabled: Schema.boolean()
      .default(false)
      .description('启用 AES-256-GCM 静态加密，快照正文以密文落库。'),
    passphrase: Schema.string()
      .role('secret')
      .default('')
      .description('加密口令（≥8 位）。不落盘，丢失即不可恢复。'),
    indexPlaintext: Schema.boolean()
      .default(false)
      .description('加密时是否仍建明文全文索引。默认关：开启会经索引泄漏密文内容，慎开。'),
  })
    .default({ enabled: false, passphrase: '', indexPlaintext: false })
    .description('数据安全'),

  logLevel: Schema.union(['debug', 'info', 'warn', 'error', 'silent'] as const)
    .default('info')
    .description('插件日志级别。'),

  merge: Schema.object({
    policy: Schema.union(['newWins', 'snapshotWins', 'timestamp'] as const)
      .default('newWins')
      .description(
        '合并模式（/import --mode merge）冲突裁决：newWins=新信息覆盖旧；' +
          'snapshotWins=快照优先；timestamp=按时间/权重裁决。',
      ),
  })
    .default({ policy: 'newWins' })
    .description('导入合并'),

  versioning: Schema.object({
    enabled: Schema.boolean()
      .default(false)
      .description(
        '记忆库版本控制：每次保存/删除后自动 git 提交，可经 /snapshot.rollback 回滚。' +
          '注意：被版本化的是快照明文，git 历史不加密——要求历史也不落明文请勿开启。',
      ),
  })
    .default({ enabled: false })
    .description('版本控制（Phase 4）'),
}).description('对话上下文桥接（DialogueContextBridge）');

/** 插件配置类型（由 Schema 推导，避免类型与校验规则双份维护）。 */
export type Config = ReturnType<typeof Config>;

/**
 * 校验加密配置的自洽性。
 *
 * 之所以单独做一次校验而不依赖 Schema：`enabled === true` 时 `passphrase`
 * 必填，这是跨字段约束，Schema 无法表达。
 *
 * @param config - 插件配置。
 * @throws 启用加密但未提供合法口令时抛错。
 */
export function assertEncryptionConfig(config: Config): void {
  if (!config.encryption.enabled) return;
  if (config.encryption.passphrase.trim().length < 8) {
    throw new Error(
      'DCB_CONFIG_INVALID: 已启用加密存储，但 encryption.passphrase 长度不足 8 位',
    );
  }
}
