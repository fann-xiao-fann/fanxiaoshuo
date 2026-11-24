import { API_ERROR_CODES, USAGE_SCENES } from '@fanxiaoshuo/shared';
import {
  generateText as aiGenerateText,
  streamText as aiStreamText,
  type LanguageModel,
  type ModelMessage,
} from 'ai';
import { createLanguageModel } from './provider-factory.js';
import {
  BudgetExceededError,
  ModelGatewayError,
} from './errors.js';
import { sanitizeErrorMessage, toModelGatewayError } from './sanitize.js';
import {
  buildFailureUsageLog,
  buildModelRef,
  buildSuccessUsageLog,
  emitUsageLog,
  summarizeUsage,
  truncatePreview,
  type RawTokenUsage,
} from './usage.js';
import {
  CONNECTIVITY_TEST_PROMPT,
  type BudgetContext,
  type GatewayGenerateTextParams,
  type GatewayGenerateTextResult,
  type GatewayStreamTextParams,
  type GatewayStreamTextResult,
  type GatewayUsageSummary,
  type ResolvedModelConfig,
  type TestConnectivityOptions,
  type UsageLogger,
} from './types.js';
import type { TestModelResponse } from '@fanxiaoshuo/shared';

/** 普通调用的默认超时（毫秒）。 */
export const DEFAULT_GENERATE_TIMEOUT_MS = 60_000;
/** 一键测通的默认超时（必须快速失败，避免占用 API 线程）。 */
export const DEFAULT_CONNECTIVITY_TIMEOUT_MS = 20_000;
/** 普通调用默认场景。 */
const DEFAULT_SCENE = 'generate-text';

/** `ModelGateway` 构造参数。 */
export interface ModelGatewayOptions {
  /** 用量日志回调（server / worker 注入 Drizzle 写入实现） */
  readonly usageLogger?: UsageLogger;
  /** 默认预算上下文（批量流水线可覆盖） */
  readonly defaultBudgetContext?: BudgetContext;
  /** 默认超时毫秒数 */
  readonly defaultTimeoutMs?: number;
  /**
   * 模型工厂覆盖（测试注入 Mock 模型 / 未来接入自定义网关）。
   * 省略时使用内置 `createLanguageModel`。
   */
  readonly createLanguageModel?: (config: ResolvedModelConfig) => LanguageModel;
}

/**
 * 梵小说统一 LLM 调用网关。
 *
 * 所有模型调用（测通、冒烟、后续章节成文）必须经过本类，以保证：
 * - 统一 Provider 适配与超时/取消；
 * - 统一 Token 计量、费用估算与预算熔断；
 * - 成功与失败都写入不可篡改的用量日志（通过注入的 `usageLogger`）；
 * - 错误信息脱敏，绝不泄露明文 API Key。
 */
export class ModelGateway {
  private readonly usageLogger?: UsageLogger;
  private readonly defaultBudgetContext?: BudgetContext;
  private readonly defaultTimeoutMs: number;
  private readonly modelFactory: (config: ResolvedModelConfig) => LanguageModel;

  constructor(options: ModelGatewayOptions = {}) {
    this.usageLogger = options.usageLogger;
    this.defaultBudgetContext = options.defaultBudgetContext;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_GENERATE_TIMEOUT_MS;
    this.modelFactory = options.createLanguageModel ?? createLanguageModel;
  }

  /** 按配置创建 AI SDK LanguageModel（供高级场景直接复用）。 */
  createLanguageModel(config: ResolvedModelConfig): LanguageModel {
    return this.modelFactory(config);
  }

  /**
   * 一次性文本生成。成功或失败都会触发一次用量日志写入。
   *
   * @throws {ModelGatewayError} 上游错误（已脱敏、已分类）
   * @throws {BudgetExceededError} 预算已耗尽（调用未发出）
   */
  async generateText(params: GatewayGenerateTextParams): Promise<GatewayGenerateTextResult> {
    const { config } = params;
    const role = params.role ?? null;
    const scene = params.scene ?? DEFAULT_SCENE;
    const usageLogger = params.usageLogger ?? this.usageLogger;
    const startedAt = Date.now();

    this.assertBudget(params.budgetContext ?? this.defaultBudgetContext);

    const timeout = createTimeoutController(
      params.timeoutMs ?? this.defaultTimeoutMs,
      params.abortSignal,
    );

    let response: Awaited<ReturnType<typeof aiGenerateText>>;
    try {
      const model = params.languageModelOverride ?? this.modelFactory(config);
      response = await aiGenerateText(this.buildRequest(model, params, timeout.signal));
    } catch (error) {
      const latencyMs = Date.now() - startedAt;
      const gatewayError = timeout.didTimeout()
        ? new ModelGatewayError(
            `上游请求超时（${params.timeoutMs ?? this.defaultTimeoutMs}ms），已终止本次调用。`,
            { category: 'PROVIDER_TIMEOUT', cause: error },
          )
        : toModelGatewayError(error, [config.apiKey]);

      const failureLog = buildFailureUsageLog({
        config,
        role,
        scene,
        latencyMs,
        errorCode: gatewayError.code,
        errorMessage: sanitizeErrorMessage(gatewayError, [config.apiKey]),
      });
      // 日志写入失败不能覆盖上游原始错误（否则排查方向被误导）。
      try {
        await emitUsageLog(usageLogger, failureLog);
      } catch {
        // 由注入方负责告警；此处保留原始上游错误。
      }
      throw gatewayError;
    } finally {
      timeout.cleanup();
    }

    const latencyMs = Date.now() - startedAt;
    const usage = summarizeUsage(response.usage, config);
    const usageLog = buildSuccessUsageLog({ config, role, scene, usage, latencyMs });

    await this.persistUsageOrThrow(usageLogger, usageLog);

    return {
      text: response.text,
      finishReason: String(response.finishReason),
      latencyMs,
      modelRef: buildModelRef(config),
      ...usage,
      usageLog,
    };
  }

  /**
   * 流式文本生成：返回文本增量流与结束后的 Token/费用统计。
   * 用量日志在流正常结束（或失败）时写入。
   */
  streamText(params: GatewayStreamTextParams): GatewayStreamTextResult {
    const { config } = params;
    const role = params.role ?? null;
    const scene = params.scene ?? DEFAULT_SCENE;
    const usageLogger = params.usageLogger ?? this.usageLogger;
    const startedAt = Date.now();

    this.assertBudget(params.budgetContext ?? this.defaultBudgetContext);
    const timeout = createTimeoutController(
      params.timeoutMs ?? this.defaultTimeoutMs,
      params.abortSignal,
    );

    let model: LanguageModel;
    let request: Parameters<typeof aiStreamText>[0];
    try {
      model = params.languageModelOverride ?? this.modelFactory(config);
      request = this.buildRequest(model, params, timeout.signal);
    } catch (error) {
      timeout.cleanup();
      throw toModelGatewayError(error, [config.apiKey]);
    }

    let failureLogged = false;
    const result = aiStreamText({
      ...request,
      onError: ({ error }: { error: unknown }) => {
        if (failureLogged) {
          return;
        }
        failureLogged = true;
        const gatewayError = timeout.didTimeout()
          ? new ModelGatewayError(
              `上游流式请求超时（${params.timeoutMs ?? this.defaultTimeoutMs}ms）。`,
              { category: 'PROVIDER_TIMEOUT', cause: error },
            )
          : toModelGatewayError(error, [config.apiKey]);
        const failureLog = buildFailureUsageLog({
          config,
          role,
          scene,
          latencyMs: Date.now() - startedAt,
          errorCode: gatewayError.code,
          errorMessage: sanitizeErrorMessage(gatewayError, [config.apiKey]),
        });
        void emitUsageLog(usageLogger, failureLog).catch(() => {
          // 保留流式错误本身，不因日志失败产生新的未处理拒绝。
        });
      },
    });

    const usagePromise: Promise<GatewayUsageSummary> = Promise.resolve(result.usage).then(
      async (raw: RawTokenUsage) => {
        const usage = summarizeUsage(raw, config);
        timeout.cleanup();
        if (!failureLogged) {
          const successLog = buildSuccessUsageLog({
            config,
            role,
            scene,
            usage,
            latencyMs: Date.now() - startedAt,
          });
          await emitUsageLog(usageLogger, successLog).catch(() => {
            // 流式路径的日志失败不应中断调用方消费。
          });
        }
        return usage;
      },
      (error: unknown) => {
        timeout.cleanup();
        throw toModelGatewayError(error, [config.apiKey]);
      },
    );

    return {
      textStream: result.textStream,
      fullStream: result.fullStream as AsyncIterable<unknown>,
      usage: usagePromise,
      finishReason: Promise.resolve(result.finishReason).then((reason) => String(reason)),
      modelRef: buildModelRef(config),
      close: () => {
        timeout.abort();
        timeout.cleanup();
      },
    };
  }

  /**
   * 一键连通性测试：真实调用一次轻量 Prompt，并落盘审计日志。
   * 永远返回结构化结果（不抛错），错误信息已脱敏。
   */
  async testConnectivity(
    config: ResolvedModelConfig,
    options: TestConnectivityOptions = {},
  ): Promise<TestModelResponse> {
    const startedAt = Date.now();
    const timeoutMs = options.timeoutMs ?? DEFAULT_CONNECTIVITY_TIMEOUT_MS;

    try {
      const result = await this.generateText({
        config,
        scene: USAGE_SCENES.connectivityTest,
        role: null,
        prompt: CONNECTIVITY_TEST_PROMPT,
        maxOutputTokens: 32,
        temperature: 0,
        timeoutMs,
        ...(options.usageLogger === undefined ? {} : { usageLogger: options.usageLogger }),
        ...(options.abortSignal === undefined ? {} : { abortSignal: options.abortSignal }),
        ...(options.languageModelOverride === undefined
          ? {}
          : { languageModelOverride: options.languageModelOverride }),
      });

      return {
        success: true,
        replyPreview: truncatePreview(result.text),
        latencyMs: result.latencyMs,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        estimatedCostUsd: result.estimatedCostUsd,
        errorCode: null,
        errorMessage: null,
      };
    } catch (error) {
      const gatewayError = toModelGatewayError(error, [config.apiKey]);
      return {
        success: false,
        replyPreview: null,
        latencyMs: Math.max(0, Date.now() - startedAt),
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostUsd: 0,
        errorCode: gatewayError.code,
        errorMessage: sanitizeErrorMessage(gatewayError, [config.apiKey]),
      };
    }
  }

  /** 预算熔断前置检查。 */
  private assertBudget(budget: BudgetContext | undefined): void {
    if (!budget || budget.maxCostUsd === undefined) {
      return;
    }
    if (!Number.isFinite(budget.maxCostUsd)) {
      throw new ModelGatewayError('预算上限 maxCostUsd 必须是有限数字。', {
        category: 'BUDGET_EXCEEDED',
        code: API_ERROR_CODES.BUDGET_EXCEEDED,
      });
    }
    const spent = budget.spentCostUsd ?? 0;
    if (spent >= budget.maxCostUsd) {
      throw new BudgetExceededError({
        ...(budget.runId === undefined ? {} : { runId: budget.runId }),
        maxCostUsd: budget.maxCostUsd,
        spentCostUsd: spent,
      });
    }
  }

  /** 成功调用的日志写入（日志基础设施故障需要显式暴露）。 */
  private async persistUsageOrThrow(
    logger: UsageLogger | undefined,
    record: Parameters<UsageLogger>[0],
  ): Promise<void> {
    try {
      await emitUsageLog(logger, record);
    } catch (error) {
      throw new ModelGatewayError('用量日志写入失败，已中止本次调用的成功返回。', {
        category: 'PROVIDER_ERROR',
        code: API_ERROR_CODES.INTERNAL_ERROR,
        cause: error,
      });
    }
  }

  /** 构造 AI SDK 请求参数（prompt / messages 二选一）。 */
  private buildRequest(
    model: LanguageModel,
    params: GatewayGenerateTextParams,
    abortSignal: AbortSignal,
  ): Parameters<typeof aiGenerateText>[0] {
    const base = {
      model,
      system: params.system,
      temperature: params.temperature,
      maxOutputTokens: params.maxOutputTokens,
      maxRetries: 0,
      abortSignal,
    };

    if (params.messages && params.messages.length > 0) {
      return { ...base, messages: params.messages as ModelMessage[] };
    }
    if (typeof params.prompt === 'string' && params.prompt.length > 0) {
      return { ...base, prompt: params.prompt };
    }
    throw new ModelGatewayError('generateText 必须提供 prompt 或非空 messages。', {
      category: 'PROVIDER_ERROR',
      code: API_ERROR_CODES.VALIDATION_ERROR,
    });
  }
}

/** 合并超时取消与外部取消信号，并记录是否由超时触发。 */
function createTimeoutController(
  timeoutMs: number,
  externalSignal?: AbortSignal,
): {
  signal: AbortSignal;
  didTimeout: () => boolean;
  abort: () => void;
  cleanup: () => void;
} {
  const controller = new AbortController();
  let timedOut = false;

  const timer =
    Number.isFinite(timeoutMs) && timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          controller.abort(new Error(`请求超时（${timeoutMs}ms）`));
        }, timeoutMs)
      : null;
  // Node 22 / 现代浏览器均支持 AbortSignal.any；避免定时器本身阻止进程退出。
  timer?.unref?.();

  const signal = externalSignal
    ? AbortSignal.any([externalSignal, controller.signal])
    : controller.signal;

  return {
    signal,
    didTimeout: () => timedOut,
    abort: () => controller.abort(),
    cleanup: () => {
      if (timer !== null) {
        clearTimeout(timer);
      }
    },
  };
}
