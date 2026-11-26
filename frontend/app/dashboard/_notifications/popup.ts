// Pure rules for the on-screen pop-ups: which category and severity a notification type has, and the "one tab shows it" claim.
// Nothing here touches the browser by itself (storage is passed in), so it can be tested.

export type Category = "Attendance" | "Break" | "Task" | "Meeting" | "Leave" | "Query" | "Document" | "System";
export type Severity = "info" | "success" | "warning" | "urgent";

export function categoryOf(type: string): Category {
  if (type.startsWith("BREAK_")) return "Break";
  if (type.startsWith("ATTENDANCE_") || type.startsWith("CORRECTION_")) return "Attendance";
  if (type.startsWith("TASK_") || type.startsWith("ASSIGNED_TASK_") || type.startsWith("REPETITIVE_TASK_")) return "Task";
  if (type.startsWith("MEETING_")) return "Meeting";
  if (type.startsWith("LEAVE_") || type.startsWith("OPTIONAL_HOLIDAY_") || type === "HOLIDAY_CALENDAR") return "Leave";
  if (type.startsWith("DEPT_QUERY_") || type.startsWith("QUERY_") || type.startsWith("TICKET_")) return "Query";
  if (type.startsWith("DOCUMENT_") || type.startsWith("WARNING_LETTER_") || type.startsWith("POLICY_") || type === "PAYSLIP_PUBLISHED") return "Document";
  return "System";
}

const URGENT = new Set(["BREAK_EXCEEDED", "BREAK_LIMIT_EXCEEDED", "BREAK_LIMIT_EXCEEDED_TEAM", "ATTENDANCE_NOT_CLOCKED_IN", "TASK_OVERDUE"]);
const WARNING = new Set(["ATTENDANCE_LATE", "ATTENDANCE_MISSING_CLOCK_OUT", "TASK_OVERDUE_TEAM", "TASK_DUE_SOON", "TASK_REJECTED", "TASK_PROPOSAL_RETURNED", "TASK_REVERTED", "TASK_DELETED", "ASSIGNED_TASK_SENT_BACK", "DOCUMENT_REJECTED", "DEPT_QUERY_REJECTED", "DEPT_QUERY_REOPENED", "CORRECTION_REJECTED", "MEETING_CANCELLED", "MEETING_ENDED", "MEETING_STARTING_SOON", "WARNING_LETTER_ISSUED", "REPETITIVE_TASK_ALERT"]);
const SUCCESS = new Set(["ATTENDANCE_CLOCK_IN", "ATTENDANCE_CLOCK_OUT", "BREAK_ENDED", "TASK_APPROVED", "TASK_PROPOSAL_APPROVED", "ASSIGNED_TASK_CONFIRMED", "DOCUMENT_VERIFIED", "DEPT_QUERY_APPROVED", "DEPT_QUERY_COMPLETED", "DEPT_QUERY_CONFIRMED", "CORRECTION_APPROVED", "PAYSLIP_PUBLISHED"]);

export function severityOf(type: string, body = ""): Severity {
  if (URGENT.has(type)) return "urgent";
  if (WARNING.has(type)) return "warning";
  if (SUCCESS.has(type)) return "success";
  // leave and correction answers say approved / rejected in the text
  if (type === "LEAVE_DECIDED" || type === "CORRECTION_DECIDED" || type === "OPTIONAL_HOLIDAY_DECIDED") {
    if (/reject|not approved|declin/i.test(body)) return "warning";
    if (/approv/i.test(body)) return "success";
  }
  return "info";
}

/** Urgent ones stay longer; nothing sticks forever (the bell keeps the history). */
export const toastMs = (s: Severity, type = "") => (type === "BREAK_LIMIT_EXCEEDED" ? 30000 : s === "urgent" ? 12000 : s === "warning" ? 10000 : 7000);
/** Types that also play the alarm sound when their pop-up appears. */
export const ALARM_TYPES = new Set(["BREAK_LIMIT_EXCEEDED"]);

export const SEVERITY_STYLE: Record<Severity, { ring: string; dot: string; label: string; icon: string }> = {
  info: { ring: "ring-indigo-100", dot: "bg-indigo-500", label: "text-indigo-600", icon: "i" },
  success: { ring: "ring-emerald-200", dot: "bg-emerald-500", label: "text-emerald-700", icon: "✓" },
  warning: { ring: "ring-amber-200", dot: "bg-amber-500", label: "text-amber-700", icon: "!" },
  urgent: { ring: "ring-rose-300", dot: "bg-rose-500", label: "text-rose-700", icon: "!!" },
};

type Store = { getItem(k: string): string | null; setItem(k: string, v: string): void };
/**
 * Several tabs of the same browser all receive the same notification. The first one to claim it shows the pop-up; the others stay quiet
 * (the bell in every tab still updates). A claim older than 2 minutes is ignored, so a closed tab never blocks a later notification.
 */
export function claimToast(store: Store, id: string, tabId: string, now = Date.now()): boolean {
  const key = `hrms-toast:${id}`;
  try {
    const cur = store.getItem(key);
    if (cur) {
      const [owner, at] = cur.split("|");
      if (owner === tabId) return true;
      if (now - Number(at) < 120_000) return false;
    }
    store.setItem(key, `${tabId}|${now}`);
    // read back: if two tabs wrote at the same moment, the one that was stored last wins
    return (store.getItem(key) ?? "").startsWith(`${tabId}|`);
  } catch {
    return true; // storage blocked: better a possible duplicate than a lost notification
  }
}

export const POPUPS_KEY = "hrms-popups";
export const popupsEnabled = (store: Store) => {
  try { return store.getItem(POPUPS_KEY) !== "off"; } catch { return true; }
};

// ---- sound ---------------------------------------------------------------------------------------------------------------------------------
// Which sound a batch of new pop-ups plays. Urgent (and the break-limit alert) = the alarm; every other pop-up = the soft ping; the person's OWN
// actions (clock-in/out, break start/end) are silent because they just pressed the button. Whether anything plays at all is the existing sound
// switch (lib/chatAlert.ts `soundOn`, shown in the bell panel), so it can always be turned off.
export const SILENT_TYPES = new Set(["ATTENDANCE_CLOCK_IN", "ATTENDANCE_CLOCK_OUT", "BREAK_STARTED", "BREAK_ENDED"]);
export function soundFor(items: { type: string; body?: string }[]): "alarm" | "ping" | null {
  const audible = items.filter((i) => !SILENT_TYPES.has(i.type));
  if (audible.length === 0) return null;
  // The loud alarm is for the person the problem is about. The copy sent to managers / HR / Admin about someone else (types ending in _TEAM) is only a soft ping.
  if (audible.some((i) => !i.type.endsWith("_TEAM") && (ALARM_TYPES.has(i.type) || severityOf(i.type, i.body ?? "") === "urgent"))) return "alarm";
  return "ping";
}
