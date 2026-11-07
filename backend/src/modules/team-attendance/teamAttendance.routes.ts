import { Router, type Response } from "express";
import { parseFilters } from "../hr-filters/hrFilters.logic.js";
import { requireAuth, requireRole } from "../../middlewares/auth.js";
import { guardUuidParams, isBadInput } from "../../lib/params.js";
import * as svc from "./teamAttendance.service.js";
import * as productivity from "./productivity.service.js";

const router = Router();
guardUuidParams(router);
router.use(requireAuth, requireRole("MANAGER", "HR", "ADMIN"));

const MESSAGES: Record<string, { status: number; message: string }> = {
  USER_NOT_FOUND: { status: 404, message: "Account not found." },
  NOT_ALLOWED: { status: 403, message: "You are not allowed to do that." },
  BAD_DATE: { status: 400, message: "Dates must look like 2026-10-30." },
  BAD_RANGE: { status: 400, message: "The end date is before the start date." },
  RANGE_TOO_LONG: { status: 400, message: "Pick a range of 93 days or less." },
  BAD_STATUS: { status: 400, message: "That attendance status is not valid." },
  BAD_ARRIVAL: { status: 400, message: "That late remark filter is not valid." },
  BAD_SCOPE: { status: 400, message: "Choose the company, a team or a person." },
  BAD_TARGET: { status: 400, message: "A daily target must be a whole number from 1 to 1000." },
  NOT_FOUND: { status: 404, message: "Not found." },
  TARGETS_NOT_READY: { status: 503, message: "Daily targets are not set up on this server yet. Ask an administrator to finish the database update." },
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
  console.error("Team attendance error:", error);
  res.status(500).json({ error: "Something went wrong" });
}

// Today, live. Polled every 30 seconds by the page.
router.get("/live", async (req, res) => {
  try {
    res.json(await svc.getLiveBoard(req.user!.userId, parseFilters(req.query as Record<string, unknown>)));
  } catch (error) {
    fail(res, error);
  }
});

// One day, how each person spent it. ?date=YYYY-MM-DD (default: today).
router.get("/shift-breakdown", async (req, res) => {
  try {
    res.json(await svc.getShiftBreakdown(req.user!.userId, typeof req.query.date === "string" && req.query.date ? req.query.date : undefined, parseFilters(req.query as Record<string, unknown>)));
  } catch (error) {
    fail(res, error);
  }
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// --- Task productivity (tasks completed / daily target) -------------------------------------
const goodIds = (...v: (string | undefined)[]) => v.every((x) => !x || UUID.test(x));

router.get("/productivity", async (req, res) => {
  try {
    const userId = text(req.query.userId, 40);
    const teamId = text(req.query.teamId, 40);
    if (!goodIds(userId, teamId)) {
      res.status(400).json({ error: "One of the values sent is not valid." });
      return;
    }
    res.json(await productivity.getProductivity(req.user!.userId, { from: text(req.query.from, 10), to: text(req.query.to, 10), userId, teamId, filters: parseFilters(req.query as Record<string, unknown>) }));
  } catch (error) {
    fail(res, error);
  }
});

// The tasks behind the productivity report (for the Excel export). Same people, same range, same filters as /productivity.
router.get("/productivity/tasks", async (req, res) => {
  try {
    const userId = text(req.query.userId, 40);
    const teamId = text(req.query.teamId, 40);
    if (!goodIds(userId, teamId)) {
      res.status(400).json({ error: "One of the values sent is not valid." });
      return;
    }
    res.json(await productivity.getProductivityTasks(req.user!.userId, { from: text(req.query.from, 10), to: text(req.query.to, 10), userId, teamId, filters: parseFilters(req.query as Record<string, unknown>) }));
  } catch (error) {
    fail(res, error);
  }
});

router.get("/productivity/hourly", async (req, res) => {
  try {
    const userId = text(req.query.userId, 40);
    const teamId = text(req.query.teamId, 40);
    if (!goodIds(userId, teamId)) {
      res.status(400).json({ error: "One of the values sent is not valid." });
      return;
    }
    res.json(await productivity.getHourly(req.user!.userId, { date: text(req.query.date, 10), userId, teamId, filters: parseFilters(req.query as Record<string, unknown>) }));
  } catch (error) {
    fail(res, error);
  }
});

// --- Daily targets: HR/Admin only --------------------------------------------------------------
router.get("/targets", requireRole("HR", "ADMIN"), async (req, res) => {
  try {
    res.json(await productivity.listTargets(req.user!.userId));
  } catch (error) {
    fail(res, error);
  }
});

router.post("/targets", requireRole("HR", "ADMIN"), async (req, res) => {
  try {
    const id = typeof req.body?.id === "string" ? req.body.id : undefined;
    if (id && !UUID.test(id)) {
      res.status(400).json({ error: "One of the values sent is not valid." });
      return;
    }
    res.json(await productivity.setTarget(req.user!.userId, { scope: req.body?.scope, id, tasksPerDay: req.body?.tasksPerDay }));
  } catch (error) {
    fail(res, error);
  }
});

const text =(v: unknown, max = 80) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);

// A date range, one row per person per day. Filters only narrow what the viewer may already see.
router.get("/attendance", async (req, res) => {
  try {
    const userId = text(req.query.userId, 40);
    const teamId = text(req.query.teamId, 40);
    if ((userId && !UUID.test(userId)) || (teamId && !UUID.test(teamId))) {
      res.status(400).json({ error: "One of the values sent is not valid." });
      return;
    }
    res.json(
      await svc.getAttendanceReport(req.user!.userId, {
        from: text(req.query.from, 10),
        to: text(req.query.to, 10),
        userId,
        teamId,
        shift: text(req.query.shift),
        status: text(req.query.status, 20),
        arrival: text(req.query.arrival, 20),
        filters: parseFilters(req.query as Record<string, unknown>),
      })
    );
  } catch (error) {
    fail(res, error);
  }
});

export default router;
