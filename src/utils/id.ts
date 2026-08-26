import { createHash, randomBytes } from 'node:crypto';

/**
 * 生成快照 id。
 *
 * 形如 `snap_lq3k8f_1a2b3c4d`：时间戳 base36 前缀保证按 id 排序 ≈ 按时间排序，
 * 随机后缀避免同毫秒碰撞。
 *
 * @param now - 时间戳（epoch 毫秒），默认取当前时间。
 * @returns 快照 id。
 */
export function createSnapshotId(now: number = Date.now()): string {
  return `snap_${now.toString(36)}_${randomBytes(4).toString('hex')}`;
}

/**
 * 生成快照内条目 id。
 *
 * @param prefix - 条目类型前缀，例如 `v`（verbatim）。
 * @param seq - 条目序号，保证同一快照内可复现。
 * @returns 条目 id，形如 `v-003`。
 */
export function createEntryId(prefix: string, seq: number): string {
  return `${prefix}-${String(seq).padStart(3, '0')}`;
}

/**
 * 计算文本校验和。
 *
 * @param payload - 待校验文本。
 * @returns 形如 `sha256:<hex>` 的校验和字符串。
 */
export function checksum(payload: string): string {
  return `sha256:${createHash('sha256').update(payload, 'utf8').digest('hex')}`;
}

/**
 * 校验文本与给定校验和是否匹配。
 *
 * @param payload - 待校验文本。
 * @param expected - 期望的校验和。
 * @returns 匹配则返回 true。
 */
export function verifyChecksum(payload: string, expected: string): boolean {
  return checksum(payload) === expected;
}
