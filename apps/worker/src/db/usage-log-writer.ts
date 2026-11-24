import type { QueryResultRow } from 'pg';
import type { UsageLogger } from '@fanxiaoshuo/agents';

/**
 * 最小化 SQL 执行器接口。
 *
 * 只依赖 `query(text, values)`，既可由 `pg.Pool` 直接满足，
 * 也可在单元测试中注入纯内存 Fake，避免测试强依赖真实 PostgreSQL。
 */
export interface QueryExecutor {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: T[] }>;
}

/** `llm_usage_logs` 插入语句（列顺序与 `createPgUsageLogger` 参数一一对应）。 */
export const INSERT_USAGE_LOG_SQL = `
INSERT INTO llm_usage_logs (
  role,
  provider_id,
  model_ref,
  scene,
  input_tokens,
  output_tokens,
  estimated_cost_usd,
  latency_ms,
  status,
  error_code,
  error_message
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
`.trim();

/**
 * 构造 `UsageLogger`：把 `packages/agents` 网关产出的结构化用量记录写入 `llm_usage_logs`。
 *
 * 场景固定由网关传入（冒烟任务为 `scene: 'smoke-job'`），本函数不做二次改写，
 * 保证「网关计量口径 == 落盘账本口径」。
 */
export function createPgUsageLogger(executor: QueryExecutor): UsageLogger {
  return async (record) => {
    await executor.query(INSERT_USAGE_LOG_SQL, [
      record.role,
      record.providerId,
      record.modelRef,
      record.scene,
      record.inputTokens,
      record.outputTokens,
      record.estimatedCostUsd,
      record.latencyMs,
      record.status,
      record.errorCode,
      record.errorMessage,
    ]);
  };
}
