import { eq } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { bookOutlines } from '../../db/schema.js';
import { mapBookOutlineRow } from '../../mapping/rows.js';
import type {
  BookOutlineRepository,
  UpsertBookOutlineRecordInput,
} from '../types.js';

/** Drizzle 实现的全书总大纲仓储（1:1 绑定书籍，整段覆盖写入）。 */
export function createDrizzleBookOutlineRepository(db: Database): BookOutlineRepository {
  return {
    async findByBookId(bookId) {
      const [row] = await db
        .select()
        .from(bookOutlines)
        .where(eq(bookOutlines.bookId, bookId))
        .limit(1);
      return row ? mapBookOutlineRow(row) : null;
    },

    async upsert(input: UpsertBookOutlineRecordInput) {
      const updatedAt = new Date();
      const [row] = await db
        .insert(bookOutlines)
        .values({
          bookId: input.bookId,
          mainPlot: input.mainPlot,
          worldSetting: input.worldSetting,
          styleGuide: input.styleGuide,
          endingPlan: input.endingPlan,
          updatedAt,
        })
        .onConflictDoUpdate({
          target: bookOutlines.bookId,
          set: {
            mainPlot: input.mainPlot,
            worldSetting: input.worldSetting,
            styleGuide: input.styleGuide,
            endingPlan: input.endingPlan,
            updatedAt,
          },
        })
        .returning();

      if (!row) {
        throw new Error('全书总大纲保存失败：数据库未返回记录。');
      }
      return mapBookOutlineRow(row);
    },
  };
}
