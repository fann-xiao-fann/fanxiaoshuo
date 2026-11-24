import { z } from 'zod';

/**
 * 梵小说运行期 4 个核心写书 Agent 角色。
 * 顺序即工作台「角色路由」面板的展示顺序：策划 → 设定 → 执笔 → 审稿。
 */
export const AGENT_ROLES = ['showrunner', 'lorekeeper', 'writer', 'critic'] as const;

export const agentRoleSchema = z.enum(AGENT_ROLES);

export type AgentRole = z.infer<typeof agentRoleSchema>;

/** 角色静态元信息：中文显示名 + 职责说明（前端展示与 Prompt 模板共用）。 */
export interface AgentRoleMeta {
  readonly role: AgentRole;
  /** 中文显示名 */
  readonly label: string;
  /** 英文标识（用于 Prompt / 日志，等价于 role） */
  readonly labelEn: string;
  /** 一句话职责描述 */
  readonly responsibility: string;
  /** 详细职责边界说明 */
  readonly detail: string;
}

export const AGENT_ROLE_META = {
  showrunner: {
    role: 'showrunner',
    label: '总编策划',
    labelEn: 'Showrunner',
    responsibility: '立项定调、拆解细纲与统稿',
    detail: '负责书名/简介/世界观主线定型，把大纲拆成可写的章节细纲，并在跨章一致性上做最终裁决。',
  },
  lorekeeper: {
    role: 'lorekeeper',
    label: '设定档案员',
    labelEn: 'Lorekeeper',
    responsibility: '维护设定集与长文记忆',
    detail: '负责人设卡、世界观条目、时间线与章节摘要的抽取、归一化与检索，为其他角色提供不失真的上下文。',
  },
  writer: {
    role: 'writer',
    label: '执笔写手',
    labelEn: 'ChapterWriter',
    responsibility: '按细纲逐章成文',
    detail: '依据章节细纲与设定集上下文完成正文写作，保持人物口吻、节奏与伏笔铺陈。',
  },
  critic: {
    role: 'critic',
    label: '审稿质检',
    labelEn: 'Critic',
    responsibility: '质量审校与返工裁判',
    detail: '从连贯性、设定冲突、节奏与文风四个维度打分，定位问题段落并给出是否返工的明确结论。',
  },
} as const satisfies Record<AgentRole, AgentRoleMeta>;

/** 角色中文显示名映射（`AGENT_ROLE_META` 的轻量投影）。 */
export const AGENT_ROLE_LABELS = {
  showrunner: AGENT_ROLE_META.showrunner.label,
  lorekeeper: AGENT_ROLE_META.lorekeeper.label,
  writer: AGENT_ROLE_META.writer.label,
  critic: AGENT_ROLE_META.critic.label,
} as const satisfies Record<AgentRole, string>;

/**
 * 安全读取角色元信息（输入来自外部时先经 `agentRoleSchema` 校验）。
 */
export function getAgentRoleMeta(role: AgentRole): AgentRoleMeta {
  return AGENT_ROLE_META[role];
}

/** 角色展示名兜底：未知角色原样返回，避免前端渲染崩溃。 */
export function resolveAgentRoleLabel(role: string): string {
  return (AGENT_ROLE_LABELS as Record<string, string | undefined>)[role] ?? role;
}
