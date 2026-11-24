import { describe, expect, it } from 'vitest';
import type { QueryResultRow } from 'pg';
import {
  API_ERROR_CODES,
  USAGE_SCENES,
  jobEventSchema,
  type JobEvent,
  type JobEventPayload,
} from '@fanxiaoshuo/shared';
import {
  SMOKE_WORKFLOW_ID,
  buildSuccessUsageLog,
  resolvedModelConfigSchema,
  type ResolvedModelConfig,
  type SmokeWorkflowInput,
  type SmokeWorkflowResult,
} from '@fanxiaoshuo/agents';
import { createPgUsageLogger, type QueryExecutor } from '../db/usage-log-writer.js';
import { silentWorkerLogger } from '../logger.js';
import {
  createSmokeJobProcessor,
  normalizeMaxAttempts,
  type SmokeJobContext,
  type SmokeJobProcessor,
  type SmokeJobRuntime,
} from '../jobs/smoke-job.js';

const JOB_ID = 'smoke-job-1';

interface SqlCall {
  readonly text: string;
  readonly values: readonly unknown[];
}

function createRecordingExecutor(): QueryExecutor & { readonly calls: SqlCall[] } {
  const calls: SqlCall[] = [];
  return {
    calls,
    async query<T extends QueryResultRow = QueryResultRow>(
      text: string,
      values: unknown[] = [],
    ): Promise<{ rows: T[] }> {
      calls.push({ text, values });
      return { rows: [] as T[] };
    },
  };
}

function createEventCollector(): {
  readonly events: JobEvent[];
  readonly publish: (event: JobEventPayload) => Promise<JobEvent>;
} {
  const events: JobEvent[] = [];
  return {
    events,
    async publish(event) {
      const parsed = jobEventSchema.parse(event);
      events.push(parsed);
      return parsed;
    },
  };
}

function createRuntime(
  handler: (input: SmokeWorkflowInput) => Promise<SmokeWorkflowResult>,
): SmokeJobRuntime {
  return { runSmokeWorkflow: handler };
}

function createWorkflowResult(overrides: Partial<SmokeWorkflowResult> = {}): SmokeWorkflowResult {
  return {
    engine: 'mastra',
    workflowId: SMOKE_WORKFLOW_ID,
    runId: 'run-1',
    mode: 'echo',
    message: 'ok',
    replyPreview: null,
    modelRef: null,
    inputTokens: 0,
    outputTokens: 0,
    estimatedCostUsd: 0,
    modelLatencyMs: null,
    totalDurationMs: 1,
    steps: [],
    ...overrides,
  };
}

const MODEL_CONFIG: ResolvedModelConfig = resolvedModelConfigSchema.parse({
  providerId: '11111111-1111-4111-8111-111111111111',
  providerName: 'fixture-provider',
  protocol: 'openai-compatible',
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'sk-live-super-secret-key-123456',
  modelId: 'gpt-4o-mini',
  displayName: 'Fixture GPT',
  inputPricePer1m: 0.15,
  outputPricePer1m: 0.6,
});

/** 递增时钟：每次读取 +5ms，便于断言 latency。 */
function createClock(start = 1_000): { now: () => number } {
  let current = start;
  return {
    now() {
      current += 5;
      return current;
    },
  };
}

function createProcessor(overrides: {
  runtime: SmokeJobRuntime;
  publish: (event: JobEventPayload) => Promise<JobEvent>;
  resolveModelConfig?: (selector: { modelId?: string; role?: string }) => Promise<ResolvedModelConfig>;
  now?: () => number;
}): SmokeJobProcessor {
  return createSmokeJobProcessor({
    runtime: overrides.runtime,
    publishEvent: overrides.publish,
    resolveModelConfig:
      overrides.resolveModelConfig ??
      (async () => {
        throw new Error('resolveModelConfig 不应在 echo 模式下被调用');
      }),
    now: overrides.now ?? createClock().now,
    logger: silentWorkerLogger,
  });
}

function context(overrides: Partial<SmokeJobContext> = {}): SmokeJobContext {
  return {
    jobId: JOB_ID,
    attemptsMade: 0,
    maxAttempts: 3,
    data: {},
    ...overrides,
  };
}

describe('createSmokeJobProcessor — echo 模式', () => {
  it('经 Mastra 运行时成功执行，并依次发布 active → completed 事件', async () => {
    const inputs: SmokeWorkflowInput[] = [];
    const collector = createEventCollector();
    const processor = createProcessor({
      runtime: createRuntime(async (input) => {
        inputs.push(input);
        return createWorkflowResult({ message: 'echo-ok', totalDurationMs: 7 });
      }),
      publish: collector.publish,
    });

    const result = await processor(
      context({ data: { mode: 'echo', message: 'ping 冒烟', note: 'echo 模式' } }),
    );

    expect(inputs).toEqual([{ mode: 'echo', message: 'ping 冒烟' }]);
    expect(result).toEqual({
      engineOk: true,
      modelTested: false,
      replyPreview: null,
      latencyMs: 5,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: 0,
    });

    expect(collector.events.map((event) => event.type)).toEqual(['job.active', 'job.completed']);
    expect(collector.events.map((event) => event.status)).toEqual(['active', 'completed']);
    expect(collector.events[1]?.data).toMatchObject({
      result,
      latencyMs: 5,
      mode: 'echo',
      scene: USAGE_SCENES.smokeJob,
    });
    // 每个事件都必须通过共享契约校验
    for (const event of collector.events) {
      expect(jobEventSchema.safeParse(event).success).toBe(true);
      expect(event.jobId).toBe(JOB_ID);
    }
  });

  it('mode 缺省时由 invokeModel 推导，显式 mode 优先', async () => {
    const modes: string[] = [];
    const collector = createEventCollector();
    const runtime = createRuntime(async (input) => {
      modes.push(input.mode);
      return createWorkflowResult({ mode: input.mode });
    });

    const echoProcessor = createProcessor({ runtime, publish: collector.publish });
    await echoProcessor(context({ data: { invokeModel: false } }));
    await echoProcessor(context({ data: { invokeModel: true, mode: 'echo' } }));

    expect(modes).toEqual(['echo', 'echo']);
  });
});

describe('createSmokeJobProcessor — live 模式与用量日志', () => {
  it('解析模型配置、经运行时执行并写入 llm_usage_logs（scene=smoke-job）', async () => {
    const executor = createRecordingExecutor();
    const usageLogger = createPgUsageLogger(executor);
    const collector = createEventCollector();
    const selectors: unknown[] = [];
    const runtimeInputs: SmokeWorkflowInput[] = [];

    const processor = createProcessor({
      runtime: createRuntime(async (input) => {
        runtimeInputs.push(input);
        // 模拟 ModelGateway 的成功计量回调（真实网关由 @fanxiaoshuo/agents 注入）
        await usageLogger(
          buildSuccessUsageLog({
            config: MODEL_CONFIG,
            role: null,
            scene: USAGE_SCENES.smokeJob,
            usage: { inputTokens: 12, outputTokens: 34, estimatedCostUsd: 0.0001 },
            latencyMs: 42,
          }),
        );
        return createWorkflowResult({
          mode: 'live',
          message: 'OK',
          replyPreview: 'OK',
          modelRef: `${MODEL_CONFIG.providerName}/${MODEL_CONFIG.modelId}`,
          inputTokens: 12,
          outputTokens: 34,
          estimatedCostUsd: 0.0001,
          modelLatencyMs: 42,
          totalDurationMs: 45,
        });
      }),
      publish: collector.publish,
      resolveModelConfig: async (selector) => {
        selectors.push(selector);
        return MODEL_CONFIG;
      },
    });

    const result = await processor(
      context({ data: { invokeModel: true, note: 'live 冒烟' } }),
    );

    expect(selectors).toEqual([{}]);
    expect(runtimeInputs).toHaveLength(1);
    expect(runtimeInputs[0]).toMatchObject({ mode: 'live', modelConfig: MODEL_CONFIG });
    expect(result).toMatchObject({
      engineOk: true,
      modelTested: true,
      replyPreview: 'OK',
      inputTokens: 12,
      outputTokens: 34,
      estimatedCostUsd: 0.0001,
    });

    expect(executor.calls).toHaveLength(1);
    const insert = executor.calls[0];
    expect(insert?.text).toContain('INSERT INTO llm_usage_logs');
    expect(insert?.values).toEqual([
      null,
      MODEL_CONFIG.providerId,
      'fixture-provider/gpt-4o-mini',
      USAGE_SCENES.smokeJob,
      12,
      34,
      0.0001,
      42,
      'success',
      null,
      null,
    ]);

    expect(collector.events.map((event) => event.type)).toEqual(['job.active', 'job.completed']);
    expect(collector.events[1]?.data?.result).toMatchObject({
      modelTested: true,
      inputTokens: 12,
      outputTokens: 34,
    });
  });

  it('显式 modelId / role 会透传给模型解析器', async () => {
    const selectors: unknown[] = [];
    const collector = createEventCollector();
    const processor = createProcessor({
      runtime: createRuntime(async () => createWorkflowResult({ mode: 'live' })),
      publish: collector.publish,
      resolveModelConfig: async (selector) => {
        selectors.push(selector);
        return MODEL_CONFIG;
      },
    });

    await processor(context({ data: { mode: 'live', modelId: 'gpt-4o-mini' } }));
    await processor(context({ data: { mode: 'live', role: 'writer' } }));

    expect(selectors).toEqual([{ modelId: 'gpt-4o-mini' }, { role: 'writer' }]);
  });
});

describe('createSmokeJobProcessor — 失败、脱敏与重试上限', () => {
  it('瞬时错误发布 failed 事件且不泄露明文 API Key', async () => {
    const collector = createEventCollector();
    const processor = createProcessor({
      runtime: createRuntime(async () => {
        throw new Error(`上游返回 401：invalid api key ${MODEL_CONFIG.apiKey}`);
      }),
      publish: collector.publish,
      resolveModelConfig: async () => MODEL_CONFIG,
    });

    let thrown: unknown;
    try {
      await processor(context({ data: { mode: 'live', modelId: 'gpt-4o-mini' } }));
    } catch (error) {
      thrown = error;
    }
    const thrownMessage = thrown instanceof Error ? thrown.message : String(thrown);
    expect(thrownMessage).toContain('[REDACTED]');
    expect(thrownMessage).not.toContain(MODEL_CONFIG.apiKey);

    expect(collector.events.map((event) => event.type)).toEqual(['job.active', 'job.failed']);
    const failed = collector.events[1];
    expect(failed).toBeDefined();
    expect(failed?.errorCode).toBe(API_ERROR_CODES.UPSTREAM_AUTH_ERROR);
    expect(failed?.errorMessage).toContain('[REDACTED]');
    expect(failed?.errorMessage).not.toContain(MODEL_CONFIG.apiKey);
    expect(JSON.stringify(failed)).not.toContain(MODEL_CONFIG.apiKey);
    expect(failed?.attemptsMade).toBe(1);
    expect(failed?.data).toMatchObject({
      maxAttempts: 3,
      willRetry: true,
      final: false,
    });
  });

  it('达到最大尝试次数时标记最终失败', async () => {
    const collector = createEventCollector();
    const processor = createProcessor({
      runtime: createRuntime(async () => {
        throw new Error('上游 503 Service Unavailable');
      }),
      publish: collector.publish,
      resolveModelConfig: async () => MODEL_CONFIG,
    });

    await expect(
      processor(
        context({
          attemptsMade: 2,
          maxAttempts: 3,
          data: { mode: 'live', role: 'writer' },
        }),
      ),
    ).rejects.toThrow(/503/);

    const failed = collector.events.at(-1);
    expect(failed?.type).toBe('job.failed');
    expect(failed?.attemptsMade).toBe(3);
    expect(failed?.errorCode).toBe(API_ERROR_CODES.UPSTREAM_ERROR);
    expect(failed?.data).toMatchObject({
      maxAttempts: 3,
      willRetry: false,
      final: true,
    });
  });

  it('simulateFailTimes 在前 N 次尝试抛出瞬时错误，之后恢复正常', async () => {
    const collector = createEventCollector();
    let executions = 0;
    const processor = createProcessor({
      runtime: createRuntime(async () => {
        executions += 1;
        return createWorkflowResult();
      }),
      publish: collector.publish,
    });

    const transient = { mode: 'echo', simulateFailTimes: 2 };

    await expect(processor(context({ attemptsMade: 0, data: transient }))).rejects.toThrow(
      /模拟瞬时故障/,
    );
    expect(collector.events.at(-1)?.data).toMatchObject({ final: false, willRetry: true });

    await expect(processor(context({ attemptsMade: 1, data: transient }))).rejects.toThrow(
      /模拟瞬时故障/,
    );
    expect(executions).toBe(0);

    const result = await processor(context({ attemptsMade: 2, data: transient }));
    expect(result.engineOk).toBe(true);
    expect(executions).toBe(1);
    expect(collector.events.at(-1)?.type).toBe('job.completed');
  });

  it('非法任务负载发布 VALIDATION_ERROR 失败事件', async () => {
    const collector = createEventCollector();
    const processor = createProcessor({
      runtime: createRuntime(async () => createWorkflowResult()),
      publish: collector.publish,
    });

    await expect(processor(context({ data: { mode: 'unexpected' } }))).rejects.toThrow(
      /负载非法/,
    );

    const failed = collector.events.at(-1);
    expect(failed?.type).toBe('job.failed');
    expect(failed?.errorCode).toBe(API_ERROR_CODES.VALIDATION_ERROR);
    expect(failed?.errorMessage).toContain('mode');
  });

  it('事件通道故障不会阻断任务本身', async () => {
    const processor = createProcessor({
      runtime: createRuntime(async () => createWorkflowResult()),
      publish: async () => {
        throw new Error('redis down');
      },
    });

    await expect(processor(context({ data: { mode: 'echo' } }))).resolves.toMatchObject({
      engineOk: true,
    });
  });
});

describe('normalizeMaxAttempts', () => {
  it('缺省 / 非法值回退到共享默认策略，并限制上限', () => {
    expect(normalizeMaxAttempts(undefined)).toBe(3);
    expect(normalizeMaxAttempts(Number.NaN)).toBe(3);
    expect(normalizeMaxAttempts(0)).toBe(3);
    expect(normalizeMaxAttempts(5)).toBe(5);
    expect(normalizeMaxAttempts(1_000)).toBe(20);
  });
});
