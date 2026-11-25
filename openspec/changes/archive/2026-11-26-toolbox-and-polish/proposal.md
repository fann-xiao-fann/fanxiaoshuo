# Proposal: toolbox-and-polish

## Why

完成 Change 1–4 后，「梵小说」已经打通了模型注册表、书库与 TipTap 长文编辑器、Book Bible 设定记忆层、章内流式 AI 写作以及多 Agent 批量写书流水线，全站 5 个核心导航入口中仅剩 **创作工具盒（`/toolbox`）** 仍处于占位页状态。

实际网文立项与日常日更过程中，作者除了写正文和跑批量流水线，还高频需要「单点结构化提效工具」——例如起书名与爆款简介、批量孵化立体人物卡、补全势力/功法/法宝设定、设计带限制防崩战力的金手指、卡文时脑暴冲突与章尾钩子、对既有片段做节奏/水文诊断与润色——并希望这些产出能够结合已有作品的 Book Bible 上下文，一键沉淀为设定卡或写入全书总大纲，同时所有模型调用继续统一经过 `ModelGateway` 审计计费。

此外，作为全站五大模块收官的最后一次迭代，也需要对跨模块体验细节做一轮集中打磨：彻底清除最后一个占位页，补齐用量日志对全部 7 个业务场景的中文标签映射，建立写作工作区 ↔ 创作工具盒 ↔ 模型配置中心的快捷跳转闭环。

## What Changes

1. **共享契约扩展（`packages/shared`）**：
   - 新增 `USAGE_SCENES.toolboxRun`（`toolbox-run`）与全量 `USAGE_SCENE_LABELS` 中文标签映射，供观测台和工具盒统一复用。
   - 新增 `packages/shared/src/constants/toolbox.ts` 与 `packages/shared/src/schemas/toolbox.ts`：定义 6 个内置 Schema 驱动工具的声明式目录元数据（分类、默认写书角色、动态表单字段定义、支持回写目标）、统一结构化产出契约（`overview` + `items[]`）、执行/查询/回写请求与响应 DTO，以及动态字段校验函数 `validateToolboxInputs`。
   - 新增错误码 `TOOLBOX_TOOL_NOT_FOUND`（404）、`TOOLBOX_RUN_NOT_FOUND`（404）、`TOOLBOX_ITEM_OUT_OF_RANGE`（400）。
2. **创作工具盒 Prompt 与结构化解析引擎（`packages/agents`）**：
   - 新增 `packages/agents/src/prompts/toolbox.ts` 与 `packages/agents/src/toolbox/run-toolbox-tool.ts`：为全部 6 个内置工具编写原创中文 Prompt 构造器（可选注入目标书籍的总大纲与置顶/核心设定卡上下文），经 `ModelGateway.generateText` 统一调用并落盘 `llm_usage_logs`，实现 JSON 抽取 + 纯文本安全兜底解析（绝不因模型输出非标准 Markdown/JSON 崩溃）。
3. **服务端持久化与创作工具盒 API（`apps/server`）**：
   - 新增 PostgreSQL 表 `toolbox_runs`（第 14 张核心表，生成 `0004_*.sql` 迁移），提供 `ToolboxRunRepository`（Drizzle 实现 + 内存测试实现）。
   - 新增 7 个 REST 接口（前缀 `/api/v1/toolbox`）：工具目录查询、历史记录分页筛选、执行工具（含角色绑定前置校验与失败脱敏留痕）、运行详情、删除历史，以及一键回写到设定卡（`POST /runs/:runId/apply-card`）与一键写入全书大纲（`POST /runs/:runId/apply-outline`）。
4. **创作工具盒控制台与全站收官打磨（`apps/web`）**：
   - 将 `/toolbox` 从占位页升级为完整的「创作工具盒」工作台：左侧工具分类目录、中间 Schema 驱动动态表单（支持关联作品注入 Book Bible 上下文、可选覆盖执行角色、`Ctrl/Cmd+Enter` 快捷触发）、右侧结构化结果卡片（一键复制、一键保存为设定卡、一键追加/替换到全书总大纲）以及持久化历史记录回溯与清理。
   - 全站收官打磨：移除导航栏与路由元信息中的 Change 5 占位描述；在写作工作区设定集面板增加直达 `/toolbox?bookId=...` 快捷入口；在 `/runtime` 用量账本补齐全部 7 个场景的中文标签与筛选选项并完善运行期指标展示。

## Capabilities

### New Capabilities
- `creation-toolbox`: Schema 驱动的网文创作辅助工具引擎（6 个内置工具目录、可选作品上下文注入、统一网关执行与结构化解析、持久化历史记录、一键回写 Book Bible 设定卡与全书总大纲）。

### Modified Capabilities
- `workbench-shell`: 全部 5 个主导航模块均已上线正式功能视图（`/toolbox` 正式交付，清除全站最后占位页），补充跨模块快捷跳转与全场景用量标签统一。

## Impact

- **受影响包**：`packages/shared`、`packages/agents`、`apps/server`、`apps/web`（无需改动 `apps/worker` 与 `infra/`）。
- **数据库变更**：新增 `toolbox_runs` 表（外键 `book_id → books.id ON DELETE SET NULL`），追加幂等迁移 `0004_*.sql`，全库共 14 张核心表。
- **安全性与成本红线**：所有工具执行必须经 `ModelGateway` 走已绑定的写书角色模型，写入 `llm_usage_logs`（`scene = 'toolbox-run'`），错误信息严格脱敏，前端零直连上游。
