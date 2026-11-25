# Design: batch-workflows-engine

## Context

Change 1–3 已完成全部前置底座并归档：
- `packages/shared`：Zod v4 契约、`QUEUE_NAMES.novelWorkflows = 'novel-workflows'`、`USAGE_SCENES`（含 `chapter-write` / `lore-extract` / `chapter-review`）、`API_ERROR_CODES.BUDGET_EXCEEDED`。
- `packages/agents`：`ModelGateway`（内置 `BudgetContext` 预算熔断、Token/费用计算、错误脱敏与 `usageLogger`）、`createFanXiaoshuoRuntime`（Mastra 多 Agent 与 Workflow 门面）、`assembleChapterContext`、`buildChapterWriterSystemPrompt`、`buildSummaryExtractPrompts` / `parseExtractedSummary`。
- `apps/server`：Fastify 5 + Drizzle ORM + PostgreSQL（11 张表）+ BullMQ Producer + Redis Pub/Sub SSE 转发模式。
- `apps/worker`：独立 BullMQ Worker 进程（`pg` 连接池 + `ioredis` + `createModelConfigResolver` + `createPgUsageLogger` + 心跳上报 + 优雅停机）。
- `apps/web`：Vue 3 + Pinia + Naive UI 工作台，`/workflows` 目前为占位视图。

Change 4 围绕「单批次有序驱动、章节级断点持久化、Mastra 编排单章闭环、BullMQ 调度、预算硬熔断与 Redis Pub/Sub 实时进度」构建完整批量生产引擎。

## Goals / Non-Goals

**Goals:**
- 持久化批次（`workflow_runs`）与章节步骤（`workflow_steps`），支持服务重启与 Worker 重启后的完整状态恢复与断点续跑。
- 用 Mastra Workflow 封装单章执行管道（`showrunner` 细纲规划 → `writer` 结合 Book Bible 成文 → `critic` 结构化打分与有界返工循环 → `lorekeeper` 摘要提炼），所有模型调用 100% 走 `ModelGateway` 并落盘 `llm_usage_logs`。
- 实现可靠的 `maxCostUsd` 预算熔断（达上限自动安全暂停为 `paused`，支持上调预算续跑），以及暂停、断点续跑、取消与单步重试控制。
- 写回章节正文前在 PG 事务中强制先留底 `source: 'ai'` 不可变快照，再更新正文、服务端重算字数与递增 `version`。
- 交付实时 `/workflows` 批量流水线控制台，通过 SSE + 轮询兜底展示每章进度、阶段、审稿得分、问题清单与费用消耗。

**Non-Goals:**
- 不在单本书同一批次内并行写相邻章节（长篇网文强依赖前章摘要与结尾连贯性，批次内必须按阅读顺序串行执行章节；多本书不同批次可由 `WORKER_CONCURRENCY` 并行消费）。
- 不实现可视化自由拖拽 DAG 编辑器（固定、经过验证的 3 种网文生产模式足够聚焦高效）。
- 不实现创作工具盒 `/toolbox`（留待 Change 5）。

## Decisions

### 1. 数据库 Schema（Drizzle 迁移 `0003_*.sql`）

在 `apps/server/src/db/schema.ts` 新增 2 张表（`apps/worker` 使用 `pg` SQL 直接读写相同精确表名与列名）：

1. **`workflow_runs`**：
   - `id uuid PRIMARY KEY DEFAULT gen_random_uuid()`
   - `book_id uuid NOT NULL REFERENCES books(id) ON DELETE CASCADE`
   - `mode text NOT NULL`（`outline_only | write_chapters | full_pipeline`）
   - `status text NOT NULL DEFAULT 'queued'`（`queued | running | paused | completed | failed | cancelled`）
   - `config_json jsonb NOT NULL`（完整配置快照：`enableCritic`, `minPassScore`, `maxReworkRounds`, `enableSummary`, `targetWords`, `maxContextTokens`, `instruction`, `chapterIds`）
   - `total_steps integer NOT NULL DEFAULT 0`
   - `completed_steps integer NOT NULL DEFAULT 0`
   - `failed_steps integer NOT NULL DEFAULT 0`
   - `max_cost_usd numeric(12,6)`（可空，非空时作为硬预算熔断上限）
   - `spent_cost_usd numeric(12,6) NOT NULL DEFAULT '0'`
   - `total_input_tokens integer NOT NULL DEFAULT 0`
   - `total_output_tokens integer NOT NULL DEFAULT 0`
   - `pause_requested boolean NOT NULL DEFAULT false`
   - `cancel_requested boolean NOT NULL DEFAULT false`
   - `pause_reason text`（`'USER_PAUSED' | 'BUDGET_EXCEEDED' | null`）
   - `error_code text`
   - `error_message text`
   - `started_at timestamptz`
   - `finished_at timestamptz`
   - `created_at timestamptz NOT NULL DEFAULT now()`
   - `updated_at timestamptz NOT NULL DEFAULT now()`
   - 索引：`workflow_runs_book_created_idx(book_id, created_at)`、`workflow_runs_status_idx(status)`。

2. **`workflow_steps`**：
   - `id uuid PRIMARY KEY DEFAULT gen_random_uuid()`
   - `run_id uuid NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE`
   - `chapter_id uuid NOT NULL REFERENCES chapters(id) ON DELETE CASCADE`
   - `step_index integer NOT NULL`（0-based 顺序序号）
   - `chapter_title_snapshot text NOT NULL`
   - `status text NOT NULL DEFAULT 'pending'`（`pending | running | completed | failed | skipped`）
   - `stage text NOT NULL DEFAULT 'idle'`（`idle | planning | writing | reviewing | reworking | summarizing | done`）
   - `rework_count integer NOT NULL DEFAULT 0`
   - `critic_score integer`（0–100，未审稿为 null）
   - `critic_passed boolean`
   - `critic_summary text`
   - `critic_issues_json jsonb NOT NULL DEFAULT '[]'::jsonb`（`string[]`）
   - `output_word_count integer NOT NULL DEFAULT 0`
   - `input_tokens integer NOT NULL DEFAULT 0`
   - `output_tokens integer NOT NULL DEFAULT 0`
   - `estimated_cost_usd numeric(12,6) NOT NULL DEFAULT '0'`
   - `backup_revision_id uuid`（写回正文前生成的 `source: 'ai'` 留底快照 ID，可空）
   - `error_code text`
   - `error_message text`
   - `started_at timestamptz`
   - `finished_at timestamptz`
   - `created_at timestamptz NOT NULL DEFAULT now()`
   - `updated_at timestamptz NOT NULL DEFAULT now()`
   - 索引：`workflow_steps_run_index_unique(run_id, step_index)`（唯一索引）、`workflow_steps_run_status_idx(run_id, status)`。

### 2. REST 与 SSE 契约（唯一真相来源：`packages/shared`）

| 方法与路径 | 说明 | 请求 / 响应契约 |
| --- | --- | --- |
| `GET /api/v1/workflows/runs` | 分页筛选批次列表（`?bookId=&status=&page=&pageSize=`） | `workflowRunListResponseSchema` |
| `POST /api/v1/workflows/runs` | 创建批量任务并入队（支持已有 `chapterIds` 或 `autoCreateChapters`） | `createWorkflowRunSchema` → `201` `workflowRunDetailDtoSchema` |
| `GET /api/v1/workflows/runs/:runId` | 批次详情 + 有序步骤列表 | `workflowRunDetailDtoSchema` |
| `POST /api/v1/workflows/runs/:runId/pause` | 请求暂停（`queued` 立即转 `paused`，`running` 设 `pause_requested` 在安全断点停下） | `workflowRunDetailDtoSchema` |
| `POST /api/v1/workflows/runs/:runId/resume` | 断点续跑（可选上调 `maxCostUsd`，将未完成/失败步重置 `pending` 后重新入队） | `resumeWorkflowRunSchema` → `workflowRunDetailDtoSchema` |
| `POST /api/v1/workflows/runs/:runId/cancel` | 取消批次（剩余未跑步骤置 `skipped`） | `workflowRunDetailDtoSchema` |
| `POST /api/v1/workflows/runs/:runId/steps/:stepId/retry` | 重试单个失败步骤并重新入队续跑 | `workflowRunDetailDtoSchema` |
| `DELETE /api/v1/workflows/runs/:runId` | 删除终态批次（`completed`/`failed`/`cancelled`）；运行中或暂停返回 `409 WORKFLOW_RUN_ACTIVE` | `204 No Content` |
| `GET /api/v1/workflows/events` | 实时进度 SSE（可选 `?runId=` 过滤；帧名 `ready` / `workflow-event` / `ping`） | `workflowEventSchema` |

新增 Redis Pub/Sub 频道：`REDIS_CHANNELS.workflowEvents = 'fanxiaoshuo:events:workflows'`。
新增 SSE 帧名常量：`WORKFLOW_SSE_EVENT_NAMES = { ready: 'ready', workflowEvent: 'workflow-event', ping: 'ping' }`。
新增用量场景：`USAGE_SCENES.outlinePlan = 'outline-plan'`（加上已有的 `chapter-write`、`chapter-review`、`lore-extract`）。
新增错误码：`WORKFLOW_RUN_NOT_FOUND`(404)、`WORKFLOW_STEP_NOT_FOUND`(404)、`WORKFLOW_RUN_ACTIVE`(409)、`WORKFLOW_INVALID_STATE`(409)。

### 3. 单章 Mastra 编排与审稿返工闭环（`packages/agents`）

- 新增 `packages/agents/src/prompts/batch-workflow.ts`：
  - `buildChapterOutlinePrompts` / `parsePlannedOutline`：`showrunner` 依据总大纲、设定卡摘要、前序摘要与本章标题，生成结构化细纲（章节目标、核心冲突、3–5 节拍与章末钩子），容错支持 JSON 或纯文本 Markdown 兜底。
  - `buildChapterCriticPrompts` / `parseCriticReview`：`critic` 对本章正文做一致性、节奏、水文与人物口吻审查，要求输出 JSON `{"score": 0..100, "passed": bool, "summary": "...", "issues": [...], "reworkGuidance": "..."}`；`parseCriticReview(raw, minPassScore)` 容错剥离代码块/抽取 JSON，缺失 `passed` 时按 `score >= minPassScore` 推导，彻底非 JSON 时优雅降级为不阻断或给出可读总结。
  - `buildChapterReworkPrompts`：在原 `assembleChapterContext` 基础上追加「上一版初稿 + 审稿官评分/问题清单/返工指导」，驱动 `writer` 精准修改而非盲重写。
- 新增 `packages/agents/src/workflows/batch-chapter-workflow.ts` 并集成到 `createFanXiaoshuoRuntime`：
  - 注册 Mastra Workflow `fanxiaoshuo-batch-chapter`（3 个明确 Step：`plan-outline` → `draft-and-review` → `extract-summary`），暴露干净的 `runtime.runBatchChapterWorkflow(input, hooks?)` 方法。
  - 每次内部 `gateway.generateText` 调用都传入动态维护的 `budgetContext: { runId, maxCostUsd, spentCostUsd }`，并在每次调用后累加 Token/费用并通过 `onStageChange(stage)` 回调通知 Worker 落盘步骤阶段与推送 Redis 事件。
  - 遇到 `BudgetExceededError` 时立即上抛，让 Worker 捕获并安全转入 `paused (BUDGET_EXCEEDED)`。

### 4. BullMQ 调度、失败重试与断点续跑（`apps/server` + `apps/worker`）

- **队列名称**：复用已预留的 `QUEUE_NAMES.novelWorkflows = 'novel-workflows'`，载荷极简 `{ runId: string }`（所有业务配置与进度以 PostgreSQL 为唯一真相来源，避免队列载荷过重或过期）。
- **重试策略**：BullMQ 任务级关闭无脑全批重跑（`attempts: 1`，避免整批重复扣费），改为**步骤内受控重试 + 持久化断点续跑**：
  - 章节内单步失败记录在 `workflow_steps`，用户可检查错误或调预算后点击「续跑」或「重试单步」，绝不重复消耗已完成章节的 Token。
  - 若 Worker 进程意外重启，下次用户点「继续运行」即可从数据库持久化断点恢复。
- **并发与顺序**：
  - Worker 同进程同时监听 `runtime-smoke` 与 `novel-workflows` 两个 BullMQ 队列，共享连接池、心跳与优雅停机。
  - 单个 `novel-workflows` Job 串行遍历 `workflow_steps`（跳过 `completed` 与 `skipped`），每章执行前查询 `workflow_runs` 的 `pause_requested`、`cancel_requested` 与 `spent_cost_usd >= max_cost_usd`：
    - 若 `cancel_requested`：将剩余 `pending` 步置 `skipped`，批次置 `cancelled`，发布 `workflow.cancelled` 并退出。
    - 若 `pause_requested`：将批次置 `paused (USER_PAUSED)`，发布 `workflow.paused` 并退出。
    - 若超预算：将批次置 `paused (BUDGET_EXCEEDED)`，发布 `workflow.paused` 并退出。
- **安全写入章节**：Worker 拿到单章产出后，在 PG 事务内：
  1. 读取目标 `chapters` 行并先向 `chapter_revisions` 插入 `source: 'ai'` 备份快照（保留写前原稿）；
  2. 更新 `chapters.content_text`、`content_json = null`（由编辑器打开时按 `resolveEditorContent` 无损转 TipTap 文档）、`word_count = countNovelWords(...)`、`version = version + 1`、`status = criticEnabled ? 'reviewing' : 'draft'`；
  3. 同步 upsert `chapter_summaries`（若拆细纲则更新 `outline`，若提炼摘要则更新 `summary`/`key_events`/`characters_present`/`source='ai'`）。

### 5. 目录所有权与 Git Worktree 并行波次

- **Wave 1（串行先行，冻结契约）**：`packages/shared`（`feat/c4-shared`）
- **Wave 2（共享契约合入 `main` 后并行双 Worktree）**：
  - `packages/agents`（`feat/c4-agents`）：Showrunner/Critic/Rework Prompts、Mastra `fanxiaoshuo-batch-chapter` 工作流与单测
  - `apps/web`（`feat/c4-web`）：`/workflows` 实时批量流水线控制台、API/Store、SSE 订阅、导航路由更新与单测
- **Wave 3（`agents` 合入 `main` 后并行双 Worktree，目录零重叠！）**：
  - `apps/server`（`feat/c4-server`）：Drizzle `0003_*.sql` 迁移、仓储、BullMQ `novel-workflows` Producer、Redis `workflowEvents` 总线、REST & SSE 路由与集成测试
  - `apps/worker`（`feat/c4-worker`）：`novel-workflows` BullMQ Worker、PG 持久化存储、角色温度/Token 扩展、预算熔断/暂停取消检查点、原子 `ai` 快照写入与单元测试
- **Wave 4（集成验证）**：全仓 `typecheck`/`test`/`build`、真实 Docker PG 幂等迁移（13 张表）、启动真实 Server + 真实 Worker + Redis + PG + 本地 Mock OpenAI 上游 + Vite 执行全链路端到端冒烟（含全链路批量成文 + 审稿返工 + 摘要联动 + 预算熔断暂停 + 上调预算断点续跑 + `source: 'ai'` 快照验证 + 清理零污染），更新 `README.md`。

## Risks / Trade-offs

- **Risk 1：Server 与 Worker 并行开发导致 SQL 列名不一致** → **Mitigation**：`design.md` 已逐列冻结 `workflow_runs` 与 `workflow_steps` 的精确列名与类型，并在 Wave 4 运行真实 Server + 真实 Worker + 真实 Docker PostgreSQL 端到端冒烟，任何列名/类型偏差立刻暴露。
- **Risk 2：Worker 写回正文时破坏 TipTap JSON 格式** → **Mitigation**：Worker 写入 `content_text` 并将 `content_json` 置 `null`，前端 `resolveEditorContent()` 已在 Change 2 经过充分验证——`contentJson === null` 时按 `\n\n` 自动无损重建 TipTap 段落文档，且写前必留 `source: 'ai'` 快照。
- **Risk 3：SSE 推送在网络抖动或刷新后丢失中间帧** → **Mitigation**：所有状态真相均落盘 PostgreSQL，前端订阅 `GET /api/v1/workflows/events` 实时刷新同时在选中活跃批次时辅以低频轮询与断线自动拉取详情，刷新页面状态完全不丢。
- **Risk 4：审稿返工死循环烧光 Token** → **Mitigation**：`maxReworkRounds` 严格封顶（默认 1，上限 3），且每一轮写作与审稿前均强制通过 `maxCostUsd` 预算熔断检查。
