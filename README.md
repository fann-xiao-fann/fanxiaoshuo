# 梵小说（FanXiaoshuo）

面向内部批量网文创作的 **AI 工作台**：用一组分工明确的写书 Agent 串起「立项起盘 → 设定集维护 → 拆细纲 → 逐章成文 → 审稿返工 → 校审导出」流水线，并提供模型配置、Token/费用计量与基础设施健康诊断。

> 本仓库为 **pnpm + TypeScript（strict）Monorepo**。当前已完成 **Change 1**（工作区骨架 / 契约 / 模型配置中心 / 运行期底座 / 工作台外壳）、**Change 2**（书架书库、卷章目录树、TipTap 长文编辑器、历史快照与安全回滚、整本导出 TXT/MD）、**Change 3**（Book Bible 设定记忆层、预算感知上下文组装、编辑器内流式 AI 写作与原子 AI 快照留底应用）与 **Change 4**（多 Agent 批量写书流水线引擎：`showrunner` 拆细纲 → `writer` 逐章成文 → `critic` 审稿返工闭环 → `lorekeeper` 摘要提炼、预算熔断、暂停/断点续跑/取消/单步重试与 `/workflows` 实时控制台）。

---

## 一、固定技术栈

| 层 | 技术选型 |
|---|---|
| Monorepo | pnpm workspaces + TypeScript strict（Node.js >= 22，Windows 优先兼容） |
| 共享契约 | `packages/shared`：Zod Schema / DTO / SSE 事件 / 领域枚举 / 统一错误码（唯一真相来源） |
| 前端 | Vue 3 + Vite + Pinia + Vue Router + Naive UI（明暗双主题 + TipTap 长文编辑器） |
| 后端 API | Fastify + Drizzle ORM + PostgreSQL（`pgvector` 镜像） |
| 队列与实时总线 | Redis + BullMQ（并发控制 / 指数退避重试）+ Redis Pub/Sub → SSE |
| AI 编排 | Vercel AI SDK（`ai`、`@ai-sdk/openai-compatible` 及主流 Provider 适配）+ Mastra（Multi-Agent + Durable Workflows） |
| 基础设施 | Docker Compose：`pgvector/pgvector:pg17` + `redis:7-alpine`（健康检查 + 命名卷持久化） |

### 目录结构

```
fanxiaoshuo/
├─ packages/shared/   # 契约包：Zod Schema、DTO、事件与错误码（先行冻结）
├─ packages/agents/   # 统一 LLM 网关（计量/费用/脱敏）+ Mastra 运行时与角色定义
├─ apps/server/       # Fastify REST/SSE API、Drizzle Schema 与迁移
├─ apps/worker/       # BullMQ Worker（冒烟任务 + novel-workflows 批量流水线）、心跳上报与事件广播
├─ apps/web/          # Vue 3 工作台 UI（书架 / 卷章树 / TipTap 编辑器 / 批量流水线 / 模型配置 / 用量与状态）
├─ infra/             # docker-compose.yml、init-db.sql
└─ openspec/          # 规格（specs）与进行中变更（changes）
```

---

## 二、双层多 AI Agent 架构

### 1）运行期：4 个专业写书角色

| 角色 | 标识 | 职责 |
|---|---|---|
| 总编策划 | `showrunner` | 选题定位、主线与卷章结构、节奏与冲突编排 |
| 设定档案员 | `lorekeeper` | 人物卡 / 世界观 / 章节摘要归一化，防止设定漂移 |
| 执笔写手 | `writer` | 按细纲逐章成文，保持人物口吻与伏笔一致 |
| 审稿质检 | `critic` | 一致性、节奏、水文检测与返工裁决 |

所有模型调用 **必须经 `packages/agents` 的统一 `ModelGateway`**，自动完成 Provider 适配、超时取消、Token 计量、费用估算与用量日志落盘（成功与失败都记录，错误信息脱敏）。前端禁止直接 `fetch` 上游模型接口。

### 2）开发期：多 Coding Agent 协作（`AGENTS.md`）

- **目录所有权**：`openspec/`（Architect）、`packages/shared/`（Contract Owner，跨包改动先行冻结）、`infra/`（Infra）、`apps/server/`（Backend）、`packages/agents/`（AI Pipeline）、`apps/worker/`（Worker）、`apps/web/`（Frontend）。
- **OpenSpec `expanded` 工作流**：`proposal.md` → `specs/` → `design.md` → `tasks.md`，规格审核通过前不写业务代码；验收走 `verify` → `archive`。
- **Git Worktree 并行**：每个 Agent 在独立 worktree 领取互不重叠的任务组：

```bash
# 阶段 1–2 在 feat/<change> 上完成契约与 infra
git worktree add ../fanxiaoshuo-wt-server -b feat/<change>-server feat/<change>
git worktree add ../fanxiaoshuo-wt-web    -b feat/<change>-web    feat/<change>
git worktree add ../fanxiaoshuo-wt-agents -b feat/<change>-agents feat/<change>
git worktree add ../fanxiaoshuo-wt-worker -b feat/<change>-worker feat/<change>

# 合流后清理
git worktree remove ../fanxiaoshuo-wt-server
```

---

## 三、环境要求

- **Node.js >= 22**（`node -v` 校验）
- **pnpm 12.x**（根 `package.json` 声明 `packageManager: pnpm@12.23.0`；建议 `corepack enable`）
- **Docker Desktop**（提供 PostgreSQL + pgvector 与 Redis）
- 首次使用：`pnpm install`

---

## 四、快速启动（照抄即可）

```bash
# 0）安装依赖（仓库根目录执行）
pnpm install

# 1）生成根目录 .env（从 .env.example 复制，并自动生成 APP_ENCRYPTION_KEY）
pnpm env:init

# 2）启动 PostgreSQL(pgvector) + Redis 容器
pnpm docker:up

# 3）执行数据库迁移（创建全部 13 张核心表，含 pgvector 向量列与批量流水线表；可重复执行，幂等）
pnpm db:migrate

# 4）同时启动 server + worker + web 开发进程
pnpm dev
```

启动后可访问：

| 服务 | 地址 |
|---|---|
| 工作台前端 | http://127.0.0.1:5173 （书架：`/books`；写作工作区：`/books/:bookId/:chapterId?`；批量流水线：`/workflows`；模型配置：`/models`；用量与状态：`/runtime`） |
| Fastify API | http://127.0.0.1:3001 |
| 健康检查 | http://127.0.0.1:3001/api/v1/health |
| 用量日志 | http://127.0.0.1:3001/api/v1/usage-logs |
| 运行期 SSE | http://127.0.0.1:3001/api/v1/runtime/events |
| 流水线 SSE | http://127.0.0.1:3001/api/v1/workflows/events |

端口与连接串均可在根目录 `.env` 调整（`API_PORT`、`WEB_PORT`、`DATABASE_URL`、`REDIS_URL`、`WORKER_CONCURRENCY`）。**`.env` 永不入库**；`APP_ENCRYPTION_KEY` 用于 AES-256-GCM 加密 Provider API Key，缺失时服务启动即 fail-fast，更换会导致历史密钥无法解密。

### 首次使用建议流程

1. 打开 `/models`，新增 Provider（上游中转站或官方 API）并填写 API Key（前端仅展示脱敏值）。
2. 在 Provider 下新增模型并配置输入/输出单价。
3. 为 4 个写书角色绑定默认模型，点击「一键测通」验证连通性（会真实调用并落盘用量日志）。
4. 打开 `/runtime` 确认 PG / Redis / Worker 诊断卡片全部绿色，触发一次冒烟任务观察 SSE 状态流转。
5. 打开 `/books` 新建作品 → 进入 `/books/:bookId` 建卷建章 → 在右侧「设定集」维护全书总大纲与 6 类设定卡、在「本章记忆」编写细纲或调用 `lorekeeper` 一键提炼摘要 → 在「AI 写作」预览 Token 预算并发起续写/扩写/改写/润色流式生成，确认后自动留底 `ai` 快照写回正文 → 随时在历史版本一键回滚或「导出」整本 TXT / Markdown。
6. 打开 `/workflows` 点击「新建批量批次」→ 选择目标作品与章节（或按卷自动建章）、运行模式（`outline_only` / `write_chapters` / `full_pipeline`）、审稿与最大返工轮次、摘要提取与 `maxCostUsd` 费用熔断上限 → 实时观察逐章阶段流转、审稿得分与费用表盘；支持随时暂停、上调预算断点续跑、取消、单步重试，并一键跳回对应章节编辑器审阅。

---

## 五、Windows 注意事项

1. **PowerShell 执行策略拦截 `pnpm.ps1`**（报 `禁止运行脚本` / `UnauthorizedAccess`）时，任选其一：
   - 改用 `pnpm.cmd` 调用脚本：
     ```powershell
     pnpm.cmd env:init
     pnpm.cmd docker:up
     pnpm.cmd db:migrate
     pnpm.cmd dev
     ```
   - 或改用 **Git Bash** 执行 `pnpm <script>`；
   - 或以管理员身份执行一次性放行：`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`。
2. **Docker Hub 拉取镜像很慢 / 超时**：先在 Docker Desktop → Settings → Docker Engine 配置镜像加速器（`registry-mirrors`）或设置 HTTP/HTTPS 代理，`Apply & Restart` 后重跑：
   ```bash
   pnpm docker:up
   ```
   若容器已部分创建，可先 `pnpm docker:down` 再启动。**首次启动会自动执行 `infra/init-db.sql` 启用 `vector` 扩展。**
3. 脚本均为跨平台 Node 实现（`scripts/*.mjs`），不依赖 `rm -rf` 等 POSIX 独占命令；终端建议使用 UTF-8 编码避免中文乱码。

---

## 六、常用命令

### 开发与验证

| 命令 | 说明 |
|---|---|
| `pnpm build` | 递归构建全部工作区（`shared`、`agents`、`server`、`worker`、`web`） |
| `pnpm typecheck` | 递归 TypeScript 类型检查（`web` 使用 `vue-tsc`） |
| `pnpm test` | 递归运行 Vitest 单元/集成测试 |
| `pnpm test:watch` | 监听模式运行测试 |
| `pnpm dev` | 并行启动各包开发进程（server / worker / web） |
| `pnpm clean` | 跨平台清理各包 `dist` 等构建产物 |

### Docker 与数据库

| 命令 | 说明 |
|---|---|
| `pnpm docker:up` | 启动 PostgreSQL(pgvector) 与 Redis |
| `pnpm docker:down` | 停止容器（保留数据卷） |
| `pnpm docker:reset` | **停止并删除数据卷**（清空数据库，慎用） |
| `pnpm docker:logs` | 跟踪容器日志 |
| `pnpm db:generate` | 依据 Drizzle Schema 生成迁移 SQL |
| `pnpm db:migrate` | 应用迁移到数据库（幂等） |

### 单包调试（示例）

```bash
pnpm --filter @fanxiaoshuo/server run dev
pnpm --filter @fanxiaoshuo/server run test
pnpm --filter @fanxiaoshuo/web run typecheck
```

---

## 七、主要 API（前缀 `/api/v1`）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 主动探测 PostgreSQL / Redis / Worker 心跳 |
| GET/POST/PATCH/DELETE | `/providers` | Provider 增删改查（Key 加密存储、响应脱敏） |
| GET/POST/PATCH/DELETE | `/models` | 模型目录与单价管理 |
| POST | `/models/:id/test` | 一键测通（经统一网关真实调用并落盘用量日志） |
| GET/PUT | `/agent-roles` | 4 个写书角色与默认模型绑定（PUT 批量更新绑定） |
| GET | `/usage-logs` | 用量日志分页筛选与汇总统计 |
| POST | `/runtime/smoke-jobs` | 入队 Mastra + BullMQ 冒烟任务 |
| GET | `/runtime/smoke-jobs/:jobId` | 查询冒烟任务状态 |
| GET | `/runtime/events` | SSE 实时事件流（Redis Pub/Sub 转发） |

### 书库 / 卷章 / 正文 / 快照 / 导出（Change 2）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/POST | `/books` | 书架列表（`status` / `q` / `includeDeleted` 筛选）与新建作品 |
| GET/PATCH/DELETE | `/books/:bookId` | 作品详情、元信息更新、软删入回收站（`?permanent=true` 仅对回收站内作品生效） |
| POST | `/books/:bookId/restore` | 从回收站恢复作品 |
| GET | `/books/:bookId/tree` | 卷章目录树（分卷 + 章节顺序，驱动左侧大纲） |
| GET | `/books/:bookId/trash` | 作品回收站内的分卷 / 章节清单 |
| GET | `/books/:bookId/export` | 整本导出（`format=txt\|md`，返回文件流 + `Content-Disposition`） |
| POST | `/books/:bookId/volumes` | 新建分卷 |
| PUT | `/books/:bookId/volumes/reorder` | 分卷排序 |
| PUT | `/books/:bookId/chapters/reorder` | 章节同卷排序与跨卷移动（单事务） |
| POST | `/books/:bookId/chapters` | 新建章节 |
| PATCH/DELETE | `/volumes/:volumeId` | 分卷重命名 / 软删 |
| POST | `/volumes/:volumeId/restore` | 恢复分卷 |
| GET/PATCH/DELETE | `/chapters/:chapterId` | 章节详情（含正文与 `version`）、元信息更新、软删 |
| POST | `/chapters/:chapterId/restore` | 恢复章节 |
| GET/PUT | `/chapters/:chapterId/content` | 读取 / 保存正文（携带 `expectedVersion` 做乐观并发校验，冲突返回 `409 CHAPTER_VERSION_CONFLICT`） |
| GET/POST | `/chapters/:chapterId/revisions` | 历史快照列表（倒序）与手动留底（返回快照详情，含正文） |
| GET | `/chapters/:chapterId/revisions/:revisionId` | 快照详情（回滚前预览） |
| POST | `/chapters/:chapterId/revisions/:revisionId/restore` | 安全回滚：先把当前正文自动留底为 `restore` 快照，再写入历史正文 |

### 设定记忆层（Book Bible）与章内流式 AI 写作（Change 3）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/PUT | `/books/:bookId/outline` | 读取 / 保存全书总大纲（主线、世界观概览、文风与禁忌、结局规划；新书默认返回空结构） |
| GET/POST | `/books/:bookId/cards` | 6 类设定卡列表（支持 `category` / `q` / `pinned` 筛选）与新建（含 pgvector 向量列预留） |
| GET/PATCH/DELETE | `/books/:bookId/cards/:cardId` | 单张设定卡详情、编辑 / 置顶切换、删除 |
| GET/PUT | `/chapters/:chapterId/summary` | 读取 / 手工保存本章细纲、剧情摘要、关键事件与出场人物 |
| POST | `/chapters/:chapterId/summary/extract` | 调用 `lorekeeper` 角色从正文提炼结构化摘要并落盘 `llm_usage_logs`（保留原有细纲） |
| POST | `/chapters/:chapterId/ai/context-preview` | 预览上下文组装结果（设定卡召回来源、前情摘要、Token 预算与裁剪状态、Prompt 预览） |
| POST | `/chapters/:chapterId/ai/stream` | 章内流式 AI 写作（`continue` / `expand` / `rewrite` / `polish`，POST+SSE 推送 `start`/`delta`/`done`/`error`，支持中止与用量审计） |
| POST | `/chapters/:chapterId/ai/apply` | 原子应用 AI 正文（单事务校验 `expectedVersion` → 先留底 `source: 'ai'` 不可变快照 → 更新正文与版本 +1） |

### 多 Agent 批量流水线（Change 4）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/workflows/runs` | 分页筛选批量流水线列表（支持 `bookId` / `status` / `mode` / `page` / `pageSize`） |
| POST | `/workflows/runs` | 创建批量流水线并入队（前置校验所需角色绑定；支持 `chapterIds` 或 `autoCreateChapters` 互斥建章） |
| GET | `/workflows/runs/:runId` | 查询批次详情（含配置快照、累计 Token/费用、逐章有序步骤、审稿得分/问题清单与留底快照 ID） |
| POST | `/workflows/runs/:runId/pause` | 请求暂停（`queued` 立即转 `paused`；`running` 置位暂停标记在安全断点收敛为 `USER_PAUSED`） |
| POST | `/workflows/runs/:runId/resume` | 断点续跑（支持可选上调 `maxCostUsd`；预算耗尽未上调返回 `402 BUDGET_EXCEEDED`；跳过已完成章节重新入队） |
| POST | `/workflows/runs/:runId/cancel` | 取消批次（立即或安全断点收敛为 `cancelled`，未执行步骤置 `skipped`，保留已完成章节） |
| POST | `/workflows/runs/:runId/steps/:stepId/retry` | 重试单个失败/跳过步骤并重新入队继续执行后续章节 |
| DELETE | `/workflows/runs/:runId` | 删除终态批次记录（`queued` / `running` / `paused` 活跃态拦截返回 `409 WORKFLOW_RUN_ACTIVE`，不删除已生成章节） |
| GET | `/workflows/events` | 批量流水线 SSE 实时事件流（支持 `?runId=` 过滤，推送 `ready` / `workflow-event` / `ping`） |

---

## 八、协作与红线

- **契约先行**：跨包数据结构先在 `packages/shared` 定义 Zod Schema，禁止用 `any` 或绕过类型约束。
- **密钥安全**：API Key 仅存数据库加密字段，日志与错误响应必须脱敏；严禁硬编码密钥。
- **统一入口**：所有 LLM 调用必须经 `packages/agents` 的 `ModelGateway`，保证计量、成本估算与错误追踪可审计。
- **Clean-Room**：代码、UI 样式、Prompt 与文案全部原创。
- 详细协作规范见 [`AGENTS.md`](./AGENTS.md)，进行中变更见 [`openspec/changes/`](./openspec/changes)。
