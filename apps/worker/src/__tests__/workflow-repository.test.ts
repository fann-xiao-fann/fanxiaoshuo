import { describe, expect, it } from 'vitest';
import type { Pool, QueryResultRow } from 'pg';
import { API_ERROR_CODES } from '@fanxiaoshuo/shared';
import { createPgWorkflowStore } from '../db/workflow-repository.js';

/**
 * PG 仓储单测：用内存 Fake `Pool` 校验 SQL 语句形态、参数绑定与行映射。
 *
 * 覆盖重点（Wave 4 与 Server Drizzle 迁移逐列对齐的关键缝隙）：
 * - `workflow_runs` / `workflow_steps` 的列名与顺序；
 * - `config_json` 过滤非配置字段（`chapterIds`）后仍能通过契约校验；
 * - `numeric` 字符串 → 有限数字、`timestamptz` → ISO 字符串；
 * - 留底快照必须先于正文更新（事务内顺序）；
 * - 阅读顺序展平与前情摘要切片。
 */

const RUN_ID = '11111111-1111-4111-8111-111111111111';
const BOOK_ID = '22222222-2222-4222-8222-222222222222';
const CHAPTER_ID = '33333333-3333-4333-8333-333333333333';
const STEP_ID = '44444444-4444-4444-8444-444444444444';
const REVISION_ID = '55555555-5555-4555-8555-555555555555';

interface SqlCall {
  readonly text: string;
  readonly values: readonly unknown[];
}

function normalizeSql(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function createFakePool(
  handler: (sql: string, values: readonly unknown[]) => readonly QueryResultRow[],
): { readonly pool: Pool; readonly calls: SqlCall[] } {
  const calls: SqlCall[] = [];
  const query = async (text: string, values: unknown[] = []): Promise<{ rows: QueryResultRow[] }> => {
    calls.push({ text, values });
    return { rows: [...handler(normalizeSql(text), values)] };
  };
  const client = { query, release: () => undefined };
  return {
    pool: { query, connect: async () => client } as unknown as Pool,
    calls,
  };
}

const RUN_ROW = {
  id: RUN_ID,
  book_id: BOOK_ID,
  book_title: '测试之书',
  mode: 'full_pipeline',
  status: 'queued',
  config_json: {
    enableCritic: true,
    minPassScore: 75,
    maxReworkRounds: 1,
    enableSummary: true,
    maxContextTokens: 8000,
    instruction: '',
    // 服务端 config 快照会额外内联 chapterIds，Worker 必须安全忽略而非报错
    chapterIds: [CHAPTER_ID],
  },
  total_steps: 2,
  completed_steps: 1,
  failed_steps: 0,
  max_cost_usd: '5.000000',
  spent_cost_usd: '0.120000',
  total_input_tokens: 1000,
  total_output_tokens: 2000,
  pause_requested: false,
  cancel_requested: false,
  pause_reason: null,
  error_code: null,
  error_message: null,
  started_at: new Date('2024-01-01T00:00:00.000Z'),
  finished_at: null,
};

const STEP_ROW = {
  id: STEP_ID,
  run_id: RUN_ID,
  chapter_id: CHAPTER_ID,
  step_index: 1,
  chapter_title_snapshot: '第2章 风云再起',
  status: 'pending',
  stage: 'idle',
  rework_count: 0,
  critic_score: null,
  backup_revision_id: null,
};

const TOTALS_ROW = {
  status: 'running',
  total_steps: 2,
  completed_steps: 1,
  failed_steps: 0,
  spent_cost_usd: '0.125000',
  max_cost_usd: '5.000000',
  total_input_tokens: 1100,
  total_output_tokens: 2200,
};

describe('createPgWorkflowStore', () => {
  it('loadRunWithSteps：解析 config_json、numeric 与时间列，步骤按 step_index 升序', async () => {
    const { pool, calls } = createFakePool((sql) => {
      if (sql.includes('FROM workflow_runs r')) return [RUN_ROW];
      if (sql.includes('FROM workflow_steps WHERE run_id')) return [STEP_ROW];
      return [];
    });
    const store = createPgWorkflowStore(pool);

    const loaded = await store.loadRunWithSteps(RUN_ID);

    expect(loaded?.run).toMatchObject({
      id: RUN_ID,
      bookId: BOOK_ID,
      bookTitle: '测试之书',
      mode: 'full_pipeline',
      status: 'queued',
      totalSteps: 2,
      completedSteps: 1,
      maxCostUsd: 5,
      spentCostUsd: 0.12,
      totalInputTokens: 1000,
      totalOutputTokens: 2000,
      startedAt: '2024-01-01T00:00:00.000Z',
      finishedAt: null,
    });
    expect(loaded?.run.config).toEqual({
      enableCritic: true,
      minPassScore: 75,
      maxReworkRounds: 1,
      enableSummary: true,
      maxContextTokens: 8000,
      instruction: '',
    });
    expect(loaded?.steps).toEqual([
      {
        id: STEP_ID,
        runId: RUN_ID,
        chapterId: CHAPTER_ID,
        stepIndex: 1,
        chapterTitleSnapshot: '第2章 风云再起',
        status: 'pending',
        stage: 'idle',
        reworkCount: 0,
        criticScore: null,
        backupRevisionId: null,
      },
    ]);
    expect(calls[1]?.text).toContain('ORDER BY step_index ASC');
  });

  it('readRunControlState：轻量读取暂停 / 取消 / 预算控制态', async () => {
    const { pool, calls } = createFakePool((sql) => {
      if (sql.includes('SELECT status, pause_requested')) {
        return [
          {
            status: 'running',
            pause_requested: true,
            cancel_requested: false,
            max_cost_usd: '1.500000',
            spent_cost_usd: '0.300000',
          },
        ];
      }
      return [];
    });
    const store = createPgWorkflowStore(pool);

    const control = await store.readRunControlState(RUN_ID);

    expect(control).toEqual({
      status: 'running',
      pauseRequested: true,
      cancelRequested: false,
      maxCostUsd: 1.5,
      spentCostUsd: 0.3,
    });
    expect(calls[0]?.values).toEqual([RUN_ID]);
  });

  it('markStepCompleted：事务内更新步骤并重算批次统计 / 累加费用与 Token', async () => {
    const { pool, calls } = createFakePool((sql) => {
      if (sql.startsWith('UPDATE workflow_runs SET completed_steps = ( SELECT count(*)')) {
        return [TOTALS_ROW];
      }
      return [];
    });
    const store = createPgWorkflowStore(pool);

    const totals = await store.markStepCompleted(RUN_ID, STEP_ID, {
      reworkCount: 1,
      criticScore: 88,
      criticPassed: true,
      criticSummary: '节奏紧凑',
      criticIssues: ['第 3 段拖沓'],
      outputWordCount: 1200,
      inputTokens: 100,
      outputTokens: 200,
      estimatedCostUsd: 0.005,
      backupRevisionId: REVISION_ID,
    });

    const normalized = calls.map((call) => normalizeSql(call.text));
    expect(normalized[0]).toBe('BEGIN');
    expect(normalized.at(-1)).toBe('COMMIT');
    expect(normalized.some((sql) => sql.startsWith("UPDATE workflow_steps SET status = 'completed'"))).toBe(true);

    const stepCall = calls.find((call) =>
      normalizeSql(call.text).startsWith("UPDATE workflow_steps SET status = 'completed'"),
    );
    expect(stepCall?.values).toEqual([
      STEP_ID,
      1,
      88,
      true,
      '节奏紧凑',
      JSON.stringify(['第 3 段拖沓']),
      1200,
      100,
      200,
      0.005,
      REVISION_ID,
    ]);

    const runCall = calls.find((call) =>
      normalizeSql(call.text).startsWith('UPDATE workflow_runs SET completed_steps = ( SELECT count(*)'),
    );
    expect(runCall?.values).toEqual([RUN_ID, 0.005, 100, 200]);
    expect(totals).toEqual({
      status: 'running',
      totalSteps: 2,
      completedSteps: 1,
      failedSteps: 0,
      spentCostUsd: 0.125,
      maxCostUsd: 5,
      totalInputTokens: 1100,
      totalOutputTokens: 2200,
    });
  });

  it('markStepFailed / resetStepToPending：保留已耗用量累加到批次账本', async () => {
    const { pool, calls } = createFakePool((sql) => {
      if (sql.startsWith('UPDATE workflow_runs SET completed_steps = ( SELECT count(*)')) {
        return [{ ...TOTALS_ROW, status: 'failed', failed_steps: 1 }];
      }
      if (sql.startsWith('UPDATE workflow_runs r SET')) {
        return [{ ...TOTALS_ROW, spent_cost_usd: '0.124000' }];
      }
      return [];
    });
    const store = createPgWorkflowStore(pool);

    const failed = await store.markStepFailed(RUN_ID, STEP_ID, {
      errorCode: API_ERROR_CODES.UPSTREAM_ERROR,
      errorMessage: '上游 500',
      inputTokens: 10,
      outputTokens: 20,
      estimatedCostUsd: 0.001,
    });
    expect(failed.status).toBe('failed');
    expect(failed.failedSteps).toBe(1);

    await store.resetStepToPending(STEP_ID, {
      inputTokens: 40,
      outputTokens: 60,
      estimatedCostUsd: 0.004,
    });

    const resetCall = calls.find((call) => normalizeSql(call.text).startsWith('WITH target_step AS'));
    expect(resetCall?.text).toContain("status = 'pending'");
    expect(resetCall?.text).toContain("stage = 'idle'");
    expect(resetCall?.values).toEqual([STEP_ID, 0.004, 40, 60]);
  });

  it('markRunCancelled：单事务把剩余步骤置 skipped 并收敛批次状态', async () => {
    const { pool, calls } = createFakePool((sql) => {
      if (sql.startsWith("UPDATE workflow_runs SET status = 'cancelled'")) {
        return [{ ...TOTALS_ROW, status: 'cancelled' }];
      }
      return [];
    });
    const store = createPgWorkflowStore(pool);

    const totals = await store.markRunCancelled(RUN_ID);

    expect(totals.status).toBe('cancelled');
    const normalized = calls.map((call) => normalizeSql(call.text));
    expect(normalized[0]).toBe('BEGIN');
    expect(normalized.at(-1)).toBe('COMMIT');
    expect(
      normalized.some(
        (sql) => sql.startsWith('UPDATE workflow_steps SET status = \'skipped\'') && sql.includes("status IN ('pending', 'running')"),
      ),
    ).toBe(true);
    expect(normalized.some((sql) => sql.startsWith("UPDATE workflow_runs SET status = 'cancelled'"))).toBe(true);
  });

  it('markRunFinished：重算 completed / failed 步骤数并落盘错误信息', async () => {
    const { pool, calls } = createFakePool((sql) => {
      if (sql.startsWith('UPDATE workflow_runs SET completed_steps = ( SELECT count(*)')) {
        return [{ ...TOTALS_ROW, status: 'failed', failed_steps: 2 }];
      }
      return [];
    });
    const store = createPgWorkflowStore(pool);

    const totals = await store.markRunFinished(RUN_ID, 'failed', {
      code: API_ERROR_CODES.UPSTREAM_TIMEOUT,
      message: '上游超时',
    });

    expect(totals).toMatchObject({ status: 'failed', failedSteps: 2 });
    expect(calls[0]?.values).toEqual([
      RUN_ID,
      'failed',
      API_ERROR_CODES.UPSTREAM_TIMEOUT,
      '上游超时',
    ]);
  });

  it('persistChapterWorkflowOutputs：先插 source=ai 留底快照再写正文与摘要', async () => {
    const { pool, calls } = createFakePool((sql) => {
      if (sql.includes('FROM chapters') && sql.includes('FOR UPDATE')) {
        return [
          {
            id: CHAPTER_ID,
            title: '第1章 初入江湖',
            content_text: '旧正文',
            content_json: null,
            word_count: 800,
            version: 3,
            status: 'outline',
          },
        ];
      }
      if (sql.startsWith('INSERT INTO chapter_revisions')) {
        return [{ id: REVISION_ID }];
      }
      return [];
    });
    const store = createPgWorkflowStore(pool);

    const result = await store.persistChapterWorkflowOutputs({
      bookId: BOOK_ID,
      chapterId: CHAPTER_ID,
      plannedOutline: '本章细纲',
      contentText: '新正文',
      outputWordCount: 1200,
      enableCritic: true,
      extractedSummary: {
        summary: '本章摘要',
        keyEvents: ['事件一'],
        charactersPresent: ['主角'],
      },
      mode: 'full_pipeline',
    });

    expect(result.backupRevisionId).toBe(REVISION_ID);

    const normalized = calls.map((call) => normalizeSql(call.text));
    expect(normalized[0]).toBe('BEGIN');
    expect(normalized.at(-1)).toBe('COMMIT');

    const revisionIndex = normalized.findIndex((sql) => sql.startsWith('INSERT INTO chapter_revisions'));
    const updateIndex = normalized.findIndex((sql) => sql.startsWith('UPDATE chapters SET'));
    expect(revisionIndex).toBeGreaterThan(-1);
    expect(updateIndex).toBeGreaterThan(revisionIndex);

    const revisionCall = calls[revisionIndex];
    expect(revisionCall?.text).toContain("'ai'");
    expect(revisionCall?.values[2]).toBe('批量流水线写入前自动留底');
    expect(revisionCall?.values).toEqual([
      CHAPTER_ID,
      3,
      '批量流水线写入前自动留底',
      '第1章 初入江湖',
      '旧正文',
      null,
      800,
    ]);

    const updateCall = calls[updateIndex];
    expect(updateCall?.text).toContain('content_json = NULL');
    expect(updateCall?.text).toContain('version = version + 1');
    expect(updateCall?.values).toEqual([CHAPTER_ID, '新正文', 1200, 'reviewing']);

    const summaryCall = calls.find((call) => normalizeSql(call.text).startsWith('INSERT INTO chapter_summaries'));
    expect(summaryCall?.values).toEqual([
      CHAPTER_ID,
      BOOK_ID,
      '本章细纲',
      '本章摘要',
      JSON.stringify(['事件一']),
      JSON.stringify(['主角']),
      'ai',
      true,
      true,
    ]);
  });

  it('loadChapterContextData：按卷 / 章 sort_order 展平阅读顺序，切片前序摘要与紧邻上一章', async () => {
    const volumes = [
      { id: 'v1', sort_order: 0 },
      { id: 'v2', sort_order: 1 },
    ];
    const chapters = [
      // 故意乱序：期望展平为 B(v1,sort0) → A(v1,sort1) → C(v2,sort0) → D(未分卷)
      { id: 'a', title: '第A章', volume_id: 'v1', sort_order: 1, content_text: '正文A', status: 'draft' },
      { id: 'd', title: '第D章', volume_id: null, sort_order: 0, content_text: '', status: 'draft' },
      { id: 'c', title: '第C章', volume_id: 'v2', sort_order: 0, content_text: '', status: 'outline' },
      { id: 'b', title: '第B章', volume_id: 'v1', sort_order: 0, content_text: '正文B', status: 'draft' },
    ];
    const summaries = [
      { chapter_id: 'a', outline: '', summary: '摘要A', key_events: ['事件A'] },
      { chapter_id: 'b', outline: '', summary: '摘要B', key_events: [] },
      { chapter_id: 'c', outline: '细纲C', summary: '', key_events: [] },
    ];

    const { pool } = createFakePool((sql) => {
      if (sql.startsWith('SELECT title, genre, synopsis, target_chapter_words FROM books')) {
        return [
          {
            title: '测试之书',
            genre: '玄幻',
            synopsis: '简介',
            target_chapter_words: 3000,
          },
        ];
      }
      if (sql.startsWith('SELECT main_plot')) {
        return [{ main_plot: '主线', world_setting: '世界', style_guide: '文风', ending_plan: '结局' }];
      }
      if (sql.startsWith('SELECT id, category')) {
        return [
          {
            id: 'card-1',
            category: 'character',
            title: '主角',
            summary: '设定摘要',
            content: '设定正文',
            aliases: ['小凡'],
            tags: ['主角'],
            pinned: true,
            sort_order: 0,
            embedding: '[0.1,0.2]',
          },
        ];
      }
      if (sql.startsWith('SELECT id, sort_order FROM volumes')) return volumes;
      if (sql.startsWith('SELECT id, title, volume_id')) return chapters;
      if (sql.startsWith('SELECT chapter_id, outline, summary')) return summaries;
      return [];
    });
    const store = createPgWorkflowStore(pool);

    const context = await store.loadChapterContextData(BOOK_ID, 'c');

    expect(context.book).toEqual({
      title: '测试之书',
      genre: '玄幻',
      synopsis: '简介',
      targetChapterWords: 3000,
    });
    expect(context.bookOutline).toEqual({
      mainPlot: '主线',
      worldSetting: '世界',
      styleGuide: '文风',
      endingPlan: '结局',
    });
    expect(context.cards).toEqual([
      {
        id: 'card-1',
        category: 'character',
        title: '主角',
        summary: '设定摘要',
        content: '设定正文',
        aliases: ['小凡'],
        tags: ['主角'],
        pinned: true,
        sortOrder: 0,
        embedding: [0.1, 0.2],
      },
    ]);
    // 前序摘要按旧 → 新：B → A
    expect(context.recentSummaries).toEqual([
      { chapterTitle: '第B章', summary: '摘要B', keyEvents: [] },
      { chapterTitle: '第A章', summary: '摘要A', keyEvents: ['事件A'] },
    ]);
    // 紧邻上一章为 A 的完整正文
    expect(context.prevChapter).toEqual({ title: '第A章', contentText: '正文A' });
    expect(context.chapter).toEqual({
      id: 'c',
      title: '第C章',
      contentText: '',
      outline: '细纲C',
    });
  });

  it('loadChapterContextData：目标章节不存在时映射 CHAPTER_NOT_FOUND', async () => {
    const { pool } = createFakePool((sql) => {
      if (sql.startsWith('SELECT title, genre, synopsis, target_chapter_words FROM books')) {
        return [{ title: '测试之书', genre: '', synopsis: '', target_chapter_words: 3000 }];
      }
      if (sql.startsWith('SELECT id, sort_order FROM volumes')) return [];
      if (sql.startsWith('SELECT id, title, volume_id')) return [];
      return [];
    });
    const store = createPgWorkflowStore(pool);

    await expect(store.loadChapterContextData(BOOK_ID, CHAPTER_ID)).rejects.toMatchObject({
      code: API_ERROR_CODES.CHAPTER_NOT_FOUND,
    });
  });
});
