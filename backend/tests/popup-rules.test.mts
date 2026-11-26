// Pop-up rules (category, severity, duration, one-tab claim, mute). npx tsx tests/popup-rules.test.mts
import { categoryOf, severityOf, toastMs, claimToast, popupsEnabled, POPUPS_KEY, soundFor } from "../../frontend/app/dashboard/_notifications/popup.ts";
import { POPUP_TYPES, TYPE_LABEL } from "../../frontend/app/dashboard/_notifications/types.ts";
let pass = 0, fail = 0;
const ok = (n: string, c: boolean, x?: unknown) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  -> " + JSON.stringify(x))); };

ok("categories", categoryOf("BREAK_EXCEEDED") === "Break" && categoryOf("ATTENDANCE_LATE") === "Attendance" && categoryOf("TASK_OVERDUE") === "Task" && categoryOf("ASSIGNED_TASK_DONE") === "Task" && categoryOf("MEETING_ENDED") === "Meeting" && categoryOf("LEAVE_DECIDED") === "Leave" && categoryOf("DEPT_QUERY_COMMENT") === "Query" && categoryOf("DOCUMENT_REJECTED") === "Document" && categoryOf("WHATEVER") === "System");
ok("severity: urgent / warning / success / info", severityOf("BREAK_EXCEEDED") === "urgent" && severityOf("ATTENDANCE_LATE") === "warning" && severityOf("TASK_APPROVED") === "success" && severityOf("MEETING_INVITED") === "info");
ok("leave answer takes its tone from the text", severityOf("LEAVE_DECIDED", "Your leave was approved") === "success" && severityOf("LEAVE_DECIDED", "Your leave was rejected by HR") === "warning" && severityOf("LEAVE_DECIDED", "On hold") === "info");
ok("urgent stays longer than info, nothing is permanent", toastMs("urgent") > toastMs("warning") && toastMs("warning") > toastMs("info") && toastMs("urgent") < 30000);
ok("every new type has a label and a pop-up", ["ATTENDANCE_CLOCK_IN", "ATTENDANCE_CLOCK_OUT", "ATTENDANCE_LATE", "ATTENDANCE_NOT_CLOCKED_IN", "ATTENDANCE_MISSING_CLOCK_OUT", "BREAK_STARTED", "BREAK_ENDED", "BREAK_EXCEEDED", "TASK_OVERDUE", "TASK_OVERDUE_TEAM", "TASK_DUE_SOON", "MEETING_STARTING_SOON", "MEETING_ENDED"].every((t) => TYPE_LABEL[t] && POPUP_TYPES.has(t)));

const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m }; };
const s = mem();
ok("the first tab claims a notification", claimToast(s, "n1", "tabA", 1000) === true);
ok("a second tab does NOT show the same one", claimToast(s, "n1", "tabB", 2000) === false);
ok("the first tab is idempotent (a re-render does not lose it)", claimToast(s, "n1", "tabA", 3000) === true);
ok("a different notification is claimed independently", claimToast(s, "n2", "tabB", 3000) === true);
ok("a stale claim (tab closed 3 minutes ago) does not block", claimToast(s, "n1", "tabC", 1000 + 180_000) === true);
const broken = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
ok("storage blocked: still shows (a duplicate is better than a lost notice)", claimToast(broken, "n9", "tabA") === true);
const p = mem();
ok("pop-ups are on by default", popupsEnabled(p) === true);
p.setItem(POPUPS_KEY, "off");
ok("and can be switched off per device", popupsEnabled(p) === false);
ok("blocked storage = on", popupsEnabled(broken) === true);
ok("urgent alerts play the alarm", soundFor([{ type: "BREAK_EXCEEDED" }]) === "alarm" && soundFor([{ type: "BREAK_LIMIT_EXCEEDED" }]) === "alarm" && soundFor([{ type: "TASK_OVERDUE" }]) === "alarm" && soundFor([{ type: "ATTENDANCE_NOT_CLOCKED_IN" }]) === "alarm");
ok("warnings, invitations and answers play the soft ping", soundFor([{ type: "ATTENDANCE_LATE" }]) === "ping" && soundFor([{ type: "MEETING_STARTING_SOON" }]) === "ping" && soundFor([{ type: "TASK_ASSIGNED" }]) === "ping" && soundFor([{ type: "LEAVE_DECIDED", body: "approved" }]) === "ping");
ok("the person's own clock-in / clock-out / break buttons are silent", ["ATTENDANCE_CLOCK_IN", "ATTENDANCE_CLOCK_OUT", "BREAK_STARTED", "BREAK_ENDED"].every((t) => soundFor([{ type: t }]) === null));
ok("the staff copies about someone else (BREAK_LIMIT_EXCEEDED_TEAM, TASK_OVERDUE_TEAM) only ping, never the alarm", soundFor([{ type: "BREAK_LIMIT_EXCEEDED_TEAM" }]) === "ping" && soundFor([{ type: "TASK_OVERDUE_TEAM" }]) === "ping");
ok("a batch plays the strongest sound once, and ignores the silent ones", soundFor([{ type: "BREAK_STARTED" }, { type: "TASK_ASSIGNED" }]) === "ping" && soundFor([{ type: "TASK_ASSIGNED" }, { type: "BREAK_EXCEEDED" }]) === "alarm" && soundFor([]) === null);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
