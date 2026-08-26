import { registerCompileCommand } from './compile';
import { registerImportCommand } from './import';
import { registerManageCommands } from './manage';
import { registerSaveCommand } from './save';
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
 * | `/snapshot.search` | 关键词检索快照（FTS5） |
 * | `/snapshot.list` | 列出快照 |
 * | `/snapshot.show` | 查看快照完整文档 |
 * | `/snapshot.remove` | 删除快照 |
 * | `/import` | 把历史快照作为背景情报引入当前对话（Phase 2） |
 *
 * @param deps - 命令依赖。
 */
export function registerCommands(deps: CommandDeps): void {
  registerCompileCommand(deps);
  registerSaveCommand(deps);
  registerSearchCommand(deps);
  registerManageCommands(deps);
  registerImportCommand(deps);
}
