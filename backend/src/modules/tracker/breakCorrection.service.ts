import { prisma } from "../../lib/prisma.js";
import { auditNote } from "../../lib/auditContext.js";
import { accessFor, assertCompany } from "../../lib/companyAccess.js";
import { parseIsoDay } from "../../lib/dates.js";
import { getContext, recompute } from "./tracker.service.js";
import { breakRowSeconds, classOfRow, recordedRowSeconds, splitAwayTime } from "./activityClass.js";

// ---------------------------------------------------------------------------
// ADMIN BREAK CORRECTION
//
// An Admin can directly correct how long a CLOSED break lasted. There is no approval step, so the safeguards are in the data instead:
//   - The recorded startedAt / endedAt / durationSeconds are never edited. The corrected value is stored beside them.
//   - A correction can only SHORTEN a break (it cannot invent break time), and needs a written reason.
//   - Who, when and why are stored on the break and, for every apply and every revert, in the append-only break_correction_log.
//   - It is reversible: a revert clears the correction and the original duration is used again.
//   - An Admin cannot correct their own break; another Admin must.
//   - The day's totals come from the SAME recompute() that clock-out uses, so attendance and productive time follow automatically.
// ---------------------------------------------------------------------------

export const REASON_MIN = 10;
export const REASON_MAX = 500;

async function adminOnly(actorId: string) {
  const a = await prisma.user.findUnique({ where: { id: actorId }, select: { id: true, role: true, platformId: true, firstName: true, lastName: true } });
  if (!a) throw new Error("USER_NOT_FOUND");
  if (String(a.role) !== "ADMIN") throw new Error("NOT_ALLOWED");
  return { ...a, access: await accessFor(actorId) };
}

function cleanReason(raw: unknown): string {
  const r = String(raw ?? "").trim();
  if (r.length < REASON_MIN) throw new Error("REASON_REQUIRED");
  if (r.length > REASON_MAX) throw new Error("REASON_TOO_LONG");
  return r;
}

async function loadBreak(actor: Awaited<ReturnType<typeof adminOnly>>, breakId: string) {
  const row = await prisma.trackerBreak.findUnique({ where: { id: breakId }, include: { workSession: { select: { id: true, userId: true, platformId: true, date: true } } } });
  if (!row) throw new Error("NOT_FOUND");
  assertCompany(actor.access, row.workSession.platformId);
  if (row.workSession.userId === actor.id) throw new Error("OWN_BREAK");
  if (!row.endedAt) throw new Error("BREAK_STILL_RUNNING");
  return row;
}

type Applied = { sessionId: string; userId: string; date: Date; beforeSeconds: number; afterSeconds: number; originalSeconds: number };

// After the totals move, drop a stale over-budget alert for the day (a revert does not re-raise it; the alert job does that on its next run).
async function settleAlert(tx: Pick<typeof prisma, "alert" | "workSession">, userId: string, date: Date, sessionId: string, budgetSeconds: number) {
  const s = await tx.workSession.findUnique({ where: { id: sessionId }, include: { breaks: true } });
  if (!s) return;
  if (splitAwayTime(s.breaks, new Date()).breakSeconds <= budgetSeconds) {
    await tx.alert.deleteMany({ where: { userId, date, alertType: "BREAK_OVERAGE" } });
  }
}

export async function applyCorrection(actorId: string, breakId: string, minutes: unknown, reasonRaw: unknown) {
  const actor = await adminOnly(actorId);
  const reason = cleanReason(reasonRaw);
  const mins = Number(minutes);
  if (!Number.isInteger(mins) || mins < 0) throw new Error("BAD_DURATION");

  const found = await loadBreak(actor, breakId);
  if (classOfRow(found) !== "BREAK") throw new Error("NOT_A_BREAK");
  const ctx = await getContext(found.workSession.userId, { ignoreLock: true });

  const out = await prisma.$transaction(
    async (tx) => {
      // Lock the day's session so a clock-in/out cannot slip in between the read and the write.
      await tx.$queryRaw`SELECT id FROM work_sessions WHERE id = ${found.workSession.id}::uuid FOR UPDATE`;
      const row = await tx.trackerBreak.findUnique({ where: { id: breakId } });
      if (!row || !row.endedAt) throw new Error("BREAK_STILL_RUNNING");

      const now = new Date();
      const original = recordedRowSeconds(row, now);
      const corrected = mins * 60;
      if (corrected > original) throw new Error("CANNOT_INCREASE");
      const before = breakRowSeconds(row, now);

      await tx.trackerBreak.update({
        where: { id: breakId },
        data: { correctedDurationSeconds: corrected, correctionReason: reason, correctedById: actor.id, correctedAt: now },
      });
      await recompute(found.workSession.id, tx);
      await settleAlert(tx, found.workSession.userId, found.workSession.date, found.workSession.id, ctx.config.breakBudgetMinutes * 60);
      await tx.breakCorrectionLog.create({
        data: { platformId: found.workSession.platformId, breakId, workSessionId: found.workSession.id, userId: found.workSession.userId, action: "APPLIED", originalSeconds: original, beforeSeconds: before, afterSeconds: corrected, reason, actedById: actor.id },
      });
      return { sessionId: found.workSession.id, userId: found.workSession.userId, date: found.workSession.date, beforeSeconds: before, afterSeconds: corrected, originalSeconds: original } satisfies Applied;
    },
    { timeout: 30_000, maxWait: 10_000 }
  );

  auditNote({
    recordType: "TrackerBreak", recordId: breakId, targetUserId: out.userId, platformId: found.workSession.platformId,
    module: "Attendance", action: "UPDATE",
    before: { breakSeconds: out.beforeSeconds, recordedSeconds: out.originalSeconds },
    after: { breakSeconds: out.afterSeconds, reason },
    summary: `Admin corrected a break on ${out.date.toISOString().slice(0, 10)} from ${Math.round(out.beforeSeconds / 60)} to ${Math.round(out.afterSeconds / 60)} minutes`,
  });
  return view(await prisma.trackerBreak.findUniqueOrThrow({ where: { id: breakId } }));
}

export async function revertCorrection(actorId: string, breakId: string, reasonRaw: unknown) {
  const actor = await adminOnly(actorId);
  const reason = cleanReason(reasonRaw);
  const found = await loadBreak(actor, breakId);

  const out = await prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM work_sessions WHERE id = ${found.workSession.id}::uuid FOR UPDATE`;
      const row = await tx.trackerBreak.findUnique({ where: { id: breakId } });
      if (!row || row.correctedDurationSeconds == null) throw new Error("NOT_CORRECTED");

      const now = new Date();
      const original = recordedRowSeconds(row, now);
      const before = breakRowSeconds(row, now);

      await tx.trackerBreak.update({ where: { id: breakId }, data: { correctedDurationSeconds: null, correctionReason: null, correctedById: null, correctedAt: null } });
      await recompute(found.workSession.id, tx);
      await tx.breakCorrectionLog.create({
        data: { platformId: found.workSession.platformId, breakId, workSessionId: found.workSession.id, userId: found.workSession.userId, action: "REVERTED", originalSeconds: original, beforeSeconds: before, afterSeconds: original, reason, actedById: actor.id },
      });
      return { userId: found.workSession.userId, date: found.workSession.date, beforeSeconds: before, afterSeconds: original };
    },
    { timeout: 30_000, maxWait: 10_000 }
  );

  auditNote({
    recordType: "TrackerBreak", recordId: breakId, targetUserId: out.userId, platformId: found.workSession.platformId,
    module: "Attendance", action: "UPDATE",
    before: { breakSeconds: out.beforeSeconds }, after: { breakSeconds: out.afterSeconds, reason },
    summary: `Admin reverted a break correction on ${out.date.toISOString().slice(0, 10)}, back to ${Math.round(out.afterSeconds / 60)} minutes`,
  });
  return view(await prisma.trackerBreak.findUniqueOrThrow({ where: { id: breakId } }));
}

function view(b: { id: string; breakType: unknown; startedAt: Date; endedAt: Date | null; durationSeconds: number | null; autoClosed: boolean; reason: string | null; correctedDurationSeconds: number | null; correctionReason: string | null; correctedAt: Date | null }) {
  const now = new Date();
  return {
    id: b.id, breakType: String(b.breakType), startedAt: b.startedAt, endedAt: b.endedAt, autoClosed: b.autoClosed, reason: b.reason,
    recordedSeconds: recordedRowSeconds(b, now),
    correctedSeconds: b.correctedDurationSeconds, correctionReason: b.correctionReason, correctedAt: b.correctedAt,
    effectiveSeconds: breakRowSeconds(b, now),
  };
}

// An Admin looks up one person's breaks for one day (to find the break to correct), with the full correction history.
export async function breaksForDay(actorId: string, userId: string, dateRaw: unknown) {
  const actor = await adminOnly(actorId);
  const date = parseIsoDay(dateRaw);
  const s = await prisma.workSession.findUnique({
    where: { userId_date: { userId, date } },
    include: { breaks: { orderBy: { startedAt: "asc" } }, user: { select: { firstName: true, lastName: true, employeeCode: true } } },
  });
  if (!s) throw new Error("NOT_FOUND");
  assertCompany(actor.access, s.platformId);
  const log = await prisma.breakCorrectionLog.findMany({ where: { workSessionId: s.id }, orderBy: { actedAt: "asc" } });
  const names = new Map(
    (await prisma.user.findMany({ where: { id: { in: [...new Set(log.map((l) => l.actedById))] } }, select: { id: true, firstName: true, lastName: true } })).map((u) => [u.id, `${u.firstName} ${u.lastName}`.trim()])
  );
  return {
    employee: { name: `${s.user.firstName} ${s.user.lastName}`.trim(), employeeCode: s.user.employeeCode },
    date: date.toISOString().slice(0, 10),
    canCorrect: s.userId !== actor.id,
    breaks: s.breaks.map(view),
    history: log.map((l) => ({ id: l.id, breakId: l.breakId, action: l.action, originalSeconds: l.originalSeconds, beforeSeconds: l.beforeSeconds, afterSeconds: l.afterSeconds, reason: l.reason, by: names.get(l.actedById) ?? null, at: l.actedAt })),
  };
}
