# Tasks: batch-workflows-engine

> 执行依赖与并行说明：
> - **Wave 1**（任务组 1，`[shared]`）先行锁定所有跨包契约并合入 `main`。
> - **Wave 2**（任务组 2 `[agents]` 与任务组 3 `[web]`）在 Wave 1 合入后通过两个独立 `git worktree` **并行开发**。
> - **Wave 3**（任务组 4 `[server]` 与任务组 5 `[worker]`）在 Wave 2 的 `[agents]` 合入后通过两个独立 `git worktree` **并行开发**（二者目录完全隔离，依据 `design.md` 冻结的表结构与共享契约独立落盘并单测）。
> - **Wave 4**（任务组 6，集成验证）合流全仓验证、真实 Server + Worker + Redis + PG + Mock LLM 端到端冒烟并更新文档。

## 1. 共享契约锁定（Wave 1 · 串行先行）

- [ ] 1.1 `[shared]` 在 `packages/shared/src/constants/workflows.ts`、`packages/shared/src/constants/runtime.ts` 与 `packages/shared/src/errors.ts` 新增批量流水线常量（运行模式 `WORKFLOW_MODES`、运行状态 `WORKFLOW_RUN_STATUSES`、步骤状态 `WORKFLOW_STEP_STATUSES`、步骤阶段 `WORKFLOW_STEP_STAGES`、暂停原因 `WORKFLOW_PAUSE_REASONS`、事件类型 `WORKFLOW_EVENT_TYPES`、SSE 帧名 `WORKFLOW_SSE_EVENT_NAMES`、`REDIS_CHANNELS.workflowEvents`、`USAGE_SCENES.outlinePlan`、预算与返工常量）与错误码（`WORKFLOW_RUN_NOT_FOUND`、`WORKFLOW_STEP_NOT_FOUND`、`WORKFLOW_RUN_ACTIVE`、`WORKFLOW_INVALID_STATE`），补充单元测试校验枚举与错误码映射完整。
- [ ] 1.2 `[shared]` 新增 `packages/shared/src/schemas/workflow.ts` 并从 `packages/shared/src/index.ts` 导出：定义创建批次请求（支持 `chapterIds` 或 `autoCreateChapters` 互斥校验）、批次配置、步骤 DTO、批次摘要与详情 DTO、分页列表查询/响应、续跑请求（可选上调 `maxCostUsd`）、队列任务负载 `workflowJobPayloadSchema` 与 Redis/SSE 事件 `workflowEventSchema`（全量 Zod v4 `strictObject`），编写单元测试覆盖合法输入、默认值与非法边界拒绝。

## 2. Mastra 批量单章编排与 Showrunner/Critic Prompt（Wave 2 · 可与任务组 3 并行）

- [ ] 2.1 `[agents]` 新增 `packages/agents/src/prompts/batch-workflow.ts`：实现原创中文 `buildChapterOutlinePrompts` + `parsePlannedOutline`（`showrunner`）、`buildChapterCriticPrompts` + `parseCriticReview`（`critic` 0–100 评分、通过判定、问题清单与返工指导，支持代码块/JSON 抽取与纯文本兜底）以及 `buildChapterReworkPrompts`（`writer` 按审稿意见返工），补齐单元测试。
- [ ] 2.2 `[agents]` 新增 `packages/agents/src/workflows/batch-chapter-workflow.ts` 并集成至 `packages/agents/src/runtime/create-runtime.ts` 与 `packages/agents/src/index.ts`：在 Mastra 中注册 `fanxiaoshuo-batch-chapter` 工作流并暴露 `runtime.runBatchChapterWorkflow(input, hooks)`，串起 `plan-outline` → `draft-and-review`（含 `maxReworkRounds` 返工循环）→ `extract-summary`，全程透传 `BudgetContext` 至 `ModelGateway` 并在触及预算时抛出 `BudgetExceededError`，编写单元测试覆盖全流程、返工闭环、只拆细纲模式与预算熔断。

## 3. 前端批量流水线实时控制台（Wave 2 · 可与任务组 2 并行）

- [ ] 3.1 `[web]` 新增 `apps/web/src/api/workflows.ts`（并从 `api/index.ts` 导出）与 Pinia Store `apps/web/src/stores/workflows.ts`：实现批次列表/创建/详情/暂停/断点续跑/取消/单步重试/删除客户端、`EventSource` 订阅 `GET /api/v1/workflows/events` 实时合并进度与断线轮询兜底，并编写 Store 单元测试覆盖状态刷新、SSE 实时更新与错误收敛。
- [ ] 3.2 `[web]` 将 `apps/web/src/views/WorkflowsView.vue` 从占位视图升级为完整的「批量流水线」控制台（配套 `apps/web/src/components/workflows/` 子组件如 `CreateWorkflowModal.vue`、`WorkflowRunDetail.vue`），支持选择书籍与章节（或自动建章）、配置模式/审稿/返工/摘要/预算上限、实时进度条与费用表盘、逐章步骤时间线（审稿得分/问题清单/阶段标签/直达编辑器链接）、暂停/上调预算续跑/取消/重试/删除操作，同步更新 `apps/web/src/router/routes.ts` 侧边栏描述与路由测试，确保 `typecheck` / `test` / `build` 全绿。

## 4. 服务端迁移、队列调度与工作流接口（Wave 3 · 依赖 Wave 2 `[agents]`，可与任务组 5 并行）

- [ ] 4.1 `[server]` 在 `apps/server/src/db/schema.ts` 新增 `workflow_runs` 与 `workflow_steps` 表定义及索引，执行 `drizzle-kit generate` 生成 `0003_*.sql` 迁移（更新 `migration.test.ts`），并在 `apps/server/src/repositories/` 新增 `WorkflowRunRepository` 接口、Drizzle 实现与内存测试仓储，新增 BullMQ `novel-workflows` 队列生产者与 `workflowEvents` Redis Pub/Sub 事件总线，接入 `ServerDependencies` 与 `src/index.ts`。
- [ ] 4.2 `[server]` 新增 `apps/server/src/routes/workflows.ts` 并挂载至 `buildServer`：实现 `GET/POST /workflows/runs`（含 `autoCreateChapters` 建章、角色前置校验、`maxCostUsd` 记录与入队）、`GET /workflows/runs/:runId`、`POST /pause`、`/resume`（含上调预算与重置未完成步）、`/cancel`、`/steps/:stepId/retry`、`DELETE /workflows/runs/:runId`（拦截活跃态 409）以及 `GET /workflows/events` SSE 端点（支持 `?runId=` 过滤），编写 `app.inject()` 集成测试覆盖全路径与异常分支。

## 5. Worker 批量流水线消费者与安全落盘（Wave 3 · 依赖 Wave 2 `[agents]`，可与任务组 4 并行）

- [ ] 5.1 `[worker]` 扩展 `apps/worker/src/db/model-repository.ts`（同时返回角色绑定的 `temperature` 与 `maxTokens`），新增 `apps/worker/src/db/workflow-repository.ts`（基于 `pg` 读取/更新 `workflow_runs`、`workflow_steps`、Book Bible 数据，以及单事务先插 `source: 'ai'` 留底快照再更新 `chapters` 与 `chapter_summaries` 的安全写入方法）与 `apps/worker/src/events/workflow-events.ts`（Redis Pub/Sub `fanxiaoshuo:events:workflows` 发布器）。
- [ ] 5.2 `[worker]` 新增 `apps/worker/src/jobs/workflow-job.ts` 并在 `apps/worker/src/worker.ts` 同时启动 `novel-workflows` BullMQ Worker（与 `runtime-smoke` 共享心跳、连接池与优雅停机）：实现按序推进未完成步骤、每步前检查暂停/取消/预算熔断、调用 `runtime.runBatchChapterWorkflow`（累计 Token 与费用、捕获 `BudgetExceededError` 转 `paused`）、广播实时事件与单步失败脱敏隔离，补齐单元测试确保 `typecheck` / `test` / `build` 全绿。

## 6. 全仓集成验收与文档更新（Wave 4 · 集成检查）

- [ ] 6.1 `[shared][agents][server][worker][web]` 合流所有分支并清理 Worktree，执行跨包缝隙审计（校验 Server Drizzle SQL、Worker `pg` SQL、前端 API 与共享契约 100% 一致），运行 `pnpm typecheck`、`pnpm test`、`pnpm build` 与真实 Docker PostgreSQL 幂等迁移 `pnpm db:migrate` x2（验证 13 张表就绪）。
- [ ] 6.2 `[server][worker][web]` 启动本地 Mock OpenAI 兼容服务器 + 真实 Fastify Server + 真实 BullMQ Worker + 真实 Docker PostgreSQL/Redis + Vite 前端，执行端到端冒烟验证（建书建 2 章 → 绑定 4 角色 → 创建 `full_pipeline` 批次并开启审稿返工与摘要 → 订阅 `/workflows/events` SSE 观察实时进度 → 验证第 1 章触发返工复审并生成 `source: 'ai'` 快照、第 2 章召回第 1 章摘要 → 验证极小 `maxCostUsd` 触发预算熔断 `paused(BUDGET_EXCEEDED)` → 上调预算 `resume` 断点续跑完成 → 清理全部测试数据零污染），更新 `README.md`。

## Workflow follow-up

- Run `/openspec-verify-change` to verify implementation against all Change 4 specs and design requirements.
- Archive the change after user review and approval.
