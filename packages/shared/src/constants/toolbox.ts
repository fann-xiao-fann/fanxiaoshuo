import type { AgentRole } from './agent-roles.js';
import type { KnowledgeCardCategory } from './book-bible.js';

/**
 * 创作工具盒（Creation Toolbox）领域枚举与 6 个内置工具的声明式目录。
 *
 * 该文件是「Schema 驱动的动态表单 + 结构化结果回写」的唯一真相来源：
 * 服务端（输入校验 / 持久化）、`packages/agents`（Prompt 构造）与前端（表单渲染、
 * 分类标签、回写按钮）必须共用此处的定义，禁止各自硬编码字段列表。
 */

/* -------------------------------------------------------------------------- */
/*                                  分类枚举                                   */
/* -------------------------------------------------------------------------- */

/** 3 大工具分类：立项策划 / 设定构建 / 剧情与质检。 */
export const TOOLBOX_CATEGORIES = ['planning', 'worldbuilding', 'drafting'] as const;

export type ToolboxCategory = (typeof TOOLBOX_CATEGORIES)[number];

/** 工具分类中文展示名（左侧工具目录分组标题共用）。 */
export const TOOLBOX_CATEGORY_LABELS = {
  planning: '立项策划',
  worldbuilding: '设定构建',
  drafting: '剧情与质检',
} as const satisfies Record<ToolboxCategory, string>;

/* -------------------------------------------------------------------------- */
/*                                  工具 ID                                    */
/* -------------------------------------------------------------------------- */

/** 6 个内置创作工具 ID（顺序即前端工具目录的展示顺序）。 */
export const TOOLBOX_TOOL_IDS = [
  'book-pitch',
  'character-designer',
  'world-faction-builder',
  'golden-finger-designer',
  'plot-hook-brainstorm',
  'text-polish-diagnose',
] as const;

export type ToolboxToolId = (typeof TOOLBOX_TOOL_IDS)[number];

/* -------------------------------------------------------------------------- */
/*                                表单字段枚举                                 */
/* -------------------------------------------------------------------------- */

/** 动态表单字段类型：单行文本 / 多行文本 / 下拉选项 / 整数。 */
export const TOOLBOX_FIELD_TYPES = ['text', 'textarea', 'select', 'number'] as const;

export type ToolboxFieldType = (typeof TOOLBOX_FIELD_TYPES)[number];

/** 字段类型中文展示名（表单帮助文案共用）。 */
export const TOOLBOX_FIELD_TYPE_LABELS = {
  text: '单行文本',
  textarea: '多行文本',
  select: '下拉选择',
  number: '数字',
} as const satisfies Record<ToolboxFieldType, string>;

/* -------------------------------------------------------------------------- */
/*                                 回写目标                                    */
/* -------------------------------------------------------------------------- */

/** 结构化结果可回写的目标：Book Bible 设定卡 / 全书总大纲。 */
export const TOOLBOX_APPLY_TARGETS = ['knowledge_card', 'book_outline'] as const;

export type ToolboxApplyTarget = (typeof TOOLBOX_APPLY_TARGETS)[number];

/** 回写目标中文展示名（结果卡片回写按钮文案共用）。 */
export const TOOLBOX_APPLY_TARGET_LABELS = {
  knowledge_card: '存为设定卡',
  book_outline: '写入全书大纲',
} as const satisfies Record<ToolboxApplyTarget, string>;

/* -------------------------------------------------------------------------- */
/*                                 运行状态                                    */
/* -------------------------------------------------------------------------- */

/**
 * 工具运行状态：`completed` 成功（有结构化产出，可回写）/ `failed` 失败（无产出）。
 * 工具盒为同步单次调用，不存在排队与运行中态。
 */
export const TOOLBOX_RUN_STATUSES = ['completed', 'failed'] as const;

export type ToolboxRunStatus = (typeof TOOLBOX_RUN_STATUSES)[number];

/** 运行状态中文展示名（历史记录列表徽标共用）。 */
export const TOOLBOX_RUN_STATUS_LABELS = {
  completed: '已生成',
  failed: '已失败',
} as const satisfies Record<ToolboxRunStatus, string>;

/* -------------------------------------------------------------------------- */
/*                              大纲回写枚举                                   */
/* -------------------------------------------------------------------------- */

/** 全书总大纲 4 个可写入字段（与 `BookOutlineDto` 字段名完全一致）。 */
export const TOOLBOX_OUTLINE_FIELDS = [
  'mainPlot',
  'worldSetting',
  'styleGuide',
  'endingPlan',
] as const;

export type ToolboxOutlineField = (typeof TOOLBOX_OUTLINE_FIELDS)[number];

/** 总大纲字段中文展示名（回写弹窗的字段选择器共用）。 */
export const TOOLBOX_OUTLINE_FIELD_LABELS = {
  mainPlot: '核心主线',
  worldSetting: '世界观概览',
  styleGuide: '文风与禁忌',
  endingPlan: '阶段与结局',
} as const satisfies Record<ToolboxOutlineField, string>;

/** 大纲写入模式：追加（保留原内容，空行拼接）/ 替换。 */
export const TOOLBOX_OUTLINE_APPLY_MODES = ['append', 'replace'] as const;

export type ToolboxOutlineApplyMode = (typeof TOOLBOX_OUTLINE_APPLY_MODES)[number];

/** 大纲写入模式中文展示名。 */
export const TOOLBOX_OUTLINE_APPLY_MODE_LABELS = {
  append: '追加到末尾',
  replace: '替换原内容',
} as const satisfies Record<ToolboxOutlineApplyMode, string>;

/* -------------------------------------------------------------------------- */
/*                                目录元数据类型                                */
/* -------------------------------------------------------------------------- */

/** 下拉字段的单个选项（`value` 为提交值，`label` 为中文展示名）。 */
export interface ToolboxFieldOption {
  readonly value: string;
  readonly label: string;
}

/** 动态表单的单个字段定义。 */
export interface ToolboxFieldDefinition {
  /** 提交时的字段键（`inputs[key]`） */
  readonly key: string;
  /** 中文标签 */
  readonly label: string;
  readonly type: ToolboxFieldType;
  readonly required: boolean;
  /** 占位提示（前端输入框 `placeholder`） */
  readonly placeholder?: string;
  /** 补充说明（前端字段下方帮助文案） */
  readonly help?: string;
  /** 文本字段长度上限（服务端与前端共用同一约束） */
  readonly maxLength?: number;
  /** 下拉字段选项白名单（`select` 必填） */
  readonly options?: readonly ToolboxFieldOption[];
  /** 数字字段最小值（`number` 专用，闭区间） */
  readonly min?: number;
  /** 数字字段最大值（`number` 专用，闭区间） */
  readonly max?: number;
  /** 省略该字段时自动补全的默认值 */
  readonly defaultValue?: string | number;
}

/** 单个内置工具的完整声明式元数据。 */
export interface ToolboxToolDefinition {
  readonly id: ToolboxToolId;
  /** 工具中文名 */
  readonly name: string;
  readonly category: ToolboxCategory;
  /** 一句话能力说明（工具卡片副标题） */
  readonly summary: string;
  /** 未显式覆盖时使用的写书角色（决定实际调用的模型） */
  readonly defaultRole: AgentRole;
  /** 是否支持注入关联作品的 Book Bible 上下文 */
  readonly supportsBookContext: boolean;
  /** 支持的结果回写目标（至少一个） */
  readonly applyTargets: readonly ToolboxApplyTarget[];
  /** 结果条目未指定分类时的推荐设定卡分类 */
  readonly defaultCardCategory: KnowledgeCardCategory;
  readonly fields: readonly ToolboxFieldDefinition[];
}

/* -------------------------------------------------------------------------- */
/*                                6 个内置工具                                  */
/* -------------------------------------------------------------------------- */

/**
 * 6 个内置工具的声明式目录（契约冻结）。
 *
 * 字段约束口径：
 * - `text` / `textarea` 走 `trim()` 后做非空与 `maxLength` 校验；
 * - `select` 的 `defaultValue` 必须命中 `options` 白名单；
 * - `number` 为整数且落在闭区间 `[min, max]` 内。
 */
export const TOOLBOX_TOOL_DEFINITIONS = [
  {
    id: 'book-pitch',
    name: '书名与简介策划',
    category: 'planning',
    summary: '围绕题材与核心爽点，一次给出多个可用的书名 + 爆款简介组合。',
    defaultRole: 'showrunner',
    supportsBookContext: true,
    applyTargets: ['book_outline', 'knowledge_card'],
    defaultCardCategory: 'world',
    fields: [
      {
        key: 'genre',
        label: '题材类型',
        type: 'text',
        required: true,
        placeholder: '如：都市异能、古典仙侠、无限流悬疑',
        help: '越具体越好，可包含细分流派与年代背景。',
        maxLength: 80,
      },
      {
        key: 'coreHook',
        label: '核心爽点与主线钩子',
        type: 'textarea',
        required: true,
        placeholder: '主角是谁、开局遭遇什么、靠什么翻盘、读者最想追看的是什么',
        maxLength: 2_000,
      },
      {
        key: 'audience',
        label: '目标读者',
        type: 'select',
        required: true,
        options: [
          { value: '男频爽文', label: '男频爽文' },
          { value: '女频言情', label: '女频言情' },
          { value: '悬疑脑洞', label: '悬疑脑洞' },
          { value: '轻小说', label: '轻小说' },
          { value: '通用', label: '通用' },
        ],
        defaultValue: '男频爽文',
      },
      {
        key: 'count',
        label: '候选套数',
        type: 'number',
        required: false,
        help: '一次生成的书名 + 简介组合数量。',
        min: 1,
        max: 5,
        defaultValue: 3,
      },
    ],
  },
  {
    id: 'character-designer',
    name: '立体人物卡生成',
    category: 'worldbuilding',
    summary: '按定位与原型批量孵化有人物弧光、可直接入设定集的人物卡。',
    defaultRole: 'lorekeeper',
    supportsBookContext: true,
    applyTargets: ['knowledge_card'],
    defaultCardCategory: 'character',
    fields: [
      {
        key: 'rolePosition',
        label: '角色定位',
        type: 'select',
        required: true,
        options: [
          { value: '主角', label: '主角' },
          { value: '反派', label: '反派' },
          { value: '核心搭档/女主', label: '核心搭档/女主' },
          { value: '导师', label: '导师' },
          { value: '关键配角', label: '关键配角' },
        ],
        defaultValue: '主角',
      },
      {
        key: 'archetype',
        label: '人物原型',
        type: 'text',
        required: true,
        placeholder: '如：背负血仇的落魄医修、痞气十足的退役雇佣兵',
        maxLength: 200,
      },
      {
        key: 'backgroundHint',
        label: '背景补充',
        type: 'textarea',
        required: false,
        placeholder: '家族、门派、成长经历或与主线的关系（可留空）',
        maxLength: 2_000,
      },
      {
        key: 'count',
        label: '生成数量',
        type: 'number',
        required: false,
        min: 1,
        max: 3,
        defaultValue: 1,
      },
    ],
  },
  {
    id: 'world-faction-builder',
    name: '世界观与势力设定',
    category: 'worldbuilding',
    summary: '补全势力架构、地域风物或关键道具，自带冲突钩子与出场时机建议。',
    defaultRole: 'lorekeeper',
    supportsBookContext: true,
    applyTargets: ['knowledge_card', 'book_outline'],
    defaultCardCategory: 'faction',
    fields: [
      {
        key: 'cardCategory',
        label: '设定类型',
        type: 'select',
        required: true,
        options: [
          { value: 'world', label: '世界观规则' },
          { value: 'faction', label: '势力组织' },
          { value: 'item', label: '物品/法宝' },
          { value: 'location', label: '地点/场景' },
          { value: 'plot', label: '剧情设定' },
        ],
        defaultValue: 'faction',
      },
      {
        key: 'theme',
        label: '设定主题',
        type: 'text',
        required: true,
        placeholder: '如：以音律为修行根基的六大乐坊',
        maxLength: 200,
      },
      {
        key: 'constraints',
        label: '约束与禁忌',
        type: 'textarea',
        required: false,
        placeholder: '必须遵守的世界观规则、战力上限或不可触碰的禁忌',
        maxLength: 2_000,
      },
      {
        key: 'count',
        label: '生成数量',
        type: 'number',
        required: false,
        min: 1,
        max: 3,
        defaultValue: 2,
      },
    ],
  },
  {
    id: 'golden-finger-designer',
    name: '金手指 / 外挂系统设计',
    category: 'planning',
    summary: '设计带明确代价与成长曲线的金手指，避免开局无敌导致战力崩坏。',
    defaultRole: 'showrunner',
    supportsBookContext: true,
    applyTargets: ['knowledge_card', 'book_outline'],
    defaultCardCategory: 'item',
    fields: [
      {
        key: 'powerStyle',
        label: '金手指形态',
        type: 'select',
        required: true,
        options: [
          { value: '系统面板', label: '系统面板' },
          { value: '神秘古宝', label: '神秘古宝' },
          { value: '天赋词条', label: '天赋词条' },
          { value: '模拟推演', label: '模拟推演' },
          { value: '特殊血脉', label: '特殊血脉' },
          { value: '自定义机制', label: '自定义机制' },
        ],
        defaultValue: '神秘古宝',
      },
      {
        key: 'coreMechanic',
        label: '核心机制',
        type: 'textarea',
        required: true,
        placeholder: '触发条件、能力范围与成长方式',
        maxLength: 2_000,
      },
      {
        key: 'limitation',
        label: '代价与限制',
        type: 'textarea',
        required: false,
        placeholder: '使用代价、冷却、反噬或道德困境（可留空让 AI 设计）',
        maxLength: 1_000,
      },
      {
        key: 'count',
        label: '生成数量',
        type: 'number',
        required: false,
        min: 1,
        max: 3,
        defaultValue: 2,
      },
    ],
  },
  {
    id: 'plot-hook-brainstorm',
    name: '剧情冲突与章尾钩子脑暴',
    category: 'drafting',
    summary: '卡文时快速给出可直接落笔的冲突升级路径与章尾强钩子。',
    defaultRole: 'showrunner',
    supportsBookContext: true,
    applyTargets: ['knowledge_card', 'book_outline'],
    defaultCardCategory: 'foreshadowing',
    fields: [
      {
        key: 'currentSituation',
        label: '当前剧情进展',
        type: 'textarea',
        required: true,
        placeholder: '主角现状、已埋伏笔与当前矛盾焦点',
        maxLength: 3_000,
      },
      {
        key: 'conflictType',
        label: '冲突类型',
        type: 'select',
        required: true,
        options: [
          { value: '打脸反转', label: '打脸反转' },
          { value: '危机升级', label: '危机升级' },
          { value: '秘密揭晓', label: '秘密揭晓' },
          { value: '感情拉扯', label: '感情拉扯' },
          { value: '悬念章尾钩子', label: '悬念章尾钩子' },
        ],
        defaultValue: '危机升级',
      },
      {
        key: 'count',
        label: '生成数量',
        type: 'number',
        required: false,
        min: 1,
        max: 5,
        defaultValue: 3,
      },
    ],
  },
  {
    id: 'text-polish-diagnose',
    name: '片段文本质检与润色建议',
    category: 'drafting',
    summary: '诊断节奏、水文与视角问题，并给出可直接替换的润色方向。',
    defaultRole: 'critic',
    supportsBookContext: true,
    applyTargets: ['knowledge_card'],
    defaultCardCategory: 'world',
    fields: [
      {
        key: 'excerpt',
        label: '待诊断片段',
        type: 'textarea',
        required: true,
        placeholder: '粘贴 1–3 段正文，建议 2000 字以内以保证诊断精度',
        maxLength: 6_000,
      },
      {
        key: 'focus',
        label: '诊断侧重',
        type: 'select',
        required: true,
        options: [
          { value: '综合诊断与节奏', label: '综合诊断与节奏' },
          { value: '去除水文与重复', label: '去除水文与重复' },
          { value: '增强画面感与张力', label: '增强画面感与张力' },
          { value: '对话口吻强化', label: '对话口吻强化' },
        ],
        defaultValue: '综合诊断与节奏',
      },
    ],
  },
] as const satisfies readonly ToolboxToolDefinition[];

/** 按需建立索引，避免每次查询都线性扫描目录。 */
const TOOLBOX_TOOL_INDEX: Readonly<Record<string, ToolboxToolDefinition>> = Object.fromEntries(
  TOOLBOX_TOOL_DEFINITIONS.map((definition) => [definition.id, definition]),
);

/**
 * 按工具 ID 查询声明式定义（未知 ID 返回 `undefined`，
 * 调用方据此返回 `TOOLBOX_TOOL_NOT_FOUND`）。
 */
export function getToolboxToolDefinition(toolId: string): ToolboxToolDefinition | undefined {
  return TOOLBOX_TOOL_INDEX[toolId];
}

/** 判断字符串是否为合法的内置工具 ID（供外部输入快速收敛）。 */
export function isToolboxToolId(toolId: string): toolId is ToolboxToolId {
  return TOOLBOX_TOOL_INDEX[toolId] !== undefined;
}
