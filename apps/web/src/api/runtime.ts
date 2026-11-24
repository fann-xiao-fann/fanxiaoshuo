import {
  smokeJobDtoSchema,
  type CreateSmokeJobInputPayload,
  type SmokeJobDto,
} from '@fanxiaoshuo/shared';
import { z } from 'zod';
import { RUNTIME_EVENTS_URL } from './config';
import { apiRequest } from './http';

/**
 * 入队响应只依赖 `jobId`：共享契约已冻结 GET 单任务 DTO，
 * 但未约束 POST 的完整响应体，因此这里宽松解析，随后统一以 GET 刷新状态。
 */
const enqueueSmokeJobResponseSchema = z.looseObject({
  jobId: z.string().min(1).max(128),
});

/** `/api/v1/runtime`：BullMQ + Mastra 冒烟任务与 SSE 事件流。 */
export const runtimeApi = {
  async createSmokeJob(payload: CreateSmokeJobInputPayload): Promise<{ jobId: string }> {
    return apiRequest('/runtime/smoke-jobs', enqueueSmokeJobResponseSchema, {
      method: 'POST',
      body: payload,
    });
  },

  getSmokeJob(jobId: string, options: { signal?: AbortSignal } = {}): Promise<SmokeJobDto> {
    return apiRequest(`/runtime/smoke-jobs/${encodeURIComponent(jobId)}`, smokeJobDtoSchema, {
      signal: options.signal,
    });
  },

  eventsUrl(): string {
    return RUNTIME_EVENTS_URL;
  },
};
