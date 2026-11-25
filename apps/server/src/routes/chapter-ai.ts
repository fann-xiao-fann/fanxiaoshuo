import { randomUUID } from 'node:crypto';
import {
  AI_APPLY_MODE_LABELS,
  AI_STREAM_EVENT_NAMES,
  AI_WRITE_ACTION_LABELS,
  API_ERROR_CODES,
  USAGE_SCENES,
  aiChapterStreamRequestSchema,
  aiContextPreviewRequestSchema,
  aiContextPreviewResponseSchema,
  aiStreamDeltaEventSchema,
  aiStreamDoneEventSchema,
  aiStreamErrorEventSchema,
  aiStreamStartEventSchema,
  applyAiChapterContentResponseSchema,
  applyAiChapterContentSchema,
  countNovelWords,
  type AiChapterStreamRequest,
  type AiContextPreviewRequest,
  type AgentRole,
} from '@fanxiaoshuo/shared';
import {
  assembleChapterContext,
  sanitizeErrorMessage,
  toModelGatewayError,
  type AssembledChapterContext,
  type ContextKnowledgeCardInput,
  type ContextRecentSummaryInput,
  type GatewayStreamTextResult,
  type UsageLogRecordInput,
  type UsageLogger,
} from '@fanxiaoshuo/agents';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ApiError } from '../errors.js';
import { toChapterDetailDto, toRevisionSummary } from '../mapping/dto.js';
import type { ChapterMetaRecord, ChapterRecord } from '../repositories/types.js';
import { resolveRoleModel } from '../services/model-resolver.js';
import type { ServerDependencies } from '../server-deps.js';
import {
  chapterNotFound,
  requireActiveBookAggregate,
  requireActiveChapter,
} from './book-helpers.js';
import { parseIdParam, parseOrThrow } from './helpers.js';
import { formatSseFrame } from './runtime.js';

/* -------------------------------------------------------------------------- */
/*                            上下文组装（预览与流式共用）                      */
/* -------------------------------------------------------------------------- */

/** 按 `sortOrder` → `createdAt` 稳定排序（与目录树阅读顺序一致）。 */
function compareBySortOrder(a: ChapterMetaRecord, b: ChapterMetaRecord): number {
  return a.sortOrder - b.sortOrder || a.createdAt.getTime() - b.createdAt.getTime();
}

/**
 * 为指定章节组装写作上下文。
 *
 * 阅读序列：全书活跃分卷 `sortOrder` 升序（各卷内活跃章 `sortOrder` 升序），
 * 再接未分卷 / 已删分卷遗留的活跃章 `sortOrder` 升序。前情摘要按「旧 → 新」传给组装器，
 * 上一章尾部正文取自紧邻上一章的完整正文。
 */
async function assembleContextForChapter(
  deps: ServerDependencies,
  chapter: ChapterRecord,
  input: AiContextPreviewRequest | AiChapterStreamRequest,
): Promise<AssembledChapterContext> {
  const book = await requireActiveBookAggregate(deps, chapter.bookId);
  const outline = await deps.bookOutlines.findByBookId(chapter.bookId);
  const cardRecords = await deps.knowledgeCards.listByBook(chapter.bookId);
  const volumeAggregates = await deps.volumes.listByBook(chapter.bookId, 'active');
  const chapterMetas = await deps.chapters.listByBook(chapter.bookId, 'active');
  const summaries = await deps.chapterSummaries.listByBook(chapter.bookId);

  const activeVolumeIds = new Set(volumeAggregates.map((entry) => entry.volume.id));
  const ordered: ChapterMetaRecord[] = [];
  for (const volume of volumeAggregates) {
    const inVolume = chapterMetas
      .filter((meta) => meta.volumeId === volume.volume.id)
      .sort(compareBySortOrder);
    ordered.push(...inVolume);
  }
  ordered.push(
    ...chapterMetas
      .filter((meta) => meta.volumeId === null || !activeVolumeIds.has(meta.volumeId))
      .sort(compareBySortOrder),
  );

  const index = ordered.findIndex((meta) => meta.id === chapter.id);
  const cut = index < 0 ? ordered.length : index;
  const preceding = ordered.slice(0, cut);
  const summaryByChapter = new Map(summaries.map((summary) => [summary.chapterId, summary]));

  const recentSummaries: ContextRecentSummaryInput[] = [];
  for (const meta of preceding) {
    const summary = summaryByChapter.get(meta.id);
    if (!summary) {
      continue;
    }
    const keyEvents = summary.keyEvents.filter((event) => event.trim().length > 0);
    if (summary.summary.trim().length === 0 && keyEvents.length === 0) {
      continue;
    }
    recentSummaries.push({
      chapterTitle: meta.title,
      summary: summary.summary,
      keyEvents,
    });
  }

  let prevChapter: { title: string; contentText: string } | null = null;
  const prevMeta = cut > 0 ? ordered[cut - 1] : undefined;
  if (prevMeta) {
    const full = await deps.chapters.findById(prevMeta.id);
    if (full && full.deletedAt === null) {
      prevChapter = { title: full.title, contentText: full.contentText };
    }
  }

  const cards: ContextKnowledgeCardInput[] = cardRecords.map((card) => ({
    id: card.id,
    category: card.category,
    title: card.title,
    summary: card.summary,
    content: card.content,
    aliases: card.aliases,
    tags: card.tags,
    pinned: card.pinned,
    sortOrder: card.sortOrder,
    embedding: card.embedding,
  }));

  const currentSummary = summaryByChapter.get(chapter.id);
  const role: AgentRole | undefined = 'role' in input ? input.role : undefined;

  return assembleChapterContext({
    book: {
      title: book.book.title,
      genre: book.book.genre,
      synopsis: book.book.synopsis,
      targetChapterWords: book.book.targetChapterWords,
    },
    outline: outline
      ? {
          mainPlot: outline.mainPlot,
          worldSetting: outline.worldSetting,
          styleGuide: outline.styleGuide,
          endingPlan: outline.endingPlan,
        }
      : null,
    cards,
    recentSummaries,
    prevChapter,
    chapter: {
      title: chapter.title,
      contentText: input.currentContentText ?? chapter.contentText,
      outline: currentSummary?.outline ?? '',
    },
    options: {
      action: input.action,
      ...(role === undefined ? {} : { role }),
      instruction: input.instruction,
      ...(input.selectedText === undefined ? {} : { selectedText: input.selectedText }),
      ...(input.cardIds === undefined ? {} : { cardIds: input.cardIds }),
      includeOutline: input.includeOutline,
      includePrevChapterTail: input.includePrevChapterTail,
      maxRecentSummaries: input.maxRecentSummaries,
      maxContextTokens: input.maxContextTokens,
      ...(input.targetWords === undefined ? {} : { targetWords: input.targetWords }),
    },
  });
}

/* -------------------------------------------------------------------------- */
/*                                 SSE 流式写作                                */
/* -------------------------------------------------------------------------- */

/** 空内容校验：非 `continue` 动作既无选区也无正文时拒绝调用上游。 */
function assertWritableContext(
  action: string,
  selectedText: string | undefined,
  contentText: string,
): void {
  if (action === 'continue') {
    return;
  }
  if ((selectedText ?? '').trim().length === 0 && contentText.trim().length === 0) {
    throw new ApiError(
      API_ERROR_CODES.AI_EMPTY_CONTEXT,
      '当前没有可处理的正文：请先在编辑器中选择片段或写入正文后再试。',
    );
  }
}

/** 挂载 `/api/v1/chapters/:chapterId/ai/*`（上下文预览 / 流式写作 / 原子应用）。 */
export function registerChapterAiRoutes(app: FastifyInstance, deps: ServerDependencies): void {
  const chaptersBase = '/api/v1/chapters';

  app.post(`${chaptersBase}/:chapterId/ai/context-preview`, async (request) => {
    const chapterId = parseIdParam(request.params, 'chapterId');
    const input = parseOrThrow(aiContextPreviewRequestSchema, request.body);
    const chapter = await requireActiveChapter(deps, chapterId);

    const assembled = await assembleContextForChapter(deps, chapter, input);

    return aiContextPreviewResponseSchema.parse({
      estimatedTokens: assembled.estimatedTokens,
      maxContextTokens: assembled.maxContextTokens,
      truncated: assembled.truncated,
      sections: assembled.sections,
      selectedCards: assembled.selectedCards,
      recentSummariesCount: assembled.recentSummariesCount,
      prevChapterTitle: assembled.prevChapterTitle,
      systemPromptPreview: assembled.systemPromptPreview,
      userPromptPreview: assembled.userPromptPreview,
    });
  });

  app.post(`${chaptersBase}/:chapterId/ai/stream`, async (request, reply) => {
    const chapterId = parseIdParam(request.params, 'chapterId');
    const input = parseOrThrow(aiChapterStreamRequestSchema, request.body);
    const chapter = await requireActiveChapter(deps, chapterId);
    await requireActiveBookAggregate(deps, chapter.bookId);

    assertWritableContext(
      input.action,
      input.selectedText,
      input.currentContentText ?? chapter.contentText,
    );

    // 关键顺序：角色解析（未绑定 / 停用 / 解密失败）必须在 hijack 之前完成，
    // 保证这类失败以标准 JSON `ApiError` 返回，而不是半截 SSE 流。
    const resolved = await resolveRoleModel(deps, input.role);
    const assembled = await assembleContextForChapter(deps, chapter, input);

    await streamChapterWriting(deps, request, chapter, input, resolved, assembled, reply);
  });

  app.post(`${chaptersBase}/:chapterId/ai/apply`, async (request) => {
    const chapterId = parseIdParam(request.params, 'chapterId');
    const input = parseOrThrow(applyAiChapterContentSchema, request.body);
    await requireActiveChapter(deps, chapterId);

    // 字数由服务端独立重算，绝不信任客户端上报值。
    const wordCount = countNovelWords(input.contentText);
    const note =
      input.note !== undefined && input.note.length > 0
        ? input.note
        : `AI ${AI_WRITE_ACTION_LABELS[input.action]}（${AI_APPLY_MODE_LABELS[input.mode]}）前自动留底`;

    const outcome = await deps.chapters.applyAiContent({
      chapterId,
      expectedVersion: input.expectedVersion,
      contentText: input.contentText,
      ...(input.contentJson === undefined ? {} : { contentJson: input.contentJson }),
      wordCount,
      note,
    });

    if (outcome.status === 'not_found') {
      throw chapterNotFound();
    }

    if (outcome.status === 'conflict') {
      throw new ApiError(
        API_ERROR_CODES.CHAPTER_VERSION_CONFLICT,
        `章节已被其他窗口或后台任务更新（服务端当前 v${outcome.chapter.version}），请重新加载最新版本后再应用 AI 正文。`,
        {
          details: [
            {
              path: 'expectedVersion',
              message: `currentVersion=${outcome.chapter.version}`,
            },
          ],
        },
      );
    }

    return applyAiChapterContentResponseSchema.parse({
      chapter: toChapterDetailDto(outcome.chapter),
      backupRevision: toRevisionSummary(outcome.backupRevision),
    });
  });
}

/**
 * 建立 `text/event-stream` 并消费 `ModelGateway.streamText`。
 *
 * Node 22 防坑：POST 请求体读完时 `request.raw` 会立即触发 `'close'`，
 * 因此只在 `reply.raw`（响应）上监听 `close` 判断客户端断开，并辅以 `request.raw` 的 `'aborted'`。
 */
async function streamChapterWriting(
  deps: ServerDependencies,
  request: FastifyRequest,
  chapter: ChapterRecord,
  input: AiChapterStreamRequest,
  resolved: Awaited<ReturnType<typeof resolveRoleModel>>,
  assembled: AssembledChapterContext,
  reply: FastifyReply,
): Promise<void> {
  reply.hijack();
  const res = reply.raw;

  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const runId = randomUUID();
  const startedAt = Date.now();
  const abortController = new AbortController();

  let finished = false;
  let aborted = false;
  let usageLogId: string | null = null;
  let gatewayStream: GatewayStreamTextResult | null = null;
  /** 网关在 `onError` 中以 fire-and-forget 方式落盘失败日志；此处捕获其已脱敏的结果。 */
  let failureRecord: UsageLogRecordInput | null = null;
  let notifyFailure: (() => void) | null = null;
  const failureReady = new Promise<void>((resolve) => {
    notifyFailure = resolve;
  });

  const safeWrite = (frame: string): void => {
    if (finished || res.writableEnded) {
      return;
    }
    try {
      res.write(frame);
    } catch {
      finished = true;
    }
  };

  const abortStream = (): void => {
    if (finished || res.writableEnded) {
      return;
    }
    aborted = true;
    abortController.abort();
    gatewayStream?.close();
  };

  res.on('close', () => {
    if (!res.writableEnded && !finished) {
      abortStream();
    }
  });
  // Node 22 下 `request.raw` 读完 body 即触发 `'close'`，因此这里只监听 `'aborted'`。
  request.raw.on('aborted', abortStream);

  const usageLogger: UsageLogger = async (record): Promise<void> => {
    const inserted = await deps.usageLogs.insert(record);
    usageLogId = inserted.id;
    if (record.status === 'error') {
      failureRecord = record;
      notifyFailure?.();
    }
  };

  /** 等待失败日志落盘（正常路径已同步就绪，用超时兜底避免挂死 SSE）。 */
  const resolveFailureRecord = async (): Promise<UsageLogRecordInput | null> => {
    if (failureRecord !== null) {
      return failureRecord;
    }
    await Promise.race([
      failureReady,
      new Promise<void>((resolve) => {
        setTimeout(resolve, 1_500);
      }),
    ]);
    return failureRecord;
  };

  /** 用归一到用量日志的脱敏结果构造 `error` 帧内容（不使用未知上游文本）。 */
  const writeFailureFrame = (record: UsageLogRecordInput): void => {
    safeWrite(
      formatSseFrame(
        AI_STREAM_EVENT_NAMES.error,
        aiStreamErrorEventSchema.parse({
          runId,
          code: record.errorCode ?? API_ERROR_CODES.UPSTREAM_ERROR,
          message:
            record.errorMessage !== null && record.errorMessage.trim().length > 0
              ? record.errorMessage
              : '上游生成失败，请稍后重试。',
        }),
      ),
    );
  };

  try {
    safeWrite(
      formatSseFrame(
        AI_STREAM_EVENT_NAMES.start,
        aiStreamStartEventSchema.parse({
          runId,
          chapterId: chapter.id,
          action: input.action,
          role: input.role,
          modelRef: `${resolved.config.providerName}/${resolved.config.modelId}`,
          estimatedContextTokens: assembled.estimatedTokens,
          truncated: assembled.truncated,
          includedCardIds: assembled.selectedCards.map((card) => card.id),
        }),
      ),
    );

    const maxOutputTokens = input.maxOutputTokens ?? resolved.maxTokens ?? undefined;
    gatewayStream = deps.gateway.streamText({
      config: resolved.config,
      role: input.role,
      scene: USAGE_SCENES.chapterWrite,
      system: assembled.systemPrompt,
      prompt: assembled.userPrompt,
      temperature: input.temperature ?? resolved.temperature,
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
      abortSignal: abortController.signal,
      usageLogger,
    });

    // 客户端提前中止时不会再 await 这两个 Promise，提前挂载兜底 catch 避免未处理拒绝。
    gatewayStream.usage.catch(() => undefined);
    gatewayStream.finishReason.catch(() => undefined);

    let fullText = '';
    for await (const delta of gatewayStream.textStream) {
      if (aborted) {
        break;
      }
      fullText += delta;
      safeWrite(
        formatSseFrame(
          AI_STREAM_EVENT_NAMES.delta,
          aiStreamDeltaEventSchema.parse({ runId, text: delta }),
        ),
      );
    }

    if (!aborted) {
      const [usage, finishReason] = await Promise.all([
        gatewayStream.usage,
        gatewayStream.finishReason,
      ]);

      // 等待用量期间客户端可能已断开：此时不再补发任何终态帧。
      if (aborted) {
        return;
      }

      if (finishReason === 'error') {
        // 上游在流中途失败：`textStream` 不报错，但 `finishReason` 为 `error`，
        // 此时绝不能推送 `done` 帧把空文本当成成功结果。
        const record = await resolveFailureRecord();
        if (record !== null) {
          writeFailureFrame(record);
        } else {
          const gatewayError = toModelGatewayError(
            new Error('上游流式生成失败，请稍后重试。'),
            [resolved.config.apiKey],
          );
          safeWrite(
            formatSseFrame(
              AI_STREAM_EVENT_NAMES.error,
              aiStreamErrorEventSchema.parse({
                runId,
                code: gatewayError.code,
                message: sanitizeErrorMessage(gatewayError, [resolved.config.apiKey]),
              }),
            ),
          );
        }
        return;
      }

      safeWrite(
        formatSseFrame(
          AI_STREAM_EVENT_NAMES.done,
          aiStreamDoneEventSchema.parse({
            runId,
            fullText,
            finishReason,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            estimatedCostUsd: usage.estimatedCostUsd,
            latencyMs: Math.max(0, Date.now() - startedAt),
            modelRef: gatewayStream.modelRef,
            usageLogId,
          }),
        ),
      );
    }
  } catch (error) {
    if (!aborted) {
      // 上游失败优先使用网关已归一的用量日志（错误码更准确、且已脱敏）。
      const record = await resolveFailureRecord();
      if (record !== null) {
        writeFailureFrame(record);
        return;
      }
      const gatewayError = toModelGatewayError(error, [resolved.config.apiKey]);
      safeWrite(
        formatSseFrame(
          AI_STREAM_EVENT_NAMES.error,
          aiStreamErrorEventSchema.parse({
            runId,
            code: gatewayError.code,
            message: sanitizeErrorMessage(gatewayError, [resolved.config.apiKey]),
          }),
        ),
      );
    }
  } finally {
    finished = true;
    gatewayStream?.close();
    if (!res.writableEnded) {
      res.end();
    }
  }
}
