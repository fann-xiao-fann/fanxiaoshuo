import { z } from 'zod';

/**
 * 全仓统一错误码。键与值必须完全一致（`API_ERROR_CODES.X === 'X'`），
 * 以便前端按 `ApiErrorCode` 做 switch 分支且日志可读。
 */
export const API_ERROR_CODES = {
  /** 请求参数/查询串未通过 Zod 校验 */
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  /** 资源不存在 */
  NOT_FOUND: 'NOT_FOUND',
  /** 资源冲突（如名称重复、被引用无法删除） */
  CONFLICT: 'CONFLICT',
  /** 未预期的内部错误 */
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  /** 依赖服务（PG / Redis / Worker）不可用 */
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  /** 缺少或非法 APP_ENCRYPTION_KEY */
  ENCRYPTION_KEY_INVALID: 'ENCRYPTION_KEY_INVALID',
  /** Provider 不存在 */
  PROVIDER_NOT_FOUND: 'PROVIDER_NOT_FOUND',
  /** Provider 已停用 */
  PROVIDER_DISABLED: 'PROVIDER_DISABLED',
  /** 模型不存在 */
  MODEL_NOT_FOUND: 'MODEL_NOT_FOUND',
  /** 模型已停用 */
  MODEL_DISABLED: 'MODEL_DISABLED',
  /** 模型仍被写书角色绑定，禁止删除 */
  MODEL_IN_USE: 'MODEL_IN_USE',
  /** 一键测通失败（上游未通过） */
  MODEL_TEST_FAILED: 'MODEL_TEST_FAILED',
  /** 角色未绑定模型 */
  AGENT_ROLE_UNBOUND: 'AGENT_ROLE_UNBOUND',
  /** 上游鉴权失败（Key 无效 / 无权限） */
  UPSTREAM_AUTH_ERROR: 'UPSTREAM_AUTH_ERROR',
  /** 上游限流 */
  UPSTREAM_RATE_LIMIT: 'UPSTREAM_RATE_LIMIT',
  /** 上游超时 */
  UPSTREAM_TIMEOUT: 'UPSTREAM_TIMEOUT',
  /** 上游其它错误 */
  UPSTREAM_ERROR: 'UPSTREAM_ERROR',
  /** 超出运行预算上限（批量熔断） */
  BUDGET_EXCEEDED: 'BUDGET_EXCEEDED',
  /** 队列不可用 */
  QUEUE_UNAVAILABLE: 'QUEUE_UNAVAILABLE',
  /** 后台任务不存在 */
  JOB_NOT_FOUND: 'JOB_NOT_FOUND',
  /** 书籍不存在（或已彻底删除） */
  BOOK_NOT_FOUND: 'BOOK_NOT_FOUND',
  /** 分卷不存在（或不属于目标书籍） */
  VOLUME_NOT_FOUND: 'VOLUME_NOT_FOUND',
  /** 章节不存在（或不属于目标书籍） */
  CHAPTER_NOT_FOUND: 'CHAPTER_NOT_FOUND',
  /** 章节乐观锁版本过期（携带服务端最新 version） */
  CHAPTER_VERSION_CONFLICT: 'CHAPTER_VERSION_CONFLICT',
  /** 章节历史快照不存在 */
  REVISION_NOT_FOUND: 'REVISION_NOT_FOUND',
  /** 设定卡不存在（或不属于目标书籍） */
  KNOWLEDGE_CARD_NOT_FOUND: 'KNOWLEDGE_CARD_NOT_FOUND',
  /** AI 写作 / 摘要提炼缺少可用上下文（无选区且无正文，或正文为空） */
  AI_EMPTY_CONTEXT: 'AI_EMPTY_CONTEXT',
  /** 批量流水线批次不存在 */
  WORKFLOW_RUN_NOT_FOUND: 'WORKFLOW_RUN_NOT_FOUND',
  /** 批量流水线步骤不存在 */
  WORKFLOW_STEP_NOT_FOUND: 'WORKFLOW_STEP_NOT_FOUND',
  /** 批次仍处于活跃态（排队 / 运行 / 暂停），禁止删除或重复启动 */
  WORKFLOW_RUN_ACTIVE: 'WORKFLOW_RUN_ACTIVE',
  /** 批次当前状态不允许该操作（如对终态批次续跑） */
  WORKFLOW_INVALID_STATE: 'WORKFLOW_INVALID_STATE',
  /** 创作工具盒工具不存在 */
  TOOLBOX_TOOL_NOT_FOUND: 'TOOLBOX_TOOL_NOT_FOUND',
  /** 创作工具盒运行记录不存在 */
  TOOLBOX_RUN_NOT_FOUND: 'TOOLBOX_RUN_NOT_FOUND',
  /** 创作工具盒结果条目索引越界（或运行未成功，不可回写） */
  TOOLBOX_ITEM_OUT_OF_RANGE: 'TOOLBOX_ITEM_OUT_OF_RANGE',
} as const;

export type ApiErrorCode = keyof typeof API_ERROR_CODES;

/**
 * 由错误码对象派生 enum schema：避免维护两份字面量列表导致契约漂移。
 * （键与值一致，因此 keyof 与 value 联合类型完全相同。）
 */
export const apiErrorCodeSchema = z.enum(
  Object.keys(API_ERROR_CODES) as [ApiErrorCode, ...ApiErrorCode[]],
);

/** 错误码 → HTTP 状态码映射，供 Fastify 统一错误处理器使用。 */
export const API_ERROR_HTTP_STATUS: Record<ApiErrorCode, number> = {
  VALIDATION_ERROR: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  INTERNAL_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,
  ENCRYPTION_KEY_INVALID: 500,
  PROVIDER_NOT_FOUND: 404,
  PROVIDER_DISABLED: 409,
  MODEL_NOT_FOUND: 404,
  MODEL_DISABLED: 409,
  MODEL_IN_USE: 409,
  MODEL_TEST_FAILED: 502,
  AGENT_ROLE_UNBOUND: 409,
  UPSTREAM_AUTH_ERROR: 502,
  UPSTREAM_RATE_LIMIT: 429,
  UPSTREAM_TIMEOUT: 504,
  UPSTREAM_ERROR: 502,
  BUDGET_EXCEEDED: 402,
  QUEUE_UNAVAILABLE: 503,
  JOB_NOT_FOUND: 404,
  BOOK_NOT_FOUND: 404,
  VOLUME_NOT_FOUND: 404,
  CHAPTER_NOT_FOUND: 404,
  CHAPTER_VERSION_CONFLICT: 409,
  REVISION_NOT_FOUND: 404,
  KNOWLEDGE_CARD_NOT_FOUND: 404,
  AI_EMPTY_CONTEXT: 400,
  WORKFLOW_RUN_NOT_FOUND: 404,
  WORKFLOW_STEP_NOT_FOUND: 404,
  WORKFLOW_RUN_ACTIVE: 409,
  WORKFLOW_INVALID_STATE: 409,
  TOOLBOX_TOOL_NOT_FOUND: 404,
  TOOLBOX_RUN_NOT_FOUND: 404,
  TOOLBOX_ITEM_OUT_OF_RANGE: 400,
};

/** 字段级校验问题（由 ZodError.issues 投影而来，路径用 `.` 连接）。 */
export const apiErrorIssueSchema = z.object({
  path: z.string(),
  message: z.string(),
});

export type ApiErrorIssue = z.infer<typeof apiErrorIssueSchema>;

/**
 * 统一错误响应体。所有非 2xx 响应必须符合该结构，
 * 且 `message` 中禁止出现明文 API Key（由服务端负责脱敏）。
 */
export const apiErrorSchema = z.object({
  code: apiErrorCodeSchema,
  message: z.string().min(1),
  details: z.array(apiErrorIssueSchema).optional(),
  requestId: z.string().min(1).optional(),
});

export type ApiError = z.infer<typeof apiErrorSchema>;

/** 按错误码读取 HTTP 状态码（未知码兜底 500）。 */
export function apiErrorStatus(code: ApiErrorCode): number {
  return API_ERROR_HTTP_STATUS[code] ?? 500;
}
