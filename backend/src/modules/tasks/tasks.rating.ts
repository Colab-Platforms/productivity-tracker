import { prisma } from "../../lib/prisma.js";
import { legacyStars } from "./tasks.rating.logic.js";

// ---------------------------------------------------------------------------
// TASK RATINGS (database side)
// The rating lives in its own table (task_ratings), one row per task. Batch reads only.
// A task graded the old way (daily_tasks.outcome) and not yet converted reads through to the equivalent stars
// (Completed 5, Partial 3, Failed 1), so a database that is half-way through the change never shows graded work as unrated.
// After the one-time conversion every such task has its own rating row and the old column is no longer needed.
// ---------------------------------------------------------------------------

const isMissingTable = (e: unknown) => {
  const code = (e as { code?: unknown })?.code;
  const msg = e instanceof Error ? e.message : "";
  return code === "P2021" || (/task_ratings/.test(msg) && /does not exist|relation/.test(msg));
};
let readyValue = false;
let readyCheckedAt = 0;
export async function ratingReady(): Promise<boolean> {
  if (readyValue) return true;
  if (Date.now() - readyCheckedAt < 15_000) return false;
  readyCheckedAt = Date.now();
  try {
    await prisma.taskRating.findFirst({ select: { taskId: true } });
    readyValue = true;
  } catch (e) {
    if (!isMissingTable(e)) throw e;
    readyValue = false;
  }
  return readyValue;
}

export type RatingInfo = { rating: number; comment: string | null; ratedById: string | null; ratedAt: Date | null };

/** taskId -> its rating. `outcome` (old grade) is only used as the read-through for tasks not converted yet. */
export async function ratingsFor(rows: { id: string; outcome?: unknown }[]): Promise<Map<string, RatingInfo>> {
  const out = new Map<string, RatingInfo>();
  if (rows.length === 0) return out;
  if (await ratingReady()) {
    const found = await prisma.taskRating.findMany({
      where: { taskId: { in: rows.map((r) => r.id) } },
      select: { taskId: true, rating: true, comment: true, ratedById: true, ratedAt: true },
    });
    for (const r of found) out.set(r.taskId, { rating: r.rating, comment: r.comment, ratedById: r.ratedById, ratedAt: r.ratedAt });
  }
  for (const r of rows) {
    if (out.has(r.id)) continue;
    const s = legacyStars(r.outcome == null ? null : String(r.outcome));
    if (s !== null) out.set(r.id, { rating: s, comment: null, ratedById: null, ratedAt: null });
  }
  return out;
}

export type WithRating<T> = T & { rating: number | null; ratingComment: string | null };

export async function withRatings<T extends { id: string; outcome?: unknown }>(rows: T[]): Promise<WithRating<T>[]> {
  const m = await ratingsFor(rows);
  return rows.map((r) => ({ ...r, rating: m.get(r.id)?.rating ?? null, ratingComment: m.get(r.id)?.comment ?? null }));
}

/** True when the manager has rated this task (or it carries an old grade that has not been converted yet). */
export async function isRated(task: { id: string; outcome?: unknown }): Promise<boolean> {
  return (await ratingsFor([task])).has(task.id);
}

/** Just the star number per task (reports and counts). */
export async function starsFor(rows: { id: string; outcome?: unknown }[]): Promise<Map<string, number>> {
  const m = await ratingsFor(rows);
  return new Map([...m].map(([k, v]) => [k, v.rating]));
}
