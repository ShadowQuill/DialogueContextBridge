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
  deps.registry('save', '把当前对话的快照草稿保存到本地记忆库')
    .usage(
      [
        '把 `/compile` 产出的草稿写入本地 SQLite 记忆库（`~/.dsh/`），并建立全文索引。',
        '若当前对话没有草稿，则先按默认参数编译再保存。',
      ].join('\n'),
    )
    .example('/save')
    .example('/save --title "DSH 插件骨架定稿" --tags dsh,phase1')
    .option('title', '--title <title:string>', { description: '覆盖快照标题（仅在需要重新编译时生效）' })
    .option('tags', '-t, --tags <tags:string>', { description: '覆盖标签（仅在需要重新编译时生效）' })
    .option('maxTokens', '--max-tokens <n:number>', { description: '重新编译时的 token 上限' })
    .action(
      guard(deps.logger, '/save', async (argv) => {
        const { conversationId } = argv.session;

        const fromDraft = deps.service.saveDraft(conversationId);
        const outcome =
          fromDraft ??
          (await deps.service.compileAndSave({
            conversationId,
            messages: await loadMessages(deps, conversationId),
            title: asString(argv.options.title),
            tags: parseTagOption(argv.options.tags),
            maxTokens: asPositiveInt(argv.options.maxTokens),
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
    );
}
