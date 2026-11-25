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
