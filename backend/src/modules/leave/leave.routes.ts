import { Router, type Request, type Response } from "express";
import { parseFilters } from "../hr-filters/hrFilters.logic.js";
import { requireAuth } from "../../middlewares/auth.js";
import * as leave from "./leave.service.js";
import { guardUuidParams, isBadInput } from "../../lib/params.js";

const router = Router();
guardUuidParams(router);

// Every service error code needs an entry here, otherwise it becomes a 500.
const MESSAGES: Record<string, { status: number; message: string }> = {
  BAD_DATE: { status: 400, message: "Dates must be real days in YYYY-MM-DD format." },
  BAD_RANGE: { status: 400, message: "The end date cannot be before the start date." },
  RANGE_TOO_LONG: { status: 400, message: "Request at most 60 days at a time." },
  TOO_OLD: { status: 400, message: "Leave can only be requested for the last 30 days or later." },
  BAD_TYPE: { status: 400, message: "Choose a leave type." },
  BAD_YEAR: { status: 400, message: "That year is not valid." },
  REASON_REQUIRED: { status: 400, message: "Please give a short reason." },
  REASON_TOO_LONG: { status: 400, message: "Keep the reason under 500 characters." },
  HALF_DAY_ONE_DAY: { status: 400, message: "A half day can only be requested for a single day." },
  NO_WORKING_DAYS: { status: 400, message: "Those dates are all weekly offs or holidays, so there is nothing to request." },
  LEAVE_OVERLAP: { status: 400, message: "You already have leave (or a request) on some of those days." },
  NOT_PENDING: { status: 400, message: "Only a request that is still waiting can be cancelled." },
  BAD_DECISION: { status: 400, message: "Decision must be approve or reject." },
  ALREADY_DECIDED: { status: 400, message: "This request has already been decided." },
  OWN_REQUEST: { status: 403, message: "You cannot approve or reject your own leave. Another HR or Admin must decide it." },
  NOT_ALLOWED: { status: 403, message: "Only HR and Admin can do that." },
  NOT_FOUND: { status: 404, message: "That request or person was not found." },
  USER_NOT_FOUND: { status: 404, message: "User not found." },
  WAITING_FOR_MANAGER: { status: 409, message: "This request is waiting for the first approver (the manager or Admin it was sent to). HR can decide after they approve." },
  NOT_FINAL_STAGE: { status: 403, message: "Only the person this request was sent to can decide it." },
  BAD_APPROVER: { status: 400, message: "That person cannot approve this request. An employee tags a Manager; a manager's leave goes to the Admin they report to; HR tags an Admin." },
  TAGGED_ADMIN_REQUIRED: { status: 400, message: "Choose the Admin who will approve your leave." },
  BAD_PROJECT: { status: 400, message: "Choose only projects you are assigned to." },
  SKIP_REASON_REQUIRED: { status: 400, message: "Give a reason (at least 5 characters) for deciding without the manager." },
  MANAGER_REJECTED: { status: 409, message: "The manager rejected this request, so it cannot be approved. You can close it as rejected." },
  STEP_ALREADY_DECIDED: { status: 409, message: "The manager step on this request was already answered." },
  COMMENT_REQUIRED: { status: 400, message: "Please say why you are rejecting this request." },
};

function fail(res: Response, error: unknown) {
  if (isBadInput(error)) {
    res.status(400).json({ error: "One of the values sent is not valid." });
    return;
  }
  const code = error instanceof Error ? error.message : "UNKNOWN";
  const known = MESSAGES[code];
  if (known) return res.status(known.status).json({ error: known.message });
  console.error("Leave error:", error);
  return res.status(500).json({ error: "Something went wrong" });
}

const run = (fn: (req: Request) => Promise<unknown>) => async (req: Request, res: Response) => {
  try {
    res.json(await fn(req));
  } catch (e) {
    fail(res, e);
  }
};

router.use(requireAuth);

// Employee: own requests and leave taken.
router.get("/mine", run((req) => leave.myLeave(req.user!.userId, req.query.year)));
// The leave form: who can be tagged, who is preselected, and the person's own projects.
router.get("/form-options", run((req) => leave.formOptions(req.user!.userId)));
// The dashboard overview for the viewer's role (counts only; the pages hold the details).
router.get("/overview", run((req) => leave.overview(req.user!.userId)));
// "Total days" for the form: working days in the range (weekly offs and holidays excluded).
router.get("/preview", run((req) => leave.previewDays(req.user!.userId, req.query.from, req.query.to, req.query.half)));
// Who is away (approved leave) in the person's company. Names, dates and type only.
router.get("/away", run((req) => leave.awayList(req.user!.userId, req.query.from, req.query.to)));
router.post("/requests", run((req) => leave.requestLeave(req.user!.userId, req.body ?? {})));
router.post("/requests/:id/cancel", run((req) => leave.cancelRequest(req.user!.userId, String(req.params.id))));

// HR / Admin (the service checks the role and the company).
router.get(
  "/requests",
  run((req) =>
    leave.listRequests(req.user!.userId, req.query.status, {
      hr: parseFilters(req.query as Record<string, unknown>),
      leaveType: req.query.leaveType,
      stage: req.query.stage,
      from: req.query.from,
      to: req.query.to,
    })
  )
);
router.post(
  "/requests/:id/decide",
  run((req) => leave.decideRequest(req.user!.userId, String(req.params.id), req.body?.decision, req.body?.note, { skipManager: req.body?.skipManager, skipReason: req.body?.skipReason }))
);

// Manager: requests from the people who report to them (the manager step).
router.get("/manager/requests", run((req) => leave.managerRequests(req.user!.userId)));
router.post(
  "/manager/requests/:id/decide",
  run((req) => leave.managerDecide(req.user!.userId, String(req.params.id), req.body?.decision, req.body?.note))
);
router.get("/summary", run((req) => leave.leaveSummary(req.user!.userId, req.query.year, parseFilters(req.query as Record<string, unknown>))));
router.get("/person/:id", run((req) => leave.personLeave(req.user!.userId, String(req.params.id), req.query.year)));

export default router;
