import {
  countNovelWords,
  DEFAULT_TARGET_CHAPTER_WORDS,
  type BookDto,
  type BookTrashResponse,
  type ChapterDetailDto,
  type ChapterRevisionDetail,
  type ChapterRevisionSummary,
  type ChapterStatus,
  type ChapterTreeItem,
  type CreateChapterInputPayload,
  type CreateVolumeInputPayload,
  type SaveChapterContentInputPayload,
  type TiptapJson,
  type UpdateChapterMetaInputPayload,
  type UpdateVolumeInputPayload,
  type VolumeTreeNode,
} from '@fanxiaoshuo/shared';
import { defineStore } from 'pinia';
import { booksApi, chaptersApi, volumesApi } from '@/api/books';
import {
  describeError,
  extractConflictVersion,
  isChapterVersionConflict,
} from '@/api/errors';
import { resolveEditorContent } from '@/utils/editor-content';

/** 防抖自动保存窗口：停止输入 1.5s 后落盘。 */
export const AUTOSAVE_DEBOUNCE_MS = 1_500;

/** 编辑器保存状态机（工具栏徽章与沉浸条共用）。 */
export type ChapterSaveStatus = 'idle' | 'dirty' | 'saving' | 'saved' | 'error' | 'conflict';

export interface WorkspaceDraft {
  title: string;
  contentText: string;
  contentJson: TiptapJson | null;
}

export interface OpenChapterOptions {
  /** 默认先冲刷当前未保存改动；`false` 表示放弃本地草稿直接切换。 */
  flush?: boolean;
}

export interface ChapterMoveTarget {
  volumeId: string | null;
}

/** 模块级自动保存计时器与并发保护（同一时刻只允许一个工作区实例存在）。 */
let autoSaveTimer: ReturnType<typeof setTimeout> | null = null;
let saveInFlight: Promise<boolean> | null = null;

function clearAutoSaveTimer(): void {
  if (autoSaveTimer !== null) {
    clearTimeout(autoSaveTimer);
    autoSaveTimer = null;
  }
}

function containsChapter(volumes: VolumeTreeNode[], chapterId: string): boolean {
  return volumes.some((volume) => volume.chapters.some((chapter) => chapter.id === chapterId));
}

interface WorkspaceState {
  bookId: string | null;
  book: BookDto | null;
  volumes: VolumeTreeNode[];
  ungroupedChapters: ChapterTreeItem[];
  trashCount: number;
  treeLoading: boolean;
  treeError: string | null;

  currentChapterId: string | null;
  currentChapter: ChapterDetailDto | null;
  chapterLoading: boolean;
  chapterError: string | null;
  /** 每次从服务端加载 / 回滚正文时递增，编辑器据此强制同步内容（不影响用户正在输入）。 */
  editorSyncToken: number;

  draftTitle: string;
  draftContentText: string;
  draftContentJson: TiptapJson | null;
  draftWordCount: number;

  isDirty: boolean;
  saveStatus: ChapterSaveStatus;
  saveError: string | null;
  lastSavedAt: string | null;
  conflictCurrentVersion: number | null;

  revisions: ChapterRevisionSummary[];
  revisionsLoading: boolean;
  revisionsError: string | null;
  revisionPreview: ChapterRevisionDetail | null;
  revisionPreviewLoading: boolean;
  restoringRevisionId: string | null;

  trash: BookTrashResponse;
  trashLoading: boolean;
  trashError: string | null;

  immersive: boolean;
}

const emptyTrash: BookTrashResponse = { volumes: [], chapters: [] };

export const useBookWorkspaceStore = defineStore('fx-book-workspace', {
  state: (): WorkspaceState => ({
    bookId: null,
    book: null,
    volumes: [],
    ungroupedChapters: [],
    trashCount: 0,
    treeLoading: false,
    treeError: null,

    currentChapterId: null,
    currentChapter: null,
    chapterLoading: false,
    chapterError: null,
    editorSyncToken: 0,

    draftTitle: '',
    draftContentText: '',
    draftContentJson: null,
    draftWordCount: 0,

    isDirty: false,
    saveStatus: 'idle',
    saveError: null,
    lastSavedAt: null,
    conflictCurrentVersion: null,

    revisions: [],
    revisionsLoading: false,
    revisionsError: null,
    revisionPreview: null,
    revisionPreviewLoading: false,
    restoringRevisionId: null,

    trash: emptyTrash,
    trashLoading: false,
    trashError: null,

    immersive: false,
  }),

  getters: {
    /** 单章目标字数（用于编辑器字数进度）。 */
    targetChapterWords(state): number {
      return state.book?.targetChapterWords ?? DEFAULT_TARGET_CHAPTER_WORDS;
    },
    /** 全书章数（分卷 + 未分卷）。 */
    totalChapterCount(state): number {
      const grouped = state.volumes.reduce((sum, volume) => sum + volume.chapters.length, 0);
      return grouped + state.ungroupedChapters.length;
    },
    /** 全书字数（按目录树聚合，保存后即时增量同步）。 */
    totalWordCount(state): number {
      if (state.book !== null) {
        return state.book.totalWordCount;
      }
      const grouped = state.volumes.reduce((sum, volume) => sum + volume.totalWordCount, 0);
      return grouped + state.ungroupedChapters.reduce((sum, chapter) => sum + chapter.wordCount, 0);
    },
    /** 是否仍有未落盘改动（离开页面守卫据此拦截）。 */
    hasUnsavedChanges(state): boolean {
      return state.isDirty || state.saveStatus === 'saving';
    },
    /** 扁平章节顺序（供「上一章 / 下一章」与空态定位）。 */
    flatChapters(state): ChapterTreeItem[] {
      const grouped = state.volumes.flatMap((volume) => volume.chapters);
      return [...grouped, ...state.ungroupedChapters];
    },
    volumeOptions(state): Array<{ label: string; value: string }> {
      return state.volumes.map((volume) => ({ label: volume.title, value: volume.id }));
    },
  },

  actions: {
    /* ------------------------------ 目录树 ------------------------------ */

    async loadTree(bookId: string): Promise<void> {
      this.bookId = bookId;
      this.treeLoading = true;
      this.treeError = null;
      try {
        const response = await booksApi.tree(bookId);
        this.book = response.book;
        this.volumes = response.volumes;
        this.ungroupedChapters = response.ungroupedChapters;
        this.trashCount = response.trashCount;
        this.pruneMissingChapter();
      } catch (error) {
        this.treeError = describeError(error);
        throw error;
      } finally {
        this.treeLoading = false;
      }
    },

    /** 当前打开的章节被删除 / 永久清理后重置编辑器状态。 */
    pruneMissingChapter(): void {
      if (this.currentChapterId === null) {
        return;
      }
      const exists =
        containsChapter(this.volumes, this.currentChapterId) ||
        this.ungroupedChapters.some((chapter) => chapter.id === this.currentChapterId);
      if (!exists) {
        this.clearChapter();
      }
    },

    findChapter(chapterId: string): ChapterTreeItem | undefined {
      return this.flatChapters.find((chapter) => chapter.id === chapterId);
    },

    /** 定位章节所在的兄弟列表（分卷或未分卷区）。 */
    chapterSiblings(chapterId: string): { volumeId: string | null; chapters: ChapterTreeItem[] } | null {
      const volume = this.volumes.find((item) =>
        item.chapters.some((chapter) => chapter.id === chapterId),
      );
      if (volume !== undefined) {
        return { volumeId: volume.id, chapters: volume.chapters };
      }
      if (this.ungroupedChapters.some((chapter) => chapter.id === chapterId)) {
        return { volumeId: null, chapters: this.ungroupedChapters };
      }
      return null;
    },

    reset(): void {
      clearAutoSaveTimer();
      saveInFlight = null;
      this.$reset();
    },

    /* ------------------------------ 章节加载 ------------------------------ */

    clearChapter(): void {
      clearAutoSaveTimer();
      this.editorSyncToken += 1;
      this.currentChapterId = null;
      this.currentChapter = null;
      this.chapterError = null;
      this.draftTitle = '';
      this.draftContentText = '';
      this.draftContentJson = null;
      this.draftWordCount = 0;
      this.isDirty = false;
      this.saveStatus = 'idle';
      this.saveError = null;
      this.lastSavedAt = null;
      this.conflictCurrentVersion = null;
      this.revisions = [];
      this.revisionsError = null;
      this.revisionPreview = null;
    },

    applyLoadedChapter(chapter: ChapterDetailDto): void {
      this.editorSyncToken += 1;
      this.currentChapter = chapter;
      this.currentChapterId = chapter.id;
      this.chapterError = null;
      this.draftTitle = chapter.title;
      this.draftContentText = chapter.contentText;
      this.draftContentJson = resolveEditorContent(chapter);
      this.draftWordCount = countNovelWords(chapter.contentText);
      this.isDirty = false;
      this.saveStatus = 'idle';
      this.saveError = null;
      this.lastSavedAt = chapter.updatedAt;
      this.conflictCurrentVersion = null;
    },

    /**
     * 打开章节并加载正文。
     * 默认先冲刷当前草稿；返回 `false` 表示「旧草稿未能保存」（冲突 / 网络错误），
     * 由调用方决定是否放弃本地改动强制切换。
     */
    async openChapter(chapterId: string, options: OpenChapterOptions = {}): Promise<boolean> {
      if (this.currentChapterId === chapterId && this.currentChapter !== null) {
        return true;
      }
      if (options.flush !== false && this.isDirty) {
        const saved = await this.saveContent();
        if (!saved) {
          return false;
        }
      }
      clearAutoSaveTimer();
      this.chapterLoading = true;
      this.chapterError = null;
      try {
        const chapter = await chaptersApi.get(chapterId);
        this.applyLoadedChapter(chapter);
        return true;
      } catch (error) {
        this.chapterError = describeError(error);
        throw error;
      } finally {
        this.chapterLoading = false;
      }
    },

    /** 重新加载当前章节最新版本（冲突弹窗「重新加载」出口）。 */
    async reloadCurrentChapter(): Promise<void> {
      const chapterId = this.currentChapterId;
      if (chapterId === null) {
        return;
      }
      clearAutoSaveTimer();
      this.chapterLoading = true;
      try {
        const chapter = await chaptersApi.get(chapterId);
        this.applyLoadedChapter(chapter);
      } catch (error) {
        this.chapterError = describeError(error);
        throw error;
      } finally {
        this.chapterLoading = false;
      }
    },

    /* ------------------------------ 编辑与保存 ------------------------------ */

    /** 编辑器内容变更：更新草稿、字数并排队防抖自动保存。 */
    setDraft(draft: Partial<WorkspaceDraft>): void {
      if (this.currentChapter === null) {
        return;
      }
      if (typeof draft.title === 'string') {
        this.draftTitle = draft.title;
      }
      if (typeof draft.contentText === 'string') {
        this.draftContentText = draft.contentText;
        this.draftWordCount = countNovelWords(draft.contentText);
      }
      if (draft.contentJson !== undefined) {
        this.draftContentJson = draft.contentJson;
      }

      const changedFromSaved =
        this.draftTitle !== this.currentChapter.title ||
        this.draftContentText !== this.currentChapter.contentText;

      this.isDirty = changedFromSaved;
      if (!changedFromSaved) {
        this.saveStatus = this.saveStatus === 'saving' ? 'saving' : 'idle';
        clearAutoSaveTimer();
        return;
      }
      this.saveStatus = 'dirty';
      this.saveError = null;
      this.scheduleAutoSave();
    },

    scheduleAutoSave(delayMs: number = AUTOSAVE_DEBOUNCE_MS): void {
      if (this.currentChapterId === null) {
        return;
      }
      clearAutoSaveTimer();
      autoSaveTimer = setTimeout(() => {
        autoSaveTimer = null;
        void this.saveContent();
      }, delayMs);
    },

    cancelAutoSave(): void {
      clearAutoSaveTimer();
    },

    /**
     * 保存当前章节正文。
     * @returns `true` 保存成功；`false` 失败（`saveStatus` / `saveError` 已反映原因）。
     */
    async saveContent(options: { forceOverwrite?: boolean } = {}): Promise<boolean> {
      if (saveInFlight !== null) {
        return saveInFlight;
      }
      const chapterId = this.currentChapterId;
      const chapter = this.currentChapter;
      if (chapterId === null || chapter === null) {
        return true;
      }
      clearAutoSaveTimer();

      const snapshot: WorkspaceDraft = {
        title: this.draftTitle,
        contentText: this.draftContentText,
        contentJson: this.draftContentJson,
      };
      const payload: SaveChapterContentInputPayload = {
        title: snapshot.title,
        contentText: snapshot.contentText,
        contentJson: snapshot.contentJson,
        expectedVersion: chapter.version,
        forceOverwrite: options.forceOverwrite === true,
      };

      this.saveStatus = 'saving';
      this.saveError = null;

      saveInFlight = (async (): Promise<boolean> => {
        try {
          const response = await chaptersApi.saveContent(chapterId, payload);
          this.applySavedChapter(response.chapter, snapshot);
          return true;
        } catch (error) {
          if (isChapterVersionConflict(error)) {
            this.saveStatus = 'conflict';
            this.conflictCurrentVersion = extractConflictVersion(error);
            this.saveError = describeError(error);
            return false;
          }
          this.saveStatus = 'error';
          this.saveError = describeError(error);
          return false;
        } finally {
          saveInFlight = null;
        }
      })();

      return saveInFlight;
    },

    /** 保存成功后的状态收敛：保留保存期间新输入的草稿，并同步目录树聚合字数。 */
    applySavedChapter(chapter: ChapterDetailDto, snapshot: WorkspaceDraft): void {
      const previous = this.findChapter(chapter.id);
      if (previous !== undefined) {
        const delta = chapter.wordCount - previous.wordCount;
        previous.wordCount = chapter.wordCount;
        previous.version = chapter.version;
        previous.title = chapter.title;
        previous.status = chapter.status;
        previous.updatedAt = chapter.updatedAt;
        if (delta !== 0 && previous.volumeId !== null) {
          const volume = this.volumes.find((item) => item.id === previous.volumeId);
          if (volume !== undefined) {
            volume.totalWordCount = Math.max(0, volume.totalWordCount + delta);
          }
        }
        if (delta !== 0 && this.book !== null) {
          this.book.totalWordCount = Math.max(0, this.book.totalWordCount + delta);
        }
      }
      if (this.book !== null) {
        this.book.updatedAt = chapter.updatedAt;
      }

      this.currentChapter = chapter;
      this.lastSavedAt = chapter.updatedAt;
      this.conflictCurrentVersion = null;
      this.saveError = null;

      const stillDirty =
        this.draftTitle !== snapshot.title || this.draftContentText !== snapshot.contentText;
      this.isDirty = stillDirty;
      if (stillDirty) {
        this.saveStatus = 'dirty';
        this.scheduleAutoSave();
      } else {
        this.saveStatus = 'saved';
      }
    },

    /** 冲突弹窗「保留当前内容并强制覆盖」：服务端会先自动留底快照再覆盖。 */
    async forceOverwrite(): Promise<boolean> {
      this.conflictCurrentVersion = null;
      return this.saveContent({ forceOverwrite: true });
    },

    /** 冲突弹窗「稍后再处理」：关闭弹窗但保留本地草稿。 */
    cancelConflict(): void {
      if (this.saveStatus !== 'conflict') {
        return;
      }
      this.conflictCurrentVersion = null;
      this.saveStatus = this.isDirty ? 'dirty' : 'idle';
    },

    /** 尝试在切换章节 / 离开页面前冲刷草稿。 */
    async flushPendingSave(): Promise<boolean> {
      clearAutoSaveTimer();
      if (!this.isDirty && this.saveStatus !== 'error' && this.saveStatus !== 'conflict') {
        return true;
      }
      return this.saveContent();
    },

    dismissSaveError(): void {
      this.saveError = null;
      if (this.saveStatus === 'error') {
        this.saveStatus = this.isDirty ? 'dirty' : 'idle';
      }
    },

    /* ------------------------------ 历史快照 ------------------------------ */

    async loadRevisions(): Promise<void> {
      const chapterId = this.currentChapterId;
      if (chapterId === null) {
        this.revisions = [];
        return;
      }
      this.revisionsLoading = true;
      this.revisionsError = null;
      try {
        const response = await chaptersApi.listRevisions(chapterId);
        this.revisions = response.items;
      } catch (error) {
        this.revisionsError = describeError(error);
        throw error;
      } finally {
        this.revisionsLoading = false;
      }
    },

    async createRevision(note?: string): Promise<void> {
      const chapterId = this.currentChapterId;
      if (chapterId === null) {
        return;
      }
      await chaptersApi.createRevision(chapterId, note !== undefined ? { note } : {});
      await this.loadRevisions();
    },

    async previewRevision(revisionId: string): Promise<void> {
      const chapterId = this.currentChapterId;
      if (chapterId === null) {
        return;
      }
      this.revisionPreviewLoading = true;
      try {
        this.revisionPreview = await chaptersApi.getRevision(chapterId, revisionId);
      } finally {
        this.revisionPreviewLoading = false;
      }
    },

    clearRevisionPreview(): void {
      this.revisionPreview = null;
    },

    /** 一键回滚：服务端先备份当前正文，再恢复目标快照。 */
    async restoreRevision(revisionId: string): Promise<void> {
      const chapterId = this.currentChapterId;
      if (chapterId === null) {
        return;
      }
      this.restoringRevisionId = revisionId;
      try {
        const response = await chaptersApi.restoreRevision(chapterId, revisionId);
        this.applyLoadedChapter(response.chapter);
        this.revisionPreview = null;
        if (this.bookId !== null) {
          await this.loadTree(this.bookId);
        }
        await this.loadRevisions();
      } finally {
        this.restoringRevisionId = null;
      }
    },

    /* ------------------------------ 分卷操作 ------------------------------ */

    async createVolume(payload: CreateVolumeInputPayload): Promise<string | null> {
      const bookId = this.bookId;
      if (bookId === null) {
        return null;
      }
      const ack = await volumesApi.create(bookId, payload);
      await this.loadTree(bookId);
      if (ack.id !== null && this.volumes.some((volume) => volume.id === ack.id)) {
        return ack.id;
      }
      return this.volumes[this.volumes.length - 1]?.id ?? null;
    },

    async updateVolume(volumeId: string, payload: UpdateVolumeInputPayload): Promise<void> {
      await volumesApi.update(volumeId, payload);
      if (this.bookId !== null) {
        await this.loadTree(this.bookId);
      }
    },

    async deleteVolume(volumeId: string): Promise<void> {
      await volumesApi.remove(volumeId);
      if (this.bookId !== null) {
        await this.loadTree(this.bookId);
      }
    },

    async restoreVolume(volumeId: string): Promise<void> {
      await volumesApi.restore(volumeId);
      await this.refreshAfterTrashChange();
    },

    async purgeVolume(volumeId: string): Promise<void> {
      await volumesApi.remove(volumeId, { permanent: true });
      await this.refreshAfterTrashChange();
    },

    /** 分卷上移 / 下移（重写全部分卷 `sortOrder`）。 */
    async moveVolume(volumeId: string, direction: 'up' | 'down'): Promise<void> {
      const bookId = this.bookId;
      if (bookId === null) {
        return;
      }
      const ids = this.volumes.map((volume) => volume.id);
      const index = ids.indexOf(volumeId);
      if (index < 0) {
        return;
      }
      const targetIndex = direction === 'up' ? index - 1 : index + 1;
      if (targetIndex < 0 || targetIndex >= ids.length) {
        return;
      }
      const nextIds = [...ids];
      const [moved] = nextIds.splice(index, 1);
      if (moved === undefined) {
        return;
      }
      nextIds.splice(targetIndex, 0, moved);
      await volumesApi.reorder(bookId, nextIds);
      await this.loadTree(bookId);
    },

    /* ------------------------------ 章节操作 ------------------------------ */

    async createChapter(payload: CreateChapterInputPayload): Promise<ChapterTreeItem | null> {
      const bookId = this.bookId;
      if (bookId === null) {
        return null;
      }
      const ack = await chaptersApi.create(bookId, payload);
      await this.loadTree(bookId);
      if (ack.id !== null) {
        const created = this.findChapter(ack.id);
        if (created !== undefined) {
          return created;
        }
      }
      // 响应未带 id 时回退：对应卷（或未分卷区）的最后一条
      const fallback =
        payload.volumeId === undefined || payload.volumeId === null
          ? this.ungroupedChapters[this.ungroupedChapters.length - 1]
          : this.volumes
              .find((volume) => volume.id === payload.volumeId)
              ?.chapters.at(-1);
      return fallback ?? null;
    },

    async updateChapterMeta(
      chapterId: string,
      payload: UpdateChapterMetaInputPayload,
    ): Promise<void> {
      await chaptersApi.updateMeta(chapterId, payload);
      if (this.bookId !== null) {
        await this.loadTree(this.bookId);
      }
      if (this.currentChapter !== null && this.currentChapter.id === chapterId) {
        if (payload.title !== undefined) {
          this.currentChapter.title = payload.title;
          this.draftTitle = payload.title;
        }
        if (payload.status !== undefined) {
          this.currentChapter.status = payload.status;
        }
        if (payload.volumeId !== undefined) {
          this.currentChapter.volumeId = payload.volumeId;
        }
      }
    },

    async updateChapterStatus(chapterId: string, status: ChapterStatus): Promise<void> {
      await this.updateChapterMeta(chapterId, { status });
    },

    async deleteChapter(chapterId: string): Promise<void> {
      await chaptersApi.remove(chapterId);
      if (this.currentChapterId === chapterId) {
        this.clearChapter();
      }
      if (this.bookId !== null) {
        await this.loadTree(this.bookId);
      }
    },

    async restoreChapter(chapterId: string): Promise<void> {
      await chaptersApi.restore(chapterId);
      await this.refreshAfterTrashChange();
    },

    async purgeChapter(chapterId: string): Promise<void> {
      await chaptersApi.remove(chapterId, { permanent: true });
      await this.refreshAfterTrashChange();
    },

    /** 同卷内上移 / 下移。 */
    async moveChapter(chapterId: string, direction: 'up' | 'down'): Promise<void> {
      const bookId = this.bookId;
      const siblings = this.chapterSiblings(chapterId);
      if (bookId === null || siblings === null) {
        return;
      }
      const index = siblings.chapters.findIndex((chapter) => chapter.id === chapterId);
      const targetIndex = direction === 'up' ? index - 1 : index + 1;
      if (index < 0 || targetIndex < 0 || targetIndex >= siblings.chapters.length) {
        return;
      }
      const next = [...siblings.chapters];
      const [moved] = next.splice(index, 1);
      if (moved === undefined) {
        return;
      }
      next.splice(targetIndex, 0, moved);
      await chaptersApi.reorder(bookId, {
        items: next.map((chapter, order) => ({
          chapterId: chapter.id,
          volumeId: siblings.volumeId,
          sortOrder: order,
        })),
      });
      await this.loadTree(bookId);
    },

    /** 跨卷移动（含移入 / 移出「未分卷区」），追加到目标末尾。 */
    async moveChapterToVolume(chapterId: string, target: ChapterMoveTarget): Promise<void> {
      const bookId = this.bookId;
      const siblings = this.chapterSiblings(chapterId);
      if (bookId === null || siblings === null || siblings.volumeId === target.volumeId) {
        return;
      }
      const targetChapters =
        target.volumeId === null
          ? this.ungroupedChapters
          : this.volumes.find((volume) => volume.id === target.volumeId)?.chapters;
      if (targetChapters === undefined) {
        return;
      }

      const source = siblings.chapters.filter((chapter) => chapter.id !== chapterId);
      const destination = [...targetChapters, this.findChapter(chapterId)].filter(
        (chapter): chapter is ChapterTreeItem => chapter !== undefined,
      );

      await chaptersApi.reorder(bookId, {
        items: [
          ...source.map((chapter, order) => ({
            chapterId: chapter.id,
            volumeId: siblings.volumeId,
            sortOrder: order,
          })),
          ...destination.map((chapter, order) => ({
            chapterId: chapter.id,
            volumeId: target.volumeId,
            sortOrder: order,
          })),
        ],
      });
      await this.loadTree(bookId);
      if (this.currentChapter !== null && this.currentChapter.id === chapterId) {
        this.currentChapter.volumeId = target.volumeId;
      }
    },

    /* ------------------------------ 回收站与沉浸 ------------------------------ */

    async loadTrash(): Promise<void> {
      const bookId = this.bookId;
      if (bookId === null) {
        this.trash = emptyTrash;
        return;
      }
      this.trashLoading = true;
      this.trashError = null;
      try {
        this.trash = await booksApi.trash(bookId);
      } catch (error) {
        this.trashError = describeError(error);
        throw error;
      } finally {
        this.trashLoading = false;
      }
    },

    async refreshAfterTrashChange(): Promise<void> {
      if (this.bookId !== null) {
        await this.loadTree(this.bookId);
      }
      await this.loadTrash();
    },

    setImmersive(value: boolean): void {
      this.immersive = value;
    },

    toggleImmersive(): void {
      this.immersive = !this.immersive;
    },

    exitImmersive(): void {
      this.immersive = false;
    },
  },
});
