import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createBridgeService } from '../src/service';
import { createSnapshotRepository } from '../src/storage/repository';
import { openMemoryDatabase } from '../src/storage/database';
import { createCipher } from '../src/security/crypto';
import { silentLogger } from '../src/utils/logger';
import type { ConversationMessage } from '../src/types';

const messages: ConversationMessage[] = [
  { id: '1', role: 'user', content: '用 Python 3.8 实现三层快照导出', createdAt: 1 },
  { id: '2', role: 'assistant', content: '好的，下面给出实现方案。', createdAt: 2 },
  { id: '3', role: 'user', content: '关键决策：快照 id 必须稳定且可排序', createdAt: 3 },
];

function makeService(dataDir: string) {
  const handle = openMemoryDatabase();
  const repository = createSnapshotRepository(handle);
  const cipher = createCipher(undefined);
  return createBridgeService({
    repository,
    cipher,
    logger: silentLogger,
    options: {
      maxTokens: 4096,
      maxBulletsPerSection: 6,
      indexPlaintextWhenEncrypted: false,
      mergePolicy: 'newWins',
    },
    dataDir,
  });
}

describe('快照文件导入 / 导出', () => {
  it('导出单条快照并写盘为 .md 文件', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dcb-port-'));
    try {
      const service = makeService(dir);
      const saved = await service.compileAndSave({ conversationId: 'c1', messages });

      const out = service.exportSnapshot(saved.snapshotId, dir);
      expect(out.snapshotId).toBe(saved.snapshotId);
      expect(out.writtenPlaintext).toBe(true);
      expect(readFileSync(out.path, 'utf8')).toContain('dcb_schema:');

      service.remove(saved.snapshotId);
      expect(service.stats().total).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('从导出的 .md 文件重新导入，分配新 id 且内容一致', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dcb-port-'));
    try {
      const service = makeService(dir);
      const saved = await service.compileAndSave({ conversationId: 'c1', messages, title: '桥接导出测试' });

      const out = service.exportSnapshot(saved.snapshotId, dir);
      const imported = service.importFile(out.path);
      expect(imported.snapshotId).not.toBe(saved.snapshotId);
      expect(imported.fromSnapshotId).toBe(saved.snapshotId);
      expect(imported.title).toBe('桥接导出测试');
      expect(imported.intact).toBe(true);
      expect(service.stats().total).toBe(2);

      const readBack = service.read(imported.snapshotId);
      expect(readBack?.snapshot.meta.title).toBe('桥接导出测试');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--dry-run 只解析校验、不落库', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dcb-port-'));
    try {
      const service = makeService(dir);
      const saved = await service.compileAndSave({ conversationId: 'c1', messages });
      const out = service.exportSnapshot(saved.snapshotId, dir);

      const before = service.stats().total;
      const dry = service.importFile(out.path, { dryRun: true });
      expect(dry.dryRun).toBe(true);
      expect(dry.fromSnapshotId).toBe(saved.snapshotId);
      expect(service.stats().total).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('导出全部快照', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dcb-port-'));
    try {
      const service = makeService(dir);
      await service.compileAndSave({ conversationId: 'c1', messages });
      await service.compileAndSave({ conversationId: 'c2', messages });
      const all = service.exportAll(dir);
      expect(all).toHaveLength(2);
      for (const r of all) expect(readFileSync(r.path, 'utf8')).toContain('dcb_schema:');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('导入非快照文档时抛出可读错误', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dcb-port-'));
    try {
      const service = makeService(dir);
      expect(() => service.importMarkdown('# 只是一段普通 Markdown\n\n没有 Schema 头')).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
