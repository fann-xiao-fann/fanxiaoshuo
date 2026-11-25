import {
  AI_WRITE_ACTION_LABELS,
  MAX_CHAPTER_SUMMARY_LENGTH,
  type AgentRole,
  type AiWriteAction,
} from '@fanxiaoshuo/shared';
import { buildRoleSystemPrompt } from '../runtime/roles.js';

/**
 * 章内 AI 写作提示词（Clean-room 原创中文）与 `lorekeeper` 摘要提炼解析器。
 *
 * 所有权：`packages/agents`。本模块只产出纯字符串与纯数据，
 * 不接触数据库、HTTP 与任何 AI SDK / Mastra 内部类型，便于服务端路由与 Worker 复用同一份 Prompt 资产。
 */

/* -------------------------------------------------------------------------- */
/*                          章内写作：系统提示词                               */
/* -------------------------------------------------------------------------- */

/** `buildChapterWriterSystemPrompt` 入参。 */
export interface ChapterWriterSystemPromptOptions {
  /** 写书角色，缺省为执笔写手 `writer` */
  readonly role?: AgentRole;
  /** 本文动作 */
  readonly action: AiWriteAction;
  readonly bookTitle: string;
  readonly genre?: string;
  /** 全书文风与禁忌（来自总大纲 `styleGuide`） */
  readonly styleGuide?: string;
  /** 期望生成的目标字数 */
  readonly targetWords?: number;
}

/**
 * 4 种写作动作的正文纪律（各自独立，避免模型把「改写」当成「续写」）。
 * 全部为原创中文说明，禁止出现任何外部竞品提示词片段。
 */
const ACTION_WRITING_RULES: Record<AiWriteAction, readonly string[]> = {
  continue: [
    '承接当前章节正文的最后一段自然续写：先延续场景、人物动作与情绪，再推进细纲中的下一个节拍。',
    '不复述已写内容、不总结前情、不提前写出整章结局，把后续空间留给下一次续写。',
    '按目标字数展开 2–5 个自然段，段落之间以节奏与场景切换为界，避免一段到底。',
  ],
  expand: [
    '扩写范围严格限定在编辑器当前选中片段，保持原有视角、时态与人物口吻。',
    '在不改变原片段关键事实、人物关系与因果结果的前提下，补充环境、动作、感官与心理细节，提高信息密度。',
    '输出扩写后的完整片段本身（可直接替换原选区），不要附带「原文 / 改后」对照说明。',
  ],
  rewrite: [
    '改写对象是编辑器当前选中片段：保留核心剧情、人物关系与事件结果，重写叙事表达。',
    '可以调整句式长短、镜头顺序与对话节奏，但不得改变时间线、胜负结果与人物能力上限。',
    '输出新版本片段本身，不要解释改写思路，也不要保留原文的标记或批注。',
  ],
  polish: [
    '仅做文字级打磨：清理冗词、重复表述、语病与标点问题，强化动词与意象，统一人物称呼与口吻。',
    '不新增情节、不改变信息量与段落结构，不调整事件顺序与对话归属。',
    '输出润色后的片段本身，篇幅与原片段基本相当（上下浮动不超过两成）。',
  ],
};

/** 输出格式纪律（4 种动作共用）。 */
const OUTPUT_FORMAT_DISCIPLINE: readonly string[] = [
  '直接输出小说正文段落，段落之间用空行分隔。',
  '不要输出「好的」「以下是」等寒暄或解释性前缀，也不要输出 Markdown 标题、列表符号、代码块或分隔线。',
  '不要复述本章细纲、设定卡原文或前情摘要，也不要插入「（承接上文）」这类元信息标注。',
  '严格遵循已给出的设定卡与文风禁忌：人物称呼、能力上限、势力关系与时间线不得与设定冲突。',
  '统一使用中文行文，专有名词沿用设定卡中的写法，不要自造同义称呼。',
];

/**
 * 构建章节写作的系统提示词。
 *
 * 在 `buildRoleSystemPrompt(role ?? 'writer')` 的角色边界之上，
 * 叠加本书信息、输出格式纪律与该动作专属的写作规则。
 */
export function buildChapterWriterSystemPrompt(
  options: ChapterWriterSystemPromptOptions,
): string {
  const actionLabel = AI_WRITE_ACTION_LABELS[options.action];
  const lines: string[] = [buildRoleSystemPrompt(options.role ?? 'writer'), ''];

  lines.push('【本次写作任务】');
  lines.push(`- 作品：《${options.bookTitle.trim() || '（未命名作品）'}》`);
  if (options.genre?.trim()) lines.push(`- 题材：${options.genre.trim()}`);
  lines.push(`- 写作动作：${actionLabel}（${options.action}）`);
  if (options.targetWords !== undefined && options.targetWords > 0) {
    lines.push(`- 目标字数：约 ${options.targetWords} 字`);
  }

  lines.push('', '【输出格式纪律】');
  OUTPUT_FORMAT_DISCIPLINE.forEach((rule, index) => {
    lines.push(`${index + 1}. ${rule}`);
  });

  lines.push('', `【${actionLabel}动作要求】`);
  ACTION_WRITING_RULES[options.action].forEach((rule, index) => {
    lines.push(`${index + 1}. ${rule}`);
  });

  const styleGuide = options.styleGuide?.trim();
  if (styleGuide) {
    lines.push('', '【文风与禁忌】', styleGuide);
  }

  return lines.join('\n');
}

/* -------------------------------------------------------------------------- */
/*                          章内写作：任务指令段                               */
/* -------------------------------------------------------------------------- */

/** 各动作的默认期望字数（未显式传入 `targetWords` 时兜底）。 */
const DEFAULT_ACTION_TARGET_WORDS: Record<AiWriteAction, number> = {
  continue: 1_200,
  expand: 600,
  rewrite: 600,
  polish: 400,
};

/** `buildActionTaskInstruction` 入参。 */
export interface ActionTaskInstructionOptions {
  readonly action: AiWriteAction;
  /** 用户本轮补充指令（可空） */
  readonly instruction?: string;
  /** 编辑器当前选区文本（用于判断是否聚焦选区，不重复贴入正文） */
  readonly selectedText?: string;
  readonly targetWords?: number;
}

/** 动作对应的聚焦范围说明（依赖是否存在选区）。 */
function describeFocus(action: AiWriteAction, hasSelection: boolean): string {
  if (action === 'continue') {
    return hasSelection
      ? '以编辑器当前选中片段为承接起点，向后续写新正文。'
      : '以当前章节正文的最后一段为承接起点，向后续写新正文。';
  }
  return hasSelection
    ? '改写对象就是编辑器当前选中片段，输出可直接替换该选区。'
    : '编辑器当前没有选区：请依据本章细纲与当前正文，自行确定最需要处理的一段作为处理对象，并在输出中只给出处理后的正文。';
}

/**
 * 构建「本轮写作任务与指令」分段文本（由上下文组装器放入 `instruction` 分段）。
 */
export function buildActionTaskInstruction(options: ActionTaskInstructionOptions): string {
  const actionLabel = AI_WRITE_ACTION_LABELS[options.action];
  const targetWords =
    options.targetWords !== undefined && options.targetWords > 0
      ? options.targetWords
      : DEFAULT_ACTION_TARGET_WORDS[options.action];
  const hasSelection = (options.selectedText ?? '').trim().length > 0;

  const lines: string[] = [`本轮任务：${actionLabel}（${options.action}）`];
  lines.push(`聚焦范围：${describeFocus(options.action, hasSelection)}`);
  lines.push(
    `期望字数：约 ${targetWords} 字（允许上下浮动 20%，不要为凑字数注水，也不要明显少于该量级）。`,
  );
  lines.push('硬性约束：不得与已给出的设定卡、本章细纲与前情摘要冲突；不得重复已有正文。');

  const instruction = options.instruction?.trim();
  if (instruction) {
    lines.push('', '用户补充指令（优先级最高，需在满足以上约束的前提下尽量落实）：', instruction);
  } else {
    lines.push('', '用户未补充额外指令，请严格按本章细纲推进。');
  }

  return lines.join('\n');
}

/* -------------------------------------------------------------------------- */
/*                        lorekeeper：章节摘要提炼提示词                        */
/* -------------------------------------------------------------------------- */

/** `buildSummaryExtractPrompts` 入参。 */
export interface SummaryExtractPromptInput {
  readonly bookTitle: string;
  readonly chapterTitle: string;
  readonly contentText: string;
  /** 本章细纲（仅供理解作者意图，不得据此外推正文未写内容） */
  readonly existingOutline?: string;
  /** 用户对摘要口径的补充要求 */
  readonly instruction?: string;
}

/** 摘要提炼提示词（系统提示词 + 用户提示词）。 */
export interface SummaryExtractPrompts {
  readonly system: string;
  readonly prompt: string;
}

/** 摘要提炼必须遵守的 JSON 纪律。 */
const SUMMARY_JSON_DISCIPLINE: readonly string[] = [
  '只依据给定章节正文做客观复述，不得编造正文中未出现的人物、设定或事件。',
  '输出必须是单个 JSON 对象：不要输出解释、寒暄、Markdown 代码块标记或任何 JSON 之外的文字。',
  'JSON 字段与类型必须严格为：{"summary": "字符串", "keyEvents": ["字符串"], "charactersPresent": ["字符串"]}。',
  'summary 用 150–400 字按事件发生顺序客观概述本章剧情，不写文学性抒情，不做评论。',
  'keyEvents 给出 3–8 条按顺序排列的关键事件，每条一句话、不超过 60 字。',
  'charactersPresent 只列本章真正出场（有行动或台词）的角色，使用设定中的正式称呼。',
  '信息不足时用空数组或写「正文信息不足」，绝不臆测后续剧情。',
];

/**
 * 构建 `lorekeeper` 章节摘要提炼提示词。
 */
export function buildSummaryExtractPrompts(input: SummaryExtractPromptInput): SummaryExtractPrompts {
  const systemLines: string[] = [buildRoleSystemPrompt('lorekeeper'), '', '【本次任务：章节摘要提炼】'];
  SUMMARY_JSON_DISCIPLINE.forEach((rule, index) => {
    systemLines.push(`${index + 1}. ${rule}`);
  });

  const promptLines: string[] = [
    `作品：《${input.bookTitle.trim() || '（未命名作品）'}》`,
    `章节：《${input.chapterTitle.trim() || '（未命名章节）'}》`,
    '',
    '本章细纲（仅供理解作者意图，不得据此外推正文未写内容）：',
    input.existingOutline?.trim() || '（未提供本章细纲）',
    '',
    '章节正文：',
    '"""',
    input.contentText.trim(),
    '"""',
  ];

  const instruction = input.instruction?.trim();
  if (instruction) {
    promptLines.push('', '用户对摘要口径的补充要求：', instruction);
  }

  promptLines.push('', '请仅输出符合要求的 JSON 对象。');

  return { system: systemLines.join('\n'), prompt: promptLines.join('\n') };
}

/* -------------------------------------------------------------------------- */
/*                         lorekeeper：摘要 JSON 容错解析                       */
/* -------------------------------------------------------------------------- */

/** 解析后的章节摘要。 */
export interface ParsedExtractedSummary {
  readonly summary: string;
  readonly keyEvents: string[];
  readonly charactersPresent: string[];
}

/** 单条关键事件长度上限（与共享 `chapterSummaryDtoSchema` 对齐）。 */
const MAX_KEY_EVENT_LENGTH = 200;

/** 关键事件条数上限（与共享 `chapterSummaryDtoSchema` 对齐）。 */
const MAX_KEY_EVENTS_COUNT = 30;

/** 出场人物名称长度上限（与共享 `chapterSummaryDtoSchema` 对齐）。 */
const MAX_CHARACTER_NAME_LENGTH = 80;

/** 出场人物条数上限（与共享 `chapterSummaryDtoSchema` 对齐）。 */
const MAX_CHARACTERS_PRESENT_COUNT = 50;

/** Markdown 代码块（可带语言标记）。 */
const CODE_FENCE_PATTERN = /```[A-Za-z]*[ \t]*\r?\n?([\s\S]*?)```/g;

/** 去掉 ```json ... ``` / ``` ... ``` 包裹，保留内部内容。 */
function stripCodeFences(rawText: string): string {
  return rawText.replace(CODE_FENCE_PATTERN, (_match, inner: string) => inner);
}

/** 安全 `JSON.parse`：任何异常都返回 `undefined`（由调用方走下一级兜底）。 */
function tryParseJson(candidate: string): unknown {
  const trimmed = candidate.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

/** 提取首个 `{` 到最后一个 `}` 之间的子串（应对模型夹杂说明文本的情况）。 */
function extractJsonObjectCandidate(text: string): string | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  return text.slice(start, end + 1);
}

/** 规范化字符串数组：丢弃非字符串与空白项、逐项限长、去重、限制条数。 */
function normalizeStringList(
  value: unknown,
  maxLength: number,
  maxCount: number,
): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim().slice(0, maxLength);
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
    if (result.length >= maxCount) break;
  }
  return result;
}

/** 把已解析的 JSON 载荷规范化为 `ParsedExtractedSummary`（`summary` 为空时返回 `null`）。 */
function normalizeSummaryPayload(value: unknown): ParsedExtractedSummary | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const rawSummary = record['summary'];
  if (typeof rawSummary !== 'string') return null;

  const summary = rawSummary.trim().slice(0, MAX_CHAPTER_SUMMARY_LENGTH);
  if (!summary) return null;

  return {
    summary,
    keyEvents: normalizeStringList(record['keyEvents'], MAX_KEY_EVENT_LENGTH, MAX_KEY_EVENTS_COUNT),
    charactersPresent: normalizeStringList(
      record['charactersPresent'],
      MAX_CHARACTER_NAME_LENGTH,
      MAX_CHARACTERS_PRESENT_COUNT,
    ),
  };
}

/**
 * 容错解析 `lorekeeper` 返回的摘要文本。
 *
 * 解析顺序：剥离代码块后整体 `JSON.parse` → 抽取首个 `{ ... }` 再解析 → 纯文本兜底。
 * **任何情况下都不会抛异常**：格式抖动最多导致 `keyEvents` / `charactersPresent` 为空数组。
 */
export function parseExtractedSummary(rawText: string): ParsedExtractedSummary {
  const source = typeof rawText === 'string' ? rawText : '';
  const cleaned = stripCodeFences(source);

  const direct = normalizeSummaryPayload(tryParseJson(cleaned));
  if (direct) return direct;

  const objectCandidate = extractJsonObjectCandidate(cleaned);
  if (objectCandidate) {
    const extracted = normalizeSummaryPayload(tryParseJson(objectCandidate));
    if (extracted) return extracted;
  }

  return {
    summary: cleaned.trim().slice(0, MAX_CHAPTER_SUMMARY_LENGTH),
    keyEvents: [],
    charactersPresent: [],
  };
}
