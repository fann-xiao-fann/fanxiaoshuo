import {
  workflowRunDetailDtoSchema,
  workflowRunListResponseSchema,
  type CreateWorkflowRunInputPayload,
  type ResumeWorkflowRunInputPayload,
  type WorkflowRunDetailDto,
  type WorkflowRunListQueryPayload,
  type WorkflowRunListResponse,
} from '@fanxiaoshuo/shared';
import { WORKFLOW_EVENTS_URL } from './config';
import { apiRequest, apiRequestVoid, type QueryValue, type RequestOptions } from './http';

/**
 * `/api/v1/workflows` 批量流水线 API 客户端。
 *
 * 请求体与响应体全部使用 `@fanxiaoshuo/shared` 的 Zod 契约严格解析：
 * 视图层只接触 DTO 类型，绝不重复判断 HTTP 状态码或手工拼装字段。
 */

function runPath(runId: string): string {
  return `/workflows/runs/${encodeURIComponent(runId)}`;
}

/**
 * 查询串清洗：`workflowRunListQuerySchema` 使用 `preprocess` 兼容空字符串，
 * 其 `z.input` 退化为 `unknown`，这里统一收敛为 HTTP 层可序列化的值。
 */
function asQueryValue(value: unknown): QueryValue {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  return undefined;
}

export const workflowsApi = {
  list(
    query: WorkflowRunListQueryPayload = {},
    options: RequestOptions = {},
  ): Promise<WorkflowRunListResponse> {
    return apiRequest('/workflows/runs', workflowRunListResponseSchema, {
      ...options,
      query: {
        bookId: asQueryValue(query.bookId),
        status: asQueryValue(query.status),
        page: asQueryValue(query.page),
        pageSize: asQueryValue(query.pageSize),
      },
    });
  },

  createRun(payload: CreateWorkflowRunInputPayload): Promise<WorkflowRunDetailDto> {
    return apiRequest('/workflows/runs', workflowRunDetailDtoSchema, {
      method: 'POST',
      body: payload,
    });
  },

  getRun(runId: string, options: RequestOptions = {}): Promise<WorkflowRunDetailDto> {
    return apiRequest(runPath(runId), workflowRunDetailDtoSchema, options);
  },

  pauseRun(runId: string): Promise<WorkflowRunDetailDto> {
    return apiRequest(`${runPath(runId)}/pause`, workflowRunDetailDtoSchema, { method: 'POST' });
  },

  resumeRun(
    runId: string,
    payload: ResumeWorkflowRunInputPayload = {},
  ): Promise<WorkflowRunDetailDto> {
    return apiRequest(`${runPath(runId)}/resume`, workflowRunDetailDtoSchema, {
      method: 'POST',
      body: payload,
    });
  },

  cancelRun(runId: string): Promise<WorkflowRunDetailDto> {
    return apiRequest(`${runPath(runId)}/cancel`, workflowRunDetailDtoSchema, { method: 'POST' });
  },

  retryStep(runId: string, stepId: string): Promise<WorkflowRunDetailDto> {
    return apiRequest(
      `${runPath(runId)}/steps/${encodeURIComponent(stepId)}/retry`,
      workflowRunDetailDtoSchema,
      { method: 'POST' },
    );
  },

  deleteRun(runId: string): Promise<void> {
    return apiRequestVoid(runPath(runId), { method: 'DELETE' });
  },

  /**
   * SSE 事件流地址：不传 `runId` 时订阅全量批次事件，
   * 传入时附带 `?runId=` 只订阅该批次的进度帧。
   */
  eventsUrl(runId?: string): string {
    if (runId === undefined || runId.length === 0) {
      return WORKFLOW_EVENTS_URL;
    }
    return `${WORKFLOW_EVENTS_URL}?runId=${encodeURIComponent(runId)}`;
  },
};
