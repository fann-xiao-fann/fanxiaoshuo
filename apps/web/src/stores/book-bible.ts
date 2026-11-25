import {
  type AiApplyMode,
  type AiChapterStreamRequestPayload,
  type AiContextPreviewRequestPayload,
  type AiContextPreviewResponse,
  type AiStreamDoneEvent,
  type AiStreamStartEvent,
  type AiUsageSummary,
  type AiWriteAction,
  type BookOutlineDto,
  type ChapterSummaryDto,
  type CreateKnowledgeCardInputPayload,
  type ExtractChapterSummaryInputPayload,
  type KnowledgeCardCategory,
  type KnowledgeCardDto,
  type TiptapJson,
  type UpdateKnowledgeCardInputPayload,
  type UpsertBookOutlineInputPayload,
  type UpsertChapterSummaryInputPayload,
} from '@fanxiaoshuo/shared';
import { defineStore } from 'pinia';
import {
  applyAiContent,
  createCard as apiCreateCard,
  deleteCard as apiDeleteCard,
  extractChapterSummary as apiExtractChapterSummary,
  getChapterSummary as apiGetChapterSummary,
  getOutline as apiGetOutline,
  listCards as apiListCards,
  previewContext as apiPreviewContext,
  saveChapterSummary as apiSaveChapterSummary,
  saveOutline as apiSaveOutline,
  streamChapterAi,
  updateCard as apiUpdateCard,
} from '@/api/book-bible';
import {
  describeError,
  extractConflictVersion,
  isApiClientError,
  isChapterVersionConflict,
  type FrontendErrorCode,
} from '@/api/errors';
import { isAbortError } from '@/api/sse-client';
import { useBookWorkspaceStore } from '@/stores/book-workspace';

/** AI 写作流状态机。 */
export type AiStreamStatus = 'idle' | 'streaming' | 'done' | 'error' | 'aborted';

/** 编辑器当前选区（`from` / `to` 为 ProseMirror 文档位置）。 */
export interface EditorSelectionSnapshot {
  text: string;
  from: number;
  to: number;
}

/** 应用 AI 生成内容时的选项（正文由调用方按模式合并后传入）。 */
export interface ApplyStreamResultOptions {
  mode: AiApplyMode;
  contentText: string;
  contentJson?: TiptapJson | null;
  note?: string;
}

interface BookBibleState {
  /* 总大纲 */
  outline: BookOutlineDto | null;
  outlineLoading: boolean;
  outlineSaving: boolean;
  outlineError: string | null;

  /* 设定卡 */
  cards: KnowledgeCardDto[];
  cardsLoading: boolean;
  cardsError: string | null;
  cardsBookId: string | null;
  categoryFilter: KnowledgeCardCategory | null;
  searchQuery: string;
  pinnedOnly: boolean;

  /* 本章记忆 */
  chapterSummary: ChapterSummaryDto | null;
  summaryLoading: boolean;
  summarySaving: boolean;
  summaryExtracting: boolean;
  summaryError: string | null;
  summaryErrorCode: FrontendErrorCode | null;
  lastExtractUsage: AiUsageSummary | null;

  /* 编辑器选区 */
  selection: EditorSelectionSnapshot | null;

  /* AI 写作 */
  selectedCardIds: string[];
  contextPreview: AiContextPreviewResponse | null;
  contextPreviewLoading: boolean;
  contextPreviewError: string | null;
  streamStatus: AiStreamStatus;
  streamAction: AiWriteAction;
  streamText: string;
  streamStart: AiStreamStartEvent | null;
  streamDone: AiStreamDoneEvent | null;
  streamErrorCode: FrontendErrorCode | null;
  streamErrorMessage: string | null;

  /* 原子应用 */
  applying: boolean;
  applyError: string | null;
}

/** 模块级流控制器与递增令牌：仅允许最新一次生成写回状态。 */
let streamController: AbortController | null = null;
let streamToken = 0;

export const useBookBibleStore = defineStore('fx-book-bible', {
  state: (): BookBibleState => ({
    outline: null,
    outlineLoading: false,
    outlineSaving: false,
    outlineError: null,

    cards: [],
    cardsLoading: false,
    cardsError: null,
    cardsBookId: null,
    categoryFilter: null,
    searchQuery: '',
    pinnedOnly: false,

    chapterSummary: null,
    summaryLoading: false,
    summarySaving: false,
    summaryExtracting: false,
    summaryError: null,
    summaryErrorCode: null,
    lastExtractUsage: null,

    selection: null,

    selectedCardIds: [],
    contextPreview: null,
    contextPreviewLoading: false,
    contextPreviewError: null,
    streamStatus: 'idle',
    streamAction: 'continue',
    streamText: '',
    streamStart: null,
    streamDone: null,
    streamErrorCode: null,
    streamErrorMessage: null,

    applying: false,
    applyError: null,
  }),

  getters: {
    /** 当前筛选条件下的设定卡数量（用于面板计数）。 */
    cardCount(state): number {
      return state.cards.length;
    },
    /** 是否处于生成中（按钮禁用与停止按钮切换）。 */
    isStreaming(state): boolean {
      return state.streamStatus === 'streaming';
    },
    /** 生成结果是否有可应用正文。 */
    hasStreamText(state): boolean {
      return state.streamText.trim().length > 0;
    },
  },

  actions: {
    /* ------------------------------------------------------------------ */
    /*                              生命周期                               */
    /* ------------------------------------------------------------------ */

    /** 中止当前进行中的流（不清空已收到的预览文本）。 */
    abortActiveStream(): void {
      streamToken += 1;
      if (streamController !== null) {
        streamController.abort();
        streamController = null;
      }
    },

    /** 整店重置（切换书籍 / 离开工作区）。 */
    reset(): void {
      this.abortActiveStream();
      this.$reset();
    },

    /** 切换章节：中止流并清空本章摘要、上下文预览、选区与生成结果。 */
    resetForChapter(): void {
      this.abortActiveStream();
      this.chapterSummary = null;
      this.summaryLoading = false;
      this.summarySaving = false;
      this.summaryExtracting = false;
      this.summaryError = null;
      this.summaryErrorCode = null;
      this.lastExtractUsage = null;
      this.selection = null;
      this.contextPreview = null;
      this.contextPreviewLoading = false;
      this.contextPreviewError = null;
      this.clearStreamResult();
      this.applyError = null;
    },

    /* ------------------------------------------------------------------ */
    /*                              全书总大纲                             */
    /* ------------------------------------------------------------------ */

    async loadOutline(bookId: string): Promise<void> {
      this.outlineLoading = true;
      this.outlineError = null;
      try {
        this.outline = await apiGetOutline(bookId);
      } catch (error) {
        this.outlineError = describeError(error);
      } finally {
        this.outlineLoading = false;
      }
    },

    async saveOutline(
      bookId: string,
      payload: UpsertBookOutlineInputPayload,
    ): Promise<BookOutlineDto | null> {
      this.outlineSaving = true;
      this.outlineError = null;
      try {
        const saved = await apiSaveOutline(bookId, payload);
        this.outline = saved;
        return saved;
      } catch (error) {
        this.outlineError = describeError(error);
        throw error;
      } finally {
        this.outlineSaving = false;
      }
    },

    /* ------------------------------------------------------------------ */
    /*                                设定卡                               */
    /* ------------------------------------------------------------------ */

    /** 书籍级数据并行加载（总大纲 + 设定卡），单条失败不阻断另一条。 */
    async loadBookBible(bookId: string): Promise<void> {
      await Promise.allSettled([this.loadOutline(bookId), this.loadCards(bookId)]);
    },

    async loadCards(bookId: string): Promise<void> {
      this.cardsLoading = true;
      this.cardsError = null;
      try {
        const response = await apiListCards(bookId, {
          category: this.categoryFilter ?? undefined,
          q: this.searchQuery.trim().length > 0 ? this.searchQuery.trim() : undefined,
          pinned: this.pinnedOnly ? true : undefined,
        });
        this.cards = response.items;
        this.cardsBookId = bookId;
      } catch (error) {
        this.cardsError = describeError(error);
      } finally {
        this.cardsLoading = false;
      }
    },

    async createCard(
      bookId: string,
      payload: CreateKnowledgeCardInputPayload,
    ): Promise<KnowledgeCardDto> {
      const created = await apiCreateCard(bookId, payload);
      const matchesFilter =
        (this.categoryFilter === null || created.category === this.categoryFilter) &&
        (!this.pinnedOnly || created.pinned);
      if (matchesFilter) {
        this.cards = [...this.cards, created];
      }
      return created;
    },

    async updateCard(
      bookId: string,
      cardId: string,
      payload: UpdateKnowledgeCardInputPayload,
    ): Promise<KnowledgeCardDto> {
      const updated = await apiUpdateCard(bookId, cardId, payload);
      const stillMatches =
        (this.categoryFilter === null || updated.category === this.categoryFilter) &&
        (!this.pinnedOnly || updated.pinned);
      this.cards = stillMatches
        ? this.cards.map((card) => (card.id === updated.id ? updated : card))
        : this.cards.filter((card) => card.id !== updated.id);
      return updated;
    },

    async toggleCardPinned(bookId: string, cardId: string): Promise<void> {
      const card = this.cards.find((item) => item.id === cardId);
      if (card === undefined) {
        return;
      }
      await this.updateCard(bookId, cardId, { pinned: !card.pinned });
    },

    async deleteCard(bookId: string, cardId: string): Promise<void> {
      await apiDeleteCard(bookId, cardId);
      this.cards = this.cards.filter((card) => card.id !== cardId);
      this.selectedCardIds = this.selectedCardIds.filter((id) => id !== cardId);
    },

    /** 手动勾选 / 取消勾选参与本轮上下文组装的设定卡。 */
    toggleSelectedCard(cardId: string): void {
      this.selectedCardIds = this.selectedCardIds.includes(cardId)
        ? this.selectedCardIds.filter((id) => id !== cardId)
        : [...this.selectedCardIds, cardId];
    },

    clearSelectedCards(): void {
      this.selectedCardIds = [];
    },

    /* ------------------------------------------------------------------ */
    /*                             本章记忆                               */
    /* ------------------------------------------------------------------ */

    async loadChapterSummary(chapterId: string): Promise<void> {
      this.summaryLoading = true;
      this.summaryError = null;
      this.summaryErrorCode = null;
      try {
        this.chapterSummary = await apiGetChapterSummary(chapterId);
        this.lastExtractUsage = null;
      } catch (error) {
        this.summaryError = describeError(error);
        this.summaryErrorCode = isApiClientError(error) ? error.code : 'NETWORK_ERROR';
      } finally {
        this.summaryLoading = false;
      }
    },

    async saveChapterSummary(
      chapterId: string,
      payload: UpsertChapterSummaryInputPayload,
    ): Promise<ChapterSummaryDto | null> {
      this.summarySaving = true;
      this.summaryError = null;
      this.summaryErrorCode = null;
      try {
        const saved = await apiSaveChapterSummary(chapterId, payload);
        this.chapterSummary = saved;
        return saved;
      } catch (error) {
        this.summaryError = describeError(error);
        this.summaryErrorCode = isApiClientError(error) ? error.code : 'NETWORK_ERROR';
        throw error;
      } finally {
        this.summarySaving = false;
      }
    },

    /**
     * `lorekeeper` 一键提炼本章摘要。
     * 角色未绑定 / 模型停用 / 空正文等错误码保留在 `summaryErrorCode`，
     * 由「本章记忆」面板给出针对性引导（跳转 `/models` 等）。
     */
    async extractChapterSummary(
      chapterId: string,
      payload: ExtractChapterSummaryInputPayload = {},
    ): Promise<AiUsageSummary | null> {
      this.summaryExtracting = true;
      this.summaryError = null;
      this.summaryErrorCode = null;
      try {
        const response = await apiExtractChapterSummary(chapterId, payload);
        this.chapterSummary = response.summary;
        this.lastExtractUsage = response.usage;
        return response.usage;
      } catch (error) {
        this.summaryError = describeError(error);
        this.summaryErrorCode = isApiClientError(error) ? error.code : 'NETWORK_ERROR';
        return null;
      } finally {
        this.summaryExtracting = false;
      }
    },

    /* ------------------------------------------------------------------ */
    /*                              编辑器选区                             */
    /* ------------------------------------------------------------------ */

    setSelection(selection: EditorSelectionSnapshot): void {
      if (selection.text.trim().length === 0) {
        this.selection = null;
        return;
      }
      this.selection = selection;
    },

    clearSelection(): void {
      this.selection = null;
    },

    /* ------------------------------------------------------------------ */
    /*                            上下文预览                               */
    /* ------------------------------------------------------------------ */

    async previewContext(
      chapterId: string,
      payload: AiContextPreviewRequestPayload,
    ): Promise<AiContextPreviewResponse | null> {
      this.contextPreviewLoading = true;
      this.contextPreviewError = null;
      try {
        const preview = await apiPreviewContext(chapterId, payload);
        this.contextPreview = preview;
        return preview;
      } catch (error) {
        this.contextPreview = null;
        this.contextPreviewError = describeError(error);
        return null;
      } finally {
        this.contextPreviewLoading = false;
      }
    },

    /* ------------------------------------------------------------------ */
    /*                            流式 AI 写作                             */
    /* ------------------------------------------------------------------ */

    clearStreamResult(): void {
      this.streamStatus = 'idle';
      this.streamText = '';
      this.streamStart = null;
      this.streamDone = null;
      this.streamErrorCode = null;
      this.streamErrorMessage = null;
    },

    /**
     * 发起流式生成：先中止旧流，再创建新 `AbortController`。
     *
     * 所有回调都带令牌校验，旧流即使有迟到帧也不会污染新一轮结果；
     * 中止时保留已收到的部分正文，方便用户继续预览或手动拼装。
     */
    async startStream(
      chapterId: string,
      payload: AiChapterStreamRequestPayload,
    ): Promise<void> {
      this.abortActiveStream();
      const token = streamToken;
      const controller = new AbortController();
      streamController = controller;

      this.streamStatus = 'streaming';
      this.streamAction = payload.action ?? 'continue';
      this.streamText = '';
      this.streamStart = null;
      this.streamDone = null;
      this.streamErrorCode = null;
      this.streamErrorMessage = null;
      this.applyError = null;

      const isCurrent = (): boolean => token === streamToken;

      try {
        await streamChapterAi(
          chapterId,
          { ...payload, role: payload.role ?? 'writer' },
          {
            onStart: (event) => {
              if (!isCurrent()) {
                return;
              }
              this.streamStart = event;
              this.streamAction = event.action;
            },
            onDelta: (event) => {
              if (!isCurrent()) {
                return;
              }
              this.streamText += event.text;
            },
            onDone: (event) => {
              if (!isCurrent()) {
                return;
              }
              this.streamDone = event;
              if (event.fullText.length > 0) {
                this.streamText = event.fullText;
              }
              this.streamStatus = 'done';
            },
            onError: (event) => {
              if (!isCurrent()) {
                return;
              }
              this.streamStatus = 'error';
              this.streamErrorCode = event.code;
              this.streamErrorMessage = event.message;
            },
          },
          { signal: controller.signal },
        );
        if (isCurrent() && this.streamStatus === 'streaming') {
          this.streamStatus = 'done';
        }
      } catch (error) {
        if (!isCurrent()) {
          return;
        }
        if (isAbortError(error)) {
          // 主动中止：保留 streamText 已收到的增量。
          this.streamStatus = 'aborted';
          return;
        }
        this.streamStatus = 'error';
        if (isApiClientError(error)) {
          this.streamErrorCode = error.code;
          this.streamErrorMessage = error.message;
        } else {
          this.streamErrorCode = 'NETWORK_ERROR';
          this.streamErrorMessage = describeError(error);
        }
      } finally {
        if (isCurrent() && streamController === controller) {
          streamController = null;
        }
      }
    },

    /** 立即中止生成并保留已收到的预览文本。 */
    stopStream(): void {
      if (this.streamStatus === 'streaming') {
        this.streamStatus = 'aborted';
      }
      streamToken += 1;
      if (streamController !== null) {
        streamController.abort();
        streamController = null;
      }
    },

    /* ------------------------------------------------------------------ */
    /*                            原子应用正文                             */
    /* ------------------------------------------------------------------ */

    /**
     * 原子应用 AI 生成正文。
     *
     * 安全网：
     * 1. 应用前先冲刷本地脏草稿，避免覆盖用户尚未落盘的编辑；
     * 2. 以冲刷后的最新 `version` 作为 `expectedVersion` 提交；
     * 3. 命中 409 时复用既有版本冲突弹窗（`workspace.saveStatus = 'conflict'`）。
     */
    async applyStreamResult(options: ApplyStreamResultOptions): Promise<boolean> {
      const workspace = useBookWorkspaceStore();
      const initialChapter = workspace.currentChapter;
      if (initialChapter === null) {
        this.applyError = '当前没有打开的章节，无法应用生成内容';
        return false;
      }

      this.applying = true;
      this.applyError = null;
      try {
        if (workspace.isDirty) {
          const flushed = await workspace.saveContent();
          if (!flushed) {
            this.applyError =
              workspace.saveError ?? '本地草稿保存失败，已中止应用以避免覆盖未落盘的编辑';
            return false;
          }
        }

        const current = workspace.currentChapter;
        if (current === null) {
          this.applyError = '当前章节已被关闭，无法应用生成内容';
          return false;
        }

        const response = await applyAiContent(current.id, {
          expectedVersion: current.version,
          action: this.streamAction,
          mode: options.mode,
          contentText: options.contentText,
          contentJson: options.contentJson ?? null,
          ...(options.note !== undefined ? { note: options.note } : {}),
        });

        workspace.applyLoadedChapter(response.chapter);
        this.clearSelection();
        this.applyError = null;

        // 目录树同步最新字数 / 版本号；失败不影响正文已落盘的事实。
        if (workspace.bookId !== null) {
          try {
            await workspace.loadTree(workspace.bookId);
          } catch {
            /* 目录树刷新失败：正文与版本已在本地收敛，下次进入工作区会重新拉取 */
          }
        }
        return true;
      } catch (error) {
        if (isChapterVersionConflict(error)) {
          workspace.saveStatus = 'conflict';
          workspace.conflictCurrentVersion = extractConflictVersion(error);
          workspace.saveError = describeError(error);
          this.applyError = describeError(error);
          return false;
        }
        this.applyError = describeError(error);
        return false;
      } finally {
        this.applying = false;
      }
    },
  },
});
