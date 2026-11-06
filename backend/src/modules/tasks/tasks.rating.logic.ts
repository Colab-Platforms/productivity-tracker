// Task star ratings: the pure rules. No database. EVERY screen and report goes through these functions, so how a star counts
// is decided in exactly one place.

export const MIN_STARS = 1;
export const MAX_STARS = 5;
export const COMMENT_MAX = 300;

/** A finished task counts as "completed" in task counts when it is unrated or rated at least this many stars. */
export const COMPLETED_MIN_STARS = 4;

/** Old grade -> stars, used only by the one-time conversion of tasks graded before star ratings existed. */
export const LEGACY_OUTCOME_STARS: Record<string, number> = { COMPLETED: 5, PARTIALLY_COMPLETED: 3, FAILED: 1 };

export function parseRating(v: unknown): number | null {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isInteger(n) && n >= MIN_STARS && n <= MAX_STARS ? n : null;
}

/** Optional comment, trimmed. Returns the text (null = none) or an error code. */
export function checkComment(v: unknown): { text: string | null } | { error: "COMMENT_TOO_LONG" } {
  const t = String(v ?? "").trim();
  if (t.length > COMMENT_MAX) return { error: "COMMENT_TOO_LONG" };
  return { text: t.length ? t : null };
}

/** Share of a task's weight that is earned. Unrated finished task = full credit (as "ungraded" always was). */
export const creditOf = (rating: number | null | undefined) => (rating == null ? 1 : rating / MAX_STARS);

/** Finished and accepted: unrated, or rated at the completed threshold or above. */
export const isCompleteRating = (rating: number | null | undefined) => rating == null || rating >= COMPLETED_MIN_STARS;

export const legacyStars = (outcome: unknown): number | null => (typeof outcome === "string" ? (LEGACY_OUTCOME_STARS[outcome] ?? null) : null);

export const STAR_LABEL: Record<number, string> = { 1: "Poor", 2: "Needs improvement", 3: "Good", 4: "Very good", 5: "Excellent" };
