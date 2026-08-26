import { formatCompilePreview } from './format';
import {
  asFlag,
  asPositiveInt,
  asString,
  guard,
  loadMessages,
  parseTagOption,
  type CommandDeps,
} from './shared';

/**
 * 注册 `/compile` 命令：把当前对话编译为三层结构快照草稿。
 *
 * 设计上 `/compile` **不写盘**，只产出草稿与预览，用户确认后再 `/save`。
 * 当配置 `autoSave` 为 true 时直接落库，适合信任度较高的个人使用场景。
 *
 * @param deps - 命令依赖。
 */
export function registerCompileCommand(deps: CommandDeps): void {
  deps.registry({
    name: 'compile',
    description: '把当前对话编译为可移植的上下文快照草稿',
    handler: guard(deps.logger, '/compile', async (ctx) => {
      const {conversationId} = ctx;

      if (asFlag(ctx.options.discard)) {
        return deps.service.discardDraft(conversationId)
          ? '已丢弃当前对话的快照草稿。'
          : '当前对话没有待处理的草稿。';
      }

      const messages = await loadMessages(deps, ctx.agent.session);
      if (messages.length === 0) {
        return '当前对话没有可编译的消息。';
      }

      const request = {
        conversationId,
        messages,
        title: asString(ctx.options.title),
        description: asString(ctx.options.description),
        tags: parseTagOption(ctx.options.tags),
        maxTokens: asPositiveInt(ctx.options.maxTokens),
      };

      if (deps.config.autoSave) {
        const outcome = await deps.service.compileAndSave(request);
        return [
          `**已编译并保存快照** \`${outcome.snapshotId}\``,
          `- 标题：${outcome.title}`,
          `- token 估算：${outcome.tokenEstimate}`,
          `- 加密存储：${outcome.encrypted ? '是' : '否'}`,
          '',
          '（`autoSave` 已开启，跳过了 `/save` 确认步骤。）',
        ].join('\n');
      }

      const result = await deps.service.compile(request);
      return formatCompilePreview(result, { full: asFlag(ctx.options.full) });
    }),
  });
}
