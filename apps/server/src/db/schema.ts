import {
  boolean,
  customType,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

/**
 * 梵小说 4 张核心表（Change 1）。
 *
 * 设计约束（见 `openspec/changes/init-fanxiaoshuo-workspace/design.md`）：
 * - `llm_providers.name` 唯一；API Key 仅存密文 + 掩码。
 * - `llm_models(provider_id, model_id)` 联合唯一，Provider 删除级联清理模型。
 * - `agent_role_bindings` 角色主键固定 4 个；删除仍被绑定的模型由 `ON DELETE RESTRICT` 兜底。
 * - `llm_usage_logs` 为 append-only 审计账本，保留 `provider_id` / `model_ref` 快照。
 */

export const llmProviders = pgTable('llm_providers', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull().unique(),
  protocol: text('protocol').notNull(),
  baseUrl: text('base_url').notNull(),
  apiKeyEncrypted: text('api_key_encrypted').notNull(),
  apiKeyMask: text('api_key_mask').notNull(),
  isEnabled: boolean('is_enabled').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

export const llmModels = pgTable(
  'llm_models',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    providerId: uuid('provider_id')
      .notNull()
      .references(() => llmProviders.id, { onDelete: 'cascade' }),
    modelId: text('model_id').notNull(),
    displayName: text('display_name').notNull(),
    contextWindow: integer('context_window'),
    // numeric 以字符串读写，避免 JS 浮点误差影响价格精度（numeric(12,6)）
    inputPricePer1m: numeric('input_price_per_1m', { precision: 12, scale: 6 })
      .notNull()
      .default('0'),
    outputPricePer1m: numeric('output_price_per_1m', { precision: 12, scale: 6 })
      .notNull()
      .default('0'),
    isEnabled: boolean('is_enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('llm_models_provider_model_id_unique').on(table.providerId, table.modelId),
    index('llm_models_provider_id_idx').on(table.providerId),
  ],
);

export const agentRoleBindings = pgTable('agent_role_bindings', {
  role: text('role').primaryKey(),
  modelId: uuid('model_id')
    .notNull()
    .references(() => llmModels.id, { onDelete: 'restrict' }),
  temperature: real('temperature').notNull().default(0.7),
  maxTokens: integer('max_tokens'),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

export const llmUsageLogs = pgTable(
  'llm_usage_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    role: text('role'),
    providerId: uuid('provider_id'),
    modelRef: text('model_ref'),
    scene: text('scene').notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    estimatedCostUsd: numeric('estimated_cost_usd', { precision: 12, scale: 6 })
      .notNull()
      .default('0'),
    latencyMs: integer('latency_ms'),
    status: text('status').notNull(),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [index('llm_usage_logs_created_at_idx').on(table.createdAt)],
);

export type LlmProviderRow = typeof llmProviders.$inferSelect;
export type LlmModelRow = typeof llmModels.$inferSelect;
export type AgentRoleBindingRow = typeof agentRoleBindings.$inferSelect;
export type LlmUsageLogRow = typeof llmUsageLogs.$inferSelect;

/* -------------------------------------------------------------------------- */
/*                     Change 2：书库 / 卷章 / 章节历史快照                     */
/* -------------------------------------------------------------------------- */

/**
 * 书库 4 张表（见 `openspec/changes/books-and-chapter-editor/design.md`）：
 *
 * - `books`：作品主表，软删除（`deleted_at`）进入回收站。
 * - `volumes`：分卷，`(book_id, sort_order)` 索引支撑有序目录树；书籍删除级联清理。
 * - `chapters`：章节，`volume_id` 可为 null（未分卷区），分卷被彻底删除时
 *   `ON DELETE SET NULL` 保证正文不丢失；`version` 为正文乐观锁序号。
 * - `chapter_revisions`：append-only 历史快照，章节删除级联清理。
 *
 * 默认值使用字面量（而非从 `@fanxiaoshuo/shared` 引入常量），避免 drizzle-kit
 * 在生成迁移时需要解析工作区包的运行时产物。
 */

export const books = pgTable(
  'books',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    title: text('title').notNull(),
    authorPenName: text('author_pen_name').notNull().default(''),
    genre: text('genre').notNull().default(''),
    // draft | ongoing | completed | archived
    status: text('status').notNull().default('draft'),
    synopsis: text('synopsis').notNull().default(''),
    targetChapterWords: integer('target_chapter_words').notNull().default(3000),
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    index('books_deleted_at_idx').on(table.deletedAt),
    index('books_updated_at_idx').on(table.updatedAt),
  ],
);

export const volumes = pgTable(
  'volumes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    bookId: uuid('book_id')
      .notNull()
      .references(() => books.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    summary: text('summary').notNull().default(''),
    sortOrder: integer('sort_order').notNull().default(0),
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [index('volumes_book_sort_idx').on(table.bookId, table.sortOrder)],
);

export const chapters = pgTable(
  'chapters',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    bookId: uuid('book_id')
      .notNull()
      .references(() => books.id, { onDelete: 'cascade' }),
    volumeId: uuid('volume_id').references(() => volumes.id, { onDelete: 'set null' }),
    title: text('title').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    // outline | draft | reviewing | final
    status: text('status').notNull().default('draft'),
    contentText: text('content_text').notNull().default(''),
    contentJson: jsonb('content_json'),
    wordCount: integer('word_count').notNull().default(0),
    // 正文乐观锁版本号，每次保存正文 +1
    version: integer('version').notNull().default(1),
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    index('chapters_book_volume_sort_idx').on(table.bookId, table.volumeId, table.sortOrder),
    index('chapters_book_deleted_idx').on(table.bookId, table.deletedAt),
  ],
);

export const chapterRevisions = pgTable(
  'chapter_revisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    chapterId: uuid('chapter_id')
      .notNull()
      .references(() => chapters.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    // manual | auto | restore | ai
    source: text('source').notNull(),
    note: text('note').notNull().default(''),
    titleSnapshot: text('title_snapshot').notNull(),
    contentText: text('content_text').notNull(),
    contentJson: jsonb('content_json'),
    wordCount: integer('word_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [index('chapter_revisions_chapter_created_idx').on(table.chapterId, table.createdAt)],
);

export type BookRow = typeof books.$inferSelect;
export type VolumeRow = typeof volumes.$inferSelect;
export type ChapterRow = typeof chapters.$inferSelect;
export type ChapterRevisionRow = typeof chapterRevisions.$inferSelect;

/* -------------------------------------------------------------------------- */
/*              Change 3：Book Bible（总大纲 / 设定卡 / 章节摘要）              */
/* -------------------------------------------------------------------------- */

/**
 * pgvector 不定维 `vector` 列。
 *
 * 不写死维度（如 `vector(1536)`），避免后续更换 768 / 1024 / 3072 维 Embedding
 * 模型时被迫重建表；驱动层以 `"[0.1,0.2,...]"` 文本往返。
 */
export const pgVector = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return 'vector';
  },
  toDriver(value: number[]): string {
    return `[${value.map((item) => (Number.isFinite(item) ? item : 0)).join(',')}]`;
  },
  fromDriver(value: unknown): number[] {
    if (typeof value !== 'string') {
      return [];
    }
    const trimmed = value.trim();
    if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) {
      return [];
    }
    const body = trimmed.slice(1, -1).trim();
    if (body.length === 0) {
      return [];
    }
    return body
      .split(',')
      .map((part) => Number(part.trim()))
      .filter((item) => Number.isFinite(item));
  },
});

/**
 * 全书总大纲（1:1 绑定 `books`）。
 *
 * 与 `books` 主表解耦，避免书架列表拉取大段大纲文本；
 * 无记录时接口返回空字段 + `updatedAt: null`，不返回 404。
 */
export const bookOutlines = pgTable('book_outlines', {
  bookId: uuid('book_id')
    .primaryKey()
    .references(() => books.id, { onDelete: 'cascade' }),
  mainPlot: text('main_plot').notNull().default(''),
  worldSetting: text('world_setting').notNull().default(''),
  styleGuide: text('style_guide').notNull().default(''),
  endingPlan: text('ending_plan').notNull().default(''),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

/**
 * 结构化设定卡（N:1 绑定 `books`）。
 *
 * `category` 取 6 类字面量；`embedding` 为可空不定维向量列，
 * 未配置 Embedding 模型时保持 null，DTO 仅暴露 `hasEmbedding`。
 */
export const knowledgeCards = pgTable(
  'knowledge_cards',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    bookId: uuid('book_id')
      .notNull()
      .references(() => books.id, { onDelete: 'cascade' }),
    // character | world | faction | item | foreshadowing | timeline
    category: text('category').notNull(),
    title: text('title').notNull(),
    summary: text('summary').notNull().default(''),
    content: text('content').notNull().default(''),
    aliases: jsonb('aliases').$type<string[]>().notNull().default([]),
    tags: jsonb('tags').$type<string[]>().notNull().default([]),
    pinned: boolean('pinned').notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
    embedding: pgVector('embedding'),
    embeddingModelRef: text('embedding_model_ref'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    index('knowledge_cards_book_category_sort_idx').on(
      table.bookId,
      table.category,
      table.sortOrder,
    ),
    index('knowledge_cards_book_pinned_idx').on(table.bookId, table.pinned),
  ],
);

/**
 * 章节细纲与剧情摘要（1:1 绑定 `chapters`）。
 *
 * 冗余 `book_id` + 索引，便于按书籍一次查出全部摘要，
 * 再按「卷 → 章」阅读顺序切片前序 N 章摘要。
 */
export const chapterSummaries = pgTable(
  'chapter_summaries',
  {
    chapterId: uuid('chapter_id')
      .primaryKey()
      .references(() => chapters.id, { onDelete: 'cascade' }),
    bookId: uuid('book_id')
      .notNull()
      .references(() => books.id, { onDelete: 'cascade' }),
    outline: text('outline').notNull().default(''),
    summary: text('summary').notNull().default(''),
    keyEvents: jsonb('key_events').$type<string[]>().notNull().default([]),
    charactersPresent: jsonb('characters_present').$type<string[]>().notNull().default([]),
    // manual | ai
    source: text('source').notNull().default('manual'),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [index('chapter_summaries_book_idx').on(table.bookId)],
);

export type BookOutlineRow = typeof bookOutlines.$inferSelect;
export type KnowledgeCardRow = typeof knowledgeCards.$inferSelect;
export type ChapterSummaryRow = typeof chapterSummaries.$inferSelect;

/* -------------------------------------------------------------------------- */
/*               Change 4：批量流水线批次 / 章节步骤（workflow_runs / steps）              */
/* -------------------------------------------------------------------------- */

/**
 * 批量流水线 2 张表（见 `openspec/changes/batch-workflows-engine/design.md`）。
 *
 * 跨进程契约：`apps/worker` 使用 `pg` SQL 直接读写**完全相同**的表名与列名，
 * 任何重命名都会在集成阶段立刻暴露，禁止单侧修改。
 *
 * - `workflow_runs`：批次主表，`config_json` 仅存 `WorkflowRunConfig`（严格 strict schema），
 *   状态真相（暂停 / 取消 / 预算）全部落盘，Worker 重启后可完整断点续跑。
 * - `workflow_steps`：章节步骤表，`(run_id, step_index)` 唯一，按阅读顺序串行推进。
 *
 * 默认值使用字面量（而非从 `@fanxiaoshuo/shared` 引入常量），避免 drizzle-kit
 * 在生成迁移时需要解析工作区包的运行时产物。
 */

export const workflowRuns = pgTable(
  'workflow_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    bookId: uuid('book_id')
      .notNull()
      .references(() => books.id, { onDelete: 'cascade' }),
    // outline_only | write_chapters | full_pipeline
    mode: text('mode').notNull(),
    // queued | running | paused | completed | failed | cancelled
    status: text('status').notNull().default('queued'),
    // 创建时冻结的配置快照（仅 WorkflowRunConfig 字段）
    configJson: jsonb('config_json').notNull(),
    totalSteps: integer('total_steps').notNull().default(0),
    completedSteps: integer('completed_steps').notNull().default(0),
    failedSteps: integer('failed_steps').notNull().default(0),
    // 预算上限（可空表示不限制），numeric 以字符串读写保证精度
    maxCostUsd: numeric('max_cost_usd', { precision: 12, scale: 6 }),
    spentCostUsd: numeric('spent_cost_usd', { precision: 12, scale: 6 })
      .notNull()
      .default('0'),
    totalInputTokens: integer('total_input_tokens').notNull().default(0),
    totalOutputTokens: integer('total_output_tokens').notNull().default(0),
    pauseRequested: boolean('pause_requested').notNull().default(false),
    cancelRequested: boolean('cancel_requested').notNull().default(false),
    // USER_PAUSED | BUDGET_EXCEEDED | null
    pauseReason: text('pause_reason'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }),
    finishedAt: timestamp('finished_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    index('workflow_runs_book_created_idx').on(table.bookId, table.createdAt),
    index('workflow_runs_status_idx').on(table.status),
  ],
);

export const workflowSteps = pgTable(
  'workflow_steps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => workflowRuns.id, { onDelete: 'cascade' }),
    chapterId: uuid('chapter_id')
      .notNull()
      .references(() => chapters.id, { onDelete: 'cascade' }),
    // 0-based 顺序序号（批次内按阅读顺序串行执行）
    stepIndex: integer('step_index').notNull(),
    chapterTitleSnapshot: text('chapter_title_snapshot').notNull(),
    // pending | running | completed | failed | skipped
    status: text('status').notNull().default('pending'),
    // idle | planning | writing | reviewing | reworking | summarizing | done
    stage: text('stage').notNull().default('idle'),
    reworkCount: integer('rework_count').notNull().default(0),
    criticScore: integer('critic_score'),
    criticPassed: boolean('critic_passed'),
    criticSummary: text('critic_summary'),
    criticIssuesJson: jsonb('critic_issues_json').$type<string[]>().notNull().default([]),
    outputWordCount: integer('output_word_count').notNull().default(0),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    estimatedCostUsd: numeric('estimated_cost_usd', { precision: 12, scale: 6 })
      .notNull()
      .default('0'),
    // 写回正文前生成的 source: 'ai' 留底快照 ID
    backupRevisionId: uuid('backup_revision_id'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }),
    finishedAt: timestamp('finished_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('workflow_steps_run_index_unique').on(table.runId, table.stepIndex),
    index('workflow_steps_run_status_idx').on(table.runId, table.status),
  ],
);

export type WorkflowRunRow = typeof workflowRuns.$inferSelect;
export type WorkflowStepRow = typeof workflowSteps.$inferSelect;

/* -------------------------------------------------------------------------- */
/*                     Change 5：创作工具盒运行历史（toolbox_runs）                     */
/* -------------------------------------------------------------------------- */

/**
 * 创作工具盒运行历史（见 `openspec/changes/toolbox-and-polish/design.md` 第 3 节）。
 *
 * 关键约束：
 * - 工具盒为**同步单次调用**，不存在排队 / 运行中态，`status` 只有 `completed` / `failed`；
 * - `book_id` 可空并 `ON DELETE SET NULL`：删书后历史仍可回看，只是不再关联作品；
 * - `inputs_json` 落盘 `validateToolboxInputs` 归一后的输入（含默认值补全），
 *   `output_json` 落盘 `{ overview, items[] }`，失败时为 null；
 * - `error_message` 必须已脱敏（由网关 `sanitizeErrorMessage` 归一），禁止明文 API Key；
 * - `estimated_cost_usd` 与 `llm_usage_logs` 同口径 `numeric(12,6)`。
 */
export const toolboxRuns = pgTable(
  'toolbox_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // 6 个内置工具 ID 之一（book-pitch / character-designer / ...）
    toolId: varchar('tool_id', { length: 64 }).notNull(),
    bookId: uuid('book_id').references(() => books.id, { onDelete: 'set null' }),
    role: varchar('role', { length: 32 }).notNull(),
    // completed | failed
    status: varchar('status', { length: 16 }).notNull(),
    inputsJson: jsonb('inputs_json').$type<Record<string, string | number>>().notNull(),
    outputJson: jsonb('output_json').$type<unknown>(),
    modelRef: varchar('model_ref', { length: 256 }),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    estimatedCostUsd: numeric('estimated_cost_usd', { precision: 12, scale: 6 })
      .notNull()
      .default('0'),
    latencyMs: integer('latency_ms').notNull().default(0),
    errorCode: varchar('error_code', { length: 64 }),
    errorMessage: text('error_message'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    index('toolbox_runs_created_idx').on(table.createdAt),
    index('toolbox_runs_book_created_idx').on(table.bookId, table.createdAt),
    index('toolbox_runs_tool_created_idx').on(table.toolId, table.createdAt),
  ],
);

export type ToolboxRunRow = typeof toolboxRuns.$inferSelect;
