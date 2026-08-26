import {
  asPositiveInt,
  asString,
  guard,
  loadMessages,
  parseTagOption,
  type CommandDeps,
} from './shared';

/**
 * 注册 `/save` 命令：把草稿落库为持久化快照。
 *
 * 行为约定：
 * - 存在草稿 → 直接落库（用户已在 `/compile` 阶段确认过内容）；
 * - 不存在草稿 → 现场编译并落库（等价于 `/compile` + `/save` 的快捷方式）。
 *
 * @param deps - 命令依赖。
 */
export function registerSaveCommand(deps: CommandDeps): void {
  deps.registry({
    name: 'save',
    description: '把当前对话的快照草稿保存到本地记忆库',
    handler: guard(deps.logger, '/save', async (ctx) => {
      const {conversationId} = ctx;

      const fromDraft = deps.service.saveDraft(conversationId);
      const outcome =
        fromDraft ??
        (await deps.service.compileAndSave({
          conversationId,
          messages: await loadMessages(deps, ctx.agent.session),
          title: asString(ctx.options.title),
          tags: parseTagOption(ctx.options.tags),
          maxTokens: asPositiveInt(ctx.options.maxTokens),
        }));

      const { total } = deps.service.stats();
      return [
        `✅ 已保存快照 \`${outcome.snapshotId}\``,
        `- 标题：${outcome.title}`,
        `- token 估算：${outcome.tokenEstimate}`,
        `- 加密存储：${outcome.encrypted ? '是（AES-256-GCM）' : '否'}`,
        `- 全文索引：${outcome.indexed ? '已建立' : '未建立（加密快照默认不索引明文）'}`,
        `- 记忆库现有快照：${total} 条`,
        '',
        fromDraft ? '（来源：`/compile` 草稿）' : '（当前对话无草稿，已即时编译后保存。）',
      ].join('\n');
    }),
  });
}
