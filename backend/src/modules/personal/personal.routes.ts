import { Router, type Request, type Response } from "express";
import { requireAuth } from "../../middlewares/auth.js";
import * as svc from "./personal.service.js";
import { guardUuidParams, isBadInput } from "../../lib/params.js";

const router = Router();
guardUuidParams(router, ["userId"]);
router.use(requireAuth);

// Every service error code needs an entry here, otherwise it becomes a 500.
const MESSAGES: Record<string, { status: number; message: string }> = {
  NOT_FOUND: { status: 404, message: "No such employee." },
  FEATURES_NOT_READY: { status: 503, message: "Personal details are not set up on this server yet. Ask an administrator to finish the database update." },
  NOTHING_TO_SAVE: { status: 400, message: "There is nothing to save: every field was left blank." },
};

function fail(res: Response, error: unknown) {
  if (isBadInput(error)) return res.status(400).json({ error: "One of the values sent is not valid." });
  const code = error instanceof Error ? error.message : "UNKNOWN";
  if (code === "INVALID_DETAILS") {
    const details = (error as { details?: { field: string; message: string }[] }).details ?? [];
    return res.status(400).json({ error: details.map((d) => d.message).join(" "), code, fields: details });
  }
  const known = MESSAGES[code];
  if (known) return res.status(known.status).json({ error: known.message });
  console.error("Personal details error:", error);
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

// The signed-in person's OWN details (id from the sign-in, never from the request).
router.get("/me", run((req) => svc.getDetails(uid(req), uid(req))));
// One person's details: the person, or HR / Admin of their company.
router.get("/:userId", run((req) => svc.getDetails(uid(req), String(req.params.userId))));
// HR / Admin only.
router.put("/:userId", run((req) => svc.saveDetails(uid(req), String(req.params.userId), (req.body ?? {}) as Record<string, unknown>)));

export default router;
