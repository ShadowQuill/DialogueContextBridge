import { registerCompileCommand } from './compile';
import { registerImportCommand } from './import';
import { registerManageCommands } from './manage';
import { registerPortCommands } from './port';
import { registerSaveCommand, registerQuickSaveCommand } from './save';
import { registerSearchCommand } from './search';
import type { CommandDeps } from './shared';

export type { CommandDeps } from './shared';

/**
 * 注册本插件的全部命令。
 *
 * 命令集：
 * | 命令 | 作用 |
 * | --- | --- |
 * | `/compile` | 编译当前对话为三层快照草稿 |
 * | `/save` | 把草稿写入本地记忆库 |
 * | `/dcb-save` | 一键导出当前对话为可复制快照（Phase 4 一键操作） |
 * | `/dcb-export` | 把快照导出为独立 `.md` 文件（跨设备 / 跨账号可移植） |
 * | `/dcb-import` | 从 `.md` 文件导入快照到记忆库 |
 * | `/snapshot-search` | 关键词检索快照（FTS5） |
 * | `/snapshot-list` | 列出快照 |
 * | `/snapshot-show` | 查看快照完整文档 |
 * | `/snapshot-remove` | 删除快照 |
 * | `/snapshot-weight` | 查看 / 设置 / 清零快照合并权重（供 `--policy weighted`） |
 * | `/import` | 把历史快照作为背景情报引入当前对话（Phase 2） |
 * | `/dcb-merge` | 一步融合快照（等价 `/import <id> --mode merge`，高频单步别名） |
 * | `/dcb` | 一键台：带 id 一键引入；不带 id 显示近期快照与快捷操作（Phase 4） |
 *
 * @param deps - 命令依赖。
 */
export function registerCommands(deps: CommandDeps): void {
  registerCompileCommand(deps);
  registerSaveCommand(deps);
  registerQuickSaveCommand(deps);
  registerSearchCommand(deps);
  registerManageCommands(deps);
  registerImportCommand(deps);
  registerPortCommands(deps);
}
