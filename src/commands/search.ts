import { formatSearchResults } from './format';
import { asPositiveInt, guard, type CommandDeps } from './shared';

/**
 * 注册 `/snapshot.search` 命令：基于 FTS5 的快照关键词检索。
 *
 * 面对大量历史快照时，用户不需要逐条翻阅，通过关键词即可定位到需要引入的
 * 那次对话。检索走 SQLite FTS5，列权重按「标题 > 描述 > 标签 > 摘要 > 偏好 >
 * 原文」排序，因为标题与摘要更能代表快照主题。
 *
 * @param deps - 命令依赖。
 */
export function registerSearchCommand(deps: CommandDeps): void {
  deps.registry('snapshot.search <keywords:text>', '按关键词检索本地快照')
    .alias('snapshot.find')
    .usage(
      [
        '在本地记忆库中做全文检索，命中片段会以 `[...]` 标出。',
        '多个关键词以空格分隔，语义为「全部命中（AND）」。',
      ].join('\n'),
    )
    .example('/snapshot.search FTS5 分词')
    .example('/snapshot.search 上下文桥接 --limit 5')
    .option('limit', '-n, --limit <n:number>', { description: '返回条数上限' })
    .action(
      guard(deps.logger, '/snapshot.search', async (argv, keywords) => {
        const query = (keywords ?? '').trim();
        if (!query) return '请提供检索关键词，例如：`/snapshot.search 上下文桥接`。';

        const limit = asPositiveInt(argv.options.limit) ?? deps.config.searchLimit;
        const hits = deps.service.search(query, limit);
        const { tokenizer } = deps.service.stats();
        return formatSearchResults(query, hits, tokenizer);
      }),
    );
}
