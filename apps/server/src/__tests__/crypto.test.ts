import { describe, expect, it } from 'vitest';
import {
  ENCRYPTION_KEY_BYTES,
  SECRET_CIPHERTEXT_VERSION,
  SecretCodecError,
  createSecretCodec,
  decryptSecret,
  encryptSecret,
  maskApiKey,
  parseEncryptionKey,
  safeEqualString,
} from '../crypto/secret-codec.js';

const KEY_HEX = 'a'.repeat(64);
const PLAINTEXT = 'sk-proj-测试-secret-1234567890-abcdef';

describe('parseEncryptionKey', () => {
  it('接受 64 字符 hex 与 44 字符 base64（均为 32 字节）', () => {
    const fromHex = parseEncryptionKey(KEY_HEX);
    expect(fromHex).toHaveLength(ENCRYPTION_KEY_BYTES);

    const base64 = Buffer.alloc(ENCRYPTION_KEY_BYTES, 7).toString('base64');
    const fromBase64 = parseEncryptionKey(base64);
    expect(fromBase64).toHaveLength(ENCRYPTION_KEY_BYTES);
    expect(fromBase64.equals(Buffer.alloc(ENCRYPTION_KEY_BYTES, 7))).toBe(true);
  });

  it('拒绝空值、长度错误与非法字符，且错误信息不回显密钥', () => {
    for (const invalid of ['', '   ', 'abc', 'z'.repeat(64), 'a'.repeat(63)]) {
      let captured: unknown;
      try {
        parseEncryptionKey(invalid);
      } catch (error) {
        captured = error;
      }
      expect(captured).toBeInstanceOf(SecretCodecError);
      expect((captured as Error).message).not.toContain(invalid.trim() || 'APP_ENCRYPTION_KEY=');
    }
  });
});

describe('AES-256-GCM 加解密', () => {
  const key = parseEncryptionKey(KEY_HEX);

  it('加密后可还原明文，且格式符合 v1:<iv>:<tag>:<cipher>', () => {
    const encrypted = encryptSecret(PLAINTEXT, key);
    const parts = encrypted.split(':');
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe(SECRET_CIPHERTEXT_VERSION);
    expect(parts[1]).toMatch(/^[0-9a-f]{24}$/);
    expect(parts[2]).toMatch(/^[0-9a-f]{32}$/);
    expect(parts[3]).toMatch(/^[0-9a-f]+$/);
    expect(decryptSecret(encrypted, key)).toBe(PLAINTEXT);
  });

  it('相同明文每次加密产生不同密文（随机 IV）', () => {
    const first = encryptSecret(PLAINTEXT, key);
    const second = encryptSecret(PLAINTEXT, key);
    expect(first).not.toBe(second);
    expect(decryptSecret(first, key)).toBe(PLAINTEXT);
    expect(decryptSecret(second, key)).toBe(PLAINTEXT);
  });

  it('密文被篡改时鉴权失败并抛出明确错误', () => {
    const encrypted = encryptSecret(PLAINTEXT, key);
    const parts = encrypted.split(':');
    const cipher = parts[3] ?? '';
    const tamperedCipher = cipher.endsWith('0') ? `${cipher.slice(0, -1)}1` : `${cipher.slice(0, -1)}0`;
    const tampered = [parts[0], parts[1], parts[2], tamperedCipher].join(':');

    expect(() => decryptSecret(tampered, key)).toThrowError(SecretCodecError);
    expect(() => decryptSecret(tampered, key)).toThrowError(/解密失败/);
  });

  it('使用错误密钥或非法格式时解密失败', () => {
    const encrypted = encryptSecret(PLAINTEXT, key);
    const wrongKey = parseEncryptionKey('b'.repeat(64));
    expect(() => decryptSecret(encrypted, wrongKey)).toThrowError(SecretCodecError);
    expect(() => decryptSecret('v2:aa:bb:cc', key)).toThrowError(/格式非法/);
    expect(() => decryptSecret('not-a-ciphertext', key)).toThrowError(/格式非法/);
  });

  it('createSecretCodec 暴露 encrypt / decrypt / mask', () => {
    const codec = createSecretCodec(KEY_HEX);
    const encrypted = codec.encrypt(PLAINTEXT);
    expect(codec.decrypt(encrypted)).toBe(PLAINTEXT);
    expect(codec.mask(PLAINTEXT)).toBe('sk-***cdef');
  });
});

describe('maskApiKey', () => {
  it('长度 >= 10 保留前 3 后 4', () => {
    expect(maskApiKey('sk-test-secret-key-1234567890')).toBe('sk-***7890');
    expect(maskApiKey('1234567890')).toBe('123***7890');
    expect(maskApiKey('  sk-abcdefghij  ')).toBe('sk-***ghij');
  });

  it('长度 < 10 全掩码，绝不泄露字符', () => {
    for (const short of ['', 'a', 'sk-123456', '123456789']) {
      expect(maskApiKey(short)).toBe('******');
    }
  });
});

describe('safeEqualString', () => {
  it('等值返回 true，长度或内容不同返回 false', () => {
    expect(safeEqualString('abc', 'abc')).toBe(true);
    expect(safeEqualString('abc', 'abd')).toBe(false);
    expect(safeEqualString('abc', 'abcd')).toBe(false);
  });
});
