import { describe, expect, it } from 'vitest';
import { applyTokenBudget } from '../src/core/budget';
import { classifyConversation } from '../src/core/classifier';
import { compileSnapshot } from '../src/core/compiler';
import {
  SNAPSHOT_SCHEMA_VERSION,
  type ContextSnapshot,
  type VerbatimKind,
} from '../src/types';
import { BASE_TIME, message, sampleConversation } from './fixtures';

describe('classifier', () => {
  it('把代码块归入原文层并保留语言标识', () => {
    const result = classifyConversation([
      message(1, 'assistant', '实现如下：\n```ts\nconst a = 1;\n```'),
    ]);
    const code = result.find((item) => item.kind === 'code');
    expect(code).toBeDefined();
    expect(code?.language).toBe('ts');
    expect(code?.text).toBe('const a = 1;');
  });

  it('识别硬性指令与决策结论', () => {
    const result = classifyConversation([
      message(1, 'user', '必须兼容 Python 3.8。最终决定采用 SQLite。'),
    ]);
    const kinds = result.map((item) => item.kind);
    expect(kinds).toContain('decision');
    // 「必须兼容」同时命中 constraint.runtime 偏好规则，优先归入偏好层。
    expect(result.some((item) => item.layer === 'preference')).toBe(true);
  });

  it('过滤纯寒暄噪声', () => {
    expect(classifyConversation([message(1, 'assistant', '好的')])).toHaveLength(0);
  });
});

describe('compileSnapshot', () => {
  it('产出完整的三层结构快照', async () => {
    const { snapshot, markdown } = await compileSnapshot({
      conversationId: 'conv-1',
      messages: sampleConversation(),
      tags: ['phase1', '架构'],
      now: BASE_TIME,
    });

    expect(snapshot.verbatim.length).toBeGreaterThan(0);
    expect(snapshot.summary.length).toBeGreaterThan(0);
    expect(snapshot.preferences.length).toBeGreaterThan(0);

    expect(snapshot.verbatim.some((entry) => entry.kind === 'code')).toBe(true);
    expect(snapshot.preferences.map((entry) => entry.key)).toContain('role.persona');

    expect(snapshot.meta.sourceConversationId).toBe('conv-1');
    expect(snapshot.meta.tags).toEqual(['phase1', '架构']);
    expect(snapshot.meta.createdAt).toBe(BASE_TIME);
    expect(snapshot.meta.checksum).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(markdown).toContain('<!-- dcb:layer:verbatim -->');
  });

  it('原文条目按时间升序且不重复', async () => {
    const duplicated = [
      message(1, 'user', '最终决定采用 SQLite。'),
      message(2, 'user', '最终决定采用 SQLite'),
    ];
    const { snapshot } = await compileSnapshot({
      conversationId: 'conv-2',
      messages: duplicated,
      now: BASE_TIME,
    });
    expect(snapshot.verbatim).toHaveLength(1);
  });

  it('尊重 token 预算并在报告中体现裁剪', async () => {
    const { snapshot, report } = await compileSnapshot({
      conversationId: 'conv-3',
      messages: sampleConversation(),
      maxTokens: 60,
      now: BASE_TIME,
    });
    expect(snapshot.meta.tokenEstimate).toBeLessThanOrEqual(60);
    expect(
      report.droppedVerbatim + report.droppedBullets + report.droppedPreferences,
    ).toBeGreaterThan(0);
  });
});

describe('applyTokenBudget', () => {
  it('预算为 0 时清空全部内容', async () => {
    const { snapshot } = await compileSnapshot({
      conversationId: 'conv-4',
      messages: sampleConversation(),
      now: BASE_TIME,
    });
    const { snapshot: trimmed, report } = applyTokenBudget(snapshot, 0);
    expect(trimmed.verbatim).toHaveLength(0);
    expect(trimmed.summary).toHaveLength(0);
    expect(trimmed.preferences).toHaveLength(0);
    expect(report.tokenEstimate).toBe(0);
  });

  it('同等体积下优先保留硬性指令与决策结论', () => {
    // 四条等长原文，只有类别不同，用以验证优先级而非长度起作用。
    const kinds: VerbatimKind[] = ['parameter', 'code', 'decision', 'directive'];
    const snapshot: ContextSnapshot = {
      meta: {
        snapshotId: 'snap_budget',
        sourceConversationId: 'conv-b',
        title: 't',
        description: 'd',
        tags: [],
        createdAt: BASE_TIME,
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
        tokenEstimate: 0,
        encrypted: false,
        checksum: '',
      },
      verbatim: kinds.map((kind, index) => ({
        id: `v-00${index}`,
        sourceMessageId: `msg-${index}`,
        sourceRole: 'user' as const,
        kind,
        content: '一二三四五六七八九十',
        createdAt: BASE_TIME + index,
      })),
      summary: [],
      preferences: [],
    };

    // 每条 10 tokens，预算 20 只够两条。
    const { snapshot: trimmed, report } = applyTokenBudget(snapshot, 20);
    expect(trimmed.verbatim.map((entry) => entry.kind).sort()).toEqual(['decision', 'directive']);
    expect(report.droppedVerbatim).toBe(2);
  });
});
