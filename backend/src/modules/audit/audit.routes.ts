import { Router, type Request, type Response } from "express";
import { requireAuth, requireRole } from "../../middlewares/auth.js";
import { guardUuidParams, isBadInput } from "../../lib/params.js";
import * as audit from "./audit.service.js";

const router = Router();
guardUuidParams(router);

// Every service error code needs an entry here, otherwise it becomes a 500.
const MESSAGES: Record<string, { status: number; message: string }> = {
  NOT_ALLOWED: { status: 403, message: "Only HR and Admin can read the audit log." },
  NOT_FOUND: { status: 404, message: "That entry was not found." },
  USER_NOT_FOUND: { status: 404, message: "User not found." },
  BAD_DATE: { status: 400, message: "Dates must be real days in YYYY-MM-DD format." },
  BAD_RANGE: { status: 400, message: "The end date cannot be before the start date." },
  BAD_FILTER: { status: 400, message: "That filter value is not valid." },
};

function fail(res: Response, error: unknown) {
  if (isBadInput(error)) {
    res.status(400).json({ error: "One of the values sent is not valid." });
    return;
  }
  const code = error instanceof Error ? error.message : "UNKNOWN";
  const known = MESSAGES[code];
  if (known) return res.status(known.status).json({ error: known.message });
  console.error("Audit error:", error);
  return res.status(500).json({ error: "Something went wrong" });
}

const run = (fn: (req: Request) => Promise<unknown>) => async (req: Request, res: Response) => {
  try {
    res.json(await fn(req));
  } catch (e) {
    fail(res, e);
  }
};

// Read-only by design: there is deliberately no POST, PATCH or DELETE in this file.
router.use(requireAuth, requireRole("ADMIN"));
router.get("/filters", run((req) => audit.filters(req.user!.userId)));
router.get("/", run((req) => audit.listLogs(req.user!.userId, req.query as Record<string, unknown>)));
router.get("/:id", run((req) => audit.getLog(req.user!.userId, String(req.params.id))));

export default router;
