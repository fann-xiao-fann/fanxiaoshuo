import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';

/**
 * 梵小说 BullMQ Worker 进程入口。
 *
 * `.env` 查找顺序（先命中者生效）：
 * 1. 包目录下 `.env`（`apps/worker/.env`，本地覆盖用）
 * 2. 仓库根 `.env`（`pnpm env:init` 生成）
 */
loadDotenv({
  path: [resolve(process.cwd(), '.env'), resolve(process.cwd(), '../../.env')],
  quiet: true,
});

try {
  const { main } = await import('./main.js');
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[worker] 启动失败：${message}`);
  process.exitCode = 1;
}
