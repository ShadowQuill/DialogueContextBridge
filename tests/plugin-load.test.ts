import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { apply } from '../src/index';
import type { Config } from '../src/config';
import type { ConversationMessage } from '../src/types';

/**
 * 插件加载集成测试。
 *
 * 之前的单测都在「核心逻辑 / 存储 / 加密」上，命令层与宿主无关的部分也覆盖到了，
 * 但 `apply` 本身——数据库打开、服务注册到 `ctx.dcb`、全部命令注册、dispose 释放
 * 连接——从未在真实调用下验证过。本测试用一个**最小 Cordis 上下文桩**直接驱动真实
 * 的 `apply`，并端到端跑通「编译落库 → 检索 → 读取 → 导入简报（inject/merge）→ 删除」，
 * 闭合「插件真的能被宿主加载」这一长期缺口。
 */

/** 一条被记录的命令注册信息（对应真实 dsh 的 `CommandDefinition`）。 */
interface RecordedCommand {
  /** 命令名（如 `compile`、`snapshot.list`）。 */
  name: string;
  /** 命令描述。 */
  description?: string;
}

/** 最小 Cordis 上下文桩：只实现 `apply` 实际用到的成员。 */
interface FakeContext {
  services: Record<string, unknown>;
  /** 由 `ctx.effect` 注册、在 fiber 卸载时运行的清理函数（模拟 unload）。 */
  disposeEffect?: () => void | Promise<void>;
  recordedCommands: RecordedCommand[];
  commands: { register(def: { name: string; description?: string }): () => void };
  set(name: string, value: unknown): void;
  /** 真实 dsh 的 `ctx.provide`：声明并赋值一项服务（fiber 卸载时自动撤回）。 */
  provide(name: string, value: unknown): () => void;
  /** 真实 dsh 的 `ctx.effect`：立即执行 `execute` 并收集其返回的 disposer。 */
  effect(execute: () => unknown): () => void;
  /** 真实 dsh 的 `ctx.inject`：声明依赖，依赖就绪时回调（测试桩不挂载 settings，故不触发）。 */
  inject(_deps: string[], _cb?: (sctx: unknown) => void): () => void;
}

/** 构造最小 Cordis 上下文桩。 */
function createFakeContext(): FakeContext {
  const recordedCommands: RecordedCommand[] = [];
  const services: Record<string, unknown> = {};
  const ctx: FakeContext = {
    services,
    recordedCommands,
    commands: {
      register(def: { name: string; description?: string }): () => void {
        recordedCommands.push({ name: def.name, description: def.description });
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
      ctx.disposeEffect = execute() as () => void | Promise<void>;
      return () => undefined;
    },
    inject(_deps: string[], _cb?: (sctx: unknown) => void): () => void {
      return () => undefined;
    },
  };
  return ctx;
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
  {
    id: 'm3',
    role: 'user',
    content:
      '写一段示例代码：\n```ts\nconst bridge = createBridgeService(deps);\n```\n' +
      '硬性约束：快照必须兼容 Python 3.8 解析，且代码要加详细注释。',
    createdAt: 1_700_000_000_200,
  },
  {
    id: 'm4',
    role: 'assistant',
    content: '收到，已记录约束并将在生成快照时为代码补充注释。',
    createdAt: 1_700_000_000_300,
  },
];

describe('plugin load integration', () => {
  let tmpDir: string;
  let ctx: FakeContext;
  let config: Config;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'dcb-load-'));
    ctx = createFakeContext();
    config = {
      dataDir: tmpDir,
      maxTokens: 4096,
      maxBulletsPerSection: 6,
      maxHistoryMessages: 400,
      autoSave: false,
      searchLimit: 10,
      encryption: { enabled: false, passphrase: '', indexPlaintext: false },
      logLevel: 'silent',
      merge: { policy: 'newWins' },
      summary: { mode: 'extractive', provider: 'deepseek', model: '', maxTokens: 1024, temperature: 0.2 },
      versioning: { enabled: false },
    };
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('apply 成功加载并注册服务与全部命令', () => {
    expect(() => apply(ctx as unknown as Parameters<typeof apply>[0], config)).not.toThrow();

    // 服务挂到了 ctx.dcb。
    const service = ctx.services.dcb as Record<string, unknown> | undefined;
    expect(service).toBeDefined();
    expect(typeof service?.compileAndSave).toBe('function');
    expect(typeof service?.search).toBe('function');
    expect(typeof service?.buildImport).toBe('function');
    expect(typeof service?.read).toBe('function');
    expect(typeof service?.remove).toBe('function');

    // 全部命令均完成注册。
    const names = ctx.recordedCommands.map((c) => c.name);
    for (const expected of [
      'compile',
      'save',
      'dcb-save',
      'snapshot-search',
      'snapshot-list',
      'snapshot-show',
      'snapshot-remove',
      'snapshot-history',
      'snapshot-rollback',
      'import',
      'dcb-merge',
      'dcb',
      'dcb-export',
      'dcb-import',
    ]) {
      expect(names).toContain(expected);
    }
    expect(names.length).toBe(14);
  });

  it('端到端跑通 编译落库 → 检索 → 读取 → 导入(inject/merge) → 删除', async () => {
    apply(ctx as unknown as Parameters<typeof apply>[0], config);
    const service = ctx.services.dcb as {
      compileAndSave: (r: unknown) => Promise<{ snapshotId: string; tokenEstimate: number }>;
      search: (q: string, limit?: number) => Array<{ snapshotId: string; title: string }>;
      read: (id: string) => { intact: boolean; snapshot: { meta: { title: string } } } | undefined;
      buildImport: (r: unknown) => Promise<
        | { mode: string; brief: string; tokenEstimate: number; conflictCount: number }
        | undefined
      >;
      remove: (id: string) => boolean;
      stats: () => { total: number };
    };

    // 1. 编译并落库。
    const saved = await service.compileAndSave({
      conversationId: 'conv-1',
      messages: SAMPLE_MESSAGES,
      title: '上下文桥接集成验证',
      tags: ['integration', 'phase4'],
    });
    expect(saved.snapshotId).toMatch(/^snap_/);
    expect(service.stats().total).toBe(1);

    // 2. FTS5 检索命中（关键词「桥接」来自标题与正文）。
    const hits = service.search('桥接');
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0].snapshotId).toBe(saved.snapshotId);

    // 3. 读取并校验完整性。
    const read = service.read(saved.snapshotId);
    expect(read?.intact).toBe(true);

    // 4. inject 模式：只读背景简报，带 dcb:import 标记，无冲突。
    const inject = await service.buildImport({ snapshotId: saved.snapshotId, mode: 'inject' });
    expect(inject).toBeDefined();
    expect(inject?.mode).toBe('inject');
    expect(inject?.brief).toContain('dcb:import');
    expect(inject?.conflictCount).toBe(0);

    // 5. merge 模式：融合当前对话，产出冲突裁决结构（基线 newWins）。
    const merge = await service.buildImport({
      snapshotId: saved.snapshotId,
      mode: 'merge',
      currentMessages: SAMPLE_MESSAGES,
      currentConversationId: 'conv-2',
      policy: 'newWins',
    });
    expect(merge).toBeDefined();
    expect(merge?.mode).toBe('merge');
    expect(merge?.brief).toContain('merge');
    expect(merge?.conflictCount).toBeGreaterThanOrEqual(0);

    // 6. 删除快照。
    expect(service.remove(saved.snapshotId)).toBe(true);
    expect(service.stats().total).toBe(0);
  });

  it('dispose 句柄可安全释放数据库连接', () => {
    apply(ctx as unknown as Parameters<typeof apply>[0], config);
    expect(ctx.disposeEffect).toBeDefined();
    expect(() => ctx.disposeEffect?.()).not.toThrow();
  });
});
