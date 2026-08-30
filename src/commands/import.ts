import type { ImportMode, MergePolicy } from '../core/inject';
import type { AgentHandle } from '../dsh/types';
import type { BridgeService } from '../service';
import { asString, asFlag, guard, loadMessages, type CommandDeps } from './shared';
import type { ConversationMessage } from '../types';
import { actionList, card, kvTable, snapshotTable, KNOWN_LIMIT_TIP } from './card';

/** `/import` 不带 id 时，选择器卡片默认展示的最近快照条数。 */
const RECENT_PICKER_LIMIT = 10;

/** `/dcb` 主页通用的「如何唤起功能卡片」提示（极简，省 token）。 */
const LAUNCH_HINT = '🧭 选功能：输入框按 `/` 或点菜单按钮唤起命令面板，鼠标点选即执行（不经模型，零 token）。';

/** `/import` 与 `/dcb-merge` 共用的导入执行参数。 */
interface RunImportParams {
  readonly deps: CommandDeps;
  readonly agent: AgentHandle;
  readonly conversationId: string;
  readonly targetId: string;
  readonly mode: ImportMode;
  readonly policy: MergePolicy;
  readonly dryRun: boolean;
}

/**
 * 执行一次快照引入（Phase 2 注入 / Phase 3 融合），供 `/import` 与 `/dcb-merge` 复用。
 *
 * @returns 渲染后的纯文本卡片或提示。
 */
async function runImport(params: RunImportParams): Promise<string> {
  const { deps, agent, conversationId, targetId, mode, policy, dryRun } = params;

  let currentMessages: ConversationMessage[] | undefined;
  if (mode === 'merge') {
    try {
      currentMessages = await loadMessages(deps, agent.session);
    } catch {
      return [
        '⚠️ --mode merge 需要读取当前对话历史，但宿主未提供会话读取能力。',
        '请改用 inject 模式。',
      ].join('\n');
    }
  }

  const outcome = await deps.service.buildImport({
    snapshotId: targetId,
    mode,
    currentMessages,
    currentConversationId: conversationId,
    policy,
  });
  if (!outcome) {
    return `未找到快照 ${targetId}。先用 /snapshot-search 或 /snapshot.list 定位。`;
  }

  if (dryRun) {
    return [
      `🔍 导入预览（模式 ${outcome.mode}${
        outcome.mode === 'merge' ? `，策略 ${policy}，冲突 ${outcome.conflictCount}` : ''
      }，约 ${outcome.tokenEstimate} tokens）：`,
      '',
      '背景简报：',
      outcome.brief,
      '',
      '去掉 --dry-run 后重新执行即可注入当前对话。',
    ].join('\n');
  }

  deps.injector(agent, outcome.brief);

  const note =
    mode === 'merge'
      ? `已按 Phase 3 融合（裁决规则 ${policy}，自动裁决 ${outcome.conflictCount} 处冲突）后注入。`
      : '已作为只读背景情报注入，新对话的产出不会回写该快照。';
  const modeLabel =
    outcome.mode === 'merge'
      ? `merge（裁决 ${policy}）`
      : 'inject（仅新信息）';
  return card({
    icon: '✅',
    title: `已引入快照 ${outcome.snapshotId}`,
    subtitle: note,
    body: kvTable([
      ['模式', modeLabel],
      ['Token 估算', String(outcome.tokenEstimate)],
      ['冲突裁决', outcome.mode === 'merge' ? `${outcome.conflictCount} 处` : '—'],
    ]),
    footerNote: KNOWN_LIMIT_TIP,
  });
}

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
  if (raw === 'snapshotWins' || raw === 'timestamp' || raw === 'weighted') return raw;
  return 'newWins';
}

/**
 * 渲染「模式选择」引导（不带 `--mode` 时返回，替代 spec 里的交互式选择界面）。
 *
 * dsh 0.1.x 命令是 fire-and-respond，没有交互式 prompt 原语，因此用一次性
 * 引导文案让用户显式选模式，并把可直接复制的命令示例列出来。
 *
 * @param id - 目标快照 id。
 * @returns Markdown 引导文案。
 */
function buildModePicker(id: string): string {
  return [
    '🔀 请选择导入模式（/import 不会自动注入，需显式指定 --mode）：',
    '',
    '① 仅新信息 —— 快照作为只读背景情报注入，新对话的产出不回写快照：',
    `   /import ${id} --mode inject`,
    '   或一键别名：',
    `   /dcb ${id}`,
    '',
    '② 合并 —— 把快照三层与当前对话上下文融合，含偏好冲突自动裁决：',
    `   /import ${id} --mode merge`,
    '   可选冲突裁决规则（默认 newWins）：',
    '   --policy newWins    当前对话胜（新信息覆盖旧信息）',
    '   --policy snapshotWins 历史快照胜',
    '   --policy timestamp  按时间先后 / 显式权重裁决',
    '   --policy weighted   按 /snapshot-weight 标记的用户权重裁决（高者胜）',
    '',
    '💡 先用 --dry-run 预览融合结果，确认后再去掉该标志执行：',
    `   /import ${id} --mode merge --dry-run`,
  ].join('\n');
}

/**
 * 渲染「最近 N 条快照」选择器（DSH 0.1.x 无参数补全 / 下拉 API，故以卡片列出
 * 可复制命令来「绕开手打 id 的气泡摩擦」）。
 *
 * 关键约束：DSH 0.1.x 的 `CommandDefinition` 仅支持 `name/description/input/
 * handler`，**没有参数补全或下拉选择器**；且手打带参命令会触发 rc.2 框架的
 * 「执行中…」常驻气泡。因此本卡片用「列出最近快照 + 可复制命令」替代真正的
 * 气泡内点选；同时给出两个**完全无参**命令 `/dcb-import-last` / `/dcb-merge-last`，
 * 由命令面板点选即执行、零手打、零气泡（README「已知限制」明确无参命令无此现象）。
 *
 * @param service - 桥接服务，用于列出最近快照。
 * @returns Markdown 选择器卡片。
 */
function buildRecentPicker(service: BridgeService): string {
  const snapshots = service.list(RECENT_PICKER_LIMIT);
  if (snapshots.length === 0) {
    return card({
      icon: '📭',
      title: '记忆库暂无快照',
      body: [
        '先用 /compile 编译当前对话，再 /save 落库；或 /dcb-save 一键导出。',
        '',
        LAUNCH_HINT,
      ].join('\n'),
      footerNote: KNOWN_LIMIT_TIP,
    });
  }
  const rows = snapshots.map((s) => ({
    id: s.snapshotId,
    title: s.title,
    tokens: s.tokenEstimate,
    status: s.encrypted ? '🔒 加密' : '明文',
  }));
  return card({
    icon: '🗂️',
    title: `选择要引入的快照（最近 ${snapshots.length} 条）`,
    subtitle: '复制下方任一 ID 运行，或直接用无参命令免手打',
    body: [
      snapshotTable(rows),
      '',
      '引入方式（把 <id> 换成上表 ID）：',
      '  /import <id> --mode inject           仅新信息（只读背景）',
      '  /import <id> --mode merge --dry-run  先预览融合，确认再去掉 --dry-run',
      '',
      '⚡ 免手打、零气泡（命令面板点选即执行）：',
      '  /dcb-import-last   一键引入最近一条（inject）',
      '  /dcb-merge-last    一键融合最近一条（merge）',
    ].join('\n'),
    footerNote: KNOWN_LIMIT_TIP,
  });
}

/**
 * 功能速查索引：在 `/` 命令面板里以卡片形式点选即可触发，不经模型、零 token。
 *
 * 作为 `/dcb` 导航主页的固定区块，让用户一眼看到全部能力并知道如何唤起。
 *
 * @returns Markdown 功能列表（紧凑 actionList）。
 */
function buildFunctionIndex(): string {
  return actionList([
    ['编译当前对话为草稿', '/compile'],
    ['保存草稿到记忆库', '/save'],
    ['一键导出当前对话', '/dcb-save'],
    ['引入快照（仅新信息）', '/dcb <id>'],
    ['一步融合快照（省一步）', '/dcb-merge <id>'],
    ['合并引入快照（显式）', '/import <id> --mode merge'],
    ['一键引入最近一条（免手打）', '/dcb-import-last'],
    ['一键融合最近一条（免手打）', '/dcb-merge-last'],
    ['检索记忆', '/snapshot-search <词>'],
    ['查看 / 列出快照', '/snapshot.list'],
    ['导出快照为文件', '/dcb-export <id>'],
    ['从文件导入快照', '/dcb-import <path>'],
  ]);
}

/**
 * 注册 `/import` 命令：把历史快照引入当前对话（Phase 2 导入注入 / Phase 3 合并）。
 *
 * 设计要点：
 * - **不带 `--mode`**：返回模式选择引导（见 {@link buildModePicker}），不注入——
 *   由用户显式选定模式后再执行，对应 spec 的「弹出模式选择界面」；
 * - `--mode inject`（或一键别名 `/dcb`）：「仅新信息」模式，快照渲染为只读背景
 *   简报，通过 `agent.inject()` 注入下一轮请求，新对话产出不回写；
 * - `--mode merge`：Phase 3 融合，需读取当前对话历史（通过 `agent.session`），
 *   把快照三层与当前上下文融合，偏好冲突按 `--policy` 裁决；
 * - `--policy snapshotWins` 让历史快照优先；`--policy timestamp` 按时间/显式权重裁决；
 * - `--dry-run` 只预览简报，不实际注入，方便确认内容。
 *
 * @param deps - 命令依赖。
 */
export function registerImportCommand(deps: CommandDeps): void {
  deps.registry({
    name: 'import',
    description: '引入历史快照：不带 --mode 时列出可选模式；--mode inject 仅注入只读背景，--mode merge 融合当前对话',
    input: {
      hint: '<快照id> --mode inject|merge [--policy newWins|snapshotWins|timestamp|weighted] [--dry-run]',
    },
    handler: guard(deps.logger, '/import', async (ctx) => {
      const targetId = asString(ctx.args[0]);
      if (!targetId) return buildRecentPicker(deps.service);

      // 未显式指定模式：返回模式选择引导，不自动注入（spec 的「弹出选择界面」等价物）。
      if (ctx.options.mode === undefined) {
        return buildModePicker(targetId);
      }

      return runImport({
        deps,
        agent: ctx.agent,
        conversationId: ctx.conversationId,
        targetId,
        mode: resolveMode(asString(ctx.options.mode)),
        policy: resolvePolicy(asString(ctx.options.policy)),
        dryRun: asFlag(ctx.options.dryRun),
      });
    }),
  });

  // 高频单步别名：/dcb-merge <id> = import --mode merge，少一次交互。
  // 一步到位融合当前对话，可选 --policy 裁决规则与 --dry-run 预览。
  deps.registry({
    name: 'dcb-merge',
    description: '一步到位融合快照：/dcb-merge <id> 等价于 /import <id> --mode merge，可选 --policy 与 --dry-run',
    input: {
      hint: '<快照id> [--policy newWins|snapshotWins|timestamp|weighted] [--dry-run]',
    },
    handler: guard(deps.logger, '/dcb-merge', async (ctx) => {
      const targetId = asString(ctx.args[0]);
      if (!targetId) return '请提供要融合的快照 id，例如：/dcb-merge snap_a1b2c3';

      return runImport({
        deps,
        agent: ctx.agent,
        conversationId: ctx.conversationId,
        targetId,
        mode: 'merge',
        policy: resolvePolicy(asString(ctx.options.policy)),
        dryRun: asFlag(ctx.options.dryRun),
      });
    }),
  });

  // 一键台：不带 id 时显示近期快照与快捷操作（Phase 4 UI 优化）；带 id 时等价
  // `/import inject`，省掉子命令记忆成本，直接 `/dcb <id>` 即「仅新信息」注入。
  deps.registry({
    name: 'dcb',
    description: '对话上下文桥接一键台：/dcb <id> 一键引入；不带 id 显示近期快照与快捷操作',
    input: {
      hint: '<快照id>  （不带 id 显示记忆库总览）',
    },
    handler: guard(deps.logger, '/dcb', async (ctx) => {
      const targetId = asString(ctx.args[0]);

      // 不带 id：仪表盘视图，提升命令面板的可见性与可发现性。
      if (!targetId) {
        const snapshots = deps.service.list(8);
        const { total } = deps.service.stats();
        if (snapshots.length === 0) {
        return card({
          icon: '📭',
          title: '记忆库暂无快照',
          body: [
          '先用 /compile 编译当前对话，再 /save 落库；或 /dcb-save 一键导出。',
          '',
          LAUNCH_HINT,
          '',
          buildFunctionIndex(),
          ].join('\n'),
          footerNote: KNOWN_LIMIT_TIP,
        });
        }
        const rows = snapshots.map((s) => ({
          id: s.snapshotId,
          title: s.title,
          tokens: s.tokenEstimate,
          status: s.encrypted ? '🔒 加密' : '明文',
        }));
        return card({
          icon: '🌉',
          title: `记忆库总览 · 共 ${total} 条`,
          body: [
            snapshotTable(rows),
            '',
            LAUNCH_HINT,
            '',
            buildFunctionIndex(),
          ].join('\n'),
          footerNote: KNOWN_LIMIT_TIP,
        });
      }

      const outcome = await deps.service.buildImport({ snapshotId: targetId, mode: 'inject' });
      if (!outcome) {
        return `未找到快照 ${targetId}。先用 /snapshot-search 或 /snapshot.list 定位。`;
      }
      deps.injector(ctx.agent, outcome.brief);
      return card({
        icon: '✅',
        title: `已一键引入快照 ${outcome.snapshotId}`,
        subtitle: '已作为只读背景情报注入，新对话的产出不会回写该快照',
        body: kvTable([
          ['模式', 'inject（仅新信息）'],
          ['Token 估算', String(outcome.tokenEstimate)],
          ['快照 ID', `${outcome.snapshotId}`],
        ]),
        footerNote: KNOWN_LIMIT_TIP,
      });
    }),
  });

  // 一键引入最近一条（inject），完全无参：命令面板点选即执行，免手打、零气泡。
  deps.registry({
    name: 'dcb-import-last',
    description: '一键引入最近一条快照（inject 只读背景）；无参、命令面板点选即执行，免手打、零气泡',
    handler: guard(deps.logger, '/dcb-import-last', async (ctx) => {
      const snapshots = deps.service.list(1);
      if (snapshots.length === 0) {
        return '记忆库暂无快照。先用 /compile + /save 或 /dcb-save 落库。';
      }
      const targetId = snapshots[0].snapshotId;
      const outcome = await deps.service.buildImport({ snapshotId: targetId, mode: 'inject' });
      if (!outcome) return `未找到快照 ${targetId}。`;
      deps.injector(ctx.agent, outcome.brief);
      return card({
        icon: '✅',
        title: `已一键引入最近快照 ${outcome.snapshotId}`,
        subtitle: '已作为只读背景情报注入，新对话的产出不会回写该快照',
        body: kvTable([
          ['模式', 'inject（仅新信息）'],
          ['Token 估算', String(outcome.tokenEstimate)],
          ['快照 ID', outcome.snapshotId],
        ]),
        footerNote: KNOWN_LIMIT_TIP,
      });
    }),
  });

  // 一键融合最近一条（merge），可选 --policy 与 --dry-run；无参点选即执行、零气泡。
  deps.registry({
    name: 'dcb-merge-last',
    description: '一键融合最近一条快照（merge）；无参、命令面板点选即执行，免手打、零气泡。可选 --policy 与 --dry-run',
    input: { hint: '[--policy newWins|snapshotWins|timestamp|weighted] [--dry-run]' },
    handler: guard(deps.logger, '/dcb-merge-last', async (ctx) => {
      const snapshots = deps.service.list(1);
      if (snapshots.length === 0) {
        return '记忆库暂无快照。先用 /compile + /save 或 /dcb-save 落库。';
      }
      return runImport({
        deps,
        agent: ctx.agent,
        conversationId: ctx.conversationId,
        targetId: snapshots[0].snapshotId,
        mode: 'merge',
        policy: resolvePolicy(asString(ctx.options.policy)),
        dryRun: asFlag(ctx.options.dryRun),
      });
    }),
  });
}
