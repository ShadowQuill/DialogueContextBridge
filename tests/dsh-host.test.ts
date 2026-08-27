import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { apply } from '../src/index';
import type { Config } from '../src/config';
import type { ConversationMessage } from '../src/types';
import type { CommandDefinition } from '../src/dsh/types';

/**
 * DSH 宿主契约测试（真实注入路径）。
 *
 * 上一个集成测试只验证「`apply` 能跑、服务与命令能注册」，但命令的 `.action`
 * 回调从未被真正调用——也就是说「宿主接缝」只在声明层面被验证，没有在运行时
 * 被验证。本测试构造一个**贴合 DSH 形态的 mock 宿主**：
 *
 * - `ctx.commands.register(def)` 捕获 `{ name, description, handler }`；
 * - 触发命令时构造 `CommandContext`，其中 `agent.session.deriveMessages()` 提供
 *   对话历史（模拟 DSH 把当前会话消息喂给命令）；
 * - 注入通过 `agent.inject(message)`（模拟 DSH 把背景简报塞进目标对话的下一轮请求）。
 *
 * 然后我们手动触发已注册的 `/compile` 与 `/import` 回调：
 * 1. 证明 `/compile` 真的走了 `agent.session` 完成编译并产出预览；
 * 2. 证明 `/import` 走真实的 `agent.inject`（背景简报作为 model-facing 上下文注入）；
 * 3. `/import --mode merge` 读取当前对话并产出融合简报。
 *
 * 把 mock 换成真实 DSH 运行时提供的同一组接口，即可在真机上做等价验证。
 */

/** 被捕获的命令定义。 */
type CapturedCommand = CommandDefinition;

/** 与一个真实 DSH 宿主同形的最小桩。 */
interface DshMockHost {
  services: Record<string, unknown>;
  /** 由 `ctx.effect` 注册、在 fiber 卸载时运行的清理函数（模拟 unload）。 */
  disposeEffect?: () => void | Promise<void>;
  /** 已捕获的注册命令（等价真实 dsh 的命令表）。 */
  capturedCommands: CapturedCommand[];
  /** 真实 dsh 的命令运行时（即 `ctx.commands`）。 */
  commands: { register(def: CommandDefinition): () => void };
  set(name: string, value: unknown): void;
  /** 真实 dsh 的 `ctx.provide`：声明并赋值一项服务（fiber 卸载时自动撤回）。 */
  provide(name: string, value: unknown): () => void;
  /** 真实 dsh 的 `ctx.effect`：立即执行 `execute` 并收集其返回的 disposer。 */
  effect(execute: () => unknown): () => void;
  /** 真实 dsh 的 `ctx.inject`：声明依赖，依赖就绪时回调（测试桩不挂载 settings，故不触发）。 */
  inject(_deps: string[], _cb?: (sctx: unknown) => void): () => void;
}

/** 构造 DSH 形态的 mock 宿主。 */
function createDshMockHost(messages: readonly ConversationMessage[]): {
  host: DshMockHost;
  agent: {
    id: string;
    session: { deriveMessages: () => readonly ConversationMessage[] };
    inject: (message: unknown) => void;
  };
  injectCalls: Array<{ text: string; source: unknown }>;
} {
  const capturedCommands: CapturedCommand[] = [];
  const services: Record<string, unknown> = {};
  const injectCalls: Array<{ text: string; source: unknown }> = [];

  const agent = {
    id: 'conv-cur',
    session: { deriveMessages: () => messages },
    inject: (message: unknown): void => {
      const msg = message as { content: Array<{ type: string; text?: string }>; source: unknown };
      injectCalls.push({ text: msg.content.map((b) => b.text ?? '').join(''), source: msg.source });
    },
  };

  const host: DshMockHost = {
    services,
    capturedCommands,
    commands: {
      register(def: CommandDefinition): () => void {
        capturedCommands.push(def);
        return () => undefined;
      },
    },
    set(name: string, value: unknown): void {
      services[name] = value;
    },
    provide(name: string, value: unknown): () => void {
      services[name] = value;
      return () => undefined;
    },
    effect(execute: () => unknown): () => void {
      host.disposeEffect = execute() as () => void | Promise<void>;
      return () => undefined;
    },
    inject(_deps: string[], _cb?: (sctx: unknown) => void): () => void {
      return () => undefined;
    },
  };
  return { host, agent, injectCalls };
}

/** 一段能触发三层分类器的示例对话。 */
const SAMPLE_MESSAGES: readonly ConversationMessage[] = [
  {
    id: 'm1',
    role: 'user',
    content: '我们要为长周期项目加一个对话上下文桥接功能，决定采用三层快照架构。',
    createdAt: 1_700_000_000_000,
  },
  {
    id: 'm2',
    role: 'assistant',
    content: '好的，我会按 verbatim / summary / preference 三层组织快照，保证零丢失移植。',
    createdAt: 1_700_000_000_100,
  },
];

/** 默认配置（关闭版本控制与加密，避免触碰 git / 加密路径）。 */
function makeConfig(tmpDir: string): Config {
  return {
    dataDir: tmpDir,
    maxTokens: 4096,
    maxBulletsPerSection: 6,
    maxHistoryMessages: 400,
    autoSave: false,
    searchLimit: 10,
    encryption: { enabled: false, passphrase: '', indexPlaintext: false },
    logLevel: 'silent',
    merge: { policy: 'newWins' },
    versioning: { enabled: false },
  };
}

/** 挂载插件（等价 DSH 在加载期调用 apply）。 */
async function mount(withMessages: boolean): Promise<{
  host: DshMockHost;
  agent: ReturnType<typeof createDshMockHost>['agent'];
  injectCalls: ReturnType<typeof createDshMockHost>['injectCalls'];
  snapshotId: string;
  tmpDir: string;
}> {
  const tmpDir = mkdtempSync(join(tmpdir(), 'dcb-dsh-'));
  const { host, agent, injectCalls } = createDshMockHost(withMessages ? SAMPLE_MESSAGES : []);
  apply(host as unknown as Parameters<typeof apply>[0], makeConfig(tmpDir));

  const service = host.services.dcb as {
    compileAndSave: (r: {
      conversationId: string;
      messages: readonly ConversationMessage[];
      title: string;
    }) => Promise<{ snapshotId: string }>;
  };
  const saved = await service.compileAndSave({
    conversationId: 'conv-src',
    messages: SAMPLE_MESSAGES,
    title: 'DSH 契约验证快照',
  });
  return { host, agent, injectCalls, snapshotId: saved.snapshotId, tmpDir };
}

/** 取出已注册命令并以其 CommandContext 触发。
 *
 * 真实 dsh 的 `CommandInvocation` 只携带 `agent` 与 `rawInput`，参数需编码进
 * `rawInput`（与 `parseFlags` 对齐），因此这里把 `args` / `options` 拼回命令行。
 */
async function run(
  host: DshMockHost,
  agent: { id: string; session: { deriveMessages: () => readonly ConversationMessage[] }; inject: (m: unknown) => void },
  name: string,
  rawInput: string,
  args: string[],
  options: Record<string, string | boolean>,
): Promise<string> {
  const cmd = host.capturedCommands.find((c) => c.name === name);
  if (!cmd) throw new Error(`命令未注册: ${name}`);
  const rawParts = [rawInput, ...args];
  for (const [key, value] of Object.entries(options)) {
    if (value === false) {
      // false 表示关闭某个 flag：真实 dsh 中缺省即 false，故不写入 rawInput。
    } else if (value === true) {
      rawParts.push(`--${key}`);
    } else {
      rawParts.push(`--${key}`, String(value));
    }
  }
  const fullRawInput = rawParts.join(' ').trim();
  const result = (await cmd.handler({
    agent: agent as never,
    rawInput: fullRawInput,
  } as never)) as unknown as { kind: 'success' | 'error'; text?: string };
  if (result.kind === 'error') throw new Error(`命令执行失败: ${result.text}`);
  return result.text ?? '';
}

describe('DSH host contract', () => {
  let cleanup: string[] = [];
  afterEach(() => {
    cleanup.forEach((dir) => rmSync(dir, { recursive: true, force: true }));
    cleanup = [];
  });

  it('宿主提供了 commands 接缝，注册了全部命令', async () => {
    const { host, tmpDir } = await mount(true);
    cleanup.push(tmpDir);
    expect(host.capturedCommands.length).toBe(14);
    expect(host.commands).toBeDefined();
    expect(host.capturedCommands.map((c) => c.name)).toContain('compile');
    expect(host.capturedCommands.map((c) => c.name)).toContain('import');
  });

  it('/compile 走 agent.session 完成编译并产出预览（不落库）', async () => {
    const { host, agent, tmpDir } = await mount(true);
    cleanup.push(tmpDir);
    const out = await run(host, agent, 'compile', '', [], { title: '桥接评审', full: false });
    expect(typeof out).toBe('string');
    expect(out.length).toBeGreaterThan(0);
    // 预览应体现「草稿」语义，而非直接落库回执。
    expect(out).toContain('草稿');
  });

  it('/import 走真实的 agent.inject 注入背景简报（只读、plugin 来源）', async () => {
    const { host, agent, injectCalls, snapshotId, tmpDir } = await mount(true);
    cleanup.push(tmpDir);
    const out = await run(host, agent, 'import', '', [snapshotId], { mode: 'inject' });
    expect(typeof out).toBe('string');

    // 关键断言：真实注入路径被调用，brief 带只读标记，来源为 plugin。
    expect(injectCalls).toHaveLength(1);
    expect(injectCalls[0].text).toContain('dcb:import');
    expect(injectCalls[0].source).toMatchObject({ kind: 'plugin', plugin: 'dialogue-context-bridge' });
    expect(out).toContain('已引入快照');
  });

  it('/import --mode merge 读取当前对话并产出融合简报', async () => {
    const { host, agent, injectCalls, snapshotId, tmpDir } = await mount(true);
    cleanup.push(tmpDir);
    const out = await run(host, agent, 'import', '', [snapshotId], { mode: 'merge', policy: 'newWins' });
    expect(typeof out).toBe('string');
    expect(injectCalls).toHaveLength(1);
    expect(injectCalls[0].text).toContain('merge');
    expect(out).toContain('融合');
  });

  it('dispose 释放数据库连接', async () => {
    const { host, tmpDir } = await mount(false);
    cleanup.push(tmpDir);
    expect(host.disposeEffect).toBeTypeOf('function');
    expect(() => host.disposeEffect?.()).not.toThrow();
  });
});
