# Tasks

> 并行协作提示：**第 1 组（Monorepo、Infra 与 Shared 契约）**完成后，**第 2 组（`[agents]`）**、**第 3 组（`[server]`）**、**第 4 组（`[worker]`）**与**第 5 组（`[web]`）**可按 `AGENTS.md` 规范通过独立 `git worktree` 并行实施（其中第 3/4 组在联调前可基于第 2 组导出的接口签名开发，合流后执行第 6 组集成验收）。

## 1. Monorepo 骨架、Docker 基础设施与共享契约（串行前置，锁死契约）

- [x] 1.1 `[infra]` 初始化 pnpm workspace 根配置（`package.json`、`pnpm-workspace.yaml`、`tsconfig.base.json`、跨平台 `dev`/`build`/`typecheck`/`test`/`db:migrate` 脚本）并确认在 Windows PowerShell 与 Git Bash 下均可解析执行
- [x] 1.2 `[infra]` 编写 `infra/docker-compose.yml`（`pgvector/pgvector:pg17` 与 `redis:7-alpine`，含命名卷与 healthcheck）、`infra/init-db.sql`（启用 `vector` 扩展）与 `.env.example`（含 `DATABASE_URL`、`REDIS_URL`、`APP_ENCRYPTION_KEY` 生成说明）
- [x] 1.3 `[shared]` 创建 `packages/shared` 包，使用 Zod 定义全量共享契约：4 个写书 Agent 角色枚举（`showrunner`/`lorekeeper`/`writer`/`critic`）、Provider/Model/RoleBinding DTO、UsageLog 分页与汇总 DTO、Health 响应结构、SmokeJob 与 SSE 事件类型及统一错误码，并补齐契约单元测试且通过 `typecheck` 与 `test`

## 2. 统一 LLM 网关与 Mastra 多 Agent 运行时底座（可在第 1 组完成后并行）

- [x] 2.1 `[agents]` 创建 `packages/agents` 包，接入 Vercel AI SDK（`ai`、`@ai-sdk/openai-compatible` 及主流 Provider 适配），实现 `ModelGateway`（按模型配置实例化客户端、统一计算估算费用、执行 `generateText` / `streamText` 并通过回调输出结构化用量日志）
- [x] 2.2 `[agents]` 在 `packages/agents` 中集成 `@mastra/core` 运行时工厂，注册 4 个核心写书角色（`showrunner`/`lorekeeper`/`writer`/`critic`）的元信息占位与用于全链路验证的诊断 Workflow/Agent
- [x] 2.3 `[agents]` 编写 `packages/agents` 单元测试（Mock 上游响应覆盖成功计量、费用计算、超时与脱敏错误分类）并验证测试全部通过

## 3. Fastify 后端 API、Drizzle 数据库与加密存储（可在第 1 组完成后并行）

- [x] 3.1 `[server]` 创建 `apps/server` 包，配置环境变量 Zod 校验（缺失 `APP_ENCRYPTION_KEY` 时启动 fail-fast）、AES-256-GCM 加解密与 API Key 掩码工具，并编写加解密与脱敏单元测试
- [x] 3.2 `[server]` 配置 Drizzle ORM 与 PostgreSQL 连接，定义并生成 4 张核心表迁移（`llm_providers`、`llm_models`、`agent_role_bindings`、`llm_usage_logs`，含 `(provider_id, model_id)` 联合唯一约束与角色绑定 `ON DELETE RESTRICT`）
- [x] 3.3 `[server]` 实现 `/api/v1/providers`、`/api/v1/models`、`/api/v1/models/:id/test`（经 `ModelGateway` 真实测通并落盘 `llm_usage_logs`）与 `/api/v1/agent-roles` 路由及接口集成测试
- [x] 3.4 `[server]` 实现 `/api/v1/health`（主动探测 PG、Redis 与 Worker 心跳键）、`/api/v1/usage-logs`（分页筛选 + 汇总统计）与 `/api/v1/runtime/smoke-jobs` + `/api/v1/runtime/events`（BullMQ 入队 + Redis Pub/Sub SSE 转发）并验证路由测试通过

## 4. BullMQ 后台 Worker 与心跳/重试引擎（可在第 1 组完成后并行）

- [x] 4.1 `[worker]` 创建 `apps/worker` 包，建立 Redis 连接与 `runtime-smoke` BullMQ Worker（配置并发度、指数退避重试 `attempts: 3`、优雅停机 `SIGINT`/`SIGTERM`）
- [x] 4.2 `[worker]` 实现 Worker 定时心跳上报（每 10 秒刷新 Redis TTL 30s 键）与队列状态发布（向 `fanxiaoshuo:events:jobs` 推送排队/运行/完成/失败事件），并调用 `packages/agents` 的 Mastra 冒烟 Workflow 完成任务执行
- [x] 4.3 `[worker]` 编写 Worker 任务执行、重试上限与事件发布单元测试并验证通过

## 5. Vue 3 + Naive UI「梵小说」工作台外壳与配置页（可在第 1 组完成后并行）

- [x] 5.1 `[web]` 创建 `apps/web` 包（Vue 3 + TypeScript + Vite + Pinia + Vue Router + Naive UI），实现首屏内联防闪白脚本与明暗双主题切换持久化（`localStorage['fx.ui.theme']`）
- [x] 5.2 `[web]` 实现「梵小说」桌面工作台外壳布局（固定可折叠侧边导航、顶部健康状态指示徽章、书架/批量流水线/工具盒规范占位页与 404 回退页）
- [x] 5.3 `[web]` 实现「模型配置中心」页面（Provider 列表与新增/编辑/删除、脱敏 Key 展示、模型目录与单价管理、一键「测通」反馈弹窗、4 个写书角色路由槽位绑定）
- [x] 5.4 `[web]` 实现「用量与状态」页面（PG/Redis/Worker 实时诊断卡片、触发并实时追踪 BullMQ + Mastra 冒烟任务 SSE 状态流转、用量日志分页表与总 Token/费用汇总卡片），并验证前端构建与类型检查通过

## 6. 全仓合流与端到端冒烟验收（集成校验）

- [x] 6.1 `[infra]` 在全仓执行 `pnpm typecheck`、`pnpm test` 与 `pnpm build`，修复全部跨包类型或构建问题
- [x] 6.2 `[infra]` 启动 Docker（PG + Redis），执行 `pnpm db:migrate` 验证幂等迁移，启动 `server` + `worker` + `web` 完成端到端冒烟验证：① 健康页全部绿色在线；② 新增模型并测通成功落盘脱敏日志；③ 触发 Mastra + BullMQ 冒烟任务并经 SSE 观察状态流转至完成；④ 暗黑主题刷新无闪白
- [x] 6.3 `[infra]` 补充根目录 `README.md`（快速启动步骤、Docker 命令、多 Agent Git Worktree 协作命令速查）并核对所有文档命令真实可执行

## Workflow follow-up

- 验收全部通过后执行 `/openspec-verify-change` 对照 `specs` 复核。
- 复核无误后执行 `/openspec-archive-change` 同步主规格并合并至 `main`。
