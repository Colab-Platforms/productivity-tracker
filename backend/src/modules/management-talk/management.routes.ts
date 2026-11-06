import { Router, type Request, type Response } from "express";
import { requireAuth } from "../../middlewares/auth.js";
import * as svc from "./management.service.js";
import { guardUuidParams, isBadInput } from "../../lib/params.js";

const router = Router();
guardUuidParams(router, ["id", "messageId"]);

// Every service error code needs an entry here, otherwise it becomes a 500.
const MESSAGES: Record<string, { status: number; message: string }> = {
  NOT_FOUND: { status: 404, message: "That conversation was not found." },
  FORBIDDEN: { status: 403, message: "You can't do that here." },
  ADMIN_REQUIRED: { status: 400, message: "Choose which Admin to write to." },
  BAD_ADMIN: { status: 400, message: "Choose an active Admin other than yourself." },
  SUBJECT_REQUIRED: { status: 400, message: "Give it a short subject (at least 3 characters)." },
  SUBJECT_TOO_LONG: { status: 400, message: "Keep the subject under 150 characters." },
  MESSAGE_REQUIRED: { status: 400, message: "Write a message first." },
  MESSAGE_TOO_LONG: { status: 400, message: "Keep the message under 4,000 characters." },
  THREAD_CLOSED: { status: 409, message: "This conversation is closed. Start a new one if you still need to talk." },
  FEATURES_NOT_READY: { status: 503, message: "Talk to Management is not set up on this server yet. Ask an administrator to finish the database update." },
  UNSUPPORTED_FILE_TYPE: { status: 415, message: "Attach a PDF, JPG, PNG, WEBP or Word file." },
  EMPTY_FILE: { status: 400, message: "That file is empty." },
  FILE_TOO_LARGE: { status: 413, message: "That file is too large (10 MB maximum)." },
  FILE_MISSING: { status: 404, message: "The stored file could not be found." },
};

function fail(res: Response, error: unknown) {
  if (isBadInput(error)) {
    res.status(400).json({ error: "One of the values sent is not valid." });
    return;
  }
  const code = error instanceof Error ? error.message : "UNKNOWN";
  const known = MESSAGES[code];
  if (known) return res.status(known.status).json({ error: known.message });
  console.error("Talk to Management error:", error);
  return res.status(500).json({ error: "Something went wrong" });
}

const run = (fn: (req: Request) => Promise<unknown>) => async (req: Request, res: Response) => {
  try {
    res.setHeader("Cache-Control", "no-store, private");
    res.json(await fn(req));
  } catch (e) {
    fail(res, e);
  }
};
const uid = (req: Request) => req.user!.userId;
const pid = (req: Request) => String(req.params.id);

router.use(requireAuth);

// Fixed paths first, so they are never read as an :id.
router.get("/admins", run((req) => svc.listAdmins(uid(req))));
router.get("/waiting", run((req) => svc.waitingCount(uid(req))));
router.get("/", run((req) => svc.listThreads(uid(req))));
router.post("/", run((req) => svc.createThread(uid(req), req.body ?? {})));

router.get("/:id", run((req) => svc.getThread(uid(req), pid(req))));
router.post("/:id/messages", run((req) => svc.reply(uid(req), pid(req), req.body ?? {})));
router.post("/:id/close", run((req) => svc.close(uid(req), pid(req))));
router.get("/:id/messages/:messageId/attachment", async (req, res) => {
  try {
    const f = await svc.openAttachment(uid(req), pid(req), String(req.params.messageId));
    res.setHeader("Content-Type", f.mimeType);
    res.setHeader("Content-Disposition", `inline; filename="${f.fileName.replace(/["\r\n]/g, "")}"`);
    res.setHeader("Cache-Control", "no-store, private");
    res.send(f.buffer);
  } catch (e) {
    fail(res, e);
  }
});

export default router;
