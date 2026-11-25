# Design

## Context

参见 `proposal.md` 的背景与动机。Change 1 已归档并确立了 Monorepo 目录所有权（`packages/shared`、`apps/server`、`apps/web` 等）、Fastify + Drizzle + PostgreSQL 架构及 Vue 3 + Naive UI 工作台壳。Change 2 在此底座上补齐「书库管理 → 卷章树 → TipTap 章节编辑器 → 快照回滚 → 整本导出」全链路，并为 Change 3/4 的 AI 设定记忆与后台批量成文预留无痛对接的字段和并发锁机制。

## Goals / Non-Goals

**Goals:**
- 保持前后端契约单一真相来源（`packages/shared`），新增领域 DTO、错误码与前后端一致的 `countNovelWords` 计数函数。
- 落地 4 张关系清晰、带软删除与乐观并发保护的 PostgreSQL 表（`books`、`volumes`、`chapters`、`chapter_revisions`）与幂等 Drizzle 迁移。
- 落地基于 TipTap 的桌面长文编辑器，解决万字章节性能、防抖自动保存、版本冲突防护、自动节流快照与安全回滚。
- 严格遵守多 Coding Agent 目录边界：Change 2 只动 `packages/shared`、`apps/server`、`apps/web`，第 1 组契约锁定后 `server` 与 `web` 可双 Worktree 并行施工。

**Non-Goals:**
- 不改动 `packages/agents` 与 `apps/worker`（零 AI 调用逻辑、零队列改动）。
- 不做富媒体块（图片上传、表格、代码块）或多人 CRDT 协同；TipTap 仅启用网文正文所需的轻量段落/基础格式扩展，保证大章节编辑零卡顿。
- 不做跨书全文检索或向量切分（留给 Change 3 的 Lorekeeper + `pgvector`）。

## Decisions

### 1. 数据模型设计与 Change 3/4 预留（PostgreSQL + Drizzle ORM）
在 `apps/server/src/db/schema.ts` 新增 4 张表并生成迁移文件 `apps/server/drizzle/0001_*.sql`：

1. **`books`**
   - `id` (uuid PK defaultRandom)
   - `title` (text not null)
   - `author_pen_name` (text not null default `''`)
   - `genre` (text not null default `''`)
   - `status` (text not null default `'draft'`：`draft | ongoing | completed | archived`)
   - `synopsis` (text not null default `''`)
   - `target_chapter_words` (integer not null default `3000`)
   - `deleted_at` (timestamptz nullable)
   - `created_at` / `updated_at` (timestamptz not null defaultNow)
   - 索引：`books_deleted_at_idx (deleted_at)`、`books_updated_at_idx (updated_at)`

2. **`volumes`**
   - `id` (uuid PK defaultRandom)
   - `book_id` (uuid not null FK → `books.id` on delete cascade)
   - `title` (text not null)
   - `summary` (text not null default `''`)
   - `sort_order` (integer not null default `0`)
   - `deleted_at` (timestamptz nullable)
   - `created_at` / `updated_at` (timestamptz not null defaultNow)
   - 索引：`volumes_book_sort_idx (book_id, sort_order)`

3. **`chapters`**
   - `id` (uuid PK defaultRandom)
   - `book_id` (uuid not null FK → `books.id` on delete cascade)
   - `volume_id` (uuid nullable FK → `volumes.id` on delete set null)
   - `title` (text not null)
   - `sort_order` (integer not null default `0`)
   - `status` (text not null default `'draft'`：`outline | draft | reviewing | final`)
   - `content_text` (text not null default `''`)
   - `content_json` (jsonb nullable)
   - `word_count` (integer not null default `0`)
   - `version` (integer not null default `1`)
   - `deleted_at` (timestamptz nullable)
   - `created_at` / `updated_at` (timestamptz not null defaultNow)
   - 索引：`chapters_book_volume_sort_idx (book_id, volume_id, sort_order)`、`chapters_book_deleted_idx (book_id, deleted_at)`

4. **`chapter_revisions`**（Append-only 快照表）
   - `id` (uuid PK defaultRandom)
   - `chapter_id` (uuid not null FK → `chapters.id` on delete cascade)
   - `version` (integer not null)
   - `source` (text not null：`manual | auto | restore | ai`)
   - `note` (text not null default `''`)
   - `title_snapshot` (text not null)
   - `content_text` (text not null)
   - `content_json` (jsonb nullable)
   - `word_count` (integer not null default `0`)
   - `created_at` (timestamptz not null defaultNow)
   - 索引：`chapter_revisions_chapter_created_idx (chapter_id, created_at)`

- **双存储理由（`content_text` + `content_json`）**：前端 TipTap 读写结构化 ProseMirror JSON（精准保留段落），同时服务端保存时同步落盘归一化后的纯文本 `content_text`（段落间以 `\n\n` 分隔）。后续 AI 上下文拼装、TXT/MD 导出、字数重算全部直接读 `content_text`，无需在后端引入 ProseMirror DOM 解析依赖。
- **替代方案**：只存 Markdown 字符串 → 缺点是网文里频繁出现 `*`、`#`、`---`、`>` 等对话/拟声符号容易被 Markdown 误解析成标题或斜体。

### 2. 乐观并发控制（Optimistic Concurrency）
- 章节内容保存接口 `PUT /api/v1/chapters/:id/content` 必须携带 `expectedVersion`（正整数；可选 `forceOverwrite: true` 仅在用户解决冲突并先留底快照后显式传出）。
- SQL 条件更新：`UPDATE chapters SET ..., version = version + 1, updated_at = now() WHERE id = $id AND deleted_at IS NULL AND version = $expectedVersion RETURNING *`。
- 若受影响行数为 0：查询该章节是否存在且未删；若存在则返回 `409 CHAPTER_VERSION_CONFLICT`（`details` 附带服务端最新 `currentVersion`），确保不会静默覆盖其他标签页或后续 Change 4 后台 Worker 写入的新内容。

### 3. 自动快照节流与安全回滚
- **手动快照**：`POST /api/v1/chapters/:id/revisions` 立即写入 `source: 'manual'` 快照。
- **自动快照**：在 `PUT /api/v1/chapters/:id/content` 落盘成功后，仅当本次正文较最近一次快照确有实质变更（`content_text` 不同且非空）且距最近一次 `auto` 快照间隔 `>= 5 分钟`（可通过服务端配置注入，便于单元测试覆盖）时，自动追加一条 `source: 'auto'` 快照，防止 1.5s 防抖自动保存把快照表写爆。
- **回滚安全网**：`POST /api/v1/chapters/:id/revisions/:revisionId/restore` 在事务中执行两步：① 先将当前章节现状写入一条 `source: 'restore'` 快照（备注「回滚至 vN 前自动备份」）；② 将章节标题、正文、JSON、字数恢复为目标快照内容并将 `version` 加 1。任何误回滚都可二次恢复。

### 4. 统一网文字数统计函数（`packages/shared`）
在 `packages/shared/src/utils/word-count.ts` 导出纯函数 `countNovelWords(text: string): number`：
- 统计规则：每个 CJK 汉字/标点区间内的中文字符记 1 字（不含空白字符），连续英文/数字词（`[A-Za-z0-9]+`）按 1 词计（或单字符统计统一规范：采用国内网文平台通用口径——**去除所有空白字符后的非空白字符数，其中连续 ASCII 字母/数字按词计数、每个 CJK 字符按 1 字计数、中文标点计入字数与主流网文平台一致**，并编写覆盖中英混排、换行、全角空格、emoji 的单元测试锁定口径）。
- 前后端共享同一函数：前端实时展示零延迟，后端写入前独立重算不信任客户端上报值。

### 5. REST API 契约（`apps/server`，前缀 `/api/v1`）
- **书架与回收站**：
  - `GET /api/v1/books`（支持 `status`、`q`、`includeDeleted=only|exclude`）→ 返回含 `volumeCount`、`chapterCount`、`totalWordCount` 聚合的书籍列表
  - `POST /api/v1/books`、`GET /api/v1/books/:bookId`、`PATCH /api/v1/books/:bookId`
  - `DELETE /api/v1/books/:bookId`（软删除，传 `?permanent=true` 时仅允许对已在回收站的书籍执行永久删除，防止误删！）
  - `POST /api/v1/books/:bookId/restore`
- **卷章树与重排**：
  - `GET /api/v1/books/:bookId/tree`（返回书籍信息 + 按 `sortOrder` 排序的卷列表（含每卷下章元信息与卷字数汇总）+ `ungroupedChapters` + 回收站计数，**不返回章节正文 `content_text`/`content_json`**，确保百章级目录树响应体积小、展开丝滑！）
  - `GET /api/v1/books/:bookId/trash`（本书下已软删除的卷与章列表）
  - `POST /api/v1/books/:bookId/volumes`、`PATCH /api/v1/volumes/:volumeId`、`DELETE /api/v1/volumes/:volumeId`（软删或 `?permanent=true`）、`POST /api/v1/volumes/:volumeId/restore`
  - `PUT /api/v1/books/:bookId/volumes/reorder`（请求体 `{ volumeIds: uuid[] }`，事务重写 `sortOrder`）
  - `POST /api/v1/books/:bookId/chapters`、`PATCH /api/v1/chapters/:chapterId`（改标题/状态/所属卷）、`DELETE /api/v1/chapters/:chapterId`（软删或 `?permanent=true`）、`POST /api/v1/chapters/:chapterId/restore`
  - `PUT /api/v1/books/:bookId/chapters/reorder`（支持同卷排序与跨卷移动：`{ items: Array<{ chapterId, volumeId, sortOrder }> }`，校验全部归属同一 `bookId` 后在单事务内更新）
- **章节正文与历史快照**：
  - `GET /api/v1/chapters/:chapterId`（返回完整正文 `contentText`/`contentJson`/`wordCount`/`version`）
  - `PUT /api/v1/chapters/:chapterId/content`（带 `expectedVersion` 乐观锁更新正文与可选标题，按节流策略生成 `auto` 快照）
  - `GET /api/v1/chapters/:chapterId/revisions`（倒序返回元信息列表）
  - `GET /api/v1/chapters/:chapterId/revisions/:revisionId`（返回快照完整正文供预览）
  - `POST /api/v1/chapters/:chapterId/revisions`（手动创建快照）
  - `POST /api/v1/chapters/:chapterId/revisions/:revisionId/restore`（安全留底并回滚）
- **整本导出**：
  - `GET /api/v1/books/:bookId/export?format=txt|md`（返回 `text/plain; charset=utf-8` 或 `text/markdown; charset=utf-8`，带 RFC 5987 UTF-8 `Content-Disposition: attachment; filename*=UTF-8''...` 文件名头，排除软删卷章）

### 6. 前端编辑器架构（`apps/web`）
- **路由结构**：
  - `/books` → `BooksView.vue`（书架卡片/列表、筛选、新建/编辑弹窗、回收站抽屉、一键导出 TXT/MD）
  - `/books/:bookId/:chapterId?` → `BookWorkspaceView.vue`（左侧可折叠卷章树 + 中央 TipTap 正文编辑器 + 右侧按需打开的「历史快照」/「本书回收站」抽屉；未指定 `chapterId` 时自动选中第一章或展示空态引导新建）
  - 根路径 `/` 重定向保持兼容（建议将默认主视图更新为 `/books` 或在 `workbench-shell` 路由测试同步更新断言，让作者打开工作台直达书架）。
- **TipTap 轻量化配置**：
  - 仅安装 `@tiptap/vue-3`、`@tiptap/starter-kit`（禁用 codeBlock/blockquote/heading 等网文不需要的复杂块，或仅保留基础段落、撤销/重做、加粗/斜体与分隔线）+ `@tiptap/extension-placeholder`。
  - 使用原生拖放或清晰的上下移/跨卷移动菜单 + 拖拽排序（确保桌面端操作无障碍且单测可控）。
  - 防抖自动保存（默认 1500ms）+ `Ctrl/Cmd+S` 立即冲刷 + 路由导航守卫 `onBeforeRouteLeave` 与 `beforeunload` 双重防丢稿。
  - 沉浸模式通过 Pinia UI 状态控制隐藏主侧栏与目录树，按 `Esc` 或顶部悬浮按钮一键退出。

## Risks / Trade-offs

- **[Risk] Fastify 默认 `bodyLimit` 为 2MB，单章万字正文远小于 2MB，但极长章节 + ProseMirror JSON 可能体积膨胀** → Mitigation：TipTap JSON 只启用基础文本节点，10 万字 JSON 也仅 ~300KB，远在 2MB 安全范围内；并在 Zod Schema 对单章正文设合理上限（如 500,000 字符）防止异常报文打垮内存。
- **[Risk] 删除分卷时若该卷下还有未删章节，直接级联软删或孤儿化容易让作者找不到稿子** → Mitigation：软删分卷时，目录树隐藏该分卷及其章节，回收站恢复分卷时同步恢复关联展示；彻底删除分卷时因外键 `ON DELETE SET NULL`，卷下未被单独删除的章节自动归入「未分卷章节」，绝不静默丢失正文。
- **[Risk] pnpm 12 供应链 `minimumReleaseAge` 策略可能拦截刚刚发布的新版本 `@tiptap/*`** → Mitigation：安装 `@tiptap/vue-3`、`@tiptap/starter-kit`、`@tiptap/extension-placeholder` 时选用已过冷静期的稳定版本，禁止擅自放宽根安全策略。
- **[Risk] 前端与后端双 Worktree 并行开发时接口字段微调导致联调返工** → Mitigation：严格先完成 Group 1（`packages/shared` 全量 DTO + 错误码 + `countNovelWords` 并合并至 `main`），Group 2（`apps/server`）与 Group 3（`apps/web`）均以 `@fanxiaoshuo/shared` 为唯一编译期契约。

## Migration Plan

1. 在 `apps/server` 运行 `pnpm db:generate` 生成 `0001_*.sql` Drizzle 迁移文件并随代码提交。
2. 升级本地环境时直接执行 `pnpm db:migrate`（幂等追加 4 张新表，不触碰 Change 1 任何表数据）。
3. 如需回滚，可在维护窗口手工按依赖逆序 `DROP TABLE chapter_revisions, chapters, volumes, books;`（不影响 Change 1 模型与用量数据）。
