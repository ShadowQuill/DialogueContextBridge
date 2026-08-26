import { describe, expect, it } from 'vitest';
import { compileSnapshot } from '../src/core/compiler';
import {
  extractIndexText,
  parseSnapshot,
  serializeSnapshot,
  verifySnapshotDocument,
} from '../src/core/serializer';
import { SNAPSHOT_SCHEMA_VERSION, type ContextSnapshot } from '../src/types';
import { BASE_TIME, sampleConversation } from './fixtures';

/**
 * 构造一个包含边界内容的快照：代码里带三反引号、正文里带 HTML 注释起始符。
 *
 * @returns 快照对象。
 */
function trickySnapshot(): ContextSnapshot {
  return {
    meta: {
      snapshotId: 'snap_test',
      sourceConversationId: 'conv-x',
      title: '边界用例：`fence` 与注释',
      description: '包含嵌套围栏与 <!-- 注释 --> 的快照',
      tags: ['edge', 'case'],
      createdAt: BASE_TIME,
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      tokenEstimate: 0,
      encrypted: false,
      checksum: '',
    },
    verbatim: [
      {
        id: 'v-001',
        sourceMessageId: 'msg-1',
        sourceRole: 'assistant',
        kind: 'code',
        language: 'md',
        content: '示例：\n```ts\nconst a = 1;\n```',
        createdAt: BASE_TIME,
      },
      {
        id: 'v-002',
        sourceMessageId: 'msg-2',
        sourceRole: 'user',
        kind: 'directive',
        content: '不要在正文里写 <!-- dcb:layer:summary --> 这种标记。',
        createdAt: BASE_TIME + 1000,
      },
    ],
    summary: [{ heading: '背景与目标', bullets: ['验证序列化的边界情况。'] }],
    preferences: [
      {
        key: 'style.language',
        value: '回复请用简体中文',
        scope: 'style',
        explicit: true,
        createdAt: BASE_TIME,
      },
    ],
  };
}

describe('serializeSnapshot / parseSnapshot', () => {
  it('真实快照可无损往返', async () => {
    const { snapshot } = await compileSnapshot({
      conversationId: 'conv-1',
      messages: sampleConversation(),
      tags: ['phase1'],
      now: BASE_TIME,
    });

    const { markdown } = serializeSnapshot(snapshot);
    const parsed = parseSnapshot(markdown);

    expect(parsed.meta.snapshotId).toBe(snapshot.meta.snapshotId);
    expect(parsed.meta.tags).toEqual(snapshot.meta.tags);
    expect(parsed.meta.createdAt).toBe(snapshot.meta.createdAt);
    expect(parsed.verbatim).toEqual(snapshot.verbatim);
    expect(parsed.summary).toEqual(snapshot.summary);
    expect(parsed.preferences).toEqual(snapshot.preferences);
  });

  it('嵌套围栏与注释标记可无损往返', () => {
    const snapshot = trickySnapshot();
    const { markdown } = serializeSnapshot(snapshot);
    const parsed = parseSnapshot(markdown);

    expect(parsed.verbatim[0].content).toBe(snapshot.verbatim[0].content);
    expect(parsed.verbatim[1].content).toBe(snapshot.verbatim[1].content);
    // 转义后的标记不得被误认为层边界。
    expect(markdown.match(/<!-- dcb:layer:summary -->/g)).toHaveLength(1);
  });

  it('写入的校验和与正文一致', () => {
    const { markdown, checksum } = serializeSnapshot(trickySnapshot());
    expect(markdown).toContain(`checksum: ${checksum}`);
    expect(verifySnapshotDocument(markdown)).toBe(true);
  });

  it('正文被篡改时校验失败', () => {
    const { markdown } = serializeSnapshot(trickySnapshot());
    expect(verifySnapshotDocument(markdown.replace('验证序列化的边界情况', '被改过了'))).toBe(false);
  });

  it('缺少 Schema 头时抛错', () => {
    expect(() => parseSnapshot('# 普通 Markdown\n正文')).toThrowError(/DCB_SNAPSHOT_PARSE_ERROR/);
  });

  it('提取的索引文本按层分离', () => {
    const index = extractIndexText(trickySnapshot());
    expect(index.summaryText).toContain('背景与目标');
    expect(index.preferenceText).toContain('style.language');
    expect(index.verbatimText).toContain('const a = 1;');
  });
});
