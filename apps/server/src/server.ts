import { API_ERROR_CODES, apiErrorSchema, type ApiErrorIssue } from '@fanxiaoshuo/shared';
import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { ApiError, isForeignKeyViolation, isUniqueViolation, toApiError, validationErrorFromZod } from './errors.js';
import { registerAgentRoleRoutes } from './routes/agent-roles.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerModelRoutes } from './routes/models.js';
import { registerProviderRoutes } from './routes/providers.js';
import { registerRuntimeRoutes } from './routes/runtime.js';
import { registerUsageLogRoutes } from './routes/usage-logs.js';
import type { ServerDependencies } from './server-deps.js';

/** 归一化 Fastify 内置客户端错误（如非法 JSON body）为统一 400。 */
function normalizeError(error: unknown): ApiError {
  if (error instanceof ApiError) {
    return error;
  }
  if (error instanceof ZodError) {
    return validationErrorFromZod(error);
  }
  if (isForeignKeyViolation(error) || isUniqueViolation(error)) {
    return toApiError(error);
  }
  const statusCode =
    typeof error === 'object' && error !== null
      ? (error as Record<string, unknown>)['statusCode']
      : undefined;
  if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
    const message =
      error instanceof Error && error.message.length > 0 ? error.message : '请求不合法。';
    return new ApiError(API_ERROR_CODES.VALIDATION_ERROR, message);
  }
  return toApiError(error);
}

/**
 * 构造 Fastify 实例（依赖注入）。
 *
 * 生产入口见 `src/index.ts`；测试直接注入内存仓储 + 假探针后调用 `app.inject()`。
 */
export async function buildServer(deps: ServerDependencies): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    bodyLimit: 2 * 1024 * 1024,
  });

  await app.register(cors, {
    origin: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Accept', 'Last-Event-ID'],
    maxAge: 86_400,
  });

  app.setErrorHandler((error, request, reply) => {
    const normalized = normalizeError(error);
    if (normalized.statusCode >= 500) {
      request.log.error({ err: error }, '请求处理失败');
    }
    const body = apiErrorSchema.parse({
      code: normalized.code,
      message: normalized.message,
      ...(normalized.details === undefined
        ? {}
        : { details: normalized.details.map((issue): ApiErrorIssue => ({ ...issue })) }),
      requestId: request.id,
    });
    return reply.status(normalized.statusCode).send(body);
  });

  app.setNotFoundHandler((request, reply) => {
    const body = apiErrorSchema.parse({
      code: API_ERROR_CODES.NOT_FOUND,
      message: `接口不存在：${request.method} ${request.url}`,
      requestId: request.id,
    });
    return reply.status(404).send(body);
  });

  registerHealthRoutes(app, deps);
  registerProviderRoutes(app, deps);
  registerModelRoutes(app, deps);
  registerAgentRoleRoutes(app, deps);
  registerUsageLogRoutes(app, deps);
  registerRuntimeRoutes(app, deps);

  return app;
}
