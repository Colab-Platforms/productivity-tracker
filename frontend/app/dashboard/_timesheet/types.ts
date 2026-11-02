// Shape of GET /tracker/timesheet (backend: tracker/timesheet.service.ts).

export type TsBreak = {
  id: string;
  breakType: string;
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number | null;
  autoClosed: boolean;
  reason: string | null;
};

export type TsMeeting = {
  id: string;
  meetingType: string;
  title: string | null;
  startedAt: string | null;
  endedAt: string | null;
};

export type TsSession = {
  id: string;
  status: "ACTIVE" | "COMPLETED";
  loginAt: string;
  logoutAt: string | null;
  autoClosed: boolean;
  productiveSeconds: number;
  breakSeconds: number;
  washroomSeconds?: number;
  meetingSeconds: number;
  wasLateLogin: boolean;
  lateByMinutes: number;
  lateRemark?: string | null;
  shiftStartTime: string | null;
  project?: { id: string; name: string } | null;
  correction?: { at: string; by: string } | null;
  // The split of this day's productive time (from the server's one shared calculation).
  breakdown?: {
    regularSeconds: number; huddleSeconds: number; otherEligibleSeconds: number; totalSeconds: number;
    huddles: { id: string; meetingId: string; title: string; scheduledStart: string; scheduledEnd: string; joinedAt: string; leftAt: string | null; countedSeconds: number; rawSeconds: number; openPastEnd: boolean; addedByManager: boolean }[];
  } | null;
  breaks: TsBreak[];
  meetings: TsMeeting[];
};

export type TsDay = {
  date: string;
  isFuture: boolean;
  expected: boolean;
  onLeave: boolean;
  holiday: { name: string; dayType: string } | null;
  session: TsSession | null;
};

export type TsSchedule = {
  shift: { name: string; startTime: string; endTime: string; workingDays: number[]; spansMidnight: boolean } | null;
  dailyWorkHours: number;
  productiveHours: number;
  breakBudgetMinutes: number;
  lateLoginGraceMinutes: number;
  overtimeAlertMinutes: number;
};

export type Timesheet = {
  range: { from: string; to: string };
  today: string;
  timezone: string;
  schedule: TsSchedule;
  totals: {
    expectedDays: number;
    onLeaveDays: number;
    plannedSeconds: number;
    daysWorked: number;
    productiveSeconds: number;
    breakSeconds: number;
    washroomSeconds?: number;
    meetingSeconds: number;
    huddleSeconds?: number;
    otherEligibleSeconds?: number;
    regularSeconds?: number;
    elapsedSeconds: number;
    lateDays: number;
  };
  days: TsDay[];
};

export const BREAK_LABEL: Record<string, string> = {
  TEA: "Tea",
  WASHROOM: "Washroom",
  LUNCH: "Lunch",
  PERSONAL: "Personal",
  OTHER: "Other",
};
export const MEETING_LABEL: Record<string, string> = {
  TEAM: "Team meeting",
  ONE_ON_ONE: "One-on-one",
  CLIENT: "Client call",
  TRAINING: "Training session",
  INTERVIEW: "Interview",
  OTHER: "Meeting",
};
