import {
  asFlag,
  asPositiveInt,
  asString,
  guard,
  loadMessages,
  parseTagOption,
  type CommandDeps,
} from './shared';
import { card, kvTable } from './card';

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
    input: {
      hint: '（无参数；--title 标题，--tags 标签，--max-tokens 上限）',
    },
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
      return card({
        icon: '💾',
        title: `已保存快照 ${outcome.snapshotId}`,
        subtitle: fromDraft ? '来源：/compile 草稿' : '当前对话无草稿，已即时编译后保存',
        body: kvTable([
          ['标题', outcome.title],
          ['Token 估算', String(outcome.tokenEstimate)],
          ['加密存储', outcome.encrypted ? '🟢 是（AES-256-GCM）' : '⚪ 否'],
          ['全文索引', outcome.indexed ? '🟢 已建立' : '⚪ 未建立'],
          ['记忆库总数', `${total} 条`],
        ]),
      });
    }),
  });
}

/**
 * 注册 `/dcb-save` 命令：一键导出当前对话为可移植快照。
 *
 * 等价于「`/compile` + `/save`」的一步到位，并额外回显落库的 Markdown 全文与快照
 * id，方便用户**直接复制**后粘贴到其他对话或外部 Agent（纯文本即可被任何能读文本的
 * AI 接手，满足 spec 的「可迁移性」）。加密快照回显的是解密后的明文。
 *
 * @param deps - 命令依赖。
 */
export function registerQuickSaveCommand(deps: CommandDeps): void {
  deps.registry({
    name: 'dcb-save',
    description: '一键把当前对话编译并落库为快照，回显可复制的 Markdown 与快照 id',
    input: {
      hint: '（无参数；--full 回显全文，--title 标题，--tags 标签）',
    },
    handler: guard(deps.logger, '/dcb-save', async (ctx) => {
      const { conversationId } = ctx;

      const outcome = await deps.service.compileAndSave({
        conversationId,
        messages: await loadMessages(deps, ctx.agent.session),
        title: asString(ctx.options.title),
        description: asString(ctx.options.description),
        tags: parseTagOption(ctx.options.tags),
        maxTokens: asPositiveInt(ctx.options.maxTokens),
      });

      // 默认省略整段快照全文以压低对话历史体积（每段全文会随后续每轮被 LLM 重读，
      // 是 token 膨胀主因）。需复制时显式加 `--full` 才回显明文 Markdown。
      const showFull = asFlag(ctx.options.full);
      const markdown = showFull ? (deps.service.read(outcome.snapshotId)?.markdown ?? '') : '';

      const fullBlock = showFull
        ? [
            '',
            `📋 可复制快照全文 —— 粘贴到新对话后 /dcb ${outcome.snapshotId} 即可一键引入：`,
            '',
            markdown,
          ]
        : ['', `需复制全文？加 --full 回显（默认省略以省 token）。`];

      return card({
        icon: '📦',
        title: `已导出快照 ${outcome.snapshotId}`,
        subtitle: `${outcome.tokenEstimate} tokens · 加密：${outcome.encrypted ? '是' : '否'}`,
        body: [
          kvTable([
            ['标题', outcome.title],
            ['Token 估算', String(outcome.tokenEstimate)],
            ['加密', outcome.encrypted ? '🟢' : '⚪'],
            ['索引', outcome.indexed ? '🟢' : '⚪'],
          ]),
          ...fullBlock,
          '',
          `引入：/dcb ${outcome.snapshotId} · 合并 /import ${outcome.snapshotId} --mode merge`,
        ].join('\n'),
      });
    }),
  });
}
