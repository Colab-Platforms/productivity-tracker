// Shared types and small helpers for the Holiday Management screens. The server decides every rule; this file only describes its answers.

export type Kind = "FIXED" | "OPTIONAL";
export type Status = "PUBLISHED" | "DRAFT" | "ARCHIVED";

export type Entry = {
  id: string;
  platformId: string;
  company: string | null;
  date: string; // YYYY-MM-DD
  name: string;
  kind: Kind;
  religion: string | null;
  status: Status;
  weekday: string;
  isPast: boolean;
  importId?: string | null;
};

export type MyRequest = { id: string; holidayId: string; status: string; name: string; date: string; managerNote: string | null; hrNote: string | null };

export type ImportRecord = { id: string; calendarYear: number; fileName: string; status: string; totalRows: number; importedRows: number; skippedRows: number; failedRows: number; createdAt: string; publishedAt: string | null };

export type CalendarData = {
  year: number;
  today: string;
  years: number[];
  canManage: boolean;
  ready: boolean;
  companies: { id: string; name: string }[];
  holidays: Entry[];
  drafts: Entry[];
  archived: Entry[];
  imports: ImportRecord[];
  myOptionalRequests: MyRequest[];
  optionalAllowance: number;
  optionalUsed: number;
};

export type QueueRow = { id: string; status: string; managerNote: string | null; hrNote: string | null; createdAt: string; managerId: string | null; date: string; holiday: string; userId: string; person: string; code: string | null; company: string };

export type PreviewRow = {
  rowNumber: number;
  date: string;
  dateText: string;
  dayText: string;
  weekday: string;
  name: string;
  kind: Kind | null;
  statusText: string;
  religion: string;
  state: "VALID" | "ERROR" | "DUPLICATE_IN_FILE" | "ALREADY_EXISTS";
  messages: string[];
};

export type Preview = {
  ok: boolean;
  missingColumns?: string[];
  company: { id: string; name: string };
  year: number;
  rows: PreviewRow[];
  ignoredEmptyRows?: number;
  yearAlreadyHasHolidays?: number;
  existingDraftId?: string | null;
  note?: string | null;
  summary: { total: number; valid: number; willImport: number; errors: number; duplicatesInFile: number; alreadyExist: number; excluded: number } | null;
};

export const KIND_LABEL: Record<Kind, string> = { FIXED: "Fixed", OPTIONAL: "Optional" };
export const STATUS_LABEL: Record<Status, string> = { PUBLISHED: "Published", DRAFT: "Draft", ARCHIVED: "Archived" };
export const REQUEST_LABEL: Record<string, string> = { PENDING_MANAGER: "Waiting for manager", PENDING_HR: "Waiting for HR", APPROVED: "Approved", REJECTED: "Rejected", CANCELLED: "Cancelled" };
export const REQUEST_CLASS: Record<string, string> = {
  PENDING_MANAGER: "bg-amber-50 text-amber-700 ring-amber-200",
  PENDING_HR: "bg-amber-50 text-amber-700 ring-amber-200",
  APPROVED: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  REJECTED: "bg-rose-50 text-rose-700 ring-rose-200",
  CANCELLED: "bg-slate-100 text-slate-600 ring-slate-200",
};
export const STATE_LABEL: Record<PreviewRow["state"], string> = { VALID: "Ready", ERROR: "Error", DUPLICATE_IN_FILE: "Duplicate in file", ALREADY_EXISTS: "Already saved" };

export const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "26 Jan 2026" from YYYY-MM-DD, without the browser's time zone moving the day. */
export function pretty(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return `${d} ${MONTHS[m - 1].slice(0, 3)} ${y}`;
}

export const msg = (e: unknown): string => (e instanceof Error && e.message ? e.message : "Something went wrong.");
export const codeOf = (e: unknown): string | undefined => (e as { code?: string } | null)?.code;

/** The columns of the sample sheet (the same ones the importer reads). */
export const TEMPLATE_ROWS: string[][] = [
  ["Date", "Day", "Holiday", "Status", "Religion"],
  ["01-Jan-2026", "Thursday", "New Year", "Fixed", "General"],
  ["26-Jan-2026", "Monday", "Republic Day IN", "Fixed", "General"],
  ["19-Mar-2026", "Thursday", "Gudi Padwa", "Optional", "Marathi"],
];
