import type { AgentRole } from '@fanxiaoshuo/shared';
import type {
  GatewayUsageSummary,
  ResolvedModelConfig,
  UsageLogRecordInput,
  UsageLogger,
  UsageLogStatus,
} from './types.js';
import type { ApiErrorCode } from '@fanxiaoshuo/shared';
import { calculateEstimatedCostUsd } from './cost.js';

/** AI SDK 的 `LanguageModelUsage` 兼容投影（仅取网关需要的两个字段）。 */
export interface RawTokenUsage {
  readonly inputTokens?: number | null | undefined;
  readonly outputTokens?: number | null | undefined;
}

/** 把上游可能为 `undefined` / 小数的 Token 数归一化为非负整数。 */
export function normalizeTokenCount(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.trunc(value);
}

/** 从 AI SDK usage 中提取 Token 数并计算费用。 */
export function summarizeUsage(
  usage: RawTokenUsage | null | undefined,
  config: ResolvedModelConfig,
): GatewayUsageSummary {
  const inputTokens = normalizeTokenCount(usage?.inputTokens);
  const outputTokens = normalizeTokenCount(usage?.outputTokens);
  return {
    inputTokens,
    outputTokens,
    estimatedCostUsd: calculateEstimatedCostUsd(
      inputTokens,
      outputTokens,
      config.inputPricePer1m,
      config.outputPricePer1m,
    ),
  };
}

/** 构造账本使用的模型快照 `provider/modelId`。 */
export function buildModelRef(config: ResolvedModelConfig): string {
  return `${config.providerName}/${config.modelId}`;
}

/** 将成功调用归一化为用量日志记录。 */
export function buildSuccessUsageLog(options: {
  config: ResolvedModelConfig;
  role: AgentRole | null;
  scene: string;
  usage: GatewayUsageSummary;
  latencyMs: number;
}): UsageLogRecordInput {
  return buildUsageLog({
    config: options.config,
    role: options.role,
    scene: options.scene,
    usage: options.usage,
    latencyMs: options.latencyMs,
    status: 'success',
    errorCode: null,
    errorMessage: null,
  });
}

/** 将失败调用归一化为用量日志记录（错误摘要必须已脱敏）。 */
export function buildFailureUsageLog(options: {
  config: ResolvedModelConfig;
  role: AgentRole | null;
  scene: string;
  latencyMs: number;
  errorCode: ApiErrorCode;
  errorMessage: string;
}): UsageLogRecordInput {
  return buildUsageLog({
    config: options.config,
    role: options.role,
    scene: options.scene,
    usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
    latencyMs: options.latencyMs,
    status: 'error',
    errorCode: options.errorCode,
    errorMessage: options.errorMessage,
  });
}

function buildUsageLog(options: {
  config: ResolvedModelConfig;
  role: AgentRole | null;
  scene: string;
  usage: GatewayUsageSummary;
  latencyMs: number;
  status: UsageLogStatus;
  errorCode: ApiErrorCode | null;
  errorMessage: string | null;
}): UsageLogRecordInput {
  return {
    role: options.role,
    providerId: options.config.providerId,
    modelRef: buildModelRef(options.config),
    scene: options.scene,
    inputTokens: options.usage.inputTokens,
    outputTokens: options.usage.outputTokens,
    estimatedCostUsd: options.usage.estimatedCostUsd,
    latencyMs: Math.max(0, Math.trunc(options.latencyMs)),
    status: options.status,
    errorCode: options.errorCode,
    errorMessage: options.errorMessage,
  };
}

/** 调用注入的 `usageLogger`（未注入时静默跳过，便于纯本地单测）。 */
export async function emitUsageLog(
  logger: UsageLogger | undefined,
  record: UsageLogRecordInput,
): Promise<void> {
  if (!logger) {
    return;
  }
  await logger(record);
}

/** 截断文本预览（`TestModelResponse.replyPreview` 上限 2000）。 */
export function truncatePreview(text: string, maxLength = 2000): string {
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}
