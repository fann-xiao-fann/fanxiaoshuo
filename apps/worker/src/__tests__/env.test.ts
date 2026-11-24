import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseWorkerEnv, WorkerEnvError } from '../config/env.js';

function validEnv(): NodeJS.ProcessEnv {
  return {
    REDIS_URL: 'redis://localhost:6379',
    DATABASE_URL: 'postgres://fanxiaoshuo:fanxiaoshuo@localhost:5432/fanxiaoshuo',
    APP_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
  };
}

describe('parseWorkerEnv', () => {
  it('校验通过并应用 WORKER_CONCURRENCY 默认值 3', () => {
    const env = parseWorkerEnv(validEnv());
    expect(env.WORKER_CONCURRENCY).toBe(3);
    expect(env.NODE_ENV).toBe('development');
  });

  it('字符串并发度自动转数字', () => {
    const env = parseWorkerEnv({ ...validEnv(), WORKER_CONCURRENCY: '8' });
    expect(env.WORKER_CONCURRENCY).toBe(8);
  });

  it('缺省 REDIS_URL 时 fail-fast 并给出字段名', () => {
    const source = validEnv();
    delete source.REDIS_URL;

    let thrown: unknown;
    try {
      parseWorkerEnv(source);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(WorkerEnvError);
    expect((thrown as WorkerEnvError).issues.join('\n')).toContain('REDIS_URL');
  });

  it('拒绝非法 APP_ENCRYPTION_KEY 与并发度', () => {
    expect(() => parseWorkerEnv({ ...validEnv(), APP_ENCRYPTION_KEY: 'too-short' })).toThrow(
      /APP_ENCRYPTION_KEY/,
    );
    expect(() => parseWorkerEnv({ ...validEnv(), WORKER_CONCURRENCY: '0' })).toThrow(
      /WORKER_CONCURRENCY/,
    );
    expect(() => parseWorkerEnv({ ...validEnv(), WORKER_CONCURRENCY: 'abc' })).toThrow(
      /WORKER_CONCURRENCY/,
    );
  });

  it('拒绝非 redis / postgres 协议的连接串', () => {
    expect(() => parseWorkerEnv({ ...validEnv(), REDIS_URL: 'http://localhost:6379' })).toThrow(
      /REDIS_URL/,
    );
    expect(() =>
      parseWorkerEnv({ ...validEnv(), DATABASE_URL: 'mysql://localhost:3306/db' }),
    ).toThrow(/DATABASE_URL/);
  });

  it('不合法时不回显敏感变量值', () => {
    const secret = randomBytes(32).toString('base64');
    let thrown: unknown;
    try {
      parseWorkerEnv({ ...validEnv(), APP_ENCRYPTION_KEY: secret.slice(0, 10) });
    } catch (error) {
      thrown = error;
    }
    expect((thrown as Error).message).not.toContain(secret.slice(0, 10));
  });
});
