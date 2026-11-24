import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * 与服务端（`apps/server`）保持完全一致的 API Key 加密格式：
 *
 * ```text
 * v1:<ivHex>:<tagHex>:<cipherHex>
 * ```
 *
 * - 算法：AES-256-GCM
 * - IV：12 字节随机值
 * - AuthTag：16 字节
 * - 主密钥：32 字节（hex 64 字符或 base64）
 *
 * Worker 只负责**解密**（用于 live 模式调用上游模型），绝不回写或记录密文内容。
 */

/** 主密钥非法（缺失 / 长度错误 / 无法解析）。 */
export class EncryptionKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EncryptionKeyError';
  }
}

/** 密文结构非法或解密失败（消息中不得包含密钥或密文原文）。 */
export class ApiKeyDecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiKeyDecryptionError';
  }
}

const ENCRYPTION_KEY_BYTES = 32;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const CIPHER_VERSION = 'v1';

/**
 * 解析 `APP_ENCRYPTION_KEY` 为 32 字节 Buffer。
 * 支持 hex（64 字符）与 base64（含 base64url 变体）两种写法，与服务端保持一致。
 */
export function parseEncryptionKey(raw: string): Buffer {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new EncryptionKeyError('APP_ENCRYPTION_KEY 未配置：无法解密模型 API Key。');
  }

  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, 'hex');
  }

  if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(trimmed)) {
    const decoded = Buffer.from(trimmed, 'base64');
    if (decoded.length === ENCRYPTION_KEY_BYTES) {
      return decoded;
    }
  }

  throw new EncryptionKeyError(
    'APP_ENCRYPTION_KEY 格式非法：必须为 32 字节随机值的 hex（64 字符）或 base64 编码。',
  );
}

/** 判断主密钥是否可用（供环境变量校验复用，不抛错）。 */
export function isEncryptionKeyValid(raw: string): boolean {
  try {
    parseEncryptionKey(raw);
    return true;
  } catch {
    return false;
  }
}

/**
 * 解密 `v1:<iv>:<tag>:<cipher>` 格式的 API Key。
 *
 * 失败时抛出的错误只包含结构性提示，绝不回显密文或密钥，便于安全地进入日志。
 */
export function decryptApiKey(encrypted: string, key: Buffer): string {
  const parts = encrypted.split(':');
  if (parts.length !== 4) {
    throw new ApiKeyDecryptionError('API Key 密文格式非法：期望 v1:<iv>:<tag>:<cipher>。');
  }

  const [version, ivSegment, tagSegment, cipherSegment] = parts;
  if (version !== CIPHER_VERSION) {
    throw new ApiKeyDecryptionError('API Key 密文版本不受支持。');
  }
  if (!ivSegment || !tagSegment || !cipherSegment) {
    throw new ApiKeyDecryptionError('API Key 密文分段缺失。');
  }

  if (key.length !== ENCRYPTION_KEY_BYTES) {
    throw new EncryptionKeyError('APP_ENCRYPTION_KEY 长度必须为 32 字节。');
  }

  const iv = decodeSegment(ivSegment);
  const authTag = decodeSegment(tagSegment);
  const cipherText = decodeSegment(cipherSegment);

  if (iv.length !== IV_BYTES || authTag.length !== AUTH_TAG_BYTES) {
    throw new ApiKeyDecryptionError('API Key 密文结构非法：IV 或 AuthTag 长度不正确。');
  }

  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    const plain = Buffer.concat([decipher.update(cipherText), decipher.final()]).toString('utf8');
    if (plain.length === 0) {
      throw new ApiKeyDecryptionError('API Key 解密结果为空。');
    }
    return plain;
  } catch (error) {
    if (error instanceof ApiKeyDecryptionError) {
      throw error;
    }
    // GCM 校验失败 / 主密钥不匹配：不透传底层错误细节。
    throw new ApiKeyDecryptionError('API Key 解密失败：主密钥不匹配或密文已被篡改。');
  }
}

/**
 * 加密工具（与服务端格式一致）。
 * Worker 生产路径不需要加密；导出用于测试构造密文与跨包格式回归验证。
 */
export function encryptApiKey(plain: string, key: Buffer): string {
  if (key.length !== ENCRYPTION_KEY_BYTES) {
    throw new EncryptionKeyError('APP_ENCRYPTION_KEY 长度必须为 32 字节。');
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const cipherText = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [CIPHER_VERSION, iv.toString('hex'), authTag.toString('hex'), cipherText.toString('hex')].join(
    ':',
  );
}

/** 解码 IV / Tag / Cipher（优先 hex，兼容 base64 变体）。 */
function decodeSegment(segment: string): Buffer {
  if (/^[0-9a-fA-F]+$/.test(segment) && segment.length % 2 === 0) {
    return Buffer.from(segment, 'hex');
  }
  return Buffer.from(segment, 'base64');
}
