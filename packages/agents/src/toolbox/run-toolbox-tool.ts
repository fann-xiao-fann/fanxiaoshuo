import {
  USAGE_SCENES,
  getToolboxToolDefinition,
  validateToolboxInputs,
  type AgentRole,
  type ApiErrorIssue,
  type ToolboxInputs,
  type ToolboxOutput,
  type ToolboxToolId,
} from '@fanxiaoshuo/shared';
import type { LanguageModel } from 'ai';
import type { ModelGateway } from '../gateway/model-gateway.js';
import type { ResolvedModelConfig } from '../gateway/types.js';
import {
  buildToolboxPrompts,
  parseToolboxOutput,
  resolveToolboxRecommendedCategory,
  type ToolboxBookContext,
} from '../prompts/toolbox.js';

/**
 * 创作工具盒执行引擎。
 *
 * 一次工具运行 = 输入校验 + 构造 Prompt + **一次** `ModelGateway.generateText` + 结构化解析。
 * 所有模型调用 100% 经统一网关，自动以 `toolbox-run` 场景落盘 `llm_usage_logs`，
 * 上游 `ModelGatewayError` 原样透传（错误信息已由网关脱敏，绝不泄露明文 API Key）。
 */

/** `runToolboxTool` 入参。 */
export interface RunToolboxToolInput {
  readonly toolId: ToolboxToolId;
  /** 实际执行的写书角色（决定调用的模型，默认由调用方取工具的 `defaultRole`） */
  readonly role: AgentRole;
  /** 动态表单原始输入（本函数内部会再做一次边界防御校验） */
  readonly inputs: ToolboxInputs;
  /** 已解析的模型配置（由 Server 从模型配置中心解密后传入） */
  readonly config: ResolvedModelConfig;
  /** 可选关联作品上下文（书名 / 总大纲 / 核心设定卡） */
  readonly bookContext?: ToolboxBookContext | null;
  readonly temperature?: number;
  /** 单次输出 Token 上限（`null` / 省略表示不限制） */
  readonly maxOutputTokens?: number | null;
  readonly abortSignal?: AbortSignal;
  /** 测试注入用 Mock 模型；生产代码不应传入 */
  readonly languageModelOverride?: LanguageModel;
}

/** `runToolboxTool` 出参（可直接写入 `toolbox_runs`）。 */
export interface RunToolboxToolResult {
  readonly toolId: ToolboxToolId;
  readonly role: AgentRole;
  /** 校验归一后的输入（含默认值补全） */
  readonly inputs: ToolboxInputs;
  readonly output: ToolboxOutput;
  /** `provider/modelId` 快照 */
  readonly modelRef: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly estimatedCostUsd: number;
  readonly latencyMs: number;
}

/**
 * 工具输入不合法时抛出的错误（在调用模型之前失败，不产生任何 Token 消耗）。
 * `issues` 可直接作为服务端 `VALIDATION_ERROR` 的 `details` 返回。
 */
export class ToolboxInputError extends Error {
  readonly toolId: ToolboxToolId;
  readonly issues: readonly ApiErrorIssue[];

  constructor(toolId: ToolboxToolId, issues: readonly ApiErrorIssue[]) {
    const detail = issues.map((issue) => `${issue.path}: ${issue.message}`).join('；');
    super(`创作工具「${toolId}」输入校验失败${detail ? `：${detail}` : ''}`);
    this.name = 'ToolboxInputError';
    this.toolId = toolId;
    this.issues = issues;
  }
}

/**
 * 执行一次创作工具。
 *
 * 流程：`validateToolboxInputs` 边界防御 → 构造 Prompt（注入可选 Book Bible 上下文）
 * → `gateway.generateText`（`scene = toolbox-run`）→ `parseToolboxOutput` 结构化归一。
 *
 * @throws {ToolboxInputError} 工具 ID 或表单输入不合法（未发起模型调用）
 * @throws {ModelGatewayError} 上游模型错误（原样透传，已脱敏）
 */
export async function runToolboxTool(
  gateway: ModelGateway,
  input: RunToolboxToolInput,
): Promise<RunToolboxToolResult> {
  const definition = getToolboxToolDefinition(input.toolId);
  if (!definition) {
    throw new ToolboxInputError(input.toolId, [
      { path: 'toolId', message: '未知的创作工具' },
    ]);
  }

  const validation = validateToolboxInputs(input.toolId, input.inputs);
  if (!validation.ok) {
    throw new ToolboxInputError(input.toolId, validation.issues);
  }

  const inputs = validation.data;
  const preferredCategory = resolveToolboxRecommendedCategory(input.toolId, inputs);
  const prompts = buildToolboxPrompts({
    toolId: input.toolId,
    inputs,
    bookContext: input.bookContext ?? null,
  });

  const maxOutputTokens = input.maxOutputTokens ?? null;

  const result = await gateway.generateText({
    config: input.config,
    role: input.role,
    scene: USAGE_SCENES.toolboxRun,
    system: prompts.system,
    prompt: prompts.prompt,
    ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
    ...(maxOutputTokens === null ? {} : { maxOutputTokens }),
    ...(input.abortSignal === undefined ? {} : { abortSignal: input.abortSignal }),
    ...(input.languageModelOverride === undefined
      ? {}
      : { languageModelOverride: input.languageModelOverride }),
  });

  return {
    toolId: input.toolId,
    role: input.role,
    inputs,
    output: parseToolboxOutput(result.text, input.toolId, preferredCategory),
    modelRef: result.modelRef,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    estimatedCostUsd: result.estimatedCostUsd,
    latencyMs: result.latencyMs,
  };
}
