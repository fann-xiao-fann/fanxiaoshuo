import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { QueryResultRow } from 'pg';
import { API_ERROR_CODES } from '@fanxiaoshuo/shared';
import type { QueryExecutor } from '../db/usage-log-writer.js';
import { createModelConfigResolver } from '../db/model-repository.js';
import { WorkerJobError } from '../errors.js';
import { encryptApiKey } from '../security/encryption.js';

interface SqlCall {
  readonly text: string;
  readonly values: readonly unknown[];
}

interface ModelRow extends QueryResultRow {
  provider_id: string;
  provider_name: string;
  protocol: string;
  base_url: string;
  api_key_encrypted: string;
  provider_enabled: boolean;
  model_row_id: string;
  model_id: string;
  display_name: string;
  input_price_per_1m: string | number | null;
  output_price_per_1m: string | number | null;
  model_enabled: boolean;
}

const KEY = randomBytes(32);
const API_KEY = 'sk-decrypted-value-123456';
const MODEL_ROW_ID = '22222222-2222-4222-8222-222222222222';

function createExecutor(rows: ModelRow[]): QueryExecutor & { readonly calls: SqlCall[] } {
  const calls: SqlCall[] = [];
  return {
    calls,
    async query<T extends QueryResultRow = QueryResultRow>(
      text: string,
      values: unknown[] = [],
    ): Promise<{ rows: T[] }> {
      calls.push({ text, values });
      return { rows: rows as unknown as T[] };
    },
  };
}

function createRow(overrides: Partial<ModelRow> = {}): ModelRow {
  return {
    provider_id: '11111111-1111-4111-8111-111111111111',
    provider_name: 'fixture-provider',
    protocol: 'openai-compatible',
    base_url: 'https://api.example.com/v1',
    api_key_encrypted: encryptApiKey(API_KEY, KEY),
    provider_enabled: true,
    model_row_id: MODEL_ROW_ID,
    model_id: 'gpt-4o-mini',
    display_name: 'Fixture GPT',
    input_price_per_1m: '0.150000',
    output_price_per_1m: 0.6,
    model_enabled: true,
    ...overrides,
  };
}

describe('createModelConfigResolver', () => {
  it('按 llm_models.id（uuid）解析并解密，NUMERIC 价格转数字', async () => {
    const executor = createExecutor([createRow()]);
    const resolve = createModelConfigResolver(executor, KEY);

    const config = await resolve({ modelId: MODEL_ROW_ID });

    expect(config).toEqual({
      providerId: '11111111-1111-4111-8111-111111111111',
      providerName: 'fixture-provider',
      protocol: 'openai-compatible',
      baseUrl: 'https://api.example.com/v1',
      apiKey: API_KEY,
      modelId: 'gpt-4o-mini',
      displayName: 'Fixture GPT',
      inputPricePer1m: 0.15,
      outputPricePer1m: 0.6,
    });
    expect(executor.calls[0]?.text).toContain('m.id = $1::uuid');
    expect(executor.calls[0]?.values).toEqual([MODEL_ROW_ID]);
  });

  it('按上游 model_id 或角色绑定解析', async () => {
    const executor = createExecutor([createRow()]);
    const resolve = createModelConfigResolver(executor, KEY);

    await resolve({ modelId: 'gpt-4o-mini' });
    await resolve({ role: 'writer' });
    await resolve({});

    expect(executor.calls[0]?.text).toContain('m.model_id = $1');
    expect(executor.calls[1]?.text).toContain('b.role = $1');
    expect(executor.calls[1]?.values).toEqual(['writer']);
    expect(executor.calls[2]?.text).toContain('CASE b.role');
  });

  it('未找到时映射为 MODEL_NOT_FOUND / AGENT_ROLE_UNBOUND', async () => {
    const executor = createExecutor([]);
    const resolve = createModelConfigResolver(executor, KEY);

    await expect(resolve({ modelId: 'gpt-4o-mini' })).rejects.toMatchObject({
      code: API_ERROR_CODES.MODEL_NOT_FOUND,
    });
    await expect(resolve({ role: 'critic' })).rejects.toMatchObject({
      code: API_ERROR_CODES.AGENT_ROLE_UNBOUND,
    });
    await expect(resolve({})).rejects.toMatchObject({
      code: API_ERROR_CODES.AGENT_ROLE_UNBOUND,
    });
  });

  it('供应商 / 模型停用时拒绝执行', async () => {
    const disabledProvider = createExecutor([createRow({ provider_enabled: false })]);
    await expect(
      createModelConfigResolver(disabledProvider, KEY)({ modelId: MODEL_ROW_ID }),
    ).rejects.toMatchObject({ code: API_ERROR_CODES.PROVIDER_DISABLED });

    const disabledModel = createExecutor([createRow({ model_enabled: false })]);
    await expect(
      createModelConfigResolver(disabledModel, KEY)({ modelId: MODEL_ROW_ID }),
    ).rejects.toMatchObject({ code: API_ERROR_CODES.MODEL_DISABLED });
  });

  it('密文 / 主密钥异常映射为 ENCRYPTION_KEY_INVALID 且不泄露密文', async () => {
    const row = createRow({ api_key_encrypted: 'v1:0f:0f:0f' });
    const executor = createExecutor([row]);
    const resolve = createModelConfigResolver(executor, KEY);

    let thrown: unknown;
    try {
      await resolve({ modelId: MODEL_ROW_ID });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(WorkerJobError);
    expect((thrown as WorkerJobError).code).toBe(API_ERROR_CODES.ENCRYPTION_KEY_INVALID);
    expect((thrown as Error).message).not.toContain(row.api_key_encrypted);
  });
});
