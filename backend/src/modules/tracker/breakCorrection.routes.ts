import { Router, type Request, type Response } from "express";
import { requireAuth } from "../../middlewares/auth.js";
import { guardUuidParams, isBadInput } from "../../lib/params.js";
import * as svc from "./breakCorrection.service.js";

const router = Router();
guardUuidParams(router);

// Every service error code needs an entry here, otherwise it becomes a 500.
const MESSAGES: Record<string, { status: number; message: string }> = {
  NOT_ALLOWED: { status: 403, message: "Only an Admin can correct a break." },
  OWN_BREAK: { status: 403, message: "You can't correct your own break. Another Admin must do it." },
  NOT_FOUND: { status: 404, message: "That break was not found." },
  USER_NOT_FOUND: { status: 404, message: "User not found." },
  BREAK_STILL_RUNNING: { status: 409, message: "That break is still running. Only a finished break can be corrected." },
  NOT_A_BREAK: { status: 400, message: "Only break rows (tea, lunch, personal, other) can be corrected, not washroom or discussion time." },
  BAD_DURATION: { status: 400, message: "Give the actual break length as a whole number of minutes (0 or more)." },
  CANNOT_INCREASE: { status: 400, message: "A correction can only shorten a break. It cannot be longer than what was recorded." },
  REASON_REQUIRED: { status: 400, message: `Please explain the correction (at least ${svc.REASON_MIN} characters).` },
  REASON_TOO_LONG: { status: 400, message: `Keep the reason under ${svc.REASON_MAX} characters.` },
  NOT_CORRECTED: { status: 409, message: "That break has no correction to revert." },
  BAD_DATE: { status: 400, message: "Dates must be real days in YYYY-MM-DD format." },
};

function fail(res: Response, error: unknown) {
  if (isBadInput(error)) return res.status(400).json({ error: "One of the values sent is not valid." });
  const code = error instanceof Error ? error.message : "UNKNOWN";
  const known = MESSAGES[code];
  if (known) return res.status(known.status).json({ error: known.message });
  console.error("Break correction error:", error);
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

router.use(requireAuth);

// Admin only (the service checks the role and the company).
router.get("/", run((req) => svc.breaksForDay(uid(req), String(req.query.userId ?? ""), req.query.date)));
router.post("/:id/correct", run((req) => svc.applyCorrection(uid(req), String(req.params.id), req.body?.minutes, req.body?.reason)));
router.post("/:id/revert", run((req) => svc.revertCorrection(uid(req), String(req.params.id), req.body?.reason)));

export default router;
