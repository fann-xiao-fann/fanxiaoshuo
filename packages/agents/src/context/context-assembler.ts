import {
  CONTEXT_CARD_RECALL_REASON_LABELS,
  DEFAULT_MAX_CONTEXT_TOKENS,
  DEFAULT_PREV_CHAPTER_TAIL_CHARS,
  DEFAULT_RECENT_SUMMARIES_COUNT,
  KNOWLEDGE_CARD_CATEGORY_LABELS,
  MAX_PREV_CHAPTER_TAIL_CHARS,
  MAX_RECALLED_CARDS,
  MAX_RECENT_SUMMARIES_COUNT,
  type AiContextSectionPreview,
  type AiContextSelectedCard,
  type AiWriteAction,
  type AgentRole,
} from '@fanxiaoshuo/shared';
import {
  recallKnowledgeCards,
  type ContextKnowledgeCardInput,
  type RecalledKnowledgeCard,
} from './card-recall.js';
import { estimateTokens } from './token-estimator.js';
import { buildActionTaskInstruction, buildChapterWriterSystemPrompt } from '../prompts/chapter-writer.js';

/**
 * 预算感知的章节上下文组装器。
 *
 * 输入是「一本书的静态记忆（总大纲 / 设定卡）+ 动态记忆（前情摘要 / 上一章尾部）+ 当前章草稿」，
 * 输出是可直接喂给 `ModelGateway` 的 `systemPrompt` / `userPrompt`，以及供前端上下文预览面板渲染的
 * 分段 Token 账本（字段与共享 `aiContextPreviewResponseSchema` 对齐）。
 *
 * 全流程纯函数、确定性：同样的输入永远得到同样的分段顺序、同样的裁剪结果与同样的 `truncated` 标记。
 */

/* -------------------------------------------------------------------------- */
/*                                  输入类型                                   */
/* -------------------------------------------------------------------------- */

/** 书本基本信息（总大纲之外的轻量元数据）。 */
export interface ContextBookInfo {
  readonly title: string;
  readonly genre?: string;
  readonly synopsis?: string;
  readonly targetChapterWords?: number;
}

/** 全书总大纲（四个字段与 `bookOutlineDtoSchema` 对齐）。 */
export interface ContextBookOutlineInput {
  readonly mainPlot: string;
  readonly worldSetting: string;
  readonly styleGuide: string;
  readonly endingPlan: string;
}

/** 前序章节摘要（`recentSummaries` 数组按时间顺序从旧到新）。 */
export interface ContextRecentSummaryInput {
  readonly chapterTitle: string;
  readonly summary: string;
  readonly keyEvents?: readonly string[];
}

/** 上一章正文（只取尾部做承接）。 */
export interface ContextPrevChapterInput {
  readonly title: string;
  readonly contentText: string;
}

/** 当前章标题、草稿正文与细纲。 */
export interface ContextCurrentChapterInput {
  readonly title: string;
  readonly contentText: string;
  readonly outline?: string;
}

/** 组装选项（与共享 `aiContextOptionsShape` 同义，额外支持预算精细化参数）。 */
export interface AssembleChapterContextOptions {
  readonly action: AiWriteAction;
  readonly role?: AgentRole;
  readonly instruction?: string;
  readonly selectedText?: string;
  readonly cardIds?: readonly string[];
  readonly includeOutline?: boolean;
  readonly includePrevChapterTail?: boolean;
  readonly maxRecentSummaries?: number;
  readonly maxContextTokens?: number;
  readonly prevChapterTailChars?: number;
  readonly targetWords?: number;
  readonly queryEmbedding?: readonly number[] | null;
}

/** `assembleChapterContext` 完整入参。 */
export interface AssembleChapterContextInput {
  readonly book: ContextBookInfo;
  readonly outline?: ContextBookOutlineInput | null;
  readonly cards?: readonly ContextKnowledgeCardInput[];
  /** 前序章节摘要，按时间顺序从旧到新 */
  readonly recentSummaries?: readonly ContextRecentSummaryInput[];
  readonly prevChapter?: ContextPrevChapterInput | null;
  readonly chapter: ContextCurrentChapterInput;
  readonly options: AssembleChapterContextOptions;
}

/* -------------------------------------------------------------------------- */
/*                                  输出类型                                   */
/* -------------------------------------------------------------------------- */

/**
 * 组装结果。
 *
 * 前 9 个字段与共享 `aiContextPreviewResponseSchema` 一致（`systemPromptPreview` / `userPromptPreview`
 * 直接等于完整提示词），另外附带完整提示词字段 `systemPrompt` / `userPrompt` 供服务端调用模型。
 */
export interface AssembledChapterContext {
  /** 系统提示词（角色边界 + 本书信息 + 动作规则） */
  readonly systemPrompt: string;
  /** 用户提示词（各分段按顺序拼接） */
  readonly userPrompt: string;
  /** 系统 + 用户提示词的估算 Token 总量 */
  readonly estimatedTokens: number;
  readonly maxContextTokens: number;
  /** 任一分段被裁剪时为 true */
  readonly truncated: boolean;
  readonly sections: readonly AiContextSectionPreview[];
  readonly selectedCards: readonly AiContextSelectedCard[];
  /** 实际纳入的前序章节摘要条数（裁剪后会减少） */
  readonly recentSummariesCount: number;
  /** 上一章标题，无上一章时为 null */
  readonly prevChapterTitle: string | null;
  /** 与 `systemPrompt` 相同，对齐共享 `aiContextPreviewResponseSchema` 字段 */
  readonly systemPromptPreview: string;
  /** 与 `userPrompt` 相同，对齐共享 `aiContextPreviewResponseSchema` 字段 */
  readonly userPromptPreview: string;
}

/* -------------------------------------------------------------------------- */
/*                                  内部常量                                   */
/* -------------------------------------------------------------------------- */

/** 分段稳定标识。 */
const SECTION_KEYS = {
  outline: 'book-outline',
  cards: 'knowledge-cards',
  summaries: 'recent-summaries',
  prevTail: 'prev-chapter-tail',
  current: 'current-chapter',
  instruction: 'instruction',
} as const;

/** 分段中文名（前端预览面板直接展示）。 */
const SECTION_LABELS = {
  outline: '全书总大纲与世界观',
  cards: '设定卡记忆',
  summaries: '前序章节摘要',
  prevTail: '上一章尾部衔接',
  current: '当前章节细纲与正文',
  instruction: '本轮写作任务与指令',
} as const;

/** 计算召回查询文本时截取的当前正文尾部字数。 */
const QUERY_CONTENT_TAIL_CHARS = 400;

/** 裁剪循环的防御性上限（正常路径远小于该值）。 */
const MAX_SHRINK_ITERATIONS = 256;

/* -------------------------------------------------------------------------- */
/*                                  内部状态                                   */
/* -------------------------------------------------------------------------- */

/** 裁剪过程的可变状态（仅在单次 `assembleChapterContext` 调用内使用）。 */
interface AssemblyState {
  /** 设定卡正文渲染级别：`full` 含详细设定，`summary` 仅保留摘要 */
  cardDetail: 'full' | 'summary';
  /** 当前纳入的设定卡（顺序 = selected → pinned → recalled） */
  cards: RecalledKnowledgeCard[];
  /** 当前纳入的前序摘要（旧 → 新） */
  summaries: ContextRecentSummaryInput[];
  /** 上一章尾部保留字数 */
  prevTailChars: number;
  /** 当前章正文保留字数（从尾部保留） */
  currentBodyChars: number;
  /** 总大纲正文字符上限 */
  outlineChars: number;
  truncation: {
    cards: boolean;
    summaries: boolean;
    prevTail: boolean;
    current: boolean;
    outline: boolean;
  };
}

/** 待落盘的分段草稿。 */
interface SectionDraft {
  readonly key: string;
  readonly label: string;
  readonly text: string;
  readonly truncated: boolean;
}

/* -------------------------------------------------------------------------- */
/*                                  渲染工具                                   */
/* -------------------------------------------------------------------------- */

/** 取文本尾部指定字数（按码点计，避免截断代理对）。 */
function tailOf(text: string, maxChars: number): string {
  const chars = Array.from(text);
  if (chars.length <= maxChars) return text;
  return chars.slice(chars.length - maxChars).join('');
}

/** 取文本头部指定字数。 */
function headOf(text: string, maxChars: number): string {
  const chars = Array.from(text);
  if (chars.length <= maxChars) return text;
  return `${chars.slice(0, maxChars).join('')}…`;
}

/** 文本的码点长度。 */
function charLength(text: string): number {
  return Array.from(text).length;
}

/** 非负整数裁剪。 */
function clampInt(value: number, min: number, max: number): number {
  const safe = Number.isFinite(value) ? Math.floor(value) : min;
  return Math.min(max, Math.max(min, safe));
}

/** 渲染单张设定卡（`detail = 'summary'` 时省略详细设定）。 */
function renderCardBlock(entry: RecalledKnowledgeCard, detail: 'full' | 'summary'): string {
  const { card, reason } = entry;
  const categoryLabel = KNOWLEDGE_CARD_CATEGORY_LABELS[card.category];
  const reasonLabel = CONTEXT_CARD_RECALL_REASON_LABELS[reason];
  const lines: string[] = [`### 【${categoryLabel}】${card.title.trim()}（${reasonLabel}）`];

  const aliases = card.aliases.map((alias) => alias.trim()).filter((alias) => alias.length > 0);
  if (aliases.length > 0) lines.push(`- 别名：${aliases.join('、')}`);

  const tags = card.tags.map((tag) => tag.trim()).filter((tag) => tag.length > 0);
  if (tags.length > 0) lines.push(`- 标签：${tags.join('、')}`);

  const summary = card.summary.trim();
  if (summary) lines.push(`- 摘要：${summary}`);

  const content = card.content.trim();
  if (detail === 'full' && content && content !== summary) {
    lines.push(`- 详细设定：${content}`);
  }

  return lines.join('\n');
}

/** 渲染设定卡分段（无卡片时返回 null）。 */
function renderCardsSection(
  cards: readonly RecalledKnowledgeCard[],
  detail: 'full' | 'summary',
): string | null {
  if (cards.length === 0) return null;
  const blocks = cards.map((entry) => renderCardBlock(entry, detail));
  return `## ${SECTION_LABELS.cards}\n\n${blocks.join('\n\n')}`;
}

/** 渲染前情摘要分段（无摘要时返回 null）。 */
function renderSummariesSection(
  summaries: readonly ContextRecentSummaryInput[],
): string | null {
  if (summaries.length === 0) return null;

  const lines: string[] = [`## ${SECTION_LABELS.summaries}`, '以下是当前章之前已发生剧情的客观摘要，按时间顺序从早到晚：'];
  summaries.forEach((entry, index) => {
    lines.push(`${index + 1}. 《${entry.chapterTitle.trim() || '未命名章节'}》`);
    const summary = entry.summary.trim();
    if (summary) lines.push(`   摘要：${summary}`);
    const keyEvents = (entry.keyEvents ?? []).map((event) => event.trim()).filter((event) => event.length > 0);
    if (keyEvents.length > 0) lines.push(`   关键事件：${keyEvents.join('；')}`);
  });

  return lines.join('\n');
}

/** 渲染上一章尾部衔接分段（无尾部或已裁空时返回 null）。 */
function renderPrevTailSection(
  prevChapter: ContextPrevChapterInput | null | undefined,
  tailChars: number,
): string | null {
  const body = prevChapter?.contentText ?? '';
  if (!prevChapter || tailChars <= 0 || !body.trim()) return null;

  const tail = tailOf(body, tailChars).trim();
  if (!tail) return null;

  return [
    `## ${SECTION_LABELS.prevTail}`,
    `上一章《${prevChapter.title.trim() || '未命名章节'}》的结尾片段（仅供承接场景与语气，不要照抄）：`,
    '',
    tail,
  ].join('\n');
}

/** 渲染当前章分段（始终保留标题、细纲与选区）。 */
function renderCurrentSection(
  chapter: ContextCurrentChapterInput,
  selectedText: string,
  bodyChars: number,
): string {
  const lines: string[] = [
    `## ${SECTION_LABELS.current}`,
    `章节标题：${chapter.title.trim() || '（未命名章节）'}`,
  ];

  const outline = chapter.outline?.trim();
  if (outline) lines.push('', '本章细纲：', outline);

  const body = chapter.contentText;
  if (body.trim() && bodyChars > 0) {
    const kept = tailOf(body, bodyChars);
    const wasCut = charLength(kept) < charLength(body);
    lines.push('', '当前正文（已写内容，续写需自然承接最后一段）：', wasCut ? `…${kept.trimStart()}` : kept);
  }

  if (selectedText) lines.push('', '编辑器当前选中片段（写作动作的作用对象）：', selectedText);

  return lines.join('\n');
}

/** 把总大纲四个字段渲染为分段正文（全部为空返回 null）。 */
function buildOutlineBody(outline: ContextBookOutlineInput | null | undefined): string | null {
  if (!outline) return null;

  const fields: readonly (readonly [string, string])[] = [
    ['主线剧情', outline.mainPlot],
    ['世界观设定', outline.worldSetting],
    ['文风与禁忌', outline.styleGuide],
    ['结局规划', outline.endingPlan],
  ];

  const bodyLines = fields
    .map(([label, value]) => [label, value.trim()] as const)
    .filter(([, value]) => value.length > 0)
    .map(([label, value]) => `- ${label}：${value}`);

  if (bodyLines.length === 0) return null;

  return bodyLines.join('\n');
}

/** 渲染总大纲分段（正文为空返回 null）。 */
function renderOutlineSection(
  outline: ContextBookOutlineInput | null | undefined,
  outlineChars: number,
): { text: string; truncated: boolean } | null {
  const body = buildOutlineBody(outline);
  if (body === null) return null;

  const fullLength = charLength(body);
  if (outlineChars <= 0) {
    return {
      text: `## ${SECTION_LABELS.outline}\n（总大纲内容因上下文预算限制已省略，请严格遵循既有设定卡与文风禁忌。）`,
      truncated: true,
    };
  }

  const truncatedBody = headOf(body, outlineChars);
  return {
    text: `## ${SECTION_LABELS.outline}\n${truncatedBody}`,
    truncated: outlineChars < fullLength,
  };
}

/* -------------------------------------------------------------------------- */
/*                                  组装主流程                                 */
/* -------------------------------------------------------------------------- */

/** 依据当前状态渲染全部分段与提示词。 */
function renderSnapshot(
  input: AssembleChapterContextInput,
  state: AssemblyState,
  systemPrompt: string,
): {
  sections: AiContextSectionPreview[];
  selectedCards: AiContextSelectedCard[];
  userPrompt: string;
  estimatedTokens: number;
  truncated: boolean;
} {
  const drafts: SectionDraft[] = [];

  if (input.options.includeOutline !== false) {
    const outlineSection = renderOutlineSection(input.outline, state.outlineChars);
    if (outlineSection) {
      drafts.push({
        key: SECTION_KEYS.outline,
        label: SECTION_LABELS.outline,
        text: outlineSection.text,
        truncated: outlineSection.truncated || state.truncation.outline,
      });
    }
  }

  const cardsSection = renderCardsSection(state.cards, state.cardDetail);
  if (cardsSection) {
    drafts.push({
      key: SECTION_KEYS.cards,
      label: SECTION_LABELS.cards,
      text: cardsSection,
      truncated: state.truncation.cards,
    });
  }

  const summariesSection = renderSummariesSection(state.summaries);
  if (summariesSection) {
    drafts.push({
      key: SECTION_KEYS.summaries,
      label: SECTION_LABELS.summaries,
      text: summariesSection,
      truncated: state.truncation.summaries,
    });
  }

  if (input.options.includePrevChapterTail !== false) {
    const prevTailSection = renderPrevTailSection(input.prevChapter, state.prevTailChars);
    if (prevTailSection) {
      drafts.push({
        key: SECTION_KEYS.prevTail,
        label: SECTION_LABELS.prevTail,
        text: prevTailSection,
        truncated: state.truncation.prevTail,
      });
    } else if (state.truncation.prevTail) {
      drafts.push({
        key: SECTION_KEYS.prevTail,
        label: SECTION_LABELS.prevTail,
        text: `## ${SECTION_LABELS.prevTail}\n（上一章尾部因上下文预算限制已省略。）`,
        truncated: true,
      });
    }
  }

  const selectedText = input.options.selectedText?.trim() ?? '';
  const currentSection = renderCurrentSection(input.chapter, selectedText, state.currentBodyChars);
  drafts.push({
    key: SECTION_KEYS.current,
    label: SECTION_LABELS.current,
    text: currentSection,
    truncated: state.truncation.current,
  });

  const instructionSection = [
    `## ${SECTION_LABELS.instruction}`,
    buildActionTaskInstruction({
      action: input.options.action,
      instruction: input.options.instruction,
      selectedText,
      targetWords: resolveTargetWords(input),
    }),
  ].join('\n');
  drafts.push({
    key: SECTION_KEYS.instruction,
    label: SECTION_LABELS.instruction,
    text: instructionSection,
    truncated: false,
  });

  const sections: AiContextSectionPreview[] = drafts.map((draft) => ({
    key: draft.key,
    label: draft.label,
    estimatedTokens: estimateTokens(draft.text),
    truncated: draft.truncated,
    preview: draft.text,
  }));

  const selectedCards: AiContextSelectedCard[] = state.cards.map((entry) => ({
    id: entry.card.id,
    title: entry.card.title.trim(),
    category: entry.card.category,
    reason: entry.reason,
    score: entry.score,
    estimatedTokens: estimateTokens(renderCardBlock(entry, state.cardDetail)),
  }));

  const userPrompt = drafts.map((draft) => draft.text).join('\n\n');
  const estimatedTokens = estimateTokens(systemPrompt) + estimateTokens(userPrompt);

  return {
    sections,
    selectedCards,
    userPrompt,
    estimatedTokens,
    truncated: sections.some((section) => section.truncated),
  };
}

/** 解析目标字数：请求显式值优先，其次书本默认章节字数。 */
function resolveTargetWords(input: AssembleChapterContextInput): number | undefined {
  const explicit = input.options.targetWords;
  if (explicit !== undefined && Number.isFinite(explicit) && explicit > 0) return Math.floor(explicit);
  const fallback = input.book.targetChapterWords;
  if (fallback !== undefined && Number.isFinite(fallback) && fallback > 0) return Math.floor(fallback);
  return undefined;
}

/** 找出最后一个满足条件的下标（ES2023 `findLastIndex` 的显式实现，便于阅读）。 */
function lastIndexWhere<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item !== undefined && predicate(item)) return index;
  }
  return -1;
}

/**
 * 执行一步确定性裁剪。
 *
 * 顺序固定（与设计文档一致）：
 * 1. 设定卡正文降级为仅摘要；
 * 2. 从末尾移除自动召回卡；
 * 3. 移除多余常驻置顶卡（保留 `sortOrder` 最小的核心卡）；
 * 4. 从最旧开始减少前情摘要条数；
 * 5. 从头部截断上一章尾部（保留最贴近本章的结尾）；
 * 6. 从头部截断当前章正文（保留最新尾部）；
 * 7. 截断总大纲尾部；
 * 8. 最后才移除核心置顶卡。
 *
 * @returns 状态是否发生变化（`false` 表示已无可裁剪项）
 */
function shrinkOnce(state: AssemblyState): boolean {
  if (
    state.cardDetail === 'full' &&
    state.cards.some((entry) => {
      const content = entry.card.content.trim();
      return content.length > 0 && content !== entry.card.summary.trim();
    })
  ) {
    state.cardDetail = 'summary';
    state.truncation.cards = true;
    return true;
  }

  const recalledIndex = lastIndexWhere(state.cards, (entry) => entry.reason === 'recalled');
  if (recalledIndex >= 0) {
    state.cards.splice(recalledIndex, 1);
    state.truncation.cards = true;
    return true;
  }

  const pinnedIndices: number[] = [];
  state.cards.forEach((entry, index) => {
    if (entry.reason === 'pinned') pinnedIndices.push(index);
  });
  if (pinnedIndices.length > 1) {
    const lastPinnedIndex = pinnedIndices[pinnedIndices.length - 1];
    if (lastPinnedIndex !== undefined) {
      state.cards.splice(lastPinnedIndex, 1);
      state.truncation.cards = true;
      return true;
    }
  }

  if (state.summaries.length > 0) {
    state.summaries.shift();
    state.truncation.summaries = true;
    return true;
  }

  if (state.prevTailChars > 0) {
    state.prevTailChars = Math.floor(state.prevTailChars / 2);
    state.truncation.prevTail = true;
    return true;
  }

  if (state.currentBodyChars > 0) {
    state.currentBodyChars = Math.floor(state.currentBodyChars / 2);
    state.truncation.current = true;
    return true;
  }

  if (state.outlineChars > 0) {
    state.outlineChars = Math.floor(state.outlineChars / 2);
    state.truncation.outline = true;
    return true;
  }

  const corePinnedIndex = lastIndexWhere(state.cards, (entry) => entry.reason === 'pinned');
  if (corePinnedIndex >= 0) {
    state.cards.splice(corePinnedIndex, 1);
    state.truncation.cards = true;
    return true;
  }

  return false;
}

/**
 * 组装章节写作上下文。
 *
 * 召回顺序、分段顺序与裁剪顺序全部确定；预算内不做任何裁剪（`truncated: false`）。
 */
export function assembleChapterContext(
  input: AssembleChapterContextInput,
): AssembledChapterContext {
  const maxContextTokens = Math.max(
    1,
    clampInt(input.options.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS, 1, Number.MAX_SAFE_INTEGER),
  );
  const maxRecentSummaries = clampInt(
    input.options.maxRecentSummaries ?? DEFAULT_RECENT_SUMMARIES_COUNT,
    0,
    MAX_RECENT_SUMMARIES_COUNT,
  );
  const prevChapterTailChars = clampInt(
    input.options.prevChapterTailChars ?? DEFAULT_PREV_CHAPTER_TAIL_CHARS,
    0,
    MAX_PREV_CHAPTER_TAIL_CHARS,
  );
  const targetWords = resolveTargetWords(input);

  const chapterContent = input.chapter.contentText;
  const selectedText = input.options.selectedText?.trim() ?? '';
  const queryText = [
    input.chapter.title,
    input.chapter.outline ?? '',
    selectedText,
    tailOf(chapterContent, QUERY_CONTENT_TAIL_CHARS),
    input.options.instruction ?? '',
  ]
    .filter((part) => part.trim().length > 0)
    .join('\n');

  const recalledCards = recallKnowledgeCards({
    cards: input.cards ?? [],
    selectedCardIds: input.options.cardIds,
    queryText,
    queryEmbedding: input.options.queryEmbedding ?? null,
    maxRecalledCards: MAX_RECALLED_CARDS,
  });

  const allSummaries = input.recentSummaries ?? [];
  const prevChapterBody = input.prevChapter?.contentText ?? '';
  const outlineFullBody = charLength(buildOutlineBody(input.outline) ?? '');

  const state: AssemblyState = {
    cardDetail: 'full',
    cards: [...recalledCards],
    summaries:
      maxRecentSummaries > 0
        ? allSummaries.slice(Math.max(0, allSummaries.length - maxRecentSummaries))
        : [],
    prevTailChars:
      input.options.includePrevChapterTail === false
        ? 0
        : Math.min(prevChapterTailChars, charLength(prevChapterBody)),
    currentBodyChars: charLength(chapterContent),
    outlineChars: outlineFullBody,
    truncation: {
      cards: false,
      summaries: false,
      prevTail: false,
      current: false,
      outline: false,
    },
  };

  const systemPrompt = buildChapterWriterSystemPrompt({
    role: input.options.role ?? 'writer',
    action: input.options.action,
    bookTitle: input.book.title,
    genre: input.book.genre,
    styleGuide: input.outline?.styleGuide,
    targetWords,
  });

  let snapshot = renderSnapshot(input, state, systemPrompt);
  let iterations = 0;
  while (snapshot.estimatedTokens > maxContextTokens && iterations < MAX_SHRINK_ITERATIONS) {
    iterations += 1;
    if (!shrinkOnce(state)) break;
    snapshot = renderSnapshot(input, state, systemPrompt);
  }

  return {
    systemPrompt,
    userPrompt: snapshot.userPrompt,
    estimatedTokens: snapshot.estimatedTokens,
    maxContextTokens,
    truncated: snapshot.truncated,
    sections: snapshot.sections,
    selectedCards: snapshot.selectedCards,
    recentSummariesCount: state.summaries.length,
    prevChapterTitle: input.prevChapter?.title ?? null,
    systemPromptPreview: systemPrompt,
    userPromptPreview: snapshot.userPrompt,
  };
}
