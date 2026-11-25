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

  it('SQL 覆盖 Change 2 书库 4 张表、全部索引与外键行为（cascade / set null）', () => {
    const sql = readSql();

    for (const table of ['books', 'volumes', 'chapters', 'chapter_revisions']) {
      expect(sql).toContain(`CREATE TABLE "${table}"`);
    }

    // 索引：软删 / 书架排序、卷内排序、章排序与回收站、快照时间线
    for (const indexName of [
      'books_deleted_at_idx',
      'books_updated_at_idx',
      'volumes_book_sort_idx',
      'chapters_book_volume_sort_idx',
      'chapters_book_deleted_idx',
      'chapter_revisions_chapter_created_idx',
    ]) {
      expect(sql).toContain(`CREATE INDEX "${indexName}"`);
    }

    // 外键：书籍删除级联清理卷 / 章 / 快照；分卷删除时章节归入未分卷区
    expect(sql).toContain('volumes_book_id_books_id_fk');
    expect(sql).toContain('chapters_book_id_books_id_fk');
    expect(sql).toContain('chapters_volume_id_volumes_id_fk');
    expect(sql).toContain('chapter_revisions_chapter_id_chapters_id_fk');
    expect(sql).toMatch(/ON DELETE set null/);

    // 双存储（纯文本 + TipTap JSON）、版本号默认 1、软删时间戳可空
    expect(sql).toContain('"content_json" jsonb');
    expect(sql).toContain('"content_text" text DEFAULT \'\' NOT NULL');
    expect(sql).toContain('"version" integer DEFAULT 1 NOT NULL');
    expect(sql).toContain('"deleted_at" timestamp with time zone');
    expect(sql).toContain('"target_chapter_words" integer DEFAULT 3000 NOT NULL');
  });
});
