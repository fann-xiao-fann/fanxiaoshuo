import type {
  AgentRole,
  ApiErrorCode,
  BookStatus,
  ChapterStatus,
  ChapterSummarySource,
  KnowledgeCardCategory,
  ProviderProtocol,
  RevisionSource,
  UsageLogStatus,
  UsageSummary,
} from '@fanxiaoshuo/shared';
import type { AgentRoleBindingInputPayload, CreateProviderInput } from '@fanxiaoshuo/shared';
import type { UsageLogRecordInput } from '@fanxiaoshuo/agents';

/**
 * Repository 层领域模型与接口。
 *
 * 设计目的：路由只依赖这些接口，生产环境注入 Drizzle 实现，
 * 测试环境注入内存实现，从而在无 Docker / 无 PostgreSQL 的情况下跑完整 `fastify.inject()` 集成测试。
 */

/** Provider 完整记录（含密文，仅服务端内部使用，禁止直接返回给客户端）。 */
export interface ProviderRecord {
  readonly id: string;
  readonly name: string;
  readonly protocol: ProviderProtocol;
  readonly baseUrl: string;
  readonly apiKeyEncrypted: string;
  readonly apiKeyMask: string;
  readonly isEnabled: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreateProviderRecordInput {
  readonly name: string;
  readonly protocol: ProviderProtocol;
  readonly baseUrl: string;
  readonly apiKeyEncrypted: string;
  readonly apiKeyMask: string;
  readonly isEnabled: boolean;
}

export type UpdateProviderRecordPatch = Partial<
  Pick<
    ProviderRecord,
    'name' | 'protocol' | 'baseUrl' | 'apiKeyEncrypted' | 'apiKeyMask' | 'isEnabled'
  >
>;

export type DeleteResult = 'deleted' | 'not_found' | 'in_use';

export interface ProviderRepository {
  list(): Promise<ProviderRecord[]>;
  findById(id: string): Promise<ProviderRecord | null>;
  findByName(name: string): Promise<ProviderRecord | null>;
  create(input: CreateProviderRecordInput): Promise<ProviderRecord>;
  update(id: string, patch: UpdateProviderRecordPatch): Promise<ProviderRecord | null>;
  delete(id: string): Promise<DeleteResult>;
}

/** 模型记录（价格已由 numeric 字符串转为 number）。 */
export interface ModelRecord {
  readonly id: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly displayName: string;
  readonly contextWindow: number | null;
  readonly inputPricePer1m: number;
  readonly outputPricePer1m: number;
  readonly isEnabled: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreateModelRecordInput {
  readonly providerId: string;
  readonly modelId: string;
  readonly displayName: string;
  readonly contextWindow: number | null;
  readonly inputPricePer1m: number;
  readonly outputPricePer1m: number;
  readonly isEnabled: boolean;
}

export type UpdateModelRecordPatch = Partial<
  Pick<
    ModelRecord,
    'modelId' | 'displayName' | 'contextWindow' | 'inputPricePer1m' | 'outputPricePer1m' | 'isEnabled'
  >
>;

/** 模型 + 所属 Provider（模型测通时解析上游配置）。 */
export interface ModelWithProviderRecord {
  readonly model: ModelRecord;
  readonly provider: ProviderRecord;
}

export interface ModelRepository {
  list(providerId?: string): Promise<ModelRecord[]>;
  findById(id: string): Promise<ModelRecord | null>;
  findWithProvider(id: string): Promise<ModelWithProviderRecord | null>;
  existsByProviderAndModelId(
    providerId: string,
    modelId: string,
    excludeModelRowId?: string,
  ): Promise<boolean>;
  create(input: CreateModelRecordInput): Promise<ModelRecord>;
  update(id: string, patch: UpdateModelRecordPatch): Promise<ModelRecord | null>;
  delete(id: string): Promise<DeleteResult>;
}

/** 角色绑定 + 关联模型/供应商摘要（用于角色路由面板）。 */
export interface AgentRoleBindingRecord {
  readonly role: AgentRole;
  readonly modelId: string;
  readonly temperature: number;
  readonly maxTokens: number | null;
  readonly updatedAt: Date;
  readonly model: ModelRecord | null;
  readonly provider: ProviderRecord | null;
}

export interface UpsertAgentRoleBindingInput {
  readonly role: AgentRole;
  readonly modelId: string;
  readonly temperature: number;
  readonly maxTokens: number | null;
}

export interface AgentRoleRepository {
  /** 仅返回已存在的绑定（GET 路由会补齐 4 个固定角色的未绑定视图）。 */
  list(): Promise<AgentRoleBindingRecord[]>;
  isModelBound(modelId: string): Promise<boolean>;
  upsert(input: UpsertAgentRoleBindingInput): Promise<void>;
  remove(role: AgentRole): Promise<void>;
}

/** 用量日志查询条件（时间已由 ISO 字符串解析为 Date）。 */
export interface UsageLogQuery {
  readonly page: number;
  readonly pageSize: number;
  readonly status?: UsageLogStatus;
  readonly role?: AgentRole;
  readonly scene?: string;
  readonly from?: Date;
  readonly to?: Date;
}

export interface UsageLogRecord {
  readonly id: string;
  readonly role: AgentRole | null;
  readonly providerId: string | null;
  readonly modelRef: string | null;
  readonly scene: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly estimatedCostUsd: number;
  readonly latencyMs: number | null;
  readonly status: UsageLogStatus;
  readonly errorCode: ApiErrorCode | null;
  readonly errorMessage: string | null;
  readonly createdAt: Date;
}

export interface UsageLogPage {
  readonly items: UsageLogRecord[];
  readonly total: number;
  readonly summary: UsageSummary;
}

export interface UsageLogRepository {
  /** 追加一条不可篡改的审计记录，返回落盘后的主键与时间。 */
  insert(record: UsageLogRecordInput): Promise<{ id: string; createdAt: Date }>;
  query(query: UsageLogQuery): Promise<UsageLogPage>;
}

/** 便捷别名：Provider 创建入参（路由层复用共享契约类型）。 */
export type CreateProviderPayload = CreateProviderInput;

/** 便捷别名：角色绑定入参（共享契约的解析前类型）。 */
export type AgentRoleBindingPayload = AgentRoleBindingInputPayload;

/* -------------------------------------------------------------------------- */
/*                    书库 / 卷章 / 章节快照仓储（Change 2）                    */
/* -------------------------------------------------------------------------- */

/** 列表查询模式：`active` 仅未软删，`deleted` 仅回收站。 */
export type TrashScope = 'active' | 'deleted';

/** 书籍记录（含软删除标记，软删书籍仍是可恢复的完整记录）。 */
export interface BookRecord {
  readonly id: string;
  readonly title: string;
  readonly authorPenName: string;
  readonly genre: string;
  readonly status: BookStatus;
  readonly synopsis: string;
  readonly targetChapterWords: number;
  readonly deletedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** 书籍记录 + 卷章/字数聚合（聚合只统计未软删的卷与章）。 */
export interface BookAggregateRecord {
  readonly book: BookRecord;
  readonly volumeCount: number;
  readonly chapterCount: number;
  readonly totalWordCount: number;
}

export interface CreateBookRecordInput {
  readonly title: string;
  readonly authorPenName: string;
  readonly genre: string;
  readonly status: BookStatus;
  readonly synopsis: string;
  readonly targetChapterWords: number;
}

export type UpdateBookRecordPatch = Partial<CreateBookRecordInput>;

/** 书架列表筛选条件（关键字由仓储做大小写不敏感模糊匹配）。 */
export interface BookListFilter {
  readonly status?: BookStatus | undefined;
  readonly q?: string | undefined;
  /** `exclude` 仅活跃作品（默认）；`only` 仅回收站作品 */
  readonly includeDeleted: 'exclude' | 'only';
}

export interface BookRepository {
  list(filter: BookListFilter): Promise<BookAggregateRecord[]>;
  /** 按主键读取（包含回收站中的书籍）；不存在返回 null。 */
  findById(id: string): Promise<BookRecord | null>;
  /** 书籍 + 聚合统计；不存在返回 null。 */
  findAggregateById(id: string): Promise<BookAggregateRecord | null>;
  create(input: CreateBookRecordInput): Promise<BookRecord>;
  update(id: string, patch: UpdateBookRecordPatch): Promise<BookRecord | null>;
  /** 软删除（幂等）：返回标记后的记录，书籍不存在返回 null。 */
  softDelete(id: string): Promise<BookRecord | null>;
  /** 从回收站恢复：返回恢复后的记录，书籍不存在返回 null。 */
  restore(id: string): Promise<BookRecord | null>;
  /** 永久删除（级联卷 / 章 / 快照）；记录不存在返回 false。 */
  purge(id: string): Promise<boolean>;
}

/** 分卷记录。 */
export interface VolumeRecord {
  readonly id: string;
  readonly bookId: string;
  readonly title: string;
  readonly summary: string;
  readonly sortOrder: number;
  readonly deletedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** 分卷记录 + 卷内未删章节聚合。 */
export interface VolumeAggregateRecord {
  readonly volume: VolumeRecord;
  readonly chapterCount: number;
  readonly totalWordCount: number;
}

export interface CreateVolumeRecordInput {
  readonly bookId: string;
  readonly title: string;
  readonly summary: string;
  /** 省略时由仓储取 `max(sort_order) + 1` 追加到末尾 */
  readonly sortOrder?: number | undefined;
}

export type UpdateVolumeRecordPatch = Partial<Pick<VolumeRecord, 'title' | 'summary'>>;

export interface VolumeRepository {
  /** 按 `sortOrder` 升序返回本书分卷（含卷内章节聚合）。 */
  listByBook(bookId: string, scope: TrashScope): Promise<VolumeAggregateRecord[]>;
  findById(id: string): Promise<VolumeRecord | null>;
  create(input: CreateVolumeRecordInput): Promise<VolumeRecord>;
  update(id: string, patch: UpdateVolumeRecordPatch): Promise<VolumeRecord | null>;
  softDelete(id: string): Promise<VolumeRecord | null>;
  restore(id: string): Promise<VolumeRecord | null>;
  purge(id: string): Promise<boolean>;
  /** 单事务按数组下标重写 `sortOrder`。 */
  reorder(bookId: string, volumeIds: readonly string[]): Promise<void>;
}

/** 章节记录（含正文，仅编辑器 / 导出等必要场景读取）。 */
export interface ChapterRecord {
  readonly id: string;
  readonly bookId: string;
  readonly volumeId: string | null;
  readonly title: string;
  readonly sortOrder: number;
  readonly status: ChapterStatus;
  readonly contentText: string;
  readonly contentJson: unknown | null;
  readonly wordCount: number;
  readonly version: number;
  readonly deletedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** 章节元信息（**不含正文**，卷章树与列表接口专用）。 */
export type ChapterMetaRecord = Omit<ChapterRecord, 'contentText' | 'contentJson'>;

export interface CreateChapterRecordInput {
  readonly bookId: string;
  readonly volumeId: string | null;
  readonly title: string;
  readonly status: ChapterStatus;
  /** 省略时由仓储按目标卷取 `max(sort_order) + 1` */
  readonly sortOrder?: number | undefined;
}

export type UpdateChapterMetaRecordPatch = Partial<
  Pick<ChapterRecord, 'title' | 'status' | 'volumeId' | 'sortOrder'>
>;

/** 单章重排 / 跨卷移动指令。 */
export interface ChapterReorderCommand {
  readonly chapterId: string;
  readonly volumeId: string | null;
  readonly sortOrder: number;
}

/** 正文保存入参（字数已由服务端重算）。 */
export interface SaveChapterContentRecordInput {
  readonly chapterId: string;
  readonly expectedVersion: number;
  readonly forceOverwrite: boolean;
  readonly title?: string | undefined;
  readonly contentText: string;
  /** 省略表示保留原 JSON */
  readonly contentJson?: unknown | undefined;
  readonly wordCount: number;
}

/**
 * 正文保存结果：
 * - `saved`：保存成功（`backupRevision` 仅在强制覆盖时非空）
 * - `conflict`：乐观锁版本已过期，`chapter` 为服务端最新记录
 * - `not_found`：章节不存在或已软删
 */
export type ChapterSaveOutcome =
  | {
      readonly status: 'saved';
      readonly chapter: ChapterRecord;
      readonly backupRevision: ChapterRevisionRecord | null;
    }
  | { readonly status: 'conflict'; readonly chapter: ChapterRecord }
  | { readonly status: 'not_found' };

export interface ChapterRepository {
  /** 本书章节元信息（`scope` 决定活跃 / 回收站），按卷与 `sortOrder` 排序。 */
  listByBook(bookId: string, scope: TrashScope): Promise<ChapterMetaRecord[]>;
  /** 本书全部章节（含正文），导出整本时使用。 */
  listWithContentByBook(bookId: string): Promise<ChapterRecord[]>;
  findById(id: string): Promise<ChapterRecord | null>;
  create(input: CreateChapterRecordInput): Promise<ChapterRecord>;
  updateMeta(id: string, patch: UpdateChapterMetaRecordPatch): Promise<ChapterRecord | null>;
  softDelete(id: string): Promise<ChapterRecord | null>;
  restore(id: string): Promise<ChapterRecord | null>;
  purge(id: string): Promise<boolean>;
  /** 乐观锁保存正文；`forceOverwrite` 时先落 `restore` 备份快照再写入。 */
  saveContent(input: SaveChapterContentRecordInput): Promise<ChapterSaveOutcome>;
  /**
   * 单事务原子应用 AI 正文：乐观锁校验 → `source: 'ai'` 不可变快照留底 → 更新正文与版本号。
   * 冲突时绝不写入脏快照。
   */
  applyAiContent(input: ApplyAiChapterContentRecordInput): Promise<ApplyAiChapterContentOutcome>;
  /** 单事务批量重写 `volumeId` 与 `sortOrder`（同卷排序 + 跨卷移动）。 */
  reorder(bookId: string, items: readonly ChapterReorderCommand[]): Promise<void>;
}

/** 章节历史快照记录（append-only，不可变）。 */
export interface ChapterRevisionRecord {
  readonly id: string;
  readonly chapterId: string;
  readonly version: number;
  readonly source: RevisionSource;
  readonly note: string;
  readonly titleSnapshot: string;
  readonly contentText: string;
  readonly contentJson: unknown | null;
  readonly wordCount: number;
  readonly createdAt: Date;
}

export interface CreateChapterRevisionRecordInput {
  readonly chapterId: string;
  readonly version: number;
  readonly source: RevisionSource;
  readonly note: string;
  readonly titleSnapshot: string;
  readonly contentText: string;
  readonly contentJson: unknown | null;
  readonly wordCount: number;
}

/** 回滚入参：`backup` 为当前正文留底，`restore` 为目标快照内容。 */
export interface RestoreChapterRevisionRecordInput {
  readonly chapterId: string;
  readonly backup: CreateChapterRevisionRecordInput;
  readonly restore: {
    readonly title: string;
    readonly contentText: string;
    readonly contentJson: unknown | null;
    readonly wordCount: number;
  };
}

export interface RestoreChapterRevisionResult {
  readonly chapter: ChapterRecord;
  readonly backupRevision: ChapterRevisionRecord;
}

export interface ChapterRevisionRepository {
  /** 按 `createdAt DESC, version DESC` 返回全部快照。 */
  listByChapter(chapterId: string): Promise<ChapterRevisionRecord[]>;
  findById(revisionId: string): Promise<ChapterRevisionRecord | null>;
  /** 最近一条快照（任意来源），用于判断正文是否有实质变更。 */
  findLatestByChapter(chapterId: string): Promise<ChapterRevisionRecord | null>;
  /** 最近一条指定来源的快照，用于自动快照节流。 */
  findLatestBySource(
    chapterId: string,
    source: RevisionSource,
  ): Promise<ChapterRevisionRecord | null>;
  create(input: CreateChapterRevisionRecordInput): Promise<ChapterRevisionRecord>;
  /**
   * 单事务安全回滚：先写入 `backup` 快照留底，再覆盖章节正文并递增 `version`。
   * 章节已不存在 / 已软删时返回 null。
   */
  restore(input: RestoreChapterRevisionRecordInput): Promise<RestoreChapterRevisionResult | null>;
}

/* -------------------------------------------------------------------------- */
/*                    Change 3：Book Bible 仓储（总大纲 / 设定卡 / 章节记忆）                    */
/* -------------------------------------------------------------------------- */

/** 全书总大纲记录（1:1 绑定书籍，`updatedAt` 为最近保存时间）。 */
export interface BookOutlineRecord {
  readonly bookId: string;
  readonly mainPlot: string;
  readonly worldSetting: string;
  readonly styleGuide: string;
  readonly endingPlan: string;
  readonly updatedAt: Date;
}

export interface UpsertBookOutlineRecordInput {
  readonly bookId: string;
  readonly mainPlot: string;
  readonly worldSetting: string;
  readonly styleGuide: string;
  readonly endingPlan: string;
}

export interface BookOutlineRepository {
  /** 读取本书总大纲；尚未填写返回 null（路由返回空默认结构，不返回 404）。 */
  findByBookId(bookId: string): Promise<BookOutlineRecord | null>;
  /** 整段覆盖写入（不存在则插入），返回落盘后的记录。 */
  upsert(input: UpsertBookOutlineRecordInput): Promise<BookOutlineRecord>;
}

/** 结构化设定卡记录（`embedding` 仅服务端内部使用，DTO 不下发原始向量）。 */
export interface KnowledgeCardRecord {
  readonly id: string;
  readonly bookId: string;
  readonly category: KnowledgeCardCategory;
  readonly title: string;
  readonly summary: string;
  readonly content: string;
  readonly aliases: string[];
  readonly tags: string[];
  readonly pinned: boolean;
  readonly sortOrder: number;
  readonly embedding: number[] | null;
  readonly embeddingModelRef: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** 设定卡列表筛选（`q` 在标题 / 别名 / 摘要 / 正文上做大小写不敏感模糊匹配）。 */
export interface KnowledgeCardListFilter {
  readonly category?: KnowledgeCardCategory | undefined;
  readonly q?: string | undefined;
  readonly pinned?: boolean | undefined;
}

export interface CreateKnowledgeCardRecordInput {
  readonly bookId: string;
  readonly category: KnowledgeCardCategory;
  readonly title: string;
  readonly summary: string;
  readonly content: string;
  readonly aliases: string[];
  readonly tags: string[];
  readonly pinned: boolean;
  /** 省略时由仓储取该书 `max(sort_order) + 1` 追加到末尾 */
  readonly sortOrder?: number | undefined;
  readonly embedding?: number[] | null | undefined;
  readonly embeddingModelRef?: string | null | undefined;
}

export type UpdateKnowledgeCardRecordPatch = Partial<
  Pick<
    KnowledgeCardRecord,
    | 'category'
    | 'title'
    | 'summary'
    | 'content'
    | 'aliases'
    | 'tags'
    | 'pinned'
    | 'sortOrder'
    | 'embedding'
    | 'embeddingModelRef'
  >
>;

export interface KnowledgeCardRepository {
  /** 本书设定卡列表（`pinned` 优先，其次 `sortOrder` 升序）。 */
  listByBook(bookId: string, filter?: KnowledgeCardListFilter): Promise<KnowledgeCardRecord[]>;
  findById(id: string): Promise<KnowledgeCardRecord | null>;
  create(input: CreateKnowledgeCardRecordInput): Promise<KnowledgeCardRecord>;
  update(id: string, patch: UpdateKnowledgeCardRecordPatch): Promise<KnowledgeCardRecord | null>;
  /** 删除成功返回 true，记录不存在返回 false。 */
  delete(id: string): Promise<boolean>;
}

/** 章节细纲与剧情摘要记录（`updatedAt` 为最近保存时间）。 */
export interface ChapterSummaryRecord {
  readonly chapterId: string;
  readonly bookId: string;
  readonly outline: string;
  readonly summary: string;
  readonly keyEvents: string[];
  readonly charactersPresent: string[];
  readonly source: ChapterSummarySource;
  readonly updatedAt: Date;
}

export interface UpsertChapterSummaryRecordInput {
  readonly chapterId: string;
  readonly bookId: string;
  readonly outline: string;
  readonly summary: string;
  readonly keyEvents: string[];
  readonly charactersPresent: string[];
  readonly source: ChapterSummarySource;
}

export interface ChapterSummaryRepository {
  findByChapterId(chapterId: string): Promise<ChapterSummaryRecord | null>;
  /** 本书全部章节记忆（按 `updatedAt` 升序），供上下文组装按阅读顺序筛选。 */
  listByBook(bookId: string): Promise<ChapterSummaryRecord[]>;
  /** 整条覆盖写入（不存在则插入），返回落盘后的记录。 */
  upsert(input: UpsertChapterSummaryRecordInput): Promise<ChapterSummaryRecord>;
}

/** 原子应用 AI 正文入参（字数已由服务端重算，`note` 用于快照备注）。 */
export interface ApplyAiChapterContentRecordInput {
  readonly chapterId: string;
  readonly expectedVersion: number;
  readonly contentText: string;
  /** 省略表示保留原 JSON */
  readonly contentJson?: unknown | undefined;
  readonly wordCount: number;
  readonly note: string;
}

/**
 * 原子应用 AI 正文结果：
 * - `applied`：写入成功，`backupRevision` 为应用前原稿的 `source: 'ai'` 快照
 * - `conflict`：乐观锁版本已过期（`chapter` 为服务端最新记录，未写入任何快照）
 * - `not_found`：章节不存在或已软删
 */
export type ApplyAiChapterContentOutcome =
  | {
      readonly status: 'applied';
      readonly chapter: ChapterRecord;
      readonly backupRevision: ChapterRevisionRecord;
    }
  | { readonly status: 'conflict'; readonly chapter: ChapterRecord }
  | { readonly status: 'not_found' };
