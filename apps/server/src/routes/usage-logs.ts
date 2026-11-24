import {
  usageLogsQuerySchema,
  usageLogsResponseSchema,
} from '@fanxiaoshuo/shared';
import type { FastifyInstance } from 'fastify';
import { toUsageLogDto } from '../mapping/dto.js';
import type { ServerDependencies } from '../server-deps.js';
import type { UsageLogQuery } from '../repositories/types.js';
import { parseOrThrow } from './helpers.js';

/** `/api/v1/usage-logs`：分页明细（时间倒序）+ 筛选区间聚合汇总。 */
export function registerUsageLogRoutes(app: FastifyInstance, deps: ServerDependencies): void {
  app.get('/api/v1/usage-logs', async (request) => {
    const query = parseOrThrow(usageLogsQuerySchema, request.query ?? {});

    const repoQuery: UsageLogQuery = {
      page: query.page,
      pageSize: query.pageSize,
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.role === undefined ? {} : { role: query.role }),
      ...(query.scene === undefined ? {} : { scene: query.scene }),
      ...(query.from === undefined ? {} : { from: new Date(query.from) }),
      ...(query.to === undefined ? {} : { to: new Date(query.to) }),
    };

    const page = await deps.usageLogs.query(repoQuery);
    const totalPages = page.total === 0 ? 0 : Math.ceil(page.total / query.pageSize);

    return usageLogsResponseSchema.parse({
      items: page.items.map(toUsageLogDto),
      page: query.page,
      pageSize: query.pageSize,
      total: page.total,
      totalPages,
      summary: page.summary,
      from: query.from ?? null,
      to: query.to ?? null,
    });
  });
}
