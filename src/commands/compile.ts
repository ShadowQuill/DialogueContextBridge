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
  deps.registry('compile', '把当前对话编译为可移植的上下文快照草稿')
    .usage(
      [
        '扫描当前对话，按三层结构提取内容：',
        '1. 关键消息原文（代码 / 决策 / 参数 / 硬性指令，逐字保留）',
        '2. 结构化摘要（背景、推导、已排除方案，压缩表达）',
        '3. 用户偏好与设定（风格、角色、硬性约束）',
        '',
        '产出的草稿只在内存中，执行 `/save` 才会写入本地记忆库。',
      ].join('\n'),
    )
    .example('/compile --title "上下文桥接架构评审" --tags 架构,phase1')
    .example('/compile --max-tokens 8192 --full')
    .option('title', '--title <title:string>', { description: '快照标题，缺省时从首条用户消息推导' })
    .option('description', '--description <text:string>', { description: '一句话描述' })
    .option('tags', '-t, --tags <tags:string>', { description: '标签，逗号分隔' })
    .option('maxTokens', '--max-tokens <n:number>', { description: '本次编译的 token 上限' })
    .option('full', '--full', { description: '在回复中附上完整快照文档' })
    .option('discard', '--discard', { description: '丢弃当前对话的草稿，不做编译' })
    .action(
      guard(deps.logger, '/compile', async (argv) => {
        const { conversationId } = argv.session;

        if (asFlag(argv.options.discard)) {
          return deps.service.discardDraft(conversationId)
            ? '已丢弃当前对话的快照草稿。'
            : '当前对话没有待处理的草稿。';
        }

        const messages = await loadMessages(deps, conversationId);
        if (messages.length === 0) {
          return '当前对话没有可编译的消息。';
        }

        const request = {
          conversationId,
          messages,
          title: asString(argv.options.title),
          description: asString(argv.options.description),
          tags: parseTagOption(argv.options.tags),
          maxTokens: asPositiveInt(argv.options.maxTokens),
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
        return formatCompilePreview(result, { full: asFlag(argv.options.full) });
      }),
    );
}
