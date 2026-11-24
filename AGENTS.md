# AGENTS.md — 「梵小说」多 AI Agent 工程协作宪法

本项目 **梵小说（FanXiaoshuo）** 是面向内部批量网文创作的 AI 工作台，采用 **双层多 AI Agent 协作架构**：
1. **开发期（Dev-Time）**：基于 **OpenSpec (`expanded`) + Git Worktree + 模块所有权边界**，支持 Pi / Codex / Antigravity 等多个 Coding Agent 并行开发、独立校验、安全合流。
2. **运行期（Runtime）**：基于 **Mastra + Vercel AI SDK + BullMQ (Redis) + PostgreSQL (`pgvector`)**，由专业分工的写书 Agent（总编策划 / 设定档案员 / 执笔写手 / 审稿质检）驱动批量成文流水线。

---

## 一、目录所有权边界（Parallel Agent Ownership Zones）

为避免多 Coding Agent 并行修改产生冲突，严格遵守以下目录边界：

| 目录 | 归属角色 | 职责说明 |
|---|---|---|
| `openspec/` | Architect / Lead Agent | 规格说明书（`specs/`）与进行中变更（`changes/`），变更前必须先定稿 spec |
| `packages/shared/` | Contract Owner（先行锁定） | Zod Schema、前后端 DTO、SSE 事件协议、领域常量与错误码。**任何跨包改动必须先更新此包并冻结契约** |
| `infra/` | Infra Agent | `docker-compose.yml`（PostgreSQL + pgvector、Redis）、初始化脚本与环境模板 |
| `apps/server/` | Backend Agent | Fastify REST/SSE API、Drizzle Schema & Migrations、基础配置/书库/任务查询 |
| `packages/agents/` | AI Pipeline Agent | Vercel AI SDK 统一模型网关（支持 OpenAI-compatible 中转站）、Mastra Agents/Workflows/Tools、Prompt 模板与 Token 计费拦截器 |
| `apps/worker/` | Worker Agent | BullMQ Worker 消费端、并发/RPM 限流、预算熔断、Redis Pub/Sub 实时进度推送 |
| `apps/web/` | Frontend Agent | Vue 3 + Vite + Pinia + Vue Router + Naive UI 工作台 UI、TipTap 编辑器、SSE 监控视图 |

---

## 二、多 Coding Agent 标准工作流（OpenSpec Expanded + Worktree）

1. **阶段 1 · 规格定型（主分支 / 单 Agent）**
   - 使用 `/openspec-new-change` → `/openspec-continue-change`（或 `/openspec-propose`）产出 `proposal.md`、`specs/`、`design.md`、`tasks.md`。
   - 审核通过前**禁止写业务代码**。
2. **阶段 2 · 契约先行（Contract-First）**
   - 先完成 `[infra]` 与 `[shared]` 任务并合入 Change 集成分支（如 `feat/<change-name>`），锁死 TypeScript 类型与 Zod Schema。
3. **阶段 3 · 并行实施（Git Worktree 隔离）**
   - 不同 Coding Agent 各自在独立 worktree 中领取互不重叠的模块标签任务：
     ```bash
     git worktree add ../fanxiaoshuo-wt-server -b feat/<change>-server feat/<change>
     git worktree add ../fanxiaoshuo-wt-web    -b feat/<change>-web    feat/<change>
     git worktree add ../fanxiaoshuo-wt-agents -b feat/<change>-agents feat/<change>
     ```
   - 每个 Agent 只修改其归属目录与对应测试；发现契约缺口时先反馈修改 `packages/shared`，禁止私自绕过类型约束。
4. **阶段 4 · 独立验收与归档**
   - 合并至 Change 分支后，由独立 Reviewer Agent 执行 `/openspec-verify-change`，核验 `typecheck`、`test`、接口联调与全部 spec 场景。
   - 验收通过后执行 `/openspec-archive-change` 同步主规格并合并 `main`，清理 worktree。

---

## 三、开发期红线与工程规范

- **Clean-Room 原则**：所有源码、UI 样式、提示词与文案必须原创，严禁拷贝外部竞品压缩代码或静态素材。
- **Windows 优先兼容**：所有 npm/pnpm 脚本使用跨平台写法，避免依赖 POSIX 独占命令（如 `rm -rf` 改用 Node 脚本或兼容工具），路径使用英文 ASCII 命名。
- **严禁硬编码密钥**：Provider API Key 仅存数据库加密字段或 `.env`（`.env` 永不入库），日志与错误响应中必须脱敏。
- **统一 AI 调用入口**：禁止在路由或前端直接 `fetch` 上游模型接口；所有模型调用必须经 `packages/agents` 统一网关以落盘 Token 消耗、成本估算与错误追踪。
- **类型安全**：禁止随意使用 `any` 或关闭 strict 编译检查；外部输入（HTTP body/query、LLM 结构化输出、环境变量）必须经 Zod 校验。
