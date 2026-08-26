import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** 单次 git 调用的结果。 */
export interface GitResult {
  /** 退出码。 */
  code: number;
  /** 标准输出。 */
  stdout: string;
  /** 标准错误。 */
  stderr: string;
}

/**
 * Git 命令运行器抽象。
 *
 * 把「对某个工作目录执行 git 子命令」抽象成一个可注入的函数，便于在测试中使用
 * 内存假实现，而不依赖真实 git 二进制或触碰文件系统。
 */
export interface GitRunner {
  /** 在工作目录内执行 `git <args>`。 */
  run(args: readonly string[]): Promise<GitResult>;
}

/** 运行器配置。 */
export interface CliGitRunnerOptions {
  /** 工作目录（数据目录）。 */
  cwd: string;
  /** 是否允许 git 输出非 ASCII 文件名（默认 false，统一用 core.quotepath=false）。 */
  quietPath?: boolean;
}

/**
 * 创建基于真实 git 二进制的运行器。
 *
 * 每次调用都会带上 `--no-pager` 与 `core.quotepath=false`，保证日志/历史中的
 * 中文文件名与提交信息不被转义，便于后续解析。
 *
 * @param options - 工作目录等配置。
 * @returns Git 运行器。
 */
export function createCliGitRunner(options: CliGitRunnerOptions): GitRunner {
  const { cwd } = options;
  return {
    async run(args: readonly string[]): Promise<GitResult> {
      try {
        const { stdout, stderr } = await execFileAsync('git', [
          '-C', cwd,
          '--no-pager',
          '-c', 'core.quotepath=false',
          ...args,
        ], { maxBuffer: 1024 * 1024 });
        return { code: 0, stdout: stdout ?? '', stderr: stderr ?? '' };
      } catch (error) {
        const err = error as { code?: number; stdout?: string; stderr?: string };
        const { code, stdout, stderr } = err;
        return {
          code: typeof code === 'number' ? code : 1,
          stdout: stdout ?? '',
          stderr: stderr ?? String(error),
        };
      }
    },
  };
}

/**
 * 创建内存假运行器（仅供测试）。
 *
 * 它是一个**忠实但无需 git 二进制**的模型：`add` 时会从真实文件系统读取对应文件
 * 内容（因为控制器把快照 markdown 写到了数据目录），其余提交/历史/读取都在内存中
 * 维护。支持的最小命令子集：`init`、`add <file>`、`commit -m <msg>`、`rm <file>`、
 * `log -- <file>`（`--pretty=format:%H%x1f%ad%x1f%s`、`--date=short`）、
 * `show <ref>:<file>`、`rev-parse HEAD`。提交以自增序号 `rN` 作为 ref。
 *
 * @param cwd - 数据目录（与控制器写入 markdown 的目录一致），`add` 据此读取内容。
 * @returns Git 运行器（内存实现）。
 */
export function createMemoryGitRunner(cwd: string): GitRunner {
  /** 单条提交记录。 */
  interface Commit {
    /** 自增引用，如 `r1`。 */
    ref: string;
    /** 提交信息。 */
    message: string;
    /** 提交日期（YYYY-MM-DD）。 */
    date: string;
    /** 该提交中文件内容的快照。 */
    files: Map<string, string>;
  }

  /** 已提交记录（按提交顺序）。 */
  const commits: Commit[] = [];
  /** 当前工作区文件内容。 */
  const working = new Map<string, string>();
  /** 已暂存文件集合。 */
  let staged: string[] = [];
  let seq = 0;

  const readFromDisk = (file: string): string | undefined => {
    try {
      return readFileSync(join(cwd, file), 'utf8');
    } catch {
      return undefined;
    }
  };

  const snapshot = (files: Iterable<string>): Map<string, string> => {
    const map = new Map<string, string>();
    for (const f of files) {
      const content = working.get(f);
      if (content !== undefined) map.set(f, content);
    }
    return map;
  };

  const today = (): string => new Date().toISOString().slice(0, 10);

  return {
    async run(args: readonly string[]): Promise<GitResult> {
      const cmd = args[0];
      if (cmd === 'init') return { code: 0, stdout: '', stderr: '' };

      if (cmd === 'add') {
        for (const file of args.slice(1)) {
          const content = readFromDisk(file);
          if (content !== undefined) working.set(file, content);
          staged = [...new Set([...staged, file])];
        }
        return { code: 0, stdout: '', stderr: '' };
      }

      if (cmd === 'rm') {
        // `git rm` 删除工作区文件并暂存删除（内存模型只删 working 映射）。
        for (const f of args.slice(1)) working.delete(f);
        return { code: 0, stdout: '', stderr: '' };
      }

      if (cmd === 'commit') {
        const idx = args.indexOf('-m');
        const message = idx >= 0 ? args[idx + 1] ?? '' : '';
        const files = staged.length > 0 ? staged : [...working.keys()];
        const ref = `r${seq + 1}`;
        commits.push({ ref, message, date: today(), files: snapshot(files) });
        seq += 1;
        staged = [];
        return { code: 0, stdout: ref, stderr: '' };
      }

      if (cmd === 'rev-parse' && args[1] === 'HEAD') {
        const last = commits[commits.length - 1];
        return { code: last ? 0 : 1, stdout: last ? last.ref : '', stderr: '' };
      }

      if (cmd === 'log') {
        // 约定格式：git log --pretty=format:%H%x1f%ad%x1f%s --date=short -- <file>
        const file = args[args.length - 1];
        const lines: string[] = [];
        for (let i = commits.length - 1; i >= 0; i -= 1) {
          const commit = commits[i] as Commit;
          if (commit.files.has(file)) {
            lines.push(`${commit.ref}\u001f${commit.date}\u001f${commit.message}`);
          }
        }
        return { code: 0, stdout: lines.join('\n'), stderr: '' };
      }

      if (cmd === 'show') {
        const target = args[1] ?? '';
        const sep = target.indexOf(':');
        const ref = target.slice(0, sep);
        const file = target.slice(sep + 1);
        const commit = commits.find((c) => c.ref === ref);
        if (!commit) return { code: 1, stdout: '', stderr: 'unknown ref' };
        const content = commit.files.get(file);
        if (content === undefined) return { code: 1, stdout: '', stderr: 'no such file' };
        return { code: 0, stdout: content, stderr: '' };
      }

      return { code: 1, stdout: '', stderr: `unsupported git command: ${String(cmd)}` };
    },
  };
}
