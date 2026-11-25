import {
  AI_STREAM_EVENT_NAMES,
  aiContextPreviewResponseSchema,
  aiStreamDeltaEventSchema,
  aiStreamDoneEventSchema,
  aiStreamErrorEventSchema,
  aiStreamStartEventSchema,
  applyAiChapterContentResponseSchema,
  bookOutlineDtoSchema,
  chapterSummaryDtoSchema,
  extractChapterSummaryResponseSchema,
  knowledgeCardDtoSchema,
  knowledgeCardListQuerySchema,
  knowledgeCardListResponseSchema,
  type AiChapterStreamRequestPayload,
  type AiContextPreviewRequestPayload,
  type AiContextPreviewResponse,
  type AiStreamDeltaEvent,
  type AiStreamDoneEvent,
  type AiStreamErrorEvent,
  type AiStreamStartEvent,
  type AiUsageSummary,
  type ApplyAiChapterContentInputPayload,
  type ApplyAiChapterContentResponse,
  type BookOutlineDto,
  type ChapterSummaryDto,
  type CreateKnowledgeCardInputPayload,
  type ExtractChapterSummaryInputPayload,
  type ExtractChapterSummaryResponse,
  type KnowledgeCardDto,
  type KnowledgeCardListQueryPayload,
  type KnowledgeCardListResponse,
  type UpdateKnowledgeCardInputPayload,
  type UpsertBookOutlineInputPayload,
  type UpsertChapterSummaryInputPayload,
} from '@fanxiaoshuo/shared';
import type { ZodType } from 'zod';
import { invalidResponseError } from './errors';
import { apiRequest, apiRequestVoid } from './http';
import { streamSsePost, type SseStreamOptions } from './sse-client';

/**
 * Book Bible（作品设定记忆层）与章内 AI 写作的 REST / SSE 客户端。
 *
 * 所有请求体与响应体 100% 使用 `@fanxiaoshuo/shared` 的 Zod 契约解析，
 * 视图层只接触 DTO 类型；4 种 SSE 帧同样逐帧校验，杜绝前后端字段漂移。
 */

function bookPath(bookId: string): string {
  return `/books/${encodeURIComponent(bookId)}`;
}

function cardPath(bookId: string, cardId: string): string {
  return `${bookPath(bookId)}/cards/${encodeURIComponent(cardId)}`;
}

function chapterPath(chapterId: string): string {
  return `/chapters/${encodeURIComponent(chapterId)}`;
}

/* -------------------------------------------------------------------------- */
/*                                  全书总大纲                                 */
/* -------------------------------------------------------------------------- */

export function getOutline(bookId: string, options: { signal?: AbortSignal } = {}): Promise<BookOutlineDto> {
  return apiRequest(`${bookPath(bookId)}/outline`, bookOutlineDtoSchema, {
    signal: options.signal,
  });
}

export function saveOutline(
  bookId: string,
  payload: UpsertBookOutlineInputPayload,
): Promise<BookOutlineDto> {
  return apiRequest(`${bookPath(bookId)}/outline`, bookOutlineDtoSchema, {
    method: 'PUT',
    body: payload,
  });
}

/* -------------------------------------------------------------------------- */
/*                                  设定卡                                     */
/* -------------------------------------------------------------------------- */

export function listCards(
  bookId: string,
  query: KnowledgeCardListQueryPayload = {},
  options: { signal?: AbortSignal } = {},
): Promise<KnowledgeCardListResponse> {
  // 共享 Schema 的 `preprocess` 会把查询入参转为 `unknown`，
  // 这里先按契约归一化，确保交给 URL 序列化的是纯量值。
  const normalized = knowledgeCardListQuerySchema.parse(query);
  return apiRequest(`${bookPath(bookId)}/cards`, knowledgeCardListResponseSchema, {
    signal: options.signal,
    query: {
      category: normalized.category,
      q: normalized.q,
      pinned: normalized.pinned,
    },
  });
}

export function createCard(
  bookId: string,
  payload: CreateKnowledgeCardInputPayload,
): Promise<KnowledgeCardDto> {
  return apiRequest(`${bookPath(bookId)}/cards`, knowledgeCardDtoSchema, {
    method: 'POST',
    body: payload,
  });
}

export function getCard(
  bookId: string,
  cardId: string,
  options: { signal?: AbortSignal } = {},
): Promise<KnowledgeCardDto> {
  return apiRequest(cardPath(bookId, cardId), knowledgeCardDtoSchema, {
    signal: options.signal,
  });
}

export function updateCard(
  bookId: string,
  cardId: string,
  payload: UpdateKnowledgeCardInputPayload,
): Promise<KnowledgeCardDto> {
  return apiRequest(cardPath(bookId, cardId), knowledgeCardDtoSchema, {
    method: 'PATCH',
    body: payload,
  });
}

export function deleteCard(bookId: string, cardId: string): Promise<void> {
  return apiRequestVoid(cardPath(bookId, cardId), { method: 'DELETE' });
}

/* -------------------------------------------------------------------------- */
/*                              章节细纲与摘要                                 */
/* -------------------------------------------------------------------------- */

export function getChapterSummary(
  chapterId: string,
  options: { signal?: AbortSignal } = {},
): Promise<ChapterSummaryDto> {
  return apiRequest(`${chapterPath(chapterId)}/summary`, chapterSummaryDtoSchema, {
    signal: options.signal,
  });
}

export function saveChapterSummary(
  chapterId: string,
  payload: UpsertChapterSummaryInputPayload,
): Promise<ChapterSummaryDto> {
  return apiRequest(`${chapterPath(chapterId)}/summary`, chapterSummaryDtoSchema, {
    method: 'PUT',
    body: payload,
  });
}

export function extractChapterSummary(
  chapterId: string,
  payload: ExtractChapterSummaryInputPayload = {},
): Promise<ExtractChapterSummaryResponse> {
  return apiRequest(
    `${chapterPath(chapterId)}/summary/extract`,
    extractChapterSummaryResponseSchema,
    { method: 'POST', body: payload },
  );
}

/* -------------------------------------------------------------------------- */
/*                            上下文预览与原子应用                              */
/* -------------------------------------------------------------------------- */

export function previewContext(
  chapterId: string,
  payload: AiContextPreviewRequestPayload,
): Promise<AiContextPreviewResponse> {
  return apiRequest(
    `${chapterPath(chapterId)}/ai/context-preview`,
    aiContextPreviewResponseSchema,
    { method: 'POST', body: payload },
  );
}

export function applyAiContent(
  chapterId: string,
  payload: ApplyAiChapterContentInputPayload,
): Promise<ApplyAiChapterContentResponse> {
  return apiRequest(
    `${chapterPath(chapterId)}/ai/apply`,
    applyAiChapterContentResponseSchema,
    { method: 'POST', body: payload },
  );
}

/* -------------------------------------------------------------------------- */
/*                              流式 AI 章节写作                                */
/* -------------------------------------------------------------------------- */

/** 4 种 SSE 帧的回调（未注册的事件名自动忽略）。 */
export interface ChapterAiStreamCallbacks {
  onStart?: (event: AiStreamStartEvent) => void;
  onDelta?: (event: AiStreamDeltaEvent) => void;
  onDone?: (event: AiStreamDoneEvent) => void;
  onError?: (event: AiStreamErrorEvent) => void;
}

function parseStreamFrame<T>(
  schema: ZodType<T>,
  dataText: string,
  eventName: string,
): T {
  let raw: unknown;
  try {
    raw = JSON.parse(dataText) as unknown;
  } catch (cause) {
    throw invalidResponseError(`SSE ${eventName} 帧不是合法 JSON`, cause);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw invalidResponseError(
      `SSE ${eventName} 帧不符合契约：${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ')}`,
      parsed.error,
    );
  }
  return parsed.data;
}

/**
 * `POST /chapters/:chapterId/ai/stream`：流式生成章节正文。
 *
 * 4 种帧（`start` / `delta` / `done` / `error`）分别用共享 Schema 严格校验后触发回调；
 * 非 2xx（如角色未绑定 409）由 `streamSsePost` 直接抛出 `ApiClientError`。
 */
export function streamChapterAi(
  chapterId: string,
  payload: AiChapterStreamRequestPayload,
  callbacks: ChapterAiStreamCallbacks = {},
  options: SseStreamOptions = {},
): Promise<void> {
  return streamSsePost(
    `${chapterPath(chapterId)}/ai/stream`,
    payload,
    {
      onEvent(eventName, dataText) {
        switch (eventName) {
          case AI_STREAM_EVENT_NAMES.start:
            callbacks.onStart?.(
              parseStreamFrame(aiStreamStartEventSchema, dataText, eventName),
            );
            break;
          case AI_STREAM_EVENT_NAMES.delta:
            callbacks.onDelta?.(
              parseStreamFrame(aiStreamDeltaEventSchema, dataText, eventName),
            );
            break;
          case AI_STREAM_EVENT_NAMES.done:
            callbacks.onDone?.(
              parseStreamFrame(aiStreamDoneEventSchema, dataText, eventName),
            );
            break;
          case AI_STREAM_EVENT_NAMES.error:
            callbacks.onError?.(
              parseStreamFrame(aiStreamErrorEventSchema, dataText, eventName),
            );
            break;
          default:
            // 未知帧名忽略，避免服务端新增非破坏性事件导致前端崩溃。
            break;
        }
      },
    },
    options,
  );
}

/* -------------------------------------------------------------------------- */
/*                                  聚合导出                                   */
/* -------------------------------------------------------------------------- */

/** 便于视图层按命名空间调用的聚合对象（与具名导出等价）。 */
export const bookBibleApi = {
  getOutline,
  saveOutline,
  listCards,
  createCard,
  getCard,
  updateCard,
  deleteCard,
  getChapterSummary,
  saveChapterSummary,
  extractChapterSummary,
  previewContext,
  applyAiContent,
  streamChapterAi,
};

/** 摘要提炼的用量反馈统一使用共享契约中的 `AiUsageSummary`。 */
export type { AiUsageSummary };
