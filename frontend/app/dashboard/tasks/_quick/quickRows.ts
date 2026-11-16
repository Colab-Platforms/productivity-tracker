// Quick Add rules that need no screen: building rows, checking them, and applying the server's answer. Pure, so they can be tested alone.
import { blockedReasonProblem } from "../../_progress/progress";

export const MAX_QUICK_ROWS = 20; // tasks per "Submit all" (the server enforces the same limit)

export type QuickRow = {
  uid: string;
  title: string;
  description: string;
  projectId: string;
  managerId: string;
  hours: string;
  weight: string;
  progress: string;
  // Why a Blocked task cannot go on (required when the progress is Blocked; ignored for every other progress).
  blockedNote?: string;
  // true = the person chose this row's project / manager by hand, so changing the default settings leaves it alone.
  // false or missing = the row follows the default.
  projectCustom?: boolean;
  managerCustom?: boolean;
  error?: string; // why this row was not sent (shown on the row)
};

export type Choices = { projects: { id: string }[]; managers: { id: string }[] };

let counter = 0;
export const newUid = () => `r${Date.now().toString(36)}${(counter++).toString(36)}`;

export function blankRow(defaults?: { projectId?: string; managerId?: string }): QuickRow {
  return { uid: newUid(), title: "", description: "", projectId: defaults?.projectId ?? "", managerId: defaults?.managerId ?? "", hours: "", weight: "MEDIUM", progress: "IN_PROGRESS" };
}

/** A copy of a row (a new id, no error), for "Duplicate task". */
export function duplicateOf(row: QuickRow): QuickRow {
  return { ...row, uid: newUid(), error: undefined };
}

/** A row nobody has typed anything into: it is ignored on submit instead of being reported as an error. */
export function isEmptyRow(r: QuickRow): boolean {
  return !r.title.trim() && !r.description.trim() && !r.hours.trim();
}

/** What is wrong with a row, in words, or null. Mirrors what the server will check; the server still decides. */
export function rowProblem(r: QuickRow, c: Choices): string | null {
  if (!r.title.trim()) return "Add a task description.";
  if (r.title.trim().length > 200) return "Keep the description under 200 characters.";
  if (c.projects.length > 0 && !r.projectId) return "Select a project.";
  if (c.managers.length > 0 && !r.managerId) return "Tag a reporting manager.";
  if (r.progress === "BLOCKED") {
    const bp = blockedReasonProblem(r.blockedNote ?? "");
    if (bp) return bp;
  }
  if (r.hours.trim()) {
    const n = Number(r.hours);
    if (!Number.isFinite(n) || n < 0 || n > 24) return "Hours must be between 0 and 24.";
  }
  return null;
}

/** The request body for one row. */
export function toPayload(r: QuickRow) {
  return {
    key: r.uid,
    title: r.title.trim(),
    description: r.description.trim(),
    weight: r.weight,
    progress: r.progress,
    ...(r.progress === "BLOCKED" ? { blockedNote: (r.blockedNote ?? "").trim() } : {}),
    ...(r.hours.trim() ? { hoursSpent: Number(r.hours) } : {}),
    ...(r.projectId ? { teamId: r.projectId } : {}),
    ...(r.managerId ? { taggedManagerId: r.managerId } : {}),
  };
}

/** A draft row from the server -> an editor row. A project or manager that is no longer on the lists is dropped, never kept invisibly. */
export function fromDraft(d: { title: string; description: string | null; teamId: string | null; taggedManagerId: string | null; hoursSpent: number | null; weight: string; progress: string }, c: Choices): QuickRow {
  return {
    uid: newUid(),
    title: d.title,
    description: d.description ?? "",
    projectId: d.teamId && c.projects.some((p) => p.id === d.teamId) ? d.teamId : "",
    managerId: d.taggedManagerId && c.managers.some((m) => m.id === d.taggedManagerId) ? d.taggedManagerId : "",
    hours: d.hoursSpent === null || d.hoursSpent === undefined ? "" : String(d.hoursSpent),
    weight: d.weight,
    progress: d.progress,
  };
}

/** An editor row -> a draft row for the server. */
export function toDraft(r: QuickRow) {
  return { title: r.title, description: r.description, teamId: r.projectId || null, taggedManagerId: r.managerId || null, hoursSpent: r.hours.trim() ? Number(r.hours) : null, weight: r.weight, progress: r.progress };
}

export type ServerResult = { key: string; ok: boolean; taskId?: string; error?: string };

/**
 * Applies the server's answer: rows that were sent leave the editor (they are listed in the summary), rows that failed STAY with the reason.
 * Nothing the person typed is ever dropped without being either sent or shown.
 */
export function applyResults(rows: QuickRow[], results: ServerResult[]) {
  const byKey = new Map(results.map((x) => [x.key, x]));
  const sent: QuickRow[] = [];
  const kept: QuickRow[] = [];
  for (const r of rows) {
    const x = byKey.get(r.uid);
    if (x?.ok) sent.push(r);
    else kept.push(x ? { ...r, error: x.error ?? "This task could not be sent." } : r);
  }
  return { sent, kept };
}

/**
 * What the "Default task settings" box starts with: the defaults the server worked out from the person's team and reporting line, and where
 * the records give none the project / manager they last chose in this browser (only if it is still on the lists).
 */
export function startingDefaults(server: { projectId?: string | null; managerId?: string | null } | null | undefined, saved: { projectId?: string; managerId?: string } | null, c: Choices) {
  const remembered = rememberedDefaults(saved, c);
  const okProject = server?.projectId && c.projects.some((p) => p.id === server.projectId) ? server.projectId : "";
  const okManager = server?.managerId && c.managers.some((m) => m.id === server.managerId) ? server.managerId : "";
  return { projectId: okProject || remembered.projectId, managerId: okManager || remembered.managerId, fromRecords: { project: !!okProject, manager: !!okManager } };
}

/** The project / manager to preselect on a new row: the last ones this person chose, only if they are still on the lists. */
export function rememberedDefaults(saved: { projectId?: string; managerId?: string } | null, c: Choices) {
  return {
    projectId: saved?.projectId && c.projects.some((p) => p.id === saved.projectId) ? saved.projectId : "",
    managerId: saved?.managerId && c.managers.some((m) => m.id === saved.managerId) ? saved.managerId : "",
  };
}

// ---- Default task settings (one project and one reporting manager for the whole screen) ----------------------------------------------------

export type DefaultSettings = { projectId: string; managerId: string };
export type DefaultField = "projectId" | "managerId";
const customKey = (f: DefaultField) => (f === "projectId" ? "projectCustom" : "managerCustom") as "projectCustom" | "managerCustom";

/** Does this row choose its own value for the field (true), or follow the default (false)? */
export const isCustom = (r: QuickRow, f: DefaultField): boolean => r[customKey(f)] === true;

/**
 * The person changed the DEFAULT project or manager: every row that still follows it takes the new value; a row the person set by hand is
 * never touched. Descriptions, hours, priority and progress are never touched either.
 */
export function applyDefault(rows: QuickRow[], f: DefaultField, value: string): QuickRow[] {
  return rows.map((r) => {
    if (!isCustom(r, f)) return { ...r, [f]: value, error: undefined };
    // A hand-picked row keeps its own value. If that value happens to be the new default, it simply follows the default again.
    return r[f] === value ? { ...r, [customKey(f)]: false } : r;
  });
}

/**
 * The person changed ONE row's project or manager. Only that row changes. Choosing the same value as the default means the row follows the
 * default again; any other value makes it a custom choice.
 */
export function setRowChoice(r: QuickRow, f: DefaultField, value: string, defaults: DefaultSettings): QuickRow {
  return { ...r, [f]: value, [customKey(f)]: value !== defaults[f], error: undefined };
}

/** "Reset to default" on one row's project or manager. */
export function resetRowChoice(r: QuickRow, f: DefaultField, defaults: DefaultSettings): QuickRow {
  return { ...r, [f]: defaults[f], [customKey(f)]: false, error: undefined };
}

/**
 * A reopened draft stores each row's own project and manager, not which ones followed the default. So the default is worked out again:
 * the value most rows use becomes the default (the first one met wins a tie), a row with that value (or with none) follows it, and every
 * other row is a custom choice. The rows keep exactly the values they were saved with.
 */
export function inferDefaults(rows: QuickRow[]): { defaults: DefaultSettings; rows: QuickRow[] } {
  const pick = (f: DefaultField): string => {
    const count = new Map<string, number>();
    for (const r of rows) if (r[f]) count.set(r[f], (count.get(r[f]) ?? 0) + 1);
    let best = "";
    let n = 0;
    for (const [v, c] of count) if (c > n) { best = v; n = c; }
    return best;
  };
  const defaults = { projectId: pick("projectId"), managerId: pick("managerId") };
  return {
    defaults,
    rows: rows.map((r) => ({
      ...r,
      projectCustom: r.projectId !== "" && r.projectId !== defaults.projectId,
      managerCustom: r.managerId !== "" && r.managerId !== defaults.managerId,
    })),
  };
}

// ---- Add Previous Day's Tasks -----------------------------------------------------------------------------------------------------------

export const LATE_REASON_MIN = 3;
export const LATE_REASON_MAX = 300;

export type LateState = { lateByDays: number; notPast: boolean; tooOld: boolean; outside: boolean };

/** How the chosen date relates to today (calendar days). Mirrors the server's rule; the server still decides. */
export function lateState(date: string, today: string, allowedDays: number, maxDays: number): LateState {
  const days = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 86400000);
  const valid = Number.isFinite(days);
  return { lateByDays: valid ? days : 0, notPast: !valid || days < 1, tooOld: valid && days > maxDays, outside: valid && days > allowedDays };
}

/** A reason problem in words, or null. Only needed outside the allowed window; always limited in length. */
export function reasonProblem(reason: string, outside: boolean): string | null {
  const r = reason.trim();
  if (r.length > LATE_REASON_MAX) return `Keep the reason to ${LATE_REASON_MAX} characters or fewer.`;
  if (outside && r.length < LATE_REASON_MIN) return "Add a reason for submitting this late.";
  return null;
}
