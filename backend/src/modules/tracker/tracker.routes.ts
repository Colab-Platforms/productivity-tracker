import { Router, type Response } from "express";
import * as tracker from "./tracker.service.js";
import { getTimesheet } from "./timesheet.service.js";
import { requireAuth, requireRole } from "../../middlewares/auth.js";
import { guardUuidParams, isBadInput } from "../../lib/params.js";
import { LateRemarkRequired } from "./lateRemarks.js";
import { liveHuddle } from "../meetings/participation.service.js";

const router = Router();
guardUuidParams(router);

// Everything below requires a valid token.
router.use(requireAuth);

// One place that turns internal error codes into messages a person can read.
// The service throws codes; only this layer decides wording and status.
const MESSAGES: Record<string, { status: number; message: string }> = {
  USER_NOT_FOUND: { status: 404, message: "User not found" },
  TRACKER_LOCKED: {
    status: 403,
    message: "Your tracker access has not been enabled yet",
  },
  NO_ACTIVE_SESSION: { status: 400, message: "You are not clocked in" },
  ALREADY_COMPLETED: {
    status: 400,
    message: "You have already completed your workday",
  },
  BREAK_ALREADY_RUNNING: { status: 400, message: "A break is already running" },
  REMARK_REQUIRED: { status: 400, message: "Tell us why you are taking this time (at least 3 characters)." },
  REMARK_TOO_LONG: { status: 400, message: "Keep the remark to 300 characters or fewer." },
  NO_BREAK_RUNNING: { status: 400, message: "No break is running" },
  MEETING_RUNNING: {
    status: 400,
    message: "End your meeting before taking a break",
  },
  NO_MEETING_RUNNING: { status: 400, message: "No meeting is running" },
  MEETING_NOT_FOUND: { status: 404, message: "Meeting not found" },
    ALERT_NOT_FOUND: { status: 404, message: "Alert not found" },
  NOT_YOURS: { status: 403, message: "That invite is not addressed to you" },
  ALREADY_ANSWERED: {
    status: 400,
    message: "This invite has already been answered",
  },
  NOT_ALLOWED: { status: 403, message: "Only a manager can start a meeting" },
  BAD_PROJECT: { status: 400, message: "That project is not one of your teams" },
  LATE_REMARK_TOO_LONG: { status: 400, message: "Keep the late remark under 300 characters." },
  BAD_DATE: { status: 400, message: "Dates must be in YYYY-MM-DD format." },
  BAD_RANGE: { status: 400, message: "The end date cannot be before the start date." },
  RANGE_TOO_LONG: { status: 400, message: "Pick a range of 93 days or fewer." },
};

function fail(res: Response, error: unknown) {
  if (isBadInput(error)) {
    res.status(400).json({ error: "One of the values sent is not valid." });
    return;
  }
  // Late after the cut-off and no reason given yet: the screen asks for one and sends the clock-in again.
  if (error instanceof LateRemarkRequired) {
    return res.status(409).json({
      error: `You are ${error.lateByMinutes} min late. Add a short reason to clock in.`,
      code: "LATE_REMARK_REQUIRED",
      lateByMinutes: error.lateByMinutes,
    });
  }
  const code = error instanceof Error ? error.message : "UNKNOWN";
  const known = MESSAGES[code];

  if (known) return res.status(known.status).json({ error: known.message });

  console.error("Tracker error:", error);
  return res.status(500).json({ error: "Something went wrong" });
}

// --- My day ---------------------------------------------------------------

router.get("/session", async (req, res) => {
  try {
    const out = await tracker.getActiveSession(req.user!.userId);
    // The live Team Huddle counter for the clock-in card (display only). A failure here must never stop the timer from loading.
    const huddle = out.session ? await liveHuddle(out.session as never, new Date()).catch(() => null) : null;
    res.json({ ...out, huddle });
  } catch (error) {
    fail(res, error);
  }
});

router.post("/clock-in", async (req, res) => {
  try {
    res.json(await tracker.clockIn(req.user!.userId, typeof req.body?.teamId === "string" ? req.body.teamId : null, req.body?.lateRemark));
  } catch (error) {
    fail(res, error);
  }
});

router.post("/clock-out", async (req, res) => {
  try {
    res.json(await tracker.clockOut(req.user!.userId));
  } catch (error) {
    fail(res, error);
  }
});

// --- Breaks ---------------------------------------------------------------

router.post("/break/start", async (req, res) => {
  const { breakType, remark } = req.body ?? {};

  // DISCUSSION = "Meeting / Team Huddle" from the activity menu (needs a remark). OTHER is not offered to people: the system uses it itself.
  const allowed = ["TEA", "LUNCH", "WASHROOM", "PERSONAL", "OTHER", "DISCUSSION"];
  if (!allowed.includes(breakType)) {
    return res.status(400).json({ error: "Pick a valid break type" });
  }

  try {
    res.json(await tracker.startBreak(req.user!.userId, breakType, remark));
  } catch (error) {
    fail(res, error);
  }
});

router.post("/break/end", async (req, res) => {
  try {
    res.json(await tracker.endBreak(req.user!.userId));
  } catch (error) {
    fail(res, error);
  }
});

// --- Meeting invites ------------------------------------------------------

// Manager sends. requireRole blocks employees at the door — the service
// checks again, because a route is not the only way in.
router.post(
  "/meetings/invite",
  requireRole("MANAGER", "HR", "ADMIN"),
  async (req, res) => {
    const { employeeIds, meetingType, title } = req.body ?? {};

    if (!Array.isArray(employeeIds) || employeeIds.length === 0) {
      return res.status(400).json({ error: "Pick at least one person" });
    }

    const allowed = [
      "TEAM",
      "CLIENT",
      "ONE_ON_ONE",
      "TRAINING",
      "INTERVIEW",
      "OTHER",
    ];
    if (!allowed.includes(meetingType)) {
      return res.status(400).json({ error: "Pick a valid meeting type" });
    }

    try {
      res.json(
        await tracker.inviteToMeeting(
          req.user!.userId,
          employeeIds,
          meetingType,
          title
        )
      );
    } catch (error) {
      fail(res, error);
    }
  }
);

// What the employee's badge polls.
router.get("/invites", async (req, res) => {
  try {
    res.json(await tracker.listPendingInvites(req.user!.userId));
  } catch (error) {
    fail(res, error);
  }
});

router.post("/invites/:id/respond", async (req, res) => {
  const { accept, reason } = req.body ?? {};

  if (typeof accept !== "boolean") {
    return res.status(400).json({ error: "Accept or decline is required" });
  }

  try {
    res.json(
      await tracker.respondToMeeting(
        req.user!.userId,
        String(req.params.id),
        accept,
        reason
      )
    );
  } catch (error) {
    fail(res, error);
  }
});

// Only the manager who called the meeting can end it. An employee ending it
// could stop it hours later, or stop it for everyone else mid-meeting.
router.post("/meeting/end", requireRole("MANAGER", "HR", "ADMIN"), async (req, res) => {
  try {
    res.json(await tracker.endMeetingForAll(req.user!.userId));
  } catch (error) {
    fail(res, error);
  }
});

// --- Manager view ---------------------------------------------------------

router.get(
  "/team",
  requireRole("MANAGER", "HR", "ADMIN"),
  async (req, res) => {
    try {
      res.json(await tracker.getTeamLiveStatus(req.user!.userId));
    } catch (error) {
      fail(res, error);
    }
  }
);


// My timesheet: the schedule plus, per day, the real clock-in/out and every
// break and meeting interval. Always the signed-in person's own data.
router.get("/timesheet", async (req, res) => {
  try {
    res.json(
      await getTimesheet(
        req.user!.userId,
        typeof req.query.from === "string" ? req.query.from : undefined,
        typeof req.query.to === "string" ? req.query.to : undefined
      )
    );
  } catch (error) {
    fail(res, error);
  }
});

router.get("/history", async (req, res) => {
  const { from, to } = req.query;
  try {
    res.json(
      await tracker.getHistory(
        req.user!.userId,
        typeof from === "string" ? from : undefined,
        typeof to === "string" ? to : undefined
      )
    );
  } catch (error) {
    fail(res, error);
  }
});

// --- Alerts ---------------------------------------------------------------

router.get("/alerts", requireRole("MANAGER", "HR", "ADMIN"), async (req, res) => {
  try {
    res.json(await tracker.listTeamAlerts(req.user!.userId));
  } catch (error) {
    fail(res, error);
  }
});

router.post(
  "/alerts/:id/ack",
  requireRole("MANAGER", "HR", "ADMIN"),
  async (req, res) => {
    try {
      res.json(
        await tracker.acknowledgeAlert(req.user!.userId, String(req.params.id))
      );
    } catch (error) {
      fail(res, error);
    }
  }
);

export default router;