import type {
  AgentRole,
  ApiErrorCode,
  ProviderProtocol,
  UsageLogStatus,
  UsageSummary,
} from '@fanxiaoshuo/shared';
import type { AgentRoleBindingInputPayload, CreateProviderInput } from '@fanxiaoshuo/shared';
import type { UsageLogRecordInput } from '@fanxiaoshuo/agents';

/**
 * Repository 层领域模型与接口。
 *
 * 设计目的：路由只依赖这些接口，生产环境注入 Drizzle 实现，
 * 测试环境注入内存实现，从而在无 Docker / 无 PostgreSQL 的情况下跑完整 `fastify.inject()` 集成测试。
 */

/** Provider 完整记录（含密文，仅服务端内部使用，禁止直接返回给客户端）。 */
export interface ProviderRecord {
  readonly id: string;
  readonly name: string;
  readonly protocol: ProviderProtocol;
  readonly baseUrl: string;
  readonly apiKeyEncrypted: string;
  readonly apiKeyMask: string;
  readonly isEnabled: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreateProviderRecordInput {
  readonly name: string;
  readonly protocol: ProviderProtocol;
  readonly baseUrl: string;
  readonly apiKeyEncrypted: string;
  readonly apiKeyMask: string;
  readonly isEnabled: boolean;
}

export type UpdateProviderRecordPatch = Partial<
  Pick<
    ProviderRecord,
    'name' | 'protocol' | 'baseUrl' | 'apiKeyEncrypted' | 'apiKeyMask' | 'isEnabled'
  >
>;

export type DeleteResult = 'deleted' | 'not_found' | 'in_use';

export interface ProviderRepository {
  list(): Promise<ProviderRecord[]>;
  findById(id: string): Promise<ProviderRecord | null>;
  findByName(name: string): Promise<ProviderRecord | null>;
  create(input: CreateProviderRecordInput): Promise<ProviderRecord>;
  update(id: string, patch: UpdateProviderRecordPatch): Promise<ProviderRecord | null>;
  delete(id: string): Promise<DeleteResult>;
}

/** 模型记录（价格已由 numeric 字符串转为 number）。 */
export interface ModelRecord {
  readonly id: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly displayName: string;
  readonly contextWindow: number | null;
  readonly inputPricePer1m: number;
  readonly outputPricePer1m: number;
  readonly isEnabled: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreateModelRecordInput {
  readonly providerId: string;
  readonly modelId: string;
  readonly displayName: string;
  readonly contextWindow: number | null;
  readonly inputPricePer1m: number;
  readonly outputPricePer1m: number;
  readonly isEnabled: boolean;
}

export type UpdateModelRecordPatch = Partial<
  Pick<
    ModelRecord,
    'modelId' | 'displayName' | 'contextWindow' | 'inputPricePer1m' | 'outputPricePer1m' | 'isEnabled'
  >
>;

/** 模型 + 所属 Provider（模型测通时解析上游配置）。 */
export interface ModelWithProviderRecord {
  readonly model: ModelRecord;
  readonly provider: ProviderRecord;
}

export interface ModelRepository {
  list(providerId?: string): Promise<ModelRecord[]>;
  findById(id: string): Promise<ModelRecord | null>;
  findWithProvider(id: string): Promise<ModelWithProviderRecord | null>;
  existsByProviderAndModelId(
    providerId: string,
    modelId: string,
    excludeModelRowId?: string,
  ): Promise<boolean>;
  create(input: CreateModelRecordInput): Promise<ModelRecord>;
  update(id: string, patch: UpdateModelRecordPatch): Promise<ModelRecord | null>;
  delete(id: string): Promise<DeleteResult>;
}

/** 角色绑定 + 关联模型/供应商摘要（用于角色路由面板）。 */
export interface AgentRoleBindingRecord {
  readonly role: AgentRole;
  readonly modelId: string;
  readonly temperature: number;
  readonly maxTokens: number | null;
  readonly updatedAt: Date;
  readonly model: ModelRecord | null;
  readonly provider: ProviderRecord | null;
}

export interface UpsertAgentRoleBindingInput {
  readonly role: AgentRole;
  readonly modelId: string;
  readonly temperature: number;
  readonly maxTokens: number | null;
}

export interface AgentRoleRepository {
  /** 仅返回已存在的绑定（GET 路由会补齐 4 个固定角色的未绑定视图）。 */
  list(): Promise<AgentRoleBindingRecord[]>;
  isModelBound(modelId: string): Promise<boolean>;
  upsert(input: UpsertAgentRoleBindingInput): Promise<void>;
  remove(role: AgentRole): Promise<void>;
}

/** 用量日志查询条件（时间已由 ISO 字符串解析为 Date）。 */
export interface UsageLogQuery {
  readonly page: number;
  readonly pageSize: number;
  readonly status?: UsageLogStatus;
  readonly role?: AgentRole;
  readonly scene?: string;
  readonly from?: Date;
  readonly to?: Date;
}

export interface UsageLogRecord {
  readonly id: string;
  readonly role: AgentRole | null;
  readonly providerId: string | null;
  readonly modelRef: string | null;
  readonly scene: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly estimatedCostUsd: number;
  readonly latencyMs: number | null;
  readonly status: UsageLogStatus;
  readonly errorCode: ApiErrorCode | null;
  readonly errorMessage: string | null;
  readonly createdAt: Date;
}

export interface UsageLogPage {
  readonly items: UsageLogRecord[];
  readonly total: number;
  readonly summary: UsageSummary;
}

export interface UsageLogRepository {
  /** 追加一条不可篡改的审计记录，返回落盘后的主键与时间。 */
  insert(record: UsageLogRecordInput): Promise<{ id: string; createdAt: Date }>;
  query(query: UsageLogQuery): Promise<UsageLogPage>;
}

/** 便捷别名：Provider 创建入参（路由层复用共享契约类型）。 */
export type CreateProviderPayload = CreateProviderInput;

/** 便捷别名：角色绑定入参（共享契约的解析前类型）。 */
export type AgentRoleBindingPayload = AgentRoleBindingInputPayload;
