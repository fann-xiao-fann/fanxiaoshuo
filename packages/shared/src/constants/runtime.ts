/**
 * 运行期常量：REST 前缀、BullMQ 队列名、Redis 键与 Pub/Sub 频道。
 * 服务端、Worker 与前端 SSE 订阅必须共用此处的字面量，禁止各自硬编码。
 */

/** 全部 REST 接口统一前缀。 */
export const API_PREFIX = '/api/v1' as const;

/** BullMQ 队列名。 */
export const QUEUE_NAMES = {
  /** Change 1：Mastra + BullMQ 全链路冒烟任务 */
  runtimeSmoke: 'runtime-smoke',
  /** Change 4 预留：批量写书工作流 */
  novelWorkflows: 'novel-workflows',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

/** Redis 键名。 */
export const REDIS_KEYS = {
  /** Worker 心跳（TTL 30s，每 10s 刷新） */
  workerHeartbeat: 'fanxiaoshuo:worker:heartbeat',
} as const;

/** Redis Pub/Sub 频道。 */
export const REDIS_CHANNELS = {
  /** 队列任务状态流转事件（排队 / 运行 / 完成 / 失败） */
  jobEvents: 'fanxiaoshuo:events:jobs',
  /** Change 4：批量流水线批次 / 步骤实时进度事件 */
  workflowEvents: 'fanxiaoshuo:events:workflows',
} as const;

/** Worker 心跳参数（与健康检查的判定窗口保持一致）。 */
export const WORKER_HEARTBEAT = {
  intervalMs: 10_000,
  ttlSeconds: 30,
} as const;

/** BullMQ 默认重试策略（指数退避）。 */
export const JOB_RETRY_POLICY = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 2_000 },
} as const;

/** 分页默认值与上限。 */
export const PAGINATION = {
  defaultPage: 1,
  defaultPageSize: 20,
  maxPageSize: 100,
} as const;

/** 用量日志的业务场景标识（后续 Change 在此追加）。 */
export const USAGE_SCENES = {
  /** 模型配置中心「一键测通」 */
  connectivityTest: 'connectivity-test',
  /** 队列冒烟任务 */
  smokeJob: 'smoke-job',
  /** Change 3 预留：章节成文 */
  chapterWrite: 'chapter-write',
  /** Change 3 预留：设定抽取 */
  loreExtract: 'lore-extract',
  /** Change 4 预留：审稿质检 */
  chapterReview: 'chapter-review',
  /** Change 4：批量流水线细纲规划 */
  outlinePlan: 'outline-plan',
} as const;

export type UsageScene = (typeof USAGE_SCENES)[keyof typeof USAGE_SCENES];
