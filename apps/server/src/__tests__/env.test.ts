import { describe, expect, it } from 'vitest';
import { EnvValidationError, envSchema, loadEnv, parseEnv } from '../config/env.js';
import { ENCRYPTION_KEY_BYTES } from '../crypto/secret-codec.js';

const VALID_ENV: Record<string, string> = {
  DATABASE_URL: 'postgres://fanxiaoshuo:fanxiaoshuo@localhost:5432/fanxiaoshuo',
  REDIS_URL: 'redis://localhost:6379',
  APP_ENCRYPTION_KEY: 'a'.repeat(64),
};

function validEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return { ...VALID_ENV, ...overrides };
}

function captureEnvError(source: NodeJS.ProcessEnv): EnvValidationError {
  try {
    parseEnv(source);
  } catch (error) {
    if (error instanceof EnvValidationError) {
      return error;
    }
    throw error;
  }
  throw new Error('期望 env 校验失败，但实际通过了');
}

describe('parseEnv', () => {
  it('校验通过时归一化默认端口并保留必填项', () => {
    const env = parseEnv(validEnv());
    expect(env.DATABASE_URL).toBe(VALID_ENV['DATABASE_URL']);
    expect(env.REDIS_URL).toBe(VALID_ENV['REDIS_URL']);
    expect(env.APP_ENCRYPTION_KEY).toBe('a'.repeat(64));
    expect(env.API_PORT).toBe(3001);
  });

  it('支持自定义端口与 base64 主密钥', () => {
    const base64Key = Buffer.alloc(ENCRYPTION_KEY_BYTES, 9).toString('base64');
    const env = parseEnv(validEnv({ API_PORT: '4010', APP_ENCRYPTION_KEY: base64Key }));
    expect(env.API_PORT).toBe(4010);
    expect(env.APP_ENCRYPTION_KEY).toBe(base64Key);
  });

  it('缺失 APP_ENCRYPTION_KEY 时 fail-fast 并给出明确路径', () => {
    const source = validEnv();
    delete source['APP_ENCRYPTION_KEY'];
    const error = captureEnvError(source);
    expect(error.message).toContain('APP_ENCRYPTION_KEY');
    expect(error.issues.some((issue) => issue.path === 'APP_ENCRYPTION_KEY')).toBe(true);
  });

  it('空字符串 / 长度错误的主密钥被拒绝', () => {
    for (const key of ['', '   ', 'abc', 'a'.repeat(63)]) {
      const error = captureEnvError(validEnv({ APP_ENCRYPTION_KEY: key }));
      const issue = error.issues.find((item) => item.path === 'APP_ENCRYPTION_KEY');
      expect(issue?.message).toMatch(/32 字节|必填/);
      expect(error.message).not.toContain(`APP_ENCRYPTION_KEY=${key}`);
    }
  });

  it('非法 DATABASE_URL / REDIS_URL 被拒绝', () => {
    const dbError = captureEnvError(validEnv({ DATABASE_URL: 'mysql://localhost/db' }));
    expect(dbError.issues.some((issue) => issue.path === 'DATABASE_URL')).toBe(true);

    const redisError = captureEnvError(validEnv({ REDIS_URL: 'http://localhost:6379' }));
    expect(redisError.issues.some((issue) => issue.path === 'REDIS_URL')).toBe(true);
  });

  it('非法 API_PORT 被拒绝，空字符串回退默认值', () => {
    expect(captureEnvError(validEnv({ API_PORT: '0' })).issues[0]?.path).toBe('API_PORT');
    expect(captureEnvError(validEnv({ API_PORT: 'not-a-port' })).issues[0]?.path).toBe(
      'API_PORT',
    );
    expect(parseEnv(validEnv({ API_PORT: '' })).API_PORT).toBe(3001);
  });

  it('envSchema 与 loadEnv 与 parseEnv 行为一致', () => {
    expect(envSchema.safeParse(validEnv()).success).toBe(true);
    expect(loadEnv(validEnv()).API_PORT).toBe(3001);
  });
});
