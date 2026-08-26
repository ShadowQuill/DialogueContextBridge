import { formatSnapshotList, formatTime } from './format';
import { asFlag, asPositiveInt, asString, guard, type CommandDeps } from './shared';

/**
 * 注册快照管理类命令：`/snapshot.list`、`/snapshot.show`、`/snapshot.remove`。
 *
 * Phase 1 阶段这些命令同时承担「让用户可验证快照内容」与「用户可编辑、可删除
 * 记忆」两个职责——数据主权属于用户，插件不做任何后台自动学习。
 *
 * @param deps - 命令依赖。
 */
export function registerManageCommands(deps: CommandDeps): void {
  deps.registry('snapshot.list', '列出本地快照')
    .option('limit', '-n, --limit <n:number>', { description: '返回条数上限' })
    .option('here', '--here', { description: '仅列出当前对话产出的快照' })
    .action(
      guard(deps.logger, '/snapshot.list', async (argv) => {
        const limit = asPositiveInt(argv.options.limit) ?? 20;
        const conversationId = asFlag(argv.options.here) ? argv.session.conversationId : undefined;
        return formatSnapshotList(deps.service.list(limit, conversationId));
      }),
    );

  deps.registry('snapshot.show <snapshotId:string>', '查看快照的完整文档')
    .option('meta', '--meta', { description: '仅显示元信息，不输出正文' })
    .action(
      guard(deps.logger, '/snapshot.show', async (argv, snapshotId) => {
        const outcome = deps.service.read(snapshotId);
        if (!outcome) return `未找到快照 \`${snapshotId}\`。`;

        const { record, snapshot, markdown, intact } = outcome;
        const header = [
          `**${snapshot.meta.title}** \`${record.snapshotId}\``,
          `- 来源对话：\`${snapshot.meta.sourceConversationId}\``,
          `- 生成时间：${formatTime(snapshot.meta.createdAt)}`,
          `- 三层规模：原文 ${snapshot.verbatim.length} 条 / 摘要 ${snapshot.summary.length} 节 / 偏好 ${snapshot.preferences.length} 条`,
          `- token 估算：${snapshot.meta.tokenEstimate}`,
          `- 存储：${record.encrypted ? '密文（AES-256-GCM）' : '明文'}`,
          `- 完整性：${intact ? '✅ 校验通过' : '⚠️ 校验和不匹配，文档可能被手工改动'}`,
        ].join('\n');

        if (asFlag(argv.options.meta)) return header;
        return `${header}\n\n---\n\n${markdown}`;
      }),
    );

  deps.registry('snapshot.remove <snapshotId:string>', '删除指定快照')
    .alias('snapshot.delete')
    .usage('删除操作不可撤销，会同时移除快照正文与全文索引。')
    .action(
      guard(deps.logger, '/snapshot.remove', async (_argv, snapshotId) =>
        deps.service.remove(snapshotId)
          ? `🗑️ 已删除快照 \`${snapshotId}\`。`
          : `未找到快照 \`${snapshotId}\`，无需删除。`,
      ),
    );

  deps.registry('snapshot.history <snapshotId:string>', '查看快照的版本历史（Phase 4 版本控制）')
    .usage('仅当设置项 `versioning.enabled` 开启后才会有历史记录。')
    .action(
      guard(deps.logger, '/snapshot.history', async (_argv, snapshotId) => {
        const history = await deps.service.history(snapshotId);
        if (history.length === 0) {
          return [
            `快照 \`${snapshotId}\` 暂无版本历史。`,
            '开启设置项 `versioning.enabled` 后，每次保存/删除都会自动提交一次版本。',
          ].join('\n');
        }
        const rows = history
          .map((entry, index) => {
            const marker = index === 0 ? '（当前）' : '';
            return `- \`${entry.ref}\` ${entry.date} · ${entry.message}${marker}`;
          })
          .join('\n');
        return `**${snapshotId} 的版本历史**（最新在前）：\n\n${rows}\n\n用 \`/snapshot.rollback ${snapshotId} --to <ref>\` 回滚到指定版本。`;
      }),
    );

  deps.registry('snapshot.rollback <snapshotId:string>', '回滚快照到某个历史版本（Phase 4 版本控制）')
    .option('to', '--to <ref:string>', { description: '目标版本引用；省略时回滚到上一个版本' })
    .usage('回滚会把目标版本重新落库，并自身也记一笔版本，历史可继续追溯。')
    .action(
      guard(deps.logger, '/snapshot.rollback', async (argv, snapshotId) => {
        const explicit = asString(argv.options.to);
        const history = await deps.service.history(snapshotId);
        if (history.length === 0) {
          return `快照 \`${snapshotId}\` 没有版本历史，无法回滚。请先开启 \`versioning.enabled\`。`;
        }
        const ref = explicit || (history[1]?.ref ?? history[0].ref);
        const restored = await deps.service.rollback(snapshotId, ref);
        if (!restored) return `回滚失败：引用 \`${ref}\` 不存在或版本控制未启用。`;
        return `↩️ 已回滚快照 \`${snapshotId}\` 至版本 \`${ref}\`（重新落库成功）。`;
      }),
    );
}
