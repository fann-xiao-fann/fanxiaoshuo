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

  it('SQL 覆盖 Change 3 Book Bible 3 张表、pgvector 扩展与索引', () => {
    const sql = readSql();

    // 迁移顶部必须幂等启用 pgvector 扩展（任意空库可直接执行）。
    expect(sql).toContain('CREATE EXTENSION IF NOT EXISTS vector;');

    for (const table of ['book_outlines', 'knowledge_cards', 'chapter_summaries']) {
      expect(sql).toContain(`CREATE TABLE "${table}"`);
    }

    // 索引：设定卡分类 / 常驻、章节摘要按书
    for (const indexName of [
      'knowledge_cards_book_category_sort_idx',
      'knowledge_cards_book_pinned_idx',
      'chapter_summaries_book_idx',
    ]) {
      expect(sql).toContain(`CREATE INDEX "${indexName}"`);
    }

    // 外键：书籍删除级联清理总大纲 / 设定卡 / 章节摘要，章节删除级联清理摘要
    expect(sql).toContain('book_outlines_book_id_books_id_fk');
    expect(sql).toContain('knowledge_cards_book_id_books_id_fk');
    expect(sql).toContain('chapter_summaries_chapter_id_chapters_id_fk');
    expect(sql).toContain('chapter_summaries_book_id_books_id_fk');

    // 不定维向量列 + jsonb 默认空数组 + 来源默认 manual
    expect(sql).toContain('"embedding" vector');
    expect(sql).toContain('"aliases" jsonb DEFAULT \'[]\'::jsonb NOT NULL');
    expect(sql).toContain('"tags" jsonb DEFAULT \'[]\'::jsonb NOT NULL');
    expect(sql).toContain('"key_events" jsonb DEFAULT \'[]\'::jsonb NOT NULL');
    expect(sql).toContain('"characters_present" jsonb DEFAULT \'[]\'::jsonb NOT NULL');
    expect(sql).toContain('"source" text DEFAULT \'manual\' NOT NULL');
  });

  it('SQL 覆盖 Change 5 创作工具盒 toolbox_runs 表、3 个索引与 set null 外键', () => {
    const sql = readSql();

    expect(sql).toContain('CREATE TABLE "toolbox_runs"');

    // 索引：全局时间线、按书回看、按工具筛选
    for (const indexName of [
      'toolbox_runs_created_idx',
      'toolbox_runs_book_created_idx',
      'toolbox_runs_tool_created_idx',
    ]) {
      expect(sql).toContain(`CREATE INDEX "${indexName}"`);
    }
    expect(sql).toContain('("book_id","created_at")');
    expect(sql).toContain('("tool_id","created_at")');

    // 外键：删书后保留历史（ON DELETE SET NULL），不级联清理历史记录
    expect(sql).toContain('toolbox_runs_book_id_books_id_fk');
    expect(sql).toMatch(/toolbox_runs_book_id_books_id_fk[\s\S]*ON DELETE set null/);

    // 15 列：工具 / 角色 / 状态 / 归一输入 / 结构化产出 / 计量 / 脱敏错误摘要
    expect(sql).toContain('"tool_id" varchar(64) NOT NULL');
    expect(sql).toContain('"book_id" uuid');
    expect(sql).toContain('"role" varchar(32) NOT NULL');
    expect(sql).toContain('"status" varchar(16) NOT NULL');
    expect(sql).toContain('"inputs_json" jsonb NOT NULL');
    expect(sql).toContain('"output_json" jsonb');
    expect(sql).toContain('"model_ref" varchar(256)');
    expect(sql).toContain('"input_tokens" integer DEFAULT 0 NOT NULL');
    expect(sql).toContain('"output_tokens" integer DEFAULT 0 NOT NULL');
    expect(sql).toContain('"estimated_cost_usd" numeric(12, 6) DEFAULT \'0\' NOT NULL');
    expect(sql).toContain('"latency_ms" integer DEFAULT 0 NOT NULL');
    expect(sql).toContain('"error_code" varchar(64)');
    expect(sql).toContain('"error_message" text');
    expect(sql).toContain('"created_at" timestamp with time zone DEFAULT now() NOT NULL');
  });

  it('SQL 覆盖 Change 4 批量流水线 2 张表、索引与级联外键', () => {
    const sql = readSql();

    for (const table of ['workflow_runs', 'workflow_steps']) {
      expect(sql).toContain(`CREATE TABLE "${table}"`);
    }

    // 索引：按书 + 创建时间、按状态、run 内步骤唯一序号与状态筛选
    for (const indexName of [
      'workflow_runs_book_created_idx',
      'workflow_runs_status_idx',
      'workflow_steps_run_status_idx',
    ]) {
      expect(sql).toContain(`CREATE INDEX "${indexName}"`);
    }
    expect(sql).toContain('CREATE UNIQUE INDEX "workflow_steps_run_index_unique"');
    expect(sql).toContain('("run_id","step_index")');

    // 外键：书籍删除级联清理批次，批次 / 章节删除级联清理步骤
    expect(sql).toContain('workflow_runs_book_id_books_id_fk');
    expect(sql).toContain('workflow_steps_run_id_workflow_runs_id_fk');
    expect(sql).toContain('workflow_steps_chapter_id_chapters_id_fk');

    // 配置快照仅存 jsonb（严格 WorkflowRunConfig）、预算 numeric(12,6)、默认状态字面量
    expect(sql).toContain('"config_json" jsonb NOT NULL');
    expect(sql).toContain('"max_cost_usd" numeric(12, 6)');
    expect(sql).toContain('"spent_cost_usd" numeric(12, 6) DEFAULT \'0\' NOT NULL');
    expect(sql).toContain('"estimated_cost_usd" numeric(12, 6) DEFAULT \'0\' NOT NULL');
    expect(sql).toContain('"critic_issues_json" jsonb DEFAULT \'[]\'::jsonb NOT NULL');
    expect(sql).toContain('"status" text DEFAULT \'queued\' NOT NULL');
    expect(sql).toContain('"status" text DEFAULT \'pending\' NOT NULL');
    expect(sql).toContain('"stage" text DEFAULT \'idle\' NOT NULL');
    expect(sql).toContain('"pause_requested" boolean DEFAULT false NOT NULL');
    expect(sql).toContain('"cancel_requested" boolean DEFAULT false NOT NULL');
  });
});
