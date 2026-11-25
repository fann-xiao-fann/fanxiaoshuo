import {
  API_ERROR_CODES,
  MAX_BOOK_OUTLINE_FIELD_LENGTH,
  MAX_CARD_TITLE_LENGTH,
  TOOLBOX_TOOL_DEFINITIONS,
  applyToolboxCardRequestSchema,
  applyToolboxOutlineRequestSchema,
  bookOutlineDtoSchema,
  getToolboxToolDefinition,
  isToolboxToolId,
  knowledgeCardDtoSchema,
  runToolboxRequestSchema,
  toolboxRunDetailSchema,
  toolboxRunListQuerySchema,
  toolboxRunListResponseSchema,
  toolboxToolsResponseSchema,
  validateToolboxInputs,
  type AgentRole,
  type ToolboxResultItem,
  type ToolboxRunDetail,
} from '@fanxiaoshuo/shared';
import { ToolboxInputError, buildModelRef, runToolboxTool, type ToolboxBookContext } from '@fanxiaoshuo/agents';
import type { FastifyInstance } from 'fastify';
import { ApiError } from '../errors.js';
import {
  toBookOutlineDto,
  toKnowledgeCardDto,
  toToolboxRunDetailDto,
  toToolboxRunSummaryDto,
} from '../mapping/dto.js';
import type {
  BookAggregateRecord,
  BookOutlineRecord,
  ToolboxRunRecord,
} from '../repositories/types.js';
import { resolveRoleModel } from '../services/model-resolver.js';
import type { ServerDependencies } from '../server-deps.js';
import { requireActiveBookAggregate } from './book-helpers.js';
import { parseIdParam, parseOrThrow, toGatewayApiError } from './helpers.js';

/**
 * `/api/v1/toolbox/*` 创作工具盒路由（Change 5）。
 *
 * 契约唯一真相来源：`packages/shared/src/schemas/toolbox.ts` +
 * `packages/shared/src/constants/toolbox.ts`（工具目录 / 动态表单 / 输入校验）。
 *
 * 执行纪律（严格顺序，任何一步失败都不写脏历史、不消耗 Token）：
 * 1. 未知 `toolId` → `404 TOOLBOX_TOOL_NOT_FOUND`；
 * 2. 请求体结构 → `400 VALIDATION_ERROR`；
 * 3. `validateToolboxInputs` 字段级校验 → `400 VALIDATION_ERROR`（携带 `details`）；
 * 4. 关联书籍必须活跃存在 → `404 BOOK_NOT_FOUND`；
 * 5. 写书角色必须已绑定可用模型 → `409 AGENT_ROLE_UNBOUND` / `PROVIDER_DISABLED` / `MODEL_DISABLED`；
 * 6. 经 `deps.gateway`（`runToolboxTool`）发起**一次**生成，成功落 `completed`、失败落脱敏 `failed` 留痕。
 */

/** 错误摘要长度上限（与 `toolboxRunSummarySchema.errorMessage` 对齐）。 */
const MAX_ERROR_MESSAGE_LENGTH = 2_000;

/** 取出请求体中可能存在的 `toolId`（用于在结构校验之前区分 404 与 400）。 */
function readToolIdCandidate(body: unknown): string | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return null;
  }
  const value = (body as Record<string, unknown>)['toolId'];
  return typeof value === 'string' ? value.trim() : null;
}

function toolNotFound(toolId: string): ApiError {
  return new ApiError(
    API_ERROR_CODES.TOOLBOX_TOOL_NOT_FOUND,
    `未知的创作工具：${toolId.slice(0, 64)}，请从工具目录中重新选择。`,
  );
}

function runNotFound(): ApiError {
  return new ApiError(API_ERROR_CODES.TOOLBOX_RUN_NOT_FOUND, '工具运行记录不存在或已被删除。');
}

function itemOutOfRange(): ApiError {
  return new ApiError(
    API_ERROR_CODES.TOOLBOX_ITEM_OUT_OF_RANGE,
    '该运行记录没有可回写的结果条目：请确认运行已成功，且条目序号在有效范围内。',
  );
}

/** 读取运行记录，不存在抛 404。 */
async function requireRun(deps: ServerDependencies, runId: string): Promise<ToolboxRunRecord> {
  const run = await deps.toolboxRuns.findById(runId);
  if (!run) {
    throw runNotFound();
  }
  return run;
}

/**
 * 选取可回写的结构化条目。
 *
 * `failed` 运行（无产出）与越界 `itemIndex` 统一返回 `400 TOOLBOX_ITEM_OUT_OF_RANGE`，
 * 与 spec 场景「条目索引越界或运行未成功时拒绝回写」完全一致。
 */
function selectApplyItem(run: ToolboxRunRecord, itemIndex: number): ToolboxResultItem {
  if (run.status !== 'completed' || run.output === null) {
    throw itemOutOfRange();
  }
  const item = run.output.items[itemIndex];
  if (!item) {
    throw itemOutOfRange();
  }
  return item;
}

/** 组装关联作品上下文（总大纲 + 核心设定卡；裁剪与置顶优先由 `packages/agents` 负责）。 */
async function buildBookContext(
  deps: ServerDependencies,
  aggregate: BookAggregateRecord,
): Promise<ToolboxBookContext> {
  const bookId = aggregate.book.id;
  const [outline, cards] = await Promise.all([
    deps.bookOutlines.findByBookId(bookId),
    deps.knowledgeCards.listByBook(bookId, {}),
  ]);

  const genre = aggregate.book.genre.trim();
  const synopsis = aggregate.book.synopsis.trim();

  return {
    title: aggregate.book.title,
    ...(genre.length === 0 ? {} : { genre }),
    ...(synopsis.length === 0 ? {} : { synopsis }),
    outline: outline
      ? {
          mainPlot: outline.mainPlot,
          worldSetting: outline.worldSetting,
          styleGuide: outline.styleGuide,
          endingPlan: outline.endingPlan,
        }
      : null,
    cards: cards.map((card) => ({
      category: card.category,
      title: card.title,
      summary: card.summary,
      content: card.content,
      pinned: card.pinned,
    })),
  };
}

/** 把结果条目渲染为可写入全书大纲的文本块（标题 + 摘要 + 正文 + 标签）。 */
export function renderOutlineSnippet(item: ToolboxResultItem): string {
  const lines: string[] = [`【${item.title}】`];
  const summary = item.summary.trim();
  const content = item.content.trim();
  if (summary.length > 0) {
    lines.push(summary);
  }
  if (content.length > 0) {
    lines.push('', content);
  }
  if (item.tags.length > 0) {
    lines.push('', `标签：${item.tags.join('、')}`);
  }
  return lines.join('\n').trim();
}

/** 缺失大纲时按 4 字段空串起算（与 `GET /books/:bookId/outline` 的空默认结构一致）。 */
function emptyOutline(bookId: string, now: Date): BookOutlineRecord {
  return {
    bookId,
    mainPlot: '',
    worldSetting: '',
    styleGuide: '',
    endingPlan: '',
    updatedAt: now,
  };
}

/** 写入大纲字段：`append` 以空行拼接保留原内容，`replace` 直接覆盖，均做上限安全截断。 */
function applyOutlineField(
  current: string,
  snippet: string,
  mode: 'append' | 'replace',
): string {
  const trimmed = current.trim();
  const next = mode === 'replace' || trimmed.length === 0 ? snippet : `${current}\n\n${snippet}`;
  return next.length > MAX_BOOK_OUTLINE_FIELD_LENGTH
    ? next.slice(0, MAX_BOOK_OUTLINE_FIELD_LENGTH)
    : next;
}

export function registerToolboxRoutes(app: FastifyInstance, deps: ServerDependencies): void {
  const base = '/api/v1/toolbox';

  /* ------------------------------------------------------------------ */
  /*                            工具目录                                 */
  /* ------------------------------------------------------------------ */

  app.get(`${base}/tools`, async () => {
    return toolboxToolsResponseSchema.parse({ tools: TOOLBOX_TOOL_DEFINITIONS });
  });

  /* ------------------------------------------------------------------ */
  /*                            运行历史                                 */
  /* ------------------------------------------------------------------ */

  app.get(`${base}/runs`, async (request) => {
    const query = parseOrThrow(toolboxRunListQuerySchema, request.query ?? {});
    const page = await deps.toolboxRuns.list(query);

    return toolboxRunListResponseSchema.parse({
      items: page.items.map(toToolboxRunSummaryDto),
      total: page.total,
      page: query.page,
      pageSize: query.pageSize,
    });
  });

  app.get(`${base}/runs/:runId`, async (request) => {
    const runId = parseIdParam(request.params, 'runId');
    const run = await requireRun(deps, runId);
    return toolboxRunDetailSchema.parse(toToolboxRunDetailDto(run));
  });

  app.delete(`${base}/runs/:runId`, async (request, reply) => {
    const runId = parseIdParam(request.params, 'runId');
    await requireRun(deps, runId);

    // 仅删除历史记录：已回写到 Book Bible 的设定卡 / 总大纲不受影响。
    await deps.toolboxRuns.delete(runId);
    return reply.status(204).send();
  });

  /* ------------------------------------------------------------------ */
  /*                            同步执行                                 */
  /* ------------------------------------------------------------------ */

  app.post(`${base}/runs`, async (request, reply) => {
    // 1. 未知工具优先返回 404（早于结构校验，避免用户拿到一组无意义的字段错误）。
    const candidate = readToolIdCandidate(request.body);
    if (candidate !== null && candidate.length > 0 && !isToolboxToolId(candidate)) {
      throw toolNotFound(candidate);
    }

    // 2. 请求体结构校验。
    const input = parseOrThrow(runToolboxRequestSchema, request.body);

    // 3. 动态表单字段级校验（失败不落库、不扣费）。
    const definition = getToolboxToolDefinition(input.toolId);
    if (!definition) {
      throw toolNotFound(input.toolId);
    }
    const validation = validateToolboxInputs(input.toolId, input.inputs);
    if (!validation.ok) {
      const first = validation.issues[0];
      throw new ApiError(
        API_ERROR_CODES.VALIDATION_ERROR,
        first
          ? `创作工具输入校验失败：${first.path ? `${first.path} - ` : ''}${first.message}`
          : '创作工具输入校验失败',
        { details: validation.issues },
      );
    }

    // 4. 关联书籍必须活跃存在（软删 / 不存在统一 404）。
    const bookId = input.bookId ?? null;
    const aggregate = bookId === null ? null : await requireActiveBookAggregate(deps, bookId);

    // 5. 目标角色必须已绑定可用模型（未绑定 / 停用均在落库之前拒绝）。
    const role: AgentRole = input.role ?? definition.defaultRole;
    const resolved = await resolveRoleModel(deps, role);

    // 6. 可选 Book Bible 上下文注入。
    const bookContext = aggregate === null ? null : await buildBookContext(deps, aggregate);

    const startedAt = Date.now();

    try {
      const result = await runToolboxTool(deps.gateway, {
        toolId: input.toolId,
        role,
        inputs: validation.data,
        config: resolved.config,
        bookContext,
        temperature: resolved.temperature,
        maxOutputTokens: resolved.maxTokens,
      });

      const created = await deps.toolboxRuns.create({
        toolId: input.toolId,
        bookId,
        role,
        status: 'completed',
        inputs: validation.data,
        output: result.output,
        modelRef: result.modelRef,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        estimatedCostUsd: result.estimatedCostUsd,
        latencyMs: result.latencyMs,
        errorCode: null,
        errorMessage: null,
      });

      const detail: ToolboxRunDetail = toToolboxRunDetailDto(created);
      return reply.status(201).send(toolboxRunDetailSchema.parse(detail));
    } catch (error) {
      // 输入二次校验失败（边界防御）：不落库，直接返回 400。
      if (error instanceof ToolboxInputError) {
        throw new ApiError(API_ERROR_CODES.VALIDATION_ERROR, error.message, {
          details: error.issues,
          cause: error,
        });
      }

      // 上游模型失败：先归一化并脱敏，再写一条 `failed` 留痕记录，最后抛出规范错误响应。
      const apiError = toGatewayApiError(error, [resolved.config.apiKey]);

      try {
        await deps.toolboxRuns.create({
          toolId: input.toolId,
          bookId,
          role,
          status: 'failed',
          inputs: validation.data,
          output: null,
          modelRef: buildModelRef(resolved.config),
          inputTokens: 0,
          outputTokens: 0,
          estimatedCostUsd: 0,
          latencyMs: Math.max(0, Date.now() - startedAt),
          errorCode: apiError.code,
          errorMessage: apiError.message.slice(0, MAX_ERROR_MESSAGE_LENGTH),
        });
      } catch {
        // 留痕写入失败不得覆盖原始上游错误（否则排查方向被误导）。
        request.log.warn({ err: error }, '创作工具盒失败留痕写入失败');
      }

      throw apiError;
    }
  });

  /* ------------------------------------------------------------------ */
  /*                          一键回写 Book Bible                         */
  /* ------------------------------------------------------------------ */

  app.post(`${base}/runs/:runId/apply-card`, async (request, reply) => {
    const runId = parseIdParam(request.params, 'runId');
    const input = parseOrThrow(applyToolboxCardRequestSchema, request.body ?? {});

    const run = await requireRun(deps, runId);
    const item = selectApplyItem(run, input.itemIndex);
    await requireActiveBookAggregate(deps, input.bookId);

    // 标题对齐设定卡契约上限（100 字）：超长工具结果标题安全截断而非整条失败。
    const rawTitle = (input.title ?? item.title).trim();
    const title = rawTitle.slice(0, MAX_CARD_TITLE_LENGTH);

    const created = await deps.knowledgeCards.create({
      bookId: input.bookId,
      category: input.category ?? item.suggestedCardCategory,
      title,
      summary: item.summary,
      content: item.content,
      aliases: [...item.aliases],
      tags: [...item.tags],
      pinned: input.pinned ?? false,
    });

    return reply.status(201).send(knowledgeCardDtoSchema.parse(toKnowledgeCardDto(created)));
  });

  app.post(`${base}/runs/:runId/apply-outline`, async (request) => {
    const runId = parseIdParam(request.params, 'runId');
    const input = parseOrThrow(applyToolboxOutlineRequestSchema, request.body ?? {});

    const run = await requireRun(deps, runId);
    const item = selectApplyItem(run, input.itemIndex);
    await requireActiveBookAggregate(deps, input.bookId);

    const existing =
      (await deps.bookOutlines.findByBookId(input.bookId)) ??
      emptyOutline(input.bookId, deps.clock?.() ?? new Date());

    // 仅改写目标字段，其余 3 个大纲字段原样保留。
    const nextValue = applyOutlineField(
      existing[input.field],
      renderOutlineSnippet(item),
      input.mode,
    );

    const saved = await deps.bookOutlines.upsert({
      bookId: input.bookId,
      mainPlot: input.field === 'mainPlot' ? nextValue : existing.mainPlot,
      worldSetting: input.field === 'worldSetting' ? nextValue : existing.worldSetting,
      styleGuide: input.field === 'styleGuide' ? nextValue : existing.styleGuide,
      endingPlan: input.field === 'endingPlan' ? nextValue : existing.endingPlan,
    });

    return bookOutlineDtoSchema.parse(toBookOutlineDto(saved));
  });
}
