import {
  boolean,
  index,
  integer,
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
