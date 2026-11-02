// Attendance is never stored. It is recomputed from work sessions, the company
// day calendar, marked leave and the shift every single time anyone asks. So
// correcting a session instantly corrects the attendance sheet AND the salary
// calculated from it. No attendance table, no migration, and no second version
// of the truth that can drift from the first.

import { prisma } from "../../lib/prisma.js";
import { awayOf } from "../tracker/activityClass.js";

// Every company here operates in India. Shift times like "10:00" mean 10:00
// IST, while timestamps are stored in UTC, so the two are compared after
// shifting into IST. One constant, one place to change if that stops being true.
export const IST_OFFSET_MINUTES = 330;

export type DayStatus =
  | "PRESENT"
  | "HALF_DAY"
  | "ABSENT"
  | "LEAVE"
  | "HOLIDAY"
  | "WEEK_OFF"
  | "NOT_TRACKED"
  | "NOT_EMPLOYED"
  | "FUTURE";

const LABELS: Record<DayStatus, string> = {
  PRESENT: "Present",
  HALF_DAY: "Half day",
  ABSENT: "Absent",
  LEAVE: "Leave",
  HOLIDAY: "Holiday",
  WEEK_OFF: "Week-off",
  NOT_TRACKED: "Not tracked",
  NOT_EMPLOYED: "Not employed",
  FUTURE: "—",
};

export type AttendanceDay = {
  date: string; // "2026-10-27"
  dayOfWeek: number; // 1 = Mon .. 7 = Sun
  status: DayStatus;
  label: string;
  // What this day earns. 1 = full, 0.5 = half, 0 = nothing.
  payableFraction: number;
  // What this day costs. Salary deduction reads only this.
  lossFraction: number;
  workedHours: number; // productive + meeting, i.e. actual work
  productiveHours: number;
  meetingHours: number;
  breakHours: number;
  washroomHours: number;
  loginAt: string | null;
  logoutAt: string | null;
  isLate: boolean;
  lateByMinutes: number;
  holidayName: string | null;
  leaveType: string | null;
  autoClosed: boolean;
  note: string | null;
};

export type AttendanceTotals = {
  daysInMonth: number;
  expectedWorkingDays: number;
  presentDays: number;
  halfDays: number;
  absentDayCount: number;
  leaveDays: number;
  holidays: number;
  weekOffs: number;
  notTrackedDays: number;
  notEmployedDays: number;
  lateMarks: number;
  // The two numbers salary uses, and nothing else.
  lossOfPayDays: number;
  payableDays: number;
  totalWorkedHours: number;
  avgWorkedHoursPerWorkedDay: number;
};

export type MonthAttendance = {
  userId: string;
  name: string;
  employeeCode: string | null;
  platformId: string;
  year: number;
  month: number; // 1-12
  monthLabel: string; // "October 2026"
  shiftName: string | null;
  shiftStart: string | null;
  dateOfJoining: string | null;
  thresholds: {
    fullDayAfterHours: number;
    halfDayAfterHours: number;
    lateLoginGraceMinutes: number;
  };
  days: AttendanceDay[];
  totals: AttendanceTotals;
};

// ---------------------------------------------------------------- date helpers

// Prisma @db.Date values come back as UTC midnight, so every date in here is
// built and read in UTC. Mixing in local time would shift days by 5.5 hours and
// silently move someone's attendance onto the wrong date.
function utcDate(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day));
}

function ymd(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// A timestamp reduced to the day it falls on, so a joining date recorded with a
// time of day still compares cleanly against a calendar day.
function dayFloor(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function daysInMonthOf(year: number, month: number): number {
  // Day 0 of the next month is the last day of this one.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

// The shift stores Mon..Sun as 1..7. JavaScript returns 0 for Sunday. Without
// this conversion every Sunday reads as a working day and every Monday as an
// off day.
function isoDayOfWeek(d: Date): number {
  const js = d.getUTCDay();
  return js === 0 ? 7 : js;
}

function minutesOfDayIST(d: Date): number {
  const shifted = new Date(d.getTime() + IST_OFFSET_MINUTES * 60_000);
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
}

// "10:00" -> 600. Anything unparseable returns null so a bad shift row cannot
// turn every employee into a late mark.
function parseShiftMinutes(hhmm: string | null | undefined): number | null {
  if (!hhmm) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

function istToday(): Date {
  const now = new Date(Date.now() + IST_OFFSET_MINUTES * 60_000);
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ------------------------------------------------------------------- the engine

/**
 * One month of attendance for one or more people, in a fixed number of queries
 * regardless of how many people are asked for. Salary generation runs this for
 * a whole company at once, so it must not become a query per person.
 */
export async function getMonthAttendanceBulk(
  userIds: string[],
  year: number,
  month: number,
): Promise<MonthAttendance[]> {
  if (userIds.length === 0) return [];
  if (month < 1 || month > 12) throw new Error("BAD_MONTH");

  const dayCount = daysInMonthOf(year, month);
  const from = utcDate(year, month, 1);
  const to = utcDate(year, month, dayCount);
  const today = istToday();

  // The person, their own shift if they have one, and the two dates that bound
  // their employment. Without those dates the engine marks somebody absent for
  // every day before they were hired.
  const users = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      employeeCode: true,
      platformId: true,
      dateOfJoining: true,
      exitDate: true,
      shift: { select: { name: true, startTime: true, workingDays: true } },
    },
  });

  // Team membership is read off TeamMember directly rather than through a
  // back-relation on User, so this depends only on columns that are certain.
  // isPrimary first, because somebody on two teams has one real team.
  const memberships = await prisma.teamMember.findMany({
    where: { userId: { in: userIds }, isActive: true },
    orderBy: [{ isPrimary: "desc" }, { joinedAt: "asc" }],
    select: {
      userId: true,
      team: {
        select: {
          name: true,
          shift: { select: { name: true, startTime: true, workingDays: true } },
          config: {
            select: {
              fullDayAfterHours: true,
              halfDayAfterHours: true,
              lateLoginGraceMinutes: true,
            },
          },
        },
      },
    },
  });

  const teamByUser = new Map<string, (typeof memberships)[number]["team"]>();
  for (const m of memberships) {
    if (!teamByUser.has(m.userId)) teamByUser.set(m.userId, m.team);
  }

  const sessions = await prisma.workSession.findMany({
    where: { userId: { in: userIds }, date: { gte: from, lte: to } },
    select: {
      userId: true,
      date: true,
      loginAt: true,
      logoutAt: true,
      productiveSeconds: true,
      breakSeconds: true,
      breaks: { select: { breakType: true, startedAt: true, endedAt: true } },
      meetingSeconds: true,
      autoClosed: true,
    },
  });

  const leaves = await prisma.leaveDay.findMany({
    where: { userId: { in: userIds }, date: { gte: from, lte: to } },
    select: {
      userId: true,
      date: true,
      leaveType: true,
      isHalfDay: true,
      isFirstHalf: true,
      note: true,
    },
  });

  // The day calendar is per company, so it is fetched once per company in this
  // batch, not once per person.
  const platformIds = Array.from(new Set(users.map((u) => u.platformId)));
  const holidays = await prisma.holiday.findMany({
    where: { platformId: { in: platformIds }, date: { gte: from, lte: to } },
    select: { platformId: true, date: true, name: true, dayType: true },
  });

  // Which days this company was actually using the tracker. A day on which
  // NOBODY in the whole company clocked in is a day the system was not in use
  // — not a day the entire company was absent. Without this, every day before
  // go-live reads as mass absence and wipes out everybody's salary.
  const trackedRows = await prisma.workSession.groupBy({
    by: ["platformId", "date"],
    where: { platformId: { in: platformIds }, date: { gte: from, lte: to } },
    _count: { id: true },
  });
  const trackedDays = new Set(
    trackedRows.map((r) => `${r.platformId}|${ymd(r.date)}`),
  );

  // Keyed lookups so the day loop below is pure arithmetic, no searching.
  const k = (a: string, b: string) => `${a}|${b}`;

  const sessionsByKey = new Map<string, (typeof sessions)[number][]>();
  for (const s of sessions) {
    const key = k(s.userId, ymd(s.date));
    const list = sessionsByKey.get(key);
    if (list) list.push(s);
    else sessionsByKey.set(key, [s]);
  }

  const leaveByKey = new Map<string, (typeof leaves)[number]>();
  for (const l of leaves) leaveByKey.set(k(l.userId, ymd(l.date)), l);

  const holidaysByKey = new Map<string, (typeof holidays)[number][]>();
  for (const h of holidays) {
    const key = k(h.platformId, ymd(h.date));
    const list = holidaysByKey.get(key);
    if (list) list.push(h);
    else holidaysByKey.set(key, [h]);
  }

  const results: MonthAttendance[] = [];

  for (const user of users) {
    const team = teamByUser.get(user.id) ?? null;

    // The person's own shift wins; their team's shift is the fallback.
    const shift = user.shift ?? team?.shift ?? null;
    const workingDays =
      shift?.workingDays && shift.workingDays.length > 0
        ? shift.workingDays
        : [1, 2, 3, 4, 5, 6]; // the schema's own default
    const shiftStartMinutes = parseShiftMinutes(shift?.startTime);

    // Thresholds come from the team's config. The defaults here match the
    // schema defaults exactly, so somebody with no team is still measured by
    // the same rule as everybody else rather than slipping through unmeasured.
    const fullDayAfterHours = team?.config?.fullDayAfterHours ?? 8;
    const halfDayAfterHours = team?.config?.halfDayAfterHours ?? 4;
    const lateLoginGraceMinutes = team?.config?.lateLoginGraceMinutes ?? 15;

    const joined = user.dateOfJoining ? dayFloor(user.dateOfJoining) : null;
    const exited = user.exitDate ? dayFloor(user.exitDate) : null;

    const days: AttendanceDay[] = [];

    for (let d = 1; d <= dayCount; d++) {
      const date = utcDate(year, month, d);
      const key = ymd(date);
      const dow = isoDayOfWeek(date);

      const daySessions = sessionsByKey.get(k(user.id, key)) ?? [];
      const leave = leaveByKey.get(k(user.id, key)) ?? null;
      const dayHolidays = holidaysByKey.get(k(user.platformId, key)) ?? [];

      // A day can have more than one session if somebody clocked in twice.
      // Hours add up; the first login and last logout bound the day.
      const productiveSeconds = daySessions.reduce(
        (sum, s) => sum + s.productiveSeconds,
        0,
      );
      // Break = Tea/Lunch/Personal/Other; Washroom is reported on its own and is not break time.
      const awayNow = new Date();
      const breakSeconds = daySessions.reduce((sum, s) => sum + awayOf(s, awayNow).breakSeconds, 0);
      const washroomSeconds = daySessions.reduce((sum, s) => sum + awayOf(s, awayNow).washroomSeconds, 0);
      const meetingSeconds = daySessions.reduce(
        (sum, s) => sum + s.meetingSeconds,
        0,
      );

      // Productive, meeting and break are three separate buckets that add up to
      // the length of the day. A meeting is work, so it counts toward the day's
      // status; only break time does not. Counting productive alone marked a
      // person who spent the day in client meetings as absent.
      const workedHours = (productiveSeconds + meetingSeconds) / 3600;

      const logins = daySessions
        .map((s) => s.loginAt)
        .filter((x): x is Date => Boolean(x))
        .sort((a, b) => a.getTime() - b.getTime());
      const logouts = daySessions
        .map((s) => s.logoutAt)
        .filter((x): x is Date => Boolean(x))
        .sort((a, b) => a.getTime() - b.getTime());
      const firstLogin = logins[0] ?? null;
      const lastLogout = logouts[logouts.length - 1] ?? null;

      // WORKING on the day calendar is how a company says "this Sunday we are
      // working" without editing anybody's shift. It overrides the shift.
      const forcedWorking = dayHolidays.some((h) => h.dayType === "WORKING");
      const offHoliday = dayHolidays.find(
        (h) => h.dayType === "PUBLIC_HOLIDAY" || h.dayType === "WEEKLY_OFF",
      );
      // An optional holiday is a normal working day. Somebody who takes it has
      // leave marked against it, which the leave rule below picks up.

      let status: DayStatus;
      let note: string | null = null;

      const isFuture = date.getTime() > today.getTime();
      const isWorkingDay = forcedWorking || workingDays.includes(dow);
      const beforeJoining = joined !== null && date.getTime() < joined.getTime();
      const afterExit = exited !== null && date.getTime() > exited.getTime();
      const companyWasTracking = trackedDays.has(k(user.platformId, key));

      if (isFuture) {
        // Nobody is absent for a day that has not happened. Without this,
        // generating salary mid-month marks the rest of the month as absence.
        status = "FUTURE";
      } else if (beforeJoining || afterExit) {
        // Outside the employment period: neither earned nor deducted.
        status = "NOT_EMPLOYED";
        note = beforeJoining ? "Before joining date" : "After exit date";
      } else if (offHoliday) {
        status = "HOLIDAY";
        if (workedHours > 0) note = `Worked ${round2(workedHours)}h on a holiday`;
      } else if (!isWorkingDay) {
        status = "WEEK_OFF";
        if (workedHours > 0) note = `Worked ${round2(workedHours)}h on a week-off`;
      } else if (leave && !leave.isHalfDay) {
        status = "LEAVE";
        note = leave.note ?? null;
      } else if (leave && leave.isHalfDay) {
        // Half the day is leave. The other half is only earned by working it.
        if (workedHours >= halfDayAfterHours) {
          status = "PRESENT";
          note = `Half-day leave (${
            leave.isFirstHalf ? "first half" : "second half"
          }) plus ${round2(workedHours)}h worked`;
        } else {
          status = "HALF_DAY";
          note = `Half-day leave, other half not worked (${round2(workedHours)}h)`;
        }
      } else if (!companyWasTracking && daySessions.length === 0) {
        // Nobody in the company clocked in on this day, so the tracker was not
        // in use. Treated as paid, because an untracked day is not evidence of
        // absence and a wrong deduction is far worse than a missed one.
        status = "NOT_TRACKED";
        note = "No attendance recorded for anyone this day";
      } else if (workedHours >= fullDayAfterHours) {
        status = "PRESENT";
      } else if (workedHours >= halfDayAfterHours) {
        status = "HALF_DAY";
        note = `${round2(workedHours)}h worked, under the ${fullDayAfterHours}h full-day mark`;
      } else if (daySessions.length > 0) {
        status = "ABSENT";
        note = `Clocked in but only ${round2(workedHours)}h worked`;
      } else {
        status = "ABSENT";
      }

      // Pay, derived from status in exactly one place. NOT_EMPLOYED earns
      // nothing and costs nothing; everything else that is not absence is paid.
      const payableFraction =
        status === "ABSENT" || status === "NOT_EMPLOYED"
          ? 0
          : status === "HALF_DAY"
          ? 0.5
          : 1;
      const lossFraction =
        status === "ABSENT" ? 1 : status === "HALF_DAY" ? 0.5 : 0;

      // Late is informational only. It never costs money here — docking pay for
      // lateness is a policy decision, not something an engine should assume.
      let isLate = false;
      let lateByMinutes = 0;
      if (
        firstLogin &&
        shiftStartMinutes !== null &&
        (status === "PRESENT" || status === "HALF_DAY")
      ) {
        const over =
          minutesOfDayIST(firstLogin) - (shiftStartMinutes + lateLoginGraceMinutes);
        if (over > 0) {
          isLate = true;
          lateByMinutes = over;
        }
      }

      days.push({
        date: key,
        dayOfWeek: dow,
        status,
        label: LABELS[status],
        payableFraction,
        lossFraction,
        workedHours: round2(workedHours),
        productiveHours: round2(productiveSeconds / 3600),
        meetingHours: round2(meetingSeconds / 3600),
        breakHours: round2(breakSeconds / 3600),
        washroomHours: round2(washroomSeconds / 3600),
        loginAt: firstLogin ? firstLogin.toISOString() : null,
        logoutAt: lastLogout ? lastLogout.toISOString() : null,
        isLate,
        lateByMinutes,
        holidayName: offHoliday?.name ?? null,
        leaveType: leave ? String(leave.leaveType) : null,
        autoClosed: daySessions.some((s) => s.autoClosed),
        note,
      });
    }

    const count = (s: DayStatus) => days.filter((x) => x.status === s).length;
    const lossOfPayDays = days.reduce((sum, x) => sum + x.lossFraction, 0);
    const payableDays = days.reduce((sum, x) => sum + x.payableFraction, 0);
    const totalWorkedHours = days.reduce((sum, x) => sum + x.workedHours, 0);
    const workedDayCount = count("PRESENT") + count("HALF_DAY");

    const totals: AttendanceTotals = {
      daysInMonth: dayCount,
      // Days this person was actually expected to turn up.
      expectedWorkingDays: days.filter(
        (x) =>
          !["HOLIDAY", "WEEK_OFF", "FUTURE", "NOT_EMPLOYED", "NOT_TRACKED"].includes(
            x.status,
          ),
      ).length,
      presentDays: count("PRESENT"),
      halfDays: count("HALF_DAY"),
      absentDayCount: count("ABSENT"),
      leaveDays: count("LEAVE"),
      holidays: count("HOLIDAY"),
      weekOffs: count("WEEK_OFF"),
      notTrackedDays: count("NOT_TRACKED"),
      notEmployedDays: count("NOT_EMPLOYED"),
      lateMarks: days.filter((x) => x.isLate).length,
      lossOfPayDays: round2(lossOfPayDays),
      payableDays: round2(payableDays),
      totalWorkedHours: round2(totalWorkedHours),
      avgWorkedHoursPerWorkedDay:
        workedDayCount > 0 ? round2(totalWorkedHours / workedDayCount) : 0,
    };

    results.push({
      userId: user.id,
      // The schema stores these separately; everything downstream wants one
      // display name, so it is assembled in exactly one place.
      name: [user.firstName, user.lastName].filter(Boolean).join(" ").trim() || "Unnamed",
      employeeCode: user.employeeCode,
      platformId: user.platformId,
      year,
      month,
      monthLabel: `${MONTH_NAMES[month - 1]} ${year}`,
      shiftName: shift?.name ?? null,
      shiftStart: shift?.startTime ?? null,
      dateOfJoining: user.dateOfJoining ? ymd(dayFloor(user.dateOfJoining)) : null,
      thresholds: { fullDayAfterHours, halfDayAfterHours, lateLoginGraceMinutes },
      days,
      totals,
    });
  }

  // Same order the caller asked in, so a table does not reshuffle itself.
  const byId = new Map(results.map((r) => [r.userId, r]));
  return userIds
    .map((id) => byId.get(id))
    .filter((r): r is MonthAttendance => Boolean(r));
}

/** One person, one month. Delegates, so there is only one set of rules. */
export async function getMonthAttendance(
  userId: string,
  year: number,
  month: number,
): Promise<MonthAttendance> {
  const [one] = await getMonthAttendanceBulk([userId], year, month);
  if (!one) throw new Error("USER_NOT_FOUND");
  return one;
}   