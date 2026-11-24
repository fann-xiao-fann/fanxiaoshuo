import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/**
 * Provider API Key 的 AES-256-GCM 加解密实现。
 *
 * 存储格式：`v1:<ivHex>:<tagHex>:<cipherHex>`
 * - key：32 字节（256 bit），由 `APP_ENCRYPTION_KEY`（hex / base64）解析
 * - iv：随机 12 字节（96 bit，GCM 推荐长度）
 * - tag：16 字节认证标签，任何篡改都会导致解密失败
 *
 * 本模块不使用任何硬编码密钥；错误信息绝不包含明文或密钥内容。
 */

/** 当前密文版本前缀。 */
export const SECRET_CIPHERTEXT_VERSION = 'v1' as const;

/** AES-256-GCM 所需密钥字节数。 */
export const ENCRYPTION_KEY_BYTES = 32;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

/** 加解密失败（密钥错误、密文损坏或被篡改）。 */
export class SecretCodecError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message);
    this.name = 'SecretCodecError';
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

/** 脱敏/加解密能力接口（服务端注入，便于测试替换）。 */
export interface SecretCodec {
  /** 明文 → `v1:<ivHex>:<tagHex>:<cipherHex>` */
  encrypt(plaintext: string): string;
  /** 密文 → 明文；格式非法或鉴权失败时抛出 `SecretCodecError` */
  decrypt(ciphertext: string): string;
  /** 明文 → 仅用于展示的脱敏指纹 */
  mask(plaintext: string): string;
}

/**
 * 解析主密钥。仅接受 32 字节的 hex（64 字符）或 base64（44 字符含 padding / 43 无 padding）。
 *
 * @throws {SecretCodecError} 格式或长度不合法（错误信息不含原始值）
 */
export function parseEncryptionKey(raw: string): Buffer {
  const value = raw.trim();
  if (value.length === 0) {
    throw new SecretCodecError('APP_ENCRYPTION_KEY 不能为空。');
  }

  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    return Buffer.from(value, 'hex');
  }

  const base64Pattern = /^[A-Za-z0-9+/]+={0,2}$/;
  if (base64Pattern.test(value)) {
    const buffer = Buffer.from(value, 'base64');
    // Buffer.from(..., 'base64') 会静默忽略非法字符，因此需回编码校验长度与内容。
    if (buffer.length === ENCRYPTION_KEY_BYTES) {
      return buffer;
    }
  }

  throw new SecretCodecError(
    'APP_ENCRYPTION_KEY 必须是 32 字节随机值的 hex（64 字符）或 base64 编码。',
  );
}

/**
 * 从候选密钥材料创建编解码器。
 * `keyMaterial` 可为原始字符串（hex/base64）或已解析的 32 字节 Buffer。
 */
export function createSecretCodec(keyMaterial: string | Buffer): SecretCodec {
  const key = Buffer.isBuffer(keyMaterial) ? normalizeKeyBuffer(keyMaterial) : parseEncryptionKey(keyMaterial);
  return {
    encrypt: (plaintext) => encryptSecret(plaintext, key),
    decrypt: (ciphertext) => decryptSecret(ciphertext, key),
    mask: (plaintext) => maskApiKey(plaintext),
  };
}

/** 加密明文（密钥须为 32 字节）。 */
export function encryptSecret(plaintext: string, key: Buffer): string {
  assertKeyBuffer(key);
  if (plaintext.length === 0) {
    throw new SecretCodecError('待加密内容不能为空。');
  }

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: AUTH_TAG_BYTES });
  const cipherBuffer = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [
    SECRET_CIPHERTEXT_VERSION,
    iv.toString('hex'),
    authTag.toString('hex'),
    cipherBuffer.toString('hex'),
  ].join(':');
}

/** 解密密文；任何格式错误、密钥不匹配或密文篡改都会抛出 `SecretCodecError`。 */
export function decryptSecret(ciphertext: string, key: Buffer): string {
  assertKeyBuffer(key);

  const parts = ciphertext.split(':');
  if (parts.length !== 4 || parts[0] !== SECRET_CIPHERTEXT_VERSION) {
    throw new SecretCodecError('密文格式非法：期望 v1:<ivHex>:<tagHex>:<cipherHex>。');
  }

  const [, ivHex, tagHex, dataHex] = parts as [string, string, string, string];
  if (
    !/^[0-9a-fA-F]{24}$/.test(ivHex) ||
    !/^[0-9a-fA-F]{32}$/.test(tagHex) ||
    !/^(?:[0-9a-fA-F]{2})+$/.test(dataHex)
  ) {
    throw new SecretCodecError('密文格式非法：iv / tag / cipher 段编码不符合预期。');
  }

  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(tagHex, 'hex');
  const data = Buffer.from(dataHex, 'hex');

  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv, {
      authTagLength: AUTH_TAG_BYTES,
    });
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(data), decipher.final()]);
    return plaintext.toString('utf8');
  } catch (error) {
    throw new SecretCodecError(
      '密文解密失败：APP_ENCRYPTION_KEY 可能已变更，或密文被篡改。',
      { cause: error },
    );
  }
}

/**
 * API Key 脱敏指纹：
 * - 长度 >= 10：保留前 3 位与后 4 位，中间固定 `***`（如 `sk-***9f2a`）
 * - 更短：全掩码（`******`），绝不泄露任何字符
 */
export function maskApiKey(rawKey: string): string {
  const value = rawKey.trim();
  if (value.length >= 10) {
    return `${value.slice(0, 3)}***${value.slice(-4)}`;
  }
  return '******';
}

/** 恒定时间比较两个字符串（用于潜在的安全校验场景）。 */
export function safeEqualString(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}

function assertKeyBuffer(key: Buffer): void {
  if (!Buffer.isBuffer(key) || key.length !== ENCRYPTION_KEY_BYTES) {
    throw new SecretCodecError('AES-256-GCM 密钥必须是 32 字节 Buffer。');
  }
}

function normalizeKeyBuffer(key: Buffer): Buffer {
  if (key.length !== ENCRYPTION_KEY_BYTES) {
    throw new SecretCodecError('AES-256-GCM 密钥必须是 32 字节 Buffer。');
  }
  return key;
}
