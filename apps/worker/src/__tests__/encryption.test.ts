import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ApiKeyDecryptionError,
  EncryptionKeyError,
  decryptApiKey,
  encryptApiKey,
  isEncryptionKeyValid,
  parseEncryptionKey,
} from '../security/encryption.js';

describe('parseEncryptionKey', () => {
  it('接受 32 字节 hex 与 base64', () => {
    const raw = randomBytes(32);
    expect(parseEncryptionKey(raw.toString('hex'))).toHaveLength(32);
    expect(parseEncryptionKey(raw.toString('base64'))).toHaveLength(32);
    expect(isEncryptionKeyValid(raw.toString('hex'))).toBe(true);
  });

  it('拒绝空值、错误长度与非 hex/base64 内容', () => {
    expect(() => parseEncryptionKey('')).toThrow(EncryptionKeyError);
    expect(() => parseEncryptionKey('   ')).toThrow(EncryptionKeyError);
    expect(() => parseEncryptionKey('abc')).toThrow(EncryptionKeyError);
    expect(() => parseEncryptionKey('z'.repeat(64))).toThrow(EncryptionKeyError);
    expect(isEncryptionKeyValid('not-a-key')).toBe(false);
  });
});

describe('decryptApiKey / encryptApiKey', () => {
  it('与服务端格式一致：v1:<iv>:<tag>:<cipher> 可往返解密', () => {
    const key = randomBytes(32);
    const plain = 'sk-live-abcdefghijklmnop';
    const encrypted = encryptApiKey(plain, key);

    const parts = encrypted.split(':');
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe('v1');
    expect(decryptApiKey(encrypted, key)).toBe(plain);
  });

  it('兼容 base64 主密钥', () => {
    const key = randomBytes(32);
    const parsed = parseEncryptionKey(key.toString('base64'));
    const encrypted = encryptApiKey('sk-from-base64-key', key);
    expect(decryptApiKey(encrypted, parsed)).toBe('sk-from-base64-key');
  });

  it('主密钥不匹配时抛出脱敏错误（不含密文与明文）', () => {
    const key = randomBytes(32);
    const encrypted = encryptApiKey('sk-secret-value', key);

    let thrown: unknown;
    try {
      decryptApiKey(encrypted, randomBytes(32));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ApiKeyDecryptionError);
    const message = (thrown as Error).message;
    expect(message).not.toContain('sk-secret-value');
    expect(message).not.toContain(encrypted);
  });

  it('拒绝非法格式与版本', () => {
    const key = randomBytes(32);
    expect(() => decryptApiKey('plain-text', key)).toThrow(ApiKeyDecryptionError);
    expect(() => decryptApiKey('v2:aabb:ccdd:eeff', key)).toThrow(/版本/);
    expect(() => decryptApiKey('v1:::', key)).toThrow(ApiKeyDecryptionError);
  });
});
