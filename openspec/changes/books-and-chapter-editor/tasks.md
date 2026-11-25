# Tasks

> 并行协作提示：**第 1 组（`[shared]` 共享契约）**完成并合流后，**第 2 组（`[server]`）**与**第 3 组（`[web]`）**可按 `AGENTS.md` 规范通过独立 `git worktree` 并行实施（两者目录完全隔离、共享 `@fanxiaoshuo/shared` 契约），合流后执行第 4 组全仓集成与真实容器 E2E 验收。

## 1. 共享领域契约与字数统计工具（串行前置，锁死契约）

- [x] 1.1 `[shared]` 扩展 `packages/shared` 领域枚举与错误码（`BOOK_STATUSES`、`CHAPTER_STATUSES`、`REVISION_SOURCES`、`EXPORT_FORMATS`，新增 `BOOK_NOT_FOUND`、`VOLUME_NOT_FOUND`、`CHAPTER_NOT_FOUND`、`CHAPTER_VERSION_CONFLICT`、`REVISION_NOT_FOUND` 及其 HTTP 状态映射），并实现前后端共用纯函数 `countNovelWords(text)` 及覆盖中英混排、标点、全角空白、换行的单元测试，确认 `pnpm --filter @fanxiaoshuo/shared test` 通过
- [x] 1.2 `[shared]` 新增书库、卷、章、重排、正文保存（含 `expectedVersion` / `forceOverwrite`）、历史快照、回收站与导出查询的完整 Zod Schema 与 DTO 类型导出，补齐正常与非法边界单元测试并验证 `pnpm --filter @fanxiaoshuo/shared build && typecheck && test` 全部通过

## 2. Fastify 后端 API 与 Drizzle 书库/版本快照持久化（第 1 组完成后可并行）

- [x] 2.1 `[server]` 在 `apps/server/src/db/schema.ts` 新增 `books`、`volumes`、`chapters`、`chapter_revisions` 4 张表与索引（含 `volumes`/`chapters` 软删除、`chapters.version` 乐观锁、`chapter_revisions` 不可变快照与级联/SET NULL 约束），通过 `pnpm db:generate` 生成 `0001_*.sql` 迁移并验证 `migration.test.ts` 与类型检查通过
- [x] 2.2 `[server]` 实现 `books` 仓储（Drizzle + 测试内存实现）及 `/api/v1/books` CRUD、状态/关键字筛选、字数/卷章数聚合、软删除回收站（`DELETE`、`POST /restore`、`DELETE ?permanent=true` 防误删校验）与 `GET /api/v1/books/:bookId/export?format=txt|md`（UTF-8 下载头、按 `sortOrder` 排除已删节点），补齐 `fastify.inject()` 集成测试并验证通过
- [x] 2.3 `[server]` 实现 `volumes` 与 `chapters` 元信息仓储及路由：`/api/v1/books/:bookId/tree`（不含正文的大目录树轻量接口）、`/api/v1/books/:bookId/trash`、卷/章 CRUD 与软删恢复、`PUT /api/v1/books/:bookId/volumes/reorder` 与 `PUT /api/v1/books/:bookId/chapters/reorder`（单事务同卷排序与跨卷移动 + 跨书越界防呆），补齐集成测试并验证通过
- [x] 2.4 `[server]` 实现章节正文与快照仓储及路由：`GET /api/v1/chapters/:chapterId`、`PUT /api/v1/chapters/:chapterId/content`（服务端重算 `wordCount`、乐观并发 `version` 校验、`409 CHAPTER_VERSION_CONFLICT` 携带 `currentVersion`、5 分钟节流自动生成 `auto` 快照）、`GET/POST /api/v1/chapters/:chapterId/revisions`、`GET /revisions/:revisionId` 及 `POST /revisions/:revisionId/restore`（事务先写 `restore` 备份再回滚），补齐集成测试并验证 `pnpm --filter @fanxiaoshuo/server build && typecheck && test` 全部通过

## 3. Vue 3 + Naive UI 书架、卷章树与 TipTap 章节编辑器（第 1 组完成后可并行）

- [x] 3.1 `[web]` 在 `apps/web` 引入稳定的 `@tiptap/vue-3`、`@tiptap/starter-kit`、`@tiptap/extension-placeholder`（遵守 pnpm 12 供应链策略），封装书库/卷章/正文/快照/导出强类型 API 客户端与 Pinia Store（`useBooksStore`、`useBookWorkspaceStore`），并补齐 API 与 Store 单元测试确认通过
- [x] 3.2 `[web]` 将 `/books` 占位页替换为完整的「书架管理」页面（书籍卡片/列表、状态与关键字筛选、新建/编辑弹窗、卷章与总字数统计、回收站抽屉支持恢复与二次确认永久删除、一键下载导出 TXT/MD），同时新增 `/books/:bookId/:chapterId?` 路由并更新 `routes.test.ts` 验证全部路由行为通过
- [x] 3.3 `[web]` 实现书籍写作工作区 `BookWorkspaceView.vue` 的左侧可折叠卷章树（按 `sortOrder` 渲染分卷、章节与未分卷区、新建卷/章、重命名、状态标记、排序上移/下移与跨卷移动、软删与本书回收站抽屉、单章/分卷/全书字数汇总），验证切换章节 URL 同步与空态引导正常
- [x] 3.4 `[web]` 封装 TipTap 长文编辑器组件与右侧历史快照抽屉：支持万字章节顺滑编辑、实时 `countNovelWords` 统计、1500ms 防抖自动保存、`Ctrl/Cmd+S` 立即保存、离开/切章未保存保护、`409 CHAPTER_VERSION_CONFLICT` 冲突处理弹窗（重载最新 / 留底快照后强制覆盖）、手动命名快照 + 历史正文预览 + 一键回滚、以及 `Esc` 进出的沉浸专注模式；补齐编辑器/状态单元测试并验证 `pnpm --filter @fanxiaoshuo/web typecheck && test && build` 全部通过

## 4. 全仓合流、真机迁移与端到端冒烟验收（集成校验）

- [x] 4.1 `[infra]` 合流所有 worktree 至 `main`，在仓库根目录执行 `pnpm typecheck`、`pnpm test` 与 `pnpm build`，确保全部 5 个工作区零报错、零测试失败
- [x] 4.2 `[infra]` 在运行中的 Docker PostgreSQL 上连续执行两次 `pnpm db:migrate`（验证幂等新增 4 张表且保留 Change 1 表），启动 `server` + `web` 执行真实端到端冒烟（创建书 → 建卷建章 → 排序与跨卷移动 → 保存正文并验证字数汇总 → 模拟旧版本保存命中 `409 CHAPTER_VERSION_CONFLICT` → 手动创建快照并一键回滚验证自动留底 → 软删与恢复 → 导出 TXT/MD 验证内容与编码），清理测试数据后更新根目录 `README.md` 补充 Change 2 路由与 API 速查

## Workflow follow-up

- 验收全部通过后执行 `/openspec-verify-change` 对照 `specs` 复核。
- 复核无误后执行 `/openspec-archive-change` 同步主规格（含 `workbench-shell` 更新与新增 `book-library`、`chapter-editor`）并合并至 `main`。
