import {
  AGENT_ROLES,
  AGENT_ROLE_META,
  getAgentRoleMeta,
  type AgentRole,
} from '@fanxiaoshuo/shared';

/** 运行期注册的写书角色定义（不泄露 Mastra / AI SDK 内部类型）。 */
export interface WritingAgentDefinition {
  readonly role: AgentRole;
  readonly label: string;
  readonly labelEn: string;
  readonly responsibility: string;
  readonly description: string;
  /** 默认系统提示词占位：Change 3–4 会在此基础上叠加章节上下文与工具说明 */
  readonly systemPrompt: string;
}

/**
 * 默认系统提示词生成器。
 * 仅包含角色边界与通用输出纪律，不包含具体章节任务（由后续 Change 的 Prompt 模板注入）。
 */
export function buildRoleSystemPrompt(role: AgentRole): string {
  const meta = getAgentRoleMeta(role);
  return [
    `你是「梵小说」的${meta.label}（${meta.labelEn}）。`,
    `核心职责：${meta.responsibility}。`,
    meta.detail,
    '协作纪律：',
    '1. 严格遵循已给定的世界观、设定集与章节细纲，不得自造冲突信息。',
    '2. 需要补充设定时，明确标注「待确认」，交由设定档案员归一化。',
    '3. 输出保持网文可读性：人物口吻一致、节奏清楚、伏笔可回收。',
  ].join('\n');
}

/** 4 个核心角色的系统提示词占位。 */
export const DEFAULT_ROLE_SYSTEM_PROMPTS: Record<AgentRole, string> = {
  showrunner: buildRoleSystemPrompt('showrunner'),
  lorekeeper: buildRoleSystemPrompt('lorekeeper'),
  writer: buildRoleSystemPrompt('writer'),
  critic: buildRoleSystemPrompt('critic'),
};

/** 不可变的写书角色注册表（顺序与 `AGENT_ROLES` 一致）。 */
export const WRITING_AGENT_DEFINITIONS: readonly WritingAgentDefinition[] = AGENT_ROLES.map(
  (role): WritingAgentDefinition => {
    const meta = AGENT_ROLE_META[role];
    return {
      role,
      label: meta.label,
      labelEn: meta.labelEn,
      responsibility: meta.responsibility,
      description: meta.detail,
      systemPrompt: DEFAULT_ROLE_SYSTEM_PROMPTS[role],
    };
  },
);

/** 角色 → 定义。 */
export const WRITING_AGENT_DEFINITION_BY_ROLE: Record<AgentRole, WritingAgentDefinition> =
  Object.fromEntries(
    WRITING_AGENT_DEFINITIONS.map((definition) => [definition.role, definition]),
  ) as Record<AgentRole, WritingAgentDefinition>;

/** 读取角色定义（角色已由共享枚举约束）。 */
export function getWritingAgentDefinition(role: AgentRole): WritingAgentDefinition {
  return WRITING_AGENT_DEFINITION_BY_ROLE[role];
}
