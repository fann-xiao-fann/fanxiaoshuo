import { API_ERROR_CODES, USAGE_SCENES, type AgentRole } from '@fanxiaoshuo/shared';
import { Mastra } from '@mastra/core';
import { Agent } from '@mastra/core/agent';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import { ModelGateway } from '../gateway/model-gateway.js';
import { asRecord, ModelGatewayError } from '../gateway/errors.js';
import { sanitizeErrorMessage } from '../gateway/sanitize.js';
import {
  resolvedModelConfigSchema,
  type ResolvedModelConfig,
  type UsageLogger,
} from '../gateway/types.js';
import {
  WRITING_AGENT_DEFINITIONS,
  getWritingAgentDefinition,
  type WritingAgentDefinition,
} from './roles.js';

/** Mastra 冒烟 Workflow 的固定 ID。 */
export const SMOKE_WORKFLOW_ID = 'fanxiaoshuo-runtime-smoke';

/**
 * 角色 Agent 的占位模型标识。
 * 真实调用由 `ModelGateway` + `agent_role_bindings` 按角色解析模型，
 * 这里的占位仅用于在 Mastra 中注册 Agent 实例（不发起网络请求）。
 */
export const DEFAULT_ROLE_MODEL_PLACEHOLDER = 'openai/gpt-4o-mini';

/** 冒烟工作流模式。 */
export type SmokeWorkflowMode = 'echo' | 'live';

/** `runSmokeWorkflow` 入参。 */
export interface SmokeWorkflowInput {
  /**
   * `echo`：只验证 Mastra 编排与状态流转，不调用外部模型（不产生费用）；
   * `live`：经 Mastra Workflow 调用 `ModelGateway.generateText` 完成真实模型对话。
   */
  readonly mode: SmokeWorkflowMode;
  /** `live` 模式必填：由 server / worker 从角色绑定解析出的模型配置 */
  readonly modelConfig?: ResolvedModelConfig;
  /** 自定义提示词；省略时使用默认冒烟文案 */
  readonly message?: string;
}

/** 冒烟工作流输入校验（Worker 任务负载边界）。 */
export const smokeWorkflowInputSchema = z.strictObject({
  mode: z.enum(['echo', 'live']),
  modelConfig: resolvedModelConfigSchema.optional(),
  message: z.string().trim().min(1).max(2000).optional(),
});

/** 单个 Mastra Step 的耗时信息。 */
export interface SmokeWorkflowStepTiming {
  readonly stepId: string;
  readonly status: string;
  readonly latencyMs: number;
}

/** `runSmokeWorkflow` 的稳定返回结构（不含 Mastra 内部类型）。 */
export interface SmokeWorkflowResult {
  readonly engine: 'mastra';
  readonly workflowId: string;
  readonly runId: string;
  readonly mode: SmokeWorkflowMode;
  /** echo 模式回显文本 / live 模式的模型原始输出 */
  readonly message: string;
  /** live 模式的模型输出预览；echo 模式为 null */
  readonly replyPreview: string | null;
  /** live 模式为 `provider/modelId`；echo 模式为 null */
  readonly modelRef: string | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly estimatedCostUsd: number;
  /** 仅模型调用耗时；echo 模式为 null */
  readonly modelLatencyMs: number | null;
  readonly totalDurationMs: number;
  readonly steps: readonly SmokeWorkflowStepTiming[];
}

/** 运行时门面：只暴露业务方法，绝不泄露 Mastra 实例或内部类型。 */
export interface FanXiaoshuoRuntime {
  readonly engine: 'mastra';
  readonly workflowId: string;
  readonly gateway: ModelGateway;
  readonly agentRoles: readonly WritingAgentDefinition[];
  readonly registeredAgentIds: readonly AgentRole[];
  /** 读取角色元信息与默认系统提示词 */
  getAgentRoleDefinition(role: AgentRole): WritingAgentDefinition;
  /** 执行 Mastra + Gateway 全链路冒烟工作流 */
  runSmokeWorkflow(input: SmokeWorkflowInput): Promise<SmokeWorkflowResult>;
}

/** `createFanXiaoshuoRuntime` 参数。 */
export interface FanXiaoshuoRuntimeOptions {
  /** 复用外部网关（server / worker 已注入 Drizzle 用量日志实现时优先传入） */
  readonly gateway?: ModelGateway;
  /** 未传 `gateway` 时用于构造网关的用量日志回调 */
  readonly usageLogger?: UsageLogger;
  /** 覆盖角色 Agent 的占位模型标识（默认 `openai/gpt-4o-mini`） */
  readonly roleModelPlaceholder?: string;
}

/** 冒烟工作流输入不合法（例如 live 模式缺少模型配置）。 */
export class SmokeWorkflowInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SmokeWorkflowInputError';
  }
}

const prepareOutputSchema = z.object({
  mode: z.enum(['echo', 'live']),
  message: z.string().min(1).max(2000),
  modelConfig: resolvedModelConfigSchema.nullable(),
  startedAt: z.number().int().nonnegative(),
});

const executeOutputSchema = z.object({
  mode: z.enum(['echo', 'live']),
  message: z.string().min(1).max(2000),
  replyPreview: z.string().max(2000).nullable(),
  modelRef: z.string().min(1).max(256).nullable(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  estimatedCostUsd: z.number().nonnegative(),
  modelLatencyMs: z.number().int().nonnegative().nullable(),
  startedAt: z.number().int().nonnegative(),
});

const finalizeOutputSchema = z.object({
  mode: z.enum(['echo', 'live']),
  message: z.string().min(1).max(2000),
  replyPreview: z.string().max(2000).nullable(),
  modelRef: z.string().min(1).max(256).nullable(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  estimatedCostUsd: z.number().nonnegative(),
  modelLatencyMs: z.number().int().nonnegative().nullable(),
  totalDurationMs: z.number().int().nonnegative(),
});

const DEFAULT_ECHO_MESSAGE = '「梵小说」Mastra 运行时冒烟：echo pipeline ok';
const DEFAULT_LIVE_MESSAGE = '请只回复 OK，用于确认梵小说模型网关连通性。';

/**
 * 构造 AI SDK / Mastra 运行时门面。
 *
 * 同一次进程内建议复用单个实例（server / worker 各一个），
 * 以便复用网关与 Mastra 引擎状态。
 */
export function createFanXiaoshuoRuntime(
  options: FanXiaoshuoRuntimeOptions = {},
): FanXiaoshuoRuntime {
  const gateway =
    options.gateway ??
    new ModelGateway({
      ...(options.usageLogger === undefined ? {} : { usageLogger: options.usageLogger }),
    });
  const roleModelPlaceholder = options.roleModelPlaceholder ?? DEFAULT_ROLE_MODEL_PLACEHOLDER;

  const agents: Record<string, Agent> = {};
  for (const definition of WRITING_AGENT_DEFINITIONS) {
    agents[definition.role] = new Agent({
      id: definition.role,
      name: definition.label,
      description: definition.responsibility,
      instructions: definition.systemPrompt,
      model: roleModelPlaceholder,
    });
  }

  const prepareStep = createStep({
    id: 'prepare',
    inputSchema: smokeWorkflowInputSchema,
    outputSchema: prepareOutputSchema,
    execute: async ({ inputData }) => {
      if (inputData.mode === 'live' && !inputData.modelConfig) {
        throw new SmokeWorkflowInputError('live 模式必须提供 modelConfig。');
      }
      const message =
        inputData.message ??
        (inputData.mode === 'live' ? DEFAULT_LIVE_MESSAGE : DEFAULT_ECHO_MESSAGE);
      return {
        mode: inputData.mode,
        message,
        modelConfig: inputData.modelConfig ?? null,
        startedAt: Date.now(),
      };
    },
  });

  const executeStep = createStep({
    id: 'execute',
    inputSchema: prepareOutputSchema,
    outputSchema: executeOutputSchema,
    execute: async ({ inputData }) => {
      if (inputData.mode === 'echo') {
        return {
          mode: 'echo' as const,
          message: inputData.message,
          replyPreview: null,
          modelRef: null,
          inputTokens: 0,
          outputTokens: 0,
          estimatedCostUsd: 0,
          modelLatencyMs: null,
          startedAt: inputData.startedAt,
        };
      }

      const modelConfig = inputData.modelConfig;
      if (!modelConfig) {
        throw new SmokeWorkflowInputError('live 模式必须提供 modelConfig。');
      }

      const result = await gateway.generateText({
        config: modelConfig,
        scene: USAGE_SCENES.smokeJob,
        prompt: inputData.message,
        maxOutputTokens: 256,
        temperature: 0.2,
        timeoutMs: 30_000,
      });

      return {
        mode: 'live' as const,
        message: result.text,
        replyPreview: result.text.length > 2000 ? result.text.slice(0, 2000) : result.text,
        modelRef: result.modelRef,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        estimatedCostUsd: result.estimatedCostUsd,
        modelLatencyMs: result.latencyMs,
        startedAt: inputData.startedAt,
      };
    },
  });

  const finalizeStep = createStep({
    id: 'finalize',
    inputSchema: executeOutputSchema,
    outputSchema: finalizeOutputSchema,
    execute: async ({ inputData }) => ({
      mode: inputData.mode,
      message: inputData.message,
      replyPreview: inputData.replyPreview,
      modelRef: inputData.modelRef,
      inputTokens: inputData.inputTokens,
      outputTokens: inputData.outputTokens,
      estimatedCostUsd: inputData.estimatedCostUsd,
      modelLatencyMs: inputData.modelLatencyMs,
      totalDurationMs: Math.max(0, Date.now() - inputData.startedAt),
    }),
  });

  const workflow = createWorkflow({
    id: SMOKE_WORKFLOW_ID,
    inputSchema: smokeWorkflowInputSchema,
    outputSchema: finalizeOutputSchema,
  })
    .then(prepareStep)
    .then(executeStep)
    .then(finalizeStep)
    .commit();

  const mastra = new Mastra({
    agents,
    workflows: { [SMOKE_WORKFLOW_ID]: workflow },
    logger: false,
  });

  // 启动期自检：确保 4 个角色与工作流均已成功注册（失败则尽早暴露）。
  const registeredAgentIds = WRITING_AGENT_DEFINITIONS.map((definition) => definition.role);
  for (const role of registeredAgentIds) {
    if (!mastra.getAgent(role)) {
      throw new Error(`Mastra Agent 注册失败：${role}`);
    }
  }
  if (!mastra.getWorkflow(SMOKE_WORKFLOW_ID)) {
    throw new Error(`Mastra Workflow 注册失败：${SMOKE_WORKFLOW_ID}`);
  }

  return {
    engine: 'mastra',
    workflowId: SMOKE_WORKFLOW_ID,
    gateway,
    agentRoles: WRITING_AGENT_DEFINITIONS,
    registeredAgentIds,
    getAgentRoleDefinition: getWritingAgentDefinition,
    async runSmokeWorkflow(input: SmokeWorkflowInput): Promise<SmokeWorkflowResult> {
      const parsed = smokeWorkflowInputSchema.parse(input);
      if (parsed.mode === 'live' && !parsed.modelConfig) {
        throw new SmokeWorkflowInputError('live 模式必须提供 modelConfig。');
      }

      const workflowInstance = mastra.getWorkflow(SMOKE_WORKFLOW_ID);
      const run = await workflowInstance.createRun();
      const result = await run.start({ inputData: parsed });

      if (result.status !== 'success') {
        const cause = 'error' in result ? result.error : undefined;
        throw new ModelGatewayError(
          sanitizeErrorMessage(
            cause ?? `Mastra 冒烟工作流状态异常：${result.status}`,
            parsed.modelConfig ? [parsed.modelConfig.apiKey] : [],
          ),
          {
            category: 'PROVIDER_ERROR',
            code: API_ERROR_CODES.INTERNAL_ERROR,
            cause,
          },
        );
      }

      const output = result.result;
      return {
        engine: 'mastra',
        workflowId: SMOKE_WORKFLOW_ID,
        runId: run.runId,
        mode: output.mode,
        message: output.message,
        replyPreview: output.replyPreview,
        modelRef: output.modelRef,
        inputTokens: output.inputTokens,
        outputTokens: output.outputTokens,
        estimatedCostUsd: output.estimatedCostUsd,
        modelLatencyMs: output.modelLatencyMs,
        totalDurationMs: output.totalDurationMs,
        steps: extractStepTimings(result.steps),
      };
    },
  };
}

/**
 * 从 Mastra 运行结果中提取各 Step 的耗时。
 * 仅暴露 stepId/status/latencyMs，避免 Mastra 类型泄漏到包外。
 */
function extractStepTimings(steps: unknown): SmokeWorkflowStepTiming[] {
  const record = asRecord(steps);
  if (!record) {
    return [];
  }

  const timings: SmokeWorkflowStepTiming[] = [];
  for (const [stepId, rawStep] of Object.entries(record)) {
    if (stepId === 'input') {
      continue;
    }
    const step = asRecord(rawStep);
    if (!step) {
      continue;
    }
    const startedAt = typeof step.startedAt === 'number' ? step.startedAt : null;
    const endedAt = typeof step.endedAt === 'number' ? step.endedAt : null;
    timings.push({
      stepId,
      status: typeof step.status === 'string' ? step.status : 'unknown',
      latencyMs:
        startedAt !== null && endedAt !== null ? Math.max(0, Math.trunc(endedAt - startedAt)) : 0,
    });
  }
  return timings;
}
