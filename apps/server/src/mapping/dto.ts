import {
  AGENT_ROLE_META,
  agentRoleRouteDtoSchema,
  agentRoleSchema,
  apiErrorCodeSchema,
  bookDtoSchema,
  chapterDetailDtoSchema,
  chapterRevisionDetailSchema,
  chapterRevisionSummarySchema,
  chapterTreeItemSchema,
  modelDtoSchema,
  modelSummarySchema,
  providerDtoSchema,
  providerSummarySchema,
  usageLogDtoSchema,
  volumeDtoSchema,
  type AgentRole,
  type AgentRoleRouteDto,
  type ApiErrorCode,
  type BookDto,
  type ChapterDetailDto,
  type ChapterRevisionDetail,
  type ChapterRevisionSummary,
  type ChapterTreeItem,
  type ModelDto,
  type ModelSummary,
  type ProviderDto,
  type ProviderSummary,
  type UsageLogDto,
  type UsageLogStatus,
  type VolumeDto,
} from '@fanxiaoshuo/shared';
import type {
  AgentRoleBindingRecord,
  BookAggregateRecord,
  ChapterMetaRecord,
  ChapterRecord,
  ChapterRevisionRecord,
  ModelRecord,
  ProviderRecord,
  UsageLogRecord,
  VolumeAggregateRecord,
  VolumeRecord,
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
