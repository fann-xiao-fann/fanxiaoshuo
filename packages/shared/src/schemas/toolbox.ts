import { z } from 'zod';
import { agentRoleSchema } from '../constants/agent-roles.js';
import { knowledgeCardCategorySchema } from '../constants/book-bible.js';
import { PAGINATION } from '../constants/runtime.js';
import {
  TOOLBOX_APPLY_TARGETS,
  TOOLBOX_CATEGORIES,
  TOOLBOX_FIELD_TYPES,
  TOOLBOX_OUTLINE_APPLY_MODES,
  TOOLBOX_OUTLINE_FIELDS,
  TOOLBOX_RUN_STATUSES,
  TOOLBOX_TOOL_IDS,
  getToolboxToolDefinition,
  type ToolboxToolId,
} from '../constants/toolbox.js';
import { apiErrorCodeSchema, type ApiErrorIssue } from '../errors.js';
import {
  isoDateTimeSchema,
  nonNegativeIntSchema,
  tokenCountSchema,
  trimmedText,
  usdAmountSchema,
  uuidSchema,
} from './primitives.js';

/**
 * 创作工具盒共享契约：工具目录 Schema、统一结构化产出、执行 / 查询 / 回写 DTO，
 * 以及动态表单输入校验函数 `validateToolboxInputs`。
 *
 * 所有请求体一律使用 `z.strictObject`，未知字段直接拒绝，避免前后端静默漂移。
 */

/* -------------------------------------------------------------------------- */
/*                                  枚举 Schema                                */
/* -------------------------------------------------------------------------- */

export const toolboxCategorySchema = z.enum(TOOLBOX_CATEGORIES);
export const toolboxToolIdSchema = z.enum(TOOLBOX_TOOL_IDS);
export const toolboxFieldTypeSchema = z.enum(TOOLBOX_FIELD_TYPES);
export const toolboxApplyTargetSchema = z.enum(TOOLBOX_APPLY_TARGETS);
export const toolboxRunStatusSchema = z.enum(TOOLBOX_RUN_STATUSES);
export const toolboxOutlineFieldSchema = z.enum(TOOLBOX_OUTLINE_FIELDS);
export const toolboxOutlineApplyModeSchema = z.enum(TOOLBOX_OUTLINE_APPLY_MODES);

export type ToolboxCategoryDto = z.infer<typeof toolboxCategorySchema>;
export type ToolboxToolIdDto = z.infer<typeof toolboxToolIdSchema>;
export type ToolboxFieldTypeDto = z.infer<typeof toolboxFieldTypeSchema>;
export type ToolboxApplyTargetDto = z.infer<typeof toolboxApplyTargetSchema>;
export type ToolboxRunStatusDto = z.infer<typeof toolboxRunStatusSchema>;
export type ToolboxOutlineFieldDto = z.infer<typeof toolboxOutlineFieldSchema>;
export type ToolboxOutlineApplyModeDto = z.infer<typeof toolboxOutlineApplyModeSchema>;

/* -------------------------------------------------------------------------- */
/*                                  目录 Schema                                */
/* -------------------------------------------------------------------------- */

/** 字段键：驼峰英文标识（禁止空键与特殊字符，保证前端表单绑定稳定）。 */
const TOOLBOX_FIELD_KEY_PATTERN = /^[a-z][a-zA-Z0-9]{0,39}$/;

/** 下拉选项最大数量（防御性上限，避免目录膨胀）。 */
const MAX_FIELD_OPTIONS_COUNT = 32;

/** 单个工具最大字段数量。 */
const MAX_TOOL_FIELDS_COUNT = 20;

/** 单次运行可回写的结果条目索引上限（与 `items` 最大条数对齐）。 */
export const MAX_TOOLBOX_ITEM_INDEX = 9;

/** 下拉字段选项。 */
export const toolboxFieldOptionSchema = z
  .strictObject({
    value: z.string().trim().min(1).max(64),
    label: z.string().trim().min(1).max(64),
  })
  .describe('工具表单下拉选项');

export type ToolboxFieldOptionDto = z.infer<typeof toolboxFieldOptionSchema>;

/** 动态表单字段定义。 */
export const toolboxFieldSchema = z
  .strictObject({
    key: z.string().regex(TOOLBOX_FIELD_KEY_PATTERN, '字段键必须是驼峰英文标识'),
    label: z.string().trim().min(1).max(40),
    type: toolboxFieldTypeSchema,
    required: z.boolean(),
    placeholder: z.string().max(200).optional(),
    help: z.string().max(500).optional(),
    /** 文本字段长度上限（`text` / `textarea` 专用） */
    maxLength: z.number().int().min(1).max(20_000).optional(),
    /** 下拉选项白名单（`select` 必填） */
    options: z.array(toolboxFieldOptionSchema).min(1).max(MAX_FIELD_OPTIONS_COUNT).optional(),
    /** 数字字段下界（`number` 专用，闭区间整数） */
    min: z.number().int().optional(),
    /** 数字字段上界（`number` 专用，闭区间整数） */
    max: z.number().int().optional(),
    defaultValue: z.union([z.string(), z.number()]).optional(),
  })
  .describe('工具动态表单字段定义');

export type ToolboxFieldDto = z.infer<typeof toolboxFieldSchema>;

/** 单个内置工具的声明式元数据。 */
export const toolboxToolDefinitionSchema = z
  .strictObject({
    id: toolboxToolIdSchema,
    name: z.string().trim().min(1).max(60),
    category: toolboxCategorySchema,
    summary: z.string().trim().min(1).max(300),
    defaultRole: agentRoleSchema,
    supportsBookContext: z.boolean(),
    applyTargets: z.array(toolboxApplyTargetSchema).min(1).max(TOOLBOX_APPLY_TARGETS.length),
    defaultCardCategory: knowledgeCardCategorySchema,
    fields: z.array(toolboxFieldSchema).min(1).max(MAX_TOOL_FIELDS_COUNT),
  })
  .describe('创作工具盒工具元数据');

export type ToolboxToolDefinitionDto = z.infer<typeof toolboxToolDefinitionSchema>;

/** `GET /api/v1/toolbox/tools` 响应：6 个内置工具的完整目录。 */
export const toolboxToolsResponseSchema = z
  .strictObject({
    tools: z.array(toolboxToolDefinitionSchema).length(TOOLBOX_TOOL_IDS.length),
  })
  .describe('创作工具盒工具目录响应');

export type ToolboxToolsResponse = z.infer<typeof toolboxToolsResponseSchema>;

/* -------------------------------------------------------------------------- */
/*                              结构化产出 Schema                               */
/* -------------------------------------------------------------------------- */

/** 结果条目标题长度上限。 */
const MAX_RESULT_TITLE_LENGTH = 120;

/** 结果条目摘要长度上限（卡片副标题，进入列表与设定卡摘要）。 */
const MAX_RESULT_SUMMARY_LENGTH = 500;

/** 结果条目正文长度上限。 */
const MAX_RESULT_CONTENT_LENGTH = 8_000;

/** 结果条目别名 / 标签数量与单条长度上限。 */
const MAX_RESULT_ALIASES_COUNT = 10;
const MAX_RESULT_ALIAS_LENGTH = 60;
const MAX_RESULT_TAGS_COUNT = 10;
const MAX_RESULT_TAG_LENGTH = 30;

/** 结果总览长度上限。 */
const MAX_RESULT_OVERVIEW_LENGTH = 2_000;

/** 单次运行最多返回的结果条目数量。 */
const MAX_RESULT_ITEMS_COUNT = 10;

/** 结构化结果条目（可直接回写为设定卡 / 写入大纲）。 */
export const toolboxResultItemSchema = z
  .strictObject({
    title: trimmedText(MAX_RESULT_TITLE_LENGTH),
    summary: z.string().max(MAX_RESULT_SUMMARY_LENGTH).default(''),
    content: z.string().max(MAX_RESULT_CONTENT_LENGTH).default(''),
    aliases: z.array(trimmedText(MAX_RESULT_ALIAS_LENGTH)).max(MAX_RESULT_ALIASES_COUNT).default([]),
    tags: z.array(trimmedText(MAX_RESULT_TAG_LENGTH)).max(MAX_RESULT_TAGS_COUNT).default([]),
    /** 推荐写入的设定卡分类（用户可在回写弹窗覆盖） */
    suggestedCardCategory: knowledgeCardCategorySchema,
  })
  .describe('创作工具盒结构化结果条目');

export type ToolboxResultItem = z.infer<typeof toolboxResultItemSchema>;

/**
 * 统一结构化产出：`overview` 为整体思路总览，`items` 为 1–10 条可直接落地的成果。
 * 6 个工具共用该契约，前端因此只需一套结果卡片渲染器。
 */
export const toolboxOutputSchema = z
  .strictObject({
    overview: z.string().max(MAX_RESULT_OVERVIEW_LENGTH).default(''),
    items: z.array(toolboxResultItemSchema).min(1).max(MAX_RESULT_ITEMS_COUNT),
  })
  .describe('创作工具盒统一结构化产出');

export type ToolboxOutput = z.infer<typeof toolboxOutputSchema>;

/* -------------------------------------------------------------------------- */
/*                               输入与校验函数                                 */
/* -------------------------------------------------------------------------- */

/** 动态表单提交值：文本 / 下拉为字符串，数量类为数字。 */
export const toolboxInputValueSchema = z.union([z.string(), z.number()]);

export type ToolboxInputValue = z.infer<typeof toolboxInputValueSchema>;

/** 动态表单提交值集合（键为字段 `key`）。 */
export const toolboxInputsSchema = z.record(z.string(), toolboxInputValueSchema);

export type ToolboxInputs = z.infer<typeof toolboxInputsSchema>;

/** `validateToolboxInputs` 的校验结果（判别式联合，`issues` 可直接作为 `ApiError.details`）。 */
export type ToolboxInputValidationResult =
  | { readonly ok: true; readonly data: ToolboxInputs }
  | { readonly ok: false; readonly issues: ApiErrorIssue[] };

/**
 * 按工具的声明式字段定义校验并归一化输入。
 *
 * 校验口径：
 * 1. 拒绝工具未声明的多余字段（防止前端残留旧字段被静默忽略）；
 * 2. `text` / `textarea`：`trim()` 后非空、长度不超过 `maxLength`；
 * 3. `select`：必须命中 `options` 白名单（提交原值，不做大小写宽松匹配）；
 * 4. `number`：必须是整数且落在 `[min, max]` 闭区间内（允许数字字符串，便于表单直传）；
 * 5. 省略的可选字段若定义了 `defaultValue` 则自动补全，其余字段不出现在 `data` 中。
 */
export function validateToolboxInputs(
  toolId: ToolboxToolId,
  rawInputs: ToolboxInputs,
): ToolboxInputValidationResult {
  const definition = getToolboxToolDefinition(toolId);
  if (!definition) {
    return { ok: false, issues: [{ path: 'toolId', message: '未知的创作工具' }] };
  }

  const issues: ApiErrorIssue[] = [];
  const declaredKeys = new Set(definition.fields.map((field) => field.key));

  for (const key of Object.keys(rawInputs)) {
    if (!declaredKeys.has(key)) {
      issues.push({ path: `inputs.${key}`, message: `「${toolId}」不接受该输入字段` });
    }
  }

  const data: ToolboxInputs = {};

  for (const field of definition.fields) {
    const raw = rawInputs[field.key];
    const path = `inputs.${field.key}`;
    const missing = raw === undefined || (typeof raw === 'string' && raw.trim() === '');

    if (missing) {
      if (field.required) {
        issues.push({ path, message: `「${field.label}」为必填项` });
      } else if (field.defaultValue !== undefined) {
        data[field.key] = field.defaultValue;
      }
      continue;
    }

    if (typeof raw !== 'string' && typeof raw !== 'number') {
      issues.push({ path, message: `「${field.label}」的输入值类型不合法` });
      continue;
    }

    switch (field.type) {
      case 'text':
      case 'textarea': {
        if (typeof raw !== 'string') {
          issues.push({ path, message: `「${field.label}」必须是文本` });
          break;
        }
        const value = raw.trim();
        if (field.maxLength !== undefined && value.length > field.maxLength) {
          issues.push({ path, message: `「${field.label}」最多 ${field.maxLength} 个字符` });
          break;
        }
        data[field.key] = value;
        break;
      }
      case 'select': {
        const optionValues = (field.options ?? []).map((option) => option.value);
        if (typeof raw !== 'string') {
          issues.push({ path, message: `「${field.label}」必须从预设选项中选择` });
          break;
        }
        const value = raw.trim();
        if (!optionValues.includes(value)) {
          issues.push({
            path,
            message: `「${field.label}」必须是以下选项之一：${optionValues.join(' / ')}`,
          });
          break;
        }
        data[field.key] = value;
        break;
      }
      case 'number': {
        const numeric = typeof raw === 'number' ? raw : Number(raw.trim());
        if (!Number.isFinite(numeric)) {
          issues.push({ path, message: `「${field.label}」必须是数字` });
          break;
        }
        if (!Number.isInteger(numeric)) {
          issues.push({ path, message: `「${field.label}」必须是整数` });
          break;
        }
        if (field.min !== undefined && numeric < field.min) {
          issues.push({ path, message: `「${field.label}」不能小于 ${field.min}` });
          break;
        }
        if (field.max !== undefined && numeric > field.max) {
          issues.push({ path, message: `「${field.label}」不能大于 ${field.max}` });
          break;
        }
        data[field.key] = numeric;
        break;
      }
      default: {
        issues.push({ path, message: `「${field.label}」的字段类型不受支持` });
      }
    }
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }
  return { ok: true, data };
}

/* -------------------------------------------------------------------------- */
/*                              执行请求与运行 DTO                              */
/* -------------------------------------------------------------------------- */

/** `POST /api/v1/toolbox/runs` 请求体。 */
export const runToolboxRequestSchema = z
  .strictObject({
    toolId: toolboxToolIdSchema,
    /** 可选关联书籍（注入 Book Bible 上下文，并在回写时提供默认目标） */
    bookId: uuidSchema.nullable().optional(),
    /** 覆盖工具默认角色；省略时取 `TOOLBOX_TOOL_DEFINITIONS[].defaultRole` */
    role: agentRoleSchema.optional(),
    inputs: toolboxInputsSchema,
  })
  .describe('执行创作工具请求');

export type RunToolboxRequest = z.infer<typeof runToolboxRequestSchema>;
export type RunToolboxRequestPayload = z.input<typeof runToolboxRequestSchema>;

/** 错误摘要长度上限（与 `llm_usage_logs.error_message` 保持一致）。 */
const MAX_TOOLBOX_ERROR_MESSAGE_LENGTH = 2_000;

/** 模型引用长度上限（`provider/modelId`）。 */
const MAX_MODEL_REF_LENGTH = 256;

/** 工具运行摘要 DTO（历史列表项与详情公共字段）。 */
export const toolboxRunSummarySchema = z
  .strictObject({
    id: uuidSchema,
    toolId: toolboxToolIdSchema,
    /** 工具中文名快照（工具目录调整后历史记录仍可读） */
    toolName: z.string().trim().min(1).max(60),
    /** 关联书籍（删书后保留历史，置为 null） */
    bookId: uuidSchema.nullable(),
    /** 实际执行的写书角色 */
    role: agentRoleSchema,
    status: toolboxRunStatusSchema,
    /** 产出总览（失败时为空串） */
    overview: z.string().max(MAX_RESULT_OVERVIEW_LENGTH),
    /** 产出条目数量（失败时为 0） */
    itemCount: nonNegativeIntSchema,
    modelRef: z.string().min(1).max(MAX_MODEL_REF_LENGTH).nullable(),
    inputTokens: tokenCountSchema,
    outputTokens: tokenCountSchema,
    estimatedCostUsd: usdAmountSchema,
    latencyMs: nonNegativeIntSchema,
    errorCode: apiErrorCodeSchema.nullable(),
    /** 已脱敏错误摘要，禁止包含明文 Key */
    errorMessage: z.string().max(MAX_TOOLBOX_ERROR_MESSAGE_LENGTH).nullable(),
    createdAt: isoDateTimeSchema,
  })
  .describe('创作工具盒运行摘要 DTO');

export type ToolboxRunSummary = z.infer<typeof toolboxRunSummarySchema>;

/** 工具运行详情 DTO：摘要 + 归一化输入 + 结构化产出（失败时为 null）。 */
export const toolboxRunDetailSchema = z
  .strictObject({
    ...toolboxRunSummarySchema.shape,
    inputs: toolboxInputsSchema,
    output: toolboxOutputSchema.nullable(),
  })
  .describe('创作工具盒运行详情 DTO');

export type ToolboxRunDetail = z.infer<typeof toolboxRunDetailSchema>;

/* -------------------------------------------------------------------------- */
/*                              列表查询与响应                                 */
/* -------------------------------------------------------------------------- */

/** 空字符串 / null 查询参数视为「未传」（Fastify 会把 `?toolId=` 解析为空串）。 */
function emptyToUndefined<S extends z.ZodType>(schema: S) {
  return z.preprocess((value) => (value === '' || value === null ? undefined : value), schema);
}

/** `GET /api/v1/toolbox/runs` 查询串（按工具 / 书籍 / 状态筛选 + 分页）。 */
export const toolboxRunListQuerySchema = z
  .strictObject({
    toolId: emptyToUndefined(toolboxToolIdSchema.optional()),
    bookId: emptyToUndefined(uuidSchema.optional()),
    status: emptyToUndefined(toolboxRunStatusSchema.optional()),
    /** 兼容 URL query string，统一用 `coerce` 转数字 */
    page: emptyToUndefined(z.coerce.number().int().min(1).default(PAGINATION.defaultPage)),
    pageSize: emptyToUndefined(
      z.coerce
        .number()
        .int()
        .min(1)
        .max(PAGINATION.maxPageSize)
        .default(PAGINATION.defaultPageSize),
    ),
  })
  .describe('创作工具盒运行历史分页查询');

export type ToolboxRunListQuery = z.infer<typeof toolboxRunListQuerySchema>;
export type ToolboxRunListQueryPayload = z.input<typeof toolboxRunListQuerySchema>;

/** `GET /api/v1/toolbox/runs` 响应（创建时间倒序）。 */
export const toolboxRunListResponseSchema = z
  .strictObject({
    items: z.array(toolboxRunSummarySchema),
    total: nonNegativeIntSchema,
    page: z.number().int().positive(),
    pageSize: z.number().int().positive(),
  })
  .describe('创作工具盒运行历史列表响应');

export type ToolboxRunListResponse = z.infer<typeof toolboxRunListResponseSchema>;

/* -------------------------------------------------------------------------- */
/*                                 回写请求体                                  */
/* -------------------------------------------------------------------------- */

/** `POST /api/v1/toolbox/runs/:runId/apply-card` 请求体（一键存为设定卡）。 */
export const applyToolboxCardRequestSchema = z
  .strictObject({
    bookId: uuidSchema,
    itemIndex: z.number().int().min(0).max(MAX_TOOLBOX_ITEM_INDEX),
    /** 覆盖推荐分类（省略时取条目的 `suggestedCardCategory`） */
    category: knowledgeCardCategorySchema.optional(),
    /** 覆盖标题（省略时取条目标题） */
    title: trimmedText(200).optional(),
    /** 是否置顶（省略时按服务端默认，不置顶） */
    pinned: z.boolean().optional(),
  })
  .describe('工具产出条目回写为设定卡请求');

export type ApplyToolboxCardRequest = z.infer<typeof applyToolboxCardRequestSchema>;
export type ApplyToolboxCardRequestPayload = z.input<typeof applyToolboxCardRequestSchema>;

/** `POST /api/v1/toolbox/runs/:runId/apply-outline` 请求体（一键写入全书总大纲）。 */
export const applyToolboxOutlineRequestSchema = z
  .strictObject({
    bookId: uuidSchema,
    itemIndex: z.number().int().min(0).max(MAX_TOOLBOX_ITEM_INDEX),
    field: toolboxOutlineFieldSchema,
    /** 追加（空行拼接，保留原内容）/ 替换 */
    mode: toolboxOutlineApplyModeSchema.default('append'),
  })
  .describe('工具产出条目写入全书总大纲请求');

export type ApplyToolboxOutlineRequest = z.infer<typeof applyToolboxOutlineRequestSchema>;
export type ApplyToolboxOutlineRequestPayload = z.input<typeof applyToolboxOutlineRequestSchema>;
