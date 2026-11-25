# Proposal

## Why

「梵小说」从零立项，需要在一个干净的独立仓库内一次性定型 Monorepo 目录边界、Docker 基础设施（PostgreSQL + pgvector、Redis）、统一 LLM 网关、Mastra + BullMQ 运行期底座以及 Vue 3 + Naive UI 工作台外壳。先打牢这套底座与契约边界，才能让后续书库编辑器、设定记忆层与批量成文多 Agent 流水线安全并行演进而不反复推翻重构。

## What Changes

### 范围内（In Scope）
- 搭建 pnpm TypeScript Monorepo 骨架：`packages/shared`、`packages/agents`、`apps/server`、`apps/worker`、`apps/web` 与 `infra/`。
- 配置 Docker Compose 本地基础设施：PostgreSQL（`pgvector/pgvector:pg17`）与 Redis（`redis:7-alpine`），提供健康检查、命名卷持久化与 `.env.example`。
- 建立数据库基础表与 Drizzle 迁移体系：`llm_providers`、`llm_models`、`agent_role_bindings`、`llm_usage_logs`，以及系统健康检查接口（验证 PG、Redis 与 Worker 连通性）。
- 实现 **模型配置与路由中心（Model Registry）**：支持管理多个 OpenAI-compatible 中转站与官方模型、加密存储 API Key（前端脱敏展示）、配置单价、按写书 Agent 角色（`showrunner` / `lorekeeper` / `writer` / `critic`）绑定默认模型，并支持「一键测通」验证真实对话连通性与延迟。
- 落地 **运行期多 Agent 最小底座（Agent Runtime Foundation）**：在 `packages/agents` 集成 Vercel AI SDK + Mastra 引擎骨架与统一调用计量包装器，在 `apps/worker` 接入 BullMQ 队列消费与心跳/烟雾测试任务（验证 PG + Redis + Mastra + Worker 全链路贯通）。
- 搭建 **梵小说工作台外壳（Workbench Shell）**：基于 Vue 3 + Vite + Pinia + Vue Router + Naive UI，提供侧边导航（书架、批量流水线、工具盒、模型配置、用量日志的路由壳与占位页）、浅色/暗黑双主题切换与首屏防闪白，以及完整的「模型配置中心」与「系统状态/用量日志」可用页面。

### 明确不做（Out of Scope）
- 不在本变更中实现书架 CRUD、卷章树、TipTap 章节编辑器（归属 Change 2）。
- 不在本变更中实现书设定集（人物卡/世界观/章节摘要）与正文章节续写（归属 Change 3）。
- 不在本变更中实现网文批量生成流水线业务逻辑（归属 Change 4）。
- 不做对外商业化登录注册、支付计费、论坛榜单或 6 套扩展主题。

## Capabilities

### New Capabilities
- `workbench-shell`: 提供「梵小说」桌面端工作台导航外壳、明暗双主题持久化与首屏防闪白、以及前后端/基础设施健康状态展示。
- `model-registry`: 提供多 LLM Provider 与模型配置管理、API Key 加密与脱敏、写书 Agent 角色默认模型槽位绑定，以及真实模型连通性测试。
- `agent-runtime-foundation`: 提供基于 Docker（PostgreSQL + pgvector、Redis）的数据持久化、统一 LLM 调用计量流水、Mastra 运行时初始化与 BullMQ 异步任务队列底座。

### Modified Capabilities
- （无，本次为项目首个变更）

## Impact

- **对开发期多 Coding Agent 协作的影响**：确立 `packages/shared`（契约先行）→ `infra` / `apps/server` / `packages/agents` / `apps/worker` / `apps/web` 的严格目录所有权边界，使后续所有 Change 都能通过 Git Worktree 拆给 Pi / Codex / Antigravity 并行实施且互不冲突。
- **对运行期多 Agent 架构的影响**：预先在数据库与网关层定型 4 个核心写书角色（`showrunner`、`lorekeeper`、`writer`、`critic`）的模型路由槽位、统一 Token/成本计量与 BullMQ + Mastra 异步执行骨架，后续只需按角色编排 Prompt、工具与 Workflow DAG。
- **依赖与基础设施**：引入 `pnpm` workspace、Vue 3、Naive UI、Fastify、Drizzle ORM、`pg`、BullMQ、`ioredis`、Vercel AI SDK（`ai`、`@ai-sdk/openai-compatible`）与 `@mastra/core`；本地运行依赖 Docker Desktop 启动 PG 与 Redis 容器。
