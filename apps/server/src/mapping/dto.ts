import {
  AGENT_ROLE_META,
  agentRoleRouteDtoSchema,
  agentRoleSchema,
  apiErrorCodeSchema,
  bookDtoSchema,
  bookOutlineDtoSchema,
  chapterDetailDtoSchema,
  chapterRevisionDetailSchema,
  chapterRevisionSummarySchema,
  chapterSummaryDtoSchema,
  chapterTreeItemSchema,
  getToolboxToolDefinition,
  knowledgeCardDtoSchema,
  modelDtoSchema,
  modelSummarySchema,
  providerDtoSchema,
  providerSummarySchema,
  toolboxRunDetailSchema,
  toolboxRunSummarySchema,
  usageLogDtoSchema,
  volumeDtoSchema,
  workflowRunDetailDtoSchema,
  workflowRunSummaryDtoSchema,
  workflowStepDtoSchema,
  type AgentRole,
  type AgentRoleRouteDto,
  type ApiErrorCode,
  type BookDto,
  type BookOutlineDto,
  type ChapterDetailDto,
  type ChapterRevisionDetail,
  type ChapterRevisionSummary,
  type ChapterSummaryDto,
  type ChapterTreeItem,
  type KnowledgeCardDto,
  type ModelDto,
  type ModelSummary,
  type ProviderDto,
  type ProviderSummary,
  type ToolboxRunDetail,
  type ToolboxRunSummary,
  type UsageLogDto,
  type UsageLogStatus,
  type VolumeDto,
  type WorkflowRunDetailDto,
  type WorkflowRunSummaryDto,
  type WorkflowStepDto,
} from '@fanxiaoshuo/shared';
import type {
  AgentRoleBindingRecord,
  BookAggregateRecord,
  BookOutlineRecord,
  ChapterMetaRecord,
  ChapterRecord,
  ChapterRevisionRecord,
  ChapterSummaryRecord,
  KnowledgeCardRecord,
  ModelRecord,
  ProviderRecord,
  ToolboxRunRecord,
  UsageLogRecord,
  VolumeAggregateRecord,
  VolumeRecord,
  WorkflowRunDetailRecord,
  WorkflowRunRecord,
  WorkflowStepRecord,
} from '../repositories/types.js';

/** 角色未绑定时的默认采样温度（与 `agent_role_bindings.temperature` 默认值一致）。 */
export const DEFAULT_ROLE_TEMPERATURE = 0.7;

/** Provider 行 → 对外 DTO（绝不包含密文 / 明文 Key）。 */
export function toProviderDto(record: ProviderRecord): ProviderDto {
  return providerDtoSchema.parse({
    id: record.id,
    name: record.name,
    protocol: record.protocol,
    baseUrl: record.baseUrl,
    apiKeyMask: record.apiKeyMask,
    isEnabled: record.isEnabled,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  });
}

export function toProviderSummary(record: ProviderRecord): ProviderSummary {
  return providerSummarySchema.parse({
    id: record.id,
    name: record.name,
    protocol: record.protocol,
    isEnabled: record.isEnabled,
  });
}

export function toModelDto(record: ModelRecord): ModelDto {
  return modelDtoSchema.parse({
    id: record.id,
    providerId: record.providerId,
    modelId: record.modelId,
    displayName: record.displayName,
    contextWindow: record.contextWindow,
    inputPricePer1M: record.inputPricePer1m,
    outputPricePer1M: record.outputPricePer1m,
    isEnabled: record.isEnabled,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  });
}

export function toModelSummary(record: ModelRecord): ModelSummary {
  return modelSummarySchema.parse({
    id: record.id,
    modelId: record.modelId,
    displayName: record.displayName,
    contextWindow: record.contextWindow,
    inputPricePer1M: record.inputPricePer1m,
    outputPricePer1M: record.outputPricePer1m,
    isEnabled: record.isEnabled,
  });
}

/**
 * 角色路由 DTO：始终返回 4 个固定角色的完整视图。
 * `binding` 为 null 表示未绑定，此时模型/供应商/时间字段均为 null。
 */
export function toAgentRoleRouteDto(
  role: AgentRole,
  binding: AgentRoleBindingRecord | null,
): AgentRoleRouteDto {
  const meta = AGENT_ROLE_META[role];
  return agentRoleRouteDtoSchema.parse({
    role,
    roleLabel: meta.label,
    responsibility: meta.responsibility,
    modelId: binding ? binding.modelId : null,
    temperature: binding ? binding.temperature : DEFAULT_ROLE_TEMPERATURE,
    maxTokens: binding ? binding.maxTokens : null,
    updatedAt: binding ? binding.updatedAt.toISOString() : null,
    model: binding?.model ? toModelSummary(binding.model) : null,
    provider: binding?.provider ? toProviderSummary(binding.provider) : null,
  });
}

/** 用量日志行 → 对外 DTO。 */
export function toUsageLogDto(record: UsageLogRecord): UsageLogDto {
  return usageLogDtoSchema.parse({
    id: record.id,
    role: record.role,
    providerId: record.providerId,
    modelRef: record.modelRef,
    scene: record.scene,
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens,
    estimatedCostUsd: record.estimatedCostUsd,
    latencyMs: record.latencyMs,
    status: record.status,
    errorCode: record.errorCode,
    errorMessage: record.errorMessage,
    createdAt: record.createdAt.toISOString(),
  });
}

/** 数据库文本 → 受控角色枚举（脏数据回退 null，避免审计页整体 500）。 */
export function parseAgentRole(value: string | null | undefined): AgentRole | null {
  if (value === null || value === undefined) {
    return null;
  }
  const result = agentRoleSchema.safeParse(value);
  return result.success ? result.data : null;
}

/** 数据库文本 → 统一错误码（未知值回退 null）。 */
export function parseApiErrorCode(value: string | null | undefined): ApiErrorCode | null {
  if (value === null || value === undefined) {
    return null;
  }
  const result = apiErrorCodeSchema.safeParse(value);
  return result.success ? result.data : null;
}

/** 数据库文本 → 用量状态（默认 success，兼容历史数据）。 */
export function parseUsageLogStatus(value: string | null | undefined): UsageLogStatus {
  return value === 'error' ? 'error' : 'success';
}

/* -------------------------------------------------------------------------- */
/*                    书库 / 卷章 / 快照 DTO 映射（Change 2）                   */
/* -------------------------------------------------------------------------- */

/** 书籍记录 + 聚合 → 对外 DTO。 */
export function toBookDto(record: BookAggregateRecord): BookDto {
  return bookDtoSchema.parse({
    id: record.book.id,
    title: record.book.title,
    authorPenName: record.book.authorPenName,
    genre: record.book.genre,
    status: record.book.status,
    synopsis: record.book.synopsis,
    targetChapterWords: record.book.targetChapterWords,
    volumeCount: record.volumeCount,
    chapterCount: record.chapterCount,
    totalWordCount: record.totalWordCount,
    deletedAt: record.book.deletedAt ? record.book.deletedAt.toISOString() : null,
    createdAt: record.book.createdAt.toISOString(),
    updatedAt: record.book.updatedAt.toISOString(),
  });
}

/** 分卷记录 + 聚合 → 对外 DTO。 */
export function toVolumeDto(record: VolumeAggregateRecord): VolumeDto {
  return volumeDtoSchema.parse({
    id: record.volume.id,
    bookId: record.volume.bookId,
    title: record.volume.title,
    summary: record.volume.summary,
    sortOrder: record.volume.sortOrder,
    chapterCount: record.chapterCount,
    totalWordCount: record.totalWordCount,
    deletedAt: record.volume.deletedAt ? record.volume.deletedAt.toISOString() : null,
    createdAt: record.volume.createdAt.toISOString(),
    updatedAt: record.volume.updatedAt.toISOString(),
  });
}

/** 单卷（无聚合）→ 空聚合 DTO（新建分卷 201 响应）。 */
export function toEmptyVolumeDto(volume: VolumeRecord): VolumeDto {
  return toVolumeDto({ volume, chapterCount: 0, totalWordCount: 0 });
}

/** 章节元信息 → 卷章树节点（**不含正文**）。 */
export function toChapterTreeItem(record: ChapterMetaRecord): ChapterTreeItem {
  return chapterTreeItemSchema.parse({
    id: record.id,
    bookId: record.bookId,
    volumeId: record.volumeId,
    title: record.title,
    sortOrder: record.sortOrder,
    status: record.status,
    wordCount: record.wordCount,
    version: record.version,
    deletedAt: record.deletedAt ? record.deletedAt.toISOString() : null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  });
}

/** 章节记录 → 章节详情 DTO（编辑器加载完整正文）。 */
export function toChapterDetailDto(record: ChapterRecord): ChapterDetailDto {
  return chapterDetailDtoSchema.parse({
    id: record.id,
    bookId: record.bookId,
    volumeId: record.volumeId,
    title: record.title,
    sortOrder: record.sortOrder,
    status: record.status,
    contentText: record.contentText,
    contentJson: record.contentJson,
    wordCount: record.wordCount,
    version: record.version,
    deletedAt: record.deletedAt ? record.deletedAt.toISOString() : null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  });
}

/** 快照记录 → 列表摘要（不含正文）。 */
export function toRevisionSummary(record: ChapterRevisionRecord): ChapterRevisionSummary {
  return chapterRevisionSummarySchema.parse({
    id: record.id,
    chapterId: record.chapterId,
    version: record.version,
    source: record.source,
    note: record.note,
    titleSnapshot: record.titleSnapshot,
    wordCount: record.wordCount,
    createdAt: record.createdAt.toISOString(),
  });
}

/** 快照记录 → 快照详情（含正文，供预览 / 回滚前确认）。 */
export function toRevisionDetail(record: ChapterRevisionRecord): ChapterRevisionDetail {
  return chapterRevisionDetailSchema.parse({
    ...toRevisionSummary(record),
    contentText: record.contentText,
    contentJson: record.contentJson,
  });
}

/* -------------------------------------------------------------------------- */
/*                  Change 3：Book Bible DTO 映射（不下发原始向量）                  */
/* -------------------------------------------------------------------------- */

/** 总大纲记录 → 对外 DTO。 */
export function toBookOutlineDto(record: BookOutlineRecord): BookOutlineDto {
  return bookOutlineDtoSchema.parse({
    bookId: record.bookId,
    mainPlot: record.mainPlot,
    worldSetting: record.worldSetting,
    styleGuide: record.styleGuide,
    endingPlan: record.endingPlan,
    updatedAt: record.updatedAt.toISOString(),
  });
}

/**
 * 设定卡记录 → 对外 DTO。
 * 仅暴露 `hasEmbedding` 与 `embeddingModelRef`，绝不输出原始浮点向量数组。
 */
export function toKnowledgeCardDto(record: KnowledgeCardRecord): KnowledgeCardDto {
  return knowledgeCardDtoSchema.parse({
    id: record.id,
    bookId: record.bookId,
    category: record.category,
    title: record.title,
    summary: record.summary,
    content: record.content,
    aliases: record.aliases,
    tags: record.tags,
    pinned: record.pinned,
    sortOrder: record.sortOrder,
    hasEmbedding: Boolean(record.embedding?.length),
    embeddingModelRef: record.embeddingModelRef,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  });
}

/** 章节细纲与剧情摘要记录 → 对外 DTO。 */
export function toChapterSummaryDto(record: ChapterSummaryRecord): ChapterSummaryDto {
  return chapterSummaryDtoSchema.parse({
    chapterId: record.chapterId,
    bookId: record.bookId,
    outline: record.outline,
    summary: record.summary,
    keyEvents: record.keyEvents,
    charactersPresent: record.charactersPresent,
    source: record.source,
    updatedAt: record.updatedAt.toISOString(),
  });
}

/* -------------------------------------------------------------------------- */
/*              Change 4：批量流水线 DTO 映射（批次摘要 / 步骤 / 详情）              */
/* -------------------------------------------------------------------------- */

/** 批次记录 → 批次摘要 DTO（列表项与详情公共字段）。 */
export function toWorkflowRunSummaryDto(record: WorkflowRunRecord): WorkflowRunSummaryDto {
  return workflowRunSummaryDtoSchema.parse({
    id: record.id,
    bookId: record.bookId,
    bookTitle: record.bookTitle,
    mode: record.mode,
    status: record.status,
    config: record.config,
    totalSteps: record.totalSteps,
    completedSteps: record.completedSteps,
    failedSteps: record.failedSteps,
    maxCostUsd: record.maxCostUsd,
    spentCostUsd: record.spentCostUsd,
    totalInputTokens: record.totalInputTokens,
    totalOutputTokens: record.totalOutputTokens,
    pauseRequested: record.pauseRequested,
    cancelRequested: record.cancelRequested,
    pauseReason: record.pauseReason,
    errorCode: record.errorCode,
    errorMessage: record.errorMessage,
    startedAt: record.startedAt ? record.startedAt.toISOString() : null,
    finishedAt: record.finishedAt ? record.finishedAt.toISOString() : null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  });
}

/** 单章步骤记录 → 步骤 DTO（审稿问题清单为强类型 `string[]`）。 */
export function toWorkflowStepDto(record: WorkflowStepRecord): WorkflowStepDto {
  return workflowStepDtoSchema.parse({
    id: record.id,
    runId: record.runId,
    chapterId: record.chapterId,
    stepIndex: record.stepIndex,
    chapterTitleSnapshot: record.chapterTitleSnapshot,
    status: record.status,
    stage: record.stage,
    reworkCount: record.reworkCount,
    criticScore: record.criticScore,
    criticPassed: record.criticPassed,
    criticSummary: record.criticSummary,
    criticIssues: record.criticIssues,
    outputWordCount: record.outputWordCount,
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens,
    estimatedCostUsd: record.estimatedCostUsd,
    backupRevisionId: record.backupRevisionId,
    errorCode: record.errorCode,
    errorMessage: record.errorMessage,
    startedAt: record.startedAt ? record.startedAt.toISOString() : null,
    finishedAt: record.finishedAt ? record.finishedAt.toISOString() : null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  });
}

/** 批次详情记录 → 详情 DTO（步骤保持 `stepIndex` 升序）。 */
export function toWorkflowRunDetailDto(record: WorkflowRunDetailRecord): WorkflowRunDetailDto {
  return workflowRunDetailDtoSchema.parse({
    ...toWorkflowRunSummaryDto(record),
    steps: record.steps.map(toWorkflowStepDto),
  });
}

/* -------------------------------------------------------------------------- */
/*                 Change 5：创作工具盒运行历史（toolbox_runs）                 */
/* -------------------------------------------------------------------------- */

/**
 * 工具运行记录 → 摘要 DTO。
 *
 * `toolName` 由当前工具目录补齐（目录调整后历史仍可读），
 * `overview` / `itemCount` 从结构化产出派生（失败记录为 0 条 + 空串）。
 */
export function toToolboxRunSummaryDto(record: ToolboxRunRecord): ToolboxRunSummary {
  return toolboxRunSummarySchema.parse({
    id: record.id,
    toolId: record.toolId,
    toolName: getToolboxToolDefinition(record.toolId)?.name ?? record.toolId,
    bookId: record.bookId,
    role: record.role,
    status: record.status,
    overview: record.output?.overview ?? '',
    itemCount: record.output?.items.length ?? 0,
    modelRef: record.modelRef,
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens,
    estimatedCostUsd: record.estimatedCostUsd,
    latencyMs: record.latencyMs,
    errorCode: record.errorCode,
    errorMessage: record.errorMessage,
    createdAt: record.createdAt.toISOString(),
  });
}

/** 工具运行记录 → 详情 DTO（摘要 + 归一输入 + 结构化产出）。 */
export function toToolboxRunDetailDto(record: ToolboxRunRecord): ToolboxRunDetail {
  return toolboxRunDetailSchema.parse({
    ...toToolboxRunSummaryDto(record),
    inputs: record.inputs,
    output: record.output,
  });
}
