import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolveMigrationsFolder } from '../db/migrate.js';

const drizzleDir = fileURLToPath(new URL('../../drizzle', import.meta.url));

function readSql(): string {
  const files = readdirSync(drizzleDir).filter((file) => file.endsWith('.sql'));
  expect(files.length).toBeGreaterThan(0);
  return files.map((file) => readFileSync(`${drizzleDir}/${file}`, 'utf8')).join('\n');
}

describe('Drizzle 迁移产物', () => {
  it('迁移目录与 journal 存在且 resolveMigrationsFolder 指向正确位置', () => {
    expect(existsSync(drizzleDir)).toBe(true);
    expect(existsSync(`${drizzleDir}/meta/_journal.json`)).toBe(true);
    expect(resolveMigrationsFolder().replaceAll('\\', '/')).toMatch(/apps\/server\/drizzle$/);

    const journal = JSON.parse(readFileSync(`${drizzleDir}/meta/_journal.json`, 'utf8')) as {
      entries?: unknown[];
    };
    expect(Array.isArray(journal.entries)).toBe(true);
    expect(journal.entries?.length).toBeGreaterThanOrEqual(1);
  });

  it('SQL 覆盖 4 张核心表、联合唯一索引、外键级联/限制与 numeric 精度', () => {
    const sql = readSql();

    for (const table of [
      'llm_providers',
      'llm_models',
      'agent_role_bindings',
      'llm_usage_logs',
    ]) {
      expect(sql).toContain(`CREATE TABLE "${table}"`);
    }

    expect(sql).toContain('CREATE UNIQUE INDEX "llm_models_provider_model_id_unique"');
    expect(sql).toContain('("provider_id","model_id")');
    expect(sql).toContain('numeric(12, 6)');
    expect(sql).toMatch(/ON DELETE restrict/);
    expect(sql).toMatch(/ON DELETE cascade/);
    expect(sql).toContain('agent_role_bindings_model_id_llm_models_id_fk');
    expect(sql).toContain('llm_models_provider_id_llm_providers_id_fk');
  });
});
