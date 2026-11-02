import { Router, type Response } from "express";
import { requireAuth } from "../../middlewares/auth.js";
import { guardUuidParams, isBadInput } from "../../lib/params.js";
import { getAttendanceCalendar } from "./attendanceCalendar.service.js";

const router = Router();
guardUuidParams(router);
// Every role: the service decides whose calendar each one may see (self / reporting people / the companies HR and Admin act on).
router.use(requireAuth);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MESSAGES: Record<string, { status: number; message: string }> = {
  BAD_DATE: { status: 400, message: "Dates must look like 2026-10-30." },
  BAD_RANGE: { status: 400, message: "The end date is before the start date." },
  RANGE_TOO_LONG: { status: 400, message: "Pick a range of 93 days or less." },
};

function fail(res: Response, error: unknown) {
  if (isBadInput(error)) {
    res.status(400).json({ error: "One of the values sent is not valid." });
    return;
  }
  const known = MESSAGES[error instanceof Error ? error.message : ""];
  if (known) {
    res.status(known.status).json({ error: known.message });
    return;
  }
  console.error("Attendance calendar error:", error);
  res.status(500).json({ error: "Something went wrong" });
}

const text = (v: unknown, max = 40) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);

// ?from=YYYY-MM-DD&to=YYYY-MM-DD (default: this month) &userId= &teamId= (filters only narrow what the viewer may already see)
router.get("/", async (req, res) => {
  try {
    const userId = text(req.query.userId);
    const teamId = text(req.query.teamId);
    if ((userId && !UUID.test(userId)) || (teamId && !UUID.test(teamId))) {
      res.status(400).json({ error: "One of the values sent is not valid." });
      return;
    }
    res.json(await getAttendanceCalendar(req.user!.userId, { from: text(req.query.from, 10), to: text(req.query.to, 10), userId, teamId }));
  } catch (error) {
    fail(res, error);
  }
});

export default router;
