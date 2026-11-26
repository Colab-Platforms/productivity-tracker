import { prisma } from "../../lib/prisma.js";
import { auditNote } from "../../lib/auditContext.js";
import { clientIp } from "../../lib/clientIp.js";
import type { PerformanceStatus } from "./tasks.weighted.js";

// ---------------------------------------------------------------------------
// MANAGER EVALUATION: a manager may adjust one employee's Overall Performance Score, Evaluation Status and Productivity % for ONE report period.
//
// Storage (owner's choice, no migration): the immutable audit log. Each adjustment is one audit row (module "Evaluation", recordType
// "EvaluationAdjustment", targetUserId = the employee). `before` = what the system calculated, `after` = the period, the adjusted values and the
// reason. The LATEST row for an employee + exact period is the effective adjustment; a later row replaces it, and a row with every value null
// is a "reset to system values". The system calculation (weightedPerformance, productivity %) is never touched: this only overlays it for display.
// Statuses are the four that already exist (No tasks, Awaiting evaluation, Provisional, Final).
// ---------------------------------------------------------------------------

export const STATUSES: PerformanceStatus[] = ["NO_TASKS", "AWAITING_EVALUATION", "PROVISIONAL", "FINAL"];
export const MODULE = "Evaluation";
export const RECORD = "EvaluationAdjustment";

export type Adjustment = {
  userId: string;
  from: string;
  to: string;
  score: number | null; // null = the system value is used
  status: PerformanceStatus | null;
  productivity: number | null;
  reason: string;
  byId: string | null;
  at: string;
  original: { score: number | null; status: PerformanceStatus | null; productivity: number | null };
};

type Row = { uid: string; after: any; before: any; actor: string | null; at: Date };
const toAdj = (r: Row): Adjustment => ({
  userId: r.uid,
  from: String(r.after?.from ?? ""),
  to: String(r.after?.to ?? ""),
  score: r.after?.score ?? null,
  status: r.after?.status ?? null,
  productivity: r.after?.productivity ?? null,
  reason: String(r.after?.reason ?? ""),
  byId: r.actor,
  at: r.at.toISOString(),
  original: { score: r.before?.score ?? null, status: r.before?.status ?? null, productivity: r.before?.productivity ?? null },
});

/** The effective adjustment per person for exactly this period (a row with nothing adjusted counts as no adjustment). Never throws: a failure means no overlay. */
export async function adjustmentsFor(userIds: string[], from: string, to: string): Promise<Map<string, Adjustment>> {
  const out = new Map<string, Adjustment>();
  if (userIds.length === 0) return out;
  try {
    const rows = await prisma.$queryRaw<Row[]>`
      select distinct on ("targetUserId") "targetUserId"::text as uid, after, before, "actorId"::text as actor, "createdAt" as at
      from audit_logs
      where module = ${MODULE} and "recordType" = ${RECORD} and "targetUserId" = any(${userIds}::uuid[])
        and after->>'from' = ${from} and after->>'to' = ${to}
      order by "targetUserId", "createdAt" desc`;
    for (const r of rows) {
      const a = toAdj(r);
      if (a.score !== null || a.status !== null || a.productivity !== null) out.set(r.uid, a);
    }
  } catch (e) {
    console.error("[evaluation] could not read adjustments:", e);
  }
  return out;
}

type W = { percent: number | null; status: PerformanceStatus; provisional: boolean; [k: string]: unknown };
/** The weighted object with the manager's values as the effective ones; the system values stay beside them. */
export function overlayWeighted<T extends W>(w: T, a: Adjustment | undefined): T & { adjusted?: Record<string, unknown> } {
  if (!a || (a.score === null && a.status === null)) return w;
  const status = a.status ?? w.status;
  return {
    ...w,
    percent: a.score ?? w.percent,
    status,
    provisional: status === "PROVISIONAL",
    adjusted: { by: a.byId, at: a.at, reason: a.reason, original: { percent: w.percent, status: w.status } },
  };
}

export type ManagerInput = { userId: unknown; from: unknown; to: unknown; score: unknown; status: unknown; productivity: unknown; reason: unknown };

const num = (v: unknown, label: string): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 100) throw new Error(label === "score" ? "EVAL_BAD_SCORE" : "EVAL_BAD_PRODUCTIVITY");
  return Math.round(n * 100) / 100;
};

/**
 * Save one adjustment. `current` = the SYSTEM values for the person and period (computed by the caller, who also proves the person is in the
 * manager's scope), so the original is always the calculated one, never a previous adjustment.
 */
export async function saveAdjustment(
  actor: { id: string; platformId: string; ip?: string | null },
  target: { userId: string; platformId: string; name: string; from: string; to: string; current: { score: number | null; status: PerformanceStatus; productivity: number | null } },
  input: ManagerInput
): Promise<Adjustment> {
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (reason.length < 5) throw new Error("EVAL_REASON_REQUIRED");
  if (reason.length > 300) throw new Error("EVAL_REASON_TOO_LONG");
  let status: PerformanceStatus | null = null;
  if (input.status !== null && input.status !== undefined && input.status !== "") {
    if (!STATUSES.includes(input.status as PerformanceStatus)) throw new Error("EVAL_BAD_STATUS");
    status = input.status as PerformanceStatus;
  }
  let score = num(input.score, "score");
  let productivity = num(input.productivity, "productivity");
  // only a value that DIFFERS from the system value is an adjustment; sending the system value back means "use the system value"
  if (score !== null && target.current.score !== null && Math.abs(score - target.current.score) < 0.005) score = null;
  if (productivity !== null && target.current.productivity !== null && Math.abs(productivity - target.current.productivity) < 0.005) productivity = null;
  if (status !== null && status === target.current.status) status = null;

  const before = { score: target.current.score, status: target.current.status, productivity: target.current.productivity };
  const after = { from: target.from, to: target.to, score, status, productivity, reason };
  const reset = score === null && status === null && productivity === null;
  const row = await prisma.auditLog.create({
    data: {
      platformId: target.platformId,
      actorId: actor.id,
      method: "POST",
      path: "/api/team-attendance/evaluation",
      status: 200,
      module: MODULE,
      action: "UPDATE",
      recordType: RECORD,
      recordId: `${target.userId}:${target.from}:${target.to}`,
      targetUserId: target.userId,
      summary: reset ? `Saved ${target.name}'s evaluation with the system values (${target.from} to ${target.to})` : `Adjusted ${target.name}'s evaluation (${target.from} to ${target.to})`,
      before: before as never,
      after: after as never,
      ip: actor.ip ?? null,
    } as never,
  });
  auditNote({ skip: true }); // this row is the audit entry; the request middleware must not write a second one
  return toAdj({ uid: target.userId, after, before, actor: actor.id, at: row.createdAt });
}

export type HistoryEntry = { at: string; by: string | null; byName: string; reason: string; before: Adjustment["original"]; after: { score: number | null; status: string | null; productivity: number | null }; from: string; to: string };
/** Every adjustment of one person for one period, newest first (the original, the new value, who, when, why). */
export async function historyFor(userId: string, from: string, to: string): Promise<HistoryEntry[]> {
  const rows = await prisma.$queryRaw<{ before: any; after: any; actor: string | null; at: Date; first: string | null; last: string | null }[]>`
    select a.before, a.after, a."actorId"::text as actor, a."createdAt" as at, u."firstName" as first, u."lastName" as last
    from audit_logs a left join users u on u.id = a."actorId"
    where a.module = ${MODULE} and a."recordType" = ${RECORD} and a."targetUserId" = ${userId}::uuid and a.after->>'from' = ${from} and a.after->>'to' = ${to}
    order by a."createdAt" desc limit 100`;
  return rows.map((r) => ({
    at: r.at.toISOString(),
    by: r.actor,
    byName: `${r.first ?? ""} ${r.last ?? ""}`.trim() || "Unknown",
    reason: String(r.after?.reason ?? ""),
    before: { score: r.before?.score ?? null, status: r.before?.status ?? null, productivity: r.before?.productivity ?? null },
    after: { score: r.after?.score ?? null, status: r.after?.status ?? null, productivity: r.after?.productivity ?? null },
    from, to,
  }));
}

export { clientIp };

// ---------------------------------------------------------------------------
// WHETHER THE MANAGER HAS EVALUATED (separate from whether values were changed): derived from the same audit rows.
//   no saved row for this person and period   = NOT_EVALUATED
//   exactly one saved row                      = EVALUATED  (the manager reviewed it and saved, with or without changing a value)
//   two or more saved rows                     = UPDATED    (an earlier evaluation was modified; includes a reset to the system values)
// ---------------------------------------------------------------------------
export type EvalState = "NOT_EVALUATED" | "EVALUATED" | "UPDATED";
export type EvalStateInfo = { state: EvalState; count: number; lastAt: string | null; lastById: string | null; lastByName: string | null };
export async function evaluationStatesFor(userIds: string[], from: string, to: string): Promise<Map<string, EvalStateInfo>> {
  const out = new Map<string, EvalStateInfo>();
  if (userIds.length === 0) return out;
  try {
    const rows = await prisma.$queryRaw<{ uid: string; n: number; at: Date; actor: string | null; first: string | null; last: string | null }[]>`
      select a."targetUserId"::text as uid, count(*) over (partition by a."targetUserId")::int as n, a."createdAt" as at, a."actorId"::text as actor, u."firstName" as first, u."lastName" as last,
             row_number() over (partition by a."targetUserId" order by a."createdAt" desc) as rn
      from audit_logs a left join users u on u.id = a."actorId"
      where a.module = ${MODULE} and a."recordType" = ${RECORD} and a."targetUserId" = any(${userIds}::uuid[]) and a.after->>'from' = ${from} and a.after->>'to' = ${to}`.then((r) => (r as any[]).filter((x) => Number(x.rn) === 1));
    for (const r of rows) out.set(r.uid, { state: r.n >= 2 ? "UPDATED" : "EVALUATED", count: r.n, lastAt: r.at.toISOString(), lastById: r.actor, lastByName: `${r.first ?? ""} ${r.last ?? ""}`.trim() || null });
  } catch (e) {
    console.error("[evaluation] could not read states:", e);
  }
  return out;
}
