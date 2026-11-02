import "dotenv/config";
import express from "express";
import cors from "cors";
import { createServer } from "node:http";
import { prisma } from "./lib/prisma.js";
import authRoutes from "./modules/auth/auth.routes.js";
import trackerRoutes from "./modules/tracker/tracker.routes.js";
import taskRoutes from "./modules/tasks/tasks.routes.js";
import reportRoutes from "./modules/reports/reports.routes.js";
import adminRoutes from "./modules/admin/admin.routes.js";
import ticketRoutes from "./modules/tickets/tickets.routes.js";
import queryRoutes from "./modules/queries/queries.routes.js";
import photoRoutes from "./modules/photos/photos.routes.js";
import onboardingRoutes from "./modules/onboarding/onboarding.routes.js";
import payrollRoutes from "./modules/payroll/payroll.routes.js";
import holidayRoutes from "./modules/holidays/holidays.routes.js";
import offerRoutes from "./modules/offers/offers.routes.js";
import projectRoutes from "./modules/projects/projects.routes.js";
import leaveRoutes from "./modules/leave/leave.routes.js";
import policyRoutes from "./modules/policies/policies.routes.js";
import correctionRoutes from "./modules/attendance-corrections/corrections.routes.js";
import notificationRoutes from "./modules/notifications/notifications.routes.js";
import preferenceRoutes from "./modules/preferences/preferences.routes.js";
import auditRoutes from "./modules/audit/audit.routes.js";
import documentRoutes from "./modules/documents/documents.routes.js";
import meetingRoutes from "./modules/meetings/meetings.routes.js";
import companyRoutes from "./modules/companies/companies.routes.js";
import teamAttendanceRoutes from "./modules/team-attendance/teamAttendance.routes.js";
import attendanceCalendarRoutes from "./modules/team-attendance/attendanceCalendar.routes.js";
import { startRealtime } from "./lib/realtime.js";
import { manageableUserIds } from "./modules/tasks/tasks.service.js";
import { requireAuth } from "./middlewares/auth.js";
import { requireTrackerAccess } from "./middlewares/trackerGate.js";
import { startTrackerScheduler } from "./modules/tracker/tracker.scheduler.js";
import { startOnboardingScheduler } from "./modules/onboarding/onboarding.scheduler.js";
import { textFields } from "./middlewares/textFields.js";
import { audit } from "./middlewares/audit.js";

const app = express();
const PORT = Number(process.env.PORT ?? 5001);

const allowedOrigins = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:3001",
  "http://127.0.0.1:3001",
  // Live addresses come from CORS_ORIGIN, comma-separated, so putting the
  // app on a new domain is a setting change rather than a code change and a
  // redeploy. Localhost stays listed so local work keeps running against
  // whichever backend you point it at.
  ...String(process.env.CORS_ORIGIN ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean),
];
app.use(cors({ origin: allowedOrigins, credentials: true }));
// Documents arrive as base64 inside the JSON body, so the default 100kb
// limit is far too small. 20mb covers a 10mb file plus base64's overhead.
app.use(express.json({ limit: "20mb" }));
app.use(textFields);
app.use(audit);

app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "tracker-backend",
    time: new Date().toISOString(),
  });
});

app.get("/api/db-health", async (_req, res) => {
  try {
    const count = await prisma.platform.count();
    res.json({ database: "connected", platforms: count });
  } catch (error) {
    res.status(500).json({
      database: "failed",
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

app.use("/api/auth", authRoutes);

// The gate runs before any tracker route. Someone mid-onboarding can sign
// in and see their checklist, but cannot record a minute of work.
app.use("/api/tracker", requireAuth, requireTrackerAccess, trackerRoutes);
app.use("/api/tasks", requireAuth, requireTrackerAccess, taskRoutes);
app.use("/api/reports", reportRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/tickets", ticketRoutes);
app.use("/api/queries", queryRoutes);
app.use("/api/photos", photoRoutes);
app.use("/api/onboarding", onboardingRoutes);
app.use("/api/payroll", payrollRoutes);
app.use("/api/holidays", holidayRoutes);
app.use("/api/offers", offerRoutes);
app.use("/api/projects", projectRoutes);
app.use("/api/leave", leaveRoutes);
app.use("/api/policies", policyRoutes);
app.use("/api/attendance-corrections", correctionRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/preferences", preferenceRoutes);
app.use("/api/audit-logs", auditRoutes);
app.use("/api/documents", documentRoutes);
app.use("/api/meetings", meetingRoutes);
app.use("/api/companies", companyRoutes);
app.use("/api/team-attendance", teamAttendanceRoutes);
app.use("/api/attendance-calendar", attendanceCalendarRoutes);
app.use((_req, res) => {
  res.status(404).json({ error: "Route not found" });
});

// Express and Socket.IO share one HTTP server (and one port). Real-time is an extra: if it fails to start the
// REST API still runs, and every page falls back to ordinary polling.
const httpServer = createServer(app);
try {
  startRealtime(httpServer, {
    origins: allowedOrigins,
    // The people whose task events a user may receive: the same rule the Team Tasks queue already uses.
    personsFor: async (u) => (u.role === "EMPLOYEE" ? [] : manageableUserIds({ id: u.userId, role: u.role, platformId: u.platformId })),
  });
} catch (e) {
  console.error("[realtime] not started:", e instanceof Error ? e.message : e);
}

httpServer.listen(PORT, () => {
  console.log(`Tracker backend listening on http://localhost:${PORT}`);
  startTrackerScheduler();
  startOnboardingScheduler();
});