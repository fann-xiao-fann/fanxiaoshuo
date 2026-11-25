import {
  KNOWLEDGE_CARD_CATEGORY_LABELS,
  getToolboxToolDefinition,
  toolboxOutputSchema,
  type KnowledgeCardCategory,
  type ToolboxInputs,
  type ToolboxOutput,
  type ToolboxResultItem,
  type ToolboxToolId,
} from '@fanxiaoshuo/shared';
import { buildRoleSystemPrompt } from '../runtime/roles.js';

/**
 * 创作工具盒（Creation Toolbox）原创中文提示词与结构化产出解析器。
 *
 * 所有权：`packages/agents`。本模块只产出纯字符串与纯数据，不接触数据库、HTTP
 * 与任何 AI SDK / Mastra 内部类型，供 `apps/server` 的同步工具盒接口复用。
 *
 * 设计原则：
 * - 6 个内置工具共用同一输出契约 `{ overview, items[] }`，前端只需一套结果卡片渲染器；
 * - 解析器**绝不抛异常**：模型输出无论是 Markdown 代码块、夹杂说明文本还是纯文本，
 *   都会收敛成可通过 `toolboxOutputSchema` 校验的结构化结果；
 * - 全部文案为 Clean-room 原创，不使用任何外部竞品提示词片段。
 */

/* -------------------------------------------------------------------------- */
/*                                  长度上限                                   */
/* -------------------------------------------------------------------------- */

/**
 * 以下上限与 `@fanxiaoshuo/shared` 的 `toolboxOutputSchema` 严格对齐。
 * 共享契约调整时必须同步本文件的归一化上限，否则解析结果会校验失败。
 */
const MAX_OVERVIEW_LENGTH = 2_000;
const MAX_ITEM_TITLE_LENGTH = 120;
const MAX_ITEM_SUMMARY_LENGTH = 500;
const MAX_ITEM_CONTENT_LENGTH = 8_000;
const MAX_ITEM_ALIASES_COUNT = 10;
const MAX_ITEM_ALIAS_LENGTH = 60;
const MAX_ITEM_TAGS_COUNT = 10;
const MAX_ITEM_TAG_LENGTH = 30;
const MAX_ITEMS_COUNT = 10;

/** 注入 Prompt 的设定卡条数上限（置顶卡优先，避免上下文膨胀）。 */
const MAX_CONTEXT_CARDS = 8;

/** 单张设定卡摘要注入字数上限。 */
const MAX_CONTEXT_CARD_SUMMARY_CHARS = 180;

/** 总大纲单字段注入字数上限。 */
const MAX_CONTEXT_OUTLINE_CHARS = 600;

/** 作品简介注入字数上限。 */
const MAX_CONTEXT_SYNOPSIS_CHARS = 800;

/* -------------------------------------------------------------------------- */
/*                                  上下文类型                                  */
/* -------------------------------------------------------------------------- */

/** 关联作品的全书总大纲精简上下文（4 个字段与 `BookOutlineDto` 同名）。 */
export interface ToolboxBookOutlineContext {
  readonly mainPlot?: string;
  readonly worldSetting?: string;
  readonly styleGuide?: string;
  readonly endingPlan?: string;
}

/** 关联作品的核心设定卡精简上下文。 */
export interface ToolboxBookCardContext {
  readonly category: KnowledgeCardCategory;
  readonly title: string;
  readonly summary: string;
  readonly content?: string;
  readonly pinned?: boolean;
}

/**
 * 关联作品上下文：书名 + 可选题材 / 简介 / 总大纲 / 核心设定卡。
 * 由 `apps/server` 从 Book Bible 读取后裁剪传入，`packages/agents` 不感知仓储细节。
 */
export interface ToolboxBookContext {
  readonly title: string;
  readonly genre?: string;
  readonly synopsis?: string;
  readonly outline?: ToolboxBookOutlineContext | null;
  readonly cards?: readonly ToolboxBookCardContext[];
}

/** `buildToolboxPrompts` 入参。 */
export interface ToolboxPromptInput {
  readonly toolId: ToolboxToolId;
  /** 已经过 `validateToolboxInputs` 归一化的输入值 */
  readonly inputs: ToolboxInputs;
  readonly bookContext?: ToolboxBookContext | null;
}

/** 提示词二元组（系统提示词 + 用户提示词）。 */
export interface ToolboxPrompts {
  readonly system: string;
  readonly prompt: string;
}

/* -------------------------------------------------------------------------- */
/*                                分类归一化                                   */
/* -------------------------------------------------------------------------- */

/**
 * 工具语义分类 → 共享设定卡分类。
 *
 * 工具盒允许模型使用更贴近创作语境的 `location` / `plot`，但 Book Bible 只接受
 * 6 个契约分类，因此在此做确定性映射（`location → world`、`plot → foreshadowing`）。
 */
const CARD_CATEGORY_ALIASES: Readonly<Record<string, KnowledgeCardCategory>> = {
  character: 'character',
  world: 'world',
  faction: 'faction',
  item: 'item',
  location: 'world',
  plot: 'foreshadowing',
  foreshadowing: 'foreshadowing',
  timeline: 'timeline',
};

/** 工具盒输入 `cardCategory` 的中文展示名（仅用于 Prompt 说明）。 */
const TOOLBOX_INPUT_CARD_CATEGORY_LABELS: Readonly<Record<string, string>> = {
  world: '世界观规则',
  faction: '势力组织',
  item: '物品/法宝',
  location: '地点/场景',
  plot: '剧情设定',
};

/**
 * 将任意分类字符串收敛为合法的设定卡分类。
 * 未知值 / 非字符串一律回退到 `fallback`（保证结果永不为 null）。
 */
export function resolveToolboxCardCategory(
  value: unknown,
  fallback: KnowledgeCardCategory,
): KnowledgeCardCategory {
  if (typeof value !== 'string') return fallback;
  return CARD_CATEGORY_ALIASES[value.trim().toLowerCase()] ?? fallback;
}

/**
 * 解析某次工具运行的推荐设定卡分类：
 * `world-faction-builder` 以用户选择的 `cardCategory` 为准（映射为契约分类），
 * 其余工具使用工具目录声明的 `defaultCardCategory`。
 */
export function resolveToolboxRecommendedCategory(
  toolId: ToolboxToolId,
  inputs?: ToolboxInputs | null,
): KnowledgeCardCategory {
  const definition = getToolboxToolDefinition(toolId);
  const fallback: KnowledgeCardCategory = definition?.defaultCardCategory ?? 'world';
  if (toolId !== 'world-faction-builder') return fallback;
  return resolveToolboxCardCategory(inputs?.['cardCategory'], fallback);
}

/* -------------------------------------------------------------------------- */
/*                                通用渲染工具                                 */
/* -------------------------------------------------------------------------- */

/** 按字符长度截断（与共享 Zod `.max()` 的 JS 长度口径保持一致）。 */
function clampText(value: string, maxLength: number): string {
  const trimmed = value.trim();
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
}

/** 归一换行并压缩多余空行。 */
function normalizeWhitespace(value: string): string {
  return value.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** 取文本头部指定字数。 */
function headOf(text: string, maxChars: number): string {
  const chars = Array.from(text);
  if (chars.length <= maxChars) return text;
  return `${chars.slice(0, maxChars).join('')}…`;
}

/** 读取文本型输入。 */
function readInputText(inputs: ToolboxInputs, key: string): string {
  const raw = inputs[key];
  if (typeof raw === 'string') return raw.trim();
  if (typeof raw === 'number') return String(raw);
  return '';
}

/** 读取数量型输入并收敛到工具声明的闭区间。 */
function readInputCount(
  inputs: ToolboxInputs,
  key: string,
  fallback: number,
  max: number,
): number {
  const raw = inputs[key];
  const numeric = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.trim()) : NaN;
  if (!Number.isInteger(numeric) || numeric < 1) return fallback;
  return Math.min(numeric, max);
}

/* -------------------------------------------------------------------------- */
/*                              关联作品上下文渲染                              */
/* -------------------------------------------------------------------------- */

/** 置顶卡优先，其余保持原有顺序，最多注入 `MAX_CONTEXT_CARDS` 张。 */
function prioritizeCards(
  cards: readonly ToolboxBookCardContext[],
): readonly ToolboxBookCardContext[] {
  const pinned = cards.filter((card) => card.pinned === true);
  const rest = cards.filter((card) => card.pinned !== true);
  return [...pinned, ...rest].slice(0, MAX_CONTEXT_CARDS);
}

/** 渲染关联作品上下文分节（无上下文时返回空数组，不注入空分节）。 */
function renderBookContext(context: ToolboxBookContext | null | undefined): readonly string[] {
  if (!context) return [];

  const lines: string[] = ['【关联作品上下文（必须与之保持一致，不得矛盾）】'];
  lines.push(`作品名：《${clampText(context.title, 120) || '（未命名作品）'}》`);

  const genre = context.genre?.trim();
  if (genre) lines.push(`题材：${clampText(genre, 120)}`);

  const synopsis = context.synopsis?.trim();
  if (synopsis) {
    lines.push(`作品简介：${headOf(normalizeWhitespace(synopsis), MAX_CONTEXT_SYNOPSIS_CHARS)}`);
  }

  const outlineFields: readonly (readonly [string, string | undefined])[] = [
    ['主线剧情', context.outline?.mainPlot],
    ['世界观设定', context.outline?.worldSetting],
    ['文风与禁忌', context.outline?.styleGuide],
    ['结局规划', context.outline?.endingPlan],
  ];
  const outlineLines = outlineFields
    .map(([label, value]) => [label, value?.trim() ?? ''] as const)
    .filter(([, value]) => value.length > 0)
    .map(([label, value]) => `- ${label}：${headOf(normalizeWhitespace(value), MAX_CONTEXT_OUTLINE_CHARS)}`);
  if (outlineLines.length > 0) {
    lines.push('', '【全书总大纲（节选）】', ...outlineLines);
  }

  const cards = prioritizeCards(context.cards ?? []);
  lines.push('', '【核心设定卡（置顶优先，最多 8 张）】');
  if (cards.length === 0) {
    lines.push('- （暂无核心设定卡）');
  } else {
    for (const card of cards) {
      const categoryLabel = KNOWLEDGE_CARD_CATEGORY_LABELS[card.category];
      const title = clampText(card.title, 120) || '（未命名设定）';
      const body = card.summary.trim() || card.content?.trim() || '';
      const summary = headOf(normalizeWhitespace(body), MAX_CONTEXT_CARD_SUMMARY_CHARS);
      const pinnedMark = card.pinned === true ? '（置顶）' : '';
      lines.push(`- 【${categoryLabel}】${title}${pinnedMark}：${summary || '（暂无摘要）'}`);
    }
  }

  return lines;
}

/* -------------------------------------------------------------------------- */
/*                             6 个工具任务说明                                */
/* -------------------------------------------------------------------------- */

/** 单个工具的 Prompt 任务说明。 */
interface ToolboxToolBrief {
  /** 一句话任务目标（写入系统提示词） */
  readonly mission: string;
  /** 该工具的创作方法论与输出纪律 */
  readonly guidelines: readonly string[];
  /** 渲染到用户提示词的输入分节 */
  readonly inputLines: readonly string[];
  /** 期望产出的条目数量 */
  readonly itemCount: number;
}

/** 各工具共用的结果条数说明。 */
function renderCountInstruction(count: number): string {
  return `本次请恰好产出 ${count} 条结果（字段 items 长度固定为 ${count}，最多 ${MAX_ITEMS_COUNT} 条）。`;
}

/** 按工具生成任务说明与输入渲染。 */
function buildToolBrief(toolId: ToolboxToolId, inputs: ToolboxInputs): ToolboxToolBrief {
  switch (toolId) {
    case 'book-pitch': {
      const genre = readInputText(inputs, 'genre') || '（未指定题材）';
      const coreHook = readInputText(inputs, 'coreHook') || '（未提供核心爽点）';
      const audience = readInputText(inputs, 'audience') || '通用';
      const count = readInputCount(inputs, 'count', 3, 5);
      return {
        mission: `围绕给定的题材与核心爽点，策划 ${count} 套可直接立项的「书名 + 爆款简介」组合，兼顾点击率与后续可写性。`,
        guidelines: [
          '每条结果对应一套方案：title 为书名（2–14 字，不含书名号，直接命中题材与卖点），summary 为一句话卖点（不超过 40 字），content 为 150–300 字简介正文。',
          '简介固定四拍：开局钩子（主角在什么处境被什么事件击中）→ 主角底牌（金手指、专业能力或异常身份）→ 第一次爽点或反转 → 追读悬念（一个尚未解决的问题）。',
          '书名与简介必须互相印证：书名承诺的卖点必须在简介中出现，禁止挂羊头卖狗肉，也禁止只用「重生」「战神」等模板词简单拼接。',
          `${count} 套方案必须真正差异化：至少两套使用完全不同的开局切入角度，禁止只换书名不换设定。`,
          'aliases 放同一方案的备选书名或核心关键词；tags 放题材与爽点标签（如「都市异能」「扮猪吃虎」「宗门逆袭」）。',
        ],
        inputLines: [
          `【题材类型】${genre}`,
          `【核心爽点与主线钩子】${coreHook}`,
          `【目标读者】${audience}`,
          `【需要产出】${count} 套书名 + 简介组合`,
        ],
        itemCount: count,
      };
    }

    case 'character-designer': {
      const rolePosition = readInputText(inputs, 'rolePosition') || '主角';
      const archetype = readInputText(inputs, 'archetype') || '（未指定人物原型）';
      const backgroundHint = readInputText(inputs, 'backgroundHint');
      const count = readInputCount(inputs, 'count', 1, 3);
      return {
        mission: `按角色定位与人物原型，孵化 ${count} 张有清晰人物弧光、可直接进入设定集的人物卡。`,
        guidelines: [
          'title 为「人物姓名·角色定位」，summary 用一句话概括最抓人的记忆点，content 用「小节标题：正文」的形式组织，不要使用 Markdown 标记。',
          'content 必须包含七个小节：基础档案（年龄/身份/外形记忆点）、性格与口吻（三个具体行为细节 + 说话方式）、动机与恐惧（想要什么、害怕失去什么）、关系网（至少两位带张力的关系）、成长弧线（起点缺陷 → 转折事件 → 终点变化）、能力与限制（强项与明确上限）、出场设计（首次登场场景与钩子）。',
          '人物必须有可被剧情戳中的缺陷与执念，禁止写完美无短板的人设，也禁止只用「高冷」「腹黑」这类标签代替具体行为。',
          '与已有设定卡中的姓名、关系与时间线保持一致，不得抢占既有角色身份；确需新增关系或势力时标注「待确认」。',
          'aliases 放绰号、道号或常用称呼；tags 放定位、阵营与性格标签。',
        ],
        inputLines: [
          `【角色定位】${rolePosition}`,
          `【人物原型】${archetype}`,
          `【背景补充】${backgroundHint || '（未提供，请自行补全并与既有设定兼容）'}`,
          `【需要产出】${count} 张人物卡`,
        ],
        itemCount: count,
      };
    }

    case 'world-faction-builder': {
      const cardCategory = readInputText(inputs, 'cardCategory') || 'faction';
      const categoryLabel = TOOLBOX_INPUT_CARD_CATEGORY_LABELS[cardCategory] ?? '势力组织';
      const theme = readInputText(inputs, 'theme') || '（未指定设定主题）';
      const constraints = readInputText(inputs, 'constraints');
      const count = readInputCount(inputs, 'count', 2, 3);
      return {
        mission: `围绕「${theme}」补全 ${count} 条「${categoryLabel}」设定，自带冲突钩子与出场时机建议。`,
        guidelines: [
          'title 为设定名称（可直接作为设定卡标题），summary 用一句话说清它最独特的规则或记忆点。',
          'content 必须包含六个小节：定义与第一印象、运行规则（可被反复引用的硬规则）、内部矛盾或裂缝、与主角团的关系与可利用点、出场时机与冲突钩子、三条可继续延展的后续空间。',
          '按设定类型调整重点：势力类写清权力结构 / 资源来源 / 行事风格；地点类写清场景特征 / 危险性 / 进入与离开方式；物品类写清能力 / 代价 / 争夺动机；世界观类写清底层规则与代价；剧情设定类写清触发条件与后果。',
          '严格遵守用户给出的约束与禁忌，不得偷偷突破战力上限或世界观规则；与既有设定卡冲突时以既有设定为准。',
          'aliases 放别称、旧称或民间俗称；tags 放类型、阵营与功能标签（如「宗门」「禁地」「副本」）。',
        ],
        inputLines: [
          `【设定类型】${categoryLabel}（${cardCategory}）`,
          `【设定主题】${theme}`,
          `【约束与禁忌】${constraints || '（未提供，请自行设定合理边界）'}`,
          `【需要产出】${count} 条设定`,
        ],
        itemCount: count,
      };
    }

    case 'golden-finger-designer': {
      const powerStyle = readInputText(inputs, 'powerStyle') || '神秘古宝';
      const coreMechanic = readInputText(inputs, 'coreMechanic') || '（未提供核心机制）';
      const limitation = readInputText(inputs, 'limitation');
      const count = readInputCount(inputs, 'count', 2, 3);
      return {
        mission: `基于「${powerStyle}」形态设计 ${count} 套带明确代价与三阶段成长曲线的金手指方案，避免开局无敌导致战力崩坏。`,
        guidelines: [
          'title 为金手指名称，summary 用一句话说清「它让主角能做什么、代价是什么」。',
          'content 必须包含六个小节：形态与来源、触发条件与能力边界、代价与限制（冷却 / 消耗 / 反噬 / 道德困境）、成长曲线（获得 → 解锁 → 质变三个阶段各自的能力与门槛）、剧情用法（两三处可直接安排的爽点与危机）、平衡风险（写手最容易写崩的地方与止损方式）。',
          '金手指必须有明确上限与失败可能，禁止出现「无代价、无冷却、无限成长」的设定。',
          '若用户已给定代价与限制，必须逐条落实，不得私自放宽；需要新增代价时标注「待确认」。',
          'aliases 放别名、俗称或系统自称；tags 放形态、能力方向与成长类型标签。',
        ],
        inputLines: [
          `【金手指形态】${powerStyle}`,
          `【核心机制】${coreMechanic}`,
          `【代价与限制】${limitation || '（未提供，请自行设计有痛感的代价）'}`,
          `【需要产出】${count} 套金手指方案`,
        ],
        itemCount: count,
      };
    }

    case 'plot-hook-brainstorm': {
      const currentSituation =
        readInputText(inputs, 'currentSituation') || '（未提供当前剧情进展）';
      const conflictType = readInputText(inputs, 'conflictType') || '危机升级';
      const count = readInputCount(inputs, 'count', 3, 5);
      return {
        mission: `围绕当前剧情进展，脑暴 ${count} 条「${conflictType}」类型的冲突升级路径与章尾强钩子，每条都能直接落笔。`,
        guidelines: [
          'title 为一句话概括（不超过 24 字），summary 用一句话说明它如何扣住指定冲突类型，content 必须包含四块。',
          'content 固定四拍：触发点（谁做了什么导致局面变化）、升级路径（三步，每一步代价都比上一步更高）、主角的艰难选择（两个都不想失去的选项）、章尾钩子（以「章尾钩子：」开头，给一句可直接放在章节末尾的悬念句）。',
          '方案之间不得换皮重复，至少覆盖两种不同强度的冲突（局部摩擦 vs 结构性危机），并保证冲突由已有矛盾自然生长。',
          '不得引入与当前进展矛盾的新设定；需要新人物、新势力或新道具时标注「待确认」，不得直接改写既有事实。',
          'aliases 放可作为章节标题的备选短句；tags 放冲突类型与情绪标签（如「打脸」「背叛」「危机」「悬念」）。',
        ],
        inputLines: [
          `【当前剧情进展】${currentSituation}`,
          `【冲突类型】${conflictType}`,
          `【需要产出】${count} 条可直接落笔的方案`,
        ],
        itemCount: count,
      };
    }

    case 'text-polish-diagnose': {
      const excerpt = readInputText(inputs, 'excerpt') || '（未提供待诊断片段）';
      const focus = readInputText(inputs, 'focus') || '综合诊断与节奏';
      return {
        mission: `对给定片段做「${focus}」方向的质检诊断，给出可立即执行的修改方向与关键段落改写示范，不重写全文。`,
        guidelines: [
          '只诊断给定片段，禁止扩写剧情或引入片段之外的新设定。',
          '每条结果针对一个具体问题或改进方向：title 为问题名（如「开篇信息倾倒」），summary 为一句话诊断结论（指出位置与影响），content 必须包含四块。',
          'content 固定四拍：问题定位（引用原文不超过 60 字的短句）、为什么这是问题（对节奏 / 代入感 / 张力的具体影响）、修改方向（可执行的改法）、改写示范（不超过 200 字，只示范关键段落）。',
          '禁止只写「文笔不错」「可以加强」这类空评价；每条建议都要让执笔写手立刻知道改哪一句、往哪个方向改。',
          '按诊断侧重取舍：综合诊断看整体节奏与信息密度；去水看重复表述与空转对话；画面感看感官细节与镜头调度；对话看口吻差异与潜台词。',
          'aliases 放该问题在写作圈内的别称；tags 放问题类型标签（如「节奏」「水文」「视角」「对话」）。',
        ],
        inputLines: [
          `【诊断侧重】${focus}`,
          '【待诊断片段】',
          '"""',
          excerpt,
          '"""',
        ],
        itemCount: 4,
      };
    }

    default: {
      const exhaustive: never = toolId;
      throw new Error(`未支持的创作工具：${String(exhaustive)}`);
    }
  }
}

/* -------------------------------------------------------------------------- */
/*                                 Prompt 构造                                 */
/* -------------------------------------------------------------------------- */

/**
 * 构建创作工具盒单次调用的系统提示词与用户提示词。
 *
 * 系统提示词 = 写书角色边界 + 工具任务说明 + 严格 JSON 输出纪律；
 * 用户提示词 = 可选关联作品上下文 + 本次表单输入 + 收尾指令。
 */
export function buildToolboxPrompts(input: ToolboxPromptInput): ToolboxPrompts {
  const definition = getToolboxToolDefinition(input.toolId);
  if (!definition) {
    throw new Error(`未知的创作工具：${String(input.toolId)}`);
  }

  const brief = buildToolBrief(input.toolId, input.inputs);
  const recommendedCategory = resolveToolboxRecommendedCategory(input.toolId, input.inputs);

  const systemLines: string[] = [
    buildRoleSystemPrompt(definition.defaultRole),
    '',
    `【本次任务：创作工具盒 · ${definition.name}】`,
    brief.mission,
  ];
  brief.guidelines.forEach((rule, index) => {
    systemLines.push(`${index + 1}. ${rule}`);
  });

  systemLines.push(
    '',
    '【输出纪律（必须逐条遵守）】',
    '1. 只输出单个 JSON 对象，禁止输出 Markdown 代码块、寒暄、解释或 JSON 之外的任何文字。',
    '2. 结构必须严格为：{"overview": "整体思路总览", "items": [{"title": "结果标题", "summary": "一句话摘要", "content": "可直接落地的正文", "aliases": ["别名"], "tags": ["标签"], "suggestedCardCategory": "character|world|faction|item|location|plot"}]}。',
    `3. ${renderCountInstruction(brief.itemCount)}每条都必须有非空 title 与 content。`,
    '4. overview 用 80–200 字说明整体策划思路与使用建议，不要逐条复述 items。',
    '5. title 不超过 60 字，summary 不超过 120 字，content 控制在 300–1200 字（片段诊断类可更短）；aliases 0–3 条、tags 2–5 条，禁止空字符串。',
    `6. suggestedCardCategory 只能取白名单值，本次优先使用 "${recommendedCategory}"（${KNOWLEDGE_CARD_CATEGORY_LABELS[recommendedCategory]}）；location 会被归一化为 world，plot 会被归一化为 foreshadowing。`,
    '7. 全文使用简体中文，专有名词前后一致，禁止出现「作为 AI」「以下是」等元叙述。',
  );

  const promptLines: string[] = [];
  const contextLines = renderBookContext(input.bookContext);
  if (contextLines.length > 0) {
    promptLines.push(...contextLines, '');
  }
  promptLines.push('【本次输入】', ...brief.inputLines, '', '请仅输出符合要求的 JSON 对象。');

  return { system: systemLines.join('\n'), prompt: promptLines.join('\n') };
}

/* -------------------------------------------------------------------------- */
/*                            结构化产出容错解析                               */
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

/** 依次尝试整体解析、首个 JSON 对象、首个 JSON 数组。 */
function extractPayload(rawText: string): unknown {
  const cleaned = stripCodeFences(rawText);
  const candidates: string[] = [cleaned.trim()];

  const objectStart = cleaned.indexOf('{');
  const objectEnd = cleaned.lastIndexOf('}');
  if (objectStart >= 0 && objectEnd > objectStart) {
    candidates.push(cleaned.slice(objectStart, objectEnd + 1));
  }

  const arrayStart = cleaned.indexOf('[');
  const arrayEnd = cleaned.lastIndexOf(']');
  if (arrayStart >= 0 && arrayEnd > arrayStart) {
    candidates.push(cleaned.slice(arrayStart, arrayEnd + 1));
  }

  for (const candidate of candidates) {
    const parsed = tryParseJson(candidate);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

/** 判断是否为普通对象（排除数组与 null）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 将任意标量 / 标量数组渲染为文本。 */
function readTextValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return value
      .map((entry) => readTextValue(entry))
      .filter((entry) => entry.trim().length > 0)
      .join('\n');
  }
  return '';
}

/** 从对象中按多个候选键读取第一个非空文本。 */
function readFirstTextField(record: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const text = readTextValue(record[key]).trim();
    if (text) return text;
  }
  return '';
}

/** 将别名 / 标签输入归一化为去重后的字符串数组。 */
function readTextList(value: unknown, maxCount: number, maxLength: number): string[] {
  const rawEntries: unknown[] = Array.isArray(value) ? value : [value];
  const result: string[] = [];

  for (const entry of rawEntries) {
    const chunks = readTextValue(entry).split(/[\n,，、;；|]+/);
    for (const chunk of chunks) {
      const text = clampText(chunk, maxLength);
      if (!text || result.includes(text)) continue;
      result.push(text);
      if (result.length >= maxCount) return result;
    }
  }
  return result;
}

/** 解析后的单条结果（构造阶段中间态）。 */
type DraftResultItem = ToolboxResultItem;

/** 归一化单条结果条目（同时兼容纯字符串条目）。 */
function normalizeResultItem(
  entry: unknown,
  index: number,
  toolName: string,
  fallbackCategory: KnowledgeCardCategory,
): DraftResultItem {
  const fallbackTitle = clampText(`${toolName}结果${index > 0 ? ` ${index + 1}` : ''}`, MAX_ITEM_TITLE_LENGTH);

  if (typeof entry === 'string') {
    const content = clampText(normalizeWhitespace(entry), MAX_ITEM_CONTENT_LENGTH);
    const firstLine = content.split('\n')[0] ?? '';
    return {
      title: clampText(firstLine, MAX_ITEM_TITLE_LENGTH) || fallbackTitle,
      summary: clampText(firstLine, MAX_ITEM_SUMMARY_LENGTH),
      content,
      aliases: [],
      tags: [],
      suggestedCardCategory: fallbackCategory,
    };
  }

  const record = isRecord(entry) ? entry : {};
  const rawContent = readFirstTextField(record, ['content', 'body', 'detail', 'text', 'description']);
  const rawSummary = readFirstTextField(record, ['summary', 'abstract', 'brief', 'description']);
  const rawTitle = readFirstTextField(record, ['title', 'name', 'heading', 'label']);

  const content = clampText(normalizeWhitespace(rawContent || rawSummary), MAX_ITEM_CONTENT_LENGTH);
  const firstLine = (content.split('\n')[0] ?? '').trim();
  const summary = clampText(rawSummary || firstLine, MAX_ITEM_SUMMARY_LENGTH);
  const title = clampText(rawTitle || firstLine, MAX_ITEM_TITLE_LENGTH) || fallbackTitle;

  const categorySource =
    record['suggestedCardCategory'] ?? record['suggested_category'] ?? record['cardCategory'] ?? record['category'];

  return {
    title,
    summary,
    content,
    aliases: readTextList(record['aliases'] ?? record['alias'], MAX_ITEM_ALIASES_COUNT, MAX_ITEM_ALIAS_LENGTH),
    tags: readTextList(record['tags'] ?? record['tag'], MAX_ITEM_TAGS_COUNT, MAX_ITEM_TAG_LENGTH),
    suggestedCardCategory: resolveToolboxCardCategory(categorySource, fallbackCategory),
  };
}

/** 纯文本兜底：把模型原文整理为 1 条可读结果。 */
function buildFallbackOutput(
  rawText: string,
  toolName: string,
  fallbackCategory: KnowledgeCardCategory,
): ToolboxOutput {
  const cleaned = clampText(normalizeWhitespace(rawText), MAX_ITEM_CONTENT_LENGTH);
  const firstLine = cleaned.split('\n')[0] ?? '';
  const overview = cleaned
    ? '模型返回了非结构化文本，已原样整理为单条结果，可直接复制使用，或手动沉淀为设定卡。'
    : `${toolName}未返回可用内容，请重试或调整输入后再次执行。`;

  return {
    overview: clampText(overview, MAX_OVERVIEW_LENGTH),
    items: [
      {
        title: clampText(`${toolName}结果`, MAX_ITEM_TITLE_LENGTH),
        summary: clampText(firstLine, MAX_ITEM_SUMMARY_LENGTH),
        content: cleaned,
        aliases: [],
        tags: [],
        suggestedCardCategory: fallbackCategory,
      },
    ],
  };
}

/** 极端兜底：保证任何输入都能产出通过契约校验的最小结构。 */
function buildMinimalOutput(
  toolName: string,
  fallbackCategory: KnowledgeCardCategory,
): ToolboxOutput {
  return {
    overview: `${toolName}已完成，但未能整理出结构化结果，请重试。`,
    items: [
      {
        title: clampText(`${toolName}结果`, MAX_ITEM_TITLE_LENGTH),
        summary: '',
        content: '',
        aliases: [],
        tags: [],
        suggestedCardCategory: fallbackCategory,
      },
    ],
  };
}

/**
 * 容错解析模型返回的结构化产出。
 *
 * 解析顺序：
 * 1. 剥离 Markdown 代码块后整体 `JSON.parse`；
 * 2. 抽取首个 `{ ... }` 或 `[ ... ]` 片段再解析（应对模型夹杂说明文本）；
 * 3. 完全无法解析时确定性降级为 1 条结构化结果（原文保留到 `content`）。
 *
 * 归一化包含：空白清洗、按共享契约上限截断、别名 / 标签去重限量、
 * 非法 `suggestedCardCategory` 回退到 `preferredCategory ?? 工具默认分类`。
 *
 * **任何情况下都不会抛异常**，返回值保证通过 `toolboxOutputSchema.parse`。
 */
export function parseToolboxOutput(
  rawText: string,
  toolId: ToolboxToolId,
  preferredCategory?: KnowledgeCardCategory | null,
): ToolboxOutput {
  const definition = getToolboxToolDefinition(toolId);
  const toolName = definition?.name ?? '创作工具';
  const fallbackCategory: KnowledgeCardCategory =
    preferredCategory ?? definition?.defaultCardCategory ?? 'world';
  const source = typeof rawText === 'string' ? rawText : '';

  let output: ToolboxOutput;

  try {
    const payload = extractPayload(source);

    if (payload === undefined) {
      output = buildFallbackOutput(source, toolName, fallbackCategory);
    } else if (Array.isArray(payload)) {
      const items = payload
        .slice(0, MAX_ITEMS_COUNT)
        .map((entry, index) => normalizeResultItem(entry, index, toolName, fallbackCategory));
      output =
        items.length > 0
          ? { overview: '', items }
          : buildFallbackOutput(source, toolName, fallbackCategory);
    } else if (isRecord(payload)) {
      const rawItems =
        payload['items'] ?? payload['results'] ?? payload['data'] ?? payload['list'] ?? undefined;
      const entries: unknown[] = Array.isArray(rawItems)
        ? rawItems
        : rawItems === undefined
          ? []
          : [rawItems];
      const items = entries
        .slice(0, MAX_ITEMS_COUNT)
        .map((entry, index) => normalizeResultItem(entry, index, toolName, fallbackCategory));
      const overview = clampText(
        normalizeWhitespace(readTextValue(payload['overview'] ?? payload['summary'])),
        MAX_OVERVIEW_LENGTH,
      );
      output =
        items.length > 0
          ? { overview, items }
          : buildFallbackOutput(source, toolName, fallbackCategory);
    } else {
      output = buildFallbackOutput(source, toolName, fallbackCategory);
    }

    return toolboxOutputSchema.parse(output);
  } catch {
    // 归一化逻辑或契约校验出现意外时，仍返回可用的最小结构，绝不向上抛解析异常。
    return toolboxOutputSchema.parse(buildMinimalOutput(toolName, fallbackCategory));
  }
}
