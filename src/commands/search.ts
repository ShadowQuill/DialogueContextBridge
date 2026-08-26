import { formatSearchResults } from './format';
import { asPositiveInt, asString, guard, type CommandDeps } from './shared';

/**
 * 注册 `/snapshot-search` 命令：基于 FTS5 的快照关键词检索。
 *
 * 面对大量历史快照时，用户不需要逐条翻阅，通过关键词即可定位到需要引入的
 * 那次对话。检索走 SQLite FTS5，列权重按「标题 > 描述 > 标签 > 摘要 > 偏好 >
 * 原文」排序。
 *
 * @param deps - 命令依赖。
 */
export function registerSearchCommand(deps: CommandDeps): void {
  deps.registry({
    name: 'snapshot-search',
    description: '按关键词检索本地快照',
    handler: guard(deps.logger, '/snapshot-search', async (ctx) => {
      const query = (asString(ctx.args[0]) ?? '').trim();
      if (!query) return '请提供检索关键词，例如：`/snapshot-search 上下文桥接`。';

      const limit = asPositiveInt(ctx.options.limit) ?? deps.config.searchLimit;
      const hits = deps.service.search(query, limit);
      const { tokenizer } = deps.service.stats();
      return formatSearchResults(query, hits, tokenizer);
    }),
  });
}
