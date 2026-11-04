import { prisma } from "../../lib/prisma.js";
import { localDayOf, parseIsoDay, platformToday, zonedToUtc } from "../../lib/dates.js";
import { visibleUserIds } from "../tracker/tracker.service.js";
import { computeBreakdown } from "../tracker/productiveBreakdown.js";
import { awayRows, splitAwayTime } from "../tracker/activityClass.js";
import { auditNote } from "../../lib/auditContext.js";
import { notifyUsers } from "../../lib/notify.js";
import { emitMeetingChange } from "../../lib/realtime.js";
import * as L from "./participation.logic.js";

// ---------------------------------------------------------------------------
// IN-PERSON MEETING PARTICIPATION (self-reported)
//
// Rules, in one place:
//   - Only the people INVITED to a tracked meeting can join it, and only for themselves.
//   - The SERVER stamps every join and exit. A person can never type or edit their own times.
//   - Join window: 15 minutes before the start until the expected end. After that only the organizing manager can
//     add someone, through a correction (with a reason, kept as history).
//   - One join and one end per person per meeting (unique pair). A return needs a manager correction.
//   - The organizing manager sees the live list. HR and Admin see only the counts (invited, joined).
//   - Nothing here touches attendance, clock-in/out, breaks, working hours or productivity.
// Safe before the migration: if the tables are not there, tracking is simply unavailable.
// ---------------------------------------------------------------------------

const CREATORS = ["MANAGER", "HR", "ADMIN"];
const OVERSIGHT = ["HR", "ADMIN"];
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

async function who(userId: string) {
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, role: true, platformId: true, firstName: true, lastName: true, platform: { select: { timezone: true } } },
  });
  if (!u) throw new Error("USER_NOT_FOUND");
  return { id: u.id, role: String(u.role), platformId: u.platformId, name: `${u.firstName} ${u.lastName}`.trim(), tz: u.platform.timezone };
}

// --- is the schema there? -----------------------------------------------------------------------

const isMissingTable = (e: unknown) => {
  const code = (e as { code?: unknown })?.code;
  const msg = e instanceof Error ? e.message : "";
  return code === "P2021" || (/meeting_(tracking|participation)/.test(msg) && /does not exist|relation/.test(msg));
};
let readyValue = false;
let readyCheckedAt = 0;
export async function participationReady(): Promise<boolean> {
  if (readyValue) return true;
  if (Date.now() - readyCheckedAt < 15_000) return false;
  readyCheckedAt = Date.now();
  try {
    await Promise.all([
      prisma.meetingTracking.findFirst({ select: { meetingId: true } }),
      prisma.meetingParticipation.findFirst({ select: { id: true } }),
      prisma.meetingParticipationChange.findFirst({ select: { id: true } }),
    ]);
    readyValue = true;
  } catch (e) {
    if (!isMissingTable(e)) throw e;
    readyValue = false;
  }
  return readyValue;
}
// Accept / Decline answers live in their own table. Before it exists nobody can answer and joining is not gated on an answer.
let respReadyValue = false;
let respCheckedAt = 0;
export async function responsesReady(): Promise<boolean> {
  if (respReadyValue) return true;
  if (Date.now() - respCheckedAt < 15_000) return false;
  respCheckedAt = Date.now();
  try {
    await prisma.meetingResponse.findFirst({ select: { id: true } });
    respReadyValue = true;
  } catch (e) {
    const code = (e as { code?: unknown })?.code;
    const msg = e instanceof Error ? e.message : "";
    if (code !== "P2021" && !(/meeting_responses/.test(msg) && /does not exist|relation/.test(msg))) throw e;
    respReadyValue = false;
  }
  return respReadyValue;
}

async function requireReady() {
  if (!(await participationReady())) throw new Error("FEATURES_NOT_READY");
}
const isUnique = (e: unknown) => (e as { code?: unknown })?.code === "P2002";

// --- used by the Meetings module -----------------------------------------------------------------------

type Tx = Pick<typeof prisma, "meetingTracking">;

/** Switch tracking on for a new meeting (called inside the same transaction that creates it). */
export async function enableTracking(tx: Tx, o: { meetingId: string; platformId: string; createdById: string; lateAfterMinutes: number }) {
  await tx.meetingTracking.create({ data: { meetingId: o.meetingId, platformId: o.platformId, createdById: o.createdById, lateAfterMinutes: o.lateAfterMinutes } });
}

/** Is participation tracking on for this meeting? (false before the migration) */
export async function isTracked(meetingId: string): Promise<boolean> {
  if (!(await participationReady())) return false;
  return !!(await prisma.meetingTracking.findUnique({ where: { meetingId }, select: { meetingId: true } }));
}

/** A manager can run huddles only for the people who report to them (teams they run + direct reports). HR/Admin are unrestricted within the company. */
export async function assertReportingEmployees(organizer: { id: string; role: string; platformId: string }, attendeeIds: string[]) {
  if (organizer.role !== "MANAGER") return;
  const allowed = new Set(await visibleUserIds(organizer));
  if (attendeeIds.some((id) => !allowed.has(id))) throw new Error("NOT_YOUR_REPORT");
}

export function cleanLateAfter(v: unknown): number {
  if (v === undefined || v === null || v === "") return 5;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 120) throw new Error("BAD_LATE_MINUTES");
  return n;
}

type Item = { id: string; startsAt: Date; endsAt: Date; isOrganizer: boolean; status: string };

/** Extra fields for meetings that have tracking on (nothing is added to the others). Never throws for a missing table. */
export async function extrasFor(items: Item[], viewerId: string, now: Date) {
  const out = new Map<string, Record<string, unknown>>();
  if (items.length === 0) return out;
  const ids = items.map((i) => i.id);
  const itemBy = new Map(items.map((i) => [i.id, i]));
  const partReady = await participationReady();
  const respReady = await responsesReady();

  const tracked = partReady ? await prisma.meetingTracking.findMany({ where: { meetingId: { in: ids } }, select: { meetingId: true, lateAfterMinutes: true } }) : [];
  const trackedIds = tracked.map((t) => t.meetingId);
  const trackedSet = new Set(trackedIds);
  const [invites, responses, mine, joined] = await Promise.all([
    prisma.meetingAttendee.findMany({ where: { meetingId: { in: ids }, userId: viewerId }, select: { meetingId: true } }),
    respReady ? prisma.meetingResponse.findMany({ where: { meetingId: { in: ids }, userId: viewerId }, select: { meetingId: true, response: true } }) : Promise.resolve([]),
    trackedIds.length ? prisma.meetingParticipation.findMany({ where: { meetingId: { in: trackedIds }, userId: viewerId } }) : Promise.resolve([]),
    trackedIds.length ? prisma.meetingParticipation.groupBy({ by: ["meetingId"], where: { meetingId: { in: trackedIds } }, _count: { _all: true } }) : Promise.resolve([]),
  ]);
  const invitedTo = new Set(invites.map((a) => a.meetingId));
  const answerOf = new Map(responses.map((r) => [r.meetingId, r.response as "ACCEPTED" | "DECLINED"]));
  const mineBy = new Map(mine.map((p) => [p.meetingId, p]));
  const joinedBy = new Map(joined.map((j) => [j.meetingId, j._count._all]));

  // Everyone INVITED (not the organizer) gets their answer, their status and whether they may still answer: for every meeting, tracked or not.
  for (const id of invitedTo) {
    const it = itemBy.get(id)!;
    const over = it.endsAt.getTime() < now.getTime();
    const response = answerOf.get(id) ?? null;
    const p = mineBy.get(id) ?? null;
    out.set(id, {
      myResponse: response,
      myStatus: L.inviteStatus({ response, participation: p, meetingOver: over, tracked: trackedSet.has(id) }),
      canRespond: respReady && L.canRespondNow({ isInvitee: true, cancelled: it.status !== "SCHEDULED", meetingOver: over, joined: !!p }),
      mustAccept: respReady && trackedSet.has(id) && response !== "ACCEPTED" && !p && !over && it.status === "SCHEDULED",
    });
  }
  for (const t of tracked) {
    const it = itemBy.get(t.meetingId)!;
    const w = L.joinWindow(it.startsAt, it.endsAt, now);
    const p = mineBy.get(t.meetingId) ?? null;
    const accepted = !respReady || it.isOrganizer || answerOf.get(t.meetingId) === "ACCEPTED";
    out.set(t.meetingId, {
      ...(out.get(t.meetingId) ?? {}),
      tracked: true,
      // Has the scheduled start passed? A Team Huddle is accepted (= joined) once it has started.
      started: it.startsAt.getTime() <= now.getTime(),
      lateAfterMinutes: t.lateAfterMinutes,
      joinWindow: { open: w.open, reason: w.reason, opensAt: w.opensAt, closesAt: w.closesAt },
      // The viewer's OWN record: an invitee, or the organizer (who can also mark himself in the meeting).
      me: p
        ? {
            state: L.stateOf(p),
            joinedAt: p.joinedAt,
            leftAt: p.leftAt,
            durationSeconds: p.durationSeconds,
            late: L.isLate(p.joinedAt, it.startsAt, t.lateAfterMinutes),
            source: p.source,
            stillActivePastEnd: L.isStillActivePastEnd(p, it.endsAt, now),
          }
        : { state: "NOT_JOINED" as const },
      // Joining needs an accepted invitation (the organizer needs none).
      canJoin: !p && it.status === "SCHEDULED" && w.open && accepted,
      // How many INVITED people joined: the organizer's own record is not one of them.
      joinedCount: it.isOrganizer ? Math.max(0, (joinedBy.get(t.meetingId) ?? 0) - (p ? 1 : 0)) : undefined,
    });
  }
  return out;
}

/** HR/Admin oversight: how many joined, per meeting. Counts only. */
export async function joinedCounts(ids: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (ids.length === 0 || !(await participationReady())) return out;
  const tracked = await prisma.meetingTracking.findMany({ where: { meetingId: { in: ids } }, select: { meetingId: true } });
  if (tracked.length === 0) return out;
  const trackedIds = tracked.map((t) => t.meetingId);
  const [rows, organizers] = await Promise.all([
    prisma.meetingParticipation.findMany({ where: { meetingId: { in: trackedIds } }, select: { meetingId: true, userId: true } }),
    prisma.meeting.findMany({ where: { id: { in: trackedIds } }, select: { id: true, organizerId: true } }),
  ]);
  const organizerOf = new Map(organizers.map((o) => [o.id, o.organizerId]));
  for (const t of tracked) out.set(t.meetingId, 0);
  for (const r of rows) if (r.userId !== organizerOf.get(r.meetingId)) out.set(r.meetingId, (out.get(r.meetingId) ?? 0) + 1); // the organizer is not an invitee
  return out;
}

// --- the employee: join and end ----------------------------------------------------------------------

export async function join(userId: string, meetingId: string) {
  await requireReady();
  const v = await who(userId);
  // The organizer or someone invited. Anyone else: it does not exist as far as they can tell (same privacy rule as the rest of Meetings).
  const m = await prisma.meeting.findFirst({
    where: { id: meetingId, platformId: v.platformId, OR: [{ attendees: { some: { userId } } }, { organizerId: userId }] },
    select: { id: true, title: true, startsAt: true, endsAt: true, status: true, organizerId: true },
  });
  if (!m) throw new Error("NOT_FOUND");
  const t = await prisma.meetingTracking.findUnique({ where: { meetingId } });
  if (!t) throw new Error("NOT_TRACKED");
  if (String(m.status) === "CANCELLED") throw new Error("MEETING_CANCELLED");

  // An invited person must have accepted first (the organizer needs no answer). Before the answers table exists this is not asked.
  if (m.organizerId !== userId && (await responsesReady())) {
    const answer = await prisma.meetingResponse.findUnique({ where: { meetingId_userId: { meetingId, userId } }, select: { response: true } });
    if (answer?.response !== "ACCEPTED") throw new Error("NOT_ACCEPTED");
  }

  const now = new Date(); // ONE reading of the clock: the same instant decides the window and is recorded as the join
  const w = L.joinWindow(m.startsAt, m.endsAt, now);
  if (!w.open) throw new Error(w.reason === "TOO_EARLY" ? "JOIN_TOO_EARLY" : "JOIN_CLOSED");

  try {
    await prisma.meetingParticipation.create({ data: { meetingId, platformId: v.platformId, userId, joinedAt: now, source: "SELF" } });
  } catch (e) {
    if (isUnique(e)) throw new Error("ALREADY_JOINED");
    throw e;
  }
  auditNote({ recordType: "Meeting", recordId: meetingId, summary: `Declared joining "${m.title}"`, after: { joinedAt: now } });
  emitMeetingChange([userId, m.organizerId], meetingId);
  return { ok: true, joinedAt: now, late: L.isLate(now, m.startsAt, t.lateAfterMinutes) };
}

/** An invited person accepts or declines. Changeable until they join or the meeting ends. Every answer is kept in the audit log. */
export async function respond(userId: string, meetingId: string, response: unknown) {
  if (!(await responsesReady())) throw new Error("FEATURES_NOT_READY");
  if (response !== "ACCEPTED" && response !== "DECLINED") throw new Error("BAD_RESPONSE");
  const v = await who(userId);
  // Only someone invited. Anyone else: it does not exist as far as they can tell.
  const m = await prisma.meeting.findFirst({
    where: { id: meetingId, platformId: v.platformId, attendees: { some: { userId } } },
    select: { id: true, title: true, startsAt: true, endsAt: true, status: true, organizerId: true },
  });
  if (!m) throw new Error("NOT_FOUND");
  if (String(m.status) === "CANCELLED") throw new Error("MEETING_CANCELLED");
  const now = new Date();
  if (m.endsAt.getTime() < now.getTime()) throw new Error("MEETING_OVER");
  if ((await participationReady()) && (await prisma.meetingParticipation.findUnique({ where: { meetingId_userId: { meetingId, userId } }, select: { id: true } }))) throw new Error("ALREADY_JOINED");

  // A Team Huddle (tracked meeting) is accepted when it STARTS, and accepting is joining: no separate Join step.
  // Before the start there is nothing to accept yet (the person was told it is scheduled); declining is allowed at any time.
  const tracking = (await participationReady()) ? await prisma.meetingTracking.findUnique({ where: { meetingId }, select: { lateAfterMinutes: true } }) : null;
  const live = now.getTime() >= m.startsAt.getTime();
  if (tracking && response === "ACCEPTED" && !live) throw new Error("ACCEPT_WHEN_STARTED");

  const before = await prisma.meetingResponse.findUnique({ where: { meetingId_userId: { meetingId, userId } }, select: { response: true } });
  await prisma.meetingResponse.upsert({
    where: { meetingId_userId: { meetingId, userId } },
    update: { response, respondedAt: now },
    create: { meetingId, platformId: v.platformId, userId, response },
  });
  // Accepting a live huddle = joining it, stamped by the server at this same instant. Not a second record if one already exists.
  let joinedAt: Date | null = null;
  if (tracking && response === "ACCEPTED" && live) {
    try {
      await prisma.meetingParticipation.create({ data: { meetingId, platformId: v.platformId, userId, joinedAt: now, source: "SELF" } });
      joinedAt = now;
      auditNote({ recordType: "Meeting", recordId: meetingId, summary: `Accepted and joined "${m.title}"`, before: before ? { response: before.response } : { response: null }, after: { response, joinedAt: now } });
    } catch (e) {
      if (!isUnique(e)) throw e;
    }
  }
  const word = response === "ACCEPTED" ? "accepted" : "declined";
  if (!joinedAt) auditNote({ recordType: "Meeting", recordId: meetingId, summary: `${response === "ACCEPTED" ? "Accepted" : "Declined"} the invitation to "${m.title}"`, before: before ? { response: before.response } : { response: null }, after: { response } });
  emitMeetingChange([userId, m.organizerId], meetingId);
  try {
    await notifyUsers({
      platformId: v.platformId,
      userIds: [m.organizerId],
      type: "MEETING_RESPONDED",
      title: `${v.name} ${word} "${m.title}"`,
      body: `${v.name} ${word} your invitation to "${m.title}".`,
      link: `/dashboard/meetings?id=${meetingId}`,
      data: { meetingId },
    });
  } catch (e) {
    console.error("[meetings] could not notify the organizer of an answer:", e);
  }
  return { ok: true, response, joinedAt, late: joinedAt && tracking ? L.isLate(joinedAt, m.startsAt, tracking.lateAfterMinutes) : false };
}

export async function leave(userId: string, meetingId: string) {
  await requireReady();
  const v = await who(userId);
  const p = await prisma.meetingParticipation.findUnique({ where: { meetingId_userId: { meetingId, userId } } });
  if (!p || p.platformId !== v.platformId) throw new Error("NOT_JOINED");
  if (p.leftAt) throw new Error("ALREADY_ENDED");

  const m = await prisma.meeting.findUnique({ where: { id: meetingId }, select: { organizerId: true, title: true } });
  const now = new Date();
  // Claim the exit only while it is still open, so a double click (or two tabs) records it once.
  const res = await prisma.meetingParticipation.updateMany({
    where: { id: p.id, leftAt: null },
    data: { leftAt: now, durationSeconds: L.durationSeconds(p.joinedAt, now), endedBy: "SELF" },
  });
  if (res.count === 0) throw new Error("ALREADY_ENDED");
  auditNote({ recordType: "Meeting", recordId: meetingId, summary: `Declared leaving "${m?.title ?? "a meeting"}"`, after: { leftAt: now } });
  if (m) emitMeetingChange([userId, m.organizerId], meetingId);
  return { ok: true, leftAt: now, durationSeconds: L.durationSeconds(p.joinedAt, now) };
}

// The organizer ended the meeting for everyone: every person still marked "in the meeting" is stopped at that same moment.
// Their time runs from their own join to the end moment (never beyond), they are told by the live signal, and the audit log gets one line.
// "MANAGER" is the true description (the manager ended it); a person who already pressed End keeps their own time untouched.
export async function closeOpenAtMeetingEnd(meetingId: string, organizerId: string, title: string, at: Date): Promise<number> {
  if (!(await participationReady())) return 0;
  const open = await prisma.meetingParticipation.findMany({ where: { meetingId, leftAt: null }, select: { id: true, userId: true, joinedAt: true } });
  if (open.length === 0) return 0;
  const closed: string[] = [];
  await prisma.$transaction(async (tx) => {
    for (const p of open) {
      // Only close while still open, so a person pressing End at the same moment is recorded once.
      const stop = p.joinedAt.getTime() > at.getTime() ? p.joinedAt : at;
      const r = await tx.meetingParticipation.updateMany({
        where: { id: p.id, leftAt: null },
        data: { leftAt: stop, durationSeconds: L.durationSeconds(p.joinedAt, stop), endedBy: "MANAGER" },
      });
      if (r.count > 0) closed.push(p.userId);
    }
  });
  if (closed.length > 0) emitMeetingChange([organizerId, ...closed], meetingId);
  return closed.length;
}

// --- the organizing manager: live list and report ---------------------------------------------------------

export async function list(userId: string, meetingId: string) {
  await requireReady();
  const v = await who(userId);
  const m = await prisma.meeting.findFirst({
    where: { id: meetingId, platformId: v.platformId, organizerId: userId },
    select: { id: true, title: true, startsAt: true, endsAt: true, status: true, attendees: { select: { user: { select: { id: true, firstName: true, lastName: true, employeeCode: true, designation: true } } } } },
  });
  if (!m) throw new Error("NOT_FOUND");
  const t = await prisma.meetingTracking.findUnique({ where: { meetingId } });
  if (!t) throw new Error("NOT_TRACKED");

  const [parts, changes, answers] = await Promise.all([
    prisma.meetingParticipation.findMany({ where: { meetingId } }),
    prisma.meetingParticipationChange.groupBy({ by: ["userId"], where: { meetingId }, _count: { _all: true } }),
    (await responsesReady()) ? prisma.meetingResponse.findMany({ where: { meetingId }, select: { userId: true, response: true, respondedAt: true } }) : Promise.resolve([]),
  ]);
  const now = new Date();
  const answerBy = new Map(answers.map((a) => [a.userId, a]));
  const over = m.endsAt.getTime() < now.getTime();
  const pBy = new Map(parts.map((p) => [p.userId, p]));
  const corrected = new Set(changes.map((c) => c.userId));

  const rows = m.attendees
    .map((a) => {
      const p = pBy.get(a.user.id) ?? null;
      const late = p ? L.isLate(p.joinedAt, m.startsAt, t.lateAfterMinutes) : false;
      return {
        userId: a.user.id,
        name: `${a.user.firstName} ${a.user.lastName}`.trim(),
        employeeCode: a.user.employeeCode,
        designation: a.user.designation,
        response: (answerBy.get(a.user.id)?.response as "ACCEPTED" | "DECLINED" | undefined) ?? null,
        respondedAt: answerBy.get(a.user.id)?.respondedAt ?? null,
        status: L.inviteStatus({ response: (answerBy.get(a.user.id)?.response as "ACCEPTED" | "DECLINED" | undefined) ?? null, participation: p, meetingOver: over, tracked: true }),
        state: L.stateOf(p),
        joinedAt: p?.joinedAt ?? null,
        leftAt: p?.leftAt ?? null,
        durationSeconds: p?.durationSeconds ?? null,
        late,
        minutesAfterStart: p && late ? L.minutesAfterStart(p.joinedAt, m.startsAt) : null,
        stillActivePastEnd: p ? L.isStillActivePastEnd(p, m.endsAt, now) : false,
        source: p?.source ?? null,
        corrected: corrected.has(a.user.id),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const joined = rows.filter((r) => r.state !== "NOT_JOINED");
  const ended = rows.filter((r) => r.state === "ENDED");
  const span = L.actualSpan(parts, now);
  const own = pBy.get(userId) ?? null; // the organizer's own record (he can mark himself in and out too); never counted below
  const ownLate = own ? L.isLate(own.joinedAt, m.startsAt, t.lateAfterMinutes) : false;
  return {
    organizer: {
      userId,
      name: v.name,
      state: L.stateOf(own),
      joinedAt: own?.joinedAt ?? null,
      leftAt: own?.leftAt ?? null,
      durationSeconds: own?.durationSeconds ?? null,
      late: ownLate,
      minutesAfterStart: own && ownLate ? L.minutesAfterStart(own.joinedAt, m.startsAt) : null,
      stillActivePastEnd: own ? L.isStillActivePastEnd(own, m.endsAt, now) : false,
    },
    meeting: { id: m.id, title: m.title, startsAt: m.startsAt, endsAt: m.endsAt, status: String(m.status) },
    timezone: v.tz,
    now: now.toISOString(),
    lateAfterMinutes: t.lateAfterMinutes,
    selfReported: true,
    summary: {
      invited: rows.length,
      accepted: rows.filter((r) => r.response === "ACCEPTED").length,
      declined: rows.filter((r) => r.response === "DECLINED").length,
      awaitingAnswer: rows.filter((r) => r.response === null).length,
      joined: joined.length,
      notJoined: rows.length - joined.length,
      inMeeting: rows.filter((r) => r.state === "IN_MEETING").length,
      ended: ended.length,
      late: rows.filter((r) => r.late).length,
      stillActivePastEnd: rows.filter((r) => r.stillActivePastEnd).length,
      actualDurationSeconds: span?.seconds ?? null,
      actualDurationOngoing: span?.ongoing ?? false,
      averageParticipationSeconds: ended.length ? Math.round(ended.reduce((n, r) => n + (r.durationSeconds ?? 0), 0) / ended.length) : null,
    },
    rows,
  };
}

// --- the organizing manager: corrections (always with a reason, always kept as history) -------------------------

export async function correct(userId: string, meetingId: string, targetUserId: string, body: { joinedAt?: unknown; leftAt?: unknown; clearLeft?: unknown; reason?: unknown }) {
  await requireReady();
  const v = await who(userId);
  if (!CREATORS.includes(v.role)) throw new Error("NOT_ALLOWED");
  const m = await prisma.meeting.findFirst({
    where: { id: meetingId, platformId: v.platformId, organizerId: userId },
    select: { id: true, title: true, startsAt: true, attendees: { select: { userId: true } } },
  });
  if (!m) throw new Error("NOT_FOUND");
  if (!(await prisma.meetingTracking.findUnique({ where: { meetingId } }))) throw new Error("NOT_TRACKED");
  if (!m.attendees.some((a) => a.userId === targetUserId)) throw new Error("NOT_INVITED");

  const reason = String(body.reason ?? "").trim();
  if (reason.length < 5) throw new Error("REASON_REQUIRED");
  if (reason.length > 300) throw new Error("REASON_TOO_LONG");

  // Times are typed as HH:MM in the company timezone, on the meeting's own day.
  const day = localDayOf(m.startsAt, v.tz);
  const parse = (x: unknown): Date | null => {
    if (x === undefined || x === null || x === "") return null;
    const s = String(x);
    if (!HHMM.test(s)) throw new Error("BAD_TIME");
    return zonedToUtc(day, s, v.tz);
  };
  const wantJoin = parse(body.joinedAt);
  const wantLeft = parse(body.leftAt);
  const clearLeft = body.clearLeft === true;
  if (clearLeft && wantLeft) throw new Error("BAD_TIME");

  const now = new Date();
  const existing = await prisma.meetingParticipation.findUnique({ where: { meetingId_userId: { meetingId, userId: targetUserId } } });

  let newJoined: Date;
  let newLeft: Date | null;
  if (!existing) {
    if (!wantJoin) throw new Error("JOIN_TIME_REQUIRED"); // recording someone as present needs the time they joined
    newJoined = wantJoin;
    newLeft = wantLeft;
  } else {
    newJoined = wantJoin ?? existing.joinedAt;
    newLeft = clearLeft ? null : wantLeft ?? existing.leftAt;
    const same = newJoined.getTime() === existing.joinedAt.getTime() && (newLeft?.getTime() ?? null) === (existing.leftAt?.getTime() ?? null);
    if (same) throw new Error("NOTHING_TO_CHANGE");
  }
  if (newJoined.getTime() > now.getTime() || (newLeft && newLeft.getTime() > now.getTime())) throw new Error("TIME_IN_FUTURE");
  if (newLeft && newLeft.getTime() < newJoined.getTime()) throw new Error("END_BEFORE_JOIN");

  const leftChanged = newLeft !== null && newLeft.getTime() !== (existing?.leftAt?.getTime() ?? -1);
  const data = {
    joinedAt: newJoined,
    leftAt: newLeft,
    durationSeconds: newLeft ? L.durationSeconds(newJoined, newLeft) : null,
    endedBy: newLeft ? (leftChanged ? "MANAGER" : existing?.endedBy ?? "MANAGER") : null,
  };
  try {
    await prisma.$transaction(async (tx) => {
      if (existing) await tx.meetingParticipation.update({ where: { id: existing.id }, data });
      else await tx.meetingParticipation.create({ data: { meetingId, platformId: v.platformId, userId: targetUserId, source: "MANAGER_ADDED", ...data } });
      await tx.meetingParticipationChange.create({
        data: {
          meetingId, userId: targetUserId, actedById: userId, action: existing ? "EDIT" : "ADD", reason,
          beforeJoinedAt: existing?.joinedAt ?? null, beforeLeftAt: existing?.leftAt ?? null, afterJoinedAt: newJoined, afterLeftAt: newLeft,
        },
      });
    });
  } catch (e) {
    if (isUnique(e)) throw new Error("ALREADY_JOINED"); // the person pressed Join at the same moment
    throw e;
  }

  auditNote({
    recordType: "Meeting", recordId: meetingId, targetUserId,
    summary: `${existing ? "Corrected" : "Added"} participation in "${m.title}"`,
    before: existing ? { joinedAt: existing.joinedAt, leftAt: existing.leftAt } : null,
    after: { joinedAt: newJoined, leftAt: newLeft, reason },
  });
  emitMeetingChange([userId, targetUserId], meetingId);
  // Tell the person, so a corrected record is never a surprise (never allowed to fail the correction).
  await notifyUsers({
    platformId: v.platformId, userIds: [targetUserId], type: "MEETING_PARTICIPATION_CORRECTED",
    title: `Your participation was updated: ${m.title}`,
    body: `${v.name} ${existing ? "corrected" : "recorded"} your participation in "${m.title}". Reason: ${reason}`,
    link: `/dashboard/meetings?id=${meetingId}`, data: { meetingId },
  });
  return { ok: true };
}

// --- history ------------------------------------------------------------------------------------------------

/** Your own history, or (for the organizing manager) one person's history in the meetings YOU organized. */
export async function history(userId: string, personId?: string) {
  await requireReady();
  const v = await who(userId);
  if (personId && !/^[0-9a-f-]{36}$/i.test(personId)) throw new Error("NOT_FOUND");
  const person = personId && personId !== userId ? personId : userId;
  if (person !== userId && !CREATORS.includes(v.role)) throw new Error("NOT_ALLOWED");

  const invitesRaw = await prisma.meetingAttendee.findMany({
    where: { userId: person, meeting: { platformId: v.platformId, status: "SCHEDULED", ...(person !== userId ? { organizerId: userId } : {}) } },
    select: { meeting: { select: { id: true, title: true, startsAt: true, endsAt: true } } },
    orderBy: { meeting: { startsAt: "desc" } },
    take: 200,
  });
  // Your own history also covers meetings you ORGANIZED (you can mark yourself in and out too).
  const organized = person === userId
    ? await prisma.meeting.findMany({ where: { platformId: v.platformId, organizerId: userId, status: "SCHEDULED" }, select: { id: true, title: true, startsAt: true, endsAt: true }, orderBy: { startsAt: "desc" }, take: 200 })
    : [];
  const seen = new Set(invitesRaw.map((i) => i.meeting.id));
  const invites = [...invitesRaw, ...organized.filter((o) => !seen.has(o.id)).map((o) => ({ meeting: o }))].sort((a, b) => b.meeting.startsAt.getTime() - a.meeting.startsAt.getTime());
  const ids = invites.map((i) => i.meeting.id);
  const tracking = ids.length ? await prisma.meetingTracking.findMany({ where: { meetingId: { in: ids } } }) : [];
  const tBy = new Map(tracking.map((t) => [t.meetingId, t]));
  const trackedIds = tracking.map((t) => t.meetingId);
  const [parts, changes] = trackedIds.length
    ? await Promise.all([
        prisma.meetingParticipation.findMany({ where: { userId: person, meetingId: { in: trackedIds } } }),
        prisma.meetingParticipationChange.groupBy({ by: ["meetingId"], where: { userId: person, meetingId: { in: trackedIds } }, _count: { _all: true } }),
      ])
    : [[], []];
  const pBy = new Map(parts.map((p) => [p.meetingId, p]));
  const cBy = new Set(changes.map((c) => c.meetingId));
  const now = new Date();

  const rows = invites
    .filter((i) => tBy.has(i.meeting.id))
    // A meeting that has not finished yet is not a "missed" meeting: it only appears once there is a record or it is over.
    .filter((i) => pBy.has(i.meeting.id) || i.meeting.endsAt.getTime() < now.getTime())
    .map((i) => {
      const p = pBy.get(i.meeting.id) ?? null;
      const t = tBy.get(i.meeting.id)!;
      return {
        meetingId: i.meeting.id, title: i.meeting.title, startsAt: i.meeting.startsAt, endsAt: i.meeting.endsAt,
        state: L.stateOf(p), joinedAt: p?.joinedAt ?? null, leftAt: p?.leftAt ?? null, durationSeconds: p?.durationSeconds ?? null,
        late: p ? L.isLate(p.joinedAt, i.meeting.startsAt, t.lateAfterMinutes) : false, corrected: cBy.has(i.meeting.id), source: p?.source ?? null,
      };
    });
  const endedRows = rows.filter((r) => r.state === "ENDED");
  return {
    timezone: v.tz,
    selfReported: true,
    personId: person,
    summary: {
      meetings: rows.length,
      joined: rows.filter((r) => r.state !== "NOT_JOINED").length,
      notJoined: rows.filter((r) => r.state === "NOT_JOINED").length,
      late: rows.filter((r) => r.late).length,
      averageSeconds: endedRows.length ? Math.round(endedRows.reduce((n, r) => n + (r.durationSeconds ?? 0), 0) / endedRows.length) : null,
    },
    rows,
  };
}

// --- HR / Admin: counts only ---------------------------------------------------------------------------------------

export async function counts(viewerId: string, meetingId: string) {
  await requireReady();
  const v = await who(viewerId);
  if (!OVERSIGHT.includes(v.role)) throw new Error("NOT_ALLOWED");
  const m = await prisma.meeting.findFirst({ where: { id: meetingId, platformId: v.platformId }, select: { id: true, organizerId: true, _count: { select: { attendees: true } } } });
  if (!m) throw new Error("NOT_FOUND");
  if (!(await prisma.meetingTracking.findUnique({ where: { meetingId } }))) throw new Error("NOT_TRACKED");
  const [joined, accepted, declined] = await Promise.all([
    prisma.meetingParticipation.count({ where: { meetingId, userId: { not: m.organizerId } } }),
    (await responsesReady()) ? prisma.meetingResponse.count({ where: { meetingId, response: "ACCEPTED" } }) : Promise.resolve(0),
    (await responsesReady()) ? prisma.meetingResponse.count({ where: { meetingId, response: "DECLINED" } }) : Promise.resolve(0),
  ]);
  return { invited: m._count.attendees, accepted, declined, joined };
}

// --- productive-time breakdown (shared by the employee and manager screens) -----------------------------------------

/**
 * The Team Huddle records of one person that could overlap one work session, shaped for computeBreakdown.
 * Reads existing records only. Returns [] before the migration (nobody has a huddle then).
 */
export async function huddlesForSession(userId: string, loginAt: Date, logoutAt: Date | null, now: Date) {
  if (!(await participationReady())) return [];
  const from = new Date(loginAt.getTime() - 6 * 3_600_000);
  const to = logoutAt ?? now;
  const rows = await prisma.meetingParticipation.findMany({
    where: { userId, joinedAt: { gte: from, lte: to } },
    select: { id: true, meetingId: true, joinedAt: true, leftAt: true, source: true },
    orderBy: { joinedAt: "asc" },
  });
  if (rows.length === 0) return [];
  const meetings = await prisma.meeting.findMany({
    where: { id: { in: rows.map((r) => r.meetingId) } },
    select: { id: true, title: true, startsAt: true, endsAt: true },
  });
  const by = new Map(meetings.map((m) => [m.id, m]));
  return rows.flatMap((r) => {
    const m = by.get(r.meetingId);
    return m ? [{ id: r.id, meetingId: r.meetingId, title: m.title, startsAt: m.startsAt, expectedEnd: m.endsAt, joinedAt: r.joinedAt, leftAt: r.leftAt, source: r.source }] : [];
  });
}

// --- manager: today's huddles and each reporting employee's breakdown --------------------------------------------------

/**
 * For a MANAGER: the huddles they organize on a day, restricted to THEIR reporting employees (the teams they run plus
 * direct reports, same rule as Live Team), and each of those people's productive-time split for that day.
 * Uses the same computeBreakdown as the employee's own screen. Batched reads, joined in memory.
 */
export async function managerOverview(userId: string, dayStr?: string) {
  await requireReady();
  const v = await who(userId);
  if (v.role !== "MANAGER") throw new Error("NOT_ALLOWED");
  const today = platformToday(v.tz);
  const day = dayStr ? parseIsoDay(dayStr) : today;
  const dayIso = day.toISOString().slice(0, 10);
  const scope = new Set(await visibleUserIds({ id: userId, role: v.role, platformId: v.platformId }));
  const now = new Date();

  const tracked = await prisma.meetingTracking.findMany({ select: { meetingId: true, lateAfterMinutes: true }, where: { platformId: v.platformId } });
  const tBy = new Map(tracked.map((t) => [t.meetingId, t.lateAfterMinutes]));
  const mine = await prisma.meeting.findMany({
    where: { platformId: v.platformId, organizerId: userId, status: "SCHEDULED", id: { in: [...tBy.keys()] } },
    select: { id: true, title: true, startsAt: true, endsAt: true, attendees: { select: { user: { select: { id: true, firstName: true, lastName: true, employeeCode: true } } } } },
    orderBy: { startsAt: "asc" },
  });
  // only the meetings that start on the chosen company day
  const onDay = mine.filter((m) => localDayOf(m.startsAt, v.tz) === dayIso);

  const nameOf = new Map<string, { name: string; code: string | null }>();
  for (const m of onDay) for (const a of m.attendees) if (scope.has(a.user.id)) nameOf.set(a.user.id, { name: `${a.user.firstName} ${a.user.lastName}`.trim(), code: a.user.employeeCode });
  const ids = [...nameOf.keys()];

  const [parts, sessions] = ids.length
    ? await Promise.all([
        prisma.meetingParticipation.findMany({ where: { meetingId: { in: onDay.map((m) => m.id) }, userId: { in: ids } } }),
        prisma.workSession.findMany({ where: { userId: { in: ids }, date: day }, include: { breaks: true, meetings: true } }),
      ])
    : [[], []];
  const pBy = new Map(parts.map((p) => [`${p.meetingId}|${p.userId}`, p]));
  const sBy = new Map(sessions.map((s) => [s.userId, s]));
  const endOf = new Map(onDay.map((m) => [m.id, m.endsAt]));

  const people = ids
    .map((id) => {
      const s = sBy.get(id) ?? null;
      const huddles = parts.filter((p) => p.userId === id).flatMap((p) => (endOf.has(p.meetingId) ? [{ id: p.id, joinedAt: p.joinedAt, leftAt: p.leftAt, expectedEnd: endOf.get(p.meetingId) as Date }] : []));
      const onSiteSeconds = s ? Math.max(0, Math.floor(((s.logoutAt ?? now).getTime() - s.loginAt.getTime()) / 1000)) : 0;
      const b = s
        ? computeBreakdown({
            loginAt: s.loginAt, logoutAt: s.logoutAt,
            breaks: awayRows(s.breaks).map((x) => ({ startedAt: x.startedAt, endedAt: x.endedAt })),
            liveMeetings: s.meetings.map((x) => ({ approvalStatus: String(x.approvalStatus), startedAt: x.startedAt, endedAt: x.endedAt })),
            huddles, now,
          })
        : null;
      return {
        userId: id, name: nameOf.get(id)!.name, employeeCode: nameOf.get(id)!.code, clockedIn: !!s,
        regularSeconds: b?.regularSeconds ?? 0, huddleSeconds: b?.huddleSeconds ?? 0, otherEligibleSeconds: b?.otherEligibleSeconds ?? 0, totalSeconds: b?.productiveSeconds ?? 0,
        // Time on site = clocked in to clocked out (or now); breaks are what is left once productive time is taken out. Derived, never stored.
        onSiteSeconds,
        // Away time is split by kind: breaks (Tea/Lunch/Personal/Other) and washroom, which is neutral and never counts as break.
        ...(s ? (({ breakSeconds, washroomSeconds }) => ({ breakSeconds, washroomSeconds }))(splitAwayTime(s.breaks, now)) : { breakSeconds: 0, washroomSeconds: 0 }),
      };
    })
    .sort((x, y) => x.name.localeCompare(y.name));

  return {
    date: dayIso, timezone: v.tz, now: now.toISOString(), selfReported: true,
    meetings: onDay.map((m) => {
      const late = tBy.get(m.id) ?? 5;
      const rows = m.attendees
        .filter((a) => scope.has(a.user.id))
        .map((a) => {
          const p = pBy.get(`${m.id}|${a.user.id}`) ?? null;
          const sess = sBy.get(a.user.id) ?? null;
          const calc = sess && p
            ? computeBreakdown({
                loginAt: sess.loginAt, logoutAt: sess.logoutAt,
                breaks: awayRows(sess.breaks).map((x) => ({ startedAt: x.startedAt, endedAt: x.endedAt })), liveMeetings: [],
                huddles: [{ id: p.id, joinedAt: p.joinedAt, leftAt: p.leftAt, expectedEnd: m.endsAt }], now,
              })
            : null;
          return {
            userId: a.user.id, name: `${a.user.firstName} ${a.user.lastName}`.trim(), employeeCode: a.user.employeeCode,
            state: L.stateOf(p), joinedAt: p?.joinedAt ?? null, leftAt: p?.leftAt ?? null, durationSeconds: p?.leftAt ? p.durationSeconds : null,
            late: p ? L.isLate(p.joinedAt, m.startsAt, late) : false,
            countedSeconds: calc?.huddleSeconds ?? 0, // the part that counts towards productive time (inside clock-in, outside breaks)
            openPastEnd: p ? L.isStillActivePastEnd(p, m.endsAt, now) : false,
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
      return {
        id: m.id, title: m.title, startsAt: m.startsAt, endsAt: m.endsAt, lateAfterMinutes: late,
        summary: {
          invited: rows.length,
          joined: rows.filter((r) => r.state !== "NOT_JOINED").length,
          notJoined: rows.filter((r) => r.state === "NOT_JOINED").length,
          inMeeting: rows.filter((r) => r.state === "IN_MEETING").length,
          late: rows.filter((r) => r.late).length,
        },
        rows,
      };
    }),
    people,
  };
}

// --- meeting time per person for the Attendance screens ----------------------------------------------------------------

type SessionForMeetings = {
  userId: string; loginAt: Date; logoutAt: Date | null;
  breaks: { breakType: string; reason?: string | null; startedAt: Date; endedAt: Date | null }[];
  meetings: { approvalStatus: unknown; startedAt: Date | null; endedAt: Date | null }[];
};

/**
 * For the people in `sessions` who actually have Team Huddle participation around their session: the huddle seconds and the other eligible
 * (live, approved) meeting seconds, merged so an overlap is counted once, limited to the clocked-in period and outside breaks
 * (the same computeBreakdown as every other screen). People with no huddle participation are NOT in the map: callers keep their
 * existing live-meeting figure untouched. Batched: one read of participation and one of meetings. Empty before the migration.
 */
export async function huddleBreakdowns(sessions: SessionForMeetings[], now: Date): Promise<Map<string, { huddleSeconds: number; otherSeconds: number; openPastEnd: boolean }>> {
  const out = new Map<string, { huddleSeconds: number; otherSeconds: number; openPastEnd: boolean }>();
  if (sessions.length === 0 || !(await participationReady())) return out;
  const ids = [...new Set(sessions.map((s) => s.userId))];
  const lo = Math.min(...sessions.map((s) => s.loginAt.getTime())) - 6 * 3_600_000;
  const hi = Math.max(...sessions.map((s) => (s.logoutAt ?? now).getTime()));
  const parts = await prisma.meetingParticipation.findMany({
    where: { userId: { in: ids }, joinedAt: { gte: new Date(lo), lte: new Date(hi) } },
    select: { id: true, meetingId: true, userId: true, joinedAt: true, leftAt: true },
  });
  if (parts.length === 0) return out;
  const meetings = await prisma.meeting.findMany({ where: { id: { in: [...new Set(parts.map((p) => p.meetingId))] } }, select: { id: true, endsAt: true } });
  const endOf = new Map(meetings.map((m) => [m.id, m.endsAt]));
  for (const s of sessions) {
    const mineParts = parts.filter((p) => p.userId === s.userId && p.joinedAt.getTime() >= s.loginAt.getTime() - 6 * 3_600_000 && p.joinedAt.getTime() <= (s.logoutAt ?? now).getTime() && endOf.has(p.meetingId));
    if (mineParts.length === 0) continue;
    const b = computeBreakdown({
      loginAt: s.loginAt, logoutAt: s.logoutAt, breaks: awayRows(s.breaks),
      liveMeetings: s.meetings.map((m) => ({ approvalStatus: String(m.approvalStatus), startedAt: m.startedAt, endedAt: m.endedAt })),
      huddles: mineParts.map((p) => ({ id: p.id, joinedAt: p.joinedAt, leftAt: p.leftAt, expectedEnd: endOf.get(p.meetingId) as Date })), now,
    });
    out.set(s.userId, { huddleSeconds: b.huddleSeconds, otherSeconds: b.otherEligibleSeconds, openPastEnd: b.huddles.some((h) => h.openPastEnd) });
  }
  return out;
}

/**
 * What the clock-in card needs to show a live Team Huddle counter: the huddle time that counts so far today (same rules as everywhere
 * else, computeBreakdown), and when the person's current huddle began if they are in one right now. A huddle left open past its
 * expected end is not shown as running (it is capped, and the record stays open for a manager correction). Display only: nothing here
 * is added to productive time, the huddle is already inside it.
 */
export async function liveHuddle(session: SessionForMeetings, now: Date): Promise<{ todaySeconds: number; activeSince: string | null; openPastEnd: boolean; openMeetingId: string | null }> {
  const none = { todaySeconds: 0, activeSince: null as string | null, openPastEnd: false, openMeetingId: null as string | null };
  if (!(await participationReady())) return none;
  const b = (await huddleBreakdowns([session], now)).get(session.userId);
  const open = await prisma.meetingParticipation.findFirst({
    where: { userId: session.userId, leftAt: null, joinedAt: { gte: new Date(session.loginAt.getTime() - 6 * 3_600_000) } },
    orderBy: { joinedAt: "desc" },
    select: { joinedAt: true, meetingId: true },
  });
  const openPastEnd = !!b?.openPastEnd;
  // openMeetingId is set whenever the person has not ended a huddle, even past its scheduled end, so the card can offer End Huddle.
  return { todaySeconds: b?.huddleSeconds ?? 0, activeSince: open && !openPastEnd ? open.joinedAt.toISOString() : null, openPastEnd, openMeetingId: open?.meetingId ?? null };
}

/**
 * The huddles this person joined and has not ended yet (recent ones only). The meetings list keeps these visible after the scheduled end,
 * so a person who is still marked "in the huddle" can always press End Huddle: before, the screen switched to a read-only record at the
 * scheduled end and the End button vanished, leaving the record open (counted only to the expected end, flagged "not ended").
 */
export async function openMeetingIds(userId: string): Promise<string[]> {
  if (!(await participationReady())) return [];
  const rows = await prisma.meetingParticipation.findMany({
    where: { userId, leftAt: null, joinedAt: { gte: new Date(Date.now() - 2 * 86_400_000) } },
    select: { meetingId: true },
  });
  return rows.map((r) => r.meetingId);
}

// --- Team Huddle seconds per person per day (for Reports and My History) -----------------------------------------------

/**
 * Team Huddle time that counted, per person and company day: "userId|YYYY-MM-DD" -> seconds. Same rules as the employee and manager
 * screens (computeBreakdown): inside clock-in, outside breaks, never counted twice, open records capped at the expected end. It is a
 * LABEL on productive time, never an addition, and a finished day can never show more huddle time than its stored productive total.
 * Batched reads, joined in memory. Returns an empty map before the migration.
 */
export async function huddleSecondsByDay(userIds: string[], from: Date, to: Date): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (userIds.length === 0 || !(await participationReady())) return out;
  const sessions = await prisma.workSession.findMany({
    where: { userId: { in: userIds }, date: { gte: from, lte: to } },
    select: { userId: true, date: true, status: true, loginAt: true, logoutAt: true, productiveSeconds: true, breaks: { select: { breakType: true, reason: true, startedAt: true, endedAt: true } } },
  });
  if (sessions.length === 0) return out;
  const parts = await prisma.meetingParticipation.findMany({
    where: { userId: { in: userIds }, joinedAt: { gte: new Date(from.getTime() - 2 * 86_400_000), lte: new Date(to.getTime() + 3 * 86_400_000) } },
    select: { id: true, meetingId: true, userId: true, joinedAt: true, leftAt: true },
  });
  if (parts.length === 0) return out;
  const meetings = await prisma.meeting.findMany({ where: { id: { in: [...new Set(parts.map((p) => p.meetingId))] } }, select: { id: true, endsAt: true } });
  const endOf = new Map(meetings.map((m) => [m.id, m.endsAt]));
  const now = new Date();
  for (const s of sessions) {
    const lo = s.loginAt.getTime() - 6 * 3_600_000;
    const hi = (s.logoutAt ?? now).getTime();
    const mine = parts.filter((p) => p.userId === s.userId && p.joinedAt.getTime() >= lo && p.joinedAt.getTime() <= hi && endOf.has(p.meetingId));
    if (mine.length === 0) continue;
    const b = computeBreakdown({
      loginAt: s.loginAt, logoutAt: s.logoutAt, breaks: awayRows(s.breaks), liveMeetings: [],
      huddles: mine.map((p) => ({ id: p.id, joinedAt: p.joinedAt, leftAt: p.leftAt, expectedEnd: endOf.get(p.meetingId) as Date })), now,
    });
    const secs = String(s.status) === "COMPLETED" ? Math.min(b.huddleSeconds, s.productiveSeconds) : b.huddleSeconds;
    if (secs > 0) out.set(`${s.userId}|${s.date.toISOString().slice(0, 10)}`, secs);
  }
  return out;
}
