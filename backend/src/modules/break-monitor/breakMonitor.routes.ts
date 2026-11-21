import { Router, type Response } from "express";
import { requireAuth, requireRole } from "../../middlewares/auth.js";
import { isBadInput } from "../../lib/params.js";
import { parseFilters } from "../hr-filters/hrFilters.logic.js";
import * as svc from "./breakMonitor.service.js";

// Break Management: ADMIN ONLY (enforced here, not just by hiding the menu item). Read-only.
const router = Router();
router.use(requireAuth, requireRole("ADMIN"));

const MESSAGES: Record<string, { status: number; message: string }> = {
  NOT_ALLOWED: { status: 403, message: "Break Management is for Admins only." },
  NOT_FOUND: { status: 404, message: "That person is not in the companies you can see." },
  BAD_DATE: { status: 400, message: "Dates must look like 2026-11-21." },
  BAD_RANGE: { status: 400, message: "The end date cannot be before the start date." },
  RANGE_TOO_LONG: { status: 400, message: "Choose at most 93 days." },
};

function fail(res: Response, error: unknown) {
  if (isBadInput(error)) return res.status(400).json({ error: "One of the values sent is not valid." });
  const known = MESSAGES[error instanceof Error ? error.message : ""];
  if (known) return res.status(known.status).json({ error: known.message });
  console.error("Break monitor error:", error);
  return res.status(500).json({ error: "Something went wrong" });
}

router.get("/", async (req, res) => {
  try {
    const qs = req.query as Record<string, unknown>;
    res.json(await svc.overview(req.user!.userId, { from: qs.from, to: qs.to, filters: parseFilters(qs), breakType: qs.breakType, status: qs.status, defaulter: qs.defaulter, userId: qs.userId }));
  } catch (e) {
    fail(res, e);
  }
});

export default router;
