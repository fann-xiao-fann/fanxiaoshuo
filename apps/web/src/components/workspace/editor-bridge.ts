import type { TiptapJson } from '@fanxiaoshuo/shared';

/**
 * 编辑器选区替换结果：同时给出纯文本与结构化 JSON，
 * 让 `POST /chapters/:chapterId/ai/apply` 能一次提交完整正文。
 */
export interface EditorSelectionReplacement {
  contentText: string;
  contentJson: TiptapJson;
}

/**
 * 写作工作区与右侧 AI 助手之间的编辑器桥接能力。
 *
 * 由 `ChapterTipTapEditor` 通过 `defineExpose` 暴露，`BookWorkspaceView` 持有组件 ref
 * 并透传给 `AiWriterPanel`，避免把 ProseMirror 实例塞进全局 Store。
 */
export interface WorkspaceEditorBridge {
  /** 用 `replacementText` 精准替换当前选区；无选区或异常时返回 `null`。 */
  buildReplacedSelectionContent(replacementText: string): EditorSelectionReplacement | null;
}
