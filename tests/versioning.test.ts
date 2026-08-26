import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extractIndexText, parseSnapshot, serializeSnapshot } from '../src/core/serializer';
import { createCipher } from '../src/security/crypto';
import { createMemoryGitRunner } from '../src/versioning/git';
import { createVersioningController } from '../src/versioning/store';
import { openMemoryDatabase, type DatabaseHandle } from '../src/storage/database';
import { createSnapshotRepository } from '../src/storage/repository';
import { createBridgeService } from '../src/service';
import { silentLogger } from '../src/utils/logger';
import type { ContextSnapshot } from '../src/types';
import { BASE_TIME, sampleConversation } from './fixtures';

let handle: DatabaseHandle;

beforeEach(() => {
  handle = openMemoryDatabase();
});

afterEach(() => {
  handle.close();
});

/** 构造一个最小快照。 */
function snapshot(id: string, title: string): ContextSnapshot {
  return {
    meta: {
      snapshotId: id,
      sourceConversationId: 'conv',
      title,
      description: '',
      tags: [],
      createdAt: BASE_TIME,
      schemaVersion: '1.0',
      tokenEstimate: 0,
      encrypted: false,
      checksum: 'sha256:deadbeef',
    },
    verbatim: [],
    summary: [],
    preferences: [],
  };
}

describe('VersioningController（内存 git 假实现）', () => {
  it('保存两次后历史最新在前，且可读取各版本内容', async () => {
    const git = createMemoryGitRunner('/tmp/dcb-test');
    const controller = createVersioningController({ dataDir: '/tmp/dcb-test', git, enabled: true });

    await controller.recordSave('snap-a', serializeSnapshot(snapshot('snap-a', 'v1')).markdown);
    await controller.recordSave('snap-a', serializeSnapshot(snapshot('snap-a', 'v2')).markdown);

    const history = await controller.history('snap-a');
    expect(history).toHaveLength(2);
    expect(history[0].message).toContain('save');
    expect(history[1].message).toContain('save');

    const newest = await controller.readAtRef('snap-a', history[0].ref);
    const oldest = await controller.readAtRef('snap-a', history[1].ref);
    expect(parseSnapshot(newest ?? '').meta.title).toBe('v2');
    expect(parseSnapshot(oldest ?? '').meta.title).toBe('v1');
  });

  it('未启用时所有方法为 no-op', async () => {
    const controller = createVersioningController({
      dataDir: '/tmp/dcb-test',
      git: createMemoryGitRunner('/tmp/dcb-test'),
      enabled: false,
    });
    await controller.recordSave('snap-x', '# x');
    expect(await controller.history('snap-x')).toEqual([]);
    expect(await controller.readAtRef('snap-x', 'r1')).toBeUndefined();
  });

  it('删除后旧版本内容仍可读取（历史止于删除边界）', async () => {
    const controller = createVersioningController({ dataDir: '/tmp/dcb-test', git: createMemoryGitRunner('/tmp/dcb-test'), enabled: true });
    await controller.recordSave('snap-d', serializeSnapshot(snapshot('snap-d', 'keep')).markdown);
    const before = await controller.history('snap-d');
    await controller.recordRemove('snap-d');
    // 删除提交不计入「该文件存在」的历史；但旧保存内容仍可回读。
    expect(await controller.readAtRef('snap-d', before[0].ref)).toContain('keep');
  });
});

describe('BridgeService 版本控制集成', () => {
  it('compileAndSave 自动提交版本；rollback 还原到旧版本并重新落库', async () => {
    const repository = createSnapshotRepository(handle);
    const cipher = createCipher();
    const service = createBridgeService({
      repository,
      cipher,
      logger: silentLogger,
      options: { maxTokens: 4096, maxBulletsPerSection: 6, indexPlaintextWhenEncrypted: false, mergePolicy: 'newWins' },
      versioning: createVersioningController({ dataDir: '/tmp/dcb-test', git: createMemoryGitRunner('/tmp/dcb-test'), enabled: true }),
    });

    const saved = await service.compileAndSave({
      conversationId: 'conv-1',
      messages: sampleConversation(),
      title: 'v1',
    });
    const id = saved.snapshotId;
    const historyAfterSave = await service.history(id);
    expect(historyAfterSave.length).toBeGreaterThanOrEqual(1);
    const firstRef = historyAfterSave[0].ref;

    // 模拟一次「再次保存」（内容不同）：直接更新仓储（不补版本，仅验证回滚可还原）。
    const v2 = snapshot(id, 'v2');
    repository.save({ snapshot: v2, document: cipher.seal(serializeSnapshot(v2).markdown), index: extractIndexText(v2) });

    // 回滚到最初版本。
    const restored = await service.rollback(id, firstRef);
    expect(restored).toBeDefined();

    const read = service.read(id);
    expect(read?.snapshot.meta.title).toBe('v1');
    // 回滚本身也记了一笔版本，历史变长。
    expect(await service.history(id)).toHaveLength(historyAfterSave.length + 1);
  });

  it('未启用版本控制时 history/rollback 安全降级', async () => {
    const repository = createSnapshotRepository(handle);
    const service = createBridgeService({
      repository,
      cipher: createCipher(),
      logger: silentLogger,
      options: { maxTokens: 4096, maxBulletsPerSection: 6, indexPlaintextWhenEncrypted: false, mergePolicy: 'newWins' },
      // 不注入 versioning
    });
    const saved = await service.compileAndSave({ conversationId: 'conv-2', messages: sampleConversation(), title: 'x' });
    expect(await service.history(saved.snapshotId)).toEqual([]);
    expect(await service.rollback(saved.snapshotId, 'r1')).toBeUndefined();
  });
});
