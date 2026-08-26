import type { ImportMode, MergePolicy } from '../core/inject';
import { asString, asFlag, guard, loadMessages, type CommandDeps } from './shared';
import type { ConversationMessage } from '../types';

/**
 * 解析并校验导入模式参数。
 *
 * @param raw - 用户传入的 `--mode` 值。
 * @returns 合法的导入模式，缺省或非预期值回退到 `inject`。
 */
function resolveMode(raw: string | undefined): ImportMode {
  if (raw === 'merge') return 'merge';
  return 'inject';
}

/**
 * 解析并校验冲突裁决规则参数。
 *
 * @param raw - 用户传入的 `--policy` 值。
 * @returns 合法的裁决规则，缺省或非预期值回退到 `newWins`。
 */
function resolvePolicy(raw: string | undefined): MergePolicy {
  if (raw === 'snapshotWins' || raw === 'timestamp') return raw;
  return 'newWins';
}

/**
 * 注册 `/import` 命令：把历史快照引入当前对话（Phase 2 导入注入 / Phase 3 合并）。
 *
 * 设计要点：
 * - 默认走「仅新信息」模式——快照被渲染为只读背景简报，通过 `agent.inject()`
 *   注入当前对话的下一轮请求；新对话的产出不会回写快照；
 * - `--mode merge` 走 Phase 3 融合：需读取当前对话历史（通过 `agent.session`），
 *   把快照三层与当前上下文融合；偏好冲突按 `--policy` 裁决；
 * - `--policy snapshotWins` 让历史快照优先；`--policy timestamp` 按时间/显式权重裁决；
 * - `--dry-run` 只预览简报，不实际注入，方便用户确认内容。
 *
 * @param deps - 命令依赖。
 */
export function registerImportCommand(deps: CommandDeps): void {
  deps.registry({
    name: 'import',
    description: '把历史快照作为背景情报引入当前对话',
    handler: guard(deps.logger, '/import', async (ctx) => {
      const targetId = asString(ctx.args[0]);
      if (!targetId) return '请提供要引入的快照 id，例如：`/import snap_a1b2c3`。';

      const mode = resolveMode(asString(ctx.options.mode));
      const policy = resolvePolicy(asString(ctx.options.policy));
      const dryRun = asFlag(ctx.options.dryRun);

      let currentMessages: ConversationMessage[] | undefined;
      if (mode === 'merge') {
        try {
          currentMessages = await loadMessages(deps, ctx.agent.session);
        } catch {
          return [
            '⚠️ `--mode merge` 需要读取当前对话历史，但宿主未提供会话读取能力。',
            '请改用默认 `inject` 模式。',
          ].join('\n');
        }
      }

      const outcome = await deps.service.buildImport({
        snapshotId: targetId,
        mode,
        currentMessages,
        currentConversationId: ctx.conversationId,
        policy,
      });
      if (!outcome) {
        return `未找到快照 \`${targetId}\`。先用 \`/snapshot.search\` 或 \`/snapshot.list\` 定位。`;
      }

      if (dryRun) {
        return [
          `🔍 导入预览（模式 \`${outcome.mode}\`${
            outcome.mode === 'merge' ? `，策略 \`${policy}\`，冲突 ${outcome.conflictCount}` : ''
          }，约 ${outcome.tokenEstimate} tokens）：`,
          '',
          '<details><summary>展开背景简报</summary>',
          '',
          outcome.brief,
          '',
          '</details>',
          '',
          '去掉 `--dry-run` 后重新执行即可注入当前对话。',
        ].join('\n');
      }

      deps.injector(ctx.agent, outcome.brief);

      const note =
        mode === 'merge'
          ? `已按 Phase 3 融合（裁决规则 \`${policy}\`，自动裁决 ${outcome.conflictCount} 处冲突）后注入。`
          : '已作为只读背景情报注入，新对话的产出不会回写该快照。';
      return [
        `✅ 已引入快照 \`${outcome.snapshotId}\``,
        `- 模式：${outcome.mode}`,
        `- token 估算：${outcome.tokenEstimate}`,
        '',
        note,
      ].join('\n');
    }),
  });

  // 一键导入别名：省掉 `/import` 的子命令记忆成本，直接 `/dcb <id>` 即「仅新信息」注入。
  deps.registry({
    name: 'dcb',
    description: '一键引入历史快照（等价 /import inject，只读背景情报）',
    handler: guard(deps.logger, '/dcb', async (ctx) => {
      const targetId = asString(ctx.args[0]);
      if (!targetId) return '请提供要引入的快照 id，例如：`dcb snap_a1b2c3`。';

      const outcome = await deps.service.buildImport({ snapshotId: targetId, mode: 'inject' });
      if (!outcome) {
        return `未找到快照 \`${targetId}\`。先用 \`/snapshot.search\` 或 \`/snapshot.list\` 定位。`;
      }
      deps.injector(ctx.agent, outcome.brief);
      return [
        `✅ 已一键引入快照 \`${outcome.snapshotId}\``,
        `- token 估算：${outcome.tokenEstimate}`,
        '',
        '已作为只读背景情报注入，新对话的产出不会回写该快照。',
      ].join('\n');
    }),
  });
}
