import { describe, expect, it } from 'vitest';
import { createCipher, decryptText, encryptText, isEncrypted, safeEqual } from '../src/security/crypto';

const PASSPHRASE = 'a-very-secret-passphrase';

describe('AES-256-GCM 信封', () => {
  it('加密后可用同一口令解密', () => {
    const envelope = encryptText('决策：采用 SQLite + FTS5', PASSPHRASE);
    expect(isEncrypted(envelope)).toBe(true);
    expect(envelope).not.toContain('SQLite');
    expect(decryptText(envelope, PASSPHRASE)).toBe('决策：采用 SQLite + FTS5');
  });

  it('相同明文两次加密得到不同密文（随机 salt/IV）', () => {
    const a = encryptText('same', PASSPHRASE);
    const b = encryptText('same', PASSPHRASE);
    expect(a).not.toBe(b);
  });

  it('口令错误时抛出认证失败', () => {
    const envelope = encryptText('secret', PASSPHRASE);
    expect(() => decryptText(envelope, 'wrong-passphrase')).toThrowError(/DCB_CRYPTO_AUTH_FAILED/);
  });

  it('密文被篡改时抛出认证失败', () => {
    const parts = encryptText('secret', PASSPHRASE).split('.');
    parts[4] = Buffer.from('tampered').toString('base64url');
    expect(() => decryptText(parts.join('.'), PASSPHRASE)).toThrowError(/DCB_CRYPTO_AUTH_FAILED/);
  });

  it('拒绝过短口令', () => {
    expect(() => encryptText('x', 'short')).toThrowError(/DCB_CRYPTO_WEAK_PASSPHRASE/);
  });

  it('信封格式非法时抛错', () => {
    expect(() => decryptText('not-an-envelope', PASSPHRASE)).toThrowError(/DCB_CRYPTO_BAD_ENVELOPE/);
  });
});

describe('createCipher', () => {
  it('未提供口令时为直通实现', () => {
    const cipher = createCipher();
    expect(cipher.enabled).toBe(false);
    expect(cipher.seal('plain')).toBe('plain');
    expect(cipher.open('plain')).toBe('plain');
  });

  it('提供口令时 seal / open 互逆', () => {
    const cipher = createCipher(PASSPHRASE);
    expect(cipher.enabled).toBe(true);
    const sealed = cipher.seal('三层快照');
    expect(sealed).not.toBe('三层快照');
    expect(cipher.open(sealed)).toBe('三层快照');
    // 兼容历史明文数据：非信封内容原样返回。
    expect(cipher.open('legacy-plaintext')).toBe('legacy-plaintext');
  });
});

describe('safeEqual', () => {
  it('长度不同直接返回 false', () => {
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });

  it('内容相同返回 true', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
  });
});
