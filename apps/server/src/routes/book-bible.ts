import {
  API_ERROR_CODES,
  USAGE_SCENES,
  bookOutlineDtoSchema,
  chapterSummaryDtoSchema,
  createKnowledgeCardSchema,
  extractChapterSummaryResponseSchema,
  extractChapterSummarySchema,
  knowledgeCardDtoSchema,
  knowledgeCardListQuerySchema,
  knowledgeCardListResponseSchema,
  updateKnowledgeCardSchema,
  upsertBookOutlineSchema,
  upsertChapterSummarySchema,
} from '@fanxiaoshuo/shared';
import {
  buildSummaryExtractPrompts,
  parseExtractedSummary,
  type UsageLogger,
} from '@fanxiaoshuo/agents';
import type { FastifyInstance } from 'fastify';
import { ApiError } from '../errors.js';
import {
  toBookOutlineDto,
  toChapterSummaryDto,
  toKnowledgeCardDto,
} from '../mapping/dto.js';
import type {
  KnowledgeCardRecord,
  UpdateKnowledgeCardRecordPatch,
} from '../repositories/types.js';
import { resolveRoleModel } from '../services/model-resolver.js';
import type { ServerDependencies } from '../server-deps.js';
import { requireActiveBookAggregate, requireActiveChapter } from './book-helpers.js';
import { parseIdParam, parseOrThrow, toGatewayApiError } from './helpers.js';

function knowledgeCardNotFound(): ApiError {
  return new ApiError(
    API_ERROR_CODES.KNOWLEDGE_CARD_NOT_FOUND,
    '设定卡不存在或不属于该书籍。',
  );
}

/** 读取设定卡并校验归属（跨书 / 不存在统一 404，不泄露其他书籍卡片是否存在）。 */
async function requireCardOfBook(
  deps: ServerDependencies,
  bookId: string,
  cardId: string,
): Promise<KnowledgeCardRecord> {
  const card = await deps.knowledgeCards.findById(cardId);
  if (!card || card.bookId !== bookId) {
    throw knowledgeCardNotFound();
  }
  return card;
}

/**
 * `/api/v1/books/:bookId/*` 与 `/api/v1/chapters/:chapterId/summary*` 路由：
 * 全书总大纲、6 类设定卡 CRUD/筛选、章节细纲与摘要读写、以及 `lorekeeper` 摘要提取。
 */
export function registerBookBibleRoutes(app: FastifyInstance, deps: ServerDependencies): void {
  const booksBase = '/api/v1/books';
  const chaptersBase = '/api/v1/chapters';

  /* ------------------------------------------------------------------ */
  /*                            全书总大纲                               */
  /* ------------------------------------------------------------------ */

  app.get(`${booksBase}/:bookId/outline`, async (request) => {
    const bookId = parseIdParam(request.params, 'bookId');
    await requireActiveBookAggregate(deps, bookId);

    const record = await deps.bookOutlines.findByBookId(bookId);
    if (!record) {
      return bookOutlineDtoSchema.parse({
        bookId,
        mainPlot: '',
        worldSetting: '',
        styleGuide: '',
        endingPlan: '',
        updatedAt: null,
      });
    }
    return bookOutlineDtoSchema.parse(toBookOutlineDto(record));
  });

  app.put(`${booksBase}/:bookId/outline`, async (request) => {
    const bookId = parseIdParam(request.params, 'bookId');
    const input = parseOrThrow(upsertBookOutlineSchema, request.body ?? {});
    await requireActiveBookAggregate(deps, bookId);

    const saved = await deps.bookOutlines.upsert({
      bookId,
      mainPlot: input.mainPlot,
      worldSetting: input.worldSetting,
      styleGuide: input.styleGuide,
      endingPlan: input.endingPlan,
    });

    return bookOutlineDtoSchema.parse(toBookOutlineDto(saved));
  });

  /* ------------------------------------------------------------------ */
  /*                              设定卡                                 */
  /* ------------------------------------------------------------------ */

  app.get(`${booksBase}/:bookId/cards`, async (request) => {
    const bookId = parseIdParam(request.params, 'bookId');
    const query = parseOrThrow(knowledgeCardListQuerySchema, request.query ?? {});
    await requireActiveBookAggregate(deps, bookId);

    const records = await deps.knowledgeCards.listByBook(bookId, query);
    const items = records.map(toKnowledgeCardDto);
    return knowledgeCardListResponseSchema.parse({ items, total: items.length });
  });

  app.post(`${booksBase}/:bookId/cards`, async (request, reply) => {
    const bookId = parseIdParam(request.params, 'bookId');
    const input = parseOrThrow(createKnowledgeCardSchema, request.body);
    await requireActiveBookAggregate(deps, bookId);

    const created = await deps.knowledgeCards.create({
      bookId,
      category: input.category,
      title: input.title,
      summary: input.summary,
      content: input.content,
      aliases: input.aliases,
      tags: input.tags,
      pinned: input.pinned,
    });

    return reply.status(201).send(knowledgeCardDtoSchema.parse(toKnowledgeCardDto(created)));
  });

  app.get(`${booksBase}/:bookId/cards/:cardId`, async (request) => {
    const bookId = parseIdParam(request.params, 'bookId');
    const cardId = parseIdParam(request.params, 'cardId');
    await requireActiveBookAggregate(deps, bookId);

    const card = await requireCardOfBook(deps, bookId, cardId);
    return knowledgeCardDtoSchema.parse(toKnowledgeCardDto(card));
  });

  app.patch(`${booksBase}/:bookId/cards/:cardId`, async (request) => {
    const bookId = parseIdParam(request.params, 'bookId');
    const cardId = parseIdParam(request.params, 'cardId');
    const input = parseOrThrow(updateKnowledgeCardSchema, request.body);
    await requireActiveBookAggregate(deps, bookId);
    await requireCardOfBook(deps, bookId, cardId);

    const patch: UpdateKnowledgeCardRecordPatch = {
      ...(input.category === undefined ? {} : { category: input.category }),
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.summary === undefined ? {} : { summary: input.summary }),
      ...(input.content === undefined ? {} : { content: input.content }),
      ...(input.aliases === undefined ? {} : { aliases: input.aliases }),
      ...(input.tags === undefined ? {} : { tags: input.tags }),
      ...(input.pinned === undefined ? {} : { pinned: input.pinned }),
      ...(input.sortOrder === undefined ? {} : { sortOrder: input.sortOrder }),
    };

    const updated = await deps.knowledgeCards.update(cardId, patch);
    if (!updated) {
      throw knowledgeCardNotFound();
    }
    return knowledgeCardDtoSchema.parse(toKnowledgeCardDto(updated));
  });

  app.delete(`${booksBase}/:bookId/cards/:cardId`, async (request, reply) => {
    const bookId = parseIdParam(request.params, 'bookId');
    const cardId = parseIdParam(request.params, 'cardId');
    await requireActiveBookAggregate(deps, bookId);
    await requireCardOfBook(deps, bookId, cardId);

    await deps.knowledgeCards.delete(cardId);
    return reply.status(204).send();
  });

  /* ------------------------------------------------------------------ */
  /*                        章节细纲与剧情摘要                           */
  /* ------------------------------------------------------------------ */

  app.get(`${chaptersBase}/:chapterId/summary`, async (request) => {
    const chapterId = parseIdParam(request.params, 'chapterId');
    const chapter = await requireActiveChapter(deps, chapterId);

    const record = await deps.chapterSummaries.findByChapterId(chapterId);
    if (!record) {
      return chapterSummaryDtoSchema.parse({
        chapterId,
        bookId: chapter.bookId,
        outline: '',
        summary: '',
        keyEvents: [],
        charactersPresent: [],
        source: 'manual',
        updatedAt: null,
      });
    }
    return chapterSummaryDtoSchema.parse(toChapterSummaryDto(record));
  });

  app.put(`${chaptersBase}/:chapterId/summary`, async (request) => {
    const chapterId = parseIdParam(request.params, 'chapterId');
    const input = parseOrThrow(upsertChapterSummarySchema, request.body);
    const chapter = await requireActiveChapter(deps, chapterId);
    const existing = await deps.chapterSummaries.findByChapterId(chapterId);

    // 手工保存：未传字段保留原值，来源强制为 `manual`。
    const saved = await deps.chapterSummaries.upsert({
      chapterId,
      bookId: chapter.bookId,
      outline: input.outline ?? existing?.outline ?? '',
      summary: input.summary ?? existing?.summary ?? '',
      keyEvents: input.keyEvents ?? existing?.keyEvents ?? [],
      charactersPresent: input.charactersPresent ?? existing?.charactersPresent ?? [],
      source: 'manual',
    });

    return chapterSummaryDtoSchema.parse(toChapterSummaryDto(saved));
  });

  app.post(`${chaptersBase}/:chapterId/summary/extract`, async (request) => {
    const chapterId = parseIdParam(request.params, 'chapterId');
    const input = parseOrThrow(extractChapterSummarySchema, request.body ?? {});
    const chapter = await requireActiveChapter(deps, chapterId);
    const book = await requireActiveBookAggregate(deps, chapter.bookId);

    if (chapter.contentText.trim().length === 0) {
      throw new ApiError(
        API_ERROR_CODES.AI_EMPTY_CONTEXT,
        '当前章节正文为空，无法提炼剧情摘要：请先写入正文后再重试。',
      );
    }

    // 角色解析（未绑定 / 供应商停用 / 模型停用）在调用上游之前给出结构化错误。
    const resolved = await resolveRoleModel(deps, 'lorekeeper');

    const existing = await deps.chapterSummaries.findByChapterId(chapterId);
    const prompts = buildSummaryExtractPrompts({
      bookTitle: book.book.title,
      chapterTitle: chapter.title,
      contentText: chapter.contentText,
      ...(existing?.outline ? { existingOutline: existing.outline } : {}),
      ...(input.instruction ? { instruction: input.instruction } : {}),
    });

    let usageLogId: string | null = null;
    const usageLogger: UsageLogger = async (record): Promise<void> => {
      const inserted = await deps.usageLogs.insert(record);
      usageLogId = inserted.id;
    };

    let result;
    try {
      result = await deps.gateway.generateText({
        config: resolved.config,
        role: 'lorekeeper',
        scene: USAGE_SCENES.loreExtract,
        system: prompts.system,
        prompt: prompts.prompt,
        temperature: input.temperature ?? resolved.temperature,
        maxOutputTokens: resolved.maxTokens ?? undefined,
        usageLogger,
      });
    } catch (error) {
      throw toGatewayApiError(error, [resolved.config.apiKey]);
    }

    const parsed = parseExtractedSummary(result.text);
    // 提炼只更新摘要类字段，原有本章细纲必须保留。
    const outline = existing?.outline ?? '';

    const usage = {
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      estimatedCostUsd: result.estimatedCostUsd,
      latencyMs: result.latencyMs,
    };

    if (input.save !== false) {
      const saved = await deps.chapterSummaries.upsert({
        chapterId,
        bookId: chapter.bookId,
        outline,
        summary: parsed.summary,
        keyEvents: parsed.keyEvents,
        charactersPresent: parsed.charactersPresent,
        source: 'ai',
      });

      return extractChapterSummaryResponseSchema.parse({
        summary: toChapterSummaryDto(saved),
        usage,
        modelRef: result.modelRef,
        usageLogId,
      });
    }

    // 仅预览不落盘：保留原有细纲与更新时间。
    const preview = chapterSummaryDtoSchema.parse({
      chapterId,
      bookId: chapter.bookId,
      outline,
      summary: parsed.summary,
      keyEvents: parsed.keyEvents,
      charactersPresent: parsed.charactersPresent,
      source: 'ai',
      updatedAt: existing?.updatedAt?.toISOString() ?? null,
    });

    return extractChapterSummaryResponseSchema.parse({
      summary: preview,
      usage,
      modelRef: result.modelRef,
      usageLogId,
    });
  });
}
