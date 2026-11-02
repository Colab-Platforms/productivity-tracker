import { prisma } from "../../lib/prisma.js";
import { hrGate, pickApprovers } from "./managerStep.logic.js";

// ---------------------------------------------------------------------------
// MANAGER STEP (database side) for leave and attendance corrections.
// Before the migration (no request_approvals table) every function here does nothing and every request goes straight to HR.
// ---------------------------------------------------------------------------

export type Kind = "LEAVE" | "CORRECTION";

const isMissingTable = (e: unknown) => {
  const code = (e as { code?: unknown })?.code;
  const msg = e instanceof Error ? e.message : "";
  return code === "P2021" || (/request_approvals/.test(msg) && /does not exist|relation/.test(msg));
};

let readyValue = false;
let readyCheckedAt = 0;
export async function approvalsReady(): Promise<boolean> {
  if (readyValue) return true;
  if (Date.now() - readyCheckedAt < 15_000) return false;
  readyCheckedAt = Date.now();
  try {
    await prisma.requestApproval.findFirst({ select: { id: true } });
    readyValue = true;
  } catch (e) {
    if (!isMissingTable(e)) throw e;
    readyValue = false;
  }
  return readyValue;
}

const nameOf = (u: { firstName: string; lastName: string } | undefined) => (u ? `${u.firstName} ${u.lastName}`.trim() : "");

/** Create the manager step for a new request. Returns the managers who were asked ([] = no step, straight to HR). */
export async function startStep(kind: Kind, requestId: string, requester: { id: string; platformId: string }): Promise<string[]> {
  if (!(await approvalsReady())) return [];
  const me = await prisma.user.findUnique({
    where: { id: requester.id },
    select: {
      reportsTo: { select: { id: true, role: true, status: true, platformId: true } },
      teamMemberships: { where: { isActive: true }, select: { team: { select: { isActive: true, manager: { select: { id: true, role: true, status: true, platformId: true } } } } } },
    },
  });
  const candidates = [
    ...(me?.reportsTo ? [me.reportsTo] : []),
    ...(me?.teamMemberships ?? []).filter((m) => m.team.isActive && m.team.manager).map((m) => m.team.manager!),
  ].map((c) => ({ id: c.id, role: String(c.role), status: String(c.status), platformId: c.platformId }));
  const approverIds = pickApprovers(requester, candidates);
  if (approverIds.length === 0) return [];
  await prisma.requestApproval.create({ data: { platformId: requester.platformId, kind, requestId, approverIds } });
  return approverIds;
}

export type StepView = { status: string; approvers: string[]; decidedBy: string | null; decidedAt: Date | null; note: string | null };

/** request id -> its manager step (only requests that have one). */
export async function stepViews(kind: Kind, requestIds: string[]): Promise<Map<string, StepView>> {
  const out = new Map<string, StepView>();
  if (requestIds.length === 0 || !(await approvalsReady())) return out;
  const rows = await prisma.requestApproval.findMany({ where: { kind, requestId: { in: requestIds } } });
  const ids = [...new Set(rows.flatMap((r) => [...r.approverIds, ...(r.decidedById ? [r.decidedById] : [])]))];
  const people = ids.length ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, firstName: true, lastName: true } }) : [];
  const name = new Map(people.map((p) => [p.id, nameOf(p)]));
  for (const r of rows) {
    out.set(r.requestId, {
      status: r.status,
      approvers: r.approverIds.map((id) => name.get(id) ?? "").filter(Boolean),
      decidedBy: r.decidedById ? name.get(r.decidedById) ?? null : null,
      decidedAt: r.decidedAt,
      note: r.note,
    });
  }
  return out;
}

/** The manager answers. Throws NOT_FOUND (not one of the asked managers, or no step), OWN_REQUEST, STEP_ALREADY_DECIDED.
 *  Only one answer can ever be recorded: the status is part of the update. */
export async function claimStep(opts: { kind: Kind; requestId: string; managerId: string; requesterId: string; decision: "APPROVE" | "REJECT"; note: string | null }) {
  if (!(await approvalsReady())) throw new Error("NOT_FOUND");
  const row = await prisma.requestApproval.findUnique({ where: { kind_requestId: { kind: opts.kind, requestId: opts.requestId } } });
  if (!row || !row.approverIds.includes(opts.managerId)) throw new Error("NOT_FOUND");
  if (opts.requesterId === opts.managerId) throw new Error("OWN_REQUEST");
  if (row.status !== "PENDING") throw new Error("STEP_ALREADY_DECIDED");
  const res = await prisma.requestApproval.updateMany({
    where: { id: row.id, status: "PENDING" },
    data: { status: opts.decision === "APPROVE" ? "APPROVED" : "REJECTED", decidedById: opts.managerId, decidedAt: new Date(), note: opts.note },
  });
  if (res.count === 0) throw new Error("STEP_ALREADY_DECIDED");
  return { platformId: row.platformId };
}

/** Called by HR before deciding. Throws WAITING_FOR_MANAGER, SKIP_REASON_REQUIRED or MANAGER_REJECTED; if HR chose to decide without the
 *  manager (with a reason) the step is marked SKIPPED and the reason is kept. Returns the skip reason when it happened. */
export async function gateForHr(kind: Kind, requestId: string, hrId: string, skip: { skipManager?: unknown; skipReason?: unknown; decision?: unknown }): Promise<string | null> {
  if (!(await approvalsReady())) return null;
  const row = await prisma.requestApproval.findUnique({ where: { kind_requestId: { kind, requestId } } });
  const g = hrGate(row, { skipManager: skip.skipManager === true, skipReason: String(skip.skipReason ?? "") });
  if (g === "OK") return null;
  if (g === "WAITING") throw new Error("WAITING_FOR_MANAGER");
  if (g === "SKIP_REASON_REQUIRED") throw new Error("SKIP_REASON_REQUIRED");
  if (g === "REJECTED_BY_MANAGER") {
    if (skip.decision === "REJECT") return null; // HR can close the request as rejected, never approve it
    throw new Error("MANAGER_REJECTED");
  }
  const reason = String(skip.skipReason).trim().slice(0, 300);
  const res = await prisma.requestApproval.updateMany({ where: { id: row!.id, status: "PENDING" }, data: { status: "SKIPPED", decidedById: hrId, decidedAt: new Date(), note: reason } });
  if (res.count === 0) throw new Error("STEP_ALREADY_DECIDED");
  return reason;
}

/** Is this person one of the managers asked about this request? (Lets a manager open the evidence file of a request waiting for them.) */
export async function isApproverOf(kind: Kind, requestId: string, managerId: string): Promise<boolean> {
  if (!(await approvalsReady())) return false;
  const row = await prisma.requestApproval.findUnique({ where: { kind_requestId: { kind, requestId } }, select: { approverIds: true } });
  return Boolean(row?.approverIds.includes(managerId));
}

/** Step rows a manager should see: those waiting for them, and the ones they answered recently. */
export async function rowsForManager(kind: Kind, managerId: string) {
  if (!(await approvalsReady())) return [];
  const [waiting, answered] = await Promise.all([
    prisma.requestApproval.findMany({ where: { kind, status: "PENDING", approverIds: { has: managerId } }, orderBy: { createdAt: "asc" }, take: 200 }),
    prisma.requestApproval.findMany({ where: { kind, decidedById: managerId, status: { in: ["APPROVED", "REJECTED"] } }, orderBy: { decidedAt: "desc" }, take: 50 }),
  ]);
  return [...waiting, ...answered];
}
