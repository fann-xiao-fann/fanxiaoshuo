import { describe, expect, it } from 'vitest';
import {
  agentRoleBindingInputSchema,
  agentRoleRouteDtoSchema,
  agentRolesResponseSchema,
  updateAgentRolesSchema,
} from '../schemas/agent-role-binding.js';

const MODEL_UUID = '33333333-3333-4333-8333-333333333333';
const PROVIDER_UUID = '44444444-4444-4444-8444-444444444444';
const TS = '2025-03-04T05:06:07.000Z';

describe('agentRoleBindingInputSchema', () => {
  it('接受绑定并填充默认温度与 maxTokens', () => {
    const parsed = agentRoleBindingInputSchema.parse({ role: 'writer', modelId: MODEL_UUID });
    expect(parsed.temperature).toBe(0.7);
    expect(parsed.maxTokens).toBeNull();
  });

  it('允许显式解绑（modelId=null）与自定义采样参数', () => {
    const parsed = agentRoleBindingInputSchema.parse({
      role: 'critic',
      modelId: null,
      temperature: 0.1,
      maxTokens: 4096,
    });
    expect(parsed.modelId).toBeNull();
    expect(parsed.maxTokens).toBe(4096);
  });

  it('拒绝越界温度、非法 maxTokens 与未知角色', () => {
    expect(
      agentRoleBindingInputSchema.safeParse({ role: 'writer', modelId: null, temperature: 2.5 })
        .success,
    ).toBe(false);
    expect(
      agentRoleBindingInputSchema.safeParse({ role: 'writer', modelId: null, temperature: -0.1 })
        .success,
    ).toBe(false);
    expect(
      agentRoleBindingInputSchema.safeParse({ role: 'writer', modelId: null, maxTokens: 0 }).success,
    ).toBe(false);
    expect(
      agentRoleBindingInputSchema.safeParse({ role: 'writer', modelId: null, maxTokens: 1.5 })
        .success,
    ).toBe(false);
    expect(agentRoleBindingInputSchema.safeParse({ role: 'editor', modelId: null }).success).toBe(
      false,
    );
  });

  it('拒绝非 uuid 的 modelId 与未知字段', () => {
    expect(agentRoleBindingInputSchema.safeParse({ role: 'writer', modelId: 'abc' }).success).toBe(
      false,
    );
    expect(
      agentRoleBindingInputSchema.safeParse({ role: 'writer', modelId: null, apiKey: 'sk-1' }).success,
    ).toBe(false);
  });
});

describe('updateAgentRolesSchema', () => {
  it('接受批量更新 4 个角色', () => {
    const parsed = updateAgentRolesSchema.parse({
      bindings: [
        { role: 'showrunner', modelId: MODEL_UUID, temperature: 0.3 },
        { role: 'lorekeeper', modelId: MODEL_UUID },
        { role: 'writer', modelId: MODEL_UUID, maxTokens: 8192 },
        { role: 'critic', modelId: null },
      ],
    });
    expect(parsed.bindings).toHaveLength(4);
  });

  it('拒绝空数组与同角色重复', () => {
    expect(updateAgentRolesSchema.safeParse({ bindings: [] }).success).toBe(false);
    expect(
      updateAgentRolesSchema.safeParse({
        bindings: [
          { role: 'writer', modelId: MODEL_UUID },
          { role: 'writer', modelId: null },
        ],
      }).success,
    ).toBe(false);
  });

  it('拒绝超过 4 条绑定（防止重复角色绕过校验）', () => {
    expect(
      updateAgentRolesSchema.safeParse({
        bindings: [
          { role: 'showrunner', modelId: null },
          { role: 'lorekeeper', modelId: null },
          { role: 'writer', modelId: null },
          { role: 'critic', modelId: null },
          { role: 'writer', modelId: null },
        ],
      }).success,
    ).toBe(false);
  });
});

describe('agentRoleRouteDtoSchema', () => {
  const bound = {
    role: 'showrunner',
    roleLabel: '总编策划',
    responsibility: '立项定调、拆解细纲与统稿',
    modelId: MODEL_UUID,
    temperature: 0.5,
    maxTokens: 2048,
    updatedAt: TS,
    model: {
      id: MODEL_UUID,
      modelId: 'deepseek-reasoner',
      displayName: 'DeepSeek Reasoner',
      contextWindow: 65536,
      inputPricePer1M: 0.55,
      outputPricePer1M: 2.19,
      isEnabled: true,
    },
    provider: {
      id: PROVIDER_UUID,
      name: '中转一号',
      protocol: 'openai-compatible',
      isEnabled: true,
    },
  };

  it('接受已绑定角色路由', () => {
    const parsed = agentRoleRouteDtoSchema.parse(bound);
    expect(parsed.provider?.name).toBe('中转一号');
    expect(parsed.model?.modelId).toBe('deepseek-reasoner');
  });

  it('接受未绑定角色（全场 null）', () => {
    const parsed = agentRoleRouteDtoSchema.parse({
      role: 'lorekeeper',
      roleLabel: '设定档案员',
      responsibility: '维护设定集与长文记忆',
      modelId: null,
      temperature: 0.7,
      maxTokens: null,
      updatedAt: null,
      model: null,
      provider: null,
    });
    expect(parsed.modelId).toBeNull();
    expect(parsed.model).toBeNull();
  });

  it('拒绝未知角色、非法温度与额外的明文密钥字段', () => {
    expect(agentRoleRouteDtoSchema.safeParse({ ...bound, role: 'editor' }).success).toBe(false);
    expect(agentRoleRouteDtoSchema.safeParse({ ...bound, temperature: 3 }).success).toBe(false);
    expect(
      agentRoleRouteDtoSchema.safeParse({
        ...bound,
        provider: { ...bound.provider, apiKey: 'sk-leak' },
      }).success,
    ).toBe(false);
  });

  it('agentRolesResponseSchema 校验角色列表', () => {
    expect(agentRolesResponseSchema.parse({ roles: [bound] }).roles).toHaveLength(1);
    expect(agentRolesResponseSchema.safeParse({ roles: 'nope' }).success).toBe(false);
  });
});
