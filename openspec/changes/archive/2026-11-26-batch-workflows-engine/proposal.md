# Proposal: batch-workflows-engine

## Why

完成书架编辑器（Change 2）与 Book Bible 设定记忆及章内流式写作（Change 3）后，作者已经能够单章高质量创作，但「梵小说」作为内部批量网文创作工作台的核心价值——**无人值守多章批量生产闭环（批量拆细纲 → 逐章连贯成文 → 自动审稿返工 → 自动更新摘要 → 预算熔断与断点续跑）**——尚未落地，`/workflows` 页面目前仍是占位视图。此时基于已就绪的 `ModelGateway` 预算控制、Mastra 运行时门面、BullMQ/Redis 队列底座与 Book Bible 记忆层构建批量流水线引擎，即可跑通整本书的自动化批量生产能力。

## What Changes

- 新增 **批量写书流水线引擎（Batch Workflows Engine）**：
  - 支持 3 种批量运行模式：`outline_only`（`showrunner` 批量拆解章节细纲）、`write_chapters`（`writer` 逐章连贯成文 + 可选 `critic` 审稿返工 + 可选 `lorekeeper` 摘要提炼）与 `full_pipeline`（全链路拆细纲 → 写正文 → 审稿返工 → 提炼摘要）。
  - 支持两种章节目标选择：勾选本书已有章节按阅读顺序批量执行，或指定分卷与数量自动按序新建待写章节并纳入批次。
  - 在 `packages/agents` 扩展 Mastra 运行时门面，新增 `showrunner` 细纲规划提示词与解析器、`critic` 结构化审稿裁判（0–100 评分、通过判定、问题清单与返工指导）、`writer` 返工改写提示词，以及封装单章编排的 Mastra 工作流 `fanxiaoshuo-batch-chapter`。
  - 在 `apps/server` 新增 Drizzle 迁移 `0003_*.sql`（`workflow_runs`、`workflow_steps`）、批次 CRUD 与控制端点（创建、列表、详情、暂停、断点续跑、取消、单步重试、删除）、BullMQ `novel-workflows` 队列生产者，以及基于 Redis Pub/Sub 的实时 SSE 进度推送端点 `GET /api/v1/workflows/events`。
  - 在 `apps/worker` 新增 `novel-workflows` BullMQ 消费者，按序推进章节步骤：执行前检查暂停/取消/预算熔断，调用 Mastra 单章流水线（经 `ModelGateway` 强制记录 `llm_usage_logs` 与费用累加），写回正文前先在事务内自动留底 `source: 'ai'` 不可变快照，写完自动更新摘要供下一章立即召回，实时向 Redis Pub/Sub 广播进度事件。
  - **预算熔断与断点续跑**：运行达到 `maxCostUsd` 上限时自动将批次置为 `paused`（`pauseReason: 'BUDGET_EXCEEDED'`）并完整保留已完成章节；用户可随时暂停、上调预算后继续执行（断点续跑）或单步重试失败章节。
- 升级 **工作台导航与 `/workflows` 视图（Workbench Shell）**：
  - 将前端 `/workflows` 从规划占位页升级为完整的「批量流水线」实时控制台，支持新建批次、预算仪表盘、实时 SSE 步骤时间线、审稿评分/问题详情查看、暂停/续跑/取消/重试控制以及一键跳转至生成章节编辑器。

## Capabilities

### New Capabilities

- `batch-workflows`: 基于 Mastra + BullMQ 的多 Agent 批量写书流水线（拆细纲、逐章成文、审稿返工闭环、自动摘要更新）、预算熔断保护、暂停/断点续跑/取消/单步重试控制、Redis Pub/Sub → SSE 实时进度流与 `/workflows` 批量控制界面。

### Modified Capabilities

- `workbench-shell`: `/workflows` 模块由占位视图升级为实时「批量流水线」控制台，仅剩「创作工具盒（`/toolbox`）」作为后续 Change 5 占位视图。

## Impact

- **`packages/shared`**：新增工作流常量（运行模式、运行/步骤状态、步骤阶段、SSE 事件名、`REDIS_CHANNELS.workflowEvents`、`USAGE_SCENES.outlinePlan`）、错误码（`WORKFLOW_RUN_NOT_FOUND`、`WORKFLOW_STEP_NOT_FOUND`、`WORKFLOW_RUN_ACTIVE`、`WORKFLOW_INVALID_STATE`）及批量运行/步骤/控制/SSE 事件 Zod v4 契约。
- **`packages/agents`**：新增 `showrunner` 细纲规划、`critic` 结构化审稿解析、`writer` 返工提示词，以及注册到 `FanXiaoshuoRuntime` 的 Mastra 单章批量工作流 `runBatchChapterWorkflow`。
- **`apps/server`**：新增 Drizzle 迁移 `0003_*.sql`（`workflow_runs`、`workflow_steps`）、仓储、BullMQ `novel-workflows` 队列生产者、Redis `workflowEvents` 总线与 `/api/v1/workflows/*` REST + SSE 路由。
- **`apps/worker`**：新增 `novel-workflows` 队列消费者、PG 工作流持久化仓储、角色配置（含 `temperature`/`max_tokens`）解析扩展与实时事件发布器，支持与既有 `runtime-smoke` Worker 同进程平滑共存与优雅停机。
- **`apps/web`**：替换 `WorkflowsView.vue` 为真实批量流水线控制台，新增 `workflows` API 客户端、Pinia Store、新建批次弹窗、实时步骤详情面板与 SSE + 轮询兜底订阅。
- **非目标（明确留待 Change 5）**：创作工具盒（`/toolbox`）Schema 驱动表单工具集与独立 Embedding 向量化定时任务。
