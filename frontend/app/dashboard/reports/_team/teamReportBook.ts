// The Manager's complete team productivity report: how the one answer of GET /team-attendance/team-report becomes sheets (Excel) and CSV.
// Pure functions, no network and no browser, so the contents can be tested on their own.
//
// NOTHING is calculated here that the HRMS does not already calculate: working, productive, break, washroom and Team Huddle hours are the values
// the attendance report returns; tasks, ratings and statuses are the stored values; counts are plain counts and hours plain sums of those values.
// There is no productivity percentage and no new formula. Meeting participation is shown as a recorded duration and as the Team Huddle label that
// already sits INSIDE productive time; it is never added to anything. Break time stays its own column (and its own sheet of break rows).

import { lateRemarkText, NO_REMARK } from "./lateRemark";
import { dayLabel, hm } from "./format";
import { dayOf, secondsOfDay, type Col, type InfoSpec, type SheetSpec, type Value } from "./reportXlsx";

// ---------------------------------------------------------------------------------------------- the data
export type TRPerson = { id: string; name: string; employeeCode: string | null; designation: string | null; company: string | null; reportingManager: string | null; projects: string[] };
export type TRAttendance = {
  userId: string; date: string; loginAt: string | null; logoutAt: string | null; workedHours: number | null; productiveHours: number | null; breakHours: number | null;
  washroomHours: number | null; huddleHours: number | null; status: string; statusLabel: string; arrival?: string | null; arrivalMinutes?: number | null; arrivalLimit?: string | null;
  lateReason?: string | null; correctedBy?: string | null; lateMinutes: number | null; earlyDepartureMinutes: number | null; leaveType: string | null; holidayName: string | null;
  note: string | null; tasksCompleted: number; tasksPlanned: number | null;
};
export type TRTask = {
  id: string; userId: string; title: string; description: string | null; project: string | null; taggedManager: string | null; date: string; priority: string; hoursSpent: number | null;
  progress: string; approvalStatus: string; completedAt: string | null; rating: number | null; ratingComment: string | null; completionNote: string | null; rejectionNote: string | null; counted: boolean;
};
export type TRBreak = { userId: string; date: string; type: string; category: string; countsAsBreak: boolean; startedAt: string; endedAt: string | null; seconds: number | null; running: boolean; autoClosed: boolean; remark: string | null };
export type TRMeeting = {
  meetingId: string; userId: string; title: string; kind: string; organizer: string | null; scheduledStart: string; scheduledEnd: string; scheduledSeconds: number; response: string | null;
  status: string; joinedAt: string | null; leftAt: string | null; participationSeconds: number | null; openPastEnd: boolean;
};
export type TRLive = { userId: string; date: string; type: string; title: string | null; approvalStatus: string; startedAt: string | null; endedAt: string | null; seconds: number | null; countsInProductive: boolean };
export type TRLeave = { id: string; userId: string; from: string; to: string; leaveType: string; halfDay: boolean; firstHalf: boolean; dayCount: number; reason: string; status: string; appliedOn: string; decidedAt: string | null; decidedBy: string | null; decisionNote: string | null };
export type TRLeaveDay = { userId: string; date: string; leaveType: string; halfDay: boolean };
export type TRCorrection = { userId: string; date: string; type: string; originalLoginAt: string | null; originalLogoutAt: string | null; requestedLoginAt: string | null; requestedLogoutAt: string | null; reason: string; status: string; reviewedBy: string | null; reviewedAt: string | null; reviewComment: string | null };
export type TeamReportData = {
  generatedAt: string; timezone: string; today: string; from: string; to: string; days: number; scope: { orgTotal: number; filteredTotal: number };
  people: TRPerson[]; attendance: TRAttendance[]; tasks: TRTask[]; breaks: TRBreak[]; meetings: TRMeeting[]; liveMeetings: TRLive[]; leave: TRLeave[]; leaveDays: TRLeaveDay[]; corrections: TRCorrection[];
};

// ---------------------------------------------------------------------------------------------- small helpers
const sec = (hours: number | null | undefined): number | null => (hours === null || hours === undefined ? null : Math.round(hours * 3600));
const title = (s: string | null | undefined) => (s ? s.toLowerCase().replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase()) : null);
const APPROVAL: Record<string, string> = { PENDING: "Waiting for approval", APPROVED: "Approved", REJECTED: "Rejected" };
const LEAVE_STATUS: Record<string, string> = { PENDING: "Pending", APPROVED: "Approved", REJECTED: "Rejected", CANCELLED: "Cancelled" };
const PROGRESS: Record<string, string> = { COMPLETED: "Completed", IN_PROGRESS: "In progress", BLOCKED: "Blocked", NOT_STARTED: "Not started", CANCELLED: "Cancelled" };
const CORRECTION_TYPE: Record<string, string> = { MISSING_CHECKIN: "Missing check-in", MISSING_CHECKOUT: "Missing check-out", INCORRECT_TIME: "Incorrect time", BIOMETRIC_FAILURE: "Biometric failure", FORGOT_CLOCK_IN: "Forgot to clock in", OTHER: "Other" };
const LEAVE_TYPE: Record<string, string> = { CASUAL: "Casual", SICK: "Sick", EARNED: "Earned", UNPAID: "Unpaid", PLANNED: "Planned", COMP_OFF: "Comp-off", OTHER: "Other" };
const CORR_STATUS: Record<string, string> = { PENDING: "Pending", APPROVED: "Approved", REJECTED: "Rejected", CANCELLED: "Cancelled" };

const clockOf = (iso: string | null, tz: string) => (iso ? new Intl.DateTimeFormat("en-IN", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: true }).format(new Date(iso)) : "");
const t = (iso: string | null, tz: string): Value => secondsOfDay(iso, tz);
const d = (iso: string | null, tz: string): Value => dayOf(iso, tz);
const sum = (xs: (number | null | undefined)[]) => xs.reduce<number>((n, x) => n + (typeof x === "number" ? x : 0), 0);
const hhmm = (seconds: number) => `${Math.floor(seconds / 3600)}:${String(Math.floor((seconds % 3600) / 60)).padStart(2, "0")}`;

/** Every calendar day from `from` to `to` (YYYY-MM-DD), inclusive. */
export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let cur = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  for (; cur <= end && out.length < 400; cur += 86400000) out.push(new Date(cur).toISOString().slice(0, 10));
  return out;
}
export const dayName = (iso: string) => new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short" }).format(new Date(`${iso}T00:00:00Z`));

type Index = {
  person: Map<string, TRPerson>;
  att: Map<string, TRAttendance[]>; tasks: Map<string, TRTask[]>; breaks: Map<string, TRBreak[]>; meetings: Map<string, TRMeeting[]>; live: Map<string, TRLive[]>;
  leave: Map<string, TRLeave[]>; leaveDays: Map<string, TRLeaveDay[]>; corrections: Map<string, TRCorrection[]>;
};
function group<T extends { userId: string }>(rows: T[]): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) m.set(r.userId, [...(m.get(r.userId) ?? []), r]);
  return m;
}
export function indexOf(data: TeamReportData): Index {
  return {
    person: new Map(data.people.map((p) => [p.id, p])),
    att: group([...data.attendance].sort((a, b) => a.date.localeCompare(b.date))),
    tasks: group([...data.tasks].sort((a, b) => a.date.localeCompare(b.date))),
    breaks: group([...data.breaks].sort((a, b) => a.startedAt.localeCompare(b.startedAt))),
    meetings: group([...data.meetings].sort((a, b) => a.scheduledStart.localeCompare(b.scheduledStart))),
    live: group(data.liveMeetings),
    leave: group([...data.leave].sort((a, b) => a.from.localeCompare(b.from))),
    leaveDays: group(data.leaveDays),
    corrections: group([...data.corrections].sort((a, b) => a.date.localeCompare(b.date))),
  };
}

// ---------------------------------------------------------------------------------------------- the per-person summary (plain counts and sums)
export type Summary = {
  daysInPeriod: number; present: number; halfDays: number; absent: number; leaveDays: number; holidays: number; weekOffs: number; notTracked: number;
  lateLogins: number; lateRemarks: number; workedSec: number; productiveSec: number; breakSec: number; washroomSec: number; huddleSec: number;
  meetingsJoined: number; meetingSec: number; submitted: number; waiting: number; approved: number; rejected: number; inProgress: number; blocked: number; completed: number; counted: number;
  rated: number; ratings: string; taskHours: number; leaveTaken: number; leavePending: number; leaveRejected: number; corrections: number;
};
export function summaryOf(data: TeamReportData, ix: Index, id: string): Summary {
  const att = ix.att.get(id) ?? [];
  const tasks = ix.tasks.get(id) ?? [];
  const mt = (ix.meetings.get(id) ?? []).filter((m) => m.participationSeconds !== null && m.joinedAt);
  const stars = new Map<number, number>();
  for (const k of tasks) if (k.rating !== null) stars.set(k.rating, (stars.get(k.rating) ?? 0) + 1);
  const ld = ix.leaveDays.get(id) ?? [];
  const lv = ix.leave.get(id) ?? [];
  return {
    daysInPeriod: data.days,
    present: att.filter((r) => r.status === "PRESENT").length, halfDays: att.filter((r) => r.status === "HALF_DAY").length, absent: att.filter((r) => r.status === "ABSENT").length,
    leaveDays: att.filter((r) => r.status === "LEAVE").length, holidays: att.filter((r) => r.status === "HOLIDAY").length, weekOffs: att.filter((r) => r.status === "WEEK_OFF").length,
    notTracked: att.filter((r) => r.status === "NOT_TRACKED").length,
    lateLogins: att.filter((r) => (r.lateMinutes ?? 0) > 0).length, lateRemarks: att.filter((r) => !!r.lateReason).length,
    workedSec: sum(att.map((r) => sec(r.workedHours))), productiveSec: sum(att.map((r) => sec(r.productiveHours))), breakSec: sum(att.map((r) => sec(r.breakHours))),
    washroomSec: sum(att.map((r) => sec(r.washroomHours))), huddleSec: sum(att.map((r) => sec(r.huddleHours))),
    meetingsJoined: mt.length, meetingSec: sum(mt.map((m) => m.participationSeconds)),
    submitted: tasks.length, waiting: tasks.filter((k) => k.approvalStatus === "PENDING").length, approved: tasks.filter((k) => k.approvalStatus === "APPROVED").length,
    rejected: tasks.filter((k) => k.approvalStatus === "REJECTED").length, inProgress: tasks.filter((k) => k.progress === "IN_PROGRESS").length, blocked: tasks.filter((k) => k.progress === "BLOCKED").length,
    completed: tasks.filter((k) => k.progress === "COMPLETED").length, counted: tasks.filter((k) => k.counted).length,
    rated: tasks.filter((k) => k.rating !== null).length,
    ratings: [...stars.entries()].sort((a, b) => b[0] - a[0]).map(([s, n]) => `${s}★ ×${n}`).join(", "),
    taskHours: sum(tasks.map((k) => k.hoursSpent)),
    leaveTaken: sum(ld.map((x) => (x.halfDay ? 0.5 : 1))), leavePending: lv.filter((l) => l.status === "PENDING").length, leaveRejected: lv.filter((l) => l.status === "REJECTED").length,
    corrections: (ix.corrections.get(id) ?? []).length,
  };
}

// ---------------------------------------------------------------------------------------------- the team sheets
const WHO: Col[] = [{ header: "Employee", width: 24 }, { header: "Employee ID", width: 13 }, { header: "Reporting manager", width: 22 }];
const who = (ix: Index, id: string): Value[] => {
  const p = ix.person.get(id);
  return [p?.name ?? "", p?.employeeCode ?? "", p?.reportingManager ?? ""];
};
const byPerson = (data: TeamReportData) => data.people.map((p) => p.id);

export type CategoryKey = "summary" | "attendance" | "tasks" | "meetings" | "hours" | "leave" | "breaks" | "corrections";
export const CATEGORIES: { key: CategoryKey; label: string; sheet: string; file: string }[] = [
  { key: "summary", label: "Overall team productivity summary", sheet: "Team Productivity Summary", file: "summary" },
  { key: "attendance", label: "Team attendance", sheet: "Team Attendance", file: "attendance" },
  { key: "tasks", label: "Daily tasks and task performance", sheet: "Team Task Performance", file: "tasks" },
  { key: "meetings", label: "Meetings and Team Huddles", sheet: "Meetings and Huddles", file: "meetings" },
  { key: "hours", label: "Break and working hours", sheet: "Break and Working Hours", file: "working-hours" },
  { key: "leave", label: "Leave and late remarks", sheet: "Leave and Late Remarks", file: "leave-and-late" },
  { key: "breaks", label: "Break details (every break)", sheet: "Break details", file: "breaks" },
  { key: "corrections", label: "Attendance corrections", sheet: "Attendance corrections", file: "corrections" },
];

function summarySheet(data: TeamReportData, ix: Index): SheetSpec {
  const cols: Col[] = [
    ...WHO, { header: "Designation", width: 20 }, { header: "Project(s)", width: 24 },
    { header: "Days in period", kind: "int", width: 10 }, { header: "Present days", kind: "int", width: 10 }, { header: "Half days", kind: "int", width: 9 }, { header: "Absent days", kind: "int", width: 10 },
    { header: "Leave days", kind: "int", width: 9 }, { header: "Holidays", kind: "int", width: 9 }, { header: "Week-offs", kind: "int", width: 9 }, { header: "Not tracked days", kind: "int", width: 10 },
    { header: "Late logins", kind: "int", width: 9, note: "Days with a late login under the HRMS late-login rule (shift start plus the team's grace)." }, { header: "Late remarks given", kind: "int", width: 10 },
    { header: "Total working hours", kind: "duration", width: 12, note: "The sum of the daily working hours of the Attendance report. Those daily figures are rounded to 0.01 h, so a total can differ from the stored seconds by a few seconds per day." }, { header: "Total productive hours", kind: "duration", width: 12 }, { header: "Total break duration", kind: "duration", width: 12 },
    { header: "Total washroom time", kind: "duration", width: 12 }, { header: "Team Huddle time (inside productive)", kind: "duration", width: 15, note: "A label inside productive hours, never added to them." },
    { header: "Meetings joined", kind: "int", width: 10 }, { header: "Meeting participation recorded", kind: "duration", width: 13, note: "The recorded join-to-leave time of scheduled meetings. Shown for information; productive hours already follow the HRMS rule." },
    { header: "Tasks submitted", kind: "int", width: 10 }, { header: "Waiting for approval", kind: "int", width: 10 }, { header: "Approved", kind: "int", width: 9 }, { header: "Rejected", kind: "int", width: 9 },
    { header: "In progress", kind: "int", width: 9 }, { header: "Blocked", kind: "int", width: 9 }, { header: "Completed", kind: "int", width: 10 }, { header: "Counted as completed", kind: "int", width: 11, note: "Completed, approved and not rated below the completed star: the number the Task productivity report counts." },
    { header: "Tasks rated", kind: "int", width: 9 }, { header: "Ratings given", width: 18 }, { header: "Task hours recorded", kind: "duration", width: 11 },
    { header: "Leave days taken", kind: "decimal", width: 10 }, { header: "Leave requests pending", kind: "int", width: 10 }, { header: "Leave requests rejected", kind: "int", width: 10 }, { header: "Attendance corrections", kind: "int", width: 11 },
  ];
  const rows = byPerson(data).map((id) => {
    const s = summaryOf(data, ix, id);
    const p = ix.person.get(id)!;
    return [
      ...who(ix, id), p.designation, p.projects.join(", "),
      s.daysInPeriod, s.present, s.halfDays, s.absent, s.leaveDays, s.holidays, s.weekOffs, s.notTracked,
      s.lateLogins, s.lateRemarks, s.workedSec, s.productiveSec, s.breakSec, s.washroomSec, s.huddleSec,
      s.meetingsJoined, s.meetingSec,
      s.submitted, s.waiting, s.approved, s.rejected, s.inProgress, s.blocked, s.completed, s.counted, s.rated, s.ratings || null, Math.round(s.taskHours * 3600),
      s.leaveTaken, s.leavePending, s.leaveRejected, s.corrections,
    ] as Value[];
  });
  return { name: "Team Productivity Summary", cols, rows };
}

function attendanceSheet(data: TeamReportData, ix: Index): SheetSpec {
  const tz = data.timezone;
  const cols: Col[] = [
    ...WHO, { header: "Date", kind: "date", width: 13 }, { header: "Day", width: 7 }, { header: "Attendance status", width: 18 }, { header: "Login", kind: "time", width: 10 }, { header: "Logout", kind: "time", width: 10 },
    { header: "Working hours", kind: "duration", width: 11 }, { header: "Productive hours", kind: "duration", width: 11 }, { header: "Late login", kind: "duration", width: 10 }, { header: "Early departure", kind: "duration", width: 10 },
    { header: "Late remark", width: 46, wrap: true }, { header: "Correction", width: 20 }, { header: "Leave type", width: 12 }, { header: "Holiday", width: 16 }, { header: "Note", width: 30, wrap: true },
  ];
  const rows: Value[][] = [];
  for (const id of byPerson(data)) {
    for (const r of ix.att.get(id) ?? []) {
      rows.push([
        ...who(ix, id), r.date, dayName(r.date), r.statusLabel, t(r.loginAt, tz), t(r.logoutAt, tz), sec(r.workedHours), sec(r.productiveHours),
        r.lateMinutes && r.lateMinutes > 0 ? r.lateMinutes * 60 : null, r.earlyDepartureMinutes && r.earlyDepartureMinutes > 0 ? r.earlyDepartureMinutes * 60 : null,
        lateRemarkText({ arrival: r.arrival ?? null, loginAt: r.loginAt, arrivalMinutes: r.arrivalMinutes, arrivalLimit: r.arrivalLimit, lateReason: r.lateReason, correctedBy: r.correctedBy }, tz),
        r.correctedBy ? `Corrected by ${r.correctedBy}` : null, title(r.leaveType), r.holidayName, r.note,
      ]);
    }
  }
  return { name: "Team Attendance", cols, rows };
}

function tasksSheet(data: TeamReportData, ix: Index): SheetSpec {
  const tz = data.timezone;
  const cols: Col[] = [
    ...WHO, { header: "Task date", kind: "date", width: 13 }, { header: "Project", width: 22 }, { header: "Task", width: 34, wrap: true }, { header: "Description", width: 44, wrap: true },
    { header: "Priority", width: 10 }, { header: "Progress", width: 12 }, { header: "Hours recorded", kind: "duration", width: 10 }, { header: "Approval status", width: 18 }, { header: "Approver (tagged manager)", width: 22 },
    { header: "Completed on", kind: "date", width: 13 }, { header: "Completed at", kind: "time", width: 11 }, { header: "Counted as completed", width: 11 },
    { header: "Rating (stars)", kind: "int", width: 9 }, { header: "Manager feedback", width: 36, wrap: true }, { header: "Employee note on completion", width: 30, wrap: true }, { header: "Reason sent back", width: 30, wrap: true },
  ];
  const rows: Value[][] = [];
  for (const id of byPerson(data)) {
    for (const k of ix.tasks.get(id) ?? []) {
      rows.push([
        ...who(ix, id), k.date, k.project, k.title, k.description, title(k.priority), PROGRESS[k.progress] ?? title(k.progress), k.hoursSpent === null ? null : Math.round(k.hoursSpent * 3600),
        APPROVAL[k.approvalStatus] ?? title(k.approvalStatus), k.taggedManager, d(k.completedAt, tz), t(k.completedAt, tz), k.counted ? "Yes" : "No",
        k.rating, k.ratingComment, k.completionNote, k.rejectionNote,
      ]);
    }
  }
  return { name: "Team Task Performance", cols, rows };
}

function meetingsSheet(data: TeamReportData, ix: Index): SheetSpec {
  const tz = data.timezone;
  const cols: Col[] = [
    ...WHO, { header: "Date", kind: "date", width: 13 }, { header: "Type", width: 16 }, { header: "Meeting", width: 30, wrap: true }, { header: "Organizer", width: 20 },
    { header: "Scheduled start", kind: "time", width: 11 }, { header: "Scheduled end", kind: "time", width: 11 }, { header: "Scheduled duration", kind: "duration", width: 11 },
    { header: "Invitation answer", width: 12 }, { header: "Participation", width: 18 }, { header: "Joined at", kind: "time", width: 10 }, { header: "Left at", kind: "time", width: 10 },
    { header: "Participation duration", kind: "duration", width: 12 }, { header: "Note", width: 40, wrap: true },
  ];
  const rows: Value[][] = [];
  for (const id of byPerson(data)) {
    for (const m of ix.meetings.get(id) ?? []) {
      rows.push([
        ...who(ix, id), d(m.scheduledStart, tz), m.kind, m.title, m.organizer, t(m.scheduledStart, tz), t(m.scheduledEnd, tz), m.scheduledSeconds, title(m.response), m.status,
        t(m.joinedAt, tz), t(m.leftAt, tz), m.participationSeconds,
        m.openPastEnd ? "Not ended: counted only up to the scheduled end; the organizer can correct it." : m.joinedAt ? "Self-reported join and leave times." : null,
      ]);
    }
    for (const m of ix.live.get(id) ?? []) {
      rows.push([
        ...who(ix, id), m.date, "Live meeting", m.title ?? title(m.type), null, null, null, null, null, title(m.approvalStatus),
        t(m.startedAt, tz), t(m.endedAt, tz), m.seconds, m.countsInProductive ? "Approved: this time is inside productive hours." : "Not approved: not counted in productive hours.",
      ]);
    }
  }
  return { name: "Meetings and Huddles", cols, rows };
}

/** "Tea 10:30 AM–10:40 AM (10m)" for a break, used in the daily sheets. */
const breakLine = (b: TRBreak, tz: string) =>
  `${b.category.startsWith("Break") ? title(b.type) : b.category.startsWith("Washroom") ? "Washroom" : "Discussion"} ${clockOf(b.startedAt, tz)}–${b.endedAt ? clockOf(b.endedAt, tz) : "running"}${b.seconds !== null ? ` (${hm(b.seconds)})` : ""}`;

function hoursSheet(data: TeamReportData, ix: Index): SheetSpec {
  const tz = data.timezone;
  const cols: Col[] = [
    ...WHO, { header: "Date", kind: "date", width: 13 }, { header: "Day", width: 7 }, { header: "Attendance status", width: 18 }, { header: "Login", kind: "time", width: 10 }, { header: "Logout", kind: "time", width: 10 },
    { header: "Working hours", kind: "duration", width: 11 }, { header: "Productive hours", kind: "duration", width: 11 }, { header: "Break duration", kind: "duration", width: 11, note: "Tea, lunch, personal and other breaks. Washroom is not a break." },
    { header: "Washroom time", kind: "duration", width: 11 }, { header: "Team Huddle (inside productive)", kind: "duration", width: 13 }, { header: "Breaks that day", width: 60, wrap: true },
  ];
  const rows: Value[][] = [];
  for (const id of byPerson(data)) {
    const br = ix.breaks.get(id) ?? [];
    for (const r of ix.att.get(id) ?? []) {
      rows.push([
        ...who(ix, id), r.date, dayName(r.date), r.statusLabel, t(r.loginAt, tz), t(r.logoutAt, tz), sec(r.workedHours), sec(r.productiveHours), sec(r.breakHours), sec(r.washroomHours), sec(r.huddleHours),
        br.filter((b) => b.date === r.date).map((b) => breakLine(b, tz)).join("\n") || null,
      ]);
    }
  }
  return { name: "Break and Working Hours", cols, rows };
}

function breaksSheet(data: TeamReportData, ix: Index): SheetSpec {
  const tz = data.timezone;
  const cols: Col[] = [
    ...WHO, { header: "Date", kind: "date", width: 13 }, { header: "Activity", width: 26 }, { header: "Type", width: 10 }, { header: "Start", kind: "time", width: 10 }, { header: "End", kind: "time", width: 10 },
    { header: "Duration", kind: "duration", width: 10 }, { header: "Counts as break", width: 11 }, { header: "Remark", width: 34, wrap: true },
  ];
  const rows: Value[][] = [];
  for (const id of byPerson(data)) {
    for (const b of ix.breaks.get(id) ?? []) {
      rows.push([...who(ix, id), b.date, b.category, title(b.type), t(b.startedAt, tz), t(b.endedAt, tz), b.seconds, b.countsAsBreak ? "Yes" : "No", b.running ? "Still running" : b.autoClosed ? `Closed automatically${b.remark ? `. ${b.remark}` : ""}` : b.remark]);
    }
  }
  return { name: "Break details", cols, rows };
}

function leaveSheet(data: TeamReportData, ix: Index): SheetSpec {
  const tz = data.timezone;
  const cols: Col[] = [
    ...WHO, { header: "Record", width: 14 }, { header: "From", kind: "date", width: 13 }, { header: "To", kind: "date", width: 13 }, { header: "Leave type / detail", width: 40, wrap: true },
    { header: "Leave days", kind: "decimal", width: 9 }, { header: "Late by", kind: "duration", width: 9 }, { header: "Status", width: 16 }, { header: "Applied on", kind: "date", width: 13 },
    { header: "Decided by", width: 18 }, { header: "Decided on", kind: "date", width: 13 }, { header: "Reason / remark", width: 36, wrap: true }, { header: "Decision note", width: 28, wrap: true },
  ];
  const rows: Value[][] = [];
  for (const id of byPerson(data)) {
    for (const l of ix.leave.get(id) ?? []) {
      rows.push([
        ...who(ix, id), "Leave request", l.from, l.to, `${LEAVE_TYPE[l.leaveType] ?? title(l.leaveType)}${l.halfDay ? ` (${l.firstHalf ? "first" : "second"} half)` : ""}`, l.dayCount, null,
        LEAVE_STATUS[l.status] ?? title(l.status), d(l.appliedOn, tz), l.decidedBy, d(l.decidedAt, tz), l.reason, l.decisionNote,
      ]);
    }
    for (const r of ix.att.get(id) ?? []) {
      const late = r.arrival === "LATE" || r.arrival === "HALF_DAY" || (r.lateMinutes ?? 0) > 0;
      if (!late) continue;
      const minutes = (r.lateMinutes ?? 0) > 0 ? (r.lateMinutes as number) : r.arrivalMinutes && r.arrivalMinutes > 0 ? r.arrivalMinutes : null;
      rows.push([
        ...who(ix, id), "Late arrival", r.date, r.date, lateRemarkText({ arrival: r.arrival ?? null, loginAt: r.loginAt, arrivalMinutes: r.arrivalMinutes, arrivalLimit: r.arrivalLimit, lateReason: r.lateReason, correctedBy: r.correctedBy }, tz),
        null, minutes === null ? null : minutes * 60, r.statusLabel, null, null, null, r.lateReason ?? NO_REMARK, null,
      ]);
    }
  }
  return { name: "Leave and Late Remarks", cols, rows };
}

function correctionsSheet(data: TeamReportData, ix: Index): SheetSpec {
  const tz = data.timezone;
  const cols: Col[] = [
    ...WHO, { header: "Date", kind: "date", width: 13 }, { header: "Type", width: 18 }, { header: "Login on record", kind: "time", width: 11 }, { header: "Logout on record", kind: "time", width: 11 },
    { header: "Login requested", kind: "time", width: 11 }, { header: "Logout requested", kind: "time", width: 11 }, { header: "Reason", width: 36, wrap: true }, { header: "Status", width: 12 },
    { header: "Reviewed by", width: 18 }, { header: "Reviewed on", kind: "date", width: 13 }, { header: "Review comment", width: 30, wrap: true },
  ];
  const rows: Value[][] = [];
  for (const id of byPerson(data)) {
    for (const c of ix.corrections.get(id) ?? []) {
      rows.push([...who(ix, id), c.date, CORRECTION_TYPE[c.type] ?? title(c.type), t(c.originalLoginAt, tz), t(c.originalLogoutAt, tz), t(c.requestedLoginAt, tz), t(c.requestedLogoutAt, tz), c.reason, CORR_STATUS[c.status] ?? title(c.status), c.reviewedBy, d(c.reviewedAt, tz), c.reviewComment]);
    }
  }
  return { name: "Attendance corrections", cols, rows };
}

const BUILDERS: Record<CategoryKey, (data: TeamReportData, ix: Index) => SheetSpec> = {
  summary: summarySheet, attendance: attendanceSheet, tasks: tasksSheet, meetings: meetingsSheet, hours: hoursSheet, leave: leaveSheet, breaks: breaksSheet, corrections: correctionsSheet,
};
export const categorySheet = (data: TeamReportData, key: CategoryKey): SheetSpec => BUILDERS[key](data, indexOf(data));

// ---------------------------------------------------------------------------------------------- one employee: the full day-by-day record
export const periodLabel = (data: TeamReportData) => `${dayLabel(data.from)} to ${dayLabel(data.to)} (${data.days} ${data.days === 1 ? "day" : "days"})`;

function employeeSheetName(p: TRPerson, taken: Set<string>): string {
  const base = `${p.employeeCode ? p.employeeCode + " " : ""}${p.name}`.replace(/[\[\]:*?/\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 31) || "Employee";
  let name = base;
  for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${base.slice(0, 31 - String(i).length - 1)} ${i}`;
  taken.add(name.toLowerCase());
  return name;
}

export function employeeSheet(data: TeamReportData, ix: Index, id: string, name: string): SheetSpec {
  const tz = data.timezone;
  const p = ix.person.get(id)!;
  const s = summaryOf(data, ix, id);
  const att = new Map((ix.att.get(id) ?? []).map((r) => [r.date, r]));
  const tasks = ix.tasks.get(id) ?? [];
  const brk = ix.breaks.get(id) ?? [];
  const mt = ix.meetings.get(id) ?? [];
  const live = ix.live.get(id) ?? [];
  const lv = ix.leave.get(id) ?? [];
  const cors = ix.corrections.get(id) ?? [];
  const cols: Col[] = [
    { header: "Date", kind: "date", width: 13 }, { header: "Day", width: 7 }, { header: "Attendance status", width: 18 }, { header: "Login", kind: "time", width: 10 }, { header: "Logout", kind: "time", width: 10 },
    { header: "Working hours", kind: "duration", width: 11 }, { header: "Productive hours", kind: "duration", width: 11 }, { header: "Break duration", kind: "duration", width: 11 },
    { header: "Washroom time", kind: "duration", width: 11 }, { header: "Team Huddle (inside productive)", kind: "duration", width: 13 }, { header: "Late remark", width: 40, wrap: true },
    { header: "Correction", width: 30, wrap: true }, { header: "Leave", width: 26, wrap: true }, { header: "Tasks submitted", kind: "int", width: 10 }, { header: "Tasks completed", kind: "int", width: 10 },
    { header: "Task details", width: 60, wrap: true }, { header: "Break details", width: 44, wrap: true }, { header: "Meeting details", width: 50, wrap: true },
  ];
  const rows: Value[][] = [];
  const last = data.to < data.today ? data.to : data.today;
  for (const day of daysBetween(data.from, last)) {
    const r = att.get(day);
    const dayTasks = tasks.filter((k) => k.date === day);
    const taskLines = dayTasks.map((k) => `• ${k.title}${k.project ? ` [${k.project}]` : ""} — ${PROGRESS[k.progress] ?? k.progress}, ${APPROVAL[k.approvalStatus] ?? k.approvalStatus}${k.hoursSpent !== null ? `, ${k.hoursSpent}h` : ""}${k.rating !== null ? `, ${k.rating}★${k.ratingComment ? ` "${k.ratingComment}"` : ""}` : ""}${k.rejectionNote ? ` (sent back: ${k.rejectionNote})` : ""}`);
    const meetLines = [
      ...mt.filter((m) => dayOf(m.scheduledStart, tz) === day).map((m) => `• ${m.kind}: ${m.title} ${clockOf(m.scheduledStart, tz)}–${clockOf(m.scheduledEnd, tz)}, ${m.status}${m.joinedAt ? `, joined ${clockOf(m.joinedAt, tz)}${m.leftAt ? `, left ${clockOf(m.leftAt, tz)}` : ", not ended"}${m.participationSeconds !== null ? ` (${hm(m.participationSeconds)})` : ""}` : ""}`),
      ...live.filter((m) => m.date === day).map((m) => `• Live meeting: ${m.title ?? title(m.type)}, ${title(m.approvalStatus)}${m.seconds !== null ? ` (${hm(m.seconds)})` : ""}`),
    ];
    const leaveLines = lv.filter((l) => l.from <= day && l.to >= day).map((l) => `${LEAVE_TYPE[l.leaveType] ?? l.leaveType}${l.halfDay ? " (half day)" : ""}, ${LEAVE_STATUS[l.status] ?? l.status}`);
    const corr = cors.filter((c) => c.date === day).map((c) => `${CORRECTION_TYPE[c.type] ?? c.type}: ${CORR_STATUS[c.status] ?? c.status}`);
    rows.push([
      day, dayName(day), r ? r.statusLabel : "No record", r ? t(r.loginAt, tz) : null, r ? t(r.logoutAt, tz) : null, r ? sec(r.workedHours) : null, r ? sec(r.productiveHours) : null, r ? sec(r.breakHours) : null,
      r ? sec(r.washroomHours) : null, r ? sec(r.huddleHours) : null,
      r ? lateRemarkText({ arrival: r.arrival ?? null, loginAt: r.loginAt, arrivalMinutes: r.arrivalMinutes, arrivalLimit: r.arrivalLimit, lateReason: r.lateReason, correctedBy: r.correctedBy }, tz) : null,
      corr.join("\n") || (r?.correctedBy ? `Corrected by ${r.correctedBy}` : null), leaveLines.join("\n") || (r?.leaveType ? title(r.leaveType) : null),
      dayTasks.length, r ? r.tasksCompleted : null, taskLines.join("\n") || null, brk.filter((b) => b.date === day).map((b) => breakLine(b, tz)).join("\n") || null, meetLines.join("\n") || null,
    ]);
  }
  const preamble: [string, string | number][] = [
    ["Employee", p.name], ["Employee ID", p.employeeCode ?? ""], ["Designation", p.designation ?? ""], ["Company", p.company ?? ""], ["Reporting manager", p.reportingManager ?? "Not assigned"],
    ["Project(s)", p.projects.join(", ")], ["Period", periodLabel(data)],
    ["Attendance", `${s.present} present, ${s.halfDays} half day, ${s.absent} absent, ${s.leaveDays} leave, ${s.holidays} holiday, ${s.weekOffs} week-off, ${s.lateLogins} late login(s)`],
    ["Total working / productive / break", `${hhmm(s.workedSec)} / ${hhmm(s.productiveSec)} / ${hhmm(s.breakSec)}  (washroom ${hhmm(s.washroomSec)}, Team Huddle ${hhmm(s.huddleSec)} inside productive)`],
    ["Meetings", `${s.meetingsJoined} joined, ${hhmm(s.meetingSec)} recorded participation`],
    ["Tasks", `${s.submitted} submitted, ${s.approved} approved, ${s.waiting} waiting, ${s.rejected} rejected, ${s.completed} completed, ${s.blocked} blocked, ${s.rated} rated${s.ratings ? ` (${s.ratings})` : ""}`],
    ["Leave", `${s.leaveTaken} day(s) taken, ${s.leavePending} pending, ${s.leaveRejected} rejected request(s)`],
  ];
  return { name, cols, rows, preamble };
}

/** All sheets of the complete workbook, in the agreed order: the six team sheets, break details and corrections, then one sheet per employee. */
export function allSheets(data: TeamReportData): SheetSpec[] {
  const ix = indexOf(data);
  const order: CategoryKey[] = ["summary", "attendance", "tasks", "meetings", "hours", "leave", "breaks", "corrections"];
  const taken = new Set(order.map((k) => CATEGORIES.find((c) => c.key === k)!.sheet.toLowerCase()).concat("report info"));
  const sheets = order.map((k) => BUILDERS[k](data, ix));
  for (const p of data.people) sheets.push(employeeSheet(data, ix, p.id, employeeSheetName(p, taken)));
  return sheets;
}

/** One employee's own workbook sheet. */
export function oneEmployeeSheet(data: TeamReportData, id: string): SheetSpec {
  const ix = indexOf(data);
  const p = ix.person.get(id);
  if (!p) throw new Error("That employee is not in this report.");
  return employeeSheet(data, ix, id, employeeSheetName(p, new Set(["report info"])));
}

// ---------------------------------------------------------------------------------------------- the "Report info" sheet and CSV
export function reportInfo(data: TeamReportData, filters: [string, string][], exportedBy: string | null, label = "Team productivity report"): InfoSpec {
  const s = data.people.map((p) => summaryOf(data, indexOf(data), p.id));
  return {
    report: label,
    period: periodLabel(data),
    filters,
    exportedAt: new Date(),
    exportedBy,
    timezone: data.timezone,
    counts: [["Employees included", data.people.length]],
    totals: [
      ["Total working hours", hhmm(sum(s.map((x) => x.workedSec)))], ["Total productive hours", hhmm(sum(s.map((x) => x.productiveSec)))], ["Total break duration", hhmm(sum(s.map((x) => x.breakSec)))],
      ["Tasks submitted", sum(s.map((x) => x.submitted))], ["Leave days taken", sum(s.map((x) => x.leaveTaken))],
    ],
  };
}

const pad = (n: number) => String(n).padStart(2, "0");
/** A cell as text for a CSV file (readable, not a spreadsheet type). */
export function csvCell(v: Value, kind: Col["kind"]): string {
  if (v === null || v === "") return "";
  if (kind === "date" && typeof v === "string") return dayLabel(v);
  if (kind === "time" && typeof v === "number") {
    const h = Math.floor(v / 3600);
    return `${pad(h % 12 === 0 ? 12 : h % 12)}:${pad(Math.floor((v % 3600) / 60))} ${h < 12 ? "AM" : "PM"}`;
  }
  if (kind === "duration" && typeof v === "number") return hhmm(v);
  return String(v);
}
/** Every line of the CSV file in order: the lines above the table (if any), a blank line, the header, then the rows. */
export function csvLines(sheet: SheetSpec): string[][] {
  const width = Math.max(2, sheet.cols.length);
  const pad2 = (a: string[]) => [...a, ...Array(Math.max(0, width - a.length)).fill("")];
  const pre = (sheet.preamble ?? []).map(([k, v]) => pad2([k, String(v)]));
  return [...(pre.length ? [...pre, pad2([])] : []), sheet.cols.map((c) => c.header), ...sheet.rows.map((r) => r.map((v, i) => csvCell(v, sheet.cols[i]?.kind)))];
}
