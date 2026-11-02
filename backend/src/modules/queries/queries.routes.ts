import { Router, type Request, type Response } from "express";
import { requireAuth } from "../../middlewares/auth.js";
import * as queries from "./queries.service.js";
import { guardUuidParams, isBadInput } from "../../lib/params.js";

const router = Router();
guardUuidParams(router, ["id", "messageId"]);

// Every service error code needs an entry here, otherwise it becomes a 500.
const MESSAGES: Record<string, { status: number; message: string }> = {
  NOT_FOUND: { status: 404, message: "That query was not found." },
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

router.get("/:id", run((req) => queries.getQuery(uid(req), pid(req))));
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
