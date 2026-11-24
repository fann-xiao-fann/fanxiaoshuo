import { Pool } from 'pg';

/**
 * 创建 Worker 专用的 PostgreSQL 连接池。
 *
 * 连接数刻意保持较小：Worker 的 DB 负载主要是「解析模型配置 + 写入用量日志」，
 * 真正的并发控制由 BullMQ `WORKER_CONCURRENCY` 决定。
 */
export function createPgPool(databaseUrl: string): Pool {
  return new Pool({
    connectionString: databaseUrl,
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: 'fanxiaoshuo-worker',
  });
}
