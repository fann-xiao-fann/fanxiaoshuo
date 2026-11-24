import {
  API_ERROR_CODES,
  createModelSchema,
  modelDtoSchema,
  modelListResponseSchema,
  testModelResponseSchema,
  updateModelSchema,
} from '@fanxiaoshuo/shared';
import { type ResolvedModelConfig, type UsageLogRecordInput } from '@fanxiaoshuo/agents';
import type { FastifyInstance } from 'fastify';
import { ApiError, isUniqueViolation } from '../errors.js';
import { SecretCodecError } from '../crypto/secret-codec.js';
import { toModelDto } from '../mapping/dto.js';
import type { ServerDependencies } from '../server-deps.js';
import type { UpdateModelRecordPatch } from '../repositories/types.js';
import { parseIdParam, parseOptionalUuidQuery, parseOrThrow } from './helpers.js';

/**
 * `/api/v1/models` 路由：
 * - 模型目录 CRUD（含 `(provider_id, model_id)` 联合唯一冲突处理）
 * - 一键测通：解密 Provider Key → 统一网关真实调用 → 成功/失败均落盘用量日志
 */
export function registerModelRoutes(app: FastifyInstance, deps: ServerDependencies): void {
  const base = '/api/v1/models';

  app.get(base, async (request) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    const providerId = parseOptionalUuidQuery(query['providerId'], 'providerId');
    const records = await deps.models.list(providerId);
    const items = records.map(toModelDto);
    return modelListResponseSchema.parse({ items, total: items.length });
  });

  app.post(base, async (request, reply) => {
    const input = parseOrThrow(createModelSchema, request.body);

    const provider = await deps.providers.findById(input.providerId);
    if (!provider) {
      throw new ApiError(
        API_ERROR_CODES.PROVIDER_NOT_FOUND,
        '指定的供应商不存在，请先创建供应商。',
      );
    }

    const duplicated = await deps.models.existsByProviderAndModelId(input.providerId, input.modelId);
    if (duplicated) {
      throw new ApiError(
        API_ERROR_CODES.CONFLICT,
        `该供应商下已存在模型「${input.modelId}」，请勿重复添加。`,
      );
    }

    let record;
    try {
      record = await deps.models.create({
        providerId: input.providerId,
        modelId: input.modelId,
        displayName: input.displayName,
        contextWindow: input.contextWindow ?? null,
        inputPricePer1m: input.inputPricePer1M,
        outputPricePer1m: input.outputPricePer1M,
        isEnabled: input.isEnabled,
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApiError(
          API_ERROR_CODES.CONFLICT,
          `该供应商下已存在模型「${input.modelId}」，请勿重复添加。`,
          { cause: error },
        );
      }
      throw error;
    }

    return reply.status(201).send(modelDtoSchema.parse(toModelDto(record)));
  });

  app.patch(`${base}/:id`, async (request) => {
    const id = parseIdParam(request.params);
    const input = parseOrThrow(updateModelSchema, request.body);

    const existing = await deps.models.findById(id);
    if (!existing) {
      throw new ApiError(API_ERROR_CODES.MODEL_NOT_FOUND, '模型不存在或已被删除。');
    }

    if (input.modelId !== undefined && input.modelId !== existing.modelId) {
      const duplicated = await deps.models.existsByProviderAndModelId(
        existing.providerId,
        input.modelId,
        id,
      );
      if (duplicated) {
        throw new ApiError(
          API_ERROR_CODES.CONFLICT,
          `该供应商下已存在模型「${input.modelId}」，请勿重复添加。`,
        );
      }
    }

    const patch: UpdateModelRecordPatch = {
      ...(input.modelId !== undefined ? { modelId: input.modelId } : {}),
      ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
      ...(input.contextWindow !== undefined ? { contextWindow: input.contextWindow } : {}),
      ...(input.inputPricePer1M !== undefined
        ? { inputPricePer1m: input.inputPricePer1M }
        : {}),
      ...(input.outputPricePer1M !== undefined
        ? { outputPricePer1m: input.outputPricePer1M }
        : {}),
      ...(input.isEnabled !== undefined ? { isEnabled: input.isEnabled } : {}),
    };

    let updated;
    try {
      updated = await deps.models.update(id, patch);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApiError(API_ERROR_CODES.CONFLICT, '同一供应商下模型标识必须唯一。', {
          cause: error,
        });
      }
      throw error;
    }

    if (!updated) {
      throw new ApiError(API_ERROR_CODES.MODEL_NOT_FOUND, '模型不存在或已被删除。');
    }

    return modelDtoSchema.parse(toModelDto(updated));
  });

  app.delete(`${base}/:id`, async (request, reply) => {
    const id = parseIdParam(request.params);

    const existing = await deps.models.findById(id);
    if (!existing) {
      throw new ApiError(API_ERROR_CODES.MODEL_NOT_FOUND, '模型不存在或已被删除。');
    }

    // 前置检查给出明确 409，数据库 ON DELETE RESTRICT 作为并发兜底。
    if (await deps.agentRoles.isModelBound(id)) {
      throw new ApiError(
        API_ERROR_CODES.MODEL_IN_USE,
        '该模型仍被写书 Agent 角色绑定，请先在角色路由中切换或解除绑定。',
      );
    }

    const result = await deps.models.delete(id);
    if (result === 'not_found') {
      throw new ApiError(API_ERROR_CODES.MODEL_NOT_FOUND, '模型不存在或已被删除。');
    }
    if (result === 'in_use') {
      throw new ApiError(
        API_ERROR_CODES.MODEL_IN_USE,
        '该模型仍被写书 Agent 角色绑定，请先在角色路由中切换或解除绑定。',
      );
    }

    return reply.status(204).send();
  });

  app.post(`${base}/:id/test`, async (request) => {
    const id = parseIdParam(request.params);

    const found = await deps.models.findWithProvider(id);
    if (!found) {
      throw new ApiError(API_ERROR_CODES.MODEL_NOT_FOUND, '模型不存在或已被删除。');
    }
    const { model, provider } = found;

    if (!provider.isEnabled) {
      throw new ApiError(
        API_ERROR_CODES.PROVIDER_DISABLED,
        '所属供应商已停用，请先启用供应商再执行测通。',
      );
    }
    if (!model.isEnabled) {
      throw new ApiError(API_ERROR_CODES.MODEL_DISABLED, '该模型已停用，请先启用再执行测通。');
    }

    let apiKey: string;
    try {
      apiKey = deps.codec.decrypt(provider.apiKeyEncrypted);
    } catch (error) {
      if (error instanceof SecretCodecError) {
        throw new ApiError(
          API_ERROR_CODES.ENCRYPTION_KEY_INVALID,
          'Provider API Key 解密失败：APP_ENCRYPTION_KEY 可能已变更，请重新保存该供应商密钥。',
          { cause: error },
        );
      }
      throw error;
    }

    const config: ResolvedModelConfig = {
      providerId: provider.id,
      providerName: provider.name,
      protocol: provider.protocol,
      baseUrl: provider.baseUrl,
      apiKey,
      modelId: model.modelId,
      displayName: model.displayName,
      inputPricePer1m: model.inputPricePer1m,
      outputPricePer1m: model.outputPricePer1m,
    };

    let usageLogId: string | null = null;
    const usageLogger = async (record: UsageLogRecordInput): Promise<void> => {
      const inserted = await deps.usageLogs.insert(record);
      usageLogId = inserted.id;
    };

    // 网关内部保证成功 / 失败都调用 usageLogger，且错误文本已脱敏（绝不包含明文 Key）。
    const result = await deps.gateway.testConnectivity(config, { usageLogger });

    return testModelResponseSchema.parse({
      ...result,
      usageLogId,
    });
  });
}
