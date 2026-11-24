# Design

## Context

参见 `proposal.md` 的背景与目标。本项目为全新立项的内部批量网文创作工作台，本机已具备 Node.js 22、Git 与 Docker Desktop CLI，且已配置 OpenSpec `expanded` 工作流与多 Coding Agent 协作宪法（`AGENTS.md`）。本设计文档定型 Change 1 的 Monorepo 架构、Docker 基础设施、数据库 Schema、契约边界、安全加密以及运行期多 Agent 底座（Mastra + Vercel AI SDK + BullMQ）的落地方式。

## Goals / Non-Goals

**Goals:**
- 建立边界清晰、Windows 与 POSIX 均顺畅运行的 pnpm TypeScript Monorepo，支撑后续多 Coding Agent 并行开发。
- 通过 Docker Compose 一键拉起 PostgreSQL（含 `pgvector`）与 Redis，配合 Drizzle ORM 实现可追踪的 Schema 迁移。
- 落地「契约先行」的 `packages/shared`，使 API、Worker 与前端共享同一份 Zod Schema 与 DTO 类型。
- 建立统一的 LLM 调用网关与可验证的 Mastra + BullMQ 异步任务底座，确保从第一天起所有模型调用都有密钥加密、Token 计量与成本审计。
- 交付可实际操作的「梵小说」Naive UI 工作台外壳、模型配置中心与系统健康/用量监控页。

**Non-Goals:**
- 不实现用户登录鉴权体系（内部工具本地/内网阶段可后续按需加口令中间件）。
- 不实现书库、卷章树、TipTap 编辑器或实际写书 Prompt 编排（留给 Change 2–4）。
- 不引入 Kubernetes 或复杂微服务网关；当前保持「1 API 进程 + 1 Worker 进程 + 1 前端开发服务 + Docker PG/Redis」的清晰拓扑。

## Decisions

### 1. Monorepo 目录所有权与包依赖拓扑
采用 pnpm workspaces，依赖方向严格单向无环：
```text
packages/shared  (无内部依赖：Zod schemas, DTO, 角色枚举, SSE 事件, 错误码)
       ▲
       ├── packages/agents (依赖 shared：Vercel AI SDK 统一网关、Mastra 实例、计费回调)
       │         ▲
       │         ├── apps/server (依赖 shared, agents：Fastify API + Drizzle DB + BullMQ Producer)
       │         └── apps/worker (依赖 shared, agents：BullMQ Worker + Mastra Workflow Runner + 心跳上报)
       └── apps/web (仅依赖 shared：Vue 3 + Vite + Pinia + Vue Router + Naive UI)
infra/ (独立基础设施：docker-compose.yml, init-db.sql)
```
- **理由**：前端仅依赖 `packages/shared`，绝对不触碰服务端/Node 依赖；AI 逻辑收口于 `packages/agents`，API 与 Worker 复用同一套模型解析与计量逻辑。
- **替代方案**：把所有后端代码塞进一个 `apps/server` 单包 → 缺点是后续批量 Worker 与 API 进程耦合、多 Coding Agent 并行修改容易冲突。

### 2. 运行期多 Agent 架构：Mastra + Vercel AI SDK + BullMQ（Redis）+ PostgreSQL（pgvector）
- **模型接入层**：使用 Vercel AI SDK（`ai` + `@ai-sdk/openai-compatible` + 官方 provider 适配器），由 `packages/agents` 中的 `ModelGateway` 统一从 DB 解析 `provider + model + 解密后的 apiKey`，包装 `generateText` / `streamText` / `generateObject`，在完成或异常后统一触发用量落盘钩子。
- **多 Agent 编排层**：引入 `@mastra/core`（配合 Postgres 存储扩展预留）定义清晰的 4 角色注册表（`showrunner`、`lorekeeper`、`writer`、`critic`）。在 Change 1 中先落地 Mastra 实例工厂、角色元数据与最小诊断 Agent/Workflow（供冒烟任务验证），Change 3–4 直接在同一骨架上挂载写书工具与循环审稿图。
- **异步批量调度层**：使用 BullMQ + Redis 承载后台任务队列（Change 1 先建 `runtime-smoke` 队列，后续扩展 `novel-workflows` 队列），内置：
  - 并发度控制（`concurrency` 可环境变量配置）与速率限制位预留；
  - 失败重试：默认 `attempts: 3`，`backoff: { type: 'exponential', delay: 2000 }`；
  - Worker 心跳：Worker 启动后每 10 秒向 Redis 写入 `fanxiaoshuo:worker:heartbeat`（TTL 30 秒，含进程 ID、活跃任务数与时间戳），供健康检查接口探测；
  - 实时进度通道：任务状态变化发布至 Redis Pub/Sub（`fanxiaoshuo:events:jobs`），Fastify 提供 SSE 端点按需转发给前端。
- **预算熔断预留**：`ModelGateway` 调用上下文携带可选 `budgetContext`（`runId`、`maxCostUsd`），Change 1 完成单次成本计算与落盘，Change 4 批量流水线直接开启累计费用熔断拦截。
- **替代方案**：
  - *LangGraph.js*：强在复杂动态循环图，但 TS 侧样板代码较重、版本常滞后 Python 侧；网文批量生产以「确定性主干流水线 + 局部 Writer↔Critic 审稿闭环 + 强类型记忆」为主，Mastra 的 TS/Zod 原生体验与 Postgres 持久化工况更轻快。
  - *纯自研状态机（无框架）*：短期简单，但后续加工具调用追踪、Agent 记忆与人工挂起恢复（suspend/resume）会重复造轮子。

### 3. 核心数据库表设计（PostgreSQL + Drizzle ORM）
Docker Compose 使用 `pgvector/pgvector:pg17`，初始化脚本执行 `CREATE EXTENSION IF NOT EXISTS vector;` 为 Change 3 语义检索留好底座。Change 1 建 4 张核心表：

1. `llm_providers`
   - `id` (uuid PK), `name` (text unique), `protocol` (`'openai-compatible' | 'openai' | 'anthropic' | 'google'`), `base_url` (text), `api_key_encrypted` (text), `api_key_mask` (text), `is_enabled` (boolean default true), `created_at`, `updated_at`
2. `llm_models`
   - `id` (uuid PK), `provider_id` (uuid FK -> `llm_providers.id` on delete cascade), `model_id` (text), `display_name` (text), `context_window` (integer nullable), `input_price_per_1m` (numeric(12,6) default 0), `output_price_per_1m` (numeric(12,6) default 0), `is_enabled` (boolean default true), `created_at`, `updated_at`
   - 联合唯一索引：`(provider_id, model_id)`
3. `agent_role_bindings`
   - `role` (text PK：`showrunner | lorekeeper | writer | critic`), `model_id` (uuid FK -> `llm_models.id` on delete restrict), `temperature` (real default 0.7), `max_tokens` (integer nullable), `updated_at`
   - `ON DELETE RESTRICT` 直接在数据库层兜底「禁止删除仍被角色绑定的模型」。
4. `llm_usage_logs`（Append-only 不可变审计表）
   - `id` (uuid PK), `role` (text nullable), `provider_id` (uuid nullable), `model_ref` (text，记录快照 `provider/modelId`), `scene` (text：如 `connectivity-test` / `smoke-job` / 后续 `chapter-write`), `input_tokens` (integer default 0), `output_tokens` (integer default 0), `estimated_cost_usd` (numeric(12,6) default 0), `latency_ms` (integer), `status` (`'success' | 'error'`), `error_code` (text nullable), `error_message` (text nullable，已脱敏), `created_at` (timestamptz default now)

### 4. API Key 加密与脱敏策略
- 使用 Node 内置 `node:crypto` 的 **AES-256-GCM**（随机 12 字节 IV + 16 字节 AuthTag，存储格式 `v1:<ivHex>:<tagHex>:<cipherHex>`），主密钥来自环境变量 `APP_ENCRYPTION_KEY`（32 字节 hex/base64，`.env.example` 提供生成命令，未配置时服务启动 fail-fast 报错）。
- 脱敏掩码 `api_key_mask` 在写入时计算（长度 >= 10 显示前 3 后 4，如 `sk-***9f2a`；更短则全掩码），所有 GET 响应与错误日志只读 `api_key_mask`。

### 5. REST / SSE API 契约（`apps/server`，统一前缀 `/api/v1`）
- `GET /api/v1/health`：主动探测 PG（`SELECT 1`）、Redis（`PING`）、Worker 心跳键，返回 `{ status: 'ok' | 'degraded', checks: { postgres, redis, worker }, timestamp }`。
- `GET/POST /api/v1/providers`、`PATCH/DELETE /api/v1/providers/:id`
- `GET/POST /api/v1/models`、`PATCH/DELETE /api/v1/models/:id`、`POST /api/v1/models/:id/test`（同步执行一次轻量测通并返回预览/延迟/Token，同时落盘 `llm_usage_logs`）
- `GET/PUT /api/v1/agent-roles`（查询或批量更新 4 个写作角色绑定）
- `GET /api/v1/usage-logs`（分页 + 时间范围/状态/角色筛选 + 聚合汇总 `totalRequests / totalInputTokens / totalOutputTokens / totalCostUsd`）
- `POST /api/v1/runtime/smoke-jobs`（入队一个 BullMQ + Mastra 冒烟任务，可选是否真实调一次绑定的模型或仅验证引擎+队列）
- `GET /api/v1/runtime/smoke-jobs/:jobId` 与 `GET /api/v1/runtime/events`（SSE 推送队列任务状态流转）

### 6. 前端工作台外壳与首屏防闪白（`apps/web`）
- 使用 Vue 3 + Vite + Pinia + Vue Router + Naive UI（`<n-config-provider>` 注入 `darkTheme` / `null`）。
- 主题偏好存 `localStorage['fx.ui.theme']`（`'light' | 'dark'`），在 `index.html` `<head>` 内置一段极简同步脚本，在首次渲染前给 `<html>` 挂 `dark` 类并设置深色底色变量，彻底消除暗黑模式刷新闪白。
- 左侧固定可折叠导航：`书架（占位）`、`批量流水线（占位）`、`工具盒（占位）`、`模型配置`、`用量与状态`；顶部状态栏展示当前健康状态徽章与明暗主题切换开关。

## Risks / Trade-offs

- **[Risk] 本机尚未激活 pnpm 或 PowerShell 执行策略拦截 `.ps1` 脚本** → Mitigation：在根 `package.json` 固定 `packageManager`，在文档与脚本中提供 `corepack enable` / `npm exec pnpm` 兼容指引，且所有脚本避免使用 POSIX 独占命令，确保 Windows PowerShell 与 Git Bash 均可一键运行。
- **[Risk] Mastra 生态迭代快，个别存储插件 API 可能有小版本破坏性变更** → Mitigation：Change 1 仅在 `packages/agents` 内部封装 Mastra 实例与 Adapter 边界，不向 `apps/server` 或 `apps/web` 暴露 Mastra 内部类型，后续升级只需改动单一包。
- **[Risk] 用户未启动 Docker Desktop 即运行开发命令** → Mitigation：启动脚本与 `/api/v1/health` 明确提示 PostgreSQL / Redis 连接诊断信息，前端状态栏友好展示离线组件而不崩溃。
- **[Risk] 中转站模型价格币种不一（人民币 vs 美元）** → Mitigation：单价字段默认按 USD / 1M tokens 存储（界面标注清晰），后续如需要人民币换算可在设置表增加汇率展示项，不改动账本底层精度。

## Migration Plan

- **初始化顺序**：
  1. 拷贝 `.env.example` 为 `.env` 并生成 `APP_ENCRYPTION_KEY`。
  2. 启动 Docker Desktop，执行 `docker compose -f infra/docker-compose.yml up -d` 等待 PG 与 Redis 均变为 `healthy`。
  3. 执行 `pnpm db:migrate` 创建全部基础表与索引。
  4. 执行 `pnpm dev` 并行拉起 `apps/server`、`apps/worker` 与 `apps/web`。
- **回滚策略**：本变更为全新立项底座，若需重置本地环境，可直接 `docker compose -f infra/docker-compose.yml down -v` 清空本地卷并重新迁移。
