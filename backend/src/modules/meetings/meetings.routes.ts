import { Router, type Request, type Response } from "express";
import { requireAuth } from "../../middlewares/auth.js";
import { guardUuidParams, isBadInput } from "../../lib/params.js";
import * as meetings from "./meetings.service.js";
import * as participation from "./participation.service.js";

const router = Router();
guardUuidParams(router);

// Every service error code needs an entry here, otherwise it becomes a 500.
const MESSAGES: Record<string, { status: number; message: string }> = {
  NOT_ALLOWED: { status: 403, message: "You don't have permission to do that." },
  NOT_FOUND: { status: 404, message: "That meeting was not found." },
  USER_NOT_FOUND: { status: 404, message: "User not found." },
  BAD_DATE: { status: 400, message: "The date must be a real day in YYYY-MM-DD format." },
  BAD_TIME: { status: 400, message: "Times must look like 14:30 (24-hour)." },
  BAD_RANGE: { status: 400, message: "The meeting must end after it starts, on the same day." },
  TOO_LONG: { status: 400, message: "A meeting can be at most 12 hours long." },
  PAST_MEETING: { status: 400, message: "A meeting can't be scheduled in the past." },
  BAD_URL: { status: 400, message: "Paste a full https link (for example from Google Meet, Teams or Zoom)." },
  TITLE_REQUIRED: { status: 400, message: "Give the meeting a title." },
  TITLE_TOO_LONG: { status: 400, message: "Keep the title under 120 characters." },
  DESCRIPTION_TOO_LONG: { status: 400, message: "Keep the description under 1000 characters." },
  ATTENDEES_REQUIRED: { status: 400, message: "Choose at least one person to invite." },
  TOO_MANY: { status: 400, message: "You can invite at most 100 people." },
  ATTENDEE_NOT_FOUND: { status: 400, message: "Everyone invited must be an active person in your company." },
  MEETING_CANCELLED: { status: 409, message: "This meeting has already been cancelled." },
  MEETING_OVER: { status: 409, message: "This meeting has already ended." },
  NOT_STARTED: { status: 409, message: "This meeting hasn't started yet. Cancel it instead." },
  // --- in-person participation ---
  FEATURES_NOT_READY: { status: 503, message: "In-person meeting tracking isn't switched on for this system yet." },
  NOT_TRACKED: { status: 409, message: "This meeting doesn't track who joins." },
  BAD_LATE_MINUTES: { status: 400, message: "Choose how many minutes late counts as late: a whole number from 0 to 120." },
  JOIN_TOO_EARLY: { status: 409, message: "You can join from 15 minutes before the meeting starts." },
  JOIN_CLOSED: { status: 409, message: "Joining has closed because the meeting's expected end has passed. Ask the organizer to record it." },
  ACCEPT_WHEN_STARTED: { status: 409, message: "This Team Huddle hasn't started yet. You will be asked to accept when it starts." },
  NOT_ACCEPTED: { status: 409, message: "Accept the invitation first, then you can join." },
  BAD_RESPONSE: { status: 400, message: "Answer must be accept or decline." },
  ALREADY_JOINED: { status: 409, message: "You have already joined this meeting. If you left and came back, ask the organizer to correct it." },
  NOT_JOINED: { status: 409, message: "You haven't joined this meeting." },
  ALREADY_ENDED: { status: 409, message: "You have already ended your participation." },
  NOT_INVITED: { status: 400, message: "That person isn't invited to this meeting." },
  REASON_REQUIRED: { status: 400, message: "Give a reason of at least 5 characters. It is kept with the correction." },
  REASON_TOO_LONG: { status: 400, message: "Keep the reason under 300 characters." },
  JOIN_TIME_REQUIRED: { status: 400, message: "To record someone as present, enter the time they joined." },
  NOTHING_TO_CHANGE: { status: 400, message: "That is already what is recorded." },
  TIME_IN_FUTURE: { status: 400, message: "A joining or leaving time can't be in the future." },
  NOT_YOUR_REPORT: { status: 403, message: "A Team Huddle can only include people who report to you." },
  END_BEFORE_JOIN: { status: 400, message: "The leaving time must be after the joining time." },
};

function fail(res: Response, error: unknown) {
  if (isBadInput(error)) {
    res.status(400).json({ error: "One of the values sent is not valid." });
    return;
  }
  const code = error instanceof Error ? error.message : "UNKNOWN";
  const known = MESSAGES[code];
  if (known) return res.status(known.status).json({ error: known.message });
  console.error("Meetings error:", error);
  return res.status(500).json({ error: "Something went wrong" });
}

const run = (fn: (req: Request) => Promise<unknown>) => async (req: Request, res: Response) => {
  try {
    res.json(await fn(req));
  } catch (e) {
    fail(res, e);
  }
};
const uid = (req: Request) => req.user!.userId;

router.use(requireAuth);

router.get("/", run((req) => meetings.listMine(uid(req), { scope: req.query.scope, q: req.query.q })));
router.get("/oversight", run((req) => meetings.oversight(uid(req), { scope: req.query.scope })));
router.get("/people", run((req) => meetings.people(uid(req))));
// In-person participation. Static paths come before "/:id".
router.get("/huddles/overview", run((req) => participation.managerOverview(uid(req), typeof req.query.date === "string" ? req.query.date : undefined)));
router.get("/participation/history", run((req) => participation.history(uid(req), typeof req.query.userId === "string" && req.query.userId ? req.query.userId : undefined)));
router.get("/:id", run((req) => meetings.getOne(uid(req), String(req.params.id))));
router.post("/:id/respond", run((req) => participation.respond(uid(req), String(req.params.id), req.body?.response)));
router.post("/:id/join", run((req) => participation.join(uid(req), String(req.params.id))));
router.post("/:id/leave", run((req) => participation.leave(uid(req), String(req.params.id))));
router.get("/:id/participation", run((req) => participation.list(uid(req), String(req.params.id))));
router.get("/:id/participation-counts", run((req) => participation.counts(uid(req), String(req.params.id))));
router.patch("/:id/participation/:userId", run((req) => participation.correct(uid(req), String(req.params.id), String(req.params.userId), req.body ?? {})));
router.post("/", run((req) => meetings.create(uid(req), req.body ?? {})));
router.patch("/:id", run((req) => meetings.update(uid(req), String(req.params.id), req.body ?? {})));
router.post("/:id/end", run((req) => meetings.end(uid(req), String(req.params.id))));
router.post("/:id/cancel",run((req) => meetings.cancel(uid(req), String(req.params.id), req.body?.reason)));

export default router;
