import { Router } from "express";
import { requireAuth } from "../../middlewares/auth.js";
import { parseIsoDay } from "../../lib/dates.js";
import { isCrmReportsUser, requireCrmReportsUser } from "./crmReports.access.js";
import { CRM_RANGES, CRM_REPORTS, CrmError, crmGet, type CrmDeps, type CrmReport } from "./crmClient.js";

// /api/crm-reports. The CRM stays the source of truth: this only forwards a validated request and returns the CRM's own answer.

export function createCrmReportsRouter(deps: CrmDeps = {}) {
  const router = Router();
  router.use(requireAuth);

  // The sidebar asks this. It answers about the signed-in person only (true/false), so it reveals nothing to anyone else.
  router.get("/access", (req, res) => {
    res.json({ allowed: isCrmReportsUser(req.user?.userId) });
  });

  // Everything below is for the one allowed user, checked on the server on every request.
  router.use(requireCrmReportsUser);

  const send = (res: import("express").Response, e: unknown) => {
    if (e instanceof CrmError) return res.status(e.status).json({ error: e.message, code: e.code, ...(e.extra ?? {}) });
    console.error("CRM reports error:", e instanceof Error ? e.name : "unknown");
    return res.status(500).json({ error: "Something went wrong", code: "INTERNAL_ERROR" });
  };

  router.get("/health", async (_req, res) => {
    try {
      res.json(await crmGet("health", {}, deps));
    } catch (e) {
      send(res, e);
    }
  });

  router.get("/:report", async (req, res) => {
    const report = String(req.params.report) as CrmReport;
    if (!CRM_REPORTS.includes(report)) return res.status(404).json({ error: "Unknown report.", code: "UNKNOWN_REPORT" });
    try {
      const range = String(req.query.range ?? "last_7_days").toLowerCase();
      if (!(CRM_RANGES as readonly string[]).includes(range)) throw new CrmError(400, "BAD_RANGE", "That date range is not supported.");
      const q: Record<string, string | undefined> = { range };
      if (range === "custom") {
        try {
          const from = parseIsoDay(req.query.from);
          const to = parseIsoDay(req.query.to);
          if (from > to) throw new Error("BAD_DATE");
        } catch {
          throw new CrmError(400, "BAD_DATE", "Choose a valid From and To date (From must not be after To).");
        }
        q.from = String(req.query.from);
        q.to = String(req.query.to);
      }
      res.json(await crmGet(report, q, deps));
    } catch (e) {
      send(res, e);
    }
  });

  return router;
}

export default createCrmReportsRouter();
