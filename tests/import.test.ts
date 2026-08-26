import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildBrief,
  buildInjectBrief,
  buildMergeBrief,
  fuseSnapshots,
} from '../src/core/inject';
import { compileSnapshot } from '../src/core/compiler';
import { createCipher } from '../src/security/crypto';
import { openMemoryDatabase, type DatabaseHandle } from '../src/storage/database';
import { createSnapshotRepository } from '../src/storage/repository';
import { createBridgeService } from '../src/service';
import { silentLogger } from '../src/utils/logger';
import { registerImportCommand } from '../src/commands/import';
import type { CommandDeps } from '../src/commands/shared';
import type { ContextSnapshot, PreferenceEntry, SummarySection, VerbatimEntry } from '../src/types';
import { BASE_TIME, sampleConversation } from './fixtures';

let handle: DatabaseHandle;

beforeEach(() => {
  handle = openMemoryDatabase();
});

afterEach(() => {
  handle.close();
});

/** 构造最小快照时的可覆盖字段。 */
type SnapshotOverride = {
  meta?: Partial<ContextSnapshot['meta']>;
  verbatim?: VerbatimEntry[];
  summary?: SummarySection[];
  preferences?: PreferenceEntry[];
};

/**
 * 构造一个最小快照，便于断言简报渲染与融合规则。
 *
 * @param overrides - 覆盖字段。
 * @returns 快照对象。
 */
function makeSnapshot(overrides: SnapshotOverride = {}): ContextSnapshot {
  const { meta: metaOverride, verbatim, summary, preferences } = overrides;
  return {
    meta: {
      snapshotId: 'snap-test',
      sourceConversationId: 'conv-test',
      title: '测试快照',
      description: 'desc',
      tags: [],
      createdAt: BASE_TIME,
      schemaVersion: '1.0',
      tokenEstimate: 0,
      encrypted: false,
      checksum: 'sha256:deadbeef',
      ...metaOverride,
    },
    verbatim: verbatim ?? [],
    summary: summary ?? [],
    preferences: preferences ?? [],
  };
}

describe('buildInjectBrief（仅新信息模式）', () => {
  it('渲染三层结构并声明只读、不回写', () => {
    const snapshot = makeSnapshot({
      verbatim: [
        { id: 'v1', sourceMessageId: 'm1', sourceRole: 'user', kind: 'decision', content: '采用 SQLite', createdAt: BASE_TIME },
        { id: 'v2', sourceMessageId: 'm2', sourceRole: 'assistant', kind: 'code', language: 'sql', content: 'SELECT 1;', createdAt: BASE_TIME },
      ],
      summary: [{ heading: '背景', bullets: ['跨会话复用上下文'] }],
      preferences: [{ key: 'style.x', value: '加注释', scope: 'style', explicit: false, createdAt: BASE_TIME }],
    });

    const brief = buildInjectBrief(snapshot);
    expect(brief).toContain('<!-- dcb:import mode=inject');
    expect(brief).toContain('snap-test');
    expect(brief).toContain('conv-test');
    expect(brief).toContain('只读背景情报');
    expect(brief).toContain('不会回写该快照');
    expect(brief).toContain('## 一、关键上下文');
    expect(brief).toContain('### 决策');
    expect(brief).toContain('```sql');
    expect(brief).toContain('## 二、背景与来龙去脉');
    expect(brief).toContain('### 背景');
    expect(brief).toContain('## 三、风格与约束');
    expect(brief).toContain('`[style]` 加注释');
  });
});

describe('fuseSnapshots（merge 基线融合）', () => {
  it('偏好按稳定键合并，新信息覆盖旧信息', () => {
    const base: ContextSnapshot = makeSnapshot({
      meta: { snapshotId: 'snap-base' },
      preferences: [
        { key: 'style.x', value: '旧注释风格', scope: 'style', explicit: false, createdAt: BASE_TIME },
        { key: 'constraint.py', value: 'Python 3.8', scope: 'constraint', explicit: true, createdAt: BASE_TIME },
      ],
    });
    const overlay: ContextSnapshot = makeSnapshot({
      meta: { snapshotId: 'snap-overlay' },
      preferences: [
        { key: 'style.x', value: '新注释风格', scope: 'style', explicit: true, createdAt: BASE_TIME + 1000 },
        { key: 'style.y', value: '新偏好', scope: 'style', explicit: true, createdAt: BASE_TIME + 1000 },
      ],
    });

    const fused = fuseSnapshots(base, overlay);
    const byKey = new Map(fused.snapshot.preferences.map((p) => [p.key, p.value]));
    expect(byKey.get('style.x')).toBe('新注释风格');
    expect(byKey.get('constraint.py')).toBe('Python 3.8');
    expect(byKey.get('style.y')).toBe('新偏好');
    expect(fused.snapshot.preferences).toHaveLength(3);
  });

  it('原文并集去重，避免重复结论', () => {
    const v: VerbatimEntry = { id: 'v1', sourceMessageId: 'm1', sourceRole: 'user', kind: 'decision', content: '采用 SQLite', createdAt: BASE_TIME };
    const base = makeSnapshot({ verbatim: [v] });
    const overlay = makeSnapshot({ verbatim: [v] });
    expect(fuseSnapshots(base, overlay).snapshot.verbatim).toHaveLength(1);
  });

  it('buildMergeBrief 标记融合上下文与策略', () => {
    const base = makeSnapshot({ preferences: [{ key: 'style.x', value: '旧', scope: 'style', explicit: false, createdAt: BASE_TIME }] });
    const overlay = makeSnapshot({ preferences: [{ key: 'style.x', value: '新', scope: 'style', explicit: true, createdAt: BASE_TIME + 1 }] });
    const brief = buildMergeBrief(base, overlay);
    expect(brief).toContain('mode=merge');
    expect(brief).toContain('融合上下文');
    expect(brief).toContain('policy=newWins');
    expect(brief).toContain('裁决规则');
  });
});

describe('fuseSnapshots 冲突裁决策略（Phase 3）', () => {
  const base: ContextSnapshot = makeSnapshot({
    meta: { snapshotId: 'snap-base' },
    preferences: [
      { key: 'style.x', value: '快照方', scope: 'style', explicit: false, createdAt: BASE_TIME },
      { key: 'constraint.py', value: 'Python 3.8', scope: 'constraint', explicit: false, createdAt: BASE_TIME },
    ],
  });
  const overlay: ContextSnapshot = makeSnapshot({
    meta: { snapshotId: 'snap-overlay' },
    preferences: [
      { key: 'style.x', value: '当前方', scope: 'style', explicit: false, createdAt: BASE_TIME + 1000 },
      { key: 'constraint.py', value: 'Python 3.12', scope: 'constraint', explicit: false, createdAt: BASE_TIME + 1000 },
    ],
  });

  it('snapshotWins 保留历史快照取值', () => {
    const { snapshot, conflicts } = fuseSnapshots(base, overlay, 'snapshotWins');
    const byKey = new Map(snapshot.preferences.map((p) => [p.key, p.value]));
    expect(byKey.get('style.x')).toBe('快照方');
    expect(byKey.get('constraint.py')).toBe('Python 3.8');
    expect(conflicts).toHaveLength(2);
    expect(conflicts.every((c) => c.reason === 'snapshotWins')).toBe(true);
  });

  it('newWins 保留当前对话取值', () => {
    const { snapshot, conflicts } = fuseSnapshots(base, overlay, 'newWins');
    const byKey = new Map(snapshot.preferences.map((p) => [p.key, p.value]));
    expect(byKey.get('style.x')).toBe('当前方');
    expect(byKey.get('constraint.py')).toBe('Python 3.12');
    expect(conflicts.every((c) => c.reason === 'newWins')).toBe(true);
  });

  it('timestamp 按时间先后裁决', () => {
    const older = makeSnapshot({ preferences: [{ key: 'k', value: '早', scope: 'style', explicit: false, createdAt: BASE_TIME }] });
    const newer = makeSnapshot({ preferences: [{ key: 'k', value: '晚', scope: 'style', explicit: false, createdAt: BASE_TIME + 5000 }] });
    const { snapshot, conflicts } = fuseSnapshots(older, newer, 'timestamp');
    expect(snapshot.preferences[0].value).toBe('晚');
    expect(conflicts[0].reason).toBe('timestamp-newer');
  });

  it('同值冲突不计入裁决清单', () => {
    const a = makeSnapshot({ preferences: [{ key: 'k', value: '同', scope: 'style', explicit: false, createdAt: BASE_TIME }] });
    const b = makeSnapshot({ preferences: [{ key: 'k', value: '同', scope: 'style', explicit: false, createdAt: BASE_TIME + 1 }] });
    expect(fuseSnapshots(a, b).conflicts).toHaveLength(0);
  });

  it('buildBrief merge 模式产出冲突计数', () => {
    const brief = buildBrief(base, 'merge', overlay, 'newWins');
    expect(brief.mode).toBe('merge');
    expect(brief.conflictCount).toBe(2);
    expect(brief.brief).toContain('冲突裁决报告');
    expect(brief.brief).toContain('`style.x`');
  });
});

describe('BridgeService.buildImport（导入编排）', () => {
  /**
   * 用内存库搭一个已落库的样例快照，返回服务实例与快照 id。
   *
   * @returns 服务与快照 id。
   */
  async function seededService() {
    const repository = createSnapshotRepository(handle);
    const cipher = createCipher();
    const service = createBridgeService({
      repository,
      cipher,
      logger: silentLogger,
      options: { maxTokens: 4096, maxBulletsPerSection: 6, indexPlaintextWhenEncrypted: false, mergePolicy: 'newWins' },
    });
    const result = await compileSnapshot({
      conversationId: 'conv-1',
      messages: sampleConversation(),
      title: '样例',
      now: BASE_TIME,
    });
    const save = service.compileAndSave({
      conversationId: 'conv-1',
      messages: sampleConversation(),
      title: '样例',
    });
    void result;
    const outcome = await save;
    return { service, snapshotId: outcome.snapshotId };
  }

  it('inject 模式产出只读简报且 token 估算为正', async () => {
    const { service, snapshotId } = await seededService();
    const outcome = await service.buildImport({ snapshotId, mode: 'inject' });
    expect(outcome).toBeDefined();
    expect(outcome?.mode).toBe('inject');
    expect(outcome?.brief).toContain('只读背景情报');
    expect(outcome?.tokenEstimate).toBeGreaterThan(0);
  });

  it('merge 模式融合当前对话上下文', async () => {
    const { service, snapshotId } = await seededService();
    const outcome = await service.buildImport({
      snapshotId,
      mode: 'merge',
      currentMessages: sampleConversation(),
      currentConversationId: 'conv-now',
    });
    expect(outcome?.mode).toBe('merge');
    expect(outcome?.brief).toContain('融合上下文');
  });

  it('快照不存在时返回 undefined', async () => {
    const { service } = await seededService();
    expect(await service.buildImport({ snapshotId: 'nope' })).toBeUndefined();
  });
});

describe('/import 命令层（模式选择引导）', () => {
  /** 最小命令依赖桩，记录 inject 调用与 buildImport 入参。 */
  function fakeDeps() {
    const injectCalls: string[] = [];
    let lastRequest: Parameters<NonNullable<CommandDeps['service']['buildImport']>>[0] | undefined;
    const handlers = new Map<string, (ctx: unknown) => unknown>();
    const deps = {
      registry: (def: { name: string; handler: (ctx: unknown) => unknown }) => {
        handlers.set(def.name, def.handler);
      },
      service: {
        buildImport: async (request: Parameters<NonNullable<CommandDeps['service']['buildImport']>>[0]) => {
          lastRequest = request;
          return {
            snapshotId: request.snapshotId,
            mode: request.mode ?? 'inject',
            brief: '# 背景简报',
            tokenEstimate: 10,
            conflictCount: 0,
          };
        },
      },
      reader: async () => [],
      injector: (_agent: unknown, brief: string) => {
        injectCalls.push(brief);
      },
      config: { maxTokens: 4096 } as CommandDeps['config'],
      logger: silentLogger,
    } as unknown as CommandDeps;
    return { deps, handlers, injectCalls, getLastRequest: () => lastRequest };
  }

  it('不带 --mode 时返回模式选择引导且不注入', async () => {
    const { deps, handlers, injectCalls } = fakeDeps();
    registerImportCommand(deps);
    const reply = (await handlers.get('import')!({
      agent: { session: { deriveMessages: () => [] } },
      conversationId: 'c1',
      rawInput: 'snap_x',
      args: ['snap_x'],
      options: {},
    })) as string;
    expect(reply).toContain('请选择导入模式');
    expect(reply).toContain('/import snap_x --mode inject');
    expect(reply).toContain('/dcb snap_x');
    expect(reply).toContain('--mode merge');
    expect(injectCalls).toHaveLength(0);
  });

  it('带 --mode inject 时真正注入且不回写', async () => {
    const { deps, handlers, injectCalls, getLastRequest } = fakeDeps();
    registerImportCommand(deps);
    const reply = (await handlers.get('import')!({
      agent: { session: { deriveMessages: () => [] } },
      conversationId: 'c1',
      rawInput: 'snap_x --mode inject',
      args: ['snap_x'],
      options: { mode: 'inject' },
    })) as string;
    expect(reply).toContain('已引入快照');
    expect(injectCalls).toHaveLength(1);
    expect(getLastRequest()?.mode).toBe('inject');
  });

  it('/dcb 别名等价 inject 且直接注入', async () => {
    const { deps, handlers, injectCalls } = fakeDeps();
    registerImportCommand(deps);
    const reply = (await handlers.get('dcb')!({
      agent: { session: { deriveMessages: () => [] } },
      conversationId: 'c1',
      rawInput: 'snap_x',
      args: ['snap_x'],
      options: {},
    })) as string;
    expect(reply).toContain('已一键引入快照');
    expect(injectCalls).toHaveLength(1);
  });
});
