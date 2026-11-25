import { randomUUID } from 'node:crypto';
import type {
  CreateToolboxRunInput,
  ToolboxRunListFilter,
  ToolboxRunPage,
  ToolboxRunRecord,
  ToolboxRunRepository,
} from '../../repositories/types.js';

/**
 * 创作工具盒运行历史仓储的内存实现（测试专用，与 Drizzle 实现逐条语义对齐）。
 *
 * 语义约定（与生产实现一致）：
 * - 历史 append-only：只有 `create` / `delete`；
 * - 列表按 `createdAt DESC, id DESC` 分页，支持 `toolId` / `bookId` / `status` 筛选；
 * - 删除历史仅移除本表记录，绝不触碰已回写的设定卡与总大纲。
 */

export interface InMemoryToolboxState {
  readonly runs: Map<string, ToolboxRunRecord>;
}

export interface InMemoryToolboxRepositories {
  readonly toolboxRuns: ToolboxRunRepository;
  readonly state: InMemoryToolboxState;
}

export function createInMemoryToolboxRunRepository(options: {
  now: () => Date;
}): InMemoryToolboxRepositories {
  const now = options.now;
  const runMap = new Map<string, ToolboxRunRecord>();

  const toolboxRuns: ToolboxRunRepository = {
    async create(input: CreateToolboxRunInput): Promise<ToolboxRunRecord> {
      const record: ToolboxRunRecord = {
        id: randomUUID(),
        toolId: input.toolId,
        bookId: input.bookId,
        role: input.role,
        status: input.status,
        inputs: { ...input.inputs },
        output: input.output,
        modelRef: input.modelRef,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        estimatedCostUsd: input.estimatedCostUsd,
        latencyMs: input.latencyMs,
        errorCode: input.errorCode,
        errorMessage: input.errorMessage,
        createdAt: now(),
      };
      runMap.set(record.id, record);
      return record;
    },

    async findById(runId: string): Promise<ToolboxRunRecord | null> {
      return runMap.get(runId) ?? null;
    },

    async list(filter: ToolboxRunListFilter): Promise<ToolboxRunPage> {
      const filtered = [...runMap.values()]
        .filter((run) => (filter.toolId === undefined ? true : run.toolId === filter.toolId))
        .filter((run) => (filter.bookId === undefined ? true : run.bookId === filter.bookId))
        .filter((run) => (filter.status === undefined ? true : run.status === filter.status))
        .sort(
          (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id),
        );

      const start = (filter.page - 1) * filter.pageSize;
      return {
        items: filtered.slice(start, start + filter.pageSize),
        total: filtered.length,
      };
    },

    async delete(runId: string): Promise<boolean> {
      return runMap.delete(runId);
    },
  };

  return { toolboxRuns, state: { runs: runMap } };
}
