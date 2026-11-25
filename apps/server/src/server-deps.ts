import type { SecretCodec } from './crypto/secret-codec.js';
import type { HealthProbes } from './health/probes.js';
import type { JobEventBus, SmokeQueue, WorkflowEventBus, WorkflowQueue } from './queue/types.js';
import type {
  AgentRoleRepository,
  BookOutlineRepository,
  BookRepository,
  ChapterRepository,
  ChapterRevisionRepository,
  ChapterSummaryRepository,
  KnowledgeCardRepository,
  ModelRepository,
  ProviderRepository,
  UsageLogRepository,
  VolumeRepository,
  WorkflowRunRepository,
} from './repositories/types.js';
import type { ModelGateway } from '@fanxiaoshuo/agents';

/**
 * `buildServer` 的依赖注入契约。
 *
 * 生产环境由 `src/index.ts` 注入 Drizzle / BullMQ / Redis 实现；
 * 测试环境注入内存仓储与假探针，即可在无 Docker 的情况下跑完整路由集成测试。
 */
export interface ServerDependencies {
  readonly config: {
    readonly APP_ENCRYPTION_KEY: string;
    readonly API_PORT: number;
    readonly NODE_ENV?: string | undefined;
    /** 服务版本号（健康检查回传，默认 0.1.0） */
    readonly version?: string | undefined;
  };
  /** AES-256-GCM 编解码器（测试可注入真实实现 + 测试密钥） */
  readonly codec: SecretCodec;
  readonly providers: ProviderRepository;
  readonly models: ModelRepository;
  readonly agentRoles: AgentRoleRepository;
  readonly usageLogs: UsageLogRepository;
  /** 统一 LLM 网关（一键测通必须经此执行并落盘审计） */
  readonly gateway: ModelGateway;
  readonly smokeQueue: SmokeQueue;
  readonly eventBus: JobEventBus;
  readonly health: HealthProbes;
  /** 书库仓储（书籍 CRUD / 回收站 / 整本导出） */
  readonly books: BookRepository;
  /** 分卷仓储（卷章树 / 排序 / 软删恢复） */
  readonly volumes: VolumeRepository;
  /** 章节仓储（元信息、正文乐观锁保存、重排与跨卷移动） */
  readonly chapters: ChapterRepository;
  /** 章节历史快照仓储（手动 / 自动节流 / 安全回滚） */
  readonly chapterRevisions: ChapterRevisionRepository;
  /** 全书总大纲仓储（1:1 绑定书籍，无记录返回 null） */
  readonly bookOutlines: BookOutlineRepository;
  /** 结构化设定卡仓储（6 类分类、筛选、常驻置顶与向量列） */
  readonly knowledgeCards: KnowledgeCardRepository;
  /** 章节细纲 / 剧情摘要仓储（手工维护与 lorekeeper AI 提炼共用） */
  readonly chapterSummaries: ChapterSummaryRepository;
  /** 批量流水线批次 / 步骤仓储（创建、暂停、续跑、取消、单步重试与删除） */
  readonly workflowRuns: WorkflowRunRepository;
  /** BullMQ `novel-workflows` 队列 Producer（载荷仅 `{ runId }`） */
  readonly workflowQueue: WorkflowQueue;
  /** Redis `workflowEvents` Pub/Sub 总线（Worker 广播与 SSE 转发共用） */
  readonly workflowEventBus: WorkflowEventBus;
  /**
   * 自动快照节流间隔（毫秒）。默认 `AUTO_REVISION_INTERVAL_MS`（5 分钟），
   * 测试可注入极小值以覆盖「节流触发 / 节流跳过」两条分支。
   */
  readonly autoRevisionIntervalMs?: number | undefined;
  /** 可注入时钟（测试可控），默认系统当前时间。 */
  readonly clock?: (() => Date) | undefined;
  /** SSE 心跳注释间隔（默认 15s；测试可缩短） */
  readonly sseHeartbeatMs?: number | undefined;
}

/** 服务默认版本号（`package.json` 版本可经依赖注入覆盖）。 */
export const DEFAULT_SERVER_VERSION = '0.1.0';
