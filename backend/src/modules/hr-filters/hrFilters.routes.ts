import { Router, type Response } from "express";
import { requireAuth, requireRole } from "../../middlewares/auth.js";
import { isBadInput } from "../../lib/params.js";
import { parseFilters } from "./hrFilters.logic.js";
import { options } from "./hrFilters.service.js";

const router = Router();
// HR and Admin (the companies they act on) and managers (their own people). Everyone else has nothing to filter.
router.use(requireAuth, requireRole("HR", "ADMIN", "MANAGER"));

const MESSAGES: Record<string, { status: number; message: string }> = {
  NOT_ALLOWED: { status: 403, message: "You do not have people to filter." },
};

function fail(res: Response, error: unknown) {
  if (isBadInput(error)) return res.status(400).json({ error: "One of the values sent is not valid." });
  const known = MESSAGES[error instanceof Error ? error.message : ""];
  if (known) return res.status(known.status).json({ error: known.message });
  console.error("HR filters error:", error);
  return res.status(500).json({ error: "Something went wrong" });
}

// The filter bar's choices and counts. Read-only; everything is limited to the people the viewer may already see.
router.get("/options", async (req, res) => {
  try {
    res.json(await options(req.user!.userId, parseFilters(req.query as Record<string, unknown>)));
  } catch (e) {
    fail(res, e);
  }
});

export default router;
