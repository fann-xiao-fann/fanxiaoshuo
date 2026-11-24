import {
  API_ERROR_CODES,
  SSE_EVENT_NAMES,
  createSmokeJobSchema,
  smokeJobDtoSchema,
  type SmokeJobDto,
  type SmokeJobResult,
} from '@fanxiaoshuo/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ApiError } from '../errors.js';
import type { ServerDependencies } from '../server-deps.js';
import type { SmokeQueueSnapshot, Unsubscribe } from '../queue/types.js';
import { parseJobIdParam, parseOrThrow } from './helpers.js';

/** 快照 → 对外 DTO（含耗时；结果/错误均为可空）。 */
function toSmokeJobDto(snapshot: SmokeQueueSnapshot): SmokeJobDto {
  const durationMs =
    snapshot.startedAt && snapshot.finishedAt
      ? Math.max(0, snapshot.finishedAt.getTime() - snapshot.startedAt.getTime())
      : null;

  return smokeJobDtoSchema.parse({
    jobId: snapshot.jobId,
    status: snapshot.status,
    invokeModel: snapshot.invokeModel,
    note: snapshot.note,
    attemptsMade: snapshot.attemptsMade,
    createdAt: snapshot.createdAt.toISOString(),
    startedAt: snapshot.startedAt?.toISOString() ?? null,
    finishedAt: snapshot.finishedAt?.toISOString() ?? null,
    durationMs,
    result: snapshot.result satisfies SmokeJobResult | null,
    errorCode: snapshot.errorCode,
    errorMessage: snapshot.errorMessage,
  });
}

/** SSE 帧格式化（`event:` + 单行 JSON `data:`）。 */
export function formatSseFrame(event: string, payload: unknown): string {
  const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return `event: ${event}\ndata: ${data}\n\n`;
}

/** 挂载 `/api/v1/runtime/*`：冒烟任务入队 / 查询 / SSE 事件流。 */
export function registerRuntimeRoutes(app: FastifyInstance, deps: ServerDependencies): void {
  const base = '/api/v1/runtime';

  app.post(`${base}/smoke-jobs`, async (request, reply) => {
    const input = parseOrThrow(createSmokeJobSchema, request.body ?? {});

    const enqueued = await deps.smokeQueue.enqueue({
      invokeModel: input.invokeModel,
      ...(input.note === undefined ? {} : { note: input.note }),
    });

    let job: SmokeJobDto;
    try {
      job = smokeJobDtoSchema.parse({
        jobId: enqueued.jobId,
        status: 'queued',
        invokeModel: input.invokeModel,
        note: input.note ?? null,
        attemptsMade: 0,
        createdAt: enqueued.createdAt.toISOString(),
        startedAt: null,
        finishedAt: null,
        durationMs: null,
        result: null,
        errorCode: null,
        errorMessage: null,
      });
    } catch (error) {
      throw new ApiError(
        API_ERROR_CODES.INTERNAL_ERROR,
        '任务入队后构造响应失败，请检查队列返回的 jobId / 时间戳。',
        { cause: error },
      );
    }

    // 事件广播失败不应导致入队失败：任务已成功排队，前端可轮询状态接口兜底。
    try {
      await deps.eventBus.publish({
        type: 'job.queued',
        jobId: job.jobId,
        status: 'queued',
        timestamp: job.createdAt,
        attemptsMade: 0,
        progress: 0,
        errorCode: null,
        errorMessage: null,
        data: { invokeModel: job.invokeModel, note: job.note },
      });
    } catch (error) {
      request.log.warn({ err: error }, '发布 job.queued 事件失败（任务已入队）');
    }

    return reply.status(202).send(job);
  });

  app.get(`${base}/smoke-jobs/:jobId`, async (request) => {
    const jobId = parseJobIdParam(request.params);
    const snapshot = await deps.smokeQueue.get(jobId);
    if (!snapshot) {
      throw new ApiError(API_ERROR_CODES.JOB_NOT_FOUND, '冒烟任务不存在或已被清理。');
    }
    return toSmokeJobDto(snapshot);
  });

  app.get(`${base}/events`, async (request, reply) => {
    await handleSse(request, reply, deps);
  });
}

/**
 * SSE 端点：
 * - 握手帧 `event: ready`
 * - 转发 Redis Pub/Sub 的 `JobEvent`（`event: job-event`）
 * - 周期心跳 `event: ping` 防止代理断开
 * - 客户端断开时退订并清理定时器
 */
async function handleSse(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: ServerDependencies,
): Promise<void> {
  reply.hijack();
  const res = reply.raw;
  const heartbeatMs = deps.sseHeartbeatMs ?? 15_000;

  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  res.write(
    formatSseFrame(SSE_EVENT_NAMES.ready, {
      timestamp: new Date().toISOString(),
      channel: 'fanxiaoshuo:events:jobs',
    }),
  );

  let closed = false;
  let unsubscribe: Unsubscribe | null = null;
  let heartbeat: NodeJS.Timeout | null = null;

  const safeWrite = (chunk: string): void => {
    if (closed) {
      return;
    }
    try {
      res.write(chunk);
    } catch {
      closed = true;
    }
  };

  const cleanup = async (): Promise<void> => {
    if (closed) {
      return;
    }
    closed = true;
    if (heartbeat !== null) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
    if (unsubscribe !== null) {
      const current = unsubscribe;
      unsubscribe = null;
      try {
        await current();
      } catch {
        // 退订失败不应阻塞连接清理。
      }
    }
  };

  res.on('close', () => {
    void cleanup();
  });
  res.on('error', () => {
    void cleanup();
  });
  request.raw.on('close', () => {
    void cleanup();
  });
  request.raw.socket?.on('close', () => {
    void cleanup();
  });

  try {
    const unsub = await deps.eventBus.subscribe((event) => {
      safeWrite(formatSseFrame(SSE_EVENT_NAMES.jobEvent, event));
    });
    if (closed) {
      await unsub();
      return;
    }
    unsubscribe = unsub;
  } catch (error) {
    safeWrite(
      formatSseFrame('error', {
        code: API_ERROR_CODES.QUEUE_UNAVAILABLE,
        message:
          error instanceof Error
            ? `事件总线订阅失败：${error.message}`
            : '事件总线订阅失败，请检查 Redis 状态。',
        timestamp: new Date().toISOString(),
      }),
    );
    await cleanup();
    res.end();
    return;
  }

  heartbeat = setInterval(() => {
    safeWrite(
      formatSseFrame(SSE_EVENT_NAMES.ping, {
        timestamp: new Date().toISOString(),
      }),
    );
  }, heartbeatMs);
  heartbeat.unref?.();
}
