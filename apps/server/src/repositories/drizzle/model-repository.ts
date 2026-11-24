import { and, asc, eq, ne } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { llmModels, llmProviders, type LlmModelRow } from '../../db/schema.js';
import { isForeignKeyViolation } from '../../errors.js';
import type {
  CreateModelRecordInput,
  DeleteResult,
  ModelRecord,
  ModelRepository,
  ModelWithProviderRecord,
  UpdateModelRecordPatch,
} from '../types.js';
import { mapProviderRow } from './provider-repository.js';

/** numeric(12,6) 在 Drizzle 中按字符串返回，这里统一转为 number。 */
function toPrice(value: string | number | null | undefined): number {
  const parsed = typeof value === 'number' ? value : Number(value ?? 0);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

export function mapModelRow(row: LlmModelRow): ModelRecord {
  return {
    id: row.id,
    providerId: row.providerId,
    modelId: row.modelId,
    displayName: row.displayName,
    contextWindow: row.contextWindow,
    inputPricePer1m: toPrice(row.inputPricePer1m),
    outputPricePer1m: toPrice(row.outputPricePer1m),
    isEnabled: row.isEnabled,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Drizzle 实现的 Model 仓储。 */
export function createDrizzleModelRepository(db: Database): ModelRepository {
  return {
    async list(providerId) {
      const query = db.select().from(llmModels);
      const rows = providerId
        ? await query.where(eq(llmModels.providerId, providerId)).orderBy(asc(llmModels.createdAt))
        : await query.orderBy(asc(llmModels.createdAt));
      return rows.map(mapModelRow);
    },

    async findById(id) {
      const [row] = await db.select().from(llmModels).where(eq(llmModels.id, id)).limit(1);
      return row ? mapModelRow(row) : null;
    },

    async findWithProvider(id): Promise<ModelWithProviderRecord | null> {
      const [row] = await db
        .select({ model: llmModels, provider: llmProviders })
        .from(llmModels)
        .innerJoin(llmProviders, eq(llmModels.providerId, llmProviders.id))
        .where(eq(llmModels.id, id))
        .limit(1);
      if (!row) {
        return null;
      }
      return {
        model: mapModelRow(row.model),
        provider: mapProviderRow(row.provider),
      };
    },

    async existsByProviderAndModelId(providerId, modelId, excludeModelRowId) {
      const conditions = [eq(llmModels.providerId, providerId), eq(llmModels.modelId, modelId)];
      if (excludeModelRowId) {
        conditions.push(ne(llmModels.id, excludeModelRowId));
      }
      const [row] = await db
        .select({ id: llmModels.id })
        .from(llmModels)
        .where(and(...conditions))
        .limit(1);
      return row !== undefined;
    },

    async create(input: CreateModelRecordInput) {
      const [row] = await db
        .insert(llmModels)
        .values({
          providerId: input.providerId,
          modelId: input.modelId,
          displayName: input.displayName,
          contextWindow: input.contextWindow,
          inputPricePer1m: String(input.inputPricePer1m),
          outputPricePer1m: String(input.outputPricePer1m),
          isEnabled: input.isEnabled,
        })
        .returning();
      if (!row) {
        throw new Error('Model 创建失败：数据库未返回记录。');
      }
      return mapModelRow(row);
    },

    async update(id, patch: UpdateModelRecordPatch) {
      const values: Record<string, unknown> = { updatedAt: new Date() };
      if (patch.modelId !== undefined) values.modelId = patch.modelId;
      if (patch.displayName !== undefined) values.displayName = patch.displayName;
      if (patch.contextWindow !== undefined) values.contextWindow = patch.contextWindow;
      if (patch.inputPricePer1m !== undefined) {
        values.inputPricePer1m = String(patch.inputPricePer1m);
      }
      if (patch.outputPricePer1m !== undefined) {
        values.outputPricePer1m = String(patch.outputPricePer1m);
      }
      if (patch.isEnabled !== undefined) values.isEnabled = patch.isEnabled;

      const [row] = await db
        .update(llmModels)
        .set(values)
        .where(eq(llmModels.id, id))
        .returning();
      return row ? mapModelRow(row) : null;
    },

    async delete(id): Promise<DeleteResult> {
      try {
        const rows = await db
          .delete(llmModels)
          .where(eq(llmModels.id, id))
          .returning({ id: llmModels.id });
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
