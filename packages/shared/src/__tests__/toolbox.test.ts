import { describe, expect, it } from 'vitest';
import { AGENT_ROLES } from '../constants/agent-roles.js';
import { KNOWLEDGE_CARD_CATEGORIES } from '../constants/book-bible.js';
import { USAGE_SCENES, USAGE_SCENE_LABELS, resolveUsageSceneLabel } from '../constants/runtime.js';
import {
  TOOLBOX_APPLY_TARGETS,
  TOOLBOX_CATEGORIES,
  TOOLBOX_CATEGORY_LABELS,
  TOOLBOX_FIELD_TYPES,
  TOOLBOX_OUTLINE_APPLY_MODES,
  TOOLBOX_OUTLINE_FIELDS,
  TOOLBOX_OUTLINE_FIELD_LABELS,
  TOOLBOX_RUN_STATUSES,
  TOOLBOX_TOOL_DEFINITIONS,
  TOOLBOX_TOOL_IDS,
  getToolboxToolDefinition,
  isToolboxToolId,
  type ToolboxFieldDefinition,
  type ToolboxToolDefinition,
  type ToolboxToolId,
} from '../constants/toolbox.js';
import { API_ERROR_CODES, API_ERROR_HTTP_STATUS, apiErrorStatus } from '../errors.js';
import type { ApiErrorIssue } from '../errors.js';
import {
  MAX_TOOLBOX_ITEM_INDEX,
  applyToolboxCardRequestSchema,
  applyToolboxOutlineRequestSchema,
  runToolboxRequestSchema,
  toolboxApplyTargetSchema,
  toolboxCategorySchema,
  toolboxFieldOptionSchema,
  toolboxFieldSchema,
  toolboxFieldTypeSchema,
  toolboxOutputSchema,
  toolboxOutlineApplyModeSchema,
  toolboxOutlineFieldSchema,
  toolboxResultItemSchema,
  toolboxRunDetailSchema,
  toolboxRunListQuerySchema,
  toolboxRunListResponseSchema,
  toolboxRunStatusSchema,
  toolboxRunSummarySchema,
  toolboxToolDefinitionSchema,
  toolboxToolIdSchema,
  toolboxToolsResponseSchema,
  validateToolboxInputs,
  type ToolboxInputValidationResult,
} from '../schemas/toolbox.js';

/* -------------------------------------------------------------------------- */
/*                                  测试工具                                   */
/* -------------------------------------------------------------------------- */

const DEFINITIONS: readonly ToolboxToolDefinition[] = TOOLBOX_TOOL_DEFINITIONS;

const BOOK_ID = '0f2a1b3c-4d5e-4f60-8a91-b2c3d4e5f601';
const RUN_ID = '1a2b3c4d-5e6f-4a70-8b92-c3d4e5f60712';

/** 按声明式目录构造一份「只填必填项」的合法输入。 */
function buildMinimalInputs(toolId: ToolboxToolId): Record<string, string | number> {
  const definition = getToolboxToolDefinition(toolId);
  if (!definition) {
    throw new Error(`测试夹具缺失工具定义：${toolId}`);
  }
  const inputs: Record<string, string | number> = {};
  for (const field of definition.fields as readonly ToolboxFieldDefinition[]) {
    if (!field.required) {
      continue;
    }
    if (field.type === 'select') {
      const firstOption = field.options?.[0];
      if (!firstOption) {
        throw new Error(`工具 ${toolId} 的 select 字段 ${field.key} 缺少选项`);
      }
      inputs[field.key] = firstOption.value;
    } else if (field.type === 'number') {
      inputs[field.key] = field.min ?? 1;
    } else {
      inputs[field.key] = `${field.label}示例`;
    }
  }
  return inputs;
}

function expectValidationOk(result: ToolboxInputValidationResult): Record<string, string | number> {
  if (!result.ok) {
    throw new Error(`预期校验通过，实际失败：${JSON.stringify(result.issues)}`);
  }
  return result.data;
}

function expectValidationFailed(result: ToolboxInputValidationResult): ApiErrorIssue[] {
  if (result.ok) {
    throw new Error('预期校验失败，实际通过');
  }
  return result.issues;
}

/** 找出第一个指定类型的字段（测试按类型驱动，无需为每个工具写死字段名）。 */
function findField(
  definition: ToolboxToolDefinition,
  predicate: (field: ToolboxFieldDefinition) => boolean,
): ToolboxFieldDefinition {
  const field = (definition.fields as readonly ToolboxFieldDefinition[]).find(predicate);
  if (!field) {
    throw new Error(`工具 ${definition.id} 缺少测试所需字段`);
  }
  return field;
}

function buildRunSummary(): Record<string, unknown> {
  return {
    id: RUN_ID,
    toolId: 'book-pitch',
    toolName: '书名与简介策划',
    bookId: BOOK_ID,
    role: 'showrunner',
    status: 'completed',
    overview: '围绕都市异能给出 3 套书名与简介组合。',
    itemCount: 3,
    modelRef: 'openai/gpt-4o-mini',
    inputTokens: 1_200,
    outputTokens: 800,
    estimatedCostUsd: 0.001234,
    latencyMs: 4_321,
    errorCode: null,
    errorMessage: null,
    createdAt: '2025-02-01T10:00:00.000Z',
  };
}

function buildRunOutput(): Record<string, unknown> {
  return {
    overview: '三套备选方案',
    items: [
      {
        title: '《深夜支票簿》',
        summary: '开局继承神秘账户，每一笔支出都要付出记忆。',
        content: '完整简介正文……',
        aliases: ['支票簿'],
        tags: ['都市', '异能'],
        suggestedCardCategory: 'world',
      },
    ],
  };
}

/* -------------------------------------------------------------------------- */
/*                          运行期常量：场景中文标签                             */
/* -------------------------------------------------------------------------- */

describe('Change 5 用量场景与中文标签', () => {
  it('USAGE_SCENES 新增 toolbox-run 且与既有场景不冲突', () => {
    expect(USAGE_SCENES.toolboxRun).toBe('toolbox-run');
    expect(new Set(Object.values(USAGE_SCENES)).size).toBe(7);
  });

  it('USAGE_SCENE_LABELS 与 USAGE_SCENES 的真实取值 100% 键对齐', () => {
    const sceneValues = Object.values(USAGE_SCENES);
    expect(Object.keys(USAGE_SCENE_LABELS).sort()).toEqual([...sceneValues].sort());
    for (const scene of sceneValues) {
      const label = USAGE_SCENE_LABELS[scene];
      expect(typeof label).toBe('string');
      expect(label.length).toBeGreaterThan(0);
      // 标签必须是中文，禁止把英文标识漏到前端
      expect(/[\u4e00-\u9fa5]/.test(label)).toBe(true);
    }
  });

  it('7 个场景的中文名称与设计文档一致', () => {
    expect(USAGE_SCENE_LABELS['connectivity-test']).toBe('一键测通');
    expect(USAGE_SCENE_LABELS['smoke-job']).toBe('冒烟任务');
    expect(USAGE_SCENE_LABELS['chapter-write']).toBe('章节成文');
    expect(USAGE_SCENE_LABELS['lore-extract']).toBe('设定抽取');
    expect(USAGE_SCENE_LABELS['chapter-review']).toBe('审稿质检');
    expect(USAGE_SCENE_LABELS['outline-plan']).toBe('细纲规划');
    expect(USAGE_SCENE_LABELS['toolbox-run']).toBe('创作工具盒');
  });

  it('resolveUsageSceneLabel 对未知场景原样兜底', () => {
    expect(resolveUsageSceneLabel('toolbox-run')).toBe('创作工具盒');
    expect(resolveUsageSceneLabel('legacy-scene')).toBe('legacy-scene');
  });
});

/* -------------------------------------------------------------------------- */
/*                                  错误码                                     */
/* -------------------------------------------------------------------------- */

describe('Change 5 创作工具盒专用错误码', () => {
  it('新增错误码字面量与值一致', () => {
    expect(API_ERROR_CODES.TOOLBOX_TOOL_NOT_FOUND).toBe('TOOLBOX_TOOL_NOT_FOUND');
    expect(API_ERROR_CODES.TOOLBOX_RUN_NOT_FOUND).toBe('TOOLBOX_RUN_NOT_FOUND');
    expect(API_ERROR_CODES.TOOLBOX_ITEM_OUT_OF_RANGE).toBe('TOOLBOX_ITEM_OUT_OF_RANGE');
  });

  it('HTTP 状态映射符合契约（404 / 404 / 400）', () => {
    expect(API_ERROR_HTTP_STATUS.TOOLBOX_TOOL_NOT_FOUND).toBe(404);
    expect(API_ERROR_HTTP_STATUS.TOOLBOX_RUN_NOT_FOUND).toBe(404);
    expect(API_ERROR_HTTP_STATUS.TOOLBOX_ITEM_OUT_OF_RANGE).toBe(400);
    expect(apiErrorStatus('TOOLBOX_TOOL_NOT_FOUND')).toBe(404);
    expect(apiErrorStatus('TOOLBOX_RUN_NOT_FOUND')).toBe(404);
    expect(apiErrorStatus('TOOLBOX_ITEM_OUT_OF_RANGE')).toBe(400);
  });
});

/* -------------------------------------------------------------------------- */
/*                            工具目录与声明式元数据                             */
/* -------------------------------------------------------------------------- */

describe('创作工具盒声明式目录', () => {
  it('枚举字面量与设计文档一致', () => {
    expect(TOOLBOX_CATEGORIES).toEqual(['planning', 'worldbuilding', 'drafting']);
    expect(TOOLBOX_CATEGORY_LABELS.planning).toBe('立项策划');
    expect(TOOLBOX_CATEGORY_LABELS.worldbuilding).toBe('设定构建');
    expect(TOOLBOX_CATEGORY_LABELS.drafting).toBe('剧情与质检');
    expect(TOOLBOX_FIELD_TYPES).toEqual(['text', 'textarea', 'select', 'number']);
    expect(TOOLBOX_APPLY_TARGETS).toEqual(['knowledge_card', 'book_outline']);
    expect(TOOLBOX_RUN_STATUSES).toEqual(['completed', 'failed']);
    expect(TOOLBOX_OUTLINE_FIELDS).toEqual([
      'mainPlot',
      'worldSetting',
      'styleGuide',
      'endingPlan',
    ]);
    expect(TOOLBOX_OUTLINE_APPLY_MODES).toEqual(['append', 'replace']);
    expect(TOOLBOX_OUTLINE_FIELD_LABELS.mainPlot).toBe('核心主线');
  });

  it('6 个内置工具 ID 顺序与唯一性符合契约', () => {
    expect(TOOLBOX_TOOL_IDS).toEqual([
      'book-pitch',
      'character-designer',
      'world-faction-builder',
      'golden-finger-designer',
      'plot-hook-brainstorm',
      'text-polish-diagnose',
    ]);
    expect(DEFINITIONS.map((definition) => definition.id)).toEqual([...TOOLBOX_TOOL_IDS]);
  });

  it('全部 6 个工具目录均能通过 toolboxToolDefinitionSchema 校验', () => {
    expect(DEFINITIONS).toHaveLength(6);
    for (const definition of DEFINITIONS) {
      const parsed = toolboxToolDefinitionSchema.parse(definition);
      expect(parsed.id).toBe(definition.id);
      expect(parsed.fields.length).toBe(definition.fields.length);
    }
    expect(toolboxToolsResponseSchema.parse({ tools: DEFINITIONS }).tools).toHaveLength(6);
  });

  it('每个工具的默认角色 / 分类 / 回写目标 / 推荐卡片分类均在白名单内', () => {
    for (const definition of DEFINITIONS) {
      expect(AGENT_ROLES).toContain(definition.defaultRole);
      expect(TOOLBOX_CATEGORIES).toContain(definition.category);
      expect(KNOWLEDGE_CARD_CATEGORIES).toContain(definition.defaultCardCategory);
      expect(definition.applyTargets.length).toBeGreaterThan(0);
      expect(new Set(definition.applyTargets).size).toBe(definition.applyTargets.length);
      for (const target of definition.applyTargets) {
        expect(TOOLBOX_APPLY_TARGETS).toContain(target);
      }
      expect(definition.name.length).toBeGreaterThan(0);
      expect(definition.summary.length).toBeGreaterThan(0);
    }
  });

  it('字段键唯一、select 必有白名单选项、number 区间合法、默认值命中选项', () => {
    for (const definition of DEFINITIONS) {
      const keys = definition.fields.map((field) => field.key);
      expect(new Set(keys).size).toBe(keys.length);

      for (const field of definition.fields as readonly ToolboxFieldDefinition[]) {
        expect(TOOLBOX_FIELD_TYPES).toContain(field.type);

        if (field.type === 'select') {
          const options = field.options ?? [];
          expect(options.length).toBeGreaterThan(0);
          const values = options.map((option) => option.value);
          expect(new Set(values).size).toBe(values.length);
          if (field.defaultValue !== undefined) {
            expect(values).toContain(field.defaultValue);
          }
        }

        if (field.type === 'number') {
          if (field.min !== undefined && field.max !== undefined) {
            expect(field.max).toBeGreaterThanOrEqual(field.min);
          }
          if (field.defaultValue !== undefined) {
            expect(typeof field.defaultValue).toBe('number');
          }
        }

        if (field.type === 'text' || field.type === 'textarea') {
          expect(field.maxLength).toBeGreaterThan(0);
        }
      }
    }
  });

  it('getToolboxToolDefinition / isToolboxToolId 正确收敛未知 ID', () => {
    expect(getToolboxToolDefinition('book-pitch')?.defaultRole).toBe('showrunner');
    expect(getToolboxToolDefinition('character-designer')?.defaultRole).toBe('lorekeeper');
    expect(getToolboxToolDefinition('text-polish-diagnose')?.defaultRole).toBe('critic');
    expect(getToolboxToolDefinition('unknown-tool')).toBeUndefined();
    expect(getToolboxToolDefinition('')).toBeUndefined();

    expect(isToolboxToolId('golden-finger-designer')).toBe(true);
    expect(isToolboxToolId('golden-finger')).toBe(false);
  });

  it('目录枚举 Schema 拒绝未知取值', () => {
    expect(toolboxCategorySchema.safeParse('planning').success).toBe(true);
    expect(toolboxCategorySchema.safeParse('marketing').success).toBe(false);
    expect(toolboxToolIdSchema.safeParse('book-pitch').success).toBe(true);
    expect(toolboxToolIdSchema.safeParse('book-pitch-v2').success).toBe(false);
    expect(toolboxFieldTypeSchema.safeParse('rich-text').success).toBe(false);
    expect(toolboxApplyTargetSchema.safeParse('clipboard').success).toBe(false);
    expect(toolboxRunStatusSchema.safeParse('running').success).toBe(false);
    expect(toolboxOutlineFieldSchema.safeParse('mainPlot').success).toBe(true);
    expect(toolboxOutlineFieldSchema.safeParse('subPlot').success).toBe(false);
    expect(toolboxOutlineApplyModeSchema.safeParse('append').success).toBe(true);
    expect(toolboxOutlineApplyModeSchema.safeParse('prepend').success).toBe(false);
  });

  it('目录 Schema 拒绝非法字段定义（未知键 / 空选项 / 缺 key）', () => {
    expect(toolboxFieldOptionSchema.safeParse({ value: '', label: '空' }).success).toBe(false);
    expect(toolboxFieldOptionSchema.safeParse({ value: 'a', label: 'b', extra: 1 }).success).toBe(
      false,
    );
    expect(
      toolboxFieldSchema.safeParse({
        key: 'Bad-Key',
        label: '非法键',
        type: 'text',
        required: true,
        maxLength: 10,
      }).success,
    ).toBe(false);
    expect(
      toolboxFieldSchema.safeParse({
        key: 'audience',
        label: '目标读者',
        type: 'select',
        required: true,
        options: [],
      }).success,
    ).toBe(false);
    expect(
      toolboxToolDefinitionSchema.safeParse({
        id: 'book-pitch',
        name: '书名',
        category: 'planning',
        summary: '说明',
        defaultRole: 'showrunner',
        supportsBookContext: true,
        applyTargets: [],
        defaultCardCategory: 'world',
        fields: [],
      }).success,
    ).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*                              动态输入校验函数                                */
/* -------------------------------------------------------------------------- */

describe('validateToolboxInputs', () => {
  it('6 个工具的最小合法输入均通过并补全默认值', () => {
    for (const definition of DEFINITIONS) {
      const minimal = buildMinimalInputs(definition.id);
      const data = expectValidationOk(validateToolboxInputs(definition.id, minimal));

      for (const field of definition.fields as readonly ToolboxFieldDefinition[]) {
        if (field.required) {
          expect(data[field.key]).toBeDefined();
        } else if (field.defaultValue !== undefined) {
          expect(data[field.key]).toBe(field.defaultValue);
        } else {
          expect(data[field.key]).toBeUndefined();
        }
      }

      // 校验产物必须能直接通过执行请求 DTO 的 inputs 校验
      expect(
        runToolboxRequestSchema.safeParse({
          toolId: definition.id,
          inputs: data,
        }).success,
      ).toBe(true);
    }
  });

  it('文本字段会 trim 首尾空白后落库', () => {
    const inputs = buildMinimalInputs('book-pitch');
    const genre = findField(getToolboxToolDefinition('book-pitch')!, (field) => field.key === 'genre');
    inputs.genre = `  ${'都市异能'}  `;
    const data = expectValidationOk(validateToolboxInputs('book-pitch', inputs));
    const value = data.genre;
    expect(value).toBe('都市异能');
    expect(typeof value === 'string' && value === value.trim()).toBe(true);
    expect(genre.type).toBe('text');
  });

  it('可选数字字段允许字符串数字（表单直传）并归一为 number', () => {
    const inputs = buildMinimalInputs('book-pitch');
    inputs.count = '4';
    const data = expectValidationOk(validateToolboxInputs('book-pitch', inputs));
    expect(data.count).toBe(4);
  });

  it('必填缺失时拒绝并给出字段级 issue（spec：character-designer 缺 archetype）', () => {
    for (const definition of DEFINITIONS) {
      const minimal = buildMinimalInputs(definition.id);
      const requiredField = findField(
        definition,
        (field) => field.required && field.type !== 'number',
      );
      delete minimal[requiredField.key];

      const issues = expectValidationFailed(validateToolboxInputs(definition.id, minimal));
      expect(issues.some((issue) => issue.path === `inputs.${requiredField.key}`)).toBe(true);
    }

    const issues = expectValidationFailed(
      validateToolboxInputs('character-designer', { rolePosition: '主角' }),
    );
    expect(issues.map((issue) => issue.path)).toContain('inputs.archetype');

    const runParsed = runToolboxRequestSchema.safeParse({
      toolId: 'character-designer',
      inputs: { rolePosition: '主角' },
    });
    // DTO 本身不做动态字段校验（由服务端调用 validateToolboxInputs 完成）
    expect(runParsed.success).toBe(true);
    expect(validateToolboxInputs('character-designer', runParsed.data!.inputs).ok).toBe(false);
  });

  it('必填字段为纯空白时视为缺失', () => {
    const inputs = buildMinimalInputs('book-pitch');
    inputs.genre = '   ';
    const issues = expectValidationFailed(validateToolboxInputs('book-pitch', inputs));
    expect(issues.some((issue) => issue.path === 'inputs.genre')).toBe(true);
  });

  it('文本超长被拒绝', () => {
    for (const definition of DEFINITIONS) {
      const field = findField(
        definition,
        (item) => (item.type === 'text' || item.type === 'textarea') && item.maxLength !== undefined,
      );
      const inputs = buildMinimalInputs(definition.id);
      inputs[field.key] = '长'.repeat((field.maxLength ?? 0) + 1);
      const issues = expectValidationFailed(validateToolboxInputs(definition.id, inputs));
      expect(issues.some((issue) => issue.path === `inputs.${field.key}`)).toBe(true);
    }
  });

  it('未知字段被拒绝（不允许前端残留旧字段静默通过）', () => {
    const inputs = buildMinimalInputs('book-pitch');
    inputs.legacyField = '旧字段';
    const issues = expectValidationFailed(validateToolboxInputs('book-pitch', inputs));
    expect(issues.some((issue) => issue.path === 'inputs.legacyField')).toBe(true);
  });

  it('非白名单下拉选项被拒绝', () => {
    for (const definition of DEFINITIONS) {
      const field = findField(definition, (item) => item.type === 'select');
      const inputs = buildMinimalInputs(definition.id);
      inputs[field.key] = '不存在的选项';
      const issues = expectValidationFailed(validateToolboxInputs(definition.id, inputs));
      expect(issues.some((issue) => issue.path === `inputs.${field.key}`)).toBe(true);
    }
  });

  it('数字字段越界 / 非整数 / 非数字被拒绝', () => {
    const definition = getToolboxToolDefinition('book-pitch')!;
    const countField = findField(definition, (field) => field.type === 'number');
    const min = countField.min ?? 1;
    const max = countField.max ?? 5;

    for (const invalid of [min - 1, max + 1, min + 0.5, 'abc', Number.NaN]) {
      const inputs = buildMinimalInputs('book-pitch');
      inputs.count = invalid;
      expect(validateToolboxInputs('book-pitch', inputs).ok).toBe(false);
    }

    // 边界值本身合法
    for (const valid of [min, max]) {
      const inputs = buildMinimalInputs('book-pitch');
      inputs.count = valid;
      expect(expectValidationOk(validateToolboxInputs('book-pitch', inputs)).count).toBe(valid);
    }
  });

  it('文本字段收到数字时拒绝', () => {
    const inputs = buildMinimalInputs('book-pitch');
    inputs.genre = 42;
    const issues = expectValidationFailed(validateToolboxInputs('book-pitch', inputs));
    expect(issues.some((issue) => issue.path === 'inputs.genre')).toBe(true);
  });

  it('未知 toolId 返回 toolId issue（服务端据此映射 TOOLBOX_TOOL_NOT_FOUND）', () => {
    const issues = expectValidationFailed(
      validateToolboxInputs('not-a-tool' as ToolboxToolId, { any: 'x' }),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe('toolId');
  });
});

/* -------------------------------------------------------------------------- */
/*                              结构化产出 Schema                              */
/* -------------------------------------------------------------------------- */

describe('toolboxOutputSchema', () => {
  it('接受完整产出并保留全部条目字段', () => {
    const parsed = toolboxOutputSchema.parse(buildRunOutput());
    expect(parsed.overview).toBe('三套备选方案');
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0]?.title).toBe('《深夜支票簿》');
    expect(parsed.items[0]?.aliases).toEqual(['支票簿']);
    expect(parsed.items[0]?.suggestedCardCategory).toBe('world');
  });

  it('overview 缺省为空串，条目可选字段补空数组 / 空串', () => {
    const parsed = toolboxOutputSchema.parse({
      items: [{ title: '单条结果', suggestedCardCategory: 'character' }],
    });
    expect(parsed.overview).toBe('');
    expect(parsed.items[0]?.summary).toBe('');
    expect(parsed.items[0]?.content).toBe('');
    expect(parsed.items[0]?.aliases).toEqual([]);
    expect(parsed.items[0]?.tags).toEqual([]);
  });

  it('条目数量必须为 1–10，标题非空，分类合法', () => {
    expect(toolboxOutputSchema.safeParse({ items: [] }).success).toBe(false);
    expect(
      toolboxOutputSchema.safeParse({
        items: Array.from({ length: 11 }, (_value, index) => ({
          title: `条目 ${index}`,
          suggestedCardCategory: 'world',
        })),
      }).success,
    ).toBe(false);
    expect(toolboxOutputSchema.safeParse({ items: [{ title: '   ', suggestedCardCategory: 'world' }] }).success).toBe(false);
    expect(
      toolboxOutputSchema.safeParse({
        items: [{ title: '标题', suggestedCardCategory: 'unknown' }],
      }).success,
    ).toBe(false);
  });

  it('结果条目拒绝未知字段（防止模型幻觉字段污染契约）', () => {
    expect(
      toolboxResultItemSchema.safeParse({
        title: '标题',
        suggestedCardCategory: 'world',
        hallucinated: true,
      }).success,
    ).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*                             执行 / 查询 DTO                                  */
/* -------------------------------------------------------------------------- */

describe('runToolboxRequestSchema', () => {
  it('接受最小请求与可选字段组合', () => {
    const minimal = runToolboxRequestSchema.parse({
      toolId: 'book-pitch',
      inputs: { genre: '都市异能', coreHook: '开局继承神秘账户' },
    });
    expect(minimal.bookId).toBeUndefined();
    expect(minimal.role).toBeUndefined();

    const full = runToolboxRequestSchema.parse({
      toolId: 'character-designer',
      bookId: BOOK_ID,
      role: 'writer',
      inputs: { archetype: '落魄医修', count: 2 },
    });
    expect(full.bookId).toBe(BOOK_ID);
    expect(full.role).toBe('writer');

    const nullBook = runToolboxRequestSchema.parse({
      toolId: 'book-pitch',
      bookId: null,
      inputs: {},
    });
    expect(nullBook.bookId).toBeNull();
  });

  it('拒绝未知工具 / 非法 uuid / 非法角色 / 未知字段 / 非法 inputs 值', () => {
    expect(
      runToolboxRequestSchema.safeParse({ toolId: 'unknown', inputs: {} }).success,
    ).toBe(false);
    expect(
      runToolboxRequestSchema.safeParse({ toolId: 'book-pitch', bookId: 'not-uuid', inputs: {} })
        .success,
    ).toBe(false);
    expect(
      runToolboxRequestSchema.safeParse({ toolId: 'book-pitch', role: 'editor', inputs: {} })
        .success,
    ).toBe(false);
    expect(
      runToolboxRequestSchema.safeParse({ toolId: 'book-pitch', inputs: {}, extra: 1 }).success,
    ).toBe(false);
    expect(
      runToolboxRequestSchema.safeParse({ toolId: 'book-pitch', inputs: { flag: true } }).success,
    ).toBe(false);
    expect(runToolboxRequestSchema.safeParse({ toolId: 'book-pitch' }).success).toBe(false);
  });
});

describe('toolboxRunSummarySchema / toolboxRunDetailSchema', () => {
  it('摘要 DTO 接受完整字段并拒绝缺字段 / 未知字段', () => {
    const summary = toolboxRunSummarySchema.parse(buildRunSummary());
    expect(summary.status).toBe('completed');
    expect(summary.modelRef).toBe('openai/gpt-4o-mini');

    const { overview: _overview, ...withoutOverview } = buildRunSummary();
    expect(toolboxRunSummarySchema.safeParse(withoutOverview).success).toBe(false);
    expect(
      toolboxRunSummarySchema.safeParse({ ...buildRunSummary(), unexpected: 'x' }).success,
    ).toBe(false);
    expect(
      toolboxRunSummarySchema.safeParse({ ...buildRunSummary(), status: 'running' }).success,
    ).toBe(false);
    expect(
      toolboxRunSummarySchema.safeParse({ ...buildRunSummary(), bookId: null }).success,
    ).toBe(true);
    expect(
      toolboxRunSummarySchema.safeParse({ ...buildRunSummary(), output: buildRunOutput() }).success,
    ).toBe(false);
  });

  it('详情 DTO = 摘要 + inputs + output，失败记录 output 为 null', () => {
    const detail = toolboxRunDetailSchema.parse({
      ...buildRunSummary(),
      inputs: { genre: '都市异能', count: 3 },
      output: buildRunOutput(),
    });
    expect(detail.inputs.genre).toBe('都市异能');
    expect(detail.output?.items).toHaveLength(1);

    const failed = toolboxRunDetailSchema.parse({
      ...buildRunSummary(),
      status: 'failed',
      output: null,
      itemCount: 0,
      errorCode: 'UPSTREAM_TIMEOUT',
      errorMessage: '上游模型超时',
      inputs: {},
    });
    expect(failed.output).toBeNull();
    expect(failed.errorCode).toBe('UPSTREAM_TIMEOUT');

    expect(
      toolboxRunDetailSchema.safeParse({ ...buildRunSummary(), output: null }).success,
    ).toBe(false);
  });
});

describe('toolboxRunListQuerySchema / toolboxRunListResponseSchema', () => {
  it('空查询串套用分页默认值', () => {
    const parsed = toolboxRunListQuerySchema.parse({});
    expect(parsed.page).toBe(1);
    expect(parsed.pageSize).toBe(20);
    expect(parsed.toolId).toBeUndefined();
    expect(parsed.bookId).toBeUndefined();
    expect(parsed.status).toBeUndefined();
  });

  it('兼容 URL query string 的数字与空串（Fastify 行为）', () => {
    const parsed = toolboxRunListQuerySchema.parse({
      toolId: 'book-pitch',
      bookId: BOOK_ID,
      status: 'completed',
      page: '2',
      pageSize: '50',
    });
    expect(parsed.page).toBe(2);
    expect(parsed.pageSize).toBe(50);
    expect(parsed.toolId).toBe('book-pitch');

    const empty = toolboxRunListQuerySchema.parse({
      toolId: '',
      bookId: '',
      status: '',
      page: '',
      pageSize: '',
    });
    expect(empty.toolId).toBeUndefined();
    expect(empty.bookId).toBeUndefined();
    expect(empty.status).toBeUndefined();
    expect(empty.page).toBe(1);
    expect(empty.pageSize).toBe(20);
  });

  it('拒绝越界分页 / 非法筛选 / 未知查询参数', () => {
    expect(toolboxRunListQuerySchema.safeParse({ page: '0' }).success).toBe(false);
    expect(toolboxRunListQuerySchema.safeParse({ pageSize: '101' }).success).toBe(false);
    expect(toolboxRunListQuerySchema.safeParse({ pageSize: '0' }).success).toBe(false);
    expect(toolboxRunListQuerySchema.safeParse({ page: '1.5' }).success).toBe(false);
    expect(toolboxRunListQuerySchema.safeParse({ status: 'running' }).success).toBe(false);
    expect(toolboxRunListQuerySchema.safeParse({ toolId: 'unknown' }).success).toBe(false);
    expect(toolboxRunListQuerySchema.safeParse({ bookId: 'not-uuid' }).success).toBe(false);
    expect(toolboxRunListQuerySchema.safeParse({ keyword: '书名' }).success).toBe(false);
  });

  it('列表响应 DTO 校验 items / total / page / pageSize', () => {
    const response = toolboxRunListResponseSchema.parse({
      items: [buildRunSummary()],
      total: 1,
      page: 1,
      pageSize: 20,
    });
    expect(response.items).toHaveLength(1);
    expect(
      toolboxRunListResponseSchema.safeParse({ items: [], total: 0, page: 1 }).success,
    ).toBe(false);
    expect(
      toolboxRunListResponseSchema.safeParse({ items: [], total: -1, page: 1, pageSize: 20 })
        .success,
    ).toBe(false);
  });
});

describe('回写请求 DTO', () => {
  it('applyToolboxCardRequestSchema 校验 bookId / itemIndex / 可选覆盖项', () => {
    const parsed = applyToolboxCardRequestSchema.parse({ bookId: BOOK_ID, itemIndex: 0 });
    expect(parsed.category).toBeUndefined();
    expect(parsed.title).toBeUndefined();
    expect(parsed.pinned).toBeUndefined();

    const full = applyToolboxCardRequestSchema.parse({
      bookId: BOOK_ID,
      itemIndex: MAX_TOOLBOX_ITEM_INDEX,
      category: 'faction',
      title: '  覆盖标题  ',
      pinned: true,
    });
    expect(full.title).toBe('覆盖标题');
    expect(full.category).toBe('faction');
    expect(full.pinned).toBe(true);
  });

  it('applyToolboxCardRequestSchema 拒绝越界索引 / 非法分类 / 空标题 / 未知字段 / 非 uuid', () => {
    expect(MAX_TOOLBOX_ITEM_INDEX).toBe(9);
    for (const itemIndex of [-1, 10, 1.5]) {
      expect(
        applyToolboxCardRequestSchema.safeParse({ bookId: BOOK_ID, itemIndex }).success,
      ).toBe(false);
    }
    expect(
      applyToolboxCardRequestSchema.safeParse({
        bookId: BOOK_ID,
        itemIndex: 0,
        category: 'location',
      }).success,
    ).toBe(false);
    expect(
      applyToolboxCardRequestSchema.safeParse({ bookId: BOOK_ID, itemIndex: 0, title: '   ' })
        .success,
    ).toBe(false);
    expect(
      applyToolboxCardRequestSchema.safeParse({ bookId: BOOK_ID, itemIndex: 0, extra: 1 }).success,
    ).toBe(false);
    expect(
      applyToolboxCardRequestSchema.safeParse({ bookId: 'not-uuid', itemIndex: 0 }).success,
    ).toBe(false);
    expect(applyToolboxCardRequestSchema.safeParse({ itemIndex: 0 }).success).toBe(false);
  });

  it('applyToolboxOutlineRequestSchema 默认 append 写入模式', () => {
    const parsed = applyToolboxOutlineRequestSchema.parse({
      bookId: BOOK_ID,
      itemIndex: 2,
      field: 'mainPlot',
    });
    expect(parsed.mode).toBe('append');

    const replaced = applyToolboxOutlineRequestSchema.parse({
      bookId: BOOK_ID,
      itemIndex: 2,
      field: 'endingPlan',
      mode: 'replace',
    });
    expect(replaced.mode).toBe('replace');
  });

  it('applyToolboxOutlineRequestSchema 拒绝非法字段 / 写入模式 / 越界索引', () => {
    expect(
      applyToolboxOutlineRequestSchema.safeParse({
        bookId: BOOK_ID,
        itemIndex: 0,
        field: 'subPlot',
      }).success,
    ).toBe(false);
    expect(
      applyToolboxOutlineRequestSchema.safeParse({
        bookId: BOOK_ID,
        itemIndex: 0,
        field: 'mainPlot',
        mode: 'prepend',
      }).success,
    ).toBe(false);
    expect(
      applyToolboxOutlineRequestSchema.safeParse({
        bookId: BOOK_ID,
        itemIndex: 10,
        field: 'mainPlot',
      }).success,
    ).toBe(false);
    expect(
      applyToolboxOutlineRequestSchema.safeParse({
        bookId: BOOK_ID,
        itemIndex: 0,
        field: 'mainPlot',
        pinned: true,
      }).success,
    ).toBe(false);
  });
});
