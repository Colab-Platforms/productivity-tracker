import { Router, type Request, type Response } from "express";
import { requireAuth, requireRole } from "../../middlewares/auth.js";
import * as companies from "./companies.service.js";
import { guardUuidParams, isBadInput } from "../../lib/params.js";

const router = Router();
guardUuidParams(router);

// Every service error code needs an entry here, otherwise it becomes a 500.
const MESSAGES: Record<string, { status: number; message: string }> = {
  NOT_ALLOWED: { status: 403, message: "Only HR and Admin can manage companies." },
  NOT_YOUR_COMPANY: { status: 403, message: "You can only edit your own company." },
  NOT_FOUND: { status: 404, message: "That company was not found." },
  USER_NOT_FOUND: { status: 404, message: "User not found." },
  NAME_REQUIRED: { status: 400, message: "Give the company a name." },
  NAME_TOO_LONG: { status: 400, message: "That name is too long." },
  COMPANY_EXISTS: { status: 409, message: "A company with that name already exists." },
  BAD_TIMEZONE: { status: 400, message: "That timezone is not valid (for example Asia/Kolkata)." },
  BAD_PREFIX: { status: 400, message: "The employee-code prefix must be 2 to 8 letters or digits." },
  PREFIX_TAKEN: { status: 409, message: "Another company already uses that prefix." },
  PREFIX_NOT_ALLOWED: { status: 403, message: "Only an Admin or top management can change a company's employee-ID prefix." },
  CANNOT_DEACTIVATE: { status: 400, message: "You cannot deactivate your own company, or the one this system is set up for." },
  NOTHING_TO_UPDATE: { status: 400, message: "Nothing to update." },
};

function fail(res: Response, error: unknown) {
  if (isBadInput(error)) {
    res.status(400).json({ error: "One of the values sent is not valid." });
    return;
  }
  const code = error instanceof Error ? error.message : "UNKNOWN";
  const known = MESSAGES[code];
  if (known) return res.status(known.status).json({ error: known.message });
  console.error("Companies error:", error);
  return res.status(500).json({ error: "Something went wrong" });
}

const run = (fn: (req: Request) => Promise<unknown>) => async (req: Request, res: Response) => {
  try {
    res.json(await fn(req));
  } catch (e) {
    fail(res, e);
  }
};

// Managers and Employees are refused before any service code runs.
router.use(requireAuth, requireRole("HR", "ADMIN"));

router.get("/", run((req) => companies.listCompanies(req.user!.userId)));
router.post("/", run((req) => companies.createCompany(req.user!.userId, req.body ?? {})));
router.post("/:id", run((req) => companies.updateCompany(req.user!.userId, String(req.params.id), req.body ?? {})));

export default router;
