# Proposal

## Why

Change 1 已完成「梵小说」的基础设施、模型配置与运行期底座，但当前工作台的「书架」仍为占位页，尚无承载长篇网文作品的数据容器与写作编辑器。Change 2 落地书库、卷章树、TipTap 正文编辑器、版本快照与整本导出能力，既让作者能立即开始顺滑写书，也为 Change 3（设定记忆层与 AI 续写）和 Change 4（批量多 Agent 成文）提供带乐观并发保护与快照留底的稳定内容底座。

## What Changes

### 范围内（In Scope）
- **共享契约扩展（`packages/shared`）**：新增书库、卷、章、重排、快照回滚与导出相关的 Zod Schema、DTO、领域错误码（`BOOK_NOT_FOUND`、`VOLUME_NOT_FOUND`、`CHAPTER_NOT_FOUND`、`CHAPTER_VERSION_CONFLICT`、`REVISION_NOT_FOUND`），以及前后端共用的网文字数统计纯函数 `countNovelWords`。
- **数据库与后端 API（`apps/server`）**：通过 Drizzle 新增 4 张表（`books`、`volumes`、`chapters`、`chapter_revisions`）与幂等 SQL 迁移；提供书架 CRUD + 回收站软删/恢复/彻底删除、卷章树查询与拖拽/同级/跨卷重排、章节内容保存（带乐观并发 `version` 校验）、手动/自动快照创建与回滚、以及整本导出为 `.txt` / `.md` 的后端接口。
- **前端书架与 TipTap 章节编辑器（`apps/web`）**：
  - 将 `/books` 占位页替换为完整的「书架管理」页面（新建/编辑/筛选/字数进度/回收站/整本导出）。
  - 新增写作工作区路由 `/books/:bookId/:chapterId?`：左侧可折叠卷章树（新建卷/章、重命名、软删、排序与跨卷移动、每章与全书字数统计），中间接入 **TipTap** 长文编辑器（防抖自动保存、乐观冲突提示、沉浸专注模式、快捷键 `Ctrl/Cmd+S`、离开未保存保护），右侧抽屉提供历史版本快照列表、差异/正文预览与一键回滚。
  - 更新工作台外壳默认主视图与占位范围：`/books` 成为已开放模块（剩余未开放占位模块为批量流水线与创作工具盒）。

### 明确不做（Out of Scope）
- 不在本变更中实现书设定集（人物卡/世界观/伏笔/章节摘要）与 `pgvector` 检索（归属 Change 3）。
- 不在本变更中在编辑器内调用 LLM 续写、扩写或润色（归属 Change 3）。
- 不在本变更中实现批量成文 Workflows 与 Worker 消费逻辑（归属 Change 4）；不修改 `packages/agents` 与 `apps/worker`。
- 不实现多人实时协同编辑（CRDT/WebSocket）或复杂富文本排版（图片/表格/公式）；编辑器专注网文长文本写作性能与清晰段落结构。

## Capabilities

### New Capabilities
- `book-library`: 提供书籍管理、卷与章节层级树、排序与跨卷调整、软删除回收站、字数统计聚合与整本 TXT/Markdown 导出能力。
- `chapter-editor`: 提供面向万字长文章节的正文编辑、防抖自动保存、乐观并发冲突防护、历史快照保存与一键回滚，以及沉浸专注写作体验。

### Modified Capabilities
- `workbench-shell`: `/books` 由占位页升级为正式书架模块，并新增 `/books/:bookId/:chapterId?` 书籍写作工作区路由，更新未开放占位模块列表。

## Impact

- **对开发期多 Coding Agent 协作的影响**：继续遵循「`packages/shared` 契约先行 → `apps/server` 与 `apps/web` 双 Worktree 并行开发 → 合流与 `/openspec-verify-change` 验收」流程；因不涉及 `packages/agents` 与 `apps/worker`，变更面清晰可控、并行无冲突。
- **对运行期多 Agent 架构的影响**：在表结构层提前为 Change 3/4 预留关键字段——`books.target_chapter_words`（写手目标字数）、`volumes.summary`（卷纲）、`chapters.status`（`outline`/`draft`/`reviewing`/`final`）、`chapters.content_text`（纯文本直喂上下文）、`chapters.version`（防后台 Worker 与人工编辑互相覆盖）以及 `chapter_revisions.source`（含 `'ai'`，支持 AI 写稿前自动留底回滚）。
- **新增依赖**：前端引入 `@tiptap/vue-3`、`@tiptap/starter-kit`、`@tiptap/extension-placeholder`（仅限 `apps/web`）；后端沿用现有 Fastify + Drizzle + PostgreSQL，无新增基础设施容器。
