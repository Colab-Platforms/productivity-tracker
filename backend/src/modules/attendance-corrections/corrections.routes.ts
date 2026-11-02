import { Router, type Request, type Response } from "express";
import { requireAuth } from "../../middlewares/auth.js";
import { guardUuidParams, isBadInput } from "../../lib/params.js";
import * as corrections from "./corrections.service.js";

const router = Router();
guardUuidParams(router);

// Every service error code needs an entry here, otherwise it becomes a 500.
const MESSAGES: Record<string, { status: number; message: string }> = {
  BAD_DATE: { status: 400, message: "Dates must be real days in YYYY-MM-DD format." },
  BAD_RANGE: { status: 400, message: "The check-out must be after the check-in, within 24 hours." },
  FUTURE_DATE: { status: 400, message: "You can't request a correction for a future day." },
  FUTURE_TIME: { status: 400, message: "A requested time can't be in the future." },
  TOO_OLD: { status: 400, message: "Corrections can only be requested for the last 30 days. Please contact HR for older days." },
  BAD_TYPE: { status: 400, message: "Choose what kind of correction this is." },
  BAD_TIME: { status: 400, message: "Times must look like 09:30 (24-hour)." },
  TIME_REQUIRED: { status: 400, message: "Give the check-in time, the check-out time, or both." },
  LOGIN_TIME_REQUIRED: { status: 400, message: "Give the check-in time you should have had." },
  LOGOUT_TIME_REQUIRED: { status: 400, message: "Give the check-out time you should have had." },
  REASON_REQUIRED: { status: 400, message: "Please explain what happened (at least a few words)." },
  REASON_TOO_LONG: { status: 400, message: "Keep the reason under 500 characters." },
  ON_LEAVE: { status: 400, message: "That day is marked as leave, so there is no attendance to correct." },
  DUPLICATE_PENDING: { status: 409, message: "You already have a pending request for that day." },
  NO_SESSION_NEEDS_LOGIN: { status: 400, message: "Nothing was recorded for that day, so a check-in time is needed." },
  NO_SESSION_NEEDS_BOTH: { status: 400, message: "Nothing was recorded for that day, so both check-in and check-out times are needed." },
  ACTIVE_SESSION_TODAY: { status: 400, message: "You are still clocked in today. Clock out normally instead of requesting a correction." },
  BREAKS_CONFLICT: { status: 409, message: "The requested times don't fit around the breaks recorded that day." },
  NOT_PENDING: { status: 400, message: "Only a request that is still waiting can be cancelled." },
  BAD_DECISION: { status: 400, message: "Decision must be approve or reject." },
  COMMENT_REQUIRED: { status: 400, message: "Please say why you are rejecting this request." },
  ALREADY_DECIDED: { status: 409, message: "This request has already been decided." },
  OWN_REQUEST: { status: 403, message: "You can't decide your own request. Another HR or Admin must do it." },
  NOT_ALLOWED: { status: 403, message: "Only HR and Admin can do that." },
  NOT_FOUND: { status: 404, message: "That request was not found." },
  USER_NOT_FOUND: { status: 404, message: "User not found." },
  WAITING_FOR_MANAGER: { status: 409, message: "This request is waiting for the manager. HR can decide after the manager approves, or without the manager if you give a reason." },
  SKIP_REASON_REQUIRED: { status: 400, message: "Give a reason (at least 5 characters) for deciding without the manager." },
  MANAGER_REJECTED: { status: 409, message: "The manager rejected this request, so it cannot be approved. You can close it as rejected." },
  STEP_ALREADY_DECIDED: { status: 409, message: "The manager step on this request was already answered." },
  TRACKER_LOCKED: { status: 403, message: "Your attendance is not active yet." },
  UNSUPPORTED_FILE_TYPE: { status: 415, message: "Attach a PDF, JPG, PNG, WEBP or Word file." },
  EMPTY_FILE: { status: 400, message: "That file is empty." },
  FILE_TOO_LARGE: { status: 413, message: "That file is too large (10 MB maximum)." },
};

function fail(res: Response, error: unknown) {
  if (isBadInput(error)) {
    res.status(400).json({ error: "One of the values sent is not valid." });
    return;
  }
  const code = error instanceof Error ? error.message : "UNKNOWN";
  const known = MESSAGES[code];
  if (known) return res.status(known.status).json({ error: known.message });
  console.error("Corrections error:", error);
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

// Anyone: their own requests.
router.get("/mine", run((req) => corrections.listMine(uid(req))));
router.post("/", run((req) => corrections.submitRequest(uid(req), req.body ?? {})));
router.post("/:id/cancel", run((req) => corrections.cancelRequest(uid(req), pid(req))));

// HR / Admin (the service checks the role and the company).
// Manager step: requests from the people who report to this manager (fixed paths, before /:id).
router.get("/manager/requests", run((req) => corrections.managerRequests(uid(req))));
router.post("/manager/requests/:id/decide", run((req) => corrections.managerDecide(uid(req), pid(req), req.body?.decision, req.body?.comment)));
router.get("/pending-count", run((req) => corrections.pendingCount(uid(req))));
router.get("/", run((req) => corrections.listForReview(uid(req), { status: req.query.status, from: req.query.from, to: req.query.to, q: req.query.q, teamId: req.query.teamId })));
router.post("/:id/decide", run((req) => corrections.decide(uid(req), pid(req), req.body?.decision, req.body?.comment, { skipManager: req.body?.skipManager, skipReason: req.body?.skipReason })));

// The employee (own) or HR/Admin (company): one request's details, and its evidence file.
router.get("/:id", run((req) => corrections.details(uid(req), pid(req))));
router.get("/:id/attachment", async (req, res) => {
  try {
    const f = await corrections.openAttachment(uid(req), pid(req));
    res.setHeader("Content-Type", f.mimeType);
    res.setHeader("Content-Disposition", `inline; filename="${f.fileName.replace(/"/g, "")}"`);
    res.setHeader("Cache-Control", "no-store, private");
    res.send(f.buffer);
  } catch (e) {
    fail(res, e);
  }
});

export default router;
