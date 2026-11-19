import { Router, type Request, type Response } from "express";
import { requireAuth } from "../../middlewares/auth.js";
import * as queries from "./queries.service.js";
import * as dept from "./dept.service.js";
import { guardUuidParams, isBadInput } from "../../lib/params.js";

const router = Router();
guardUuidParams(router, ["id", "messageId", "deptId", "eventId"]);

// Every service error code needs an entry here, otherwise it becomes a 500.
const MESSAGES: Record<string, { status: number; message: string }> = {
  NOT_FOUND: { status: 404, message: "That query was not found." },
  CONFIRM_REQUIRED: { status: 400, message: "Please confirm that you want to delete this permanently." },
  CANNOT_DELETE_CORRECTION: { status: 400, message: "An attendance correction request cannot be deleted here. It is evidence for an attendance change." },
  FORBIDDEN: { status: 403, message: "You can't do that on this query." },
  USE_CORRECTION_FORM: { status: 400, message: "An attendance correction is requested with its own form, so it can be approved properly." },
  BAD_CATEGORY: { status: 400, message: "Choose a category." },
  SUBJECT_REQUIRED: { status: 400, message: "Give the query a short subject (at least 3 characters)." },
  SUBJECT_TOO_LONG: { status: 400, message: "Keep the subject under 150 characters." },
  DESCRIPTION_REQUIRED: { status: 400, message: "Describe what happened (at least a few words)." },
  DESCRIPTION_TOO_LONG: { status: 400, message: "Keep the description under 4,000 characters." },
  MESSAGE_REQUIRED: { status: 400, message: "Write a message first." },
  MESSAGE_TOO_LONG: { status: 400, message: "Keep the message under 4,000 characters." },
  MISSING_FIELDS: { status: 400, message: "Please fill in the subject and the description." },
  QUERY_CLOSED: { status: 409, message: "This query is closed. Raise a new one if you still need help." },
  BAD_STATUS: { status: 400, message: "That status is not valid." },
  NOTHING_TO_CHANGE: { status: 409, message: "Nothing to change." },
  NOTE_REQUIRED: { status: 400, message: "Say in a few words why, so the person understands the answer." },
  ASSIGNEE_REQUIRED: { status: 400, message: "Choose who to assign it to." },
  BAD_ASSIGNEE: { status: 400, message: "That person cannot take this query. Pick active HR, Admin or a manager of the same company (payroll queries only HR or Admin)." },
  TITLE_REQUIRED: { status: 400, message: "Give the query a short title (at least 3 characters)." },
  TITLE_TOO_LONG: { status: 400, message: "Keep the title under 150 characters." },
  BAD_PRIORITY: { status: 400, message: "Choose a priority: Low, Medium, High or Urgent." },
  DEPARTMENT_REQUIRED: { status: 400, message: "Choose the department that should do the work." },
  BAD_DEPARTMENT: { status: 400, message: "That department is not available. Pick one from the list." },
  BAD_DEPARTMENT_NAME: { status: 400, message: "A department name needs 2 to 80 characters." },
  DEPARTMENT_EXISTS: { status: 409, message: "A department with that name already exists in this company." },
  BAD_MEMBERS: { status: 400, message: "Members must be active people of this company." },
  DECISION_REQUIRED: { status: 400, message: "Say whether you approve or reject." },
  NOTE_TOO_LONG: { status: 400, message: "That note is too long." },
  STEP_ALREADY_DECIDED: { status: 409, message: "This step was already answered, or the request has moved on. Refresh to see where it is." },
  WAITING_FOR_MANAGER: { status: 409, message: "The reporting manager has not approved this yet. The Admin cannot skip that step." },
  ALREADY_TAKEN: { status: 409, message: "Someone in the department already took this request." },
  BAD_PROGRESS: { status: 400, message: "That progress change is not allowed from the current state." },
  NOT_COMPLETED_YET: { status: 409, message: "The department has not marked this completed yet, or you already answered." },
  FEATURES_NOT_READY: { status: 503, message: "This part of the Query Desk is not set up on this server yet. Ask an administrator to finish the database update." },
  UNSUPPORTED_FILE_TYPE: { status: 415, message: "Attach a PDF, JPG, PNG, WEBP or Word file." },
  EMPTY_FILE: { status: 400, message: "That file is empty." },
  FILE_TOO_LARGE: { status: 413, message: "That file is too large (10 MB maximum)." },
  FILE_MISSING: { status: 404, message: "The stored file could not be found." },
  BAD_DATE: { status: 400, message: "Dates must look like 2026-11-02." },
};

function fail(res: Response, error: unknown) {
  if (isBadInput(error)) {
    res.status(400).json({ error: "One of the values sent is not valid." });
    return;
  }
  const code = error instanceof Error ? error.message : "UNKNOWN";
  const known = MESSAGES[code];
  if (known) return res.status(known.status).json({ error: known.message });
  console.error("Queries error:", error);
  return res.status(500).json({ error: "Something went wrong" });
}

const run = (fn: (req: Request) => Promise<unknown>) => async (req: Request, res: Response) => {
  try {
    res.json(await fn(req));
  } catch (e) {
    fail(res, e);
  }
};
const uid = (req: Request) => req.user!.userId;
const pid = (req: Request) => String(req.params.id);

router.use(requireAuth);

// Fixed paths first, so they are never read as an :id.
router.get("/categories", run(() => Promise.resolve(queries.categories())));
router.get("/counts", run((req) => queries.counts(uid(req))));
router.get("/", run((req) => queries.listQueries(uid(req), req.query)));
router.post("/", run((req) => queries.createQuery(uid(req), req.body ?? {})));

// Department requests (manager -> Admin approval -> department work). Fixed paths first.
router.get("/dept/departments", run((req) => dept.departmentsForPicker(uid(req))));
router.get("/dept/form-preview", run((req) => dept.formPreview(uid(req))));
router.get("/dept/admin/departments", run((req) => dept.adminDepartments(uid(req))));
router.post("/dept/admin/departments", run((req) => dept.createDepartment(uid(req), req.body ?? {})));
router.post("/dept/admin/departments/:deptId", run((req) => dept.updateDepartment(uid(req), String(req.params.deptId), req.body ?? {})));
router.get("/dept", run((req) => dept.listRequests(uid(req), req.query)));
router.post("/dept", run((req) => dept.createRequest(uid(req), req.body ?? {})));
router.get("/dept/:id", run((req) => dept.getRequest(uid(req), pid(req))));
router.post("/dept/:id/manager-decision", run((req) => dept.managerDecide(uid(req), pid(req), req.body ?? {})));
router.post("/dept/:id/admin-decision", run((req) => dept.adminDecide(uid(req), pid(req), req.body ?? {})));
router.post("/dept/:id/accept", run((req) => dept.accept(uid(req), pid(req))));
router.post("/dept/:id/progress", run((req) => dept.setProgress(uid(req), pid(req), req.body ?? {})));
router.post("/dept/:id/reassign", run((req) => dept.reassign(uid(req), pid(req), req.body ?? {})));
router.post("/dept/:id/comments", run((req) => dept.comment(uid(req), pid(req), req.body ?? {})));
router.post("/dept/:id/confirm", run((req) => dept.confirm(uid(req), pid(req))));
router.post("/dept/:id/delete", run((req) => dept.deleteRequest(uid(req), pid(req), req.body ?? {})));
router.post("/dept/:id/reopen", run((req) => dept.reopen(uid(req), pid(req), req.body ?? {})));
router.get("/dept/:id/events/:eventId/attachment", async (req, res) => {
  try {
    const f = await dept.openAttachment(uid(req), pid(req), String(req.params.eventId));
    res.setHeader("Content-Type", f.mimeType);
    res.setHeader("Content-Disposition", `inline; filename="${f.fileName.replace(/["\r\n]/g, "")}"`);
    res.setHeader("Cache-Control", "no-store, private");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.send(f.buffer);
  } catch (e) {
    fail(res, e);
  }
});

router.get("/:id", run((req) => queries.getQuery(uid(req), pid(req))));
router.post("/:id/delete", run((req) => queries.deleteQuery(uid(req), pid(req), req.body ?? {})));
router.post("/:id/messages", run((req) => queries.reply(uid(req), pid(req), req.body ?? {})));
router.post("/:id/request-info", run((req) => queries.requestInfo(uid(req), pid(req), req.body ?? {})));
router.post("/:id/status", run((req) => queries.setStatus(uid(req), pid(req), req.body ?? {})));
router.post("/:id/assign", run((req) => queries.assign(uid(req), pid(req), req.body ?? {})));
router.get("/:id/messages/:messageId/attachment", async (req, res) => {
  try {
    const f = await queries.openAttachment(uid(req), pid(req), String(req.params.messageId));
    res.setHeader("Content-Type", f.mimeType);
    res.setHeader("Content-Disposition", `inline; filename="${f.fileName.replace(/["\r\n]/g, "")}"`);
    res.setHeader("Cache-Control", "no-store, private");
    res.send(f.buffer);
  } catch (e) {
    fail(res, e);
  }
});

export default router;
