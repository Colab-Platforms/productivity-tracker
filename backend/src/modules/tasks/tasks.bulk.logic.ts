// Quick Add (several tasks at once): rules that need no database. Pure, so they can be tested on their own.

export const MAX_BULK_ROWS = 20; // tasks per "Submit all"
export const MAX_DRAFT_ROWS = 30; // rows kept in a person's draft sheet

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WEIGHTS = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];
const PROGRESS = ["TODO", "IN_PROGRESS", "COMPLETED", "BLOCKED"];

export type DraftRow = {
  title: string;
  description: string | null;
  teamId: string | null;
  taggedManagerId: string | null;
  hoursSpent: number | null;
  weight: string;
  progress: string;
};

const asUuid = (v: unknown): string | null => (typeof v === "string" && UUID.test(v.trim()) ? v.trim().toLowerCase() : null);

/** One draft row, made safe: wrong types are dropped, never trusted. A draft may be incomplete, so nothing here is "required". */
export function cleanDraftRow(raw: unknown): DraftRow {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const title = typeof r.title === "string" ? r.title.slice(0, 200) : "";
  const description = typeof r.description === "string" && r.description.trim() ? r.description.slice(0, 2000) : null;
  const hoursNum = typeof r.hoursSpent === "number" ? r.hoursSpent : typeof r.hoursSpent === "string" && r.hoursSpent.trim() !== "" ? Number(r.hoursSpent) : NaN;
  const hoursSpent = Number.isFinite(hoursNum) && hoursNum >= 0 && hoursNum <= 24 ? Math.round(hoursNum * 100) / 100 : null;
  return {
    title,
    description,
    teamId: asUuid(r.teamId ?? r.projectId),
    taggedManagerId: asUuid(r.taggedManagerId),
    hoursSpent,
    weight: typeof r.weight === "string" && WEIGHTS.includes(r.weight) ? r.weight : "MEDIUM",
    progress: typeof r.progress === "string" && PROGRESS.includes(r.progress) ? r.progress : "IN_PROGRESS",
  };
}

/** The draft sheet to store. Rows that are completely empty are not worth saving. More than the limit is refused, never silently cut. */
export function cleanDraftRows(raw: unknown): DraftRow[] {
  if (!Array.isArray(raw)) throw new Error("BAD_ROWS");
  if (raw.length > MAX_DRAFT_ROWS) throw new Error("TOO_MANY_ROWS");
  return raw.map(cleanDraftRow).filter((r) => r.title.trim() || r.description || r.teamId || r.taggedManagerId || r.hoursSpent !== null);
}

/** The rows of a "Submit all" request: 1 to the limit, each kept exactly as sent (the existing single-task rules judge every field). */
export function bulkRows(raw: unknown): { key: string; body: Record<string, unknown> }[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error("NO_ROWS");
  if (raw.length > MAX_BULK_ROWS) throw new Error("TOO_MANY_ROWS");
  return raw.map((r, i) => {
    const o = (r && typeof r === "object" ? r : {}) as Record<string, unknown>;
    const key = typeof o.key === "string" && o.key.length <= 64 ? o.key : String(i);
    return { key, body: o };
  });
}

/** What makes two tasks "the same one sent twice": the same words (case and spacing ignored), project and manager. */
export function sameTaskKey(t: { title: string; teamId: string | null; taggedManagerId: string | null }): string {
  return [t.title.trim().replace(/\s+/g, " ").toLowerCase(), t.teamId ?? "", t.taggedManagerId ?? ""].join("|");
}

export type RowResult = { key: string; ok: boolean; taskId?: string; code?: string };

export function summarize(results: RowResult[]) {
  const submitted = results.filter((r) => r.ok).length;
  return { total: results.length, submitted, failed: results.length - submitted };
}
