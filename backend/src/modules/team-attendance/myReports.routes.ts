import { Router, type Response } from "express";
import { requireAuth } from "../../middlewares/auth.js";
import * as svc from "./teamAttendance.service.js";
import * as productivity from "./productivity.service.js";

// An employee's own monthly report: the same attendance and task-productivity data the manager reports use, but locked to the signed-in
// person. No userId, team or company filter is read from the request, so nobody can ask for someone else's figures.
const router = Router();
router.use(requireAuth);

const MESSAGES: Record<string, { status: number; message: string }> = {
  USER_NOT_FOUND: { status: 404, message: "Account not found." },
  BAD_DATE: { status: 400, message: "Dates must look like 2026-10-30." },
  BAD_RANGE: { status: 400, message: "The end date is before the start date." },
  RANGE_TOO_LONG: { status: 400, message: "Pick a range of 93 days or less." },
};

function fail(res: Response, error: unknown) {
  const known = MESSAGES[error instanceof Error ? error.message : ""];
  if (known) {
    res.status(known.status).json({ error: known.message });
    return;
  }
  console.error("My report error:", error);
  res.status(500).json({ error: "Something went wrong" });
}

const text = (v: unknown, max = 10) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);

router.get("/attendance", async (req, res) => {
  try {
    res.json(await svc.getAttendanceReport(req.user!.userId, { from: text(req.query.from), to: text(req.query.to), self: true }));
  } catch (error) {
    fail(res, error);
  }
});

router.get("/productivity", async (req, res) => {
  try {
    res.json(await productivity.getProductivity(req.user!.userId, { from: text(req.query.from), to: text(req.query.to), self: true }));
  } catch (error) {
    fail(res, error);
  }
});

router.get("/productivity/tasks", async (req, res) => {
  try {
    res.json(await productivity.getProductivityTasks(req.user!.userId, { from: text(req.query.from), to: text(req.query.to), self: true }));
  } catch (error) {
    fail(res, error);
  }
});

export default router;
