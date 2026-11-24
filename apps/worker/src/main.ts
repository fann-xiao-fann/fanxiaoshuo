import { parseWorkerEnv } from './config/env.js';
import { consoleWorkerLogger } from './logger.js';
import { startWorker } from './worker.js';

/**
 * Worker 进程入口：校验环境变量 → 启动 `runtime-smoke` 消费与心跳 → 等待停机信号。
 */
export async function main(): Promise<void> {
  const logger = consoleWorkerLogger;
  const env = parseWorkerEnv(process.env);

  const handle = await startWorker({ env, logger });
  logger.info('[worker] @fanxiaoshuo/worker 已就绪', {
    queue: 'runtime-smoke',
    concurrency: env.WORKER_CONCURRENCY,
    pid: process.pid,
  });

  await handle.closed;
}
