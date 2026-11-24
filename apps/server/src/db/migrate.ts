import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { loadEnv } from '../config/env.js';
import { createDatabase } from './client.js';

/**
 * 幂等数据库迁移脚本（对接根 `pnpm db:migrate`）。
 *
 * Drizzle Migrator 使用 `drizzle.__drizzle_migrations` 记录已应用的文件哈希，
 * 重复执行会跳过已应用迁移，不删除、不重建任何业务数据。
 */

/** 从仓库根或包目录启动时都能找到 `.env`。 */
function loadProjectEnv(): void {
  const candidates = [
    resolve(process.cwd(), '.env'),
    resolve(process.cwd(), '../../.env'),
    fileURLToPath(new URL('../../../../.env', import.meta.url)),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      loadDotenv({ path: candidate, quiet: true });
      return;
    }
  }
}

/** 迁移目录在 `src/db` 与 `dist/db` 下均可解析到 `apps/server/drizzle`。 */
export function resolveMigrationsFolder(): string {
  return fileURLToPath(new URL('../../drizzle', import.meta.url));
}

export interface RunMigrationsResult {
  readonly applied: boolean;
  readonly folder: string;
}

/**
 * 执行全部待应用的迁移。
 * 无待应用迁移时同样安全返回 `{ applied: false }`。
 */
export async function runMigrations(options: {
  databaseUrl: string;
  migrationsFolder?: string;
  log?: (message: string) => void;
}): Promise<RunMigrationsResult> {
  const folder = options.migrationsFolder ?? resolveMigrationsFolder();
  if (!existsSync(folder)) {
    throw new Error(`迁移目录不存在：${folder}`);
  }

  const { pool, db } = createDatabase(options.databaseUrl);
  try {
    await migrate(db, { migrationsFolder: folder, migrationsTable: '__drizzle_migrations' });
    options.log?.('数据库迁移已全部应用（幂等，重复执行安全）。');
    return { applied: true, folder };
  } finally {
    await pool.end();
  }
}

async function main(): Promise<void> {
  loadProjectEnv();
  const env = loadEnv();
  const result = await runMigrations({
    databaseUrl: env.DATABASE_URL,
    log: (message) => {
      console.log(`[db:migrate] ${message}`);
    },
  });
  console.log(`[db:migrate] 完成，迁移目录：${result.folder}`);
}

const isEntrypoint = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isEntrypoint) {
  main().catch((error: unknown) => {
    console.error('[db:migrate] 迁移失败：', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
