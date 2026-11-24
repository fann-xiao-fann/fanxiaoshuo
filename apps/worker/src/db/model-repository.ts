import { API_ERROR_CODES, uuidSchema, type AgentRole } from '@fanxiaoshuo/shared';
import type { ResolvedModelConfig } from '@fanxiaoshuo/agents';
import { resolvedModelConfigSchema } from '@fanxiaoshuo/agents';
import type { QueryResultRow } from 'pg';
import { ApiKeyDecryptionError, EncryptionKeyError, decryptApiKey } from '../security/encryption.js';
import { WorkerJobError } from '../errors.js';
import type { QueryExecutor } from './usage-log-writer.js';

/** 任务可指定的模型选择器：优先 `modelId`，其次角色绑定。 */
export interface ModelSelector {
  /** `llm_models.id`（uuid）或上游 `model_id`（如 `gpt-4o-mini`） */
  readonly modelId?: string;
  /** 写书角色绑定（`agent_role_bindings.role`） */
  readonly role?: AgentRole;
}

/** 模型 + Provider 联合查询结果行（价格列由 pg NUMERIC 返回字符串）。 */
interface SmokeModelRow extends QueryResultRow {
  readonly provider_id: string;
  readonly provider_name: string;
  readonly protocol: string;
  readonly base_url: string;
  readonly api_key_encrypted: string;
  readonly provider_enabled: boolean;
  readonly model_row_id: string;
  readonly model_id: string;
  readonly display_name: string;
  readonly input_price_per_1m: string | number | null;
  readonly output_price_per_1m: string | number | null;
  readonly model_enabled: boolean;
}

const MODEL_SELECT = `
SELECT
  p.id            AS provider_id,
  p.name          AS provider_name,
  p.protocol      AS protocol,
  p.base_url      AS base_url,
  p.api_key_encrypted AS api_key_encrypted,
  p.is_enabled    AS provider_enabled,
  m.id            AS model_row_id,
  m.model_id      AS model_id,
  m.display_name  AS display_name,
  m.input_price_per_1m  AS input_price_per_1m,
  m.output_price_per_1m AS output_price_per_1m,
  m.is_enabled    AS model_enabled
FROM llm_models m
JOIN llm_providers p ON p.id = m.provider_id
`.trim();

const SQL_BY_MODEL_ROW_ID = `${MODEL_SELECT}\nWHERE m.id = $1::uuid\nLIMIT 1`;
const SQL_BY_UPSTREAM_MODEL_ID = `${MODEL_SELECT}\nWHERE m.model_id = $1\nORDER BY m.created_at ASC, m.id ASC\nLIMIT 1`;
const SQL_BY_ROLE = `${MODEL_SELECT}\nJOIN agent_role_bindings b ON b.model_id = m.id\nWHERE b.role = $1\nLIMIT 1`;
const SQL_ANY_BOUND_ROLE = `${MODEL_SELECT}
JOIN agent_role_bindings b ON b.model_id = m.id
ORDER BY CASE b.role
  WHEN 'showrunner' THEN 0
  WHEN 'lorekeeper' THEN 1
  WHEN 'writer' THEN 2
  ELSE 3
END, b.role
LIMIT 1`;

/**
 * 构造模型配置解析器：按任务指定的模型 / 角色绑定，从 PostgreSQL 读取
 * `llm_models` + `llm_providers`，解密 API Key 并归一化为 `ResolvedModelConfig`。
 *
 * 选择优先级：
 * 1. 显式 `modelId`（uuid 视为 `llm_models.id`，否则视为上游 `model_id`）
 * 2. 显式 `role` 的 `agent_role_bindings`
 * 3. 未指定时按 `showrunner → lorekeeper → writer → critic` 顺序取第一个已绑定角色
 */
export function createModelConfigResolver(
  executor: QueryExecutor,
  encryptionKey: Buffer,
): (selector: ModelSelector) => Promise<ResolvedModelConfig> {
  return async (selector: ModelSelector): Promise<ResolvedModelConfig> => {
    const row = await findModelRow(executor, selector);
    if (!row) {
      if (selector.modelId !== undefined) {
        throw new WorkerJobError(
          `未找到可用的模型配置（modelId=${selector.modelId}）。`,
          API_ERROR_CODES.MODEL_NOT_FOUND,
        );
      }
      if (selector.role !== undefined) {
        throw new WorkerJobError(
          `写书角色 ${selector.role} 尚未绑定模型。`,
          API_ERROR_CODES.AGENT_ROLE_UNBOUND,
        );
      }
      throw new WorkerJobError(
        '尚未为任何写书角色绑定模型，无法执行 live 冒烟。',
        API_ERROR_CODES.AGENT_ROLE_UNBOUND,
      );
    }

    if (!row.provider_enabled) {
      throw new WorkerJobError(
        `供应商 ${row.provider_name} 已停用，拒绝执行模型调用。`,
        API_ERROR_CODES.PROVIDER_DISABLED,
      );
    }
    if (!row.model_enabled) {
      throw new WorkerJobError(
        `模型 ${row.display_name} 已停用，拒绝执行模型调用。`,
        API_ERROR_CODES.MODEL_DISABLED,
      );
    }

    const apiKey = decryptSecret(row.api_key_encrypted, encryptionKey);

    const parsed = resolvedModelConfigSchema.safeParse({
      providerId: row.provider_id,
      providerName: row.provider_name,
      protocol: row.protocol,
      baseUrl: row.base_url,
      apiKey,
      modelId: row.model_id,
      displayName: row.display_name,
      inputPricePer1m: toFiniteNumber(row.input_price_per_1m),
      outputPricePer1m: toFiniteNumber(row.output_price_per_1m),
    });

    if (!parsed.success) {
      throw new WorkerJobError(
        `模型配置数据非法（${row.provider_name}/${row.model_id}）：字段未通过契约校验。`,
        API_ERROR_CODES.INTERNAL_ERROR,
      );
    }
    return parsed.data;
  };
}

async function findModelRow(
  executor: QueryExecutor,
  selector: ModelSelector,
): Promise<SmokeModelRow | null> {
  if (selector.modelId !== undefined) {
    if (uuidSchema.safeParse(selector.modelId).success) {
      return firstRow(await executor.query<SmokeModelRow>(SQL_BY_MODEL_ROW_ID, [selector.modelId]));
    }
    return firstRow(
      await executor.query<SmokeModelRow>(SQL_BY_UPSTREAM_MODEL_ID, [selector.modelId]),
    );
  }

  if (selector.role !== undefined) {
    return firstRow(await executor.query<SmokeModelRow>(SQL_BY_ROLE, [selector.role]));
  }

  // 未指定时取任一已绑定角色（按 showrunner → lorekeeper → writer → critic 的固定优先级）。
  return firstRow(await executor.query<SmokeModelRow>(SQL_ANY_BOUND_ROLE));
}

function firstRow(result: { rows: SmokeModelRow[] }): SmokeModelRow | null {
  return result.rows[0] ?? null;
}

/** pg NUMERIC 默认返回字符串，这里统一转为有限数字，异常值兜底 0。 */
function toFiniteNumber(value: string | number | null): number {
  if (value === null) {
    return 0;
  }
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

/** 解密失败统一映射为共享错误码，且错误消息不包含密文 / 明文。 */
function decryptSecret(encrypted: string, key: Buffer): string {
  try {
    return decryptApiKey(encrypted, key);
  } catch (error) {
    if (error instanceof EncryptionKeyError) {
      throw new WorkerJobError(error.message, API_ERROR_CODES.ENCRYPTION_KEY_INVALID);
    }
    if (error instanceof ApiKeyDecryptionError) {
      throw new WorkerJobError(error.message, API_ERROR_CODES.ENCRYPTION_KEY_INVALID);
    }
    throw new WorkerJobError(
      'API Key 解密失败：请检查 APP_ENCRYPTION_KEY 是否与服务端一致。',
      API_ERROR_CODES.ENCRYPTION_KEY_INVALID,
    );
  }
}
