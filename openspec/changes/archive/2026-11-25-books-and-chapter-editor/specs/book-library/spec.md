# Spec Delta

## Purpose

提供「梵小说」的书架作品管理、卷与章节层级目录树、排序与跨卷调整、软删除回收站、实时字数统计聚合以及整本 TXT/Markdown 导出能力。

## ADDED Requirements

### Requirement: 书架作品增删改查与筛选
The system SHALL allow users to create, list, filter, update, and soft-delete novel books with title, author pen name, genre, writing status, synopsis, and target chapter word count.

#### Scenario: 创建新书并展示在书架
- **WHEN** 用户提交有效的书名及可选的笔名、题材、状态、简介与单章目标字数
- **THEN** 系统持久化该书记录并在书架列表展示，同时返回初始卷数 0、章数 0 与总字数 0

#### Scenario: 按状态或关键字筛选书架
- **WHEN** 用户按作品状态（草稿、连载中、完结、归档）或书名关键字筛选书架
- **THEN** 系统仅返回符合条件且未进入回收站的书籍列表，并附带各书聚合章节数、总字数与最近更新时间

#### Scenario: 提交非法书名或目标字数被拒绝
- **WHEN** 用户提交空书名或非正整数的单章目标字数
- **THEN** 系统返回结构化校验错误并指出具体字段原因，不写入任何数据

### Requirement: 书架软删除与回收站管理
The system SHALL support soft-deleting books into a trash view, restoring deleted books with all their volumes and chapters intact, and permanently purging trashed books.

#### Scenario: 软删除书籍进入回收站
- **WHEN** 用户对某本书执行移入回收站操作
- **THEN** 该书不再出现在默认书架列表中，但可在回收站列表中查看并保留全部卷章内容

#### Scenario: 从回收站恢复书籍
- **WHEN** 用户对回收站中的书籍执行恢复操作
- **THEN** 该书重新回到默认书架列表，原有卷章结构、正文与历史快照完整保留

#### Scenario: 彻底删除回收站书籍
- **WHEN** 用户对回收站中的书籍执行永久删除并确认
- **THEN** 系统级联移除该书及其下全部卷、章节与历史快照记录，且不可再恢复

### Requirement: 卷与章节层级树管理
The system SHALL organize each book into ordered volumes and ordered chapters (including optional ungrouped chapters), supporting creation, renaming, status updates, soft-deletion, and restoration within the book tree.

#### Scenario: 创建分卷并在卷下创建章节
- **WHEN** 用户在某本书下新建分卷并在该卷下新建章节
- **THEN** 卷章树接口按 `sortOrder` 升序返回完整层级结构，新建卷与章自动追加到对应末尾

#### Scenario: 软删除分卷或章节后可从本书回收站恢复
- **WHEN** 用户在卷章树中软删除某个章节或分卷
- **THEN** 被删除节点从正文目录树隐藏且全书总字数即时重算，并可在回收站抽屉中恢复或彻底清理

#### Scenario: 查询不存在的书籍或跨书越界操作
- **WHEN** 客户端使用不存在的 `bookId` 或将不属于目标书籍的 `volumeId` 传入章节创建接口
- **THEN** 系统返回明确的 404 或校验冲突错误，不产生跨书脏关联

### Requirement: 卷章排序与跨卷移动
The system SHALL support atomically reordering volumes within a book and reordering chapters within the same volume or moving chapters across volumes.

#### Scenario: 调整同卷内章节顺序
- **WHEN** 用户提交新的章节排序列表（如将第 3 章移动到第 1 章之前）
- **THEN** 系统在单一事务中更新受影响章节的 `sortOrder`，再次拉取目录树按新顺序稳定展示

#### Scenario: 将章节跨卷移动
- **WHEN** 用户将某章节从卷 A 移动至卷 B 指定位置（或移至未分卷区）
- **THEN** 系统在单一事务中更新该章节的 `volumeId` 与相关章节的 `sortOrder`，原卷与目标卷章数及字数汇总同步更新

### Requirement: 统一中英文字数统计与全书汇总
The system SHALL calculate chapter word counts using a consistent novel word-counting rule (counting CJK characters and alphanumeric words while excluding whitespace) and aggregate active chapter counts and total words per volume and per book.

#### Scenario: 章节保存后实时更新单章与全书字数
- **WHEN** 用户修改并保存某章节正文
- **THEN** 系统服务端重算并持久化该章节字数，目录树与书架接口返回的分卷字数和全书总字数立即同步反映变化

### Requirement: 整本作品导出为 TXT 与 Markdown
The system SHALL allow users to export any active book with all non-deleted volumes and chapters in reading order as a downloadable UTF-8 `.txt` or `.md` file.

#### Scenario: 导出整本 TXT 文件
- **WHEN** 用户触发某本书的 TXT 导出操作
- **THEN** 系统按卷与章的 `sortOrder` 顺序拼装书名、简介、卷标题、章标题与正文，返回 `Content-Disposition: attachment` 的 UTF-8 文本下载流

#### Scenario: 导出整本 Markdown 文件
- **WHEN** 用户触发某本书的 Markdown 导出操作
- **THEN** 系统输出以 `# 书名`、`## 卷名`、`### 章名` 分层的标准 Markdown 文档下载流，且自动排除已软删除的卷和章
