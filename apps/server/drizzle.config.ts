import { defineConfig } from 'drizzle-kit';

/**
 * Drizzle Kit 配置：`pnpm db:generate` 依据 `src/db/schema.ts` 生成 SQL 迁移。
 * 连接串仅在需要直连数据库的子命令（studio / push）时使用。
 */
export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  strict: true,
  verbose: true,
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://fanxiaoshuo:fanxiaoshuo@localhost:5432/fanxiaoshuo',
  },
});
