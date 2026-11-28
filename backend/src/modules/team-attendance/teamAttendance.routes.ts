import { Router, type Response } from "express";
import { parseFilters } from "../hr-filters/hrFilters.logic.js";
import { requireAuth, requireRole, requireMonitor } from "../../middlewares/auth.js";
import { guardUuidParams, isBadInput } from "../../lib/params.js";
import * as svc from "./teamAttendance.service.js";
import * as productivity from "./productivity.service.js";
import { getTeamReport } from "./teamReport.service.js";
import * as evaluation from "./evaluation.service.js";
import { clientIp } from "../../lib/clientIp.js";

const router = Router();
guardUuidParams(router);
router.use(requireAuth, requireMonitor);

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
  EVAL_MANAGERS_ONLY: { status: 403, message: "Only a manager can adjust an evaluation. HR and Admin can see the adjustments and their history." },
  EVAL_SELF: { status: 403, message: "You can't adjust your own evaluation." },
  EVAL_BAD_PERIOD: { status: 400, message: "The adjustment must be for the exact dates shown in the report." },
  EVAL_BAD_SCORE: { status: 400, message: "The score must be a number from 0 to 100." },
  EVAL_BAD_PRODUCTIVITY: { status: 400, message: "The productivity must be a number from 0 to 100." },
  EVAL_BAD_STATUS: { status: 400, message: "Choose one of the existing evaluation statuses." },
  EVAL_REASON_REQUIRED: { status: 400, message: "Give a reason for the adjustment (at least 5 characters)." },
  EVAL_REASON_TOO_LONG: { status: 400, message: "Keep the reason to 300 characters or fewer." },
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

// Work Efficiency Index (policy EFFICIENCY_V1): same people and filters as the productivity report; with userId it carries the task lines behind the number.
router.get("/efficiency", async (req, res) => {
  try {
    const userId = text(req.query.userId, 40);
    const teamId = text(req.query.teamId, 40);
    if (!goodIds(userId, teamId)) {
      res.status(400).json({ error: "One of the values sent is not valid." });
      return;
    }
    res.json(await productivity.getEfficiency(req.user!.userId, { from: text(req.query.from, 10), to: text(req.query.to, 10), userId, teamId, filters: parseFilters(req.query as Record<string, unknown>) }));
  } catch (error) {
    fail(res, error);
  }
});

// Manager Evaluation: adjust one person's score / status / productivity for the exact period shown (managers only, in their own reporting scope); history for everyone who may see the person.
router.post("/evaluation", async (req, res) => {
  try {
    res.json(await evaluation.saveEvaluation(req.user!.userId, clientIp(req), (req.body ?? {}) as Record<string, unknown>));
  } catch (error) {
    fail(res, error);
  }
});
router.get("/evaluation/history", async (req, res) => {
  try {
    const userId = text(req.query.userId, 40);
    if (!userId || !goodIds(userId)) return res.status(400).json({ error: "One of the values sent is not valid." });
    res.json(await evaluation.evaluationHistory(req.user!.userId, userId, text(req.query.from, 10) ?? "", text(req.query.to, 10) ?? ""));
  } catch (error) {
    fail(res, error);
  }
});

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

// One person's tasks for the drill-down (same people, range and filters as /productivity).
router.get("/productivity/person", async (req, res) => {
  try {
    const userId = text(req.query.userId, 40);
    if (!userId || !goodIds(userId)) {
      res.status(400).json({ error: "One of the values sent is not valid." });
      return;
    }
    res.json(await productivity.getPersonTasks(req.user!.userId, { userId, from: text(req.query.from, 10), to: text(req.query.to, 10), filters: parseFilters(req.query as Record<string, unknown>) }));
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
    const companyId = text(req.query.companyId, 40);
    if (companyId && !UUID.test(companyId)) {
      res.status(400).json({ error: "One of the values sent is not valid." });
      return;
    }
    res.json(await productivity.listTargets(req.user!.userId, companyId));
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
    const companyId = typeof req.body?.companyId === "string" && req.body.companyId ? req.body.companyId : undefined;
    if (companyId && !UUID.test(companyId)) {
      res.status(400).json({ error: "One of the values sent is not valid." });
      return;
    }
    res.json(await productivity.setTarget(req.user!.userId, { scope: req.body?.scope, id, tasksPerDay: req.body?.tasksPerDay, companyId }));
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

// "Show your working": for every eligible person and date the clock-in record, status and the reason it was or was not counted, plus people the viewer may
// see who are left out of the report altogether (and why). Same people and filters as the report. Names, IDs, dates and statuses only.
router.get("/attendance/diagnostic", async (req, res) => {
  try {
    const userId = text(req.query.userId, 40);
    if (userId && !UUID.test(userId)) {
      res.status(400).json({ error: "One of the values sent is not valid." });
      return;
    }
    res.json(await svc.getAttendanceDiagnostic(req.user!.userId, { from: text(req.query.from, 10), to: text(req.query.to, 10), userId, filters: parseFilters(req.query as Record<string, unknown>) }));
  } catch (error) {
    fail(res, error);
  }
});

// The complete team productivity report for one period (every sheet of the Manager download comes from this one answer). Same people and
// filters as the other reports; a manager gets only the people who report to them, an employee is refused by the router guard.
router.get("/team-report", async (req, res) => {
  try {
    res.json(await getTeamReport(req.user!.userId, { from: text(req.query.from, 10), to: text(req.query.to, 10), filters: parseFilters(req.query as Record<string, unknown>) }));
  } catch (error) {
    fail(res, error);
  }
});

export default router;
