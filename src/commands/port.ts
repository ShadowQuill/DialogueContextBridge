import { asFlag, asString, guard, type CommandDeps } from './shared';
import { actionList, card, kvTable } from './card';

/**
 * 快照文件导入 / 导出命令。
 *
 * `/dcb-export` 把记忆库中的快照写成独立 `.md` 文件（明文、自描述 Schema 头），
 * 可直接拷贝到另一台机器或账号后由 `/dcb-import` 接手——这是 spec 要求的
 * 「可迁移性」超越聊天内复制粘贴的形态。
 *
 * @packageDocumentation
 */

/**
 * 注册导出 / 导入命令。
 *
 * | 命令 | 作用 |
 * | --- | --- |
 * | `/dcb-export <id>` | 导出单个快照为 `.md` 文件 |
 * | `/dcb-export --all` | 导出记忆库全部快照 |
 * | `/dcb-import <path>` | 从 `.md` 文件导入快照到记忆库 |
 *
 * @param deps - 命令依赖。
 */
export function registerPortCommands(deps: CommandDeps): void {
  // 导出：单条或全量。
  deps.registry({
    name: 'dcb-export',
    description: '导出快照为独立 .md 文件（跨设备 / 跨账号可移植）',
    handler: guard(deps.logger, '/dcb-export', async (ctx) => {
      const id = asString(ctx.args[0]);
      const all = asFlag(ctx.options.all) || asFlag(ctx.options.a);
      const outDir = asString(ctx.options.out) ?? asString(ctx.options.o);
      if (!id && !all) {
        return '请提供快照 id（`/dcb-export <id>`）或加 `--all` 导出全部。';
      }

      if (all) {
        const results = deps.service.exportAll(outDir);
        if (results.length === 0) return '📭 记忆库暂无快照可导出。';
        return card({
          icon: '📦',
          title: `已导出 ${results.length} 条快照`,
          subtitle: outDir ? `落盘目录：${outDir}` : '落盘目录：<dataDir>/exports',
          body: kvTable(results.map((r) => [r.snapshotId, r.path] as [string, string])),
        });
      }

      const r = deps.service.exportSnapshot(id!, outDir);
      return card({
        icon: '📄',
        title: `已导出快照 ${r.snapshotId}`,
        subtitle: r.encrypted ? '源快照为密文，已在本机解密为明文文件' : undefined,
        body: kvTable([
          ['标题', r.title],
          ['Token 估算', String(r.tokenEstimate)],
          ['格式', '明文 .md（可被任意 Agent 接手）'],
          ['文件', r.path],
        ]),
      });
    }),
  });

  // 导入：从文件落库。
  deps.registry({
    name: 'dcb-import',
    description: '从 .md 文件导入快照到记忆库（自动分配新 id，防覆盖）',
    handler: guard(deps.logger, '/dcb-import', async (ctx) => {
      const file = asString(ctx.args[0]);
      if (!file) return '请提供快照 .md 文件路径（`/dcb-import <path>`）。';
      const dryRun = asFlag(ctx.options.dryRun) || asFlag(ctx.options.d) || asFlag(ctx.options['dry-run']);

      const outcome = deps.service.importFile(file, { dryRun });
      if (dryRun) {
        return card({
          icon: '🔍',
          title: '[预演] 可导入快照',
          subtitle: outcome.intact ? '校验和一致' : '⚠️ 校验和不匹配，文档可能已被改动',
          body: kvTable([
            ['原 id', outcome.fromSnapshotId],
            ['标题', outcome.title],
            ['Token 估算', String(outcome.tokenEstimate)],
            ['将分配新 id', outcome.snapshotId],
          ]),
        });
      }
      return card({
        icon: '✅',
        title: `已导入快照 ${outcome.snapshotId}`,
        subtitle: outcome.intact ? '校验和一致' : '⚠️ 校验和不匹配，内容可能已被改动',
        body: kvTable([
          ['来源文件 id', outcome.fromSnapshotId],
          ['标题', outcome.title],
          ['Token 估算', String(outcome.tokenEstimate)],
          ['文件', file],
        ]),
        footerNote: actionList([
          ['/dcb <id>', '一键引入'],
          ['/snapshot-search <关键词>', '检索'],
        ]),
      });
    }),
  });
}
