import { isProviderProtocol } from '@fanxiaoshuo/shared';
import { asc, eq } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { llmProviders, type LlmProviderRow } from '../../db/schema.js';
import { isForeignKeyViolation } from '../../errors.js';
import type {
  CreateProviderRecordInput,
  DeleteResult,
  ProviderRecord,
  ProviderRepository,
  UpdateProviderRecordPatch,
} from '../types.js';

/** PG 行 → 领域记录（protocol 兜底为 openai-compatible，避免脏数据击穿接口）。 */
export function mapProviderRow(row: LlmProviderRow): ProviderRecord {
  return {
    id: row.id,
    name: row.name,
    protocol: isProviderProtocol(row.protocol) ? row.protocol : 'openai-compatible',
    baseUrl: row.baseUrl,
    apiKeyEncrypted: row.apiKeyEncrypted,
    apiKeyMask: row.apiKeyMask,
    isEnabled: row.isEnabled,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Drizzle 实现的 Provider 仓储。 */
export function createDrizzleProviderRepository(db: Database): ProviderRepository {
  return {
    async list() {
      const rows = await db.select().from(llmProviders).orderBy(asc(llmProviders.createdAt));
      return rows.map(mapProviderRow);
    },

    async findById(id) {
      const [row] = await db.select().from(llmProviders).where(eq(llmProviders.id, id)).limit(1);
      return row ? mapProviderRow(row) : null;
    },

    async findByName(name) {
      const [row] = await db.select().from(llmProviders).where(eq(llmProviders.name, name)).limit(1);
      return row ? mapProviderRow(row) : null;
    },

    async create(input: CreateProviderRecordInput) {
      const [row] = await db
        .insert(llmProviders)
        .values({
          name: input.name,
          protocol: input.protocol,
          baseUrl: input.baseUrl,
          apiKeyEncrypted: input.apiKeyEncrypted,
          apiKeyMask: input.apiKeyMask,
          isEnabled: input.isEnabled,
        })
        .returning();
      if (!row) {
        throw new Error('Provider 创建失败：数据库未返回记录。');
      }
      return mapProviderRow(row);
    },

    async update(id, patch: UpdateProviderRecordPatch) {
      const [row] = await db
        .update(llmProviders)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(llmProviders.id, id))
        .returning();
      return row ? mapProviderRow(row) : null;
    },

    async delete(id): Promise<DeleteResult> {
      try {
        const rows = await db
          .delete(llmProviders)
          .where(eq(llmProviders.id, id))
          .returning({ id: llmProviders.id });
        return rows.length > 0 ? 'deleted' : 'not_found';
      } catch (error) {
        if (isForeignKeyViolation(error)) {
          return 'in_use';
        }
        throw error;
      }
    },
  };
}
