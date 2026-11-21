import { Router, type Request, type Response } from "express";
import { requireAuth } from "../../middlewares/auth.js";
import { guardUuidParams, isBadInput } from "../../lib/params.js";
import * as documents from "./documents.service.js";

const router = Router();
guardUuidParams(router);

// Every service error code needs an entry here, otherwise it becomes a 500.
const MESSAGES: Record<string, { status: number; message: string }> = {
  NOT_ALLOWED: { status: 403, message: "Only HR and Admin can do that." },
  NOT_FOUND: { status: 404, message: "That employee was not found." },
  USER_NOT_FOUND: { status: 404, message: "User not found." },
  BAD_EMPLOYMENT_TYPE: { status: 400, message: "Employment type must be permanent, probation, contract or intern." },
  FEATURE_UNAVAILABLE: { status: 503, message: "This needs a database update that has not been applied yet." },
};

function fail(res: Response, error: unknown) {
  if (isBadInput(error)) {
    res.status(400).json({ error: "One of the values sent is not valid." });
    return;
  }
  const code = error instanceof Error ? error.message : "UNKNOWN";
  const known = MESSAGES[code];
  if (known) return res.status(known.status).json({ error: known.message });
  console.error("Documents error:", error);
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

// Everyone: their own checklist.
router.get("/mine", run((req) => documents.listMine(uid(req))));

// HR / Admin (the service checks the role and the company).
router.get("/tracking", run((req) => documents.tracking(uid(req), { q: req.query.q, status: req.query.status, employmentType: req.query.employmentType, teamId: req.query.teamId })));
router.get("/history/:id", run((req) => documents.documentHistory(uid(req), String(req.params.id))));
router.get("/employees/:userId", run((req) => documents.employeeChecklist(uid(req), String(req.params.userId))));
router.post("/employees/:userId/employment-type", run((req) => documents.setEmploymentType(uid(req), String(req.params.userId), req.body?.employmentType)));

export default router;
