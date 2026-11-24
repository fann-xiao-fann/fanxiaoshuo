import type { UsageSummary } from '@fanxiaoshuo/shared';
import { and, desc, eq, gte, lte, sql, type SQL } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { llmUsageLogs, type LlmUsageLogRow } from '../../db/schema.js';
import {
  parseAgentRole,
  parseApiErrorCode,
  parseUsageLogStatus,
} from '../../mapping/dto.js';
import type {
  UsageLogPage,
  UsageLogQuery,
  UsageLogRecord,
  UsageLogRepository,
} from '../types.js';

function toNumber(value: string | number | null | undefined): number {
  const parsed = typeof value === 'number' ? value : Number(value ?? 0);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

export function mapUsageLogRow(row: LlmUsageLogRow): UsageLogRecord {
  return {
    id: row.id,
    role: parseAgentRole(row.role),
    providerId: row.providerId,
    modelRef: row.modelRef,
    scene: row.scene,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    estimatedCostUsd: toNumber(row.estimatedCostUsd),
    latencyMs: row.latencyMs,
    status: parseUsageLogStatus(row.status),
    errorCode: parseApiErrorCode(row.errorCode),
    errorMessage: row.errorMessage,
    createdAt: row.createdAt,
  };
}

/** Drizzle 实现的用量日志（append-only）仓储。 */
export function createDrizzleUsageLogRepository(db: Database): UsageLogRepository {
  return {
    async insert(record) {
      const [row] = await db
        .insert(llmUsageLogs)
        .values({
          role: record.role,
          providerId: record.providerId,
          modelRef: record.modelRef,
          scene: record.scene,
          inputTokens: record.inputTokens,
          outputTokens: record.outputTokens,
          estimatedCostUsd: String(record.estimatedCostUsd),
          latencyMs: record.latencyMs,
          status: record.status,
          errorCode: record.errorCode,
          errorMessage: record.errorMessage,
        })
        .returning({ id: llmUsageLogs.id, createdAt: llmUsageLogs.createdAt });
      if (!row) {
        throw new Error('用量日志写入失败：数据库未返回记录。');
      }
      return { id: row.id, createdAt: row.createdAt };
    },

    async query(query: UsageLogQuery): Promise<UsageLogPage> {
      const conditions: SQL[] = [];
      if (query.status) {
        conditions.push(eq(llmUsageLogs.status, query.status));
      }
      if (query.role) {
        conditions.push(eq(llmUsageLogs.role, query.role));
      }
      if (query.scene) {
        conditions.push(eq(llmUsageLogs.scene, query.scene));
      }
      if (query.from) {
        conditions.push(gte(llmUsageLogs.createdAt, query.from));
      }
      if (query.to) {
        conditions.push(lte(llmUsageLogs.createdAt, query.to));
      }
      const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

      const [countRow] = await db
        .select({ value: sql<number>`count(*)::int` })
        .from(llmUsageLogs)
        .where(whereClause);
      const total = countRow?.value ?? 0;

      const [summaryRow] = await db
        .select({
          totalRequests: sql<number>`count(*)::int`,
          successRequests: sql<number>`(count(*) filter (where ${llmUsageLogs.status} = 'success'))::int`,
          errorRequests: sql<number>`(count(*) filter (where ${llmUsageLogs.status} = 'error'))::int`,
          totalInputTokens: sql<number>`coalesce(sum(${llmUsageLogs.inputTokens}), 0)::int`,
          totalOutputTokens: sql<number>`coalesce(sum(${llmUsageLogs.outputTokens}), 0)::int`,
          totalCostUsd: sql<number>`coalesce(sum(${llmUsageLogs.estimatedCostUsd}), 0)::float8`,
        })
        .from(llmUsageLogs)
        .where(whereClause);

      const summary: UsageSummary = {
        totalRequests: summaryRow?.totalRequests ?? 0,
        successRequests: summaryRow?.successRequests ?? 0,
        errorRequests: summaryRow?.errorRequests ?? 0,
        totalInputTokens: summaryRow?.totalInputTokens ?? 0,
        totalOutputTokens: summaryRow?.totalOutputTokens ?? 0,
        totalCostUsd: toNumber(summaryRow?.totalCostUsd),
      };

      const rows = await db
        .select()
        .from(llmUsageLogs)
        .where(whereClause)
        .orderBy(desc(llmUsageLogs.createdAt), desc(llmUsageLogs.id))
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize);

      return { items: rows.map(mapUsageLogRow), total, summary };
    },
  };
}
