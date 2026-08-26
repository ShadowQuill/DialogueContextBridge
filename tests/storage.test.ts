import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { compileSnapshot, type CompileResult } from '../src/core/compiler';
import { extractIndexText } from '../src/core/serializer';
import { createCipher } from '../src/security/crypto';
import { openMemoryDatabase, type DatabaseHandle } from '../src/storage/database';
import {
  createSnapshotRepository,
  toMatchExpression,
  type SnapshotRepository,
} from '../src/storage/repository';
import { createBridgeService } from '../src/service';
import { silentLogger } from '../src/utils/logger';
import { BASE_TIME, sampleConversation } from './fixtures';

let handle: DatabaseHandle;
let repository: SnapshotRepository;

beforeEach(() => {
  handle = openMemoryDatabase();
  repository = createSnapshotRepository(handle);
});

afterEach(() => {
  handle.close();
});

/**
 * 编译一份样例快照。
 *
 * @param conversationId - 对话 id。
 * @returns 编译结果。
 */
async function fixture(conversationId = 'conv-1'): Promise<CompileResult> {
  return compileSnapshot({
    conversationId,
    messages: sampleConversation(),
    title: '对话上下文桥接架构评审',
    tags: ['phase1', '架构'],
    now: BASE_TIME,
  });
}

describe('toMatchExpression', () => {
  it('转义用户输入，避免 FTS 语法注入', () => {
    expect(toMatchExpression('SQLite AND "x"', 'unicode61')).toBe('"SQLite" AND "AND" AND """x"""');
  });

  it('trigram 下过滤过短词项', () => {
    expect(toMatchExpression('ab', 'trigram')).toBeUndefined();
    expect(toMatchExpression('abc', 'trigram')).toBe('"abc"');
  });
});

describe('snapshot repository', () => {
  it('迁移建表并可用 FTS5', () => {
    expect(['trigram', 'unicode61']).toContain(handle.tokenizer);
    expect(repository.count()).toBe(0);
  });

  it('保存后可按 id 读取与列出', async () => {
    const { snapshot, markdown } = await fixture();
    repository.save({ snapshot, document: markdown, index: extractIndexText(snapshot) });

    const record = repository.findById(snapshot.meta.snapshotId);
    expect(record?.title).toBe('对话上下文桥接架构评审');
    expect(record?.tags).toEqual(['phase1', '架构']);
    expect(record?.document).toBe(markdown);
    expect(repository.list()).toHaveLength(1);
    expect(repository.list({ conversationId: 'conv-nope' })).toHaveLength(0);
  });

  it('中文关键词可命中全文索引', async () => {
    const { snapshot, markdown } = await fixture();
    repository.save({ snapshot, document: markdown, index: extractIndexText(snapshot) });

    const hits = repository.search('上下文桥接');
    expect(hits).toHaveLength(1);
    expect(hits[0].snapshotId).toBe(snapshot.meta.snapshotId);
    expect(hits[0].excerpt.length).toBeGreaterThan(0);
  });

  it('英文关键词与 AND 语义生效', async () => {
    const { snapshot, markdown } = await fixture();
    repository.save({ snapshot, document: markdown, index: extractIndexText(snapshot) });

    expect(repository.search('SQLite')).toHaveLength(1);
    expect(repository.search('SQLite FTS5')).toHaveLength(1);
    expect(repository.search('SQLite MongoDB')).toHaveLength(0);
  });

  it('未建索引的快照不出现在检索结果中', async () => {
    const { snapshot, markdown } = await fixture();
    repository.save({ snapshot, document: markdown });
    expect(repository.search('上下文桥接')).toHaveLength(0);
    expect(repository.findById(snapshot.meta.snapshotId)).toBeDefined();
  });

  it('删除会同时清理索引', async () => {
    const { snapshot, markdown } = await fixture();
    repository.save({ snapshot, document: markdown, index: extractIndexText(snapshot) });

    expect(repository.remove(snapshot.meta.snapshotId)).toBe(true);
    expect(repository.remove(snapshot.meta.snapshotId)).toBe(false);
    expect(repository.search('上下文桥接')).toHaveLength(0);
    expect(repository.count()).toBe(0);
  });
});

describe('bridge service', () => {
  /**
   * 组装一个测试用服务。
   *
   * @param passphrase - 加密口令；省略则不加密。
   * @param indexPlaintextWhenEncrypted - 加密时是否仍建索引。
   * @returns 服务实例。
   */
  function service(passphrase?: string, indexPlaintextWhenEncrypted = false) {
    return createBridgeService({
      repository,
      cipher: createCipher(passphrase),
      logger: silentLogger,
      options: { maxTokens: 4096, maxBulletsPerSection: 6, indexPlaintextWhenEncrypted, mergePolicy: 'newWins' },
      dataDir: tmpdir(),
    });
  }

  it('compile 只产草稿，save 才落库', async () => {
    const bridge = service();
    const result = await bridge.compile({
      conversationId: 'conv-1',
      messages: sampleConversation(),
    });

    expect(repository.count()).toBe(0);
    expect(bridge.getDraft('conv-1')?.snapshot.meta.snapshotId).toBe(result.snapshot.meta.snapshotId);

    const outcome = bridge.saveDraft('conv-1');
    expect(outcome?.snapshotId).toBe(result.snapshot.meta.snapshotId);
    expect(repository.count()).toBe(1);
    // 草稿保存后被消费掉，避免重复落库。
    expect(bridge.getDraft('conv-1')).toBeUndefined();
    expect(bridge.saveDraft('conv-1')).toBeUndefined();
  });

  it('read 可还原并校验快照文档', async () => {
    const bridge = service();
    const outcome = await bridge.compileAndSave({
      conversationId: 'conv-1',
      messages: sampleConversation(),
    });

    const read = bridge.read(outcome.snapshotId);
    expect(read?.intact).toBe(true);
    expect(read?.snapshot.meta.snapshotId).toBe(outcome.snapshotId);
    expect(read?.record.encrypted).toBe(false);
  });

  it('加密模式下正文落密文且默认不建明文索引', async () => {
    const bridge = service('correct horse battery staple');
    const outcome = await bridge.compileAndSave({
      conversationId: 'conv-1',
      messages: sampleConversation(),
    });

    expect(outcome.encrypted).toBe(true);
    expect(outcome.indexed).toBe(false);

    const record = repository.findById(outcome.snapshotId)!;
    expect(record.document.startsWith('dcb1.')).toBe(true);
    expect(record.document).not.toContain('SQLite');

    // 持有口令的服务仍能正常读取。
    expect(bridge.read(outcome.snapshotId)?.intact).toBe(true);
    expect(repository.search('SQLite')).toHaveLength(0);
  });

  it('显式允许时加密快照也可建立明文索引', async () => {
    const bridge = service('correct horse battery staple', true);
    const outcome = await bridge.compileAndSave({
      conversationId: 'conv-1',
      messages: sampleConversation(),
    });
    expect(outcome.indexed).toBe(true);
    expect(repository.search('SQLite')).toHaveLength(1);
  });
});
