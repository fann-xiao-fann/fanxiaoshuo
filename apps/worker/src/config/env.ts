import { z } from 'zod';
import { isEncryptionKeyValid } from '../security/encryption.js';

/**
 * Worker 环境变量契约。
 *
 * - `REDIS_URL`：BullMQ 队列 + Pub/Sub + 心跳共用
 * - `DATABASE_URL`：live 模式解析模型配置、写入 `llm_usage_logs`
 * - `APP_ENCRYPTION_KEY`：live 模式解密 `api_key_encrypted`（AES-256-GCM）
 * - `WORKER_CONCURRENCY`：BullMQ 并发度（默认 3，与 `.env.example` 一致）
 */
export const workerEnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    REDIS_URL: z
      .url({ protocol: /^rediss?$/, message: 'REDIS_URL 必须为 redis:// 或 rediss:// 地址' })
      .max(2048),
    DATABASE_URL: z
      .url({ protocol: /^postgres(ql)?$/, message: 'DATABASE_URL 必须为 postgres:// 连接串' })
      .max(2048),
    APP_ENCRYPTION_KEY: z
      .string()
      .min(1, 'APP_ENCRYPTION_KEY 必填（32 字节 hex 或 base64）')
      .refine(isEncryptionKeyValid, {
        message: 'APP_ENCRYPTION_KEY 必须为 32 字节随机值的 hex（64 字符）或 base64 编码',
      }),
    WORKER_CONCURRENCY: z.coerce
      .number()
      .int('WORKER_CONCURRENCY 必须为整数')
      .min(1, 'WORKER_CONCURRENCY 至少为 1')
      .max(64, 'WORKER_CONCURRENCY 最多为 64')
      .default(3),
  })
  .describe('BullMQ Worker 环境变量');

export type WorkerEnv = z.infer<typeof workerEnvSchema>;

/** 环境变量校验失败：消息中只包含变量名与规则，绝不回显变量值。 */
export class WorkerEnvError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Worker 环境变量校验失败：\n- ${issues.join('\n- ')}`);
    this.name = 'WorkerEnvError';
    this.issues = issues;
  }
}

/**
 * 解析并校验环境变量（缺失 / 非法时 fail-fast）。
 * 默认读取 `process.env`；测试可传入自定义快照。
 */
export function parseWorkerEnv(source: NodeJS.ProcessEnv = process.env): WorkerEnv {
  const result = workerEnvSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `${path}: ${issue.message}`;
    });
    throw new WorkerEnvError(issues);
  }
  return result.data;
}
