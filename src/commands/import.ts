import type { ImportMode, MergePolicy } from '../core/inject';
import {
  createSessionInjector,
  type InjectionService,
} from '../dsh/types';
import { asString, guard, loadMessages, type CommandDeps } from './shared';
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
 * - 默认走「仅新信息」模式——快照被渲染为只读背景简报，注入当前对话的系统
 *   提示头部，新对话的产出不会回写快照；
 * - `--mode merge` 走 Phase 3 融合：需读取当前对话历史（宿主提供对话服务），
 *   把快照三层与当前上下文融合；偏好冲突按 `--policy` 裁决（默认取配置
 *   `merge.policy`，即「新信息覆盖旧信息」）；
 * - `--policy snapshotWins` 让历史快照优先；`--policy timestamp` 按时间/显式权重裁决；
 * - `--dry-run` 只预览简报，不实际注入，方便用户确认内容；
 * - 注入优先使用宿主的 `injector` 能力，缺失时降级为以消息形式下发。
 *
 * @param deps - 命令依赖。
 */
export function registerImportCommand(deps: CommandDeps): void {
  deps.registry('import <snapshotId:text>', '把历史快照作为背景情报引入当前对话')
    .usage(
      [
        '从本地记忆库取出某个快照，渲染为只读背景简报并注入当前对话的系统提示。',
        '默认「仅新信息」模式：新对话的产出不会回写该快照。',
        '加 `--mode merge` 可启用 Phase 3 融合（需宿主提供对话历史）。',
        '加 `--policy <newWins|snapshotWins|timestamp>` 指定合并冲突裁决规则。',
        '加 `--dry-run` 仅预览简报，不注入。',
      ].join('\n'),
    )
    .example('/import snap_a1b2c3')
    .example('/import snap_a1b2c3 --mode merge')
    .example('/import snap_a1b2c3 --mode merge --policy snapshotWins')
    .example('/import snap_a1b2c3 --dry-run')
    .option('mode', '--mode <mode:string>', { description: '导入模式：inject（默认）或 merge' })
    .option('policy', '--policy <policy:string>', {
      description: 'merge 模式冲突裁决：newWins（默认）/ snapshotWins / timestamp',
    })
    .option('dryRun', '-d, --dry-run', { description: '仅预览简报，不实际注入' })
    .action(
      guard(deps.logger, '/import', async (argv, snapshotId) => {
        const targetId = asString(snapshotId);
        if (!targetId) return '请提供要引入的快照 id，例如：`/import snap_a1b2c3`。';

        const mode = resolveMode(asString(argv.options.mode));
        const policy = resolvePolicy(asString(argv.options.policy));
        const dryRun = argv.options.dryRun === true || argv.options.dryRun === 'true';

        let currentMessages: ConversationMessage[] | undefined;
        if (mode === 'merge') {
          try {
            currentMessages = await loadMessages(deps, argv.session.conversationId);
          } catch {
            return [
              '⚠️ `--mode merge` 需要读取当前对话历史，但宿主未提供对话服务。',
              '请改用默认 `inject` 模式，或为宿主启用对话读取能力。',
            ].join('\n');
          }
        }

        const outcome = await deps.service.buildImport({
          snapshotId: targetId,
          mode,
          currentMessages,
          currentConversationId: argv.session.conversationId,
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

        const injector: InjectionService = deps.injector ?? createSessionInjector(argv.session);
        injector.inject(argv.session.conversationId, outcome.brief);

        const note =
          mode === 'merge'
            ? `已按 Phase 3 融合（裁决规则 \`${policy}\`，自动裁决 ${outcome.conflictCount} 处冲突）后注入。`
            : '已作为只读背景情报注入，新对话的产出不会回写该快照。';
        return [
          `✅ 已引入快照 \`${outcome.snapshotId}\``,
          `- 模式：${outcome.mode}`,
          `- token 估算：${outcome.tokenEstimate}`,
          `- 注入方式：${deps.injector ? '宿主系统提示注入' : '会话消息降级下发'}`,
          '',
          note,
        ].join('\n');
      }),
    );

  // 一键导入别名：省掉 `/import` 的子命令记忆成本，直接 `/dcb <id>` 即「仅新信息」注入。
  deps.registry('dcb <snapshotId:text>', '一键引入历史快照（等价 /import inject，只读背景情报）')
    .alias('import.now')
    .usage('最常用的导入路径：把某个快照作为只读背景注入当前对话，不回写快照。')
    .example('dcb snap_a1b2c3')
    .action(
      guard(deps.logger, '/dcb', async (argv, snapshotId) => {
        const targetId = asString(snapshotId);
        if (!targetId) return '请提供要引入的快照 id，例如：`dcb snap_a1b2c3`。';

        const outcome = await deps.service.buildImport({ snapshotId: targetId, mode: 'inject' });
        if (!outcome) {
          return `未找到快照 \`${targetId}\`。先用 \`/snapshot.search\` 或 \`/snapshot.list\` 定位。`;
        }
        const injector: InjectionService = deps.injector ?? createSessionInjector(argv.session);
        injector.inject(argv.session.conversationId, outcome.brief);
        return [
          `✅ 已一键引入快照 \`${outcome.snapshotId}\``,
          `- token 估算：${outcome.tokenEstimate}`,
          `- 注入方式：${deps.injector ? '宿主系统提示注入' : '会话消息降级下发'}`,
          '',
          '已作为只读背景情报注入，新对话的产出不会回写该快照。',
        ].join('\n');
      }),
    );
}
