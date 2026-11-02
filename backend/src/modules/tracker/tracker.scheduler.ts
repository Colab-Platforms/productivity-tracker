import { prisma } from "../../lib/prisma.js";
import { awayOf } from "./activityClass.js";
import { getPinnedCompany } from "../../lib/deployment.js";
import { closeStaleBreaks, closeStaleMeetings } from "./tracker.service.js";
import { localMinutes, recompute } from "./tracker.service.js";
import { platformToday } from "../../lib/dates.js";

const INTERVAL_MINUTES = 15;

function fmt(date: Date, timezone: string) {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

// One alert of a given type per person per day — the unique constraint on
// [userId, date, alertType] makes this safe to run every 15 minutes.
async function raise(
  platformId: string,
  userId: string,
  date: Date,
  alertType: string,
  severity: string,
  message: string,
  context: Record<string, unknown>
) {
  await prisma.alert.upsert({
    where: { userId_date_alertType: { userId, date, alertType: alertType as any } },
    update: { message, context: context as any },
    create: {
      platformId,
      userId,
      date,
      alertType: alertType as any,
      severity: severity as any,
      message,
      context: context as any,
    },
  });
}

// ---------------------------------------------------------------------------
// Sessions left running overnight. Without this, someone who forgets to
// clock out shows 20 hours of productive time the next morning and every
// report that includes that day is wrong.
// ---------------------------------------------------------------------------
export async function closeStaleSessions() {
  const pinned = await getPinnedCompany();
  const platforms = await prisma.platform.findMany({ where: { isActive: true, ...(pinned ? { id: pinned.id } : {}) } });
  let closed = 0;

  for (const platform of platforms) {
    const today = platformToday(platform.timezone);

    const stale = await prisma.workSession.findMany({
      where: { platformId: platform.id, status: "ACTIVE", date: { lt: today } },
      include: {
        breaks: true,
        meetings: true,
        user: {
          include: {
            teamMemberships: {
              where: { isActive: true },
              include: { team: { include: { config: true } } },
            },
          },
        },
      },
    });

    for (const s of stale) {
      const hours =
        s.user.teamMemberships[0]?.team.config?.dailyWorkHours ?? 9;

      // Close at login + a full day, or the end of that calendar day,
      // whichever comes first. Never credit time they didn't work.
      const endOfDay = new Date(s.date.getTime() + 24 * 3600 * 1000 - 1000);
      const byHours = new Date(s.loginAt.getTime() + hours * 3600 * 1000);
      const closeAt = byHours < endOfDay ? byHours : endOfDay;

      for (const b of s.breaks) {
        if (b.endedAt) continue;
        const end = b.startedAt > closeAt ? b.startedAt : closeAt;
        await prisma.trackerBreak.update({
          where: { id: b.id },
          data: {
            endedAt: end,
            durationSeconds: Math.max(
              0,
              Math.floor((end.getTime() - b.startedAt.getTime()) / 1000)
            ),
            autoClosed: true,
          },
        });
      }

      for (const m of s.meetings) {
        if (!m.startedAt || m.endedAt) continue;
        const end = m.startedAt > closeAt ? m.startedAt : closeAt;
        await prisma.trackerMeeting.update({
          where: { id: m.id },
          data: {
            endedAt: end,
            durationSeconds: Math.max(
              0,
              Math.floor((end.getTime() - m.startedAt.getTime()) / 1000)
            ),
            autoClosed: true,
          },
        });
      }

      // An invite never answered expires rather than hanging around.
      await prisma.trackerMeeting.updateMany({
        where: { workSessionId: s.id, approvalStatus: "PENDING" },
        data: {
          approvalStatus: "REJECTED",
          rejectionReason: "Not answered before end of day",
          endedAt: closeAt,
          durationSeconds: 0,
        },
      });

      await prisma.workSession.update({
        where: { id: s.id },
        data: {
          status: "COMPLETED",
          logoutAt: closeAt,
          autoClosed: true,
          autoClosedAt: new Date(),
        },
      });

      await recompute(s.id);
      closed++;
    }
  }

  return closed;
}

// ---------------------------------------------------------------------------
// Alerts. Every threshold comes from TeamConfig — nothing hardcoded.
// ---------------------------------------------------------------------------
export async function generateAlerts() {
  const pinned = await getPinnedCompany();
  const platforms = await prisma.platform.findMany({ where: { isActive: true, ...(pinned ? { id: pinned.id } : {}) } });
  let raised = 0;

  for (const platform of platforms) {
    const today = platformToday(platform.timezone);
    const nowMinutes = localMinutes(new Date(), platform.timezone);

    const sessions = await prisma.workSession.findMany({
      where: { platformId: platform.id, date: today },
      include: {
        breaks: true,
        user: {
          include: {
            teamMemberships: {
              where: { isActive: true },
              include: { team: { include: { config: true } } },
            },
          },
        },
      },
    });

    for (const s of sessions) {
      const cfg = s.user.teamMemberships[0]?.team.config;
      const breakBudget = (cfg?.breakBudgetMinutes ?? 60) * 60;
      const dailySeconds = (cfg?.dailyWorkHours ?? 9) * 3600;
      const overtimeAfter =
        dailySeconds + (cfg?.overtimeAlertMinutes ?? 15) * 60;
      const lowThreshold = cfg?.lowProductivityThreshold ?? 0.75;
      const productiveTarget = (cfg?.productiveHours ?? 8) * 3600;

      if (s.wasLateLogin) {
        await raise(
          platform.id,
          s.userId,
          today,
          "LATE_LOGIN",
          "WARNING",
          `Late login at ${fmt(s.loginAt, platform.timezone)} — ${s.lateByMinutes} minutes after shift start`,
          { lateByMinutes: s.lateByMinutes, shiftStart: s.shiftStartTime }
        );
        raised++;
      }

      // Washroom is not break time, so it never counts towards the budget.
      const away = awayOf(s, new Date());
      if (away.breakSeconds > breakBudget) {
        const over = Math.round((away.breakSeconds - breakBudget) / 60);
        await raise(
          platform.id,
          s.userId,
          today,
          "BREAK_OVERAGE",
          over > 30 ? "CRITICAL" : "WARNING",
          `Break budget exceeded by ${over} minutes`,
          { usedSeconds: away.breakSeconds, budgetSeconds: breakBudget }
        );
        raised++;
      }

      // Meetings are already inside productiveSeconds; adding them again would
      // fire OVERTIME early for anyone who attended a meeting.
      const onSite = s.productiveSeconds + away.breakSeconds + away.washroomSeconds;
      if (onSite > overtimeAfter) {
        const over = Math.round((onSite - dailySeconds) / 60);
        await raise(
          platform.id,
          s.userId,
          today,
          "OVERTIME",
          "INFO",
          `Working ${over} minutes beyond the ${cfg?.dailyWorkHours ?? 9}-hour day`,
          { onSiteSeconds: onSite }
        );
        raised++;
      }

      if (
        s.status === "COMPLETED" &&
        s.productiveSeconds < productiveTarget * lowThreshold
      ) {
        const pct = Math.round((s.productiveSeconds / productiveTarget) * 100);
        await raise(
          platform.id,
          s.userId,
          today,
          "LOW_PRODUCTIVITY",
          "WARNING",
          `Day ended at ${pct}% of the productive target`,
          { productiveSeconds: s.productiveSeconds, productiveTarget }
        );
        raised++;
      }
    }

    // NO_LOGIN — nobody clocked in, an hour past their shift start, and
    // they are not on leave.
    const clockedIn = new Set(sessions.map((s) => s.userId));

    const members = await prisma.teamMember.findMany({
      where: { isActive: true, team: { platformId: platform.id, isActive: true } },
      include: {
        user: { include: { shift: true } },
        team: { include: { shift: true } },
      },
    });

    const onLeave = new Set(
      (
        await prisma.leaveDay.findMany({
          where: { platformId: platform.id, date: today },
        })
      ).map((l) => l.userId)
    );

    for (const m of members) {
      if (clockedIn.has(m.userId)) continue;
      if (onLeave.has(m.userId)) continue;
      if (!m.user.trackerAccessEnabled) continue;
      if (m.user.status !== "ACTIVE") continue;

      const shift = m.team.shift ?? m.user.shift;
      if (!shift) continue;

      // Not a working day for this shift? Nothing to report.
      const dow = today.getUTCDay() === 0 ? 7 : today.getUTCDay();
      if (!shift.workingDays.includes(dow)) continue;

      const [h, min] = shift.startTime.split(":").map(Number);
      if (nowMinutes < h * 60 + min + 60) continue;

      await raise(
        platform.id,
        m.userId,
        today,
        "NO_LOGIN",
        "CRITICAL",
        `Not clocked in — shift started at ${shift.startTime}`,
        { shiftStart: shift.startTime }
      );
      raised++;
    }
  }

  return raised;
}

export function startTrackerScheduler() {
  const run = async () => {
    try {
      const closed = await closeStaleSessions();
      // A meeting nobody ended is closed here, credited only up to the
      // limit. Without this, making the end button manager-only turns one
      // forgetful manager into a whole team's inflated meeting hours.
      const meetings = await closeStaleMeetings();
      // Same for a break nobody ended, so it cannot swallow the productive day.
      const breaks = await closeStaleBreaks();
      const raised = await generateAlerts();
      if (closed || raised || meetings || breaks) {
        console.log(
          `[scheduler] closed ${closed} stale session(s), ${meetings} stale meeting(s), ${breaks} stale break(s), ${raised} alert(s)`
        );
      }
    } catch (error) {
      // Never let a scheduler failure take the server down.
      console.error("[scheduler] failed:", error);
    }
  };

  run();
  setInterval(run, INTERVAL_MINUTES * 60 * 1000);
  console.log(`Tracker scheduler started (every ${INTERVAL_MINUTES} minutes)`);
}
