// EVIDENCE for the Work Efficiency Index (migration 20261124130000_efficiency_evidence, new tables only):
//   task_review_attempts  every return of a Completed task, with WHY (quality / the requirement changed)
//   task_partial_progress the manager-verified progress % and milestone behind a "partially completed" mark
//   task_time_reviews     the time the tagged manager confirmed as reasonable (the expected time the automatic timer is compared with)
// Before the migration none of these exist: writes that need them answer FEATURES_NOT_READY only where the new evidence is required, reads return nothing.
import { prisma } from "../../lib/prisma.js";

let ready: boolean | null = null;
let checkedAt = 0;
let checking: Promise<boolean> | null = null;
export async function evidenceReady(): Promise<boolean> {
  if (ready === true) return true;
  if (checking) return checking;
  if (ready === false && Date.now() - checkedAt < 15_000) return false;
  checking = (async () => {
    try {
      const r = await prisma.$queryRaw<{ n: number }[]>`select count(*)::int n from pg_class where relkind = 'r' and relname in ('task_review_attempts', 'task_partial_progress', 'task_time_reviews')`;
      ready = (r[0]?.n ?? 0) === 3;
    } catch { ready = false; }
    checkedAt = Date.now();
    return ready;
  })().finally(() => { checking = null; });
  return checking;
}

export type RevertKind = "QUALITY" | "REQUIREMENT_CHANGE";
export const REVERT_KINDS: RevertKind[] = ["QUALITY", "REQUIREMENT_CHANGE"];
export const REVERT_KIND_LABEL: Record<RevertKind, string> = { QUALITY: "Quality problem (rework needed)", REQUIREMENT_CHANGE: "Requirement changed" };

export function parseRevertKind(v: unknown): RevertKind | null {
  return REVERT_KINDS.includes(v as RevertKind) ? (v as RevertKind) : null;
}
/** Verified partial progress: a whole percent 1-99 and a milestone note of at least 3 characters. */
export function parsePartialProgress(percent: unknown, milestone: unknown): { percent: number; milestone: string } | null {
  const p = typeof percent === "number" ? percent : Number(percent);
  const m = typeof milestone === "string" ? milestone.trim() : "";
  if (!Number.isInteger(p) || p < 1 || p > 99 || m.length < 3 || m.length > 300) return null;
  return { percent: p, milestone: m };
}
/** Minutes the manager confirms (1 minute to 24 hours), stored as seconds. */
export function parseExpectedMinutes(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n < 1 || n > 1440) return null;
  return Math.round(n * 60);
}

export async function recordRevertAttempt(a: { taskId: string; platformId: string; kind: RevertKind; revertType: string; remark: string; byId: string }): Promise<void> {
  if (!(await evidenceReady())) return;
  await prisma.$executeRaw`insert into task_review_attempts ("taskId", "platformId", "kind", "revertType", "remark", "byId") values (${a.taskId}::uuid, ${a.platformId}::uuid, ${a.kind}, ${a.revertType}, ${a.remark}, ${a.byId}::uuid)`;
}
export async function savePartialProgress(taskId: string, byId: string, p: { percent: number; milestone: string }): Promise<void> {
  await prisma.$executeRaw`insert into task_partial_progress ("taskId", "percent", "milestone", "verifiedById", "verifiedAt") values (${taskId}::uuid, ${p.percent}, ${p.milestone}, ${byId}::uuid, now())
    on conflict ("taskId") do update set "percent" = excluded."percent", "milestone" = excluded."milestone", "verifiedById" = excluded."verifiedById", "verifiedAt" = now()`;
}
export async function clearPartialProgress(taskId: string): Promise<void> {
  if (!(await evidenceReady())) return;
  await prisma.$executeRaw`delete from task_partial_progress where "taskId" = ${taskId}::uuid`;
}
export async function saveTimeReview(taskId: string, byId: string, expectedSeconds: number, note: string | null): Promise<void> {
  await prisma.$executeRaw`insert into task_time_reviews ("taskId", "expectedSeconds", "note", "reviewedById", "reviewedAt") values (${taskId}::uuid, ${expectedSeconds}, ${note}, ${byId}::uuid, now())
    on conflict ("taskId") do update set "expectedSeconds" = excluded."expectedSeconds", "note" = excluded."note", "reviewedById" = excluded."reviewedById", "reviewedAt" = now()`;
}

export type Evidence = {
  quality: Map<string, number>;
  requirement: Map<string, number>;
  /** older returns recorded only in the audit log (no reason): never counted, only flagged */
  unclassified: Map<string, number>;
  partial: Map<string, { percent: number; milestone: string }>;
  expected: Map<string, number>;
};
/** All the evidence for these tasks, in four batched reads. Every read tolerates a missing table. */
export async function readEvidence(taskIds: string[]): Promise<Evidence> {
  const out: Evidence = { quality: new Map(), requirement: new Map(), unclassified: new Map(), partial: new Map(), expected: new Map() };
  if (taskIds.length === 0) return out;
  const ids = taskIds;
  const ready2 = await evidenceReady();
  const audits = await prisma.$queryRaw<{ id: string; n: number }[]>`select "recordId" as id, count(*)::int n from audit_logs where "recordType" = 'Task' and "summary" like 'Reopened task%' and "recordId" = any(${ids}::text[]) group by 1`.catch(() => []);
  const classified = new Map<string, number>();
  if (ready2) {
    const [att, part, time] = await Promise.all([
      prisma.$queryRaw<{ id: string; kind: string; n: number }[]>`select "taskId"::text as id, "kind", count(*)::int n from task_review_attempts where "taskId" = any(${ids}::uuid[]) group by 1, 2`,
      prisma.$queryRaw<{ id: string; percent: number; milestone: string }[]>`select "taskId"::text as id, "percent", "milestone" from task_partial_progress where "taskId" = any(${ids}::uuid[])`,
      prisma.$queryRaw<{ id: string; s: number }[]>`select "taskId"::text as id, "expectedSeconds" as s from task_time_reviews where "taskId" = any(${ids}::uuid[])`,
    ]);
    for (const r of att) { (r.kind === "QUALITY" ? out.quality : out.requirement).set(r.id, r.n); classified.set(r.id, (classified.get(r.id) ?? 0) + r.n); }
    for (const r of part) out.partial.set(r.id, { percent: r.percent, milestone: r.milestone });
    for (const r of time) out.expected.set(r.id, r.s);
  }
  for (const a of audits) { const un = a.n - (classified.get(a.id) ?? 0); if (un > 0) out.unclassified.set(a.id, un); }
  return out;
}

/** The manager-confirmed "reasonable time" per task and WHEN it was set. It is only ever set while rating, i.e. after the work was finished, so it is labelled a post-completion estimate. */
export async function timeReviewsFor(taskIds: string[]): Promise<Map<string, { expectedSeconds: number; reviewedAt: string }>> {
  const out = new Map<string, { expectedSeconds: number; reviewedAt: string }>();
  if (taskIds.length === 0 || !(await evidenceReady())) return out;
  const rows = await prisma.$queryRaw<{ id: string; s: number; at: string }[]>`select "taskId"::text as id, "expectedSeconds" as s, to_char("reviewedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as at from task_time_reviews where "taskId" = any(${taskIds}::uuid[])`.catch(() => []);
  for (const r of rows) out.set(r.id, { expectedSeconds: r.s, reviewedAt: r.at });
  return out;
}
