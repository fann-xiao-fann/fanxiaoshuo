import {
  API_ERROR_CODES,
  createProviderSchema,
  providerDtoSchema,
  providerListResponseSchema,
  updateProviderSchema,
} from '@fanxiaoshuo/shared';
import type { FastifyInstance } from 'fastify';
import { ApiError, isUniqueViolation } from '../errors.js';
import { toProviderDto } from '../mapping/dto.js';
import type { ServerDependencies } from '../server-deps.js';
import type { UpdateProviderRecordPatch } from '../repositories/types.js';
import { parseIdParam, parseOrThrow } from './helpers.js';

/**
 * `/api/v1/providers` 路由。
 *
 * 安全红线：所有响应只包含 `apiKeyMask`，绝不返回明文 / 密文密钥。
 */
export function registerProviderRoutes(app: FastifyInstance, deps: ServerDependencies): void {
  const base = '/api/v1/providers';

  app.get(base, async () => {
    const records = await deps.providers.list();
    const items = records.map(toProviderDto);
    return providerListResponseSchema.parse({ items, total: items.length });
  });

  app.post(base, async (request, reply) => {
    const input = parseOrThrow(createProviderSchema, request.body);

    const existing = await deps.providers.findByName(input.name);
    if (existing) {
      throw new ApiError(
        API_ERROR_CODES.CONFLICT,
        `供应商名称「${input.name}」已存在，请换一个名称。`,
      );
    }

    let record;
    try {
      record = await deps.providers.create({
        name: input.name,
        protocol: input.protocol,
        baseUrl: input.baseUrl,
        apiKeyEncrypted: deps.codec.encrypt(input.apiKey),
        apiKeyMask: deps.codec.mask(input.apiKey),
        isEnabled: input.isEnabled,
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApiError(
          API_ERROR_CODES.CONFLICT,
          `供应商名称「${input.name}」已存在，请换一个名称。`,
          { cause: error },
        );
      }
      throw error;
    }

    return reply.status(201).send(providerDtoSchema.parse(toProviderDto(record)));
  });

  app.patch(`${base}/:id`, async (request) => {
    const id = parseIdParam(request.params);
    const input = parseOrThrow(updateProviderSchema, request.body);

    const existing = await deps.providers.findById(id);
    if (!existing) {
      throw new ApiError(API_ERROR_CODES.PROVIDER_NOT_FOUND, '供应商不存在或已被删除。');
    }

    if (input.name !== undefined && input.name !== existing.name) {
      const duplicated = await deps.providers.findByName(input.name);
      if (duplicated) {
        throw new ApiError(
          API_ERROR_CODES.CONFLICT,
          `供应商名称「${input.name}」已存在，请换一个名称。`,
        );
      }
    }

    // `apiKey` 留空（空字符串或省略）时保留原加密密钥与掩码。
    const nextSecret =
      input.apiKey !== undefined && input.apiKey.length > 0
        ? {
            apiKeyEncrypted: deps.codec.encrypt(input.apiKey),
            apiKeyMask: deps.codec.mask(input.apiKey),
          }
        : {};

    const patch: UpdateProviderRecordPatch = {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.protocol !== undefined ? { protocol: input.protocol } : {}),
      ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
      ...(input.isEnabled !== undefined ? { isEnabled: input.isEnabled } : {}),
      ...nextSecret,
    };

    let updated;
    try {
      updated = await deps.providers.update(id, patch);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApiError(API_ERROR_CODES.CONFLICT, '供应商名称已存在，请换一个名称。', {
          cause: error,
        });
      }
      throw error;
    }

    if (!updated) {
      throw new ApiError(API_ERROR_CODES.PROVIDER_NOT_FOUND, '供应商不存在或已被删除。');
    }

    return providerDtoSchema.parse(toProviderDto(updated));
  });

  app.delete(`${base}/:id`, async (request, reply) => {
    const id = parseIdParam(request.params);
    const result = await deps.providers.delete(id);

    if (result === 'not_found') {
      throw new ApiError(API_ERROR_CODES.PROVIDER_NOT_FOUND, '供应商不存在或已被删除。');
    }
    if (result === 'in_use') {
      throw new ApiError(
        API_ERROR_CODES.CONFLICT,
        '该供应商下的模型仍被写书 Agent 角色绑定，请先解除角色绑定后再删除。',
      );
    }

    return reply.status(204).send();
  });
}
