import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema.js';

/** Drizzle 实例类型（含完整 schema，供泛型推断）。 */
export type Database = NodePgDatabase<typeof schema>;

export interface DatabaseConnection {
  readonly pool: Pool;
  readonly db: Database;
}

/**
 * 创建 PostgreSQL 连接池与 Drizzle 实例。
 * 连接池懒连接：启动时不会立即阻塞，健康检查会主动 `SELECT 1` 探测。
 */
export function createDatabase(connectionString: string): DatabaseConnection {
  const pool = new Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  const db = drizzle(pool, { schema });
  return { pool, db };
}

export { schema };
