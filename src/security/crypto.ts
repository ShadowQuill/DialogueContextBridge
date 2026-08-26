import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';

/**
 * 本地静态数据加密（AES-256-GCM）。
 *
 * 设计要点：
 * - 每条密文自带随机 salt 与 IV，密钥由口令经 scrypt 派生，**不落盘**；
 * - 使用 GCM 模式，认证标签一并存储，篡改会在解密阶段被发现；
 * - 信封为纯 ASCII 文本，可直接存进 SQLite 的 TEXT 列，不破坏「快照是纯文本」
 *   这一可移植性约束；
 * - 支持加密擦除（cryptographic erasure）：丢弃口令即等价于销毁全部密文。
 *
 * @packageDocumentation
 */

/** 信封版本前缀。 */
const ENVELOPE_PREFIX = 'dcb1';

/** scrypt 参数：N=2^15 在现代机器上约 100ms 量级，足以抵御离线爆破。 */
const SCRYPT_COST = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;

const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const IV_LENGTH = 12;

/**
 * 从口令与 salt 派生 256 位密钥。
 *
 * @param passphrase - 用户口令。
 * @param salt - 随机 salt。
 * @returns 32 字节密钥。
 */
function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, KEY_LENGTH, SCRYPT_COST);
}

/**
 * 判断字符串是否为本模块产出的密文信封。
 *
 * @param text - 待判断文本。
 * @returns 是密文信封返回 true。
 */
export function isEncrypted(text: string): boolean {
  return text.startsWith(`${ENVELOPE_PREFIX}.`) && text.split('.').length === 5;
}

/**
 * 加密文本。
 *
 * @param plaintext - 明文。
 * @param passphrase - 口令（长度至少 8）。
 * @returns 形如 `dcb1.<salt>.<iv>.<tag>.<ciphertext>` 的 base64url 信封。
 * @throws 口令过短时抛错。
 */
export function encryptText(plaintext: string, passphrase: string): string {
  if (passphrase.length < 8) {
    throw new Error('DCB_CRYPTO_WEAK_PASSPHRASE: 加密口令长度至少 8 个字符');
  }
  const salt = randomBytes(SALT_LENGTH);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    ENVELOPE_PREFIX,
    salt.toString('base64url'),
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

/**
 * 解密文本。
 *
 * @param envelope - {@link encryptText} 产出的信封。
 * @param passphrase - 口令。
 * @returns 明文。
 * @throws 信封格式非法、口令错误或数据被篡改时抛错。
 */
export function decryptText(envelope: string, passphrase: string): string {
  const parts = envelope.split('.');
  if (parts.length !== 5 || parts[0] !== ENVELOPE_PREFIX) {
    throw new Error('DCB_CRYPTO_BAD_ENVELOPE: 密文信封格式非法');
  }
  const [, saltRaw, ivRaw, tagRaw, dataRaw] = parts;
  const decipher = createDecipheriv(
    'aes-256-gcm',
    deriveKey(passphrase, Buffer.from(saltRaw, 'base64url')),
    Buffer.from(ivRaw, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'));
  try {
    return Buffer.concat([
      decipher.update(Buffer.from(dataRaw, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new Error('DCB_CRYPTO_AUTH_FAILED: 口令错误或数据已被篡改');
  }
}

/** 加解密器：由配置决定是否真正加密，业务代码无需分支判断。 */
export interface Cipher {
  /** 当前是否启用加密。 */
  readonly enabled: boolean;
  /**
   * 编码待落盘文本。
   *
   * @param plaintext - 明文。
   * @returns 启用加密时返回信封，否则原样返回。
   */
  seal(plaintext: string): string;
  /**
   * 解码已落盘文本。
   *
   * @param stored - 落盘内容。
   * @returns 明文。
   */
  open(stored: string): string;
}

/**
 * 创建加解密器。
 *
 * 未提供口令时返回「直通」实现，使调用方代码路径保持一致。
 *
 * @param passphrase - 加密口令；为空表示不加密。
 * @returns 加解密器。
 */
export function createCipher(passphrase?: string): Cipher {
  if (!passphrase) {
    return { enabled: false, seal: (text) => text, open: (text) => text };
  }
  return {
    enabled: true,
    seal: (text) => encryptText(text, passphrase),
    open: (text) => (isEncrypted(text) ? decryptText(text, passphrase) : text),
  };
}

/**
 * 恒定时间比较两个字符串（用于口令指纹校验，避免时序侧信道）。
 *
 * @param left - 字符串 A。
 * @param right - 字符串 B。
 * @returns 相等返回 true。
 */
export function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
