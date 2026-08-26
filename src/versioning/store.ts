import { mkdirSync, writeFileSync } from 'node:fs';
import type { GitRunner } from './git';

/** 单条快照版本历史记录。 */
export interface VersionEntry {
  /** 提交引用（git 哈希或内存假实现的 `rN`）。 */
  ref: string;
  /** 提交日期（YYYY-MM-DD）。 */
  date: string;
  /** 提交信息。 */
  message: string;
}

/** 版本控制控制器依赖。 */
export interface VersioningControllerDeps {
  /** 快照 markdown 落盘的数据目录（也是 git 仓库根）。 */
  dataDir: string;
  /** git 运行器（CLI 或内存假实现）。 */
  git: GitRunner;
  /** 是否启用版本控制；关闭时所有方法均为 no-op。 */
  enabled: boolean;
}

/**
 * 记忆库版本控制控制器。
 *
 * 设计取舍：**被版本化的是快照的 Markdown 明文**（即本插件自描述的可移植知识单元），
 * 而非 SQLite 二进制。原因有三：
 *
 * 1. 快照本质就是「可移植的纯文本知识单元」，Markdown 是其规范形态；
 * 2. git 的差异/回滚对明文才有意义，对二进制 SQLite 几乎无法 review；
 * 3. SQLite（开启加密时）是运行时索引/缓存，git 历史只负责「记忆内容」的可追溯性。
 *
 * 因此若启用了 AES-256-GCM 静态加密且**要求历史也不落明文**，应关闭本功能——这是
 * 一条明确的安全权衡，由用户通过设置项决定。
 */
export interface VersioningController {
  /** 是否启用。 */
  readonly enabled: boolean;
  /** 保存后记录一次提交（写入 `<id>.md` 并 commit）。 */
  recordSave(snapshotId: string, markdown: string): Promise<void>;
  /** 删除后记录一次提交（移除文件并 commit 删除）。 */
  recordRemove(snapshotId: string): Promise<void>;
  /** 列出某个快照的提交历史（最新在前）。 */
  history(snapshotId: string): Promise<VersionEntry[]>;
  /** 读取某次提交中该快照的 markdown 内容。 */
  readAtRef(snapshotId: string, ref: string): Promise<string | undefined>;
}

/** 快照文件名（相对数据目录）。 */
const fileOf = (snapshotId: string): string => `${snapshotId}.md`;

/**
 * 创建版本控制控制器。
 *
 * @param deps - 数据目录、git 运行器与开关。
 * @returns 控制器实例。
 */
export function createVersioningController(deps: VersioningControllerDeps): VersioningController {
  const { dataDir, git, enabled } = deps;
  const noop = (): Promise<void> => Promise.resolve();

  if (!enabled) {
    return {
      enabled: false,
      recordSave: noop,
      recordRemove: noop,
      history: async () => [],
      readAtRef: async () => undefined,
    };
  }

  const ensureRepo = async (): Promise<void> => {
    mkdirSync(dataDir, { recursive: true });
    await git.run(['init']);
  };

  const commit = async (file: string, message: string): Promise<void> => {
    await git.run(['add', file]);
    await git.run(['commit', '-m', message]);
  };

  return {
    enabled: true,

    async recordSave(snapshotId: string, markdown: string): Promise<void> {
      await ensureRepo();
      const file = fileOf(snapshotId);
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(`${dataDir}/${file}`, markdown, 'utf8');
      await commit(file, `snapshot ${snapshotId}: save`);
    },

    async recordRemove(snapshotId: string): Promise<void> {
      // 用 `git rm` 同时删除工作区文件并暂存删除，CLI 与内存 runner 行为一致。
      await git.run(['rm', fileOf(snapshotId)]);
      await commit(fileOf(snapshotId), `snapshot ${snapshotId}: remove`);
    },

    async history(snapshotId: string): Promise<VersionEntry[]> {
      const file = fileOf(snapshotId);
      const result = await git.run([
        'log',
        '--pretty=format:%H%x1f%ad%x1f%s',
        '--date=short',
        '--',
        file,
      ]);
      if (result.code !== 0 || !result.stdout.trim()) return [];
      return result.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [ref, date, ...rest] = line.split('\u001f');
          return { ref: ref ?? '', date: date ?? '', message: rest.join('\u001f') };
        });
    },

    async readAtRef(snapshotId: string, ref: string): Promise<string | undefined> {
      const result = await git.run(['show', `${ref}:${fileOf(snapshotId)}`]);
      if (result.code !== 0) return undefined;
      return result.stdout;
    },
  };
}
