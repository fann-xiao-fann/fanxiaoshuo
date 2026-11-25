import {
  applyToolboxCardRequestSchema,
  applyToolboxOutlineRequestSchema,
  bookOutlineDtoSchema,
  knowledgeCardDtoSchema,
  runToolboxRequestSchema,
  toolboxRunDetailSchema,
  toolboxRunListResponseSchema,
  toolboxToolsResponseSchema,
  type ApplyToolboxCardRequestPayload,
  type ApplyToolboxOutlineRequestPayload,
  type BookOutlineDto,
  type KnowledgeCardDto,
  type RunToolboxRequestPayload,
  type ToolboxRunDetail,
  type ToolboxRunListResponse,
  type ToolboxRunStatus,
  type ToolboxToolId,
  type ToolboxToolsResponse,
} from '@fanxiaoshuo/shared';
import { apiRequest, apiRequestVoid, type QueryValue, type RequestOptions } from './http';

/**
 * `/api/v1/toolbox` 创作工具盒 API 客户端。
 *
 * 7 个接口的响应体全部使用 `@fanxiaoshuo/shared` 的 Zod 契约严格解析：
 * - 目录接口的响应包裹字段是 `{ tools }`（不是裸数组），此处不做任何手工松散解析；
 * - 请求体在发出前先用共享 Schema 解析一次，避免可选字段默认值（如大纲 `mode`）漂移；
 * - 视图层只接触 DTO 类型，不重复判断 HTTP 状态码。
 */

function runPath(runId: string): string {
  return `/toolbox/runs/${encodeURIComponent(runId)}`;
}

/**
 * 查询串清洗：共享查询 Schema 使用 `preprocess` 兼容空字符串，其 `z.input` 退化为
 * `unknown`，这里改用显式强类型入参并逐项收敛为 HTTP 层可序列化的值。
 */
export interface ToolboxRunListQuery {
  toolId?: ToolboxToolId;
  bookId?: string;
  status?: ToolboxRunStatus;
  page?: number;
  pageSize?: number;
}

function asQueryValue(value: unknown): QueryValue {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  return undefined;
}

export const toolboxApi = {
  /** `GET /toolbox/tools`：6 个内置工具的声明式目录。 */
  listTools(options: RequestOptions = {}): Promise<ToolboxToolsResponse> {
    return apiRequest('/toolbox/tools', toolboxToolsResponseSchema, options);
  },

  /** `GET /toolbox/runs`：分页 + 工具 / 作品筛选的历史运行列表。 */
  listRuns(
    query: ToolboxRunListQuery = {},
    options: RequestOptions = {},
  ): Promise<ToolboxRunListResponse> {
    return apiRequest('/toolbox/runs', toolboxRunListResponseSchema, {
      ...options,
      query: {
        toolId: asQueryValue(query.toolId),
        bookId: asQueryValue(query.bookId),
        status: asQueryValue(query.status),
        page: asQueryValue(query.page),
        pageSize: asQueryValue(query.pageSize),
      },
    });
  },

  /** `POST /toolbox/runs`：同步执行一次工具并返回结构化详情。 */
  runTool(payload: RunToolboxRequestPayload): Promise<ToolboxRunDetail> {
    const body = runToolboxRequestSchema.parse(payload);
    return apiRequest('/toolbox/runs', toolboxRunDetailSchema, { method: 'POST', body });
  },

  /** `GET /toolbox/runs/:runId`：回看单条历史运行详情。 */
  getRun(runId: string, options: RequestOptions = {}): Promise<ToolboxRunDetail> {
    return apiRequest(runPath(runId), toolboxRunDetailSchema, options);
  },

  /** `DELETE /toolbox/runs/:runId`：删除历史记录（204），不影响已回写的卡片与大纲。 */
  deleteRun(runId: string): Promise<void> {
    return apiRequestVoid(runPath(runId), { method: 'DELETE' });
  },

  /** `POST /toolbox/runs/:runId/apply-card`：把某条结果一键存为设定卡。 */
  applyCard(
    runId: string,
    payload: ApplyToolboxCardRequestPayload,
  ): Promise<KnowledgeCardDto> {
    const body = applyToolboxCardRequestSchema.parse(payload);
    return apiRequest(`${runPath(runId)}/apply-card`, knowledgeCardDtoSchema, {
      method: 'POST',
      body,
    });
  },

  /** `POST /toolbox/runs/:runId/apply-outline`：把某条结果写入全书总大纲。 */
  applyOutline(
    runId: string,
    payload: ApplyToolboxOutlineRequestPayload,
  ): Promise<BookOutlineDto> {
    const body = applyToolboxOutlineRequestSchema.parse(payload);
    return apiRequest(`${runPath(runId)}/apply-outline`, bookOutlineDtoSchema, {
      method: 'POST',
      body,
    });
  },
};
