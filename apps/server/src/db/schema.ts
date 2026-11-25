import {
  boolean,
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
