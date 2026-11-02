import { prisma } from "../../lib/prisma.js";
import { onlyPinnedCompany } from "../../lib/deployment.js";
import { parseIsoDay, platformToday } from "../../lib/dates.js";
import { cleanRemark, lateRemarksReady, LateRemarkRequired, remarksBySession } from "./lateRemarks.js";
import { huddleSecondsByDay } from "../meetings/participation.service.js";
import { awayOf, isCountedBreak, isWashroom, splitAwayTime } from "./activityClass.js";

const DEFAULTS = {
  dailyWorkHours: 9,
  productiveHours: 8,
  breakBudgetMinutes: 60,
  lateLoginGraceMinutes: 15,
};

// Late = minutes past (shift start + grace). ONE formula, used by clock-in and by approved corrections.
export function computeLate(
  at: Date,
  shiftStartTime: string | null,
  graceMinutes: number,
  timezone: string
): { wasLateLogin: boolean; lateByMinutes: number } {
  if (!shiftStartTime) return { wasLateLogin: false, lateByMinutes: 0 };
  const [h, m] = shiftStartTime.split(":").map(Number);
  const late = localMinutes(at, timezone) - (h * 60 + m) - graceMinutes;
  return late > 0 ? { wasLateLogin: true, lateByMinutes: late } : { wasLateLogin: false, lateByMinutes: 0 };
}

export function localMinutes(date: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return get("hour") * 60 + get("minute");
}

// Everything the engine needs about one person: platform timezone, the
// team's targets, and the shift their day is measured against.
export async function getContext(userId: string, opts: { ignoreLock?: boolean } = {}) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      platform: true,
      shift: true,
      teamMemberships: {
        where: { isActive: true },
        include: { team: { include: { config: true, shift: true } } },
      },
    },
  });

  if (!user) throw new Error("USER_NOT_FOUND");
  if (!user.trackerAccessEnabled && !opts.ignoreLock) throw new Error("TRACKER_LOCKED");

  const team = user.teamMemberships[0]?.team ?? null;
  const config = team?.config ?? null;
  const shift = team?.shift ?? user.shift ?? null;

  return {
    user,
    platformId: user.platformId,
    timezone: user.platform.timezone,
    shift,
    config: {
      dailyWorkHours: config?.dailyWorkHours ?? DEFAULTS.dailyWorkHours,
      productiveHours: config?.productiveHours ?? DEFAULTS.productiveHours,
      breakBudgetMinutes:
        config?.breakBudgetMinutes ?? DEFAULTS.breakBudgetMinutes,
      lateLoginGraceMinutes:
        config?.lateLoginGraceMinutes ?? DEFAULTS.lateLoginGraceMinutes,
    },
  };
}

// ---------------------------------------------------------------------------
// Recompute the three totals from the detail rows and WRITE them to the
// session. Called after every state change. Reports read these columns and
// never recalculate — which is why this must never be skipped.
// ---------------------------------------------------------------------------
// Anything that can run workSession queries: the shared client or a transaction.
export type SessionDb = Pick<typeof prisma, "workSession">;

export async function recompute(sessionId: string, db: SessionDb = prisma) {
  const session = await db.workSession.findUnique({
    where: { id: sessionId },
    include: { breaks: true, meetings: true },
  });
  if (!session) throw new Error("SESSION_NOT_FOUND");

  const now = new Date();
  const end = session.logoutAt ?? now;
  const elapsed = Math.max(
    0,
    Math.floor((end.getTime() - session.loginAt.getTime()) / 1000)
  );

  // Break time = Tea, Lunch, Personal, Other. Washroom is its own neutral activity: not break, not productive (see activityClass.ts).
  const { breakSeconds, washroomSeconds } = splitAwayTime(session.breaks, now);

  let meetingSeconds = 0;
  for (const m of session.meetings) {
    // Unaccepted invite time is not counted at all.
    if (m.approvalStatus !== "APPROVED" || !m.startedAt) continue;
    const mEnd = m.endedAt ?? now;
    meetingSeconds += Math.max(
      0,
      Math.floor((mEnd.getTime() - m.startedAt.getTime()) / 1000)
    );
  }

  // An APPROVED meeting is working time, so it stays inside productive time.
  // meetingSeconds is a separate view of how much of it was meetings. Only
  // breaks come out of the day.
  // Every away row (break or washroom) comes out of the day, so productive time is the same figure it always was.
  const productiveSeconds = Math.max(0, elapsed - breakSeconds - washroomSeconds);

  return db.workSession.update({
    where: { id: sessionId },
    data: { breakSeconds, meetingSeconds, productiveSeconds },
    include: { breaks: true, meetings: true },
  });
}

export async function getActiveSession(userId: string) {
  const ctx = await getContext(userId);
  const date = platformToday(ctx.timezone);

  // Is this person hosting a meeting that is still running? A manager has no
  // meeting row of their own - the rows belong to the people they invited -
  // so their screen has no way to know one is running, and the End button
  // could neither appear at the right time nor go away afterwards.
  const hostsOpenMeeting =
    (await prisma.trackerMeeting.count({
      where: {
        invitedById: userId,
        approvalStatus: "APPROVED",
        startedAt: { not: null },
        endedAt: null,
      },
    })) > 0;

  const session = await prisma.workSession.findUnique({
    where: { userId_date: { userId, date } },
    include: { breaks: true, meetings: true },
  });

  const projects = ctx.user.teamMemberships.map((m) => ({ id: m.team.id, name: m.team.name }));
  if (!session) return { session: null, config: ctx.config, hostsOpenMeeting, projects };

  const fresh = await recompute(session.id);
  const { washroomSeconds } = splitAwayTime(fresh.breaks, new Date());
  return { session: { ...fresh, washroomSeconds }, config: ctx.config, hostsOpenMeeting, projects };
}

export async function clockIn(userId: string, teamId?: string | null, lateRemark?: unknown) {
  const ctx = await getContext(userId);

  // The project is optional, but if given it must be one of THIS person's own teams.
  let projectId: string | null = null;
  if (teamId) {
    if (!ctx.user.teamMemberships.some((m) => m.teamId === teamId)) throw new Error("BAD_PROJECT");
    projectId = teamId;
  }
  const date = platformToday(ctx.timezone);
  const now = new Date();

  const existing = await prisma.workSession.findUnique({
    where: { userId_date: { userId, date } },
    include: { breaks: true, meetings: true },
  });

  if (existing?.status === "ACTIVE") {
    return recompute(existing.id);
  }

  // SESSION RESUME: clocked out early, coming back. Reopen the same session
  // and log the time away as a break, rather than locking them out all day.
  if (existing?.status === "COMPLETED") {
    if (existing.productiveSeconds >= ctx.config.productiveHours * 3600) {
      throw new Error("ALREADY_COMPLETED");
    }

    if (existing.logoutAt) {
      const away = Math.floor(
        (now.getTime() - existing.logoutAt.getTime()) / 1000
      );
      if (away > 0) {
        await prisma.trackerBreak.create({
          data: {
            workSessionId: existing.id,
            breakType: "OTHER",
            startedAt: existing.logoutAt,
            endedAt: now,
            durationSeconds: away,
            reason: "Away between clock-out and clock-in",
          },
        });
      }
    }

    await prisma.workSession.update({
      where: { id: existing.id },
      data: { status: "ACTIVE", logoutAt: null, ...(projectId && !existing.teamId ? { teamId: projectId } : {}) },
    });

    return recompute(existing.id);
  }

  // Late login is measured against THIS PERSON'S shift, never a global time.
  const shiftStartTime = ctx.shift?.startTime ?? null;
  const { wasLateLogin, lateByMinutes } = computeLate(now, shiftStartTime, ctx.config.lateLoginGraceMinutes, ctx.timezone);

  // After the cut-off a short reason is required (only once the late_remarks table exists). Nothing is created
  // until it is given, so a refused attempt leaves no half-started day behind.
  const needsRemark = wasLateLogin && (await lateRemarksReady());
  const remark = needsRemark ? cleanRemark(lateRemark) : null;
  if (needsRemark && !remark) throw new LateRemarkRequired(lateByMinutes);

  const sessionData = {
    platformId: ctx.platformId,
    userId,
    date,
    loginAt: now,
    status: "ACTIVE" as const,
    shiftStartTime,
    wasLateLogin,
    lateByMinutes,
    teamId: projectId,
  };
  const created = remark
    ? await prisma.$transaction(async (tx) => {
        const s = await tx.workSession.create({ data: sessionData });
        await tx.lateRemark.create({ data: { platformId: ctx.platformId, userId, sessionId: s.id, remark, lateByMinutes } });
        return s;
      })
    : await prisma.workSession.create({ data: sessionData });

  return recompute(created.id);
}

export async function clockOut(userId: string) {
  const ctx = await getContext(userId);
  const date = platformToday(ctx.timezone);
  const now = new Date();

  const session = await prisma.workSession.findUnique({
    where: { userId_date: { userId, date } },
    include: { breaks: true, meetings: true },
  });

  if (!session || session.status !== "ACTIVE") {
    throw new Error("NO_ACTIVE_SESSION");
  }

  // Close anything still running, otherwise the totals would keep growing.
  for (const b of session.breaks) {
    if (!b.endedAt) {
      await prisma.trackerBreak.update({
        where: { id: b.id },
        data: {
          endedAt: now,
          durationSeconds: Math.max(
            0,
            Math.floor((now.getTime() - b.startedAt.getTime()) / 1000)
          ),
        },
      });
    }
  }

  for (const m of session.meetings) {
    if (!m.endedAt && m.startedAt) {
      await prisma.trackerMeeting.update({
        where: { id: m.id },
        data: {
          endedAt: now,
          durationSeconds: Math.max(
            0,
            Math.floor((now.getTime() - m.startedAt.getTime()) / 1000)
          ),
        },
      });
    }
  }

  await prisma.workSession.update({
    where: { id: session.id },
    data: { status: "COMPLETED", logoutAt: now },
  });

  return recompute(session.id);
}

export async function startBreak(userId: string, breakType: string) {
  const ctx = await getContext(userId);
  const date = platformToday(ctx.timezone);

  const session = await prisma.workSession.findUnique({
    where: { userId_date: { userId, date } },
    include: { breaks: true, meetings: true },
  });

  if (!session || session.status !== "ACTIVE") {
    throw new Error("NO_ACTIVE_SESSION");
  }
  if (session.breaks.some((b) => !b.endedAt)) {
    throw new Error("BREAK_ALREADY_RUNNING");
  }
  if (session.meetings.some((m) => m.startedAt && !m.endedAt)) {
    throw new Error("MEETING_RUNNING");
  }

  await prisma.trackerBreak.create({
    data: {
      workSessionId: session.id,
      breakType: breakType as never,
      startedAt: new Date(),
    },
  });

  return recompute(session.id);
}

export async function endBreak(userId: string) {
  const ctx = await getContext(userId);
  const date = platformToday(ctx.timezone);

  const session = await prisma.workSession.findUnique({
    where: { userId_date: { userId, date } },
    include: { breaks: true },
  });

  if (!session) throw new Error("NO_ACTIVE_SESSION");

  const open = session.breaks.find((b) => !b.endedAt);
  if (!open) throw new Error("NO_BREAK_RUNNING");

  const now = new Date();
  await prisma.trackerBreak.update({
    where: { id: open.id },
    data: {
      endedAt: now,
      durationSeconds: Math.max(
        0,
        Math.floor((now.getTime() - open.startedAt.getTime()) / 1000)
      ),
    },
  });

  return recompute(session.id);
}

// ---------------------------------------------------------------------------
// INVITE FLOW
// Only a manager can start a meeting. Each invited employee gets a PENDING
// row. The clock does NOT run while pending — startedAt is set at the moment
// the employee accepts, so waiting is never paid time.
// ---------------------------------------------------------------------------
export async function inviteToMeeting(
  managerId: string,
  employeeIds: string[],
  meetingType: string,
  title?: string
) {
  const manager = await prisma.user.findUnique({ where: { id: managerId } });
  if (!manager) throw new Error("USER_NOT_FOUND");
  if (!["MANAGER", "HR", "ADMIN"].includes(manager.role)) {
    throw new Error("NOT_ALLOWED");
  }

  const invited: string[] = [];
  const skipped: { userId: string; reason: string }[] = [];

  // Tenant guard: platformId comes from the manager's own record, never from
  // the request. One lookup for everyone, then a set check — no N+1.
  const sameCompany = new Set(
    (
      await prisma.user.findMany({
        where: { id: { in: employeeIds.map(String) }, platformId: manager.platformId },
        select: { id: true },
      })
    ).map((u) => u.id)
  );

  for (const employeeId of employeeIds) {
    if (!sameCompany.has(String(employeeId))) {
      skipped.push({ userId: employeeId, reason: "Not in your company" });
      continue;
    }

    const ctx = await getContext(employeeId).catch(() => null);
    if (!ctx) {
      skipped.push({ userId: employeeId, reason: "No tracker access" });
      continue;
    }

    const date = platformToday(ctx.timezone);
    const session = await prisma.workSession.findUnique({
      where: { userId_date: { userId: employeeId, date } },
      include: { meetings: true },
    });

    // A meeting attaches to a work session, so they must be clocked in.
    if (!session || session.status !== "ACTIVE") {
      skipped.push({ userId: employeeId, reason: "Not clocked in" });
      continue;
    }
    if (session.meetings.some((m) => m.approvalStatus === "PENDING")) {
      skipped.push({ userId: employeeId, reason: "Already has a pending invite" });
      continue;
    }
    if (
      session.meetings.some(
        (m) => m.approvalStatus === "APPROVED" && m.startedAt && !m.endedAt
      )
    ) {
      skipped.push({ userId: employeeId, reason: "Already in a meeting" });
      continue;
    }

    await prisma.trackerMeeting.create({
      data: {
        workSessionId: session.id,
        meetingType: meetingType as never,
        title: title ?? null,
        approvalStatus: "PENDING",
        invitedById: managerId,
        attendeeIds: employeeIds,
      },
    });

    invited.push(employeeId);
  }

  return { invited, skipped };
}

// What the employee's notification badge polls for.
export async function listPendingInvites(userId: string) {
  const ctx = await getContext(userId);
  const date = platformToday(ctx.timezone);

  const session = await prisma.workSession.findUnique({
    where: { userId_date: { userId, date } },
    include: {
      meetings: {
        where: { approvalStatus: "PENDING" },
        include: {
          invitedBy: { select: { firstName: true, lastName: true, role: true } },
        },
        orderBy: { requestedAt: "desc" },
      },
    },
  });

  return session?.meetings ?? [];
}

export async function respondToMeeting(
  userId: string,
  meetingId: string,
  accept: boolean,
  reason?: string
) {
  const meeting = await prisma.trackerMeeting.findUnique({
    where: { id: meetingId },
    include: { workSession: true },
  });

  if (!meeting) throw new Error("MEETING_NOT_FOUND");
  // Ownership check: you can only answer an invite addressed to you.
  if (meeting.workSession.userId !== userId) throw new Error("NOT_YOURS");
  if (meeting.approvalStatus !== "PENDING") throw new Error("ALREADY_ANSWERED");

  const now = new Date();

  if (accept) {
    await prisma.trackerMeeting.update({
      where: { id: meetingId },
      data: {
        approvalStatus: "APPROVED",
        reviewedAt: now,
        reviewedById: userId,
        startedAt: now, // the clock starts HERE, not when invited
      },
    });
  } else {
    await prisma.trackerMeeting.update({
      where: { id: meetingId },
      data: {
        approvalStatus: "REJECTED",
        reviewedAt: now,
        reviewedById: userId,
        rejectionReason: reason ?? null,
        endedAt: now,
        durationSeconds: 0,
      },
    });
  }

  return recompute(meeting.workSessionId);
}

// How long a meeting may run before the system ends it itself. Once only a
// manager can end a meeting, a manager who forgets would otherwise record a
// whole day of "meeting time" for their entire team.
const MAX_MEETING_HOURS = 4;

// Ends the meeting for everyone the manager invited, in one action. Each
// attendee has their own row against their own day, so "end the meeting"
// means closing all of them - otherwise one person stays in a meeting that
// finished an hour ago.
export async function endMeetingForAll(managerId: string) {
  const open = await prisma.trackerMeeting.findMany({
    where: {
      invitedById: managerId,
      approvalStatus: "APPROVED",
      startedAt: { not: null },
      endedAt: null,
    },
    select: { id: true, startedAt: true, workSessionId: true },
  });

  if (open.length === 0) throw new Error("NO_MEETING_RUNNING");

  const now = new Date();
  for (const m of open) {
    await prisma.trackerMeeting.update({
      where: { id: m.id },
      data: {
        endedAt: now,
        durationSeconds: Math.max(
          0,
          Math.floor((now.getTime() - m.startedAt!.getTime()) / 1000)
        ),
      },
    });
  }

  for (const sessionId of Array.from(new Set(open.map((m) => m.workSessionId)))) {
    await recompute(sessionId);
  }

  return { ok: true, ended: open.length };
}

// Run on a timer. A meeting left open past the limit is closed and credited
// only up to the limit - the hours after that were not a meeting, they were
// somebody forgetting to press a button, and paying for them would quietly
// inflate everyone's productive time.
export async function closeStaleMeetings(): Promise<number> {
  const cutoff = new Date(Date.now() - MAX_MEETING_HOURS * 3600_000);

  const stale = await prisma.trackerMeeting.findMany({
    where: {
      approvalStatus: "APPROVED",
      endedAt: null,
      startedAt: { not: null, lt: cutoff },
    },
    select: { id: true, startedAt: true, workSessionId: true },
  });

  for (const m of stale) {
    const endedAt = new Date(m.startedAt!.getTime() + MAX_MEETING_HOURS * 3600_000);
    await prisma.trackerMeeting.update({
      where: { id: m.id },
      data: {
        endedAt,
        durationSeconds: MAX_MEETING_HOURS * 3600,
        autoClosed: true,
      },
    });
  }

  for (const sessionId of Array.from(new Set(stale.map((m) => m.workSessionId)))) {
    await recompute(sessionId);
  }

  return stale.length;
}
// A single break may run for this many times the team's whole-day break
// budget before the system ends it. The budget itself comes from TeamConfig;
// the multiple only leaves room for a long lunch before we assume the person
// simply forgot to press "end break".
const STALE_BREAK_BUDGET_MULTIPLE = 2;

// Run on a timer, same idea as closeStaleMeetings: a break left open past the
// limit is closed and credited only up to the limit. The hours after that were
// somebody forgetting a button, and counting them as break would zero out a
// whole day of productive time.
export async function closeStaleBreaks(): Promise<number> {
  const open = await prisma.trackerBreak.findMany({
    where: { endedAt: null },
    select: {
      id: true,
      startedAt: true,
      workSessionId: true,
      workSession: {
        select: {
          user: {
            select: {
              teamMemberships: {
                where: { isActive: true },
                select: { team: { select: { config: { select: { breakBudgetMinutes: true } } } } },
              },
            },
          },
        },
      },
    },
  });

  const now = Date.now();
  const touched = new Set<string>();

  for (const b of open) {
    const budget =
      b.workSession.user.teamMemberships[0]?.team.config?.breakBudgetMinutes ??
      DEFAULTS.breakBudgetMinutes;
    const limitMs = budget * STALE_BREAK_BUDGET_MULTIPLE * 60_000;
    if (now - b.startedAt.getTime() < limitMs) continue;

    await prisma.trackerBreak.update({
      where: { id: b.id },
      data: {
        endedAt: new Date(b.startedAt.getTime() + limitMs),
        durationSeconds: Math.floor(limitMs / 1000),
        autoClosed: true,
      },
    });
    touched.add(b.workSessionId);
  }

  for (const sessionId of touched) {
    await recompute(sessionId);
  }

  return touched.size;
}

export async function endMeeting(userId: string) {
  const ctx = await getContext(userId);
  const date = platformToday(ctx.timezone);

  const session = await prisma.workSession.findUnique({
    where: { userId_date: { userId, date } },
    include: { meetings: true },
  });

  if (!session) throw new Error("NO_ACTIVE_SESSION");

  const open = session.meetings.find(
    (m) => m.approvalStatus === "APPROVED" && m.startedAt && !m.endedAt
  );
  if (!open) throw new Error("NO_MEETING_RUNNING");

  const now = new Date();
  await prisma.trackerMeeting.update({
    where: { id: open.id },
    data: {
      endedAt: now,
      durationSeconds: Math.max(
        0,
        Math.floor((now.getTime() - open.startedAt!.getTime()) / 1000)
      ),
    },
  });

  return recompute(session.id);
}

// ---------------------------------------------------------------------------
// WHO A MANAGER MAY SEE
//
// The teams they run, PLUS everyone who reports to them. The second list can
// cross companies — one manager may run teams in Avatar and in Take Health.
// HR and Admin see their own company.
//
// Shared by Live Team and the alerts panel so the two can never disagree
// about who is on screen.
// ---------------------------------------------------------------------------
export async function visibleUserIds(viewer: {
  id: string;
  role: string;
  platformId: string;
}): Promise<string[]> {
  if (viewer.role !== "MANAGER") {
    const everyone = await prisma.user.findMany({
      where: {
        platformId: viewer.platformId,
        status: { in: ["ACTIVE", "INVITED"] },
      },
      select: { id: true },
    });
    return everyone.map((u) => u.id);
  }

  const [managedTeams, reports] = await Promise.all([
    prisma.team.findMany({
      where: { managerId: viewer.id, isActive: true },
      select: { members: { where: { isActive: true }, select: { userId: true } } },
    }),
    prisma.user.findMany({
      where: { reportsToId: viewer.id },
      select: { id: true },
    }),
  ]);

  return onlyPinnedCompany(
    Array.from(
      new Set([
        ...managedTeams.flatMap((t) => t.members.map((m) => m.userId)),
        ...reports.map((r) => r.id),
      ])
    )
  );
}

// ---------------------------------------------------------------------------
// LIVE TEAM
// Totals are adjusted on read using updatedAt (the last recompute) so the
// view is live without writing to the database on every poll.
//
// People are queried directly rather than by walking teams, so someone in two
// teams appears once with no dedupe pass, and a direct report who isn't in
// any team yet still shows up.
// ---------------------------------------------------------------------------
export async function getTeamLiveStatus(viewerId: string) {
  const viewer = await prisma.user.findUnique({
    where: { id: viewerId },
    include: { platform: true },
  });

  if (!viewer) throw new Error("USER_NOT_FOUND");
  if (!["MANAGER", "HR", "ADMIN"].includes(viewer.role)) {
    throw new Error("NOT_ALLOWED");
  }

  // NOTE: "today" is the VIEWER's company day. Identical while every company
  // is Asia/Kolkata; a company in another timezone would need this per person.
  const date = platformToday(viewer.platform.timezone);

  const userIds = await visibleUserIds(viewer);
  if (userIds.length === 0) return [];

  const [people, sessions, leaveDays] = await Promise.all([
    prisma.user.findMany({
      where: { id: { in: userIds } },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        employeeCode: true,
        designation: true,
        platform: { select: { name: true } },
        teamMemberships: {
          where: { isActive: true },
          select: { team: { select: { name: true, config: true } } },
          take: 1,
        },
      },
      orderBy: [{ firstName: "asc" }],
    }),
    prisma.workSession.findMany({
      where: { userId: { in: userIds }, date },
      include: { breaks: true, meetings: true },
    }),
    prisma.leaveDay.findMany({
      where: { userId: { in: userIds }, date },
    }),
  ]);

  const byUser = new Map(sessions.map((s) => [s.userId, s]));
  const onLeave = new Set(leaveDays.map((l) => l.userId));
  const now = Date.now();
  const remarkOf = await remarksBySession(sessions.map((s) => s.id));

  return people.map((person) => {
    const s = byUser.get(person.id) ?? null;
    const team = person.teamMemberships[0]?.team ?? null;

    const openBreak = s?.breaks.find((b) => !b.endedAt) ?? null;
    const openMeeting =
      s?.meetings.find(
        (m) => m.approvalStatus === "APPROVED" && m.startedAt && !m.endedAt
      ) ?? null;
    const pendingInvite =
      s?.meetings.some((m) => m.approvalStatus === "PENDING") ?? false;

    let status: string;
    if (onLeave.has(person.id)) status = "ON_LEAVE";
    else if (!s) status = "NOT_CLOCKED_IN";
    else if (s.status === "COMPLETED") status = "DONE";
    else if (openBreak) status = "ON_BREAK";
    else if (openMeeting) status = "IN_MEETING";
    else status = "WORKING";

    let productiveSeconds = s?.productiveSeconds ?? 0;
    // Break and washroom come from the break rows (an open row runs to now), so Washroom never lands in the break figure.
    const away = s ? splitAwayTime(s.breaks, new Date(now)) : { breakSeconds: 0, washroomSeconds: 0 };
    const breakSeconds = away.breakSeconds;
    let meetingSeconds = s?.meetingSeconds ?? 0;

    if (s && s.status === "ACTIVE") {
      const since = Math.max(0, Math.floor((now - s.updatedAt.getTime()) / 1000));
      if (openBreak) {
        // the open break or washroom is already counted to now above; productive time does not run while away
      } else {
        productiveSeconds += since;
        if (openMeeting) meetingSeconds += since;
      }
    }

    return {
      userId: person.id,
      name: `${person.firstName} ${person.lastName}`,
      employeeCode: person.employeeCode,
      designation: person.designation,
      teamName: team?.name ?? "—",
      company: person.platform?.name ?? null,
      status,
      pendingInvite,
      breakType: openBreak?.breakType ?? null,
      loginAt: s?.loginAt ?? null,
      wasLateLogin: s?.wasLateLogin ?? false,
      lateByMinutes: s?.lateByMinutes ?? 0,
      lateRemark: s ? remarkOf.get(s.id) ?? null : null,
      productiveSeconds,
      breakSeconds,
      washroomSeconds: away.washroomSeconds,
      meetingSeconds,
      productiveTarget: (team?.config?.productiveHours ?? 8) * 3600,
      breakBudget: (team?.config?.breakBudgetMinutes ?? 60) * 60,
    };
  });
}

// ---------------------------------------------------------------------------
// MY HISTORY
// Past days with their totals, plus that day's task score. Defaults to the
// last 30 days. Dates come in as YYYY-MM-DD and are read as UTC midnight,
// matching how the day is stored.
// ---------------------------------------------------------------------------
const TASK_WEIGHTS: Record<string, number> = {
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  CRITICAL: 5,
};

// Same scale the Daily Tasks page uses, so a day's score reads identically
// in both places.
const OUTCOME_MULTIPLIER: Record<string, number> = {
  COMPLETED: 1,
  PARTIALLY_COMPLETED: 0.5,
  FAILED: 0,
};

export async function getHistory(userId: string, fromStr?: string, toStr?: string) {
  const ctx = await getContext(userId);
  const today = platformToday(ctx.timezone);

  const to = toStr ? parseIsoDay(toStr) : today;
  const from = fromStr ? parseIsoDay(fromStr) : new Date(to.getTime() - 29 * 86400000);
  if (from.getTime() > to.getTime()) throw new Error("BAD_RANGE");

  const [sessions, leaveDays, tasks] = await Promise.all([
    prisma.workSession.findMany({
      where: { userId, date: { gte: from, lte: to } },
      include: { breaks: true, meetings: true },
      orderBy: { date: "desc" },
    }),
    prisma.leaveDay.findMany({
      where: { userId, date: { gte: from, lte: to } },
    }),
    prisma.dailyTask.findMany({
      where: { userId, date: { gte: from, lte: to } },
    }),
  ]);

  const key = (d: Date) => d.toISOString().slice(0, 10);

  const leaveByDate = new Map(leaveDays.map((l) => [key(l.date), l]));

  const tasksByDate = new Map<string, typeof tasks>();
  for (const t of tasks) {
    const k = key(t.date);
    if (!tasksByDate.has(k)) tasksByDate.set(k, []);
    tasksByDate.get(k)!.push(t);
  }

  const remarkOf = await remarksBySession(sessions.map((s) => s.id));
  // Team Huddle time that counted per day: a label inside productive time, never an addition (see participation.service).
  const huddleMap = await huddleSecondsByDay([userId], from, to);

  const rows = sessions.map((s) => {
    const k = key(s.date);
    // Only approved work counts — a proposal the manager never agreed to
    // was never work.
    const dayTasks = (tasksByDate.get(k) ?? []).filter(
      (t) => String(t.approvalStatus) === "APPROVED"
    );

    const totalWeight = dayTasks.reduce(
      (n, t) => n + (TASK_WEIGHTS[t.weight] ?? 1),
      0
    );

    const doneWeight = dayTasks.reduce((n, t) => {
      const w = TASK_WEIGHTS[t.weight] ?? 1;
      if (t.outcome) return n + w * (OUTCOME_MULTIPLIER[String(t.outcome)] ?? 0);
      if (String(t.status) === "COMPLETED") return n + w;
      return n;
    }, 0);

    return {
      date: k,
      loginAt: s.loginAt,
      logoutAt: s.logoutAt,
      status: s.status,
      productiveSeconds: s.productiveSeconds,
      breakSeconds: awayOf(s, new Date()).breakSeconds,
      washroomSeconds: awayOf(s, new Date()).washroomSeconds,
      meetingSeconds: s.meetingSeconds,
      breakCount: s.breaks.filter((b) => isCountedBreak(String(b.breakType))).length,
      washroomCount: s.breaks.filter((b) => isWashroom(String(b.breakType))).length,
      meetingCount: s.meetings.filter((m) => m.approvalStatus === "APPROVED").length,
      wasLateLogin: s.wasLateLogin,
      lateByMinutes: s.lateByMinutes,
      lateRemark: remarkOf.get(s.id) ?? null,
      huddleSeconds: huddleMap.get(`${userId}|${k}`) ?? 0,
      autoClosed: s.autoClosed,
      onLeave: leaveByDate.has(k),
      leaveType: leaveByDate.get(k)?.leaveType ?? null,
      taskTotal: dayTasks.length,
      taskDone: dayTasks.filter(
        (t) => String(t.status) === "COMPLETED" || String(t.outcome) === "COMPLETED"
      ).length,
      taskPercent:
        totalWeight === 0 ? null : Math.round((doneWeight / totalWeight) * 100),
    };
  });

  const worked = rows.filter((r) => !r.onLeave);
  const totalProductive = worked.reduce((n, r) => n + r.productiveSeconds, 0);
  const scored = worked.filter((r) => r.taskPercent !== null);

  return {
    from: key(from),
    to: key(to),
    target: ctx.config.productiveHours * 3600,
    breakBudget: ctx.config.breakBudgetMinutes * 60,
    rows,
    summary: {
      daysWorked: worked.length,
      daysOnLeave: rows.filter((r) => r.onLeave).length,
      daysLate: worked.filter((r) => r.wasLateLogin).length,
      totalProductive,
      avgProductive: worked.length
        ? Math.round(totalProductive / worked.length)
        : 0,
      totalBreak: worked.reduce((n, r) => n + r.breakSeconds, 0),
      totalWashroom: worked.reduce((n, r) => n + r.washroomSeconds, 0),
      totalMeeting: worked.reduce((n, r) => n + r.meetingSeconds, 0),
      avgTaskScore: scored.length
        ? Math.round(
            scored.reduce((n, r) => n + (r.taskPercent ?? 0), 0) / scored.length
          )
        : null,
    },
  };
}

// ---------------------------------------------------------------------------
// ALERTS for the manager view. Only today's, only unacknowledged.
// Uses the same visibility rule as Live Team, so the alert panel and the
// table below it always talk about the same people.
// ---------------------------------------------------------------------------
export async function listTeamAlerts(viewerId: string) {
  const viewer = await prisma.user.findUnique({
    where: { id: viewerId },
    include: { platform: true },
  });
  if (!viewer) throw new Error("USER_NOT_FOUND");
  if (!["MANAGER", "HR", "ADMIN"].includes(viewer.role)) {
    throw new Error("NOT_ALLOWED");
  }

  const today = platformToday(viewer.platform.timezone);
  const userIds = await visibleUserIds(viewer);
  if (userIds.length === 0) return [];

  const alerts = await prisma.alert.findMany({
    where: { userId: { in: userIds }, date: today, acknowledgedAt: null },
    include: { user: { select: { firstName: true, lastName: true } } },
    orderBy: [{ severity: "desc" }, { createdAt: "desc" }],
  });

  return alerts.map((a) => ({
    id: a.id,
    userId: a.userId,
    name: `${a.user.firstName} ${a.user.lastName}`,
    alertType: a.alertType,
    severity: a.severity,
    message: a.message,
    createdAt: a.createdAt,
  }));
}

export async function acknowledgeAlert(viewerId: string, alertId: string) {
  const viewer = await prisma.user.findUnique({ where: { id: viewerId } });
  if (!viewer) throw new Error("USER_NOT_FOUND");
  if (!["MANAGER", "HR", "ADMIN"].includes(viewer.role)) {
    throw new Error("NOT_ALLOWED");
  }

  const alert = await prisma.alert.findUnique({ where: { id: alertId } });
  if (!alert) throw new Error("ALERT_NOT_FOUND");

  // You may clear an alert for anyone you can see — which now includes a
  // direct report in another company. Checking platform alone would stop a
  // cross-company manager clearing their own person's alert.
  const userIds = await visibleUserIds(viewer);
  if (!userIds.includes(alert.userId)) throw new Error("NOT_ALLOWED");

  await prisma.alert.update({
    where: { id: alertId },
    data: { acknowledgedAt: new Date(), acknowledgedById: viewerId },
  });

  return listTeamAlerts(viewerId);
}