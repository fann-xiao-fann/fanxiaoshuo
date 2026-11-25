import { randomUUID } from 'node:crypto';
import { AGENT_ROLES, okComponentHealth, type AgentRole, type JobEvent } from '@fanxiaoshuo/shared';
import type {
  AgentRoleBindingRecord,
  AgentRoleRepository,
  DeleteResult,
  ModelRecord,
  ModelRepository,
  ModelWithProviderRecord,
  ProviderRecord,
  ProviderRepository,
  UsageLogPage,
  UsageLogRecord,
  UsageLogRepository,
  UpsertAgentRoleBindingInput,
} from '../../repositories/types.js';
import type { JobEventBus, SmokeQueue, SmokeQueueSnapshot, Unsubscribe } from '../../queue/types.js';
import type { HealthProbes } from '../../health/probes.js';
import type { ServerDependencies } from '../../server-deps.js';
import { createSecretCodec, type SecretCodec } from '../../crypto/secret-codec.js';
import { buildServer } from '../../server.js';
import { ModelGateway } from '@fanxiaoshuo/agents';
import {
  createInMemoryBookRepositories,
  type InMemoryBookState,
} from './in-memory-books.js';
import {
  createInMemoryBookBibleRepositories,
  type InMemoryBookBibleState,
} from './in-memory-book-bible.js';
import type {
  BookOutlineRepository,
  BookRepository,
  ChapterRepository,
  ChapterRevisionRepository,
  ChapterSummaryRepository,
  KnowledgeCardRepository,
  VolumeRepository,
} from '../../repositories/types.js';

/** 测试主密钥（32 字节 hex，仅为测试固定值）。 */
export const TEST_ENCRYPTION_KEY = 'a'.repeat(64);

/** 固定测试密钥的编解码器。 */
export const testCodec: SecretCodec = createSecretCodec(TEST_ENCRYPTION_KEY);

export interface InMemoryStore {
  readonly providers: ProviderRepository;
  readonly models: ModelRepository;
  readonly agentRoles: AgentRoleRepository;
  readonly usageLogs: UsageLogRepository;
  readonly books: BookRepository;
  readonly volumes: VolumeRepository;
  readonly chapters: ChapterRepository;
  readonly chapterRevisions: ChapterRevisionRepository;
  readonly bookOutlines: BookOutlineRepository;
  readonly knowledgeCards: KnowledgeCardRepository;
  readonly chapterSummaries: ChapterSummaryRepository;
  /** 服务端与内存仓储共用的时钟（测试可通过 `clock` 选项注入可控时间）。 */
  readonly clock: () => Date;
  readonly state: {
    readonly providers: Map<string, ProviderRecord>;
    readonly models: Map<string, ModelRecord>;
    readonly roles: Map<
      AgentRole,
      { modelId: string; temperature: number; maxTokens: number | null; updatedAt: Date }
    >;
    readonly logs: UsageLogRecord[];
    readonly books: InMemoryBookState['books'];
    readonly volumes: InMemoryBookState['volumes'];
    readonly chapters: InMemoryBookState['chapters'];
    readonly revisions: InMemoryBookState['revisions'];
    readonly outlines: InMemoryBookBibleState['outlines'];
    readonly cards: InMemoryBookBibleState['cards'];
    readonly summaries: InMemoryBookBibleState['summaries'];
  };
}

/** 创建内存版四大仓储（无 Docker / PostgreSQL 依赖）。 */
export function createInMemoryStore(options: { now?: () => Date } = {}): InMemoryStore {
  let tick = 0;
  const now =
    options.now ??
    (() => {
      tick += 1;
      return new Date(Date.UTC(2025, 0, 1, 0, 0, 0, 0) + tick * 1000);
    });

  const providerMap = new Map<string, ProviderRecord>();
  const modelMap = new Map<string, ModelRecord>();
  const roleMap = new Map<
    AgentRole,
    { modelId: string; temperature: number; maxTokens: number | null; updatedAt: Date }
  >();
  const logs: UsageLogRecord[] = [];

  const bookRepositories = createInMemoryBookRepositories({ now });
  const bookBibleRepositories = createInMemoryBookBibleRepositories({ now });

  const providerRepository: ProviderRepository = {
    async list() {
      return [...providerMap.values()];
    },
    async findById(id) {
      return providerMap.get(id) ?? null;
    },
    async findByName(name) {
      return [...providerMap.values()].find((item) => item.name === name) ?? null;
    },
    async create(input) {
      const at = now();
      const record: ProviderRecord = {
        id: randomUUID(),
        name: input.name,
        protocol: input.protocol,
        baseUrl: input.baseUrl,
        apiKeyEncrypted: input.apiKeyEncrypted,
        apiKeyMask: input.apiKeyMask,
        isEnabled: input.isEnabled,
        createdAt: at,
        updatedAt: at,
      };
      providerMap.set(record.id, record);
      return record;
    },
    async update(id, patch) {
      const current = providerMap.get(id);
      if (!current) {
        return null;
      }
      const next: ProviderRecord = { ...current, ...patch, updatedAt: now() };
      providerMap.set(id, next);
      return next;
    },
    async delete(id): Promise<DeleteResult> {
      if (!providerMap.has(id)) {
        return 'not_found';
      }
      const modelIds = [...modelMap.values()]
        .filter((model) => model.providerId === id)
        .map((model) => model.id);
      if ([...roleMap.values()].some((binding) => modelIds.includes(binding.modelId))) {
        return 'in_use';
      }
      for (const modelId of modelIds) {
        modelMap.delete(modelId);
      }
      providerMap.delete(id);
      return 'deleted';
    },
  };

  const modelRepository: ModelRepository = {
    async list(providerId) {
      const items = [...modelMap.values()];
      return providerId ? items.filter((model) => model.providerId === providerId) : items;
    },
    async findById(id) {
      return modelMap.get(id) ?? null;
    },
    async findWithProvider(id): Promise<ModelWithProviderRecord | null> {
      const model = modelMap.get(id);
      if (!model) {
        return null;
      }
      const provider = providerMap.get(model.providerId);
      return provider ? { model, provider } : null;
    },
    async existsByProviderAndModelId(providerId, modelId, excludeModelRowId) {
      return [...modelMap.values()].some(
        (model) =>
          model.providerId === providerId &&
          model.modelId === modelId &&
          model.id !== excludeModelRowId,
      );
    },
    async create(input) {
      const at = now();
      const record: ModelRecord = {
        id: randomUUID(),
        providerId: input.providerId,
        modelId: input.modelId,
        displayName: input.displayName,
        contextWindow: input.contextWindow,
        inputPricePer1m: input.inputPricePer1m,
        outputPricePer1m: input.outputPricePer1m,
        isEnabled: input.isEnabled,
        createdAt: at,
        updatedAt: at,
      };
      modelMap.set(record.id, record);
      return record;
    },
    async update(id, patch) {
      const current = modelMap.get(id);
      if (!current) {
        return null;
      }
      const next: ModelRecord = { ...current, ...patch, updatedAt: now() };
      modelMap.set(id, next);
      return next;
    },
    async delete(id): Promise<DeleteResult> {
      if (!modelMap.has(id)) {
        return 'not_found';
      }
      if ([...roleMap.values()].some((binding) => binding.modelId === id)) {
        return 'in_use';
      }
      modelMap.delete(id);
      return 'deleted';
    },
  };

  const agentRoleRepository: AgentRoleRepository = {
    async list(): Promise<AgentRoleBindingRecord[]> {
      const records: AgentRoleBindingRecord[] = [];
      for (const role of AGENT_ROLES) {
        const binding = roleMap.get(role);
        if (!binding) {
          continue;
        }
        const model = modelMap.get(binding.modelId) ?? null;
        const provider = model ? (providerMap.get(model.providerId) ?? null) : null;
        records.push({
          role,
          modelId: binding.modelId,
          temperature: binding.temperature,
          maxTokens: binding.maxTokens,
          updatedAt: binding.updatedAt,
          model,
          provider,
        });
      }
      return records;
    },
    async isModelBound(modelId) {
      return [...roleMap.values()].some((binding) => binding.modelId === modelId);
    },
    async upsert(input: UpsertAgentRoleBindingInput) {
      roleMap.set(input.role, {
        modelId: input.modelId,
        temperature: input.temperature,
        maxTokens: input.maxTokens,
        updatedAt: now(),
      });
    },
    async remove(role) {
      roleMap.delete(role);
    },
  };

  const usageLogRepository: UsageLogRepository = {
    async insert(record) {
      const createdAt = now();
      const stored: UsageLogRecord = {
        id: randomUUID(),
        role: record.role,
        providerId: record.providerId,
        modelRef: record.modelRef,
        scene: record.scene,
        inputTokens: record.inputTokens,
        outputTokens: record.outputTokens,
        estimatedCostUsd: record.estimatedCostUsd,
        latencyMs: record.latencyMs,
        status: record.status,
        errorCode: record.errorCode,
        errorMessage: record.errorMessage,
        createdAt,
      };
      logs.push(stored);
      return { id: stored.id, createdAt };
    },
    async query(query): Promise<UsageLogPage> {
      const filtered = logs.filter((log) => {
        if (query.status && log.status !== query.status) return false;
        if (query.role && log.role !== query.role) return false;
        if (query.scene && log.scene !== query.scene) return false;
        if (query.from && log.createdAt.getTime() < query.from.getTime()) return false;
        if (query.to && log.createdAt.getTime() > query.to.getTime()) return false;
        return true;
      });
      const sorted = [...filtered].sort(
        (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id),
      );
      const start = (query.page - 1) * query.pageSize;
      const items = sorted.slice(start, start + query.pageSize);
      return {
        items,
        total: sorted.length,
        summary: {
          totalRequests: sorted.length,
          successRequests: sorted.filter((log) => log.status === 'success').length,
          errorRequests: sorted.filter((log) => log.status === 'error').length,
          totalInputTokens: sorted.reduce((sum, log) => sum + log.inputTokens, 0),
          totalOutputTokens: sorted.reduce((sum, log) => sum + log.outputTokens, 0),
          totalCostUsd: Number(
            sorted.reduce((sum, log) => sum + log.estimatedCostUsd, 0).toFixed(6),
          ),
        },
      };
    },
  };

  return {
    providers: providerRepository,
    models: modelRepository,
    agentRoles: agentRoleRepository,
    usageLogs: usageLogRepository,
    books: bookRepositories.books,
    volumes: bookRepositories.volumes,
    chapters: bookRepositories.chapters,
    chapterRevisions: bookRepositories.chapterRevisions,
    bookOutlines: bookBibleRepositories.bookOutlines,
    knowledgeCards: bookBibleRepositories.knowledgeCards,
    chapterSummaries: bookBibleRepositories.chapterSummaries,
    clock: now,
    state: {
      providers: providerMap,
      models: modelMap,
      roles: roleMap,
      logs,
      books: bookRepositories.state.books,
      volumes: bookRepositories.state.volumes,
      chapters: bookRepositories.state.chapters,
      revisions: bookRepositories.state.revisions,
      outlines: bookBibleRepositories.state.outlines,
      cards: bookBibleRepositories.state.cards,
      summaries: bookBibleRepositories.state.summaries,
    },
  };
}

/** 可控的假 BullMQ 队列。 */
export interface FakeSmokeQueue extends SmokeQueue {
  readonly snapshots: Map<string, SmokeQueueSnapshot>;
  setSnapshot(snapshot: SmokeQueueSnapshot): void;
}

export function createFakeSmokeQueue(): FakeSmokeQueue {
  const snapshots = new Map<string, SmokeQueueSnapshot>();
  let counter = 0;

  return {
    snapshots,
    async enqueue(input) {
      counter += 1;
      const jobId = `job-${counter}`;
      const createdAt = new Date();
      snapshots.set(jobId, {
        jobId,
        status: 'queued',
        invokeModel: input.invokeModel,
        note: input.note ?? null,
        attemptsMade: 0,
        createdAt,
        startedAt: null,
        finishedAt: null,
        result: null,
        errorCode: null,
        errorMessage: null,
      });
      return { jobId, createdAt };
    },
    async get(jobId) {
      return snapshots.get(jobId) ?? null;
    },
    setSnapshot(snapshot) {
      snapshots.set(snapshot.jobId, snapshot);
    },
  };
}

/** 可控的假事件总线（记录发布事件并支持向 SSE 订阅者注入事件）。 */
export interface FakeEventBus extends JobEventBus {
  readonly published: JobEvent[];
  readonly handlers: Set<(event: JobEvent) => void>;
  unsubscribeCount: number;
  emit(event: JobEvent): void;
}

export function createFakeEventBus(): FakeEventBus {
  const published: JobEvent[] = [];
  const handlers = new Set<(event: JobEvent) => void>();
  let unsubscribeCount = 0;

  const bus: FakeEventBus = {
    published,
    handlers,
    unsubscribeCount,
    async publish(event) {
      published.push(event);
      bus.emit(event);
    },
    async subscribe(handler): Promise<Unsubscribe> {
      handlers.add(handler);
      return async () => {
        handlers.delete(handler);
        unsubscribeCount += 1;
        bus.unsubscribeCount = unsubscribeCount;
      };
    },
    emit(event) {
      for (const handler of handlers) {
        handler(event);
      }
    },
  };
  return bus;
}

/** 全部健康的全绿探针。 */
export function createHealthyProbes(): HealthProbes {
  return {
    checkPostgres: async () => okComponentHealth({ latencyMs: 2 }),
    checkRedis: async () => okComponentHealth({ latencyMs: 1 }),
    checkWorker: async () =>
      okComponentHealth({
        latencyMs: 1,
        lastHeartbeatAt: new Date().toISOString(),
        activeJobs: 0,
      }),
  };
}

export interface TestServerOptions {
  readonly store?: InMemoryStore;
  readonly gateway?: ModelGateway;
  readonly smokeQueue?: FakeSmokeQueue;
  readonly eventBus?: FakeEventBus;
  readonly health?: HealthProbes;
  readonly sseHeartbeatMs?: number;
  /** 可控时钟（与内存仓储共用，便于测试自动快照节流） */
  readonly clock?: () => Date;
  /** 自动快照节流间隔（默认共享常量 5 分钟） */
  readonly autoRevisionIntervalMs?: number;
}

export interface TestServerContext {
  readonly app: Awaited<ReturnType<typeof buildServer>>;
  readonly toDeps: ServerDependencies;
  readonly store: InMemoryStore;
  readonly smokeQueue: FakeSmokeQueue;
  readonly eventBus: FakeEventBus;
}

/** 组装可 `app.inject()` 的完整测试服务器。 */
export async function createTestServer(options: TestServerOptions = {}): Promise<TestServerContext> {
  const store =
    options.store ?? createInMemoryStore(options.clock ? { now: options.clock } : {});
  const smokeQueue = options.smokeQueue ?? createFakeSmokeQueue();
  const eventBus = options.eventBus ?? createFakeEventBus();

  const toDeps: ServerDependencies = {
    config: {
      APP_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
      API_PORT: 3001,
      NODE_ENV: 'test',
      version: '0.1.0-test',
    },
    codec: testCodec,
    providers: store.providers,
    models: store.models,
    agentRoles: store.agentRoles,
    usageLogs: store.usageLogs,
    books: store.books,
    volumes: store.volumes,
    chapters: store.chapters,
    chapterRevisions: store.chapterRevisions,
    bookOutlines: store.bookOutlines,
    knowledgeCards: store.knowledgeCards,
    chapterSummaries: store.chapterSummaries,
    gateway: options.gateway ?? new ModelGateway(),
    smokeQueue,
    eventBus,
    health: options.health ?? createHealthyProbes(),
    clock: options.clock ?? store.clock,
    ...(options.autoRevisionIntervalMs === undefined
      ? {}
      : { autoRevisionIntervalMs: options.autoRevisionIntervalMs }),
    sseHeartbeatMs: options.sseHeartbeatMs ?? 50,
  };

  const app = await buildServer(toDeps);
  return { app, toDeps, store, smokeQueue, eventBus };
}
