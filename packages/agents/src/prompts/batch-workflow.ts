import { KNOWLEDGE_CARD_CATEGORY_LABELS, MAX_CHAPTER_OUTLINE_LENGTH } from '@fanxiaoshuo/shared';
import type {
  ContextBookOutlineInput,
  ContextPrevChapterInput,
  ContextRecentSummaryInput,
} from '../context/context-assembler.js';
import type { ContextKnowledgeCardInput } from '../context/card-recall.js';
import { buildRoleSystemPrompt } from '../runtime/roles.js';

/**
 * 批量写书流水线的原创中文提示词（Showrunner 拆细纲 / Critic 审稿 / Writer 返工）
 * 与容错解析器。
 *
 * 所有权：`packages/agents`。本模块只产出纯字符串与纯数据，
 * 不接触数据库、HTTP 与任何 AI SDK / Mastra 内部类型，供 Worker 与 Server 复用同一份 Prompt 资产。
 *
 * 设计原则（与 `openspec/changes/batch-workflows-engine/design.md` 一致）：
 * - 无人值守批次场景下，模型输出格式永远可能抖动，因此所有解析器**绝不抛异常**；
 * - 解析失败最多降级为「可读文本 / 不阻断批次」，由 `critic` 阈值与返工轮数上限兜住质量；
 * - 全部文案为 Clean-room 原创，不使用任何外部竞品提示词片段。
 */

/* -------------------------------------------------------------------------- */
/*                                通用渲染工具                                 */
/* -------------------------------------------------------------------------- */

/** 上一章尾部片段纳入提示词的字数上限。 */
const PREV_CHAPTER_TAIL_CHARS = 800;

/** 设定卡摘要纳入提示词的条数上限（避免细纲规划提示词膨胀）。 */
const MAX_CARD_DIGEST_COUNT = 12;

/** 设定卡摘要单条纳入正文的字数上限。 */
const MAX_CARD_SUMMARY_CHARS = 240;

/** 前情摘要纳入提示词的条数上限。 */
const MAX_RECENT_SUMMARY_COUNT = 8;

/** 前情摘要单条纳入正文的字数上限。 */
const MAX_RECENT_SUMMARY_CHARS = 400;

/** 取文本尾部指定字数。 */
function tailOf(text: string, maxChars: number): string {
  const chars = Array.from(text);
  if (chars.length <= maxChars) return text;
  return chars.slice(chars.length - maxChars).join('');
}

/** 取文本头部指定字数。 */
function headOf(text: string, maxChars: number): string {
  const chars = Array.from(text);
  if (chars.length <= maxChars) return text;
  return chars.slice(0, maxChars).join('');
}

/** 渲染全书总大纲四个字段（全空时返回占位说明）。 */
function renderBookOutline(outline: ContextBookOutlineInput | null | undefined): string {
  if (!outline) return '（未提供全书总大纲）';

  const fields: readonly (readonly [string, string])[] = [
    ['主线剧情', outline.mainPlot],
    ['世界观设定', outline.worldSetting],
    ['文风与禁忌', outline.styleGuide],
    ['结局规划', outline.endingPlan],
  ];

  const lines = fields
    .map(([label, value]) => [label, value.trim()] as const)
    .filter(([, value]) => value.length > 0)
    .map(([label, value]) => `- ${label}：${value}`);

  return lines.length > 0 ? lines.join('\n') : '（未提供全书总大纲）';
}

/** 渲染设定卡摘要列表（无卡片时返回占位说明）。 */
function renderCardDigest(cards: readonly ContextKnowledgeCardInput[] | undefined): string {
  const entries = (cards ?? []).slice(0, MAX_CARD_DIGEST_COUNT);
  if (entries.length === 0) return '（暂无设定卡）';

  return entries
    .map((card) => {
      const categoryLabel = KNOWLEDGE_CARD_CATEGORY_LABELS[card.category];
      const title = card.title.trim() || '未命名设定';
      const summary = headOf(card.summary.trim() || card.content.trim(), MAX_CARD_SUMMARY_CHARS);
      return `- 【${categoryLabel}】${title}：${summary || '（暂无摘要）'}`;
    })
    .join('\n');
}

/** 渲染前序章节摘要（按时间顺序从旧到新，无摘要时返回占位说明）。 */
function renderRecentSummaries(
  summaries: readonly ContextRecentSummaryInput[] | undefined,
): string {
  const entries = (summaries ?? []).slice(-MAX_RECENT_SUMMARY_COUNT);
  if (entries.length === 0) return '（暂无前序章节摘要）';

  return entries
    .map((entry, index) => {
      const title = entry.chapterTitle.trim() || '未命名章节';
      const summary = headOf(entry.summary.trim(), MAX_RECENT_SUMMARY_CHARS);
      const keyEvents = (entry.keyEvents ?? [])
        .map((event) => event.trim())
        .filter((event) => event.length > 0);
      const lines = [`${index + 1}. 《${title}》`, `   摘要：${summary || '（暂无摘要）'}`];
      if (keyEvents.length > 0) lines.push(`   关键事件：${keyEvents.join('；')}`);
      return lines.join('\n');
    })
    .join('\n');
}

/** 渲染上一章结尾片段（无上一章时返回占位说明）。 */
function renderPrevChapterTail(prevChapter: ContextPrevChapterInput | null | undefined): string {
  const body = prevChapter?.contentText?.trim() ?? '';
  if (!prevChapter || !body) return '（无上一章内容）';
  const title = prevChapter.title.trim() || '未命名章节';
  const tail = tailOf(body, PREV_CHAPTER_TAIL_CHARS).trim();
  return `《${title}》结尾片段：\n${tail}`;
}

/* -------------------------------------------------------------------------- */
/*                          Showrunner：单章细纲规划                           */
/* -------------------------------------------------------------------------- */

/** `buildChapterOutlinePrompts` 入参。 */
export interface ChapterOutlinePromptInput {
  readonly bookTitle: string;
  readonly genre?: string;
  readonly bookOutline?: ContextBookOutlineInput | null;
  readonly cards?: readonly ContextKnowledgeCardInput[];
  /** 前序章节摘要，按时间顺序从旧到新 */
  readonly recentSummaries?: readonly ContextRecentSummaryInput[];
  readonly prevChapter?: ContextPrevChapterInput | null;
  readonly chapterTitle: string;
  /** 章节已有的细纲（作为细化基础，不得推翻既有事实） */
  readonly existingOutline?: string | null;
  /** 用户对本批次 / 本章的补充指令 */
  readonly instruction?: string;
}

/** 提示词二元组（系统提示词 + 用户提示词）。 */
export interface ChapterOutlinePrompts {
  readonly system: string;
  readonly prompt: string;
}

/** `showrunner` 拆解单章细纲的输出纪律。 */
const OUTLINE_OUTPUT_DISCIPLINE: readonly string[] = [
  '严格服从全书总大纲与结局规划，本章只推进当前阶段该推进的部分，不得提前写穿后续两三章的主线。',
  '细纲必须写完四块内容：核心目标（本章结束时一定要达成的剧情结果）、主要冲突（谁在阻止谁、代价是什么）、推进节拍（3–5 个按顺序展开的场景节拍，每个节拍一句话）、章末钩子（让读者想翻下一章的悬念或危机）。',
  '节拍之间要有因果推进：前一节拍的结果是后一节拍的起因，禁止把同质化的打斗或对话堆成一章。',
  '与设定卡的人物性格、能力上限、势力关系和时间线保持一致；确需新增设定时标注「待确认」，不得自造与设定冲突的信息。',
  '优先输出单个 JSON 对象：{"outline": "本章细纲全文"}；也可以直接输出纯文本细纲，但必须用「核心目标 / 主要冲突 / 推进节拍 / 章末钩子」四个小标题分块。',
  '不写正文对白，不写作者旁白，不输出与细纲无关的寒暄、解释或 Markdown 代码块标记。',
];

/**
 * 构建 `showrunner` 的单章细纲规划提示词。
 *
 * 输入包含全书总大纲、设定卡摘要、前序摘要、上一章尾部、本章标题与既有细纲，
 * 输出引导模型给出可直接指导 `writer` 成文的本章细纲。
 */
export function buildChapterOutlinePrompts(
  input: ChapterOutlinePromptInput,
): ChapterOutlinePrompts {
  const systemLines: string[] = [
    buildRoleSystemPrompt('showrunner'),
    '',
    '【本次任务：单章细纲规划】',
  ];
  OUTLINE_OUTPUT_DISCIPLINE.forEach((rule, index) => {
    systemLines.push(`${index + 1}. ${rule}`);
  });

  const promptLines: string[] = [
    `作品：《${input.bookTitle.trim() || '（未命名作品）'}》`,
  ];
  const genre = input.genre?.trim();
  if (genre) promptLines.push(`题材：${genre}`);

  promptLines.push(
    '',
    '【全书总大纲】',
    renderBookOutline(input.bookOutline),
    '',
    '【前序章节摘要（从旧到新）】',
    renderRecentSummaries(input.recentSummaries),
    '',
    '【上一章尾部衔接参考（只用来把握语气与场景，不要照抄）】',
    renderPrevChapterTail(input.prevChapter),
    '',
    '【关键设定卡摘要】',
    renderCardDigest(input.cards),
    '',
    `【本章标题】《${input.chapterTitle.trim() || '（未命名章节）'}》`,
  );

  const existingOutline = input.existingOutline?.trim();
  promptLines.push(
    '',
    '【本章已有细纲（若不为空，请在此基础上细化补全，不要推翻既有事实）】',
    existingOutline || '（本章尚无细纲，请从零规划）',
  );

  const instruction = input.instruction?.trim();
  if (instruction) {
    promptLines.push('', '【用户补充指令（优先级最高，需在不违背总大纲的前提下落实）】', instruction);
  }

  promptLines.push('', '请输出本章细纲。');

  return { system: systemLines.join('\n'), prompt: promptLines.join('\n') };
}

/* -------------------------------------------------------------------------- */
/*                        Showrunner：细纲容错解析（不抛异常）                  */
/* -------------------------------------------------------------------------- */

/** Markdown 代码块（可带语言标记）。 */
const CODE_FENCE_PATTERN = /```[A-Za-z]*[ \t]*\r?\n?([\s\S]*?)```/g;

/** 去掉 ```json ... ``` / ``` ... ``` 包裹，保留内部内容。 */
function stripCodeFences(rawText: string): string {
  return rawText.replace(CODE_FENCE_PATTERN, (_match, inner: string) => inner);
}

/** 安全 `JSON.parse`：任何异常都返回 `undefined`。 */
function tryParseJson(candidate: string): unknown {
  const trimmed = candidate.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

/** 提取首个 `{` 到最后一个 `}` 之间的子串（应对模型夹杂说明文本）。 */
function extractJsonObjectCandidate(text: string): string | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  return text.slice(start, end + 1);
}

/** 从已解析的 JSON 载荷中取出非空字符串字段。 */
function readStringField(value: unknown, field: string): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const raw = (value as Record<string, unknown>)[field];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** 截断到共享契约的细纲长度上限。 */
function clampOutline(outline: string): string {
  return outline.length > MAX_CHAPTER_OUTLINE_LENGTH
    ? outline.slice(0, MAX_CHAPTER_OUTLINE_LENGTH)
    : outline;
}

/**
 * 容错解析 `showrunner` 返回的细纲文本。
 *
 * 解析顺序：剥离代码块后整体 `JSON.parse` 取 `outline` → 抽取首个 `{ ... }` 再取 `outline`
 * → 取清理后的纯文本。结果截断至 `MAX_CHAPTER_OUTLINE_LENGTH`（10,000 字）。
 *
 * **任何情况下都不会抛异常**：信息缺失时返回空字符串，由调用方决定是否降级为「沿用原细纲」。
 */
export function parsePlannedOutline(rawText: string): string {
  const source = typeof rawText === 'string' ? rawText : '';
  const cleaned = stripCodeFences(source);

  const direct = readStringField(tryParseJson(cleaned), 'outline');
  if (direct) return clampOutline(direct);

  const objectCandidate = extractJsonObjectCandidate(cleaned);
  if (objectCandidate) {
    const extracted = readStringField(tryParseJson(objectCandidate), 'outline');
    if (extracted) return clampOutline(extracted);
  }

  return clampOutline(cleaned.trim());
}

/* -------------------------------------------------------------------------- */
/*                            Critic：单章审稿质检                             */
/* -------------------------------------------------------------------------- */

/** `buildChapterCriticPrompts` 入参。 */
export interface ChapterCriticPromptInput {
  readonly bookTitle: string;
  readonly chapterTitle: string;
  /** 审稿及格分（0–100），低于该分必须判定不通过 */
  readonly minPassScore: number;
  readonly bookOutline?: ContextBookOutlineInput | null;
  readonly cards?: readonly ContextKnowledgeCardInput[];
  readonly recentSummaries?: readonly ContextRecentSummaryInput[];
  /** 本章细纲（作为审稿基准之一） */
  readonly chapterOutline?: string | null;
  /** 待审章节正文 */
  readonly contentText: string;
  /** 用户额外的审稿口径 */
  readonly instruction?: string;
}

/** `critic` 审稿提示词二元组。 */
export interface ChapterCriticPrompts {
  readonly system: string;
  readonly prompt: string;
}

/** 审稿 JSON 输出纪律（评分口径 + 字段契约 + 返工指导可执行性）。 */
const CRITIC_JSON_DISCIPLINE: readonly string[] = [
  '只依据给定正文与基准材料（总大纲、设定卡、本章细纲、前情摘要）审查，不臆测正文之外的情节。',
  '输出必须是单个 JSON 对象：不要输出寒暄、解释、Markdown 代码块标记或任何 JSON 之外的文字。',
  'JSON 字段与类型必须严格为：{"score": 整数0-100, "passed": 布尔值, "summary": "总体评价", "issues": ["问题1", "问题2"], "reworkGuidance": "具体可执行的返工修改指令"}。',
  '评分口径：0–100 整数。85 分以上表示可直接发布；70–84 表示小修可用；60–69 表示需要明显修改；60 分以下表示结构或连贯性存在硬伤。',
  '审查维度按优先级排列：① 与总大纲 / 设定卡 / 本章细纲的一致性；② 剧情推进与叙事节奏（是否拖沓、是否跳步）；③ 人物口吻与行为逻辑是否统一；④ 水文问题（重复表述、空转对话、无信息量的环境堆砌）；⑤ 章末钩子是否有效。',
  'issues 给出 0–10 条最值得修的具体问题，每条一句话、不超过 60 字，禁止写「整体不错」这类空评价。',
  'reworkGuidance 必须是执笔写手可以直接执行的修改指令（改哪一段、改成什么方向、保留什么），禁止只写「加强文笔」「提高质量」。',
  'passed 必须与 score 一致：score 低于及格分时 passed 必须为 false。',
];

/**
 * 构建 `critic` 的单章审稿提示词。
 *
 * 明确告知及格分阈值 `minPassScore`，要求返回严格 JSON，便于下游 `parseCriticReview` 稳定解析。
 */
export function buildChapterCriticPrompts(
  input: ChapterCriticPromptInput,
): ChapterCriticPrompts {
  const minPassScore = normalizeScoreBound(input.minPassScore);

  const systemLines: string[] = [
    buildRoleSystemPrompt('critic'),
    '',
    '【本次任务：单章审稿质检】',
    `- 及格分阈值：${minPassScore} 分（0–100 整数评分，低于该分必须判定 passed = false，并给出可执行的返工指导）。`,
  ];
  CRITIC_JSON_DISCIPLINE.forEach((rule, index) => {
    systemLines.push(`${index + 1}. ${rule}`);
  });

  const promptLines: string[] = [
    `作品：《${input.bookTitle.trim() || '（未命名作品）'}》`,
    `章节：《${input.chapterTitle.trim() || '（未命名章节）'}》`,
    '',
    '【全书总大纲】',
    renderBookOutline(input.bookOutline),
    '',
    '【关键设定卡摘要】',
    renderCardDigest(input.cards),
    '',
    '【前序章节摘要（从旧到新）】',
    renderRecentSummaries(input.recentSummaries),
    '',
    '【本章细纲（一致性审查基准）】',
    input.chapterOutline?.trim() || '（本章无细纲，请按总大纲与前情判断推进是否合理）',
    '',
    '【待审章节正文】',
    '"""',
    input.contentText.trim(),
    '"""',
  ];

  const instruction = input.instruction?.trim();
  if (instruction) {
    promptLines.push('', '【用户补充审稿口径】', instruction);
  }

  promptLines.push('', '请仅输出符合要求的 JSON 对象。');

  return { system: systemLines.join('\n'), prompt: promptLines.join('\n') };
}

/* -------------------------------------------------------------------------- */
/*                         Critic：审稿 JSON 容错解析                          */
/* -------------------------------------------------------------------------- */

/** 解析后的审稿结论。 */
export interface ParsedCriticReview {
  /** 0–100 整数得分 */
  readonly score: number;
  readonly passed: boolean;
  readonly summary: string;
  readonly issues: string[];
  readonly reworkGuidance: string;
}

/** 单条问题文本长度上限（与共享 `workflowStepDtoSchema.criticIssues` 对齐）。 */
const MAX_CRITIC_ISSUE_LENGTH = 500;

/** 问题清单条数上限。 */
const MAX_CRITIC_ISSUES_COUNT = 15;

/** 总体评价 / 返工指导长度上限（与共享 `workflowStepDtoSchema` 文本上限对齐）。 */
const MAX_CRITIC_TEXT_LENGTH = 2_000;

/** 非 JSON 兜底时使用的总体评价。 */
const FALLBACK_REVIEW_SUMMARY = '审稿完成';

/** 把任意数值归一为 0–100 整数（非法值返回 `fallback`）。 */
function normalizeScoreBound(value: number, fallback = 0): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(100, Math.max(0, Math.round(value)));
}

/** 解析模型返回的 `score` 字段（支持数字字符串，非法值返回 null）。 */
function readRawScore(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return normalizeScoreBound(value);
  if (typeof value === 'string' && /^\s*-?\d+(?:\.\d+)?\s*$/.test(value)) {
    return normalizeScoreBound(Number(value));
  }
  return null;
}

/** 规范化字符串数组：丢弃非字符串与空白项、逐项限长、去重、限制条数。 */
function normalizeIssueList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim().slice(0, MAX_CRITIC_ISSUE_LENGTH);
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
    if (result.length >= MAX_CRITIC_ISSUES_COUNT) break;
  }
  return result;
}

/** 规范化单段文本（非字符串返回空串，超出上限截断）。 */
function normalizeText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, MAX_CRITIC_TEXT_LENGTH);
}

/**
 * 把已解析的 JSON 载荷规范化为 `ParsedCriticReview`。
 *
 * 硬规则（预算与返工闭环的安全底线）：
 * - `score < minPassScore` → `passed` 强制为 `false`（模型自评通过也无效）；
 * - `score >= minPassScore` → 模型显式给出 `false` 时保持 `false`，否则 `true`。
 */
function normalizeReviewPayload(
  value: unknown,
  minPassScore: number,
): ParsedCriticReview | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;

  const rawScore = readRawScore(record['score']);
  const summary = normalizeText(record['summary']);
  const issues = normalizeIssueList(record['issues']);
  const reworkGuidance = normalizeText(record['reworkGuidance']);
  const explicitPassed = typeof record['passed'] === 'boolean' ? record['passed'] : null;

  // 完全没有可用字段时视为解析失败，交由纯文本兜底（避免把噪声当成审稿结论）。
  if (rawScore === null && !summary && issues.length === 0 && !reworkGuidance) return null;

  const score = rawScore ?? normalizeScoreBound(minPassScore);
  const passed =
    score < minPassScore ? false : explicitPassed === null ? true : explicitPassed;

  return {
    score,
    passed,
    summary,
    issues,
    reworkGuidance,
  };
}

/**
 * 容错解析 `critic` 返回的审稿文本。
 *
 * 解析顺序：剥离代码块后整体 `JSON.parse` → 抽取首个 `{ ... }` 再解析 → 纯文本兜底。
 * 纯文本兜底返回 `{ score: minPassScore, passed: true }`（不阻断无人值守批次），
 * **任何情况下都不会抛异常**。
 */
export function parseCriticReview(rawText: string, minPassScore: number): ParsedCriticReview {
  const threshold = normalizeScoreBound(minPassScore, 0);
  const source = typeof rawText === 'string' ? rawText : '';
  const cleaned = stripCodeFences(source);

  const direct = normalizeReviewPayload(tryParseJson(cleaned), threshold);
  if (direct) return direct;

  const objectCandidate = extractJsonObjectCandidate(cleaned);
  if (objectCandidate) {
    const extracted = normalizeReviewPayload(tryParseJson(objectCandidate), threshold);
    if (extracted) return extracted;
  }

  const summary = normalizeText(cleaned);
  return {
    score: threshold,
    passed: true,
    summary: summary || FALLBACK_REVIEW_SUMMARY,
    issues: [],
    reworkGuidance: '',
  };
}

/* -------------------------------------------------------------------------- */
/*                            Writer：按审稿意见返工                           */
/* -------------------------------------------------------------------------- */

/** `buildChapterReworkPrompts` 入参。 */
export interface ChapterReworkPromptInput {
  /** 首稿使用的系统提示词（角色边界 + 本书信息 + 动作纪律） */
  readonly baseSystemPrompt: string;
  /** 首稿使用的用户提示词（上下文分段拼接结果） */
  readonly baseUserPrompt: string;
  /** 上一版初稿正文 */
  readonly previousDraft: string;
  /** 上一轮审稿结论 */
  readonly review: ParsedCriticReview;
  /** 当前返工轮次（从 1 开始） */
  readonly round: number;
  /** 允许的最大返工轮数 */
  readonly maxRounds: number;
  readonly chapterTitle?: string;
  /** 目标字数（返工后篇幅应与首稿基本持平） */
  readonly targetWords?: number;
}

/** `writer` 返工提示词二元组。 */
export interface ChapterReworkPrompts {
  readonly system: string;
  readonly prompt: string;
}

/** 返工模式的额外纪律（叠加在首稿系统提示词之上）。 */
const REWORK_SYSTEM_DISCIPLINE: readonly string[] = [
  '你现在处于「按审稿意见返工」模式：本次任务是修订上一版初稿，不是重写一个全新的章节。',
  '保留初稿中已成立的情节骨架、人物关系、时间线与章末钩子；只针对审稿意见指出的问题做定向修改。',
  '不得新增与总大纲、设定卡冲突的设定，也不得把初稿里已经交代清楚的信息再重复一遍。',
  '重点修复：一致性问题、节奏拖沓、人物口吻漂移、水文段落与无效对话；修复后章末钩子必须依然有效。',
  '直接输出修订后的完整小说正文段落（可整章替换初稿），不要输出修改说明、对照表、批注或 Markdown 标题列表。',
];

/**
 * 构建 `writer` 的返工提示词。
 *
 * 在首稿的 `baseSystemPrompt` / `baseUserPrompt` 之上追加「上一版初稿 + 审稿得分 / 问题清单 / 返工指导」，
 * 驱动执笔写手做定向修订并直接输出完整正文。
 */
export function buildChapterReworkPrompts(input: ChapterReworkPromptInput): ChapterReworkPrompts {
  const round = Math.max(1, Math.round(Number.isFinite(input.round) ? input.round : 1));
  const maxRounds = Math.max(round, Math.round(Number.isFinite(input.maxRounds) ? input.maxRounds : round));

  const systemLines: string[] = [input.baseSystemPrompt, '', '【返工模式附加纪律】'];
  REWORK_SYSTEM_DISCIPLINE.forEach((rule, index) => {
    systemLines.push(`${index + 1}. ${rule}`);
  });

  const issueLines =
    input.review.issues.length > 0
      ? input.review.issues.map((issue, index) => `${index + 1}. ${issue}`).join('\n')
      : '（审稿官未列出具体问题，请自行排查一致性、节奏与水文问题）';

  const promptLines: string[] = [
    input.baseUserPrompt,
    '',
    '---',
    '',
    `【返工任务：第 ${round}/${maxRounds} 轮】`,
  ];

  const chapterTitle = input.chapterTitle?.trim();
  if (chapterTitle) promptLines.push(`章节标题：《${chapterTitle}》`);
  if (input.targetWords !== undefined && input.targetWords > 0) {
    promptLines.push(`篇幅要求：约 ${input.targetWords} 字（返工后与初稿基本持平，不要为改而注水）`);
  }

  promptLines.push(
    '',
    '【审稿官结论】',
    `- 得分：${input.review.score} 分（0–100）`,
    `- 总体评价：${input.review.summary.trim() || '（未提供总体评价）'}`,
    '',
    '【必须修复的问题清单】',
    issueLines,
    '',
    '【返工指导（按此执行）】',
    input.review.reworkGuidance.trim() || '（未提供具体返工指导，请按上面问题清单逐条修复）',
    '',
    '【上一版初稿（供对照修改，不要原样输出）】',
    '"""',
    input.previousDraft.trim(),
    '"""',
    '',
    '请输出修订后的完整本章正文段落。',
  );

  return { system: systemLines.join('\n'), prompt: promptLines.join('\n') };
}
