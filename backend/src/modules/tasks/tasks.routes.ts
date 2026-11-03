// ===========================================================================
// TASK ROUTES
//
// /api/tasks        — the employee's own list
// /api/tasks/review — the manager's approval and grading queue
// ===========================================================================

import { Router } from "express";
import * as tasks from "./tasks.service.js";
import * as selfTasks from "./tasks.self.js";
import { guardUuidParams, isBadInput } from "../../lib/params.js";

const router = Router();
guardUuidParams(router);

const MESSAGES: Record<string, { status: number; message: string }> = {
  USER_NOT_FOUND: { status: 404, message: "Not signed in." },
  BAD_DATE: { status: 400, message: "Dates must be in YYYY-MM-DD format." },
  NOT_FOUND: { status: 404, message: "That task doesn't exist." },
  FORBIDDEN: { status: 403, message: "Only managers can do that." },
  NOT_YOUR_TEAM: { status: 403, message: "That person isn't in your team." },
  MANAGER_TASKS_ARE_PERSONAL: { status: 403, message: "A manager's tasks are their own. Tasks can't be assigned to a manager." },
  MISSING_FIELDS: { status: 400, message: "A title is required." },
  BAD_STATUS: { status: 400, message: "That isn't a valid status." },
  BAD_OUTCOME: { status: 400, message: "Pick completed, partial or failed." },
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
  NOT_MY_PROJECT: { status: 403, message: "You aren't on that project." },
  NOT_APPROVED_YET: { status: 400, message: "Your manager hasn't approved that task yet." },
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
  ALREADY_REOPENED: { status: 409, message: "That task was already reopened." },
  ASSIGNED_CANNOT_DELETE: { status: 400, message: "A task your manager assigned can't be deleted." },
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
    }));
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
    const note = req.body?.rejectionNote ? String(req.body.rejectionNote) : undefined;
    res.json(await tasks.approveTask(req.user!.userId, id(req.params.id), approve, note));
  } catch (e) {
    fail(res, e);
  }
});

router.post("/review/:id/outcome", async (req, res) => {
  try {
    const outcome = String(req.body?.outcome ?? "");
    const note = req.body?.reviewNote ? String(req.body.reviewNote) : undefined;
    res.json(await tasks.reviewTask(req.user!.userId, id(req.params.id), outcome, note));
  } catch (e) {
    fail(res, e);
  }
});

// Send a Completed task back to In Progress. Body: { type: "PARTIAL" | "NOT_FULL", remark }.
router.post("/review/:id/revert", async (req, res) => {
  try {
    res.json(await tasks.revertTask(req.user!.userId, id(req.params.id), req.body?.type, req.body?.remark));
  } catch (e) {
    fail(res, e);
  }
});

export default router;