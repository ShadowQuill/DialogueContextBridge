import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { apply } from '../src/index';
import type { Config } from '../src/config';
import type { ConversationMessage } from '../src/types';
import type {
  CommandBuilder,
  CommandOptionConfig,
  CommandRegistry,
  ConversationService,
  InjectionService,
} from '../src/dsh/types';

/**
 * DSH 宿主契约测试（真实注入路径）。
 *
 * 上一个集成测试只验证「`apply` 能跑、服务与命令能注册」，但命令的 `.action`
 * 回调从未被真正调用——也就是说「宿主接缝」只在声明层面被验证，没有在运行时
 * 被验证。本测试构造一个**贴合 DSH 形态的 mock 宿主**：
 *
 * - `ctx.command(decl, desc)` 记录声明，并返回链式构建器，最终把 `.action(cb)`
 *   回调捕获下来；
 * - `ctx.conversation.history()` 提供对话历史（模拟 DSH 把当前会话消息喂给命令）；
 * - `ctx.injector.inject(id, brief)` 记录系统提示注入调用（模拟 DSH 把背景简报
 *   塞进目标对话的系统上下文头部）。
 *
 * 然后我们手动触发已注册的 `/compile` 与 `/import` 回调：
 * 1. 证明 `/compile` 真的走了 `conversation` 服务完成编译并产出预览；
 * 2. 证明 `/import` 在宿主提供 `injector` 时，**走真实的 `InjectionService.inject`**
 *    （而非 `createSessionInjector` 的消息降级）；
 * 3. 反例：宿主不提供 `injector` 时，降级为 `session.send` 下发消息。
 *
 * 这正好对应「真实 DSH 宿主联调」要验证的最小契约：`command` / `conversation` /
 * `injector` 三个能力按预期工作。把 mock 换成真实 DSH 运行时提供的同一组接口，
 * 即可在真机上做等价验证。
 *
 * 注意：插件在 `apply` 时就把 `ctx.injector` 快照进 `deps.injector`（与真实宿主在
 * 加载期即提供能力一致），因此测试必须在 `apply` 之前就决定宿主是否带 injector。
 */

/** 被捕获的命令（含最终注册的 action 回调）。 */
interface CapturedCommand {
  declaration: string;
  description?: string;
  options: Record<string, CommandOptionConfig>;
  aliases: string[];
  actionHandler?: (argv: unknown, ...rest: string[]) => unknown;
}

/** 与一个真实 DSH 宿主同形的最小桩。 */
interface DshMockHost {
  services: Record<string, unknown>;
  disposeHandler?: () => void;
  commands: CapturedCommand[];
  command: CommandRegistry;
  conversation: ConversationService;
  injector?: InjectionService;
  injectCalls: Array<{ conversationId: string; brief: string }>;
  sentMessages: string[];
  set(name: string, value: unknown): void;
  on(event: string, handler: () => void): void;
}

/** 构造 DSH 形态的 mock 宿主。 */
function createDshMockHost(messages: readonly ConversationMessage[]): DshMockHost {
  const commands: CapturedCommand[] = [];
  const services: Record<string, unknown> = {};
  const injectCalls: Array<{ conversationId: string; brief: string }> = [];
  const sentMessages: string[] = [];

  const host: DshMockHost = {
    services,
    commands,
    injectCalls,
    sentMessages,
    set(name: string, value: unknown): void {
      services[name] = value;
    },
    on(event: string, handler: () => void): void {
      if (event === 'dispose') host.disposeHandler = handler;
    },
    command(declaration: string, description?: string): CommandBuilder {
      // `command` 为局部 const，构建器回调对其属性的改写不会触发 no-param-reassign。
      const captured: CapturedCommand = { declaration, description, options: {}, aliases: [] };
      commands.push(captured);
      const builder: CommandBuilder = {
        option(name: string, _declaration: string, config?: CommandOptionConfig): CommandBuilder {
          captured.options[name] = config ?? {};
          return builder;
        },
        alias(name: string): CommandBuilder {
          captured.aliases.push(name);
          return builder;
        },
        usage: () => builder,
        example: () => builder,
        action(handler: (argv: unknown, ...rest: string[]) => unknown): CommandBuilder {
          captured.actionHandler = handler;
          return builder;
        },
      };
      return builder;
    },
    conversation: {
      history: async () => messages as ConversationMessage[],
    },
  };
  return host;
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

/** 挂载插件（等价 DSH 在加载期调用 apply），并按需提供 injector 能力。 */
async function mount(withInjector: boolean): Promise<{ host: DshMockHost; snapshotId: string; tmpDir: string }> {
  const tmpDir = mkdtempSync(join(tmpdir(), 'dcb-dsh-'));
  const host = createDshMockHost(SAMPLE_MESSAGES);
  if (withInjector) {
    host.injector = {
      inject(conversationId: string, brief: string): void {
        host.injectCalls.push({ conversationId, brief });
      },
    };
  }
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
  return { host, snapshotId: saved.snapshotId, tmpDir };
}

describe('DSH host contract', () => {
  let cleanup: string[] = [];
  afterEach(() => {
    cleanup.forEach((dir) => rmSync(dir, { recursive: true, force: true }));
    cleanup = [];
  });

  it('宿主提供了完整的 command / conversation 接缝，injector 可选', async () => {
    const { host, tmpDir } = await mount(true);
    cleanup.push(tmpDir);
    expect(host.commands.length).toBe(10);
    expect(typeof host.conversation.history).toBe('function');
    expect(typeof host.injector?.inject).toBe('function');
  });

  it('/compile 走 conversation 服务完成编译并产出预览（不落库）', async () => {
    const { host, tmpDir } = await mount(false);
    cleanup.push(tmpDir);
    const compile = host.commands.find((c) => c.declaration === 'compile');
    expect(compile?.actionHandler).toBeTypeOf('function');

    const session = { conversationId: 'conv-cur', send: () => undefined };
    const out = await compile!.actionHandler!(
      { session, options: { title: '桥接评审', full: false }, args: [] },
    );
    expect(typeof out).toBe('string');
    expect((out as string).length).toBeGreaterThan(0);
    // 预览应体现「草稿」语义，而非直接落库回执。
    expect((out as string)).toContain('草稿');
  });

  it('/import 在宿主提供 injector 时走真实 InjectionService.inject（非降级）', async () => {
    const { host, snapshotId, tmpDir } = await mount(true);
    cleanup.push(tmpDir);
    const importCmd = host.commands.find((c) => c.declaration === 'import <snapshotId:text>');
    expect(importCmd?.actionHandler).toBeTypeOf('function');

    const session = { conversationId: 'conv-target', send: () => undefined };
    const out = await importCmd!.actionHandler!(
      { session, options: { mode: 'inject', dryRun: false }, args: [] },
      snapshotId,
    );
    expect(typeof out).toBe('string');

    // 关键断言：真实注入路径被调用，且 conversationId 正确、brief 带只读标记。
    expect(host.injectCalls).toHaveLength(1);
    expect(host.injectCalls[0].conversationId).toBe('conv-target');
    expect(host.injectCalls[0].brief).toContain('dcb:import');
    // 没有走消息降级。
    expect(host.sentMessages).toHaveLength(0);
    expect((out as string)).toContain('宿主系统提示注入');
  });

  it('/import 在宿主缺失 injector 时降级为 session.send 下发消息', async () => {
    const { host, snapshotId, tmpDir } = await mount(false);
    cleanup.push(tmpDir);
    const importCmd = host.commands.find((c) => c.declaration === 'import <snapshotId:text>');
    const session = { conversationId: 'conv-target', send: (m: string) => host.sentMessages.push(m) };
    const out = await importCmd!.actionHandler!(
      { session, options: { mode: 'inject', dryRun: false }, args: [] },
      snapshotId,
    );
    expect(typeof out).toBe('string');

    expect(host.injectCalls).toHaveLength(0);
    expect(host.sentMessages).toHaveLength(1);
    expect(host.sentMessages[0]).toContain('dcb:import');
    expect((out as string)).toContain('会话消息降级下发');
  });

  it('/import --mode merge 读取当前对话并产出融合简报', async () => {
    const { host, snapshotId, tmpDir } = await mount(true);
    cleanup.push(tmpDir);
    const importCmd = host.commands.find((c) => c.declaration === 'import <snapshotId:text>');
    const session = { conversationId: 'conv-target', send: () => undefined };
    const out = await importCmd!.actionHandler!(
      { session, options: { mode: 'merge', policy: 'newWins', dryRun: false }, args: [] },
      snapshotId,
    );
    expect(typeof out).toBe('string');
    expect(host.injectCalls).toHaveLength(1);
    expect(host.injectCalls[0].brief).toContain('merge');
    expect((out as string)).toContain('融合');
  });

  it('dispose 释放数据库连接', async () => {
    const { host, tmpDir } = await mount(false);
    cleanup.push(tmpDir);
    expect(host.disposeHandler).toBeTypeOf('function');
    expect(() => host.disposeHandler?.()).not.toThrow();
  });
});
