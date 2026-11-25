import {
  API_ERROR_CODES,
  REDIS_CHANNELS,
  WORKFLOW_SSE_EVENT_NAMES,
  createWorkflowRunSchema,
  isWorkflowTerminalStatus,
  resumeWorkflowRunSchema,
  workflowRunConfigSchema,
  workflowRunDetailDtoSchema,
  workflowRunListQuerySchema,
  workflowRunListResponseSchema,
  type AgentRole,
  type CreateWorkflowRunInput,
  type WorkflowEvent,
  type WorkflowEventType,
  type WorkflowRunDetailDto,
} from '@fanxiaoshuo/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ApiError } from '../errors.js';
import {
  toWorkflowRunDetailDto,
  toWorkflowRunSummaryDto,
} from '../mapping/dto.js';
import type { Unsubscribe, WorkflowEventBus } from '../queue/types.js';
import type { WorkflowRunDetailRecord, WorkflowRunRecord } from '../repositories/types.js';
import { resolveRoleModel } from '../services/model-resolver.js';
import type { ServerDependencies } from '../server-deps.js';
import {
  chapterNotFound,
  requireActiveBookAggregate,
  requireActiveVolumeOfBook,
} from './book-helpers.js';
import { parseIdParam, parseOptionalUuidQuery, parseOrThrow } from './helpers.js';
import { formatSseFrame } from './runtime.js';

/**
 * `/api/v1/workflows/*` 批量流水线 REST 与 SSE 路由（Change 4）。
 *
 * 契约唯一真相来源：`packages/shared/src/schemas/workflow.ts`。
 * 全部写操作遵循「先校验（书籍 / 章节 / 角色模型）→ 再落盘 → 再入队 → 最后尽力广播」，
 * 任何前置校验失败都在写入 `workflow_runs` 之前抛错，绝不残留孤立批次。
 */

/* -------------------------------------------------------------------------- */
/*                                   通用工具                                  */
/* -------------------------------------------------------------------------- */

/** 读取批次详情，不存在抛 404。 */
async function requireRunDetail(
  deps: ServerDependencies,
  runId: string,
): Promise<WorkflowRunDetailRecord> {
  const detail = await deps.workflowRuns.findDetailById(runId);
  if (!detail) {
    throw new ApiError(API_ERROR_CODES.WORKFLOW_RUN_NOT_FOUND, '批量任务不存在或已被删除。');
  }
  return detail;
}

/**
 * 依运行模式与配置快照推导必需写书角色。
 * `critic` / `lorekeeper` 仅在对应开关打开时才算必需。
 */
export function requiredWorkflowRoles(
  mode: CreateWorkflowRunInput['mode'],
  config: { readonly enableCritic: boolean; readonly enableSummary: boolean },
): AgentRole[] {
  const optional: AgentRole[] = [
    ...(config.enableCritic ? (['critic'] as const) : []),
    ...(config.enableSummary ? (['lorekeeper'] as const) : []),
  ];

  switch (mode) {
    case 'outline_only':
      return ['showrunner'];
    case 'write_chapters':
      return ['writer', ...optional];
    case 'full_pipeline':
      return ['showrunner', 'writer', ...optional];
  }
}

/**
 * 前置校验全部必需角色的模型可用性。
 * 任一角色未绑定 / 供应商或模型停用 → 直接抛 409，且发生在建章与入库之前。
 */
async function requireRoleModels(
  deps: ServerDependencies,
  roles: readonly AgentRole[],
): Promise<void> {
  for (const role of roles) {
    await resolveRoleModel(deps, role);
  }
}

/** 章节标题生成：`第` → `第1章`；`第一卷·第` → `第一卷·第1章`；其它前缀自然拼接。 */
export function buildAutoChapterTitle(titlePrefix: string, sequence: number): string {
  const trimmed = titlePrefix.trim();
  if (trimmed.length === 0 || trimmed === '第') {
    return `第${sequence}章`;
  }
  if (trimmed.startsWith('第')) {
    return `${trimmed}${sequence}章`;
  }
  if (trimmed.endsWith('章')) {
    return `${trimmed.slice(0, -1)}${sequence}章`;
  }
  return `${trimmed} ${sequence}`;
}

interface TargetChapter {
  readonly id: string;
  readonly title: string;
}

/**
 * 解析批次目标章节：
 * - `chapterIds`：逐章校验存在 / 活跃 / 属于目标书籍，保持请求顺序；
 * - `autoCreateChapters`：校验分卷归属后按序创建空白章节（`status: 'outline'`）。
 */
async function resolveTargetChapters(
  deps: ServerDependencies,
  input: CreateWorkflowRunInput,
): Promise<TargetChapter[]> {
  if (input.chapterIds !== undefined && input.chapterIds.length > 0) {
    const targets: TargetChapter[] = [];
    for (const chapterId of input.chapterIds) {
      const chapter = await deps.chapters.findById(chapterId);
      if (!chapter || chapter.deletedAt !== null) {
        throw chapterNotFound('目标章节不存在或已在回收站中。');
      }
      if (chapter.bookId !== input.bookId) {
        throw new ApiError(
          API_ERROR_CODES.CONFLICT,
          '目标章节不属于该书籍，禁止跨书创建批量任务。',
        );
      }
      targets.push({ id: chapter.id, title: chapter.title });
    }
    return targets;
  }

  const auto = input.autoCreateChapters;
  if (!auto) {
    throw new ApiError(API_ERROR_CODES.VALIDATION_ERROR, '必须提供 chapterIds 或 autoCreateChapters。');
  }

  if (auto.volumeId !== null) {
    // 归属 / 活跃校验由共享助手统一抛出 404 / 409。
    await requireActiveVolumeOfBook(deps, input.bookId, auto.volumeId);
  }

  const existing = await deps.chapters.listByBook(input.bookId, 'active');
  const startSequence = existing.length + 1;

  const created: TargetChapter[] = [];
  for (let offset = 0; offset < auto.count; offset += 1) {
    const title = buildAutoChapterTitle(auto.titlePrefix, startSequence + offset);
    const chapter = await deps.chapters.create({
      bookId: input.bookId,
      volumeId: auto.volumeId,
      title,
      status: 'outline',
    });
    created.push({ id: chapter.id, title: chapter.title });
  }
  return created;
}

/** 批次记录 → 批次级进度事件（Worker 侧步骤级事件另行填充 `step*` 字段）。 */
function toRunEvent(detail: WorkflowRunRecord, type: WorkflowEventType): WorkflowEvent {
  return {
    type,
    runId: detail.id,
    bookId: detail.bookId,
    status: detail.status,
    timestamp: new Date().toISOString(),
    totalSteps: detail.totalSteps,
    completedSteps: detail.completedSteps,
    failedSteps: detail.failedSteps,
    spentCostUsd: detail.spentCostUsd,
    maxCostUsd: detail.maxCostUsd,
    pauseReason: detail.pauseReason,
    stepId: null,
    chapterId: null,
    stepIndex: null,
    stepStatus: null,
    stepStage: null,
    criticScore: null,
    errorCode: null,
    errorMessage: null,
  };
}

/** 尽力广播事件：Redis 抖动不应让已成功落盘 / 入队的请求返回失败。 */
async function publishRunEvent(
  deps: ServerDependencies,
  request: FastifyRequest,
  detail: WorkflowRunRecord,
  type: WorkflowEventType,
): Promise<void> {
  try {
    await deps.workflowEventBus.publish(toRunEvent(detail, type));
  } catch (error) {
    request.log.warn({ err: error }, `发布 ${type} 事件失败（批次已落盘）`);
  }
}

/** 入队：失败时给出明确 503，便于前端提示「批次已保存，可稍后续跑」。 */
async function enqueueRun(
  deps: ServerDependencies,
  runId: string,
  cause?: unknown,
): Promise<void> {
  try {
    await deps.workflowQueue.enqueue(runId);
  } catch (error) {
    throw new ApiError(
      API_ERROR_CODES.QUEUE_UNAVAILABLE,
      '批次已保存，但执行队列暂不可用，请稍后点击「继续运行」。',
      { cause: cause ?? error },
    );
  }
}

/** 用仓储返回值构造详情 DTO。 */
function toDetailDto(detail: WorkflowRunDetailRecord): WorkflowRunDetailDto {
  return workflowRunDetailDtoSchema.parse(toWorkflowRunDetailDto(detail));
}

/* -------------------------------------------------------------------------- */
/*                                   路由注册                                  */
/* -------------------------------------------------------------------------- */

/** 挂载 `/api/v1/workflows/*`：批次 CRUD、生命周期控制与 SSE 实时进度。 */
export function registerWorkflowRoutes(app: FastifyInstance, deps: ServerDependencies): void {
  const base = '/api/v1/workflows';

  /* ------------------------------ 批次列表 ------------------------------ */
  app.get(`${base}/runs`, async (request) => {
    const query = parseOrThrow(workflowRunListQuerySchema, request.query ?? {});
    const page = await deps.workflowRuns.list({
      ...(query.bookId === undefined ? {} : { bookId: query.bookId }),
      ...(query.status === undefined ? {} : { status: query.status }),
      page: query.page,
      pageSize: query.pageSize,
    });

    return workflowRunListResponseSchema.parse({
      items: page.items.map(toWorkflowRunSummaryDto),
      total: page.total,
      page: query.page,
      pageSize: query.pageSize,
    });
  });

  /* ------------------------------ 创建批次 ------------------------------ */
  app.post(`${base}/runs`, async (request, reply) => {
    const input = parseOrThrow(createWorkflowRunSchema, request.body ?? {});

    // 1. 书籍必须存在且活跃（回收站中的书不允许新建批量任务）。
    await requireActiveBookAggregate(deps, input.bookId);

    // 2. 必需角色模型前置校验：先校验再建章入库，绝不残留孤立记录。
    await requireRoleModels(
      deps,
      requiredWorkflowRoles(input.mode, {
        enableCritic: input.enableCritic,
        enableSummary: input.enableSummary,
      }),
    );

    // 3. 解析 / 创建目标章节（保持请求顺序）。
    const targets = await resolveTargetChapters(deps, input);

    // 4. 配置快照：仅保留 `workflowRunConfigSchema` 允许的字段（strictObject）。
    const config = workflowRunConfigSchema.parse({
      enableCritic: input.enableCritic,
      minPassScore: input.minPassScore,
      maxReworkRounds: input.maxReworkRounds,
      enableSummary: input.enableSummary,
      ...(input.targetWords === undefined ? {} : { targetWords: input.targetWords }),
      maxContextTokens: input.maxContextTokens,
      instruction: input.instruction,
    });

    // 5. 单事务落盘批次 + 有序步骤。
    const detail = await deps.workflowRuns.createWithSteps({
      bookId: input.bookId,
      mode: input.mode,
      config,
      maxCostUsd: input.maxCostUsd,
      steps: targets.map((target) => ({
        chapterId: target.id,
        chapterTitleSnapshot: target.title,
      })),
    });

    // 6. 入队 + 尽力广播（广播失败只记录 warn，不影响 201）。
    await enqueueRun(deps, detail.id);
    await publishRunEvent(deps, request, detail, 'workflow.queued');

    return reply.status(201).send(toDetailDto(detail));
  });

  /* ------------------------------ 批次详情 ------------------------------ */
  app.get(`${base}/runs/:runId`, async (request) => {
    const runId = parseIdParam(request.params, 'runId');
    const detail = await requireRunDetail(deps, runId);
    return toDetailDto(detail);
  });

  /* -------------------------------- 暂停 -------------------------------- */
  app.post(`${base}/runs/:runId/pause`, async (request) => {
    const runId = parseIdParam(request.params, 'runId');
    const current = await requireRunDetail(deps, runId);

    if (current.status !== 'queued' && current.status !== 'running') {
      throw new ApiError(
        API_ERROR_CODES.WORKFLOW_INVALID_STATE,
        `批次当前状态为「${current.status}」，仅排队中 / 运行中可暂停。`,
      );
    }

    const detail = await deps.workflowRuns.requestPause(runId);
    if (!detail) {
      throw new ApiError(API_ERROR_CODES.WORKFLOW_RUN_NOT_FOUND, '批量任务不存在或已被删除。');
    }

    if (detail.status === 'paused') {
      await publishRunEvent(deps, request, detail, 'workflow.paused');
    }
    return toDetailDto(detail);
  });

  /* ------------------------------ 断点续跑 ------------------------------ */
  app.post(`${base}/runs/:runId/resume`, async (request) => {
    const runId = parseIdParam(request.params, 'runId');
    const input = parseOrThrow(resumeWorkflowRunSchema, request.body ?? {});
    const current = await requireRunDetail(deps, runId);

    if (current.status !== 'paused' && current.status !== 'failed') {
      throw new ApiError(
        API_ERROR_CODES.WORKFLOW_INVALID_STATE,
        `批次当前状态为「${current.status}」，仅已暂停 / 已失败可续跑。`,
      );
    }

    // 预算校验：续跑前必须确认剩余额度，否则 Worker 会立刻再次熔断。
    const effectiveMaxCostUsd =
      input.maxCostUsd === undefined ? current.maxCostUsd : input.maxCostUsd;
    if (effectiveMaxCostUsd !== null && current.spentCostUsd >= effectiveMaxCostUsd) {
      throw new ApiError(
        API_ERROR_CODES.BUDGET_EXCEEDED,
        `批次已消耗 $${current.spentCostUsd.toFixed(6)}，已达或超过预算上限 $${effectiveMaxCostUsd.toFixed(6)}，请先上调预算上限后再续跑。`,
      );
    }

    // 续跑前重新校验角色模型（期间可能被停用或解绑）。
    await requireRoleModels(
      deps,
      requiredWorkflowRoles(current.mode, {
        enableCritic: current.config.enableCritic,
        enableSummary: current.config.enableSummary,
      }),
    );

    const detail = await deps.workflowRuns.resume(runId, {
      ...(input.maxCostUsd === undefined ? {} : { maxCostUsd: input.maxCostUsd }),
    });
    if (!detail) {
      throw new ApiError(API_ERROR_CODES.WORKFLOW_RUN_NOT_FOUND, '批量任务不存在或已被删除。');
    }

    await enqueueRun(deps, runId);
    await publishRunEvent(deps, request, detail, 'workflow.queued');

    return toDetailDto(detail);
  });

  /* -------------------------------- 取消 -------------------------------- */
  app.post(`${base}/runs/:runId/cancel`, async (request) => {
    const runId = parseIdParam(request.params, 'runId');
    const current = await requireRunDetail(deps, runId);

    if (isWorkflowTerminalStatus(current.status)) {
      throw new ApiError(
        API_ERROR_CODES.WORKFLOW_INVALID_STATE,
        `批次当前状态为「${current.status}」，已处于终态，无需取消。`,
      );
    }

    const detail = await deps.workflowRuns.cancel(runId);
    if (!detail) {
      throw new ApiError(API_ERROR_CODES.WORKFLOW_RUN_NOT_FOUND, '批量任务不存在或已被删除。');
    }

    if (detail.status === 'cancelled') {
      await publishRunEvent(deps, request, detail, 'workflow.cancelled');
    }
    return toDetailDto(detail);
  });

  /* ----------------------------- 单步重试 ----------------------------- */
  app.post(`${base}/runs/:runId/steps/:stepId/retry`, async (request) => {
    const runId = parseIdParam(request.params, 'runId');
    const stepId = parseIdParam(request.params, 'stepId');
    const current = await requireRunDetail(deps, runId);

    const step = current.steps.find((item) => item.id === stepId);
    if (!step) {
      throw new ApiError(
        API_ERROR_CODES.WORKFLOW_STEP_NOT_FOUND,
        '目标步骤不存在或不属于该批量任务。',
      );
    }
    if (current.status !== 'paused' && current.status !== 'failed') {
      throw new ApiError(
        API_ERROR_CODES.WORKFLOW_INVALID_STATE,
        `批次当前状态为「${current.status}」，仅已暂停 / 已失败批次可重试单步。`,
      );
    }
    if (step.status !== 'failed') {
      throw new ApiError(
        API_ERROR_CODES.WORKFLOW_INVALID_STATE,
        `步骤当前状态为「${step.status}」，仅失败步骤可重试。`,
      );
    }

    await requireRoleModels(
      deps,
      requiredWorkflowRoles(current.mode, {
        enableCritic: current.config.enableCritic,
        enableSummary: current.config.enableSummary,
      }),
    );

    const detail = await deps.workflowRuns.retryStep(runId, stepId);
    if (!detail) {
      throw new ApiError(
        API_ERROR_CODES.WORKFLOW_INVALID_STATE,
        '步骤状态已变化，请刷新后重试。',
      );
    }

    await enqueueRun(deps, runId);
    await publishRunEvent(deps, request, detail, 'workflow.queued');

    return toDetailDto(detail);
  });

  /* ------------------------------ 删除批次 ------------------------------ */
  app.delete(`${base}/runs/:runId`, async (request, reply) => {
    const runId = parseIdParam(request.params, 'runId');
    const current = await deps.workflowRuns.findDetailById(runId);
    if (!current) {
      throw new ApiError(API_ERROR_CODES.WORKFLOW_RUN_NOT_FOUND, '批量任务不存在或已被删除。');
    }
    if (!isWorkflowTerminalStatus(current.status)) {
      throw new ApiError(
        API_ERROR_CODES.WORKFLOW_RUN_ACTIVE,
        `批次当前状态为「${current.status}」，请先取消后再删除。`,
      );
    }

    await deps.workflowRuns.delete(runId);
    return reply.status(204).send();
  });

  /* ------------------------------ SSE 事件流 ------------------------------ */
  app.get(`${base}/events`, async (request, reply) => {
    await handleWorkflowSse(request, reply, deps);
  });
}

/* -------------------------------------------------------------------------- */
/*                             SSE 实时进度转发                                */
/* -------------------------------------------------------------------------- */

/**
 * `GET /api/v1/workflows/events` SSE 端点：
 * - 握手帧 `event: ready`
 * - 转发 Redis `workflowEvents` 频道的批次 / 步骤事件（`event: workflow-event`）
 * - 周期心跳 `event: ping` 防止代理断开
 * - 客户端断开时自动退订并清理定时器
 * - 可选 `?runId=` 仅透传该批次事件
 */
async function handleWorkflowSse(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: ServerDependencies,
): Promise<void> {
  const runIdFilter = parseOptionalUuidQuery(
    (request.query as Record<string, unknown> | undefined)?.['runId'],
    'runId',
  );

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
    formatSseFrame(WORKFLOW_SSE_EVENT_NAMES.ready, {
      timestamp: new Date().toISOString(),
      channel: REDIS_CHANNELS.workflowEvents,
      runId: runIdFilter ?? null,
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

  const bus: WorkflowEventBus = deps.workflowEventBus;

  try {
    const unsub = await bus.subscribe((event) => {
      if (runIdFilter !== undefined && event.runId !== runIdFilter) {
        return;
      }
      safeWrite(formatSseFrame(WORKFLOW_SSE_EVENT_NAMES.workflowEvent, event));
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
            ? `批量流水线事件订阅失败：${error.message}`
            : '批量流水线事件订阅失败，请检查 Redis 状态。',
        timestamp: new Date().toISOString(),
      }),
    );
    await cleanup();
    res.end();
    return;
  }

  heartbeat = setInterval(() => {
    safeWrite(
      formatSseFrame(WORKFLOW_SSE_EVENT_NAMES.ping, {
        timestamp: new Date().toISOString(),
      }),
    );
  }, heartbeatMs);
  heartbeat.unref?.();
}
