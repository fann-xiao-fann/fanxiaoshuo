import type { ApiErrorCode } from '@fanxiaoshuo/shared';

/**
 * Worker 内部业务错误：携带共享契约错误码，可直接映射到 `JobEvent.errorCode`。
 *
 * ⚠️ `message` 必须是已脱敏文本（不得包含明文 API Key / 密文 / Authorization 头）。
 */
export class WorkerJobError extends Error {
  readonly code: ApiErrorCode;

  constructor(message: string, code: ApiErrorCode) {
    super(message);
    this.name = 'WorkerJobError';
    this.code = code;
  }
}

/** 类型守卫。 */
export function isWorkerJobError(error: unknown): error is WorkerJobError {
  return error instanceof WorkerJobError;
}
