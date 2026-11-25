import { describe, expect, it } from 'vitest';
import {
  AGENT_ROLES,
  API_ERROR_CODES,
  API_PREFIX,
  AUTO_REVISION_INTERVAL_MS,
  BOOK_STATUSES,
  BOOK_STATUS_LABELS,
  CHAPTER_STATUSES,
  CHAPTER_STATUS_LABELS,
  DEFAULT_TARGET_CHAPTER_WORDS,
  EXPORT_FORMATS,
  JOB_RETRY_POLICY,
  MAX_CHAPTER_CONTENT_LENGTH,
  PAGINATION,
  PROVIDER_PROTOCOLS,
  QUEUE_NAMES,
  REDIS_CHANNELS,
  REDIS_KEYS,
  REVISION_SOURCES,
  REVISION_SOURCE_LABELS,
  SSE_EVENT_NAMES,
  USAGE_SCENES,
  WORKER_HEARTBEAT,
  agentRoleSchema,
  apiErrorSchema,
  bookDtoSchema,
  bookExportQuerySchema,
  bookListQuerySchema,
  bookTreeResponseSchema,
  chapterDetailDtoSchema,
  chapterRevisionSummarySchema,
  chapterSaveResponseSchema,
  countNovelWords,
  createBookSchema,
  createProviderSchema,
  healthResponseSchema,
  jobEventSchema,
  providerDtoSchema,
  restoreChapterRevisionResponseSchema,
  reorderChaptersSchema,
  reorderVolumesSchema,
  saveChapterContentSchema,
  updateBookSchema,
  usageLogStatusSchema,
  volumeDtoSchema,
} from '../index.js';
import {
  AI_APPLY_MODES,
  AI_STREAM_EVENT_NAMES,
  AI_WRITE_ACTIONS,
  DEFAULT_MAX_CONTEXT_TOKENS,
  KNOWLEDGE_CARD_CATEGORIES,
  MAX_RECALLED_CARDS,
  aiChapterStreamRequestSchema,
  aiContextPreviewRequestSchema,
  aiContextPreviewResponseSchema,
  aiStreamDeltaEventSchema,
  aiStreamDoneEventSchema,
  aiStreamErrorEventSchema,
  aiStreamStartEventSchema,
  applyAiChapterContentResponseSchema,
  applyAiChapterContentSchema,
  bookOutlineDtoSchema,
  chapterSummaryDtoSchema,
  createKnowledgeCardSchema,
  extractChapterSummaryResponseSchema,
  extractChapterSummarySchema,
  knowledgeCardDtoSchema,
  knowledgeCardListQuerySchema,
  knowledgeCardListResponseSchema,
  updateKnowledgeCardSchema,
  upsertBookOutlineSchema,
  upsertChapterSummarySchema,
} from '../index.js';
import {
  DEFAULT_WORKFLOW_MAX_COST_USD,
  DEFAULT_WORKFLOW_MAX_REWORK_ROUNDS,
  DEFAULT_WORKFLOW_MIN_PASS_SCORE,
  MAX_WORKFLOW_CHAPTERS_PER_RUN,
  MAX_WORKFLOW_MAX_COST_USD,
  MAX_WORKFLOW_REWORK_ROUNDS,
  MIN_WORKFLOW_MAX_COST_USD,
  WORKFLOW_EVENT_TYPES,
  WORKFLOW_MODES,
  WORKFLOW_MODE_LABELS,
  WORKFLOW_PAUSE_REASONS,
  WORKFLOW_PAUSE_REASON_LABELS,
  WORKFLOW_RUN_STATUSES,
  WORKFLOW_RUN_STATUS_LABELS,
  WORKFLOW_SSE_EVENT_NAMES,
  WORKFLOW_STATUS_TO_EVENT_TYPE,
  WORKFLOW_STEP_STAGES,
  WORKFLOW_STEP_STATUSES,
  WORKFLOW_STEP_STATUS_LABELS,
  WORKFLOW_STEP_STAGE_LABELS,
  WORKFLOW_TERMINAL_STATUSES,
  autoCreateChaptersConfigSchema,
  createWorkflowRunSchema,
  isWorkflowTerminalStatus,
  resumeWorkflowRunSchema,
  workflowEventSchema,
  workflowEventTypeSchema,
  workflowJobPayloadSchema,
  workflowModeSchema,
  workflowPauseReasonSchema,
  workflowRunConfigSchema,
  workflowRunDetailDtoSchema,
  workflowRunListQuerySchema,
  workflowRunListResponseSchema,
  workflowRunStatusSchema,
  workflowRunSummaryDtoSchema,
  workflowStepDtoSchema,
  workflowStepStageSchema,
  workflowStepStatusSchema,
} from '../index.js';
import {
  TOOLBOX_CATEGORIES,
  TOOLBOX_CATEGORY_LABELS,
  TOOLBOX_OUTLINE_FIELDS,
  TOOLBOX_RUN_STATUSES,
  TOOLBOX_TOOL_DEFINITIONS,
  TOOLBOX_TOOL_IDS,
  USAGE_SCENE_LABELS,
  applyToolboxCardRequestSchema,
  applyToolboxOutlineRequestSchema,
  getToolboxToolDefinition,
  runToolboxRequestSchema,
  toolboxOutputSchema,
  toolboxRunDetailSchema,
  toolboxRunListQuerySchema,
  toolboxRunListResponseSchema,
  toolboxRunSummarySchema,
  toolboxToolDefinitionSchema,
  toolboxToolsResponseSchema,
  validateToolboxInputs,
} from '../index.js';

describe('barrel 导出（前后端 / Worker 统一入口）', () => {
  it('导出全部契约常量与 schema', () => {
    expect(AGENT_ROLES).toHaveLength(4);
    expect(PROVIDER_PROTOCOLS).toHaveLength(4);
    expect(Object.keys(API_ERROR_CODES).length).toBeGreaterThan(10);
    expect(agentRoleSchema.safeParse('showrunner').success).toBe(true);
    expect(createProviderSchema).toBeDefined();
    expect(providerDtoSchema).toBeDefined();
    expect(usageLogStatusSchema).toBeDefined();
    expect(healthResponseSchema).toBeDefined();
    expect(jobEventSchema).toBeDefined();
    expect(apiErrorSchema).toBeDefined();
  });
});

describe('Change 2 书库 / 编辑器契约 barrel 导出', () => {
  it('导出书籍、卷章、快照与导出相关枚举', () => {
    expect(BOOK_STATUSES).toHaveLength(4);
    expect(CHAPTER_STATUSES).toHaveLength(4);
    expect(REVISION_SOURCES).toHaveLength(4);
    expect(EXPORT_FORMATS).toHaveLength(2);
    expect(BOOK_STATUS_LABELS.ongoing).toBe('连载中');
    expect(CHAPTER_STATUS_LABELS.final).toBe('定稿');
    expect(REVISION_SOURCE_LABELS.restore).toBe('回滚备份');
  });

  it('导出书库运行常量', () => {
    expect(AUTO_REVISION_INTERVAL_MS).toBe(300_000);
    expect(MAX_CHAPTER_CONTENT_LENGTH).toBe(500_000);
    expect(DEFAULT_TARGET_CHAPTER_WORDS).toBe(3000);
  });

  it('导出全部新增 Zod Schema', () => {
    expect(bookDtoSchema).toBeDefined();
    expect(bookListQuerySchema).toBeDefined();
    expect(bookTreeResponseSchema).toBeDefined();
    expect(createBookSchema).toBeDefined();
    expect(updateBookSchema).toBeDefined();
    expect(volumeDtoSchema).toBeDefined();
    expect(reorderVolumesSchema).toBeDefined();
    expect(chapterDetailDtoSchema).toBeDefined();
    expect(reorderChaptersSchema).toBeDefined();
    expect(saveChapterContentSchema).toBeDefined();
    expect(chapterSaveResponseSchema).toBeDefined();
    expect(chapterRevisionSummarySchema).toBeDefined();
    expect(restoreChapterRevisionResponseSchema).toBeDefined();
    expect(bookExportQuerySchema).toBeDefined();
  });

  it('导出前后端共用字数统计函数', () => {
    expect(countNovelWords('你好 world')).toBe(3);
  });
});

describe('运行期常量契约', () => {
  it('REST 前缀统一为 /api/v1', () => {
    expect(API_PREFIX).toBe('/api/v1');
  });

  it('队列名与设计文档一致', () => {
    expect(QUEUE_NAMES.runtimeSmoke).toBe('runtime-smoke');
    expect(new Set(Object.values(QUEUE_NAMES)).size).toBe(Object.values(QUEUE_NAMES).length);
  });

  it('Redis 心跳键 / 事件频道与设计文档一致', () => {
    expect(REDIS_KEYS.workerHeartbeat).toBe('fanxiaoshuo:worker:heartbeat');
    expect(REDIS_CHANNELS.jobEvents).toBe('fanxiaoshuo:events:jobs');
    expect(REDIS_CHANNELS.workflowEvents).toBe('fanxiaoshuo:events:workflows');
  });

  it('Worker 心跳 TTL 必须大于上报间隔（避免误判离线）', () => {
    expect(WORKER_HEARTBEAT.ttlSeconds * 1000).toBeGreaterThan(WORKER_HEARTBEAT.intervalMs);
  });

  it('重试策略固定为 3 次指数退避', () => {
    expect(JOB_RETRY_POLICY.attempts).toBe(3);
    expect(JOB_RETRY_POLICY.backoff.type).toBe('exponential');
    expect(JOB_RETRY_POLICY.backoff.delay).toBeGreaterThan(0);
  });

  it('分页上限为 100，默认值合法', () => {
    expect(PAGINATION.defaultPage).toBe(1);
    expect(PAGINATION.defaultPageSize).toBeLessThanOrEqual(PAGINATION.maxPageSize);
    expect(PAGINATION.maxPageSize).toBe(100);
  });

  it('用量场景覆盖测通与冒烟任务', () => {
    expect(USAGE_SCENES.connectivityTest).toBe('connectivity-test');
    expect(USAGE_SCENES.smokeJob).toBe('smoke-job');
    expect(USAGE_SCENES.outlinePlan).toBe('outline-plan');
    expect(USAGE_SCENES.chapterWrite).toBe('chapter-write');
    expect(USAGE_SCENES.chapterReview).toBe('chapter-review');
    expect(USAGE_SCENES.loreExtract).toBe('lore-extract');
  });

  it('SSE 帧名可供前端 EventSource 复用', () => {
    expect(SSE_EVENT_NAMES.jobEvent).toBe('job-event');
  });
});

describe('Change 3 设定集 / AI 写作契约 barrel 导出', () => {
  it('导出 Book Bible 领域枚举与上下文预算常量', () => {
    expect(KNOWLEDGE_CARD_CATEGORIES).toHaveLength(6);
    expect(AI_WRITE_ACTIONS).toHaveLength(4);
    expect(AI_APPLY_MODES).toHaveLength(3);
    expect(AI_STREAM_EVENT_NAMES.delta).toBe('delta');
    expect(DEFAULT_MAX_CONTEXT_TOKENS).toBe(8_000);
    expect(MAX_RECALLED_CARDS).toBe(8);
  });

  it('导出 Book Bible 与 AI 写作全部 Zod Schema', () => {
    expect(bookOutlineDtoSchema).toBeDefined();
    expect(upsertBookOutlineSchema).toBeDefined();
    expect(knowledgeCardDtoSchema).toBeDefined();
    expect(knowledgeCardListQuerySchema).toBeDefined();
    expect(knowledgeCardListResponseSchema).toBeDefined();
    expect(createKnowledgeCardSchema).toBeDefined();
    expect(updateKnowledgeCardSchema).toBeDefined();
    expect(chapterSummaryDtoSchema).toBeDefined();
    expect(upsertChapterSummarySchema).toBeDefined();
    expect(extractChapterSummarySchema).toBeDefined();
    expect(extractChapterSummaryResponseSchema).toBeDefined();
    expect(aiContextPreviewRequestSchema).toBeDefined();
    expect(aiContextPreviewResponseSchema).toBeDefined();
    expect(aiChapterStreamRequestSchema).toBeDefined();
    expect(aiStreamStartEventSchema).toBeDefined();
    expect(aiStreamDeltaEventSchema).toBeDefined();
    expect(aiStreamDoneEventSchema).toBeDefined();
    expect(aiStreamErrorEventSchema).toBeDefined();
    expect(applyAiChapterContentSchema).toBeDefined();
    expect(applyAiChapterContentResponseSchema).toBeDefined();
  });
});

describe('Change 4 批量流水线契约 barrel 导出', () => {
  it('导出批量流水线领域枚举与中文展示名', () => {
    expect(WORKFLOW_MODES).toHaveLength(3);
    expect(WORKFLOW_RUN_STATUSES).toHaveLength(6);
    expect(WORKFLOW_TERMINAL_STATUSES).toHaveLength(3);
    expect(WORKFLOW_STEP_STATUSES).toHaveLength(5);
    expect(WORKFLOW_STEP_STAGES).toHaveLength(7);
    expect(WORKFLOW_PAUSE_REASONS).toHaveLength(2);
    expect(WORKFLOW_EVENT_TYPES).toHaveLength(7);

    expect(WORKFLOW_MODE_LABELS.full_pipeline).toBe('全链路生产');
    expect(WORKFLOW_RUN_STATUS_LABELS.paused).toBe('已暂停');
    expect(WORKFLOW_STEP_STATUS_LABELS.skipped).toBe('已跳过');
    expect(WORKFLOW_STEP_STAGE_LABELS.reworking).toBe('按意见返工');
    expect(WORKFLOW_PAUSE_REASON_LABELS.BUDGET_EXCEEDED).toBe('触及预算上限');
    expect(WORKFLOW_SSE_EVENT_NAMES.workflowEvent).toBe('workflow-event');
    expect(WORKFLOW_STATUS_TO_EVENT_TYPE.paused).toBe('workflow.paused');
    expect(isWorkflowTerminalStatus('cancelled')).toBe(true);
    expect(isWorkflowTerminalStatus('running')).toBe(false);
  });

  it('导出预算与返工运行常量', () => {
    expect(DEFAULT_WORKFLOW_MIN_PASS_SCORE).toBe(75);
    expect(DEFAULT_WORKFLOW_MAX_REWORK_ROUNDS).toBe(1);
    expect(MAX_WORKFLOW_REWORK_ROUNDS).toBe(3);
    expect(DEFAULT_WORKFLOW_MAX_COST_USD).toBe(5);
    expect(MIN_WORKFLOW_MAX_COST_USD).toBe(0.0001);
    expect(MAX_WORKFLOW_MAX_COST_USD).toBe(500);
    expect(MAX_WORKFLOW_CHAPTERS_PER_RUN).toBe(50);
  });

  it('导出批量流水线全部 Zod Schema', () => {
    expect(workflowModeSchema).toBeDefined();
    expect(workflowRunStatusSchema).toBeDefined();
    expect(workflowStepStatusSchema).toBeDefined();
    expect(workflowStepStageSchema).toBeDefined();
    expect(workflowPauseReasonSchema).toBeDefined();
    expect(workflowEventTypeSchema).toBeDefined();
    expect(autoCreateChaptersConfigSchema).toBeDefined();
    expect(workflowRunConfigSchema).toBeDefined();
    expect(createWorkflowRunSchema).toBeDefined();
    expect(resumeWorkflowRunSchema).toBeDefined();
    expect(workflowStepDtoSchema).toBeDefined();
    expect(workflowRunSummaryDtoSchema).toBeDefined();
    expect(workflowRunDetailDtoSchema).toBeDefined();
    expect(workflowRunListQuerySchema).toBeDefined();
    expect(workflowRunListResponseSchema).toBeDefined();
    expect(workflowJobPayloadSchema).toBeDefined();
    expect(workflowEventSchema).toBeDefined();
  });
});

describe('Change 5 创作工具盒契约 barrel 导出', () => {
  it('导出创作工具盒领域枚举与中文展示名', () => {
    expect(TOOLBOX_CATEGORIES).toHaveLength(3);
    expect(TOOLBOX_TOOL_IDS).toHaveLength(6);
    expect(TOOLBOX_RUN_STATUSES).toEqual(['completed', 'failed']);
    expect(TOOLBOX_OUTLINE_FIELDS).toHaveLength(4);
    expect(TOOLBOX_CATEGORY_LABELS.planning).toBe('立项策划');
    expect(TOOLBOX_TOOL_DEFINITIONS).toHaveLength(6);
  });

  it('导出全部创作工具盒 Zod Schema 与查询函数', () => {
    expect(toolboxToolDefinitionSchema).toBeDefined();
    expect(toolboxToolsResponseSchema).toBeDefined();
    expect(toolboxOutputSchema).toBeDefined();
    expect(runToolboxRequestSchema).toBeDefined();
    expect(toolboxRunSummarySchema).toBeDefined();
    expect(toolboxRunDetailSchema).toBeDefined();
    expect(toolboxRunListQuerySchema).toBeDefined();
    expect(toolboxRunListResponseSchema).toBeDefined();
    expect(applyToolboxCardRequestSchema).toBeDefined();
    expect(applyToolboxOutlineRequestSchema).toBeDefined();
    expect(getToolboxToolDefinition('book-pitch')?.id).toBe('book-pitch');
    expect(validateToolboxInputs('book-pitch', {}).ok).toBe(false);
  });

  it('全量 7 个用量场景标签可从 barrel 直接复用', () => {
    expect(Object.keys(USAGE_SCENE_LABELS)).toHaveLength(7);
    expect(USAGE_SCENES.toolboxRun).toBe('toolbox-run');
    expect(USAGE_SCENE_LABELS['toolbox-run']).toBe('创作工具盒');
  });
});
