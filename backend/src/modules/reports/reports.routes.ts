// ===========================================================================
// REPORT ROUTES
//
// Only two things happen here: validate the query string, and map a thrown
// error code to an HTTP status. All the thinking lives in the service.
// ===========================================================================

import { Router } from "express";
import { parseFilters } from "../hr-filters/hrFilters.logic.js";
import { requireAuth } from "../../middlewares/auth.js";
import { getTeamReport, type GroupBy } from "./reports.service.js";
import { isBadInput } from "../../lib/params.js";

const router = Router();

const GROUP_BY_VALUES: GroupBy[] = ["person", "day", "week", "month", "year"];

const MESSAGES: Record<string, { status: number; message: string }> = {
  NOT_FOUND: { status: 404, message: "User not found." },
  BAD_DATE: { status: 400, message: "Dates must be in YYYY-MM-DD format." },
  BAD_RANGE: { status: 400, message: "The end date cannot be before the start date." },
};

function fail(res: any, error: unknown) {
  if (isBadInput(error)) {
    res.status(400).json({ error: "One of the values sent is not valid." });
    return;
  }
  const code = error instanceof Error ? error.message : "UNKNOWN";
  const mapped = MESSAGES[code];
  if (mapped) return res.status(mapped.status).json({ error: mapped.message });
  console.error("[reports]", error);
  return res.status(500).json({ error: "Something went wrong generating the report." });
}

// Default range: the first of the current month to today, in ISO form.
function defaultRange() {
  const now = new Date();
  const to = now.toISOString().slice(0, 10);
  const from = `${to.slice(0, 7)}-01`;
  return { from, to };
}

router.get("/", requireAuth, async (req, res) => {
  try {
    const fallback = defaultRange();
    const from = String(req.query.from ?? fallback.from);
    const to = String(req.query.to ?? fallback.to);

    const requested = String(req.query.groupBy ?? "person") as GroupBy;
    const groupBy = GROUP_BY_VALUES.includes(requested) ? requested : "person";

    const onlyUserId = req.query.userId ? String(req.query.userId) : undefined;
    const report = await getTeamReport(req.user!.userId, from, to, groupBy, onlyUserId, parseFilters(req.query as Record<string, unknown>));
    return res.json(report);
  } catch (error) {
    return fail(res, error);
  }
});

export default router;