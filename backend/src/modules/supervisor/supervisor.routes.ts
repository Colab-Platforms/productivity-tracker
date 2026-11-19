import { Router, type NextFunction, type Request, type Response } from "express";
import { requireAuth } from "../../middlewares/auth.js";
import { isBadInput } from "../../lib/params.js";
import { isSupervisor } from "../../lib/supervisor.js";
import { parseFilters } from "../hr-filters/hrFilters.logic.js";
import { listEmployees } from "./supervisor.service.js";

const router = Router();

// Productivity Supervisors only. Every route here is a READ; there is deliberately no way to create, edit or delete anything from this module.
async function requireSupervisor(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user || !(await isSupervisor(req.user.userId))) {
      res.status(403).json({ error: "NOT_ALLOWED" });
      return;
    }
    next();
  } catch (e) {
    console.error("Supervisor guard error:", e);
    res.status(500).json({ error: "Something went wrong" });
  }
}
router.use(requireAuth, requireSupervisor);

function fail(res: Response, error: unknown) {
  if (isBadInput(error)) return res.status(400).json({ error: "One of the values sent is not valid." });
  console.error("Supervisor error:", error);
  return res.status(500).json({ error: "Something went wrong" });
}

// All Employees: everybody in every company, narrowed by the shared filters.
router.get("/employees", async (req, res) => {
  try {
    res.json(await listEmployees(req.user!.userId, parseFilters(req.query as Record<string, unknown>)));
  } catch (e) {
    fail(res, e);
  }
});

export default router;
