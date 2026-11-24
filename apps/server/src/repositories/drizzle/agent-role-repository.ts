import type { AgentRole } from '@fanxiaoshuo/shared';
import { agentRoleSchema } from '@fanxiaoshuo/shared';
import { eq, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { agentRoleBindings } from '../../db/schema.js';
import type {
  AgentRoleBindingRecord,
  AgentRoleRepository,
  UpsertAgentRoleBindingInput,
} from '../types.js';
import { createDrizzleModelRepository } from './model-repository.js';

/** Drizzle 实现的 Agent 角色绑定仓储。 */
export function createDrizzleAgentRoleRepository(db: Database): AgentRoleRepository {
  const modelRepository = createDrizzleModelRepository(db);

  return {
    async list(): Promise<AgentRoleBindingRecord[]> {
      const rows = await db.select().from(agentRoleBindings);
      const records: AgentRoleBindingRecord[] = [];

      for (const row of rows) {
        const parsedRole = agentRoleSchema.safeParse(row.role);
        if (!parsedRole.success) {
          continue;
        }
        const related = await modelRepository.findWithProvider(row.modelId);
        records.push({
          role: parsedRole.data,
          modelId: row.modelId,
          temperature: row.temperature,
          maxTokens: row.maxTokens,
          updatedAt: row.updatedAt,
          model: related?.model ?? null,
          provider: related?.provider ?? null,
        });
      }

      return records;
    },

    async isModelBound(modelId) {
      const [row] = await db
        .select({ value: sql<number>`count(*)::int` })
        .from(agentRoleBindings)
        .where(eq(agentRoleBindings.modelId, modelId));
      return (row?.value ?? 0) > 0;
    },

    async upsert(input: UpsertAgentRoleBindingInput) {
      await db
        .insert(agentRoleBindings)
        .values({
          role: input.role,
          modelId: input.modelId,
          temperature: input.temperature,
          maxTokens: input.maxTokens,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: agentRoleBindings.role,
          set: {
            modelId: input.modelId,
            temperature: input.temperature,
            maxTokens: input.maxTokens,
            updatedAt: new Date(),
          },
        });
    },

    async remove(role: AgentRole) {
      await db.delete(agentRoleBindings).where(eq(agentRoleBindings.role, role));
    },
  };
}
