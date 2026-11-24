import { describe, expect, it } from 'vitest';
import {
  AGENT_ROLE_LABELS,
  AGENT_ROLE_META,
  AGENT_ROLES,
  agentRoleSchema,
  getAgentRoleMeta,
  resolveAgentRoleLabel,
} from '../constants/agent-roles.js';

describe('AGENT_ROLES', () => {
  it('固定包含 4 个写书角色且顺序稳定', () => {
    expect(AGENT_ROLES).toEqual(['showrunner', 'lorekeeper', 'writer', 'critic']);
  });

  it('schema 接受全部合法角色', () => {
    for (const role of AGENT_ROLES) {
      expect(agentRoleSchema.safeParse(role).success).toBe(true);
    }
  });

  it('schema 拒绝未知角色与空值', () => {
    for (const invalid of ['editor', 'Showrunner', '', null, 42, undefined]) {
      expect(agentRoleSchema.safeParse(invalid).success).toBe(false);
    }
  });
});

describe('AGENT_ROLE_META', () => {
  it('每个角色都有中文显示名与职责描述', () => {
    for (const role of AGENT_ROLES) {
      const meta = AGENT_ROLE_META[role];
      expect(meta.role).toBe(role);
      expect(meta.label.length).toBeGreaterThan(0);
      expect(meta.labelEn.length).toBeGreaterThan(0);
      expect(meta.responsibility.length).toBeGreaterThan(0);
      expect(meta.detail.length).toBeGreaterThan(meta.responsibility.length - 1);
      expect(meta.label).toMatch(/[\u4e00-\u9fa5]/);
    }
  });

  it('中文显示名与设计文档一致', () => {
    expect(AGENT_ROLE_META.showrunner.label).toBe('总编策划');
    expect(AGENT_ROLE_META.lorekeeper.label).toBe('设定档案员');
    expect(AGENT_ROLE_META.writer.label).toBe('执笔写手');
    expect(AGENT_ROLE_META.critic.label).toBe('审稿质检');
  });

  it('AGENT_ROLE_LABELS 与 META 投影保持一致', () => {
    for (const role of AGENT_ROLES) {
      expect(AGENT_ROLE_LABELS[role]).toBe(AGENT_ROLE_META[role].label);
    }
  });

  it('getAgentRoleMeta 返回对应角色元信息', () => {
    expect(getAgentRoleMeta('writer').role).toBe('writer');
    expect(getAgentRoleMeta('critic').label).toBe('审稿质检');
  });

  it('resolveAgentRoleLabel 未知角色原样返回，不抛异常', () => {
    expect(resolveAgentRoleLabel('writer')).toBe('执笔写手');
    expect(resolveAgentRoleLabel('unknown-role')).toBe('unknown-role');
  });
});
