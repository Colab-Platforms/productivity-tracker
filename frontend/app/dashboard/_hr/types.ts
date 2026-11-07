// Shapes of the existing API responses the HR dashboard reads. They mirror
// what the backend already returns; nothing here asks the backend for
// anything new except the optional ?userId= on /reports.

export type Totals = {
  headcount: number;
  daysExpected: number;
  daysPresent: number;
  daysOnLeave: number;
  daysAbsent: number;
  productiveSeconds: number;
  breakSeconds: number;
  meetingSeconds: number;
  targetSeconds: number;
  attainment: number;
  taskScore: number;
  tasksTotal: number;
  tasksDone: number;
};

export type Person = {
  userId: string;
  name: string;
  employeeCode: string | null;
  role: string;
  designation: string | null;
  teamName?: string | null;
  daysNotTracked?: number;
  daysExpected: number;
  daysPresent: number;
  daysOnLeave: number;
  daysAbsent: number;
  productiveSeconds: number;
  breakSeconds?: number;
  targetSeconds: number;
  attainment: number;
  tasksTotal: number;
  tasksDone: number;
  taskScore: number;
};

export type Bucket = {
  key: string;
  headcount: number;
  daysExpected: number;
  daysPresent: number;
  daysOnLeave: number;
  productiveSeconds: number;
  targetSeconds: number;
  attainment: number;
};

export type Report = {
  range: { from: string; to: string };
  groupBy: string;
  scope: "self" | "team" | "platform";
  totals: Totals;
  people: Person[];
  buckets: Bucket[];
};

export type AdminUser = {
  id: string;
  name: string;
  employeeCode: string | null;
  role: string;
  status: string;
  designation: string | null;
  company: string | null;
  // already returned by /admin/users; used by the Employee Status table and the anniversaries
  teams?: { id: string; name: string }[];
  dateOfJoining?: string | null;
  photoAt?: string | null;
};

export type LiveRow = {
  userId: string;
  name: string;
  designation: string | null;
  teamName: string;
  company: string | null;
  status: string;
  loginAt: string | null;
};

export type AlertRow = {
  id: string;
  userId: string;
  name: string;
  alertType: string;
  severity: string;
  message: string;
  createdAt: string;
};

export type Holiday = {
  id: string;
  date: string;
  name: string;
  dayType: string;
  company: string | null;
};

export type HolidayResponse = { year: number; today: string; holidays: Holiday[] };

export type Ticket = {
  id: string;
  reference: string;
  subject: string;
  status: string;
  priority: string;
  isOverdue: boolean;
  raisedBy: string;
  // false once staff have answered; missing on an older server (treated as still waiting)
  awaitingReply?: boolean;
};

// /onboarding/candidates returns one row per joiner. pendingReview is how many
// of their submitted documents are waiting for an HR decision.
export type Candidate = {
  id: string;
  company: string | null;
  pendingReview: number;
};

export type Queue = { proposals: unknown[] };
