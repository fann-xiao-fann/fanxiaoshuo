# Spec Delta

## ADDED Requirements

### Requirement: 写作工作区右侧设定集与 AI 助手侧栏
The system SHALL provide a collapsible right-hand assistant panel inside the book writing workspace with dedicated tabs for AI writing, Book Bible management (book outline and knowledge cards), and current chapter memory (chapter outline and summary), synchronized with the active book, active chapter, and editor selection without remounting the editor on chapter switches.

#### Scenario: 在写作工作区展开并切换右侧助手标签页
- **WHEN** 用户在 `/books/:bookId/:chapterId` 写作工作区展开右侧栏并在「AI 写作」「设定集」「本章记忆」之间切换
- **THEN** 各标签页实时展示当前书籍的总大纲/设定卡与当前章节的细纲/摘要/AI 预览状态；同书内切换章节时自动刷新本章记忆并清空过期选区，且编辑器保持挂载不闪烁

#### Scenario: 折叠右侧助手侧栏以扩大正文视野
- **WHEN** 用户点击右侧栏折叠按钮
- **THEN** 右侧助手栏收起为窄边展开触发条，中间正文编辑区平滑扩展宽度

## MODIFIED Requirements

### Requirement: 沉浸专注写作模式
The system SHALL provide a distraction-free immersive writing mode that collapses surrounding workspace chrome (including the main navigation sidebar, left chapter tree, and right Book Bible / AI assistant panel) while keeping essential word count, save status, and quick exit controls accessible.

#### Scenario: 进入与退出沉浸写作模式
- **WHEN** 用户在编辑器工具栏点击「沉浸模式」（或按下退出快捷键 `Esc`）
- **THEN** 系统隐藏主工作台侧边栏、左侧目录树与右侧设定集/AI 助手栏以居中呈现正文编辑区，并在顶部悬浮展示字数、保存状态与退出按钮；退出后恢复原布局状态
