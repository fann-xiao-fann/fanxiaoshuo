import type { ApiErrorIssue } from '@fanxiaoshuo/shared';
import { z } from 'zod';
import { parseEncryptionKey, SecretCodecError } from '../crypto/secret-codec.js';

/**
 * 服务端环境变量契约。
 *
 * 安全红线：`APP_ENCRYPTION_KEY` 缺失或长度非法时，服务启动必须 fail-fast；
 * 所有错误信息只描述格式要求，绝不回显密钥内容。
 */

const NODE_ENVS = ['development', 'test', 'production'] as const;

/** 空字符串（`.env.example` 未填写的状态）按「未提供」处理。 */
const optionalNumber = z.preprocess(
  (value) => (value === '' || value === null || value === undefined ? undefined : value),
  z.coerce.number().int().min(1).max(65_535).default(3001),
);

function isPostgresUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'postgres:' || url.protocol === 'postgresql:';
  } catch {
    return false;
  }
}

function isRedisUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'redis:' || url.protocol === 'rediss:';
  } catch {
    return false;
  }
}

const rawEnvSchema = z.object({
  DATABASE_URL: z
    .string({ error: '缺少必填环境变量 DATABASE_URL（例如 postgres://user:pass@localhost:5432/fanxiaoshuo）' })
    .trim()
    .min(1, 'DATABASE_URL 不能为空')
    .refine(isPostgresUrl, 'DATABASE_URL 必须是合法的 postgres:// 或 postgresql:// 连接串'),
  REDIS_URL: z
    .string({ error: '缺少必填环境变量 REDIS_URL（例如 redis://localhost:6379）' })
    .trim()
    .min(1, 'REDIS_URL 不能为空')
    .refine(isRedisUrl, 'REDIS_URL 必须是合法的 redis:// 或 rediss:// 连接串'),
  APP_ENCRYPTION_KEY: z.string().optional(),
  API_PORT: optionalNumber,
  NODE_ENV: z.enum(NODE_ENVS).optional(),
});

export type RawServerEnv = z.infer<typeof rawEnvSchema>;

/** 校验并归一化后的服务端环境变量。 */
export interface ServerEnv {
  readonly DATABASE_URL: string;
  readonly REDIS_URL: string;
  readonly APP_ENCRYPTION_KEY: string;
  readonly API_PORT: number;
  readonly NODE_ENV: (typeof NODE_ENVS)[number] | undefined;
}

/** 环境变量校验失败：携带全部字段级问题（供启动日志与测试断言）。 */
export class EnvValidationError extends Error {
  readonly issues: readonly ApiErrorIssue[];

  constructor(issues: readonly ApiErrorIssue[]) {
    const detail = issues.map((issue) => `${issue.path}: ${issue.message}`).join('；');
    super(`环境变量校验失败，服务启动已中止：${detail}`);
    this.name = 'EnvValidationError';
    this.issues = issues;
  }
}

export const envSchema = rawEnvSchema
  .superRefine((value, ctx) => {
    const rawKey = value.APP_ENCRYPTION_KEY?.trim() ?? '';
    if (rawKey.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['APP_ENCRYPTION_KEY'],
        message:
          '缺少必填环境变量 APP_ENCRYPTION_KEY（32 字节 hex 或 base64；可执行 pnpm env:init 生成）',
      });
      return;
    }
    try {
      parseEncryptionKey(rawKey);
    } catch (error) {
      ctx.addIssue({
        code: 'custom',
        path: ['APP_ENCRYPTION_KEY'],
        message:
          error instanceof SecretCodecError
            ? error.message
            : 'APP_ENCRYPTION_KEY 必须是 32 字节随机值的 hex（64 字符）或 base64 编码',
      });
    }
  })
  .transform(
    (value): ServerEnv => ({
      DATABASE_URL: value.DATABASE_URL,
      REDIS_URL: value.REDIS_URL,
      APP_ENCRYPTION_KEY: (value.APP_ENCRYPTION_KEY ?? '').trim(),
      API_PORT: value.API_PORT,
      NODE_ENV: value.NODE_ENV,
    }),
  );

export type ServerEnvSchema = typeof envSchema;

function toIssues(error: z.ZodError): ApiErrorIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map((segment) => String(segment)).join('.'),
    message: issue.message,
  }));
}

/**
 * 解析环境变量（默认 `process.env`）。
 *
 * @throws {EnvValidationError} 任一必填项缺失 / 格式非法
 */
export function parseEnv(source: NodeJS.ProcessEnv = process.env): ServerEnv {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    throw new EnvValidationError(toIssues(result.error));
  }
  return result.data;
}

/** 启动期读取并校验环境变量（fail-fast 语义的显式入口）。 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): ServerEnv {
  return parseEnv(source);
}
