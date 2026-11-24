// ---------------------------------------------------------------------------
// WORK EFFICIENCY INDEX (policy EFFICIENCY_V1). Pure rules, no database: the service reads the records, this file decides every figure, so the
// same facts can never score differently on two screens and every percentage can be reproduced by hand from the breakdown.
//
// ELIGIBLE TASKS    submitted by the employee, approved, not cancelled, not deleted, dated inside the period (the service filters those; assigned tasks
//                   and a manager's own self-managed tasks are never in the list). Task priority is not used anywhere.
// ONE OUTCOME PER TASK (so a task is never penalised twice), decided at the report cutoff:
//   COMPLETED      status Completed, not graded Failed, not a manager-marked partial, finished on or before the cutoff
//   PARTIAL        a manager marked it partly done AND recorded the verified progress % and a milestone note
//   RETURNED       sent back for QUALITY at least once and still not finished again
//   NOT_COMPLETED  everything else that is eligible (open, in progress, blocked, Failed, an unverified partial mark)
// A returned task is penalised only under "Reverted"; it is left out of "Not completed". A deleted task is not eligible; it only appears under "Deleted".
//
// STANDARD (weight)            formula (each is 0-100 before the weight)
//   Completed tasks      20    completed / eligible
//   Manager ratings      25    average finalized stars / 5, over completed tasks that have a rating (no rating is never 5 and never 0)
//   Task completion time 20    per completed task with BOTH actual active time (automatic timer) and the time the manager confirmed as reasonable:
//                              ratio = actual / expected; ratio <= 1.10 -> 100%; ratio >= 2.00 -> 0%; in between falls in a straight line. No bonus for
//                              finishing early. The average of those task credits is the component.
//   Attendance           10    (present days + half days x 0.5) / scheduled working days (leave, holidays, week-offs and not-tracked days are not
//                              scheduled days, so authorised absence is never penalised)
//   Partial completion    5    average of the manager-verified progress % over partial tasks
//   Not completed        10    1 - overdue unfinished / eligible tasks whose date has passed. Overdue = dated before the cutoff day, outcome
//                              NOT_COMPLETED. A blocked task with a written reason is a dependency, not the employee's delay: it is left out of both.
//   Reverted tasks        7    first-pass acceptance = completed tasks that were never returned for quality / (completed + returned). A return
//                              marked "requirement changed" is not a quality failure and is not counted. Each task counts once however many times
//                              it was reviewed.
//   Manager deletions     3    1 - attributable deletions / (eligible + attributable deletions). Only a deletion with reason "Other" and a written
//                              note is attributable; duplicate, wrong person, wrong project and approved-by-mistake are never held against anyone.
//
// COMPONENT STATES     SCORED | NOT_APPLICABLE (nothing of that kind happened, e.g. no partial tasks; its weight is shared by the others and the
//                      report says so) | MISSING_EVIDENCE (there is work to judge but the evidence is absent, e.g. completed tasks and no rating at all)
// FINAL                any MISSING_EVIDENCE -> blank (never a default). Otherwise earned points / weights that apply x 100.
// STATUS               NO_TASKS | INCOMPLETE_EVIDENCE (blank) | INSUFFICIENT_EVIDENCE (fewer than MIN_TASKS eligible: shown, not trusted)
//                      | PROVISIONAL (some completed tasks are still unrated / have no confirmed time, or a return has no recorded reason) | FINAL
// ---------------------------------------------------------------------------

export const EFFICIENCY_POLICY_VERSION = "EFFICIENCY_V1";
export const MIN_TASKS = 5;
export const TIME_TOLERANCE = 1.1; // up to 110% of the confirmed time is full credit
export const TIME_CEILING = 2.0; // 200% or more earns nothing
export const WEIGHTS = { completed: 20, rating: 25, time: 20, attendance: 10, partial: 5, notCompleted: 10, reverted: 7, deleted: 3 } as const;
export type StandardKey = keyof typeof WEIGHTS;
export const STANDARD_ORDER: StandardKey[] = ["completed", "rating", "time", "attendance", "partial", "notCompleted", "reverted", "deleted"];
export const STANDARD_LABEL: Record<StandardKey, string> = {
  completed: "Completed tasks", rating: "Manager ratings", time: "Task completion time", attendance: "Attendance",
  partial: "Partially completed tasks", notCompleted: "Not completed tasks", reverted: "Reverted tasks", deleted: "Manager-deleted tasks",
};

export type EfficiencyTask = {
  id: string;
  title: string;
  date: string; // YYYY-MM-DD, the task's own day in the company time zone
  status: string; // PENDING | IN_PROGRESS | COMPLETED
  outcome: string | null; // graded outcome, if any
  completedAt: number | null; // epoch ms
  blocked: boolean;
  blockedNote: string | null;
  rating: number | null; // finalized manager stars 1..5
  qualityReverts: number; // times sent back for quality (recorded reasons)
  requirementReverts: number; // times sent back because the requirement changed
  unclassifiedReverts: number; // older returns with no recorded reason (never counted, only flagged)
  partialPercent: number | null; // manager-verified progress, 1..99 (needs a milestone note)
  actualSeconds: number | null; // automatic timer, null = Not tracked
  expectedSeconds: number | null; // the time the manager confirmed as reasonable, null = none
};
export type EfficiencyDeletion = { id: string; title: string; reasonCode: string; reasonNote: string | null };
export type EfficiencyInput = {
  tasks: EfficiencyTask[];
  deletions: EfficiencyDeletion[];
  attendance: { scheduledDays: number; creditDays: number } | null; // null = attendance could not be read
  cutoff: number; // epoch ms, end of the period's last day
  cutoffDay: string; // YYYY-MM-DD, the last day of the period (a task of this day is not overdue yet)
};

export type Outcome = "COMPLETED" | "PARTIAL" | "RETURNED" | "NOT_COMPLETED";
export type ComponentState = "SCORED" | "NOT_APPLICABLE" | "MISSING_EVIDENCE";
export type Component = {
  key: StandardKey;
  label: string;
  weight: number;
  state: ComponentState;
  percent: number | null; // 0-100
  earned: number | null; // points = percent x weight / 100 (before re-sharing the weights)
  numerator: number | null;
  denominator: number | null;
  formula: string;
  note: string;
};
export type TaskLine = { id: string; title: string; date: string; outcome: Outcome; rating: number | null; actualSeconds: number | null; expectedSeconds: number | null; timeCredit: number | null; reverts: number; partialPercent: number | null; overdue: boolean; dependency: boolean };
export type EfficiencyStatus = "NO_TASKS" | "INCOMPLETE_EVIDENCE" | "INSUFFICIENT_EVIDENCE" | "PROVISIONAL" | "FINAL";
export type Efficiency = {
  version: string;
  percent: number | null;
  status: EfficiencyStatus;
  eligible: number;
  completed: number;
  partial: number;
  returned: number;
  notCompleted: number;
  completionRate: number | null;
  ratedTasks: number;
  awaitingRating: number;
  averageRating: number | null;
  attributableDeletions: number;
  activeSeconds: number;
  expectedSeconds: number;
  attendanceRate: number | null;
  components: Component[];
  lines: TaskLine[];
  deletions: (EfficiencyDeletion & { attributable: boolean })[];
  missing: string[]; // plain reasons the final is blank or provisional
};

const r2 = (n: number) => Math.round(n * 100) / 100;

/** The credit one completed task earns for its time (see the formula above). */
export function timeCredit(actualSeconds: number, expectedSeconds: number): number {
  if (!(expectedSeconds > 0)) return 0;
  const ratio = actualSeconds / expectedSeconds;
  if (ratio <= TIME_TOLERANCE) return 1;
  if (ratio >= TIME_CEILING) return 0;
  return (TIME_CEILING - ratio) / (TIME_CEILING - TIME_TOLERANCE);
}

/** A deletion counts against the employee only for reason Other with a written note. */
export function isAttributableDeletion(d: { reasonCode: string; reasonNote: string | null }): boolean {
  return d.reasonCode === "OTHER" && String(d.reasonNote ?? "").trim().length >= 3;
}

export function outcomeOf(t: EfficiencyTask, cutoff: number): Outcome {
  const outcome = String(t.outcome ?? "");
  const finished = String(t.status) === "COMPLETED" && outcome !== "FAILED" && outcome !== "PARTIALLY_COMPLETED" && (t.completedAt == null || t.completedAt <= cutoff);
  if (finished) return "COMPLETED";
  if (outcome === "PARTIALLY_COMPLETED" && t.partialPercent != null && t.partialPercent >= 1 && t.partialPercent <= 99) return "PARTIAL";
  if (t.qualityReverts > 0 && String(t.status) !== "COMPLETED") return "RETURNED";
  return "NOT_COMPLETED";
}

export function efficiencyIndex(input: EfficiencyInput): Efficiency {
  const { tasks, cutoff, cutoffDay } = input;
  const eligible = tasks.length;
  const lines: TaskLine[] = tasks.map((t) => {
    const outcome = outcomeOf(t, cutoff);
    const dependency = outcome === "NOT_COMPLETED" && t.blocked && String(t.blockedNote ?? "").trim().length >= 3;
    const hasBoth = outcome === "COMPLETED" && t.actualSeconds != null && t.expectedSeconds != null && t.expectedSeconds > 0;
    return {
      id: t.id, title: t.title, date: t.date, outcome, rating: outcome === "COMPLETED" ? t.rating : null,
      actualSeconds: t.actualSeconds, expectedSeconds: t.expectedSeconds,
      timeCredit: hasBoth ? r2(timeCredit(t.actualSeconds!, t.expectedSeconds!)) : null,
      reverts: t.qualityReverts, partialPercent: outcome === "PARTIAL" ? t.partialPercent : null,
      overdue: outcome === "NOT_COMPLETED" && t.date < cutoffDay && !dependency, dependency,
    };
  });
  const by = (o: Outcome) => lines.filter((l) => l.outcome === o);
  const completed = by("COMPLETED"), partial = by("PARTIAL"), returned = by("RETURNED"), notCompleted = by("NOT_COMPLETED");
  const missing: string[] = [];
  const provisional: string[] = [];
  const comp = (key: StandardKey, state: ComponentState, percent: number | null, numerator: number | null, denominator: number | null, formula: string, note: string): Component => ({
    key, label: STANDARD_LABEL[key], weight: WEIGHTS[key], state, percent: percent == null ? null : r2(percent),
    earned: percent == null ? null : r2((percent * WEIGHTS[key]) / 100), numerator, denominator, formula, note,
  });
  const na = (key: StandardKey, formula: string, note: string) => comp(key, "NOT_APPLICABLE", null, null, null, formula, note);

  // 1. completed
  const cCompleted = eligible > 0
    ? comp("completed", "SCORED", (completed.length / eligible) * 100, completed.length, eligible, "completed tasks / eligible tasks x 100", `${completed.length} of ${eligible} eligible tasks are completed and approved.`)
    : na("completed", "completed tasks / eligible tasks x 100", "No eligible tasks in this period.");

  // 2. ratings
  const rated = completed.filter((l) => l.rating != null && l.rating >= 1 && l.rating <= 5);
  const awaitingRating = completed.length - rated.length;
  const ratingSum = rated.reduce((n, l) => n + (l.rating as number), 0);
  const averageRating = rated.length ? r2(ratingSum / rated.length) : null;
  let cRating: Component;
  if (completed.length === 0) cRating = na("rating", "average stars / 5 x 100", "Nothing is completed, so there is nothing to rate.");
  else if (rated.length === 0) { cRating = comp("rating", "MISSING_EVIDENCE", null, 0, completed.length, "average stars / 5 x 100", "Completed tasks exist but no manager has rated any of them."); missing.push(`Manager ratings: none of the ${completed.length} completed tasks is rated yet`); }
  else {
    cRating = comp("rating", "SCORED", (ratingSum / (rated.length * 5)) * 100, ratingSum, rated.length * 5, "sum of stars / (rated tasks x 5) x 100", `Average ${averageRating} / 5 over ${rated.length} rated task${rated.length === 1 ? "" : "s"}${awaitingRating ? `; ${awaitingRating} completed task${awaitingRating === 1 ? " is" : "s are"} not rated yet and left out (never counted as 5 stars)` : ""}.`);
    if (awaitingRating) provisional.push(`${awaitingRating} completed task${awaitingRating === 1 ? "" : "s"} still waiting for a rating`);
  }

  // 3. time
  const timed = completed.filter((l) => l.timeCredit != null);
  const activeSeconds = completed.reduce((n, l) => n + (l.actualSeconds ?? 0), 0);
  const expectedSeconds = completed.reduce((n, l) => n + (l.expectedSeconds ?? 0), 0);
  let cTime: Component;
  if (completed.length === 0) cTime = na("time", "average task time credit x 100", "Nothing is completed, so there is no completion time to judge.");
  else if (timed.length === 0) { cTime = comp("time", "MISSING_EVIDENCE", null, 0, completed.length, "average task time credit x 100", "Completed tasks have no confirmed expected time and automatic active time together."); missing.push(`Task completion time: none of the ${completed.length} completed tasks has both tracked time and a manager-confirmed expected time`); }
  else {
    const sum = timed.reduce((n, l) => n + (l.timeCredit as number), 0);
    cTime = comp("time", "SCORED", (sum / timed.length) * 100, r2(sum), timed.length, "average of task credits x 100 (<=110% of expected = 1, >=200% = 0, straight line between)", `${timed.length} of ${completed.length} completed tasks have tracked and confirmed expected time.`);
    if (timed.length < completed.length) provisional.push(`${completed.length - timed.length} completed task${completed.length - timed.length === 1 ? "" : "s"} without tracked or confirmed time`);
  }

  // 4. attendance
  const a = input.attendance;
  let cAttendance: Component;
  if (!a) { cAttendance = comp("attendance", "MISSING_EVIDENCE", null, null, null, "(present + half days x 0.5) / scheduled working days x 100", "Attendance could not be read for this person."); missing.push("Attendance could not be read"); }
  else if (a.scheduledDays <= 0) cAttendance = na("attendance", "(present + half days x 0.5) / scheduled working days x 100", "No scheduled working day in the period (all leave, holiday, week-off or not tracked).");
  else cAttendance = comp("attendance", "SCORED", Math.min(100, (a.creditDays / a.scheduledDays) * 100), r2(a.creditDays), a.scheduledDays, "(present + half days x 0.5) / scheduled working days x 100", `${r2(a.creditDays)} credited day${a.creditDays === 1 ? "" : "s"} of ${a.scheduledDays} scheduled working days. Leave, holidays and week-offs are not scheduled days.`);

  // 5. partial
  const cPartial = partial.length
    ? comp("partial", "SCORED", partial.reduce((n, l) => n + (l.partialPercent as number), 0) / partial.length, partial.reduce((n, l) => n + (l.partialPercent as number), 0), partial.length * 100, "average of manager-verified progress %", `${partial.length} partial task${partial.length === 1 ? "" : "s"} with a recorded progress % and milestone.`)
    : na("partial", "average of manager-verified progress %", "No verified partial tasks in this period.");

  // 6. not completed
  const due = lines.filter((l) => l.date < cutoffDay && !l.dependency);
  const overdue = due.filter((l) => l.overdue);
  const cNot = due.length
    ? comp("notCompleted", "SCORED", (1 - overdue.length / due.length) * 100, overdue.length, due.length, "(1 - overdue unfinished / tasks whose date has passed) x 100", `${overdue.length} overdue unfinished of ${due.length} tasks whose day has passed${lines.some((l) => l.dependency) ? "; blocked tasks with a written reason are dependencies and left out" : ""}.`)
    : na("notCompleted", "(1 - overdue unfinished / tasks whose date has passed) x 100", "No task has passed its date yet.");

  // 7. reverted
  const reviewed = completed.length + returned.length;
  const firstPass = completed.filter((l) => l.reverts === 0).length;
  const unclassified = tasks.reduce((n, t) => n + t.unclassifiedReverts, 0);
  let cRev: Component;
  if (reviewed === 0) cRev = na("reverted", "first-pass accepted / (completed + returned) x 100", "No task was completed or returned in this period.");
  else {
    cRev = comp("reverted", "SCORED", (firstPass / reviewed) * 100, firstPass, reviewed, "first-pass accepted / (completed + returned) x 100", `${firstPass} of ${reviewed} reviewed tasks were accepted first time.${tasks.some((t) => t.requirementReverts > 0) ? " Returns because the requirement changed are not counted." : ""}`);
    if (unclassified > 0) provisional.push(`${unclassified} older return${unclassified === 1 ? "" : "s"} with no recorded reason (not counted)`);
  }

  // 8. deletions
  const delRows = input.deletions.map((d) => ({ ...d, attributable: isAttributableDeletion(d) }));
  const attributable = delRows.filter((d) => d.attributable).length;
  const cDel = eligible + attributable > 0
    ? comp("deleted", "SCORED", (1 - attributable / (eligible + attributable)) * 100, attributable, eligible + attributable, "(1 - attributable deletions / (eligible tasks + attributable deletions)) x 100", `${attributable} attributable deletion${attributable === 1 ? "" : "s"}; ${delRows.length - attributable} other deletion${delRows.length - attributable === 1 ? "" : "s"} (duplicate, mistake or cleanup) not held against the employee.`)
    : na("deleted", "(1 - attributable deletions / (eligible tasks + attributable deletions)) x 100", "No tasks and no deletions in this period.");

  const components = [cCompleted, cRating, cTime, cAttendance, cPartial, cNot, cRev, cDel];
  const applicable = components.filter((c) => c.state === "SCORED");
  const hasMissing = components.some((c) => c.state === "MISSING_EVIDENCE");
  const weightSum = applicable.reduce((n, c) => n + c.weight, 0);
  const earned = applicable.reduce((n, c) => n + (c.earned ?? 0), 0);

  let status: EfficiencyStatus;
  let percent: number | null = null;
  if (eligible === 0) status = "NO_TASKS";
  else if (hasMissing || weightSum === 0) status = "INCOMPLETE_EVIDENCE";
  else {
    percent = r2((earned / weightSum) * 100);
    status = eligible < MIN_TASKS ? "INSUFFICIENT_EVIDENCE" : provisional.length ? "PROVISIONAL" : "FINAL";
  }
  return {
    version: EFFICIENCY_POLICY_VERSION, percent, status, eligible,
    completed: completed.length, partial: partial.length, returned: returned.length, notCompleted: notCompleted.length,
    completionRate: eligible ? r2((completed.length / eligible) * 100) : null,
    ratedTasks: rated.length, awaitingRating, averageRating, attributableDeletions: attributable,
    activeSeconds, expectedSeconds, attendanceRate: cAttendance.state === "SCORED" ? cAttendance.percent : null,
    components, lines, deletions: delRows, missing: [...missing, ...provisional],
  };
}
