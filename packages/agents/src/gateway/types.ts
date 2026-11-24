import type { ApiErrorCode, AgentRole, ProviderProtocol } from '@fanxiaoshuo/shared';
import { providerProtocolSchema } from '@fanxiaoshuo/shared';
import { z } from 'zod';

/**
 * 已解析的模型配置：由 `apps/server` 从数据库（provider + model + 解密密钥）解析后传入。
 * `packages/agents` 不接触数据库，只负责按该配置实例化上游客户端。
 */
export interface ResolvedModelConfig {
  /** `llm_providers.id` */
  readonly providerId: string;
  /** 供应商显示名，用于 `modelRef` 快照与日志 */
  readonly providerName: string;
  /** 上游协议，决定使用哪个 AI SDK Provider 适配器 */
  readonly protocol: ProviderProtocol;
  /** 上游 Base URL（已含 `/v1` 等版本前缀） */
  readonly baseUrl: string;
  /** 明文 API Key（仅在内存中短暂存在，严禁写入日志） */
  readonly apiKey: string;
  /** 上游模型标识，如 `gpt-4o-mini`、`deepseek-chat` */
  readonly modelId: string;
  readonly displayName: string;
  /** USD / 1M input tokens */
  readonly inputPricePer1m: number;
  /** USD / 1M output tokens */
  readonly outputPricePer1m: number;
}

/** 运行期模型配置校验（Worker 任务负载 / 边界输入使用）。 */
export const resolvedModelConfigSchema = z.strictObject({
  providerId: z.string().min(1).max(128),
  providerName: z.string().min(1).max(128),
  protocol: providerProtocolSchema,
  baseUrl: z.url({ protocol: /^https?$/ }).max(2048),
  apiKey: z.string().min(1).max(1024),
  modelId: z.string().min(1).max(128),
  displayName: z.string().min(1).max(128),
  inputPricePer1m: z.number().nonnegative(),
  outputPricePer1m: z.number().nonnegative(),
});

/** 用量日志状态（与 `llm_usage_logs.status` 对齐）。 */
export type UsageLogStatus = 'success' | 'error';

/**
 * 用量日志落盘入参（与 `llm_usage_logs` 表字段一一对齐）。
 * `scene` 使用 `USAGE_SCENES` 中的业务场景字面量。
 */
export interface UsageLogRecordInput {
  /** 写书角色；通用调用（测通 / 冒烟）为 null */
  readonly role: AgentRole | null;
  readonly providerId: string | null;
  /** 模型快照 `provider/modelId`，避免模型删除后账本失真 */
  readonly modelRef: string | null;
  readonly scene: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly estimatedCostUsd: number;
  readonly latencyMs: number | null;
  readonly status: UsageLogStatus;
  readonly errorCode: ApiErrorCode | null;
  /** 已脱敏错误摘要，禁止包含明文 API Key */
  readonly errorMessage: string | null;
}

/**
 * 用量日志落盘回调：由 `apps/server` / `apps/worker` 注入 Drizzle 写入实现。
 * 允许同步或异步返回；网关会在模型调用结束（成功或失败）后 `await` 该回调。
 */
export type UsageLogger = (record: UsageLogRecordInput) => Promise<void> | void;

/**
 * 运行预算上下文（Change 4 批量流水线会传入累计费用）。
 * 当 `maxCostUsd` 存在且 `spentCostUsd >= maxCostUsd` 时，网关会在调用上游前熔断。
 */
export interface BudgetContext {
  /** 批次 / 运行 ID，便于审计关联 */
  readonly runId?: string;
  /** 本运行允许的最大费用（USD） */
  readonly maxCostUsd?: number;
  /** 本运行已花费费用（USD） */
  readonly spentCostUsd?: number;
}

/** 单次模型调用可复用的上下文选项。 */
export interface GatewayCallOptions {
  /** 写书角色（用于用量日志归属）；通用调用传 null / 省略 */
  readonly role?: AgentRole | null;
  /** 业务场景，默认由具体方法指定（如 `connectivity-test`） */
  readonly scene?: string;
  /** 超时毫秒数；省略时使用网关默认值 */
  readonly timeoutMs?: number;
  /** 外部取消信号（与超时信号合并） */
  readonly abortSignal?: AbortSignal;
  /** 预算上下文（省略时使用网关默认预算） */
  readonly budgetContext?: BudgetContext;
  /** 覆盖网关构造时注入的用量日志回调 */
  readonly usageLogger?: UsageLogger;
  /** 采样温度 */
  readonly temperature?: number;
  /** 单次输出 Token 上限 */
  readonly maxOutputTokens?: number;
  /**
   * 测试注入用：直接使用指定 AI SDK LanguageModel，跳过 `createLanguageModel(config)`。
   * 生产代码不应传入。
   */
  readonly languageModelOverride?: import('ai').LanguageModel;
}

/** `ModelGateway.generateText` 入参。 */
export interface GatewayGenerateTextParams extends GatewayCallOptions {
  readonly config: ResolvedModelConfig;
  /** 单轮提示词（与 `messages` 二选一） */
  readonly prompt?: string;
  /** 多轮消息（与 `prompt` 二选一） */
  readonly messages?: import('ai').ModelMessage[];
  /** 系统提示词 */
  readonly system?: string;
}

/** 归一化后的 Token 用量与费用。 */
export interface GatewayUsageSummary {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly estimatedCostUsd: number;
}

/** `ModelGateway.generateText` 返回值（干净的业务结果，不泄露上游原始响应）。 */
export interface GatewayGenerateTextResult extends GatewayUsageSummary {
  readonly text: string;
  readonly finishReason: string;
  readonly latencyMs: number;
  /** `provider/modelId` 快照 */
  readonly modelRef: string;
  /** 本次调用对应的用量日志记录（已脱敏，可直接落盘核对） */
  readonly usageLog: UsageLogRecordInput;
}

/** `ModelGateway.streamText` 入参。 */
export interface GatewayStreamTextParams extends GatewayGenerateTextParams {}

/** `ModelGateway.streamText` 返回值。 */
export interface GatewayStreamTextResult {
  /** 纯文本增量流 */
  readonly textStream: AsyncIterable<string>;
  /** 全量结构化增量流（工具调用、推理等，类型由 AI SDK 决定） */
  readonly fullStream: AsyncIterable<unknown>;
  /** 结束后解析 Token / 费用；流消费完成后可用 */
  readonly usage: Promise<GatewayUsageSummary>;
  /** 结束原因（`stop` / `length` / `tool-calls` 等） */
  readonly finishReason: Promise<string>;
  /** `provider/modelId` 快照 */
  readonly modelRef: string;
  /** 停止计时器 / 取消上游请求 */
  readonly close: () => void;
}

/** `ModelGateway.testConnectivity` 可选参数。 */
export interface TestConnectivityOptions {
  /** 默认 20_000ms（测通必须快速失败） */
  readonly timeoutMs?: number;
  readonly usageLogger?: UsageLogger;
  readonly abortSignal?: AbortSignal;
  /** 测试注入用 Mock 模型 */
  readonly languageModelOverride?: import('ai').LanguageModel;
}

/** 连通性测试使用的轻量 Prompt。 */
export const CONNECTIVITY_TEST_PROMPT = 'Reply with OK';
