import { prisma } from "../../lib/prisma.js";
import { parseIsoDay, platformToday, zonedToUtc } from "../../lib/dates.js";
import { saveUpload, readStored, deleteStored, contentTypeFor } from "../../lib/storage.js";
import { notifyUsers } from "../../lib/notify.js";
import { auditNote } from "../../lib/auditContext.js";
import { sendMail } from "../../lib/mailer.js";
import { correctionSubmittedEmail, correctionDecidedEmail } from "../../lib/emails.js";
import { computeLate, getContext, recompute } from "../tracker/tracker.service.js";
import { accessFor, deciderIdsForCompany, scopeWhere, type Access } from "../../lib/companyAccess.js";
import { claimStep, gateForHr, isApproverOf, rowsForManager, startStep, stepViews } from "../approvals/managerStep.js";

// ---------------------------------------------------------------------------
// ATTENDANCE CORRECTIONS
//
// An employee ASKS. Nothing about attendance changes on submission. HR/Admin of
// the same company decides (an owner who is HR/Admin, via OWNER_CODES, decides for every company; off in a pinned deployment). Only on approval is the work session changed, and
// then in ONE transaction: claim the request, change the session, recompute the
// totals and the late flag with the existing rules, and write the audit row.
// If any step fails, nothing is saved and the request stays pending.
//
// The 15-minute grace period and every other policy value come from TeamConfig,
// exactly as at clock-in. This module never waives a late mark by itself: a
// corrected time that is still past the grace stays late.
// ---------------------------------------------------------------------------

const WINDOW_DAYS = 30;
const DAY_MS = 86_400_000;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DECIDERS = ["HR", "ADMIN"];

export const TYPES = ["MISSING_CHECKIN", "MISSING_CHECKOUT", "INCORRECT_TIME", "BIOMETRIC_FAILURE", "FORGOT_CLOCK_IN", "OTHER"] as const;
type CType = (typeof TYPES)[number];

export const TYPE_LABEL: Record<string, string> = {
  MISSING_CHECKIN: "Missing check-in",
  MISSING_CHECKOUT: "Missing check-out",
  INCORRECT_TIME: "Incorrect time",
  BIOMETRIC_FAILURE: "Biometric failure",
  FORGOT_CLOCK_IN: "Forgot to clock in",
  OTHER: "Other",
};

const iso = (d: Date) => d.toISOString().slice(0, 10);

function clock(at: Date | null, tz: string): string {
  if (!at) return "Not recorded";
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true }).format(at);
}

async function person(userId: string) {
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, role: true, platformId: true, firstName: true, lastName: true, employeeCode: true, email: true, platform: { select: { name: true, timezone: true } } },
  });
  if (!u) throw new Error("USER_NOT_FOUND");
  return u;
}

// Owner reach: sees every company. A deployment pinned to one company switches it off.
async function ownerReach(viewerId: string): Promise<Access> {
  return accessFor(viewerId);
}
const scopeOf = (_v: { platformId: string }, access: Access) => scopeWhere(access);

async function decider(viewerId: string) {
  const v = await person(viewerId);
  if (!DECIDERS.includes(String(v.role))) throw new Error("NOT_ALLOWED");
  return { ...v, access: await ownerReach(viewerId) };
}

// --- the rules that decide whether a requested change is possible --------------------

type SessionLike = {
  loginAt: Date;
  logoutAt: Date | null;
  status: unknown;
  breaks: { startedAt: Date; endedAt: Date | null }[];
} | null;

// Used twice: when the request is submitted, and again at approval (the session may have moved on).
function checkChange(opts: { existing: SessionLike; reqLogin: Date | null; reqLogout: Date | null; isToday: boolean; now: Date }) {
  const { existing, reqLogin, reqLogout, isToday, now } = opts;

  if (!existing) {
    if (!reqLogin) throw new Error("NO_SESSION_NEEDS_LOGIN");
    if (!isToday && !reqLogout) throw new Error("NO_SESSION_NEEDS_BOTH");
  } else if (isToday && String(existing.status) === "ACTIVE" && reqLogout) {
    // Today's running session is closed by clocking out, not by a correction.
    throw new Error("ACTIVE_SESSION_TODAY");
  }

  const newLogin = reqLogin ?? existing?.loginAt ?? null;
  const newLogout = reqLogout ?? existing?.logoutAt ?? null;
  if (!newLogin) throw new Error("NO_SESSION_NEEDS_LOGIN");
  if ((reqLogin && reqLogin.getTime() > now.getTime()) || (reqLogout && reqLogout.getTime() > now.getTime())) throw new Error("FUTURE_TIME");
  if (newLogout) {
    if (newLogout.getTime() <= newLogin.getTime()) throw new Error("BAD_RANGE");
    if (newLogout.getTime() - newLogin.getTime() > DAY_MS) throw new Error("BAD_RANGE");
  }
  // The recorded breaks must still sit inside the corrected day.
  for (const b of existing?.breaks ?? []) {
    if (b.startedAt.getTime() < newLogin.getTime()) throw new Error("BREAKS_CONFLICT");
    if (newLogout && b.endedAt && b.endedAt.getTime() > newLogout.getTime()) throw new Error("BREAKS_CONFLICT");
  }
  return { newLogin, newLogout };
}

// --- employee ---------------------------------------------------------------------------

export async function submitRequest(
  userId: string,
  body: {
    date?: string;
    correctionType?: string;
    requestedLogin?: string | null;
    requestedLogout?: string | null;
    logoutNextDay?: boolean;
    reason?: string;
    attachment?: { fileName?: string; data?: string; mimeType?: string } | null;
  }
) {
  // Needs a working tracker: someone who never had access has no attendance to correct.
  const ctx = await getContext(userId);
  const tz = ctx.timezone;
  const now = new Date();

  const day = parseIsoDay(body.date);
  const today = platformToday(tz);
  if (day.getTime() > today.getTime()) throw new Error("FUTURE_DATE");
  if (day.getTime() < today.getTime() - WINDOW_DAYS * DAY_MS) throw new Error("TOO_OLD");
  const dateIso = iso(day);

  const type = TYPES.find((t) => t === body.correctionType) as CType | undefined;
  if (!type) throw new Error("BAD_TYPE");

  const reason = String(body.reason ?? "").trim();
  if (reason.length < 5) throw new Error("REASON_REQUIRED");
  if (reason.length > 500) throw new Error("REASON_TOO_LONG");

  const loginStr = body.requestedLogin ? String(body.requestedLogin) : null;
  const logoutStr = body.requestedLogout ? String(body.requestedLogout) : null;
  if ((loginStr && !HHMM.test(loginStr)) || (logoutStr && !HHMM.test(logoutStr))) throw new Error("BAD_TIME");

  // Each type has to ask for the time it is about.
  if ((type === "MISSING_CHECKIN" || type === "FORGOT_CLOCK_IN") && !loginStr) throw new Error("LOGIN_TIME_REQUIRED");
  if (type === "MISSING_CHECKOUT" && !logoutStr) throw new Error("LOGOUT_TIME_REQUIRED");
  if (!loginStr && !logoutStr) throw new Error("TIME_REQUIRED");

  const reqLogin = loginStr ? zonedToUtc(dateIso, loginStr, tz) : null;
  let reqLogout = logoutStr ? zonedToUtc(dateIso, logoutStr, tz) : null;
  if (reqLogout && body.logoutNextDay === true) reqLogout = new Date(reqLogout.getTime() + DAY_MS);

  const [leave, existing, pending] = await Promise.all([
    prisma.leaveDay.findUnique({ where: { userId_date: { userId, date: day } }, select: { isHalfDay: true } }),
    prisma.workSession.findUnique({ where: { userId_date: { userId, date: day } }, include: { breaks: true } }),
    prisma.attendanceCorrectionRequest.count({ where: { userId, date: day, status: "PENDING" } }),
  ]);
  if (leave && !leave.isHalfDay) throw new Error("ON_LEAVE");
  if (pending > 0) throw new Error("DUPLICATE_PENDING");

  checkChange({ existing, reqLogin, reqLogout, isToday: day.getTime() === today.getTime(), now });

  let attachment: { storageKey: string; fileName: string } | null = null;
  if (body.attachment?.data) {
    attachment = await saveUpload({ platformId: ctx.platformId, folder: "corrections", originalName: String(body.attachment.fileName ?? "evidence"), data: body.attachment.data, mimeType: body.attachment.mimeType });
  }

  let created;
  try {
    created = await prisma.attendanceCorrectionRequest.create({
      data: {
        platformId: ctx.platformId,
        userId,
        workSessionId: existing?.id ?? null,
        date: day,
        correctionType: type,
        originalLoginAt: existing?.loginAt ?? null,
        originalLogoutAt: existing?.logoutAt ?? null,
        requestedLoginAt: reqLogin,
        requestedLogoutAt: reqLogout,
        reason,
        attachmentKey: attachment?.storageKey ?? null,
        attachmentName: attachment?.fileName ?? null,
      },
    });
  } catch (e) {
    if (attachment) await deleteStored(attachment.storageKey).catch(() => undefined);
    // The database's own one-pending-per-day rule, if two submissions race.
    if ((e as { code?: string }).code === "P2002") throw new Error("DUPLICATE_PENDING");
    throw e;
  }

  // ---- tell HR (never allowed to fail the submission) ----
  const name = `${ctx.user.firstName} ${ctx.user.lastName}`.trim();
  const recorded = existing ? `In ${clock(existing.loginAt, tz)} / Out ${clock(existing.logoutAt, tz)}` : "No attendance recorded";
  const requested = `In ${reqLogin ? clock(reqLogin, tz) : "unchanged"} / Out ${reqLogout ? clock(reqLogout, tz) : "unchanged"}`;
  const hr = await prisma.user.findMany({ where: { id: { in: await deciderIdsForCompany(ctx.platformId, userId) } }, select: { id: true, email: true } });
  // The manager answers first; HR is told when the manager approves. No manager (or an HR/Admin boss): straight to HR.
  const approvers = await startStep("CORRECTION", created.id, { id: userId, platformId: ctx.platformId }).catch((e) => { console.error("[corrections] manager step not created:", e); return [] as string[]; });
  const notified = await notifyUsers({
    platformId: ctx.platformId,
    userIds: approvers.length ? approvers : hr.map((h) => h.id),
    type: "CORRECTION_SUBMITTED",
    title: approvers.length ? `Attendance correction for your approval: ${name}` : `Attendance correction: ${name}`,
    body: `${name} (${ctx.user.employeeCode ?? "no ID"}) asked to correct ${dateIso}: ${TYPE_LABEL[type]}. Recorded: ${recorded}. Requested: ${requested}. Reason: ${reason}`,
    link: `/dashboard/corrections?id=${created.id}`,
    data: { requestId: created.id },
  });
  const mail = correctionSubmittedEmail({ company: ctx.user.platform.name, employee: name, employeeCode: ctx.user.employeeCode ?? "no ID", date: dateIso, typeLabel: TYPE_LABEL[type], recorded, requested, reason });
  if (approvers.length === 0) await Promise.allSettled(hr.filter((h) => h.email && !h.email.endsWith(".local")).map((h) => sendMail({ to: h.email, ...mail })));

  return { id: created.id, status: "PENDING", notified };
}

function view(r: {
  id: string; date: Date; correctionType: unknown; originalLoginAt: Date | null; originalLogoutAt: Date | null;
  requestedLoginAt: Date | null; requestedLogoutAt: Date | null; reason: string; attachmentName: string | null;
  status: unknown; reviewedAt: Date | null; reviewComment: string | null; appliedAt: Date | null; createdAt: Date;
  reviewedBy?: { firstName: string; lastName: string } | null;
}) {
  return {
    id: r.id,
    date: iso(r.date),
    correctionType: String(r.correctionType),
    typeLabel: TYPE_LABEL[String(r.correctionType)] ?? String(r.correctionType),
    originalLoginAt: r.originalLoginAt,
    originalLogoutAt: r.originalLogoutAt,
    requestedLoginAt: r.requestedLoginAt,
    requestedLogoutAt: r.requestedLogoutAt,
    reason: r.reason,
    attachmentName: r.attachmentName,
    status: String(r.status),
    reviewedAt: r.reviewedAt,
    reviewComment: r.reviewComment,
    reviewedBy: r.reviewedBy ? `${r.reviewedBy.firstName} ${r.reviewedBy.lastName}`.trim() : null,
    applied: r.appliedAt !== null,
    createdAt: r.createdAt,
  };
}

export async function listMine(userId: string) {
  const me = await person(userId);
  const rows = await prisma.attendanceCorrectionRequest.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: 100,
    include: { reviewedBy: { select: { firstName: true, lastName: true } } },
  });
  const steps = await stepViews("CORRECTION", rows.map((r) => r.id));
  return { timezone: me.platform.timezone, windowDays: WINDOW_DAYS, requests: rows.map((r) => ({ ...view(r), managerStep: steps.get(r.id) ?? null })) };
}

export async function cancelRequest(userId: string, id: string) {
  const r = await prisma.attendanceCorrectionRequest.findUnique({ where: { id }, select: { userId: true } });
  if (!r || r.userId !== userId) throw new Error("NOT_FOUND");
  const res = await prisma.attendanceCorrectionRequest.updateMany({ where: { id, status: "PENDING" }, data: { status: "CANCELLED" } });
  if (res.count === 0) throw new Error("NOT_PENDING");
  return { ok: true };
}

// --- HR / Admin ---------------------------------------------------------------------------

export async function pendingCount(viewerId: string) {
  const v = await decider(viewerId);
  return { pending: await prisma.attendanceCorrectionRequest.count({ where: { ...scopeOf(v, v.access), status: "PENDING" } }) };
}

export async function listForReview(
  viewerId: string,
  f: { status?: unknown; from?: unknown; to?: unknown; q?: unknown; teamId?: unknown }
) {
  const v = await decider(viewerId);
  const status = (["PENDING", "APPROVED", "REJECTED", "CANCELLED"] as const).find((s) => s === f.status);
  const from = f.from ? parseIsoDay(f.from) : undefined;
  const to = f.to ? parseIsoDay(f.to) : undefined;
  if (from && to && from.getTime() > to.getTime()) throw new Error("BAD_RANGE");
  const q = String(f.q ?? "").trim();
  const teamId = f.teamId ? String(f.teamId) : "";

  const where = {
    ...scopeOf(v, v.access),
    ...(status ? { status } : {}),
    ...(from || to ? { date: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
    user: {
      ...(q ? { OR: [{ firstName: { contains: q, mode: "insensitive" as const } }, { lastName: { contains: q, mode: "insensitive" as const } }, { employeeCode: { contains: q, mode: "insensitive" as const } }] } : {}),
      ...(teamId ? { teamMemberships: { some: { teamId, isActive: true } } } : {}),
    },
  };

  const [rows, grouped, teams] = await Promise.all([
    prisma.attendanceCorrectionRequest.findMany({
      where,
      orderBy: [{ createdAt: "desc" }],
      take: 300,
      include: {
        user: { select: { id: true, firstName: true, lastName: true, employeeCode: true, designation: true } },
        reviewedBy: { select: { firstName: true, lastName: true } },
      },
    }),
    prisma.attendanceCorrectionRequest.groupBy({ by: ["status"], where: scopeOf(v, v.access), _count: true }),
    prisma.team.findMany({ where: { ...scopeOf(v, v.access), isActive: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);
  const counts: Record<string, number> = { PENDING: 0, APPROVED: 0, REJECTED: 0, CANCELLED: 0 };
  for (const g of grouped) counts[String(g.status)] = g._count;
  const steps = await stepViews("CORRECTION", rows.map((r) => r.id));

  return {
    timezone: (await person(viewerId)).platform.timezone,
    counts,
    teams,
    requests: rows.map((r) => ({
      ...view(r),
      managerStep: steps.get(r.id) ?? null,
      employee: { id: r.user.id, name: `${r.user.firstName} ${r.user.lastName}`.trim(), employeeCode: r.user.employeeCode, designation: r.user.designation },
    })),
  };
}

export async function details(viewerId: string, id: string) {
  const v = await person(viewerId);
  const isDecider = DECIDERS.includes(String(v.role));
  const access: Access = isDecider ? await ownerReach(viewerId) : { all: false, ids: [v.platformId] };
  const r = await prisma.attendanceCorrectionRequest.findFirst({
    where: { id, ...scopeOf(v, access), ...(isDecider ? {} : { userId: v.id }) },
    include: {
      user: { select: { id: true, firstName: true, lastName: true, employeeCode: true, designation: true } },
      reviewedBy: { select: { firstName: true, lastName: true } },
      audits: { orderBy: { createdAt: "asc" }, include: { actedBy: { select: { firstName: true, lastName: true } } } },
    },
  });
  if (!r) throw new Error("NOT_FOUND");
  const current = await prisma.workSession.findUnique({
    where: { userId_date: { userId: r.userId, date: r.date } },
    select: { loginAt: true, logoutAt: true, status: true, productiveSeconds: true, breakSeconds: true, wasLateLogin: true, lateByMinutes: true },
  });
  const step = (await stepViews("CORRECTION", [r.id])).get(r.id) ?? null;
  return {
    timezone: v.platform.timezone,
    ...view(r),
    managerStep: step,
    employee: { id: r.user.id, name: `${r.user.firstName} ${r.user.lastName}`.trim(), employeeCode: r.user.employeeCode, designation: r.user.designation },
    current,
    audits: r.audits.map((a) => ({ id: a.id, action: a.action, before: a.before, after: a.after, by: `${a.actedBy.firstName} ${a.actedBy.lastName}`.trim(), at: a.createdAt })),
    canDecide: isDecider && String(r.status) === "PENDING" && r.userId !== v.id,
  };
}

export async function openAttachment(viewerId: string, id: string) {
  const v = await person(viewerId);
  const isDecider = DECIDERS.includes(String(v.role));
  const access: Access = isDecider ? await ownerReach(viewerId) : { all: false, ids: [v.platformId] };
  // The person themself, HR/Admin, or a manager asked in the manager step may open the evidence.
  const asManager = !isDecider && String(v.role) === "MANAGER" && (await isApproverOf("CORRECTION", id, v.id));
  const r = await prisma.attendanceCorrectionRequest.findFirst({
    where: { id, ...scopeOf(v, access), ...(isDecider || asManager ? {} : { userId: v.id }) },
    select: { attachmentKey: true, attachmentName: true },
  });
  if (!r?.attachmentKey) throw new Error("NOT_FOUND");
  return { buffer: await readStored(r.attachmentKey), fileName: r.attachmentName ?? "evidence", mimeType: contentTypeFor(r.attachmentKey) };
}

export async function decide(viewerId: string, id: string, decision: unknown, comment: unknown, skip: { skipManager?: unknown; skipReason?: unknown } = {}) {
  const v = await decider(viewerId);
  if (decision !== "APPROVE" && decision !== "REJECT") throw new Error("BAD_DECISION");
  const text = String(comment ?? "").trim().slice(0, 500) || null;
  if (decision === "REJECT" && (!text || text.length < 3)) throw new Error("COMMENT_REQUIRED");

  const req = await prisma.attendanceCorrectionRequest.findFirst({ where: { id, ...scopeOf(v, v.access) } });
  if (!req) throw new Error("NOT_FOUND");
  if (req.userId === v.id) throw new Error("OWN_REQUEST");
  if (String(req.status) !== "PENDING") throw new Error("ALREADY_DECIDED");
  // The manager answers first. HR can approve only after the manager approved (or, with a written reason, without the manager);
  // a manager's rejection can never be turned into an approval.
  const skipReason = await gateForHr("CORRECTION", id, v.id, { ...skip, decision });
  const viaSkip = skipReason ? ` (decided without the manager: ${skipReason})` : "";

  const approve = decision === "APPROVE";
  const ctx = await getContext(req.userId, { ignoreLock: true });
  const tz = ctx.timezone;
  const dateIso = iso(req.date);

  // What the day looked like before and after, for the audit trail (set inside the transaction on approval).
  let applied: { before: unknown; after: unknown } | null = null;

  await prisma.$transaction(
    async (tx) => {
      // 1. Claim the request. Only one reviewer can move it out of PENDING; the other gets ALREADY_DECIDED.
      const claimed = await tx.attendanceCorrectionRequest.updateMany({
        where: { id, platformId: req.platformId, status: "PENDING" },
        data: { status: approve ? "APPROVED" : "REJECTED", reviewedById: v.id, reviewedAt: new Date(), reviewComment: text },
      });
      if (claimed.count === 0) throw new Error("ALREADY_DECIDED");
      if (!approve) return; // a rejection changes no attendance at all

      // 2. Lock the day's session (if any) so a clock-in/out cannot slip in between our read and write.
      await tx.$queryRaw`SELECT id FROM work_sessions WHERE "userId" = ${req.userId}::uuid AND date = ${dateIso}::date FOR UPDATE`;
      const existing = await tx.workSession.findUnique({ where: { userId_date: { userId: req.userId, date: req.date } }, include: { breaks: true } });

      // 3. Re-check against the session as it is NOW (it may have changed since the request).
      const today = platformToday(tz);
      const { newLogin, newLogout } = checkChange({ existing, reqLogin: req.requestedLoginAt, reqLogout: req.requestedLogoutAt, isToday: req.date.getTime() === today.getTime(), now: new Date() });

      const grace = ctx.config.lateLoginGraceMinutes;
      const shiftStartTime = existing?.shiftStartTime ?? ctx.shift?.startTime ?? null;
      const late = computeLate(newLogin, shiftStartTime, grace, tz);
      const stamp = `Corrected via request ${id.slice(0, 8)} approved by ${v.firstName} ${v.lastName} on ${iso(new Date())}`;

      const snap = (s: { loginAt: Date; logoutAt: Date | null; status: unknown; autoClosed: boolean; productiveSeconds: number; breakSeconds: number; meetingSeconds: number; wasLateLogin: boolean; lateByMinutes: number } | null) =>
        s ? { loginAt: s.loginAt, logoutAt: s.logoutAt, status: String(s.status), autoClosed: s.autoClosed, productiveSeconds: s.productiveSeconds, breakSeconds: s.breakSeconds, meetingSeconds: s.meetingSeconds, wasLateLogin: s.wasLateLogin, lateByMinutes: s.lateByMinutes } : null;
      const before = snap(existing);

      let sessionId: string;
      if (existing) {
        const upd = await tx.workSession.update({
          where: { id: existing.id },
          data: {
            loginAt: newLogin,
            logoutAt: newLogout,
            status: newLogout ? "COMPLETED" : existing.status,
            // A logout a person has now vouched for is no longer a forced one.
            ...(req.requestedLogoutAt ? { autoClosed: false, autoClosedAt: null } : {}),
            shiftStartTime,
            wasLateLogin: late.wasLateLogin,
            lateByMinutes: late.lateByMinutes,
            notes: existing.notes ? `${existing.notes}\n${stamp}` : stamp,
          },
          select: { id: true },
        });
        sessionId = upd.id;
      } else {
        const made = await tx.workSession.create({
          data: {
            platformId: req.platformId,
            userId: req.userId,
            date: req.date,
            loginAt: newLogin,
            logoutAt: newLogout,
            status: newLogout ? "COMPLETED" : "ACTIVE",
            shiftStartTime,
            wasLateLogin: late.wasLateLogin,
            lateByMinutes: late.lateByMinutes,
            notes: stamp,
          },
          select: { id: true },
        });
        sessionId = made.id;
      }

      // 4. The SAME function clock-out uses: worked, break and meeting seconds are never computed two ways.
      const after = await recompute(sessionId, tx);

      // 5. Alerts that were true of the old record but no longer are.
      await tx.alert.deleteMany({ where: { userId: req.userId, date: req.date, alertType: "NO_LOGIN" } });
      if (!late.wasLateLogin) await tx.alert.deleteMany({ where: { userId: req.userId, date: req.date, alertType: "LATE_LOGIN" } });

      // 6. The permanent before/after record, and the link from the request to the session.
      await tx.attendanceCorrectionAudit.create({
        data: { requestId: id, platformId: req.platformId, userId: req.userId, workSessionId: sessionId, action: "APPLIED", before: (before ?? { note: "no attendance was recorded" }) as never, after: snap(after) as never, actedById: v.id },
      });
      await tx.attendanceCorrectionRequest.update({ where: { id }, data: { appliedAt: new Date(), workSessionId: sessionId } });
      applied = { before: before ?? { note: "no attendance was recorded" }, after: snap(after) };
    },
    { timeout: 30_000, maxWait: 10_000 }
  );

  auditNote({
    recordType: "AttendanceCorrection",
    recordId: id,
    targetUserId: req.userId,
    before: approve ? (applied as { before: unknown } | null)?.before : { status: "PENDING" },
    after: approve ? (applied as { after: unknown } | null)?.after : { status: "REJECTED", comment: text },
    summary: `${approve ? "Approved" : "Rejected"} the ${TYPE_LABEL[String(req.correctionType)].toLowerCase()} correction for ${dateIso}${viaSkip}`,
  });

  // ---- tell the employee (never allowed to undo the decision) ----
  const employee = await person(req.userId);
  await notifyUsers({
    platformId: req.platformId,
    userIds: [req.userId],
    type: "CORRECTION_DECIDED",
    title: approve ? "Attendance correction approved" : "Attendance correction not approved",
    body: `Your correction for ${dateIso} (${TYPE_LABEL[String(req.correctionType)]}) was ${approve ? "approved" : "not approved"}.${text ? ` HR comment: ${text}` : ""}`,
    link: "/dashboard/corrections",
    data: { requestId: id },
  });
  if (employee.email && !employee.email.endsWith(".local")) {
    const mail = correctionDecidedEmail({ company: employee.platform.name, firstName: employee.firstName, approved: approve, date: dateIso, typeLabel: TYPE_LABEL[String(req.correctionType)], comment: text });
    await sendMail({ to: employee.email, ...mail }).catch(() => undefined);
  }

  return { status: approve ? "APPROVED" : "REJECTED" };
}

// --- manager step ---------------------------------------------------------------------------

async function managerOnly(managerId: string) {
  const m = await person(managerId);
  if (String(m.role) !== "MANAGER") throw new Error("NOT_ALLOWED");
  return m;
}

// Requests waiting for this manager, and the ones they answered recently.
export async function managerRequests(managerId: string) {
  const m = await managerOnly(managerId);
  const rows = await rowsForManager("CORRECTION", managerId);
  const ids = [...new Set(rows.map((r) => r.requestId))];
  const reqs = ids.length
    ? await prisma.attendanceCorrectionRequest.findMany({
        where: { id: { in: ids }, platformId: m.platformId },
        include: {
          user: { select: { id: true, firstName: true, lastName: true, employeeCode: true, designation: true } },
          reviewedBy: { select: { firstName: true, lastName: true } },
        },
      })
    : [];
  const byId = new Map(reqs.map((r) => [r.id, r]));
  const steps = await stepViews("CORRECTION", ids);
  const one = (id: string) => {
    const r = byId.get(id);
    if (!r) return null;
    return {
      ...view(r),
      managerStep: steps.get(id) ?? null,
      employee: { id: r.user.id, name: `${r.user.firstName} ${r.user.lastName}`.trim(), employeeCode: r.user.employeeCode, designation: r.user.designation },
    };
  };
  const pending = rows.filter((r) => r.status === "PENDING").map((r) => one(r.requestId)).filter((x) => x && x.status === "PENDING");
  const answered = rows.filter((r) => r.status !== "PENDING").map((r) => one(r.requestId)).filter(Boolean);
  return { timezone: m.platform.timezone, pending, answered };
}

export async function managerDecide(managerId: string, id: string, decision: unknown, comment: unknown) {
  const m = await managerOnly(managerId);
  if (decision !== "APPROVE" && decision !== "REJECT") throw new Error("BAD_DECISION");
  const text = String(comment ?? "").trim().slice(0, 500) || null;
  if (decision === "REJECT" && (!text || text.length < 3)) throw new Error("COMMENT_REQUIRED");

  const req = await prisma.attendanceCorrectionRequest.findFirst({ where: { id, platformId: m.platformId } });
  if (!req) throw new Error("NOT_FOUND");
  if (String(req.status) !== "PENDING") throw new Error("ALREADY_DECIDED");
  await claimStep({ kind: "CORRECTION", requestId: id, managerId, requesterId: req.userId, decision, note: text });

  const dateIso = iso(req.date);
  const label = TYPE_LABEL[String(req.correctionType)];
  const employee = await person(req.userId);
  const name = `${employee.firstName} ${employee.lastName}`.trim();
  if (decision === "REJECT") {
    // The manager's rejection closes the request. Nothing about attendance changes.
    await prisma.attendanceCorrectionRequest.updateMany({ where: { id, status: "PENDING" }, data: { status: "REJECTED", reviewedById: managerId, reviewedAt: new Date(), reviewComment: text } });
    auditNote({ recordType: "AttendanceCorrection", recordId: id, targetUserId: req.userId, before: { status: "PENDING" }, after: { status: "REJECTED", by: "manager", comment: text }, summary: `Manager rejected the ${label.toLowerCase()} correction for ${dateIso}` });
    await notifyUsers({
      platformId: req.platformId,
      userIds: [req.userId],
      type: "CORRECTION_DECIDED",
      title: "Attendance correction not approved",
      body: `Your correction for ${dateIso} (${label}) was not approved by your manager.${text ? ` Comment: ${text}` : ""}`,
      link: "/dashboard/corrections",
      data: { requestId: id },
    });
    return { status: "REJECTED" };
  }
  auditNote({ recordType: "AttendanceCorrection", recordId: id, targetUserId: req.userId, before: { managerStep: "PENDING" }, after: { managerStep: "APPROVED", comment: text }, summary: `Manager approved the ${label.toLowerCase()} correction for ${dateIso}; waiting for HR` });
  try {
    const hr = (await deciderIdsForCompany(req.platformId, req.userId)).map((id) => ({ id }));
    await notifyUsers({
      platformId: req.platformId,
      userIds: hr.map((h) => h.id),
      type: "CORRECTION_SUBMITTED",
      title: `Attendance correction ready for HR: ${name}`,
      body: `${name} (${employee.employeeCode ?? "no ID"}): ${label} on ${dateIso}. Their manager approved it${text ? `: ${text}` : ""}. HR decides now.`,
      link: `/dashboard/corrections?id=${id}`,
      data: { requestId: id },
    });
    await notifyUsers({
      platformId: req.platformId,
      userIds: [req.userId],
      type: "CORRECTION_DECIDED",
      title: "Your manager approved your correction",
      body: `Your correction for ${dateIso} (${label}) was approved by your manager. It is now waiting for HR.`,
      link: "/dashboard/corrections",
      data: { requestId: id },
    });
  } catch (e) {
    console.error("[corrections] could not notify after manager step:", e);
  }
  return { status: "WAITING_FOR_HR" };
}

