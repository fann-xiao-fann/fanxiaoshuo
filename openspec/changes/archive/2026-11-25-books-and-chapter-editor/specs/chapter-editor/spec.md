# Spec Delta

## Purpose

提供面向万字网文长章节的桌面正文编辑器、防抖自动保存、乐观并发版本冲突防护、手动与自动历史快照回滚，以及沉浸专注写作模式，确保创作过程流畅不卡顿、不丢稿。

## ADDED Requirements

### Requirement: 章节正文加载与长文编辑体验
The system SHALL load a selected chapter's title, status, structured content, plain text, word count, and version into the writing workspace and allow smooth editing of long chapters exceeding 10,000 characters.

#### Scenario: 切换目录树章节加载正文
- **WHEN** 用户在卷章树中点击任意章节
- **THEN** 编辑器加载该章节标题、状态、正文内容与实时字数，URL 同步更新为 `/books/:bookId/:chapterId`

#### Scenario: 万字章节输入与编辑流畅响应
- **WHEN** 用户在超过 10,000 字的章节中连续键入、分段、撤销或重做
- **THEN** 编辑器保持实时输入响应与准确字数更新，且不破坏原有段落换行结构

### Requirement: 防抖自动保存、手动保存与离开保护
The system SHALL automatically save dirty chapter edits after an idle debounce window, support immediate manual save via button or `Ctrl/Cmd+S`, display clear save state indicators, and warn before discarding unsaved edits.

#### Scenario: 停止输入后触发防抖自动保存
- **WHEN** 用户修改章节标题或正文并停止输入超过防抖窗口
- **THEN** 界面状态从「未保存」转为「保存中」再变为「已保存」，后端持久化正文、字数并递增章节版本号

#### Scenario: 快捷键立即保存
- **WHEN** 用户在编辑器聚焦状态下按下 `Ctrl+S` 或 `Cmd+S`
- **THEN** 系统阻止浏览器默认保存网页弹窗并立即提交保存请求

#### Scenario: 存在未保存改动时切换章节或关闭页面
- **WHEN** 当前章节仍有未落盘的本地改动且用户尝试切换章节或刷新页面
- **THEN** 系统先尝试冲刷保存或给出明确未保存确认提醒，防止静默丢稿

### Requirement: 乐观并发版本校验与冲突防护
The system SHALL enforce optimistic concurrency control using chapter version numbers on content saves so stale clients or concurrent background writers cannot silently overwrite newer edits.

#### Scenario: 携带最新版本号保存成功
- **WHEN** 客户端提交章节保存请求并携带与数据库一致的 `expectedVersion`
- **THEN** 系统保存正文、更新字数并将 `version` 加 1 返回给客户端

#### Scenario: 版本号过期时拦截覆盖并提示冲突
- **WHEN** 客户端提交保存请求时 `expectedVersion` 小于数据库当前版本
- **THEN** 后端拒绝写入并返回 `409 CHAPTER_VERSION_CONFLICT` 及服务端最新版本号
- **AND** 前端弹出明确冲突提示，允许用户选择「重新加载最新版本」或「先留底快照后强制覆盖」

### Requirement: 章节历史版本快照与一键回滚
The system SHALL maintain immutable chapter revision snapshots supporting manual named snapshots, throttled automatic snapshots during editing, snapshot content preview, and safe one-click restoration.

#### Scenario: 手动创建命名快照
- **WHEN** 用户在编辑器点击「保存快照」并输入可选备注
- **THEN** 系统将当前章节标题、正文、字数与版本号写入不可变历史快照表，并在版本历史列表中按时间倒序展示

#### Scenario: 持续编辑期间自动节流留底
- **WHEN** 章节正文发生实质内容变化且距离上一次自动快照已超过节流间隔（如 5 分钟）
- **THEN** 后端在保存正文时自动追加一条 `auto` 来源快照，避免频繁自动保存导致快照表膨胀

#### Scenario: 一键回滚至指定历史快照
- **WHEN** 用户在历史快照抽屉中预览某条历史版本并确认「回滚到此版本」
- **THEN** 后端先将回滚前的当前正文自动留底为一条 `restore` 快照，再把章节正文恢复为目标快照内容并递增版本号
- **AND** 编辑器立即刷新为回滚后的正文且历史记录中可追溯回滚前的版本

### Requirement: 沉浸专注写作模式
The system SHALL provide a distraction-free immersive writing mode that collapses surrounding workspace chrome while keeping essential word count, save status, and quick exit controls accessible.

#### Scenario: 进入与退出沉浸写作模式
- **WHEN** 用户在编辑器工具栏点击「沉浸模式」（或按下退出快捷键 `Esc`）
- **THEN** 系统隐藏主工作台侧边栏与目录树以居中呈现正文编辑区，并在顶部悬浮展示字数、保存状态与退出按钮；退出后恢复原布局状态
