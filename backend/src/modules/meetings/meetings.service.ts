import { prisma } from "../../lib/prisma.js";
import { parseIsoDay, zonedToUtc, localDayOf } from "../../lib/dates.js";
import { notifyUsers } from "../../lib/notify.js";
import { sendMail } from "../../lib/mailer.js";
import { meetingEmail } from "../../lib/emails.js";
import { auditNote, changedFields } from "../../lib/auditContext.js";
import * as part from "./participation.service.js";

// ---------------------------------------------------------------------------
// MEETINGS (scheduled meetings with a pasted link)
//
// The organizer pastes an existing Google Meet / Teams / Zoom / other https link.
// Nothing here creates meetings at those providers or needs any integration.
//
// Privacy: a meeting's details (description, link, who is invited) are visible to the
// organizer and the invited people ONLY, including HR and Admin. HR/Admin get an oversight
// list with just title, organizer, time and head-count, and may cancel any meeting in their
// company. Only the organizer can edit a meeting.
//
// This is separate from tracker_meetings (the live "I am in a meeting now" time tracking).
// Nothing here touches attendance or worked hours.
// ---------------------------------------------------------------------------

const CREATORS = ["MANAGER", "HR", "ADMIN"];
const OVERSIGHT = ["HR", "ADMIN"];
const MAX_ATTENDEES = 100;
const MAX_HOURS = 12;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const HOUR_MS = 3_600_000;

async function who(userId: string) {
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, role: true, platformId: true, firstName: true, lastName: true, platform: { select: { name: true, timezone: true } } },
  });
  if (!u) throw new Error("USER_NOT_FOUND");
  return { id: u.id, role: String(u.role), platformId: u.platformId, name: `${u.firstName} ${u.lastName}`.trim(), company: u.platform.name, tz: u.platform.timezone };
}

// --- the link ----------------------------------------------------------------------------------

export function cleanUrl(raw: unknown): { url: string; provider: string } | null {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  if (text.length > 500) throw new Error("BAD_URL");
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    throw new Error("BAD_URL");
  }
  // https only (no javascript:, data:, file:, http:), no embedded credentials.
  if (u.protocol !== "https:" || u.username || u.password) throw new Error("BAD_URL");
  const host = u.hostname.toLowerCase();
  if (!host.includes(".") || host === "localhost" || /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith("[") || /\.(local|internal|localhost)$/.test(host)) throw new Error("BAD_URL");
  const provider =
    host === "meet.google.com" ? "Google Meet"
    : host === "teams.microsoft.com" || host === "teams.live.com" ? "Microsoft Teams"
    : host === "zoom.us" || host.endsWith(".zoom.us") ? "Zoom"
    : "Other link";
  return { url: u.toString(), provider };
}

// --- time ---------------------------------------------------------------------------------------

function whenText(startsAt: Date, endsAt: Date, tz: string) {
  const day = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", day: "2-digit", month: "short", year: "numeric" }).format(startsAt);
  const t = (d: Date) => new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true }).format(d);
  return `${day}, ${t(startsAt)} to ${t(endsAt)} (${tz})`;
}

type Fields = { title?: unknown; description?: unknown; date?: unknown; startTime?: unknown; endTime?: unknown; meetingUrl?: unknown; attendeeIds?: unknown; inPerson?: unknown; lateAfterMinutes?: unknown };

function parseWhen(f: Fields, tz: string) {
  const day = parseIsoDay(f.date);
  const dateIso = day.toISOString().slice(0, 10);
  const st = String(f.startTime ?? "");
  const et = String(f.endTime ?? "");
  if (!HHMM.test(st) || !HHMM.test(et)) throw new Error("BAD_TIME");
  const startsAt = zonedToUtc(dateIso, st, tz);
  const endsAt = zonedToUtc(dateIso, et, tz);
  if (endsAt.getTime() <= startsAt.getTime()) throw new Error("BAD_RANGE");
  if (endsAt.getTime() - startsAt.getTime() > MAX_HOURS * HOUR_MS) throw new Error("TOO_LONG");
  return { startsAt, endsAt };
}

async function checkAttendees(raw: unknown, organizerId: string, platformId: string) {
  if (!Array.isArray(raw)) throw new Error("ATTENDEES_REQUIRED");
  const ids = [...new Set(raw.map(String))].filter((id) => id !== organizerId);
  if (ids.length === 0) throw new Error("ATTENDEES_REQUIRED");
  if (ids.length > MAX_ATTENDEES) throw new Error("TOO_MANY");
  if (ids.some((id) => !/^[0-9a-f-]{36}$/i.test(id))) throw new Error("ATTENDEE_NOT_FOUND");
  // Only active people of the organizer's OWN company can be invited.
  const found = await prisma.user.findMany({
    where: { id: { in: ids }, platformId, status: { notIn: ["EXITED", "SUSPENDED"] } },
    select: { id: true, firstName: true, lastName: true, email: true },
  });
  if (found.length !== ids.length) throw new Error("ATTENDEE_NOT_FOUND");
  return found;
}

function title(v: unknown) {
  const t = String(v ?? "").trim();
  if (t.length < 2) throw new Error("TITLE_REQUIRED");
  if (t.length > 120) throw new Error("TITLE_TOO_LONG");
  return t;
}
function description(v: unknown) {
  const d = String(v ?? "").trim();
  if (d.length > 1000) throw new Error("DESCRIPTION_TOO_LONG");
  return d || null;
}

// --- notifications (never allowed to fail the action) -----------------------------------------

async function tell(
  organizer: { id: string; name: string; platformId: string; company: string; tz: string },
  meeting: { id: string; title: string; startsAt: Date; endsAt: Date; meetingUrl: string | null },
  people: { id: string; firstName: string; email: string | null }[],
  kind: "invited" | "updated" | "cancelled" | "removed",
  note: string | null
) {
  if (people.length === 0) return;
  const when = whenText(meeting.startsAt, meeting.endsAt, organizer.tz);
  const head = { invited: "Meeting invitation", updated: "Meeting updated", cancelled: "Meeting cancelled", removed: "Removed from a meeting" }[kind];
  await notifyUsers({
    platformId: organizer.platformId,
    userIds: people.map((p) => p.id),
    type: `MEETING_${kind.toUpperCase()}`,
    title: `${head}: ${meeting.title}`,
    body: `${organizer.name} ${{ invited: "invited you to", updated: "changed", cancelled: "cancelled", removed: "removed you from" }[kind]} "${meeting.title}", ${when}.${note ? ` ${note}` : ""}`,
    link: kind === "cancelled" || kind === "removed" ? "/dashboard/meetings" : `/dashboard/meetings?id=${meeting.id}`,
    data: { meetingId: meeting.id },
  });
  await Promise.allSettled(
    people.filter((p) => p.email && !p.email.endsWith(".local")).map((p) =>
      sendMail({ to: p.email as string, ...meetingEmail({ company: organizer.company, kind, firstName: p.firstName, title: meeting.title, when, organizer: organizer.name, joinUrl: meeting.meetingUrl, note }) })
    )
  );
}

// --- shaping ------------------------------------------------------------------------------------

type Row = {
  id: string; title: string; description: string | null; startsAt: Date; endsAt: Date; meetingUrl: string | null; provider: string | null;
  status: unknown; cancelledAt: Date | null; cancelReason: string | null; organizerId: string;
  organizer: { firstName: string; lastName: string };
  attendees: { user: { id: string; firstName: string; lastName: string; employeeCode: string | null } }[];
};

function view(m: Row, viewer: { id: string; role: string }, now: Date) {
  const cancelled = String(m.status) === "CANCELLED";
  const over = m.endsAt.getTime() < now.getTime();
  const isOrganizer = m.organizerId === viewer.id;
  return {
    id: m.id,
    title: m.title,
    description: m.description,
    startsAt: m.startsAt,
    endsAt: m.endsAt,
    state: cancelled ? "cancelled" : over ? "past" : m.startsAt.getTime() <= now.getTime() ? "ongoing" : "upcoming",
    status: String(m.status),
    cancelReason: m.cancelReason,
    organizer: `${m.organizer.firstName} ${m.organizer.lastName}`.trim(),
    organizerId: m.organizerId,
    attendees: m.attendees.map((a) => ({ id: a.user.id, name: `${a.user.firstName} ${a.user.lastName}`.trim(), employeeCode: a.user.employeeCode })),
    meetingUrl: cancelled ? null : m.meetingUrl,
    provider: m.meetingUrl ? m.provider : null,
    isOrganizer,
    canEdit: isOrganizer && !cancelled && !over,
    canCancel: (isOrganizer || OVERSIGHT.includes(viewer.role)) && !cancelled && !over,
    canEnd: isOrganizer && !cancelled && !over && m.startsAt.getTime() <= now.getTime(),
  };
}

const include = {
  organizer: { select: { firstName: true, lastName: true } },
  attendees: { select: { user: { select: { id: true, firstName: true, lastName: true, employeeCode: true } } } },
} as const;

// --- reads --------------------------------------------------------------------------------------

export async function listMine(userId: string, f: { scope?: unknown; q?: unknown }) {
  const v = await who(userId);
  const now = new Date();
  const scope = (["upcoming", "past", "cancelled"] as const).find((s) => s === f.scope) ?? "upcoming";
  const q = String(f.q ?? "").trim().slice(0, 100);
  const mine = { OR: [{ organizerId: userId }, { attendees: { some: { userId } } }] };
  // A huddle you joined and have not ended stays in "upcoming" after its scheduled end, so the End Huddle button never disappears.
  const stillIn = scope === "upcoming" ? await part.openMeetingIds(userId) : [];
  const where = {
    platformId: v.platformId,
    ...mine,
    ...(q ? { title: { contains: q, mode: "insensitive" as const } } : {}),
    ...(scope === "upcoming" ? { status: "SCHEDULED" as const, ...(stillIn.length ? { AND: [{ OR: [{ endsAt: { gte: now } }, { id: { in: stillIn } }] }] } : { endsAt: { gte: now } }) } : scope === "past" ? { status: "SCHEDULED" as const, endsAt: { lt: now } } : { status: "CANCELLED" as const }),
  };
  const [rows, counts] = await Promise.all([
    prisma.meeting.findMany({ where, include, orderBy: { startsAt: scope === "upcoming" ? "asc" : "desc" }, take: 200 }),
    Promise.all([
      prisma.meeting.count({ where: { platformId: v.platformId, ...mine, status: "SCHEDULED", endsAt: { gte: now } } }),
      prisma.meeting.count({ where: { platformId: v.platformId, ...mine, status: "SCHEDULED", endsAt: { lt: now } } }),
      prisma.meeting.count({ where: { platformId: v.platformId, ...mine, status: "CANCELLED" } }),
    ]),
  ]);
  const views = rows.map((m) => view(m as unknown as Row, v, now));
  // In-person meetings carry participation fields (the viewer's own record, the join window, the joined count for the organizer).
  const extras = await part.extrasFor(views.map((x) => ({ id: x.id, startsAt: x.startsAt, endsAt: x.endsAt, isOrganizer: x.isOrganizer, status: x.status })), userId, now);
  return {
    timezone: v.tz,
    canCreate: CREATORS.includes(v.role),
    counts: { upcoming: counts[0], past: counts[1], cancelled: counts[2] },
    meetings: views.map((x) => ({ ...x, ...(extras.get(x.id) ?? {}) })),
  };
}

export async function getOne(userId: string, id: string) {
  const v = await who(userId);
  const m = await prisma.meeting.findFirst({
    where: { id, platformId: v.platformId, OR: [{ organizerId: userId }, { attendees: { some: { userId } } }] },
    include,
  });
  // Not invited and not the organizer: it does not exist as far as this person can tell.
  if (!m) throw new Error("NOT_FOUND");
  const now = new Date();
  const one = view(m as unknown as Row, v, now);
  const extras = await part.extrasFor([{ id: one.id, startsAt: one.startsAt, endsAt: one.endsAt, isOrganizer: one.isOrganizer, status: one.status }], userId, now);
  return { timezone: v.tz, ...one, ...(extras.get(one.id) ?? {}) };
}

// HR/Admin oversight: no description, link or names.
export async function oversight(userId: string, f: { scope?: unknown }) {
  const v = await who(userId);
  if (!OVERSIGHT.includes(v.role)) throw new Error("NOT_ALLOWED");
  const now = new Date();
  const scope = (["upcoming", "past", "cancelled"] as const).find((s) => s === f.scope) ?? "upcoming";
  const rows = await prisma.meeting.findMany({
    where: { platformId: v.platformId, ...(scope === "upcoming" ? { status: "SCHEDULED", endsAt: { gte: now } } : scope === "past" ? { status: "SCHEDULED", endsAt: { lt: now } } : { status: "CANCELLED" }) },
    select: { id: true, title: true, startsAt: true, endsAt: true, status: true, organizer: { select: { firstName: true, lastName: true } }, _count: { select: { attendees: true } } },
    orderBy: { startsAt: scope === "upcoming" ? "asc" : "desc" },
    take: 200,
  });
  // In-person meetings: HR/Admin get the COUNTS (invited, joined) and nothing else: no names, times or durations.
  const joined = await part.joinedCounts(rows.map((r) => r.id));
  return {
    timezone: v.tz,
    meetings: rows.map((m) => ({
      id: m.id,
      title: m.title,
      startsAt: m.startsAt,
      endsAt: m.endsAt,
      status: String(m.status),
      organizer: `${m.organizer.firstName} ${m.organizer.lastName}`.trim(),
      attendeeCount: m._count.attendees,
      participation: joined.has(m.id) ? { invited: m._count.attendees, joined: joined.get(m.id) ?? 0 } : null,
      canCancel: String(m.status) === "SCHEDULED" && m.endsAt.getTime() >= now.getTime(),
    })),
  };
}

export async function people(userId: string) {
  const v = await who(userId);
  if (!CREATORS.includes(v.role)) throw new Error("NOT_ALLOWED");
  const rows = await prisma.user.findMany({
    where: { platformId: v.platformId, status: { notIn: ["EXITED", "SUSPENDED"] }, id: { not: userId } },
    select: { id: true, firstName: true, lastName: true, employeeCode: true, designation: true },
    orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
    take: 1000,
  });
  return { people: rows.map((r) => ({ id: r.id, name: `${r.firstName} ${r.lastName}`.trim(), employeeCode: r.employeeCode, designation: r.designation })) };
}

// --- writes -------------------------------------------------------------------------------------

export async function create(userId: string, body: Fields) {
  const v = await who(userId);
  if (!CREATORS.includes(v.role)) throw new Error("NOT_ALLOWED");
  const t = title(body.title);
  const d = description(body.description);
  const { startsAt, endsAt } = parseWhen(body, v.tz);
  // A meeting cannot be scheduled in the past (a few minutes of slack for the clock).
  if (startsAt.getTime() < Date.now() - 5 * 60_000) throw new Error("PAST_MEETING");
  // An in-person meeting has no link; it is tracked by "I'm in the Meeting" instead.
  const attendees = await checkAttendees(body.attendeeIds, userId, v.platformId);
  let inPerson = body.inPerson === true;
  // Team Huddle tracking switches ON by itself when a MANAGER invites only people who report to them and gives no meeting link (a link means an
  // online meeting). Without this, a meeting made without the tick had no Accept/Join buttons for anyone. An explicit choice is never overridden.
  if (body.inPerson === undefined && v.role === "MANAGER" && !String(body.meetingUrl ?? "").trim() && (await part.participationReady())) {
    try {
      await part.assertReportingEmployees(v, attendees.map((a) => a.id));
      inPerson = true;
    } catch {
      inPerson = false;
    }
  }
  if (inPerson && !(await part.participationReady())) throw new Error("FEATURES_NOT_READY");
  const lateAfter = inPerson ? part.cleanLateAfter(body.lateAfterMinutes) : 5;
  const link = inPerson ? null : cleanUrl(body.meetingUrl);
  if (inPerson) await part.assertReportingEmployees(v, attendees.map((a) => a.id));

  const created = await prisma.$transaction(async (tx) => {
    const m = await tx.meeting.create({
      data: { platformId: v.platformId, organizerId: userId, title: t, description: d, startsAt, endsAt, meetingUrl: link?.url ?? null, provider: link?.provider ?? null },
    });
    await tx.meetingAttendee.createMany({ data: attendees.map((a) => ({ meetingId: m.id, userId: a.id })) });
    if (inPerson) await part.enableTracking(tx, { meetingId: m.id, platformId: v.platformId, createdById: userId, lateAfterMinutes: lateAfter });
    return m;
  });

  auditNote({
    recordType: "Meeting",
    recordId: created.id,
    summary: `Scheduled "${t}" with ${attendees.length} ${attendees.length === 1 ? "person" : "people"}`,
    after: { title: t, startsAt, endsAt, provider: link?.provider ?? null, attendees: attendees.length, inPerson, lateAfterMinutes: inPerson ? lateAfter : undefined },
  });
  await tell(v, created, attendees, "invited", inPerson ? "This is a Team Huddle. Accept the invitation in Team Huddle; when you are in the room, press \"Join Huddle\" and later \"End Huddle\"." : null);
  return { id: created.id, invited: attendees.length };
}

export async function update(userId: string, id: string, body: Fields) {
  const v = await who(userId);
  const m = await prisma.meeting.findFirst({ where: { id, platformId: v.platformId }, include: { attendees: { select: { userId: true } } } });
  // Only the organizer edits, and only a meeting they can see (they organize it).
  if (!m || m.organizerId !== userId) throw new Error("NOT_FOUND");
  if (String(m.status) === "CANCELLED") throw new Error("MEETING_CANCELLED");
  if (m.endsAt.getTime() < Date.now()) throw new Error("MEETING_OVER");

  const t = body.title !== undefined ? title(body.title) : m.title;
  const d = body.description !== undefined ? description(body.description) : m.description;
  const timesGiven = body.date !== undefined || body.startTime !== undefined || body.endTime !== undefined;
  const merged = {
    date: body.date ?? localDayOf(m.startsAt, v.tz),
    startTime: body.startTime ?? new Intl.DateTimeFormat("en-GB", { timeZone: v.tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(m.startsAt),
    endTime: body.endTime ?? new Intl.DateTimeFormat("en-GB", { timeZone: v.tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(m.endsAt),
  };
  const { startsAt, endsAt } = timesGiven ? parseWhen(merged, v.tz) : { startsAt: m.startsAt, endsAt: m.endsAt };
  if (timesGiven && endsAt.getTime() < Date.now()) throw new Error("PAST_MEETING");
  // An organizer who scheduled an ordinary meeting can turn it into an in-person one (tracked) as long as it has not ended.
  // It cannot be switched off again, and an in-person meeting has no link.
  const alreadyTracked = await part.isTracked(id);
  const makeTracked = body.inPerson === true && !alreadyTracked;
  if (makeTracked && !(await part.participationReady())) throw new Error("FEATURES_NOT_READY");
  const lateAfter = makeTracked ? part.cleanLateAfter(body.lateAfterMinutes) : 5;
  const link = makeTracked || alreadyTracked ? null : body.meetingUrl !== undefined ? cleanUrl(body.meetingUrl) : m.meetingUrl ? { url: m.meetingUrl, provider: m.provider ?? "Other link" } : null;

  const before = new Set(m.attendees.map((a) => a.userId));
  const next = body.attendeeIds !== undefined ? await checkAttendees(body.attendeeIds, userId, v.platformId) : null;
  const nextIds = next ? new Set(next.map((a) => a.id)) : before;
  const added = next ? next.filter((a) => !before.has(a.id)) : [];
  const removedIds = [...before].filter((x) => !nextIds.has(x));

  await prisma.$transaction(async (tx) => {
    await tx.meeting.update({ where: { id }, data: { title: t, description: d, startsAt, endsAt, meetingUrl: link?.url ?? null, provider: link?.provider ?? null } });
    if (makeTracked) await part.enableTracking(tx, { meetingId: id, platformId: v.platformId, createdById: userId, lateAfterMinutes: lateAfter });
    if (next) {
      if (removedIds.length) await tx.meetingAttendee.deleteMany({ where: { meetingId: id, userId: { in: removedIds } } });
      if (added.length) await tx.meetingAttendee.createMany({ data: added.map((a) => ({ meetingId: id, userId: a.id })) });
    }
  });

  const diff = changedFields(
    { title: m.title, description: m.description, startsAt: m.startsAt, endsAt: m.endsAt, meetingUrl: m.meetingUrl, attendees: before.size },
    { title: t, description: d, startsAt, endsAt, meetingUrl: link?.url ?? null, attendees: nextIds.size },
    ["title", "description", "startsAt", "endsAt", "meetingUrl", "attendees"]
  );
  const afterWithTracking = { ...(diff.after as Record<string, unknown>), ...(makeTracked ? { inPerson: true, lateAfterMinutes: lateAfter } : {}) };
  auditNote({ recordType: "Meeting", recordId: id, before: diff.before, after: afterWithTracking, summary: `Changed "${t}": ${Object.keys(afterWithTracking).join(", ") || "no changes"}` });

  // Tell the people it affects: new invitees, people who stay (if anything they care about changed), people removed.
  const changedForAttendees = makeTracked || ["title", "startsAt", "endsAt", "meetingUrl", "description"].some((k) => k in (diff.after as Record<string, unknown>));
  const meetingNow = { id, title: t, startsAt, endsAt, meetingUrl: link?.url ?? null };
  await tell(v, meetingNow, added, "invited", null);
  if (changedForAttendees) {
    const stay = await prisma.user.findMany({ where: { id: { in: [...nextIds].filter((x) => before.has(x)) } }, select: { id: true, firstName: true, email: true } });
    await tell(v, meetingNow, stay, "updated", makeTracked ? "It is now an in-person meeting. When you are in the room, open Team Huddle and press \"I'm in the Meeting\"." : null);
  }
  if (removedIds.length) {
    const gone = await prisma.user.findMany({ where: { id: { in: removedIds } }, select: { id: true, firstName: true, email: true } });
    await tell(v, meetingNow, gone, "removed", null);
  }
  return { ok: true };
}

// The organizer closes a meeting that is happening now: its end time becomes "now", so it moves to Past.
// (Cancel is for a meeting that has not started.) Nothing is deleted and attendance is not touched.
export async function end(userId: string, id: string) {
  const v = await who(userId);
  const m = await prisma.meeting.findFirst({ where: { id, platformId: v.platformId, organizerId: userId } });
  if (!m) throw new Error("NOT_FOUND");
  if (String(m.status) === "CANCELLED") throw new Error("MEETING_CANCELLED");
  const now = new Date();
  if (m.endsAt.getTime() < now.getTime()) throw new Error("MEETING_OVER");
  if (m.startsAt.getTime() > now.getTime()) throw new Error("NOT_STARTED");

  const res = await prisma.meeting.updateMany({ where: { id, status: "SCHEDULED", endsAt: { gte: now } }, data: { endsAt: now } });
  if (res.count === 0) throw new Error("MEETING_OVER");
  auditNote({ recordType: "Meeting", recordId: id, before: { endsAt: m.endsAt.toISOString() }, after: { endsAt: now.toISOString() }, summary: `Ended "${m.title}" early` });
  // Everyone still marked in the meeting is stopped at this same moment. A failure here must not undo the end itself.
  try {
    const closed = await part.closeOpenAtMeetingEnd(id, userId, m.title, now);
    if (closed > 0) auditNote({ after: { endsAt: now.toISOString(), openRecordsClosed: closed }, summary: `Ended "${m.title}" early for everyone; ${closed} open attendance record${closed === 1 ? "" : "s"} closed at the end time` });
  } catch (e) {
    console.error("[meetings] could not close open attendance at meeting end:", e);
  }
  return { ok: true };
}

export async function cancel(userId: string, id: string, reason: unknown) {
  const v = await who(userId);
  const m = await prisma.meeting.findFirst({ where: { id, platformId: v.platformId }, include: { attendees: { select: { user: { select: { id: true, firstName: true, email: true } } } } } });
  if (!m) throw new Error("NOT_FOUND");
  // The organizer, or HR/Admin of the company (oversight).
  if (m.organizerId !== userId && !OVERSIGHT.includes(v.role)) throw new Error("NOT_FOUND");
  if (String(m.status) === "CANCELLED") throw new Error("MEETING_CANCELLED");
  if (m.endsAt.getTime() < Date.now()) throw new Error("MEETING_OVER");
  const why = String(reason ?? "").trim().slice(0, 300) || null;

  const res = await prisma.meeting.updateMany({ where: { id, status: "SCHEDULED" }, data: { status: "CANCELLED", cancelledAt: new Date(), cancelReason: why } });
  if (res.count === 0) throw new Error("MEETING_CANCELLED");
  auditNote({ recordType: "Meeting", recordId: id, before: { status: "SCHEDULED" }, after: { status: "CANCELLED", reason: why }, summary: `Cancelled "${m.title}"` });
  await tell(v, { id, title: m.title, startsAt: m.startsAt, endsAt: m.endsAt, meetingUrl: null }, m.attendees.map((a) => a.user), "cancelled", why);
  return { ok: true };
}
