// ===========================================================================
// TASK ROUTES
//
// /api/tasks        — the employee's own list
// /api/tasks/review — the manager's approval and grading queue
// ===========================================================================

import { Router } from "express";
import { parseFilters } from "../hr-filters/hrFilters.logic.js";
import * as tasks from "./tasks.service.js";
import * as selfTasks from "./tasks.self.js";
import * as bulk from "./tasks.bulk.js";
import * as late from "./tasks.late.js";
import * as edit from "./tasks.edit.service.js";
import * as assigned from "./tasks.assigned.js";
import * as rep from "./repetition.service.js";
import { guardUuidParams, isBadInput } from "../../lib/params.js";

const router = Router();
guardUuidParams(router);

const MESSAGES: Record<string, { status: number; message: string }> = {
  USER_NOT_FOUND: { status: 404, message: "Not signed in." },
  BAD_DATE: { status: 400, message: "Dates must be in YYYY-MM-DD format." },
  NOT_FOUND: { status: 404, message: "That task doesn't exist." },
  FORBIDDEN: { status: 403, message: "Only managers can do that." },
  NOT_YOUR_TEAM: { status: 403, message: "That person isn't in your team." },
  ADMIN_ASSIGNS_EMPLOYEES: { status: 403, message: "An Admin can assign tasks to employees only." },
  ASSIGN_TO_EMPLOYEES_ONLY: { status: 403, message: "Tasks can't be assigned to Admin accounts." },
  NOT_SAME_COMPANY: { status: 403, message: "That person is outside the companies you can assign tasks in." },
  CANNOT_ASSIGN_SELF: { status: 400, message: "You can't assign a task to yourself." },
  ASSIGNER_CANNOT_CONFIRM: { status: 403, message: "Confirming or sending back finished work is a manager's decision. You can follow the progress here." },
  MANAGER_TASKS_ARE_PERSONAL: { status: 403, message: "A manager's tasks are their own. Tasks can't be assigned to a manager." },
  MISSING_FIELDS: { status: 400, message: "A title is required." },
  BAD_STATUS: { status: 400, message: "That isn't a valid status." },
  BAD_PROGRESS: { status: 400, message: "Progress must be To Do, In Progress, Completed or Blocked." },
  BLOCKED_REASON_REQUIRED: { status: 400, message: "Say what is blocking this task (at least 3 characters)." },
  BLOCKED_REASON_TOO_LONG: { status: 400, message: "Keep the blocked reason to 500 characters or fewer." },
  DRAFT_TODO_NOT_READY: { status: 409, message: "A draft with a To Do task needs a database update that has not been applied yet. Set that task to In Progress, or send it now." },
  BAD_HOURS: { status: 400, message: "Hours spent must be a number from 0 to 24." },
  BAD_TAGGED_MANAGER: { status: 400, message: "That manager is not available for tagging. Pick one from the list." },
  TAGGED_MANAGER_REQUIRED: { status: 400, message: "Select the reporting manager who should review this task." },
  PROJECT_HAS_NO_MANAGER: { status: 409, message: "No manager is available to approve this task. Please ask HR or your Admin to assign one." },
  PROJECT_REQUIRED: { status: 400, message: "Select the project this task belongs to." },
  FEATURES_NOT_READY: { status: 503, message: "This feature is not switched on yet." },
  USE_RATING: { status: 400, message: "Tasks are rated with 1 to 5 stars now. Give a star rating." },
  BAD_RATING: { status: 400, message: "Give a rating from 1 to 5 stars." },
  COMMENT_TOO_LONG: { status: 400, message: "Keep the comment to 300 characters or fewer." },
  NOT_YOUR_OWN_TASK: { status: 403, message: "You can't rate your own task." },
  NOT_APPROVED: { status: 400, message: "That task hasn't been approved yet." },
  NOT_FINISHED: { status: 400, message: "It hasn't been marked done yet." },
  ALREADY_DECIDED: { status: 409, message: "That proposal was already decided." },
  ALREADY_REVIEWED: { status: 409, message: "Your manager has already graded that." },
  APPROVED_CANNOT_DELETE: {
    status: 400,
    message: "Approved work can't be deleted. Ask your manager to cancel it.",
  },
  REASON_REQUIRED: { status: 400, message: "Say why you're rejecting it." },
  // Codes the service throws. Each one used to fall through to a 500.
  NOT_ALLOWED: { status: 403, message: "Only managers can do that." },
  TITLE_REQUIRED: { status: 400, message: "A title is required." },
  TITLE_TOO_LONG: { status: 400, message: "Keep the title under 200 characters." },
  USER_REQUIRED: { status: 400, message: "Pick who the task is for." },
  BAD_WEIGHT: { status: 400, message: "That isn't a valid weight." },
  NOTHING_TO_UPDATE: { status: 400, message: "There was nothing to change." },
  NOT_MY_PROJECT: { status: 403, message: "That project is not available to you." },
  TASK_TOO_OLD: { status: 400, message: "That task is more than 30 days old, so it can no longer be marked done." },
  NOT_APPROVED_YET: { status: 400, message: "Your manager hasn't approved that task yet." },
  // editing a submitted task, and correction requests
  USE_CORRECTION: { status: 409, message: "That task is already approved or rated, so it can't be edited directly. Send a correction request instead." },
  USE_EDIT: { status: 409, message: "That task is still waiting for approval (or was sent back), so edit it directly instead." },
  ASSIGNED_CANNOT_EDIT: { status: 403, message: "A task your manager assigned to you can't be edited by you." },
  EDITED_ELSEWHERE: { status: 409, message: "This task was changed by someone else (or your manager just decided it). Reload it and try again." },
  VERSION_REQUIRED: { status: 400, message: "Reload the task before editing it." },
  DATE_IN_FUTURE: { status: 400, message: "A task can't be dated in the future." },
  CORRECTION_FIELD_NOT_ALLOWED: { status: 400, message: "A correction can't change the task date or the approving manager." },
  CORRECTION_REASON_REQUIRED: { status: 400, message: "Say why the correction is needed (at least 3 characters)." },
  CORRECTION_REASON_TOO_LONG: { status: 400, message: "Keep the reason to 300 characters or fewer." },
  CORRECTION_ALREADY_PENDING: { status: 409, message: "A correction for this task is already waiting for your manager." },
  CORRECTION_NOT_FOUND: { status: 404, message: "That correction request doesn't exist." },
  CORRECTION_ALREADY_DECIDED: { status: 409, message: "That correction was already decided." },
  DECISION_NOTE_REQUIRED: { status: 400, message: "Say why you're declining it (at least 3 characters)." },
  BAD_DECISION: { status: 400, message: "Send approve as true or false." },
  NOT_FINISHED_YET: { status: 400, message: "It hasn't been marked done yet." },
  ALREADY_ANSWERED: { status: 409, message: "That proposal was already decided." },
  APPROVED_CANNOT_EDIT: { status: 400, message: "Approved work can't be edited. Ask your manager." },
  ALREADY_STARTED: { status: 400, message: "You've already started that task, so it can't be deleted." },
  SELF_MANAGED: { status: 409, message: "That is the manager's own task. It needs no approval and nobody reviews it." },
  SELF_MANAGED_ONLY: { status: 400, message: "Deadlines and work updates are for a manager's own tasks." },
  DUE_IN_PAST: { status: 400, message: "The deadline can't be before today." },
  BAD_RANGE: { status: 400, message: "The end date can't be before the start date." },
  RANGE_TOO_LONG: { status: 400, message: "Pick a range of 93 days or fewer." },
  BAD_REVERT_TYPE: { status: 400, message: "Choose Partially completed or Not fully completed." },
  REMARK_REQUIRED: { status: 400, message: "Add a remark (at least 3 characters) explaining why." },
  REMARK_TOO_LONG: { status: 400, message: "Keep the remark to 300 characters or fewer." },
  NOT_STARTED_YET: { status: 400, message: "This task is still To Do. It cannot be marked as partly done yet." },
  BAD_EXPECTED_TIME: { status: 400, message: "Enter the reasonable time for this work in minutes (1 to 1440)." },
  BAD_PARTIAL_PROGRESS: { status: 400, message: "Enter how much is done (1 to 99 %) and a short milestone note." },
  REVERT_REASON_REQUIRED: { status: 400, message: "Say why it is sent back: a quality problem or a changed requirement." },
  BAD_PARTIAL: { status: 400, message: "Say whether the task is partially completed (true or false)." },
  ALREADY_REOPENED: { status: 409, message: "That task was already reopened." },
  BACKDATE_NOT_PAST: { status: 400, message: "Pick a date before today. Use Quick Add or Add Single Task for today." },
  BACKDATE_TOO_OLD: { status: 400, message: "That date is too old. Tasks can be added for the last 14 days only." },
  LATE_REASON_REQUIRED: { status: 400, message: "Add a reason (at least 3 characters) for submitting this late." },
  LATE_REASON_TOO_LONG: { status: 400, message: "Keep the reason to 300 characters or fewer." },
  NO_APPROVER_FOR_LATE: { status: 409, message: "A late task needs a manager to review it, and none is available. Please ask HR or your Admin." },
  BAD_ALLOWED_DAYS: { status: 400, message: "Enter a whole number of days from 0 to 14." },
  BAD_DELETE_REASON: { status: 400, message: "Choose a reason for deleting this task." },
  DELETE_NOTE_REQUIRED: { status: 400, message: "Write a short note (at least 3 characters) when the reason is Other." },
  DELETE_NOTE_TOO_LONG: { status: 400, message: "Keep the note to 300 characters or fewer." },
  ALREADY_DELETED: { status: 409, message: "That task was already deleted." },
  DUPLICATE_TASK: { status: 409, message: "You already sent this task today (same description, project and manager)." },
  BULK_NOT_AVAILABLE: { status: 403, message: "Quick Add is for tasks that need approval. Your own tasks use the manager screen." },
  NO_ROWS: { status: 400, message: "Add at least one task." },
  TOO_MANY_ROWS: { status: 400, message: "Too many tasks at once. Send up to 20 at a time (drafts hold up to 30)." },
  BAD_ROWS: { status: 400, message: "That list of tasks is not valid." },
  ASSIGNED_CANNOT_DELETE: { status: 400, message: "A task your manager assigned can't be deleted." },
  BAD_DUE_DATE: { status: 400, message: "The due date must be a real day (YYYY-MM-DD)." },
  COMMENT_REQUIRED: { status: 400, message: "Write something first." },
  REASON_TOO_LONG: { status: 400, message: "The reason is too long (up to 300 characters)." },
  BAD_PRIORITY: { status: 400, message: "Priority must be Low, Medium or High." },
  BAD_FLAG_STATUS: { status: 400, message: "Choose Under Review, Valid Repetition, False Positive or Resolved." },
  NOTE_REQUIRED: { status: 400, message: "Write something first." },
  NOTE_TOO_LONG: { status: 400, message: "That is too long (up to 300 characters; comments up to 500)." },
  EXPLANATION_REQUIRED: { status: 400, message: "Write your explanation first (at least 3 characters)." },
  USE_ESCALATE_ADMIN: { status: 403, message: "HR passes a case to Admin with Escalate to Admin." },
  ALREADY_ESCALATED_ADMIN: { status: 409, message: "This case was already escalated to Admin." },
  HR_CANNOT_ESCALATE: { status: 403, message: "HR receives escalations, so there is nobody above to escalate to." },
  FLAG_CLOSED: { status: 409, message: "This flag is closed. Reopen it for review first." },
  ALREADY_ESCALATED: { status: 409, message: "This flag was already escalated to HR." },
  BAD_MIN_COUNT: { status: 400, message: "Similar submissions needed must be a whole number from 2 to 20." },
  BAD_WINDOW_DAYS: { status: 400, message: "The number of days must be a whole number from 1 to 60." },
  BAD_SIMILARITY: { status: 400, message: "Similarity must be a whole number from 30 to 100." },
  NOTHING_CHANGED: { status: 400, message: "Nothing was changed." },
  ALREADY_CONFIRMED: { status: 409, message: "This task is already confirmed as complete, so it can't be changed." },
  NOT_AWAITING_CONFIRMATION: { status: 409, message: "This task is not waiting for confirmation (it may already have been answered)." },
  NO_CHANGE: { status: 409, message: "The task is already in that state." },
  MOVE_NOT_ALLOWED: { status: 409, message: "That change is not possible from the task's current state." },
  CHANGED_ELSEWHERE: { status: 409, message: "The task changed while you were saving. Reload it and try again." },
};

function fail(res: any, error: unknown) {
  if (isBadInput(error)) {
    res.status(400).json({ error: "One of the values sent is not valid." });
    return;
  }
  const code = error instanceof Error ? error.message : "UNKNOWN";
  const mapped = MESSAGES[code];
  if (mapped) return res.status(mapped.status).json({ error: mapped.message });
  console.error("[tasks]", error);
  return res.status(500).json({ error: "Something went wrong." });
}

const id = (v: unknown) => String(v);

// --- employee ---------------------------------------------------------------

router.get("/", async (req, res) => {
  try {
    res.json(await tasks.listTasks(req.user!.userId));
  } catch (e) {
    fail(res, e);
  }
});

router.get("/day", async (req, res) => {
  try {
    res.json(await tasks.listMyDay(req.user!.userId, req.query.date));
  } catch (e) {
    fail(res, e);
  }
});

router.get("/range", async (req, res) => {
  try {
    res.json(await tasks.listMyRange(req.user!.userId, req.query.from, req.query.to));
  } catch (e) {
    fail(res, e);
  }
});

// A manager's OWN task picture (self-managed tasks only). Managers only.
router.get("/self/summary", async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    res.json(await selfTasks.summary(req.user!.userId, String(req.query.from ?? today.slice(0, 8) + "01"), String(req.query.to ?? today)));
  } catch (e) {
    fail(res, e);
  }
});

// The history of one of the signed-in person's own tasks: every step, edit and work update.
// --- Quick Add: several tasks from one screen (drafts are the person's own, never tasks) ----------
router.get("/drafts", async (req, res) => {
  try {
    res.json(await bulk.listDrafts(req.user!.userId));
  } catch (e) {
    fail(res, e);
  }
});

router.put("/drafts", async (req, res) => {
  try {
    res.json(await bulk.saveDrafts(req.user!.userId, req.body?.rows));
  } catch (e) {
    fail(res, e);
  }
});

router.post("/bulk", async (req, res) => {
  try {
    const out = await bulk.submitBulk(req.user!.userId, req.body?.rows, { forDate: req.body?.forDate, lateReason: req.body?.lateReason });
    // Each failed row says why, in words (the same messages the single form shows).
    res.json({ ...out, results: out.results.map((r) => (r.ok ? r : { ...r, error: MESSAGES[r.code ?? ""]?.message ?? "This task could not be sent." })) });
  } catch (e) {
    fail(res, e);
  }
});

// --- late (previous-day) submissions: the window the employee screen needs, and the Admin setting ----------
// Deleted tasks (read only): HR and Admin for their companies, a manager only what he deleted himself.
router.get("/deleted", async (req, res) => {
  try {
    res.json(await tasks.listDeletedTasks(req.user!.userId));
  } catch (e) {
    fail(res, e);
  }
});

router.get("/late-policy", async (req, res) => {
  try {
    res.json(await late.policyFor(req.user!.userId));
  } catch (e) {
    fail(res, e);
  }
});

router.get("/late-policy/all", async (req, res) => {
  try {
    if (req.user!.role !== "ADMIN") throw new Error("NOT_ALLOWED");
    res.json(await late.listPolicies(req.user!.userId));
  } catch (e) {
    fail(res, e);
  }
});

router.put("/late-policy", async (req, res) => {
  try {
    if (req.user!.role !== "ADMIN") throw new Error("NOT_ALLOWED");
    res.json(await late.setPolicy(req.user!.userId, req.body?.companyId, req.body?.allowedDays));
  } catch (e) {
    fail(res, e);
  }
});

// --- editing a submitted task and correction requests ----------------------------------------------------------------
// Pending or sent-back task: the owner edits it. Approved or rated task: the owner asks for a correction and the tagged manager decides.
router.post("/:id/edit", async (req, res) => {
  try {
    res.json(await edit.editMyTask(req.user!.userId, id(req.params.id), req.body ?? {}));
  } catch (e) {
    fail(res, e);
  }
});

router.post("/:id/correction", async (req, res) => {
  try {
    res.json(await edit.requestCorrection(req.user!.userId, id(req.params.id), req.body ?? {}));
  } catch (e) {
    fail(res, e);
  }
});

// Correction requests waiting for this person to decide (managers; never HR or Admin by role).
router.get("/corrections/pending", async (req, res) => {
  try {
    res.json(await edit.pendingCorrections(req.user!.userId));
  } catch (e) {
    fail(res, e);
  }
});

// The change history of one task: its owner, the people who can review it, and HR / Admin inside their company scope.
router.get("/:id/changes", async (req, res) => {
  try {
    res.json(await edit.taskChanges(req.user!.userId, id(req.params.id)));
  } catch (e) {
    fail(res, e);
  }
});

router.post("/review/:id/correction", async (req, res) => {
  try {
    res.json(await edit.decideCorrection(req.user!.userId, id(req.params.id), req.body ?? {}));
  } catch (e) {
    fail(res, e);
  }
});

router.get("/:id/history", async (req, res) => {
  try {
    const task = await tasks.ownTaskOrThrow(req.user!.userId, id(req.params.id));
    res.json({ taskId: task.id, events: await selfTasks.historyOf(task.id) });
  } catch (e) {
    fail(res, e);
  }
});

router.post("/", async (req, res) => {
  try {
    res.json(await tasks.proposeTask(req.user!.userId, req.body ?? {}));
  } catch (e) {
    fail(res, e);
  }
});

router.patch("/:id", async (req, res) => {
  try {
    res.json(await tasks.updateMyTask(req.user!.userId, id(req.params.id), req.body ?? {}));
  } catch (e) {
    fail(res, e);
  }
});

router.delete("/:id", async (req, res) => {
  try {
    res.json(await tasks.deleteMyTask(req.user!.userId, id(req.params.id)));
  } catch (e) {
    fail(res, e);
  }
});

// --- manager ----------------------------------------------------------------
// These sit under /review so they can never collide with a task id in the
// routes above.

router.get("/review/queue", async (req, res) => {
  try {
    res.json(await tasks.listForApproval(req.user!.userId, {
      from: req.query.from ? String(req.query.from) : undefined,
      to: req.query.to ? String(req.query.to) : undefined,
    }, parseFilters(req.query as Record<string, unknown>)));
  } catch (e) {
    fail(res, e);
  }
});

router.post("/review/assign", async (req, res) => {
  try {
    res.json(await tasks.assignTask(req.user!.userId, req.body ?? {}));
  } catch (e) {
    fail(res, e);
  }
});

router.post("/review/:id/approve", async (req, res) => {
  try {
    const approve = req.body?.approve === true;
    const note = req.body?.rejectionNote ? String(req.body.rejectionNote) : req.body?.comment ? String(req.body.comment) : undefined;
    res.json(await tasks.approveTask(req.user!.userId, id(req.params.id), approve, note));
  } catch (e) {
    fail(res, e);
  }
});

// Rate a finished task 1-5 stars. Body: { rating, comment? }. (/outcome is the old path: it only answers "use stars".)
router.post(["/review/:id/rating", "/review/:id/outcome"], async (req, res) => {
  try {
    res.json(await tasks.reviewTask(req.user!.userId, id(req.params.id), { rating: req.body?.rating, comment: req.body?.comment, outcome: req.body?.outcome, expectedMinutes: req.body?.expectedMinutes }));
  } catch (e) {
    fail(res, e);
  }
});

// Mark a task partially completed (earns half its weight) or undo it. Body: { partial: true | false }.
router.post("/review/:id/partial", async (req, res) => {
  try {
    res.json(await tasks.markPartial(req.user!.userId, id(req.params.id), req.body?.partial, { percent: req.body?.percent, milestone: req.body?.milestone }));
  } catch (e) {
    fail(res, e);
  }
});

// Send a Completed task back to In Progress. Body: { type: "PARTIAL" | "NOT_FULL", remark }.
router.post("/review/:id/delete", async (req, res) => {
  try {
    res.json(await tasks.deleteTaskAsManager(req.user!.userId, id(req.params.id), { reasonCode: req.body?.reasonCode, note: req.body?.note }));
  } catch (e) {
    fail(res, e);
  }
});

// --- manager-ASSIGNED tasks (their own workflow: assign, progress, confirm; no approval and no rating) ---
router.get("/assigned/mine", async (req, res) => {
  try { res.json(await assigned.listAssignedToMe(req.user!.userId)); } catch (e) { fail(res, e); }
});
router.get("/assigned/by-me", async (req, res) => {
  try { res.json(await assigned.listAssignedByMe(req.user!.userId)); } catch (e) { fail(res, e); }
});
router.get("/assigned/people", async (req, res) => {
  try { res.json(await assigned.assignablePeople(req.user!.userId)); } catch (e) { fail(res, e); }
});
router.post("/assigned", async (req, res) => {
  try { res.json(await assigned.assignNew(req.user!.userId, req.body ?? {})); } catch (e) { fail(res, e); }
});
router.get("/assigned/:id/history", async (req, res) => {
  try { res.json(await assigned.historyAssigned(req.user!.userId, id(req.params.id))); } catch (e) { fail(res, e); }
});
router.post("/assigned/:id/progress", async (req, res) => {
  try { res.json(await assigned.moveAssigned(req.user!.userId, id(req.params.id), req.body?.to, req.body?.note)); } catch (e) { fail(res, e); }
});
router.post("/assigned/:id/comment", async (req, res) => {
  try { res.json(await assigned.commentAssigned(req.user!.userId, id(req.params.id), req.body?.text)); } catch (e) { fail(res, e); }
});
router.post("/assigned/:id/edit", async (req, res) => {
  try { res.json(await assigned.editAssigned(req.user!.userId, id(req.params.id), req.body ?? {})); } catch (e) { fail(res, e); }
});
router.post("/assigned/:id/confirm", async (req, res) => {
  try { res.json(await assigned.confirmAssigned(req.user!.userId, id(req.params.id), req.body?.note)); } catch (e) { fail(res, e); }
});
router.post("/assigned/:id/send-back", async (req, res) => {
  try { res.json(await assigned.sendBackAssigned(req.user!.userId, id(req.params.id), req.body?.reason)); } catch (e) { fail(res, e); }
});
router.post("/assigned/:id/cancel", async (req, res) => {
  try { res.json(await assigned.cancelAssigned(req.user!.userId, id(req.params.id))); } catch (e) { fail(res, e); }
});

// --- repetitive task flags (manager / HR / Admin; the service decides who sees what) ---
router.get("/repetition/flags", async (req, res) => {
  try { res.json(await rep.listFlags(req.user!.userId, { status: req.query.status as string, userId: req.query.userId as string, projectId: req.query.projectId as string, own: req.query.mine === "1" })); } catch (e) { fail(res, e); }
});
router.get("/repetition/flags/:id", async (req, res) => {
  try { res.json(await rep.flagDetail(req.user!.userId, id(req.params.id))); } catch (e) { fail(res, e); }
});
router.post("/repetition/flags/:id/status", async (req, res) => {
  try { res.json(await rep.setStatus(req.user!.userId, id(req.params.id), req.body?.status, req.body?.note)); } catch (e) { fail(res, e); }
});
router.post("/repetition/flags/:id/comment", async (req, res) => {
  try { res.json(await rep.addComment(req.user!.userId, id(req.params.id), req.body?.text)); } catch (e) { fail(res, e); }
});
router.post("/repetition/flags/:id/explain", async (req, res) => {
  try { res.json(await rep.explain(req.user!.userId, id(req.params.id), req.body?.text)); } catch (e) { fail(res, e); }
});
router.post("/repetition/flags/:id/escalate-admin", async (req, res) => {
  try { res.json(await rep.escalateToAdmin(req.user!.userId, id(req.params.id), req.body?.reason)); } catch (e) { fail(res, e); }
});
router.post("/repetition/flags/:id/escalate", async (req, res) => {
  try { res.json(await rep.escalate(req.user!.userId, id(req.params.id), req.body?.note)); } catch (e) { fail(res, e); }
});
router.get("/repetition/summary", async (req, res) => {
  try { res.json(await rep.summary(req.user!.userId, req.query.from as string, req.query.to as string)); } catch (e) { fail(res, e); }
});
router.get("/repetition/settings", async (req, res) => {
  try { res.json(await rep.getSettings(req.user!.userId)); } catch (e) { fail(res, e); }
});
router.put("/repetition/settings", async (req, res) => {
  try { res.json(await rep.saveSettings(req.user!.userId, req.body ?? {})); } catch (e) { fail(res, e); }
});
router.post("/repetition/scan", async (req, res) => {
  try { res.json(await rep.scanNow(req.user!.userId)); } catch (e) { fail(res, e); }
});

router.post("/review/:id/revert", async (req, res) => {
  try {
    res.json(await tasks.revertTask(req.user!.userId, id(req.params.id), req.body?.type, req.body?.remark, req.body?.reason));
  } catch (e) {
    fail(res, e);
  }
});

export default router;