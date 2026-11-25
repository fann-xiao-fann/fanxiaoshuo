# Tasks: toolbox-and-polish

> 执行依赖与并行说明：
> - **Wave 1**（任务组 1，`[shared]`）先行冻结创作工具盒常量、Schema、输入校验函数、错误码与全场景用量标签并合入 `main`。
> - **Wave 2**（任务组 2 `[agents]` 与任务组 3 `[web]`）在 Wave 1 合入后通过两个独立 `git worktree` **并行开发**。
> - **Wave 3**（任务组 4 `[server]`）在 Wave 2 的 `[agents]` 合入后开发迁移、仓储与 7 个创作工具盒 REST 接口。
> - **Wave 4**（任务组 5，集成验证）合流全仓验证、真实 Docker PostgreSQL 幂等迁移（14 张表）、真实 Server + Mock OpenAI + Vite 端到端冒烟验证与文档更新。

## 1. 共享契约锁定（Wave 1 · 串行先行）

- [x] 1.1 `[shared]` 扩展 `packages/shared/src/constants/runtime.ts`（新增 `USAGE_SCENES.toolboxRun` 与全量 `USAGE_SCENE_LABELS` 映射）与 `packages/shared/src/errors.ts`（新增 `TOOLBOX_TOOL_NOT_FOUND`、`TOOLBOX_RUN_NOT_FOUND`、`TOOLBOX_ITEM_OUT_OF_RANGE` 及 HTTP 状态码映射），新增 `packages/shared/src/constants/toolbox.ts` 定义 6 个内置工具分类、ID、字段类型、回写目标与完整声明式目录 `TOOLBOX_TOOL_DEFINITIONS`。
- [x] 1.2 `[shared]` 新增 `packages/shared/src/schemas/toolbox.ts` 并从 `packages/shared/src/index.ts` 导出：定义工具目录 Schema、统一结构化输出 `toolboxOutputSchema`、运行请求/摘要/详情/分页查询/响应 Schema、回写设定卡与回写大纲 Schema，以及动态输入校验函数 `validateToolboxInputs`，编写完整单元测试覆盖 6 个工具的合法输入、默认值补全与非法边界拒绝。

## 2. 创作工具盒 Prompt 与执行引擎（Wave 2 · 可与任务组 3 并行）

- [x] 2.1 `[agents]` 新增 `packages/agents/src/prompts/toolbox.ts`：为 6 个内置工具实现原创中文 `buildToolboxPrompts`（支持可选书籍大纲与核心设定卡上下文注入）与 `parseToolboxOutput`（支持 Markdown 代码块 / JSON 对象抽取、分类归一化与纯文本安全兜底），补齐单元测试。
- [x] 2.2 `[agents]` 新增 `packages/agents/src/toolbox/run-toolbox-tool.ts` 并从 `packages/agents/src/index.ts` 导出：经 `ModelGateway.generateText` 以 `USAGE_SCENES.toolboxRun` 场景执行工具并返回结构化产出与用量统计（含错误透传与脱敏），补齐单元测试覆盖上下文注入、解析兜底与异常传播。

## 3. 前端创作工具盒工作台与全站打磨（Wave 2 · 可与任务组 2 并行）

- [x] 3.1 `[web]` 新增 `apps/web/src/api/toolbox.ts`（并从 `api/index.ts` 导出）与 Pinia Store `apps/web/src/stores/toolbox.ts`：实现工具目录加载、工具执行、历史记录分页筛选/详情回看/删除、一键回写设定卡与大纲，编写 Store 单元测试。
- [x] 3.2 `[web]` 将 `apps/web/src/views/ToolboxView.vue` 从占位视图升级为完整的「创作工具盒」工作台（配套 `apps/web/src/components/toolbox/` 子组件，如 `ToolboxForm.vue`、`ToolboxResultList.vue`、`ToolboxApplyModal.vue`、`ToolboxHistoryDrawer.vue`），支持分类切换、关联作品预选（`/toolbox?bookId=...`）、动态表单、`Ctrl/Cmd+Enter` 执行、一键复制与回写 Book Bible 设定卡/总大纲。
- [x] 3.3 `[web]` 全站收官打磨：更新 `apps/web/src/router/routes.ts` 与 `routes.test.ts`（清除所有 Change 5 占位描述，确认五大导航模块全部正式上线）；在 `apps/web/src/components/workspace/BookBiblePanel.vue` 增加直达 `/toolbox?bookId=...` 快捷入口；在 `apps/web/src/components/runtime/UsageLogsPanel.vue` 改用共享 `USAGE_SCENE_LABELS` 覆盖全量 7 个场景并在 `RuntimeView.vue` 同步展示 `novel-workflows` 队列信息，确保 `typecheck` / `test` / `build` 全绿。

## 4. 服务端迁移、仓储与创作工具盒接口（Wave 3 · 依赖 Wave 2 `[agents]`）

- [x] 4.1 `[server]` 在 `apps/server/src/db/schema.ts` 新增 `toolbox_runs` 表定义及索引，执行 `drizzle-kit generate` 生成 `0004_*.sql` 迁移（更新 `migration.test.ts`），并在 `apps/server/src/repositories/` 新增 `ToolboxRunRepository` 接口、Drizzle 实现与内存测试仓储，接入 `ServerDependencies` 与 `src/index.ts`。
- [x] 4.2 `[server]` 新增 `apps/server/src/routes/toolbox.ts` 并挂载至 `buildServer`：实现全部 7 个 `/api/v1/toolbox/*` REST 接口（目录、历史列表、同步执行含 Book Bible 注入与失败脱敏留痕、详情、删除、一键存为设定卡、一键写入全书总大纲），编写 `app.inject()` 集成测试覆盖全路径、未绑定角色 409、越界 400、上游失败落库脱敏与回写联动。

## 5. 全仓集成验收与文档更新（Wave 4 · 集成检查）

- [x] 5.1 `[shared][agents][server][web]` 合流所有分支并清理 Worktree，执行跨包缝隙审计（校验共享契约、Agents 引擎、Server Drizzle SQL 与前端 API 100% 一致），运行 `pnpm typecheck`、`pnpm test`、`pnpm build` 与真实 Docker PostgreSQL 幂等迁移 `pnpm db:migrate` x2（验证全部 14 张核心表就绪）。
- [x] 5.2 `[server][web]` 启动本地 Mock OpenAI 兼容服务器 + 真实 Fastify Server + 真实 Docker PostgreSQL + Vite 前端，执行端到端冒烟验证（获取 6 工具目录 → 校验未绑定角色 409 与非法输入 400 → 建书建大纲与设定卡 → 关联书籍执行 `character-designer` 校验 Prompt 注入与 `toolbox-run` 用量落盘 → 一键保存为设定卡并在 Book Bible 验证可见 → 执行 `book-pitch` 并一键 `append` 写入全书总大纲验证不覆盖其余字段 → 校验历史列表筛选与删除不影响已保存卡片 → 校验 Vite `/toolbox` 与 `/toolbox?bookId=...` 路由及代理 → 清理全部测试数据零污染），更新 `README.md`。

## Workflow follow-up

- Run `/openspec-verify-change` to verify implementation against all Change 5 specs and design requirements.
- Archive the change after user review and approval.
