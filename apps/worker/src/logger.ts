/**
 * Worker 轻量日志接口。
 *
 * 约束：调用方传入的元信息必须已脱敏，严禁把明文 API Key 写入日志。
 * 独立接口便于单元测试注入静默实现，避免测试输出噪声。
 */
export interface WorkerLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/** 默认控制台日志实现（生产 / 开发通用）。 */
export const consoleWorkerLogger: WorkerLogger = {
  info(message, meta) {
    if (meta === undefined) {
      console.info(message);
      return;
    }
    console.info(message, meta);
  },
  warn(message, meta) {
    if (meta === undefined) {
      console.warn(message);
      return;
    }
    console.warn(message, meta);
  },
  error(message, meta) {
    if (meta === undefined) {
      console.error(message);
      return;
    }
    console.error(message, meta);
  },
};

/** 测试与静默场景使用的空日志实现。 */
export const silentWorkerLogger: WorkerLogger = {
  info() {},
  warn() {},
  error() {},
};
