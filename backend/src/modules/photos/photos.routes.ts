import { Router, type Request, type Response } from "express";
import { requireAuth } from "../../middlewares/auth.js";
import * as photos from "./photos.service.js";
import { guardUuidParams, isBadInput } from "../../lib/params.js";

const router = Router();
guardUuidParams(router, ["userId"]);

// Every service error code needs an entry here, otherwise it becomes a 500.
const MESSAGES: Record<string, { status: number; message: string }> = {
  NOT_FOUND: { status: 404, message: "No photo found." },
  FEATURES_NOT_READY: { status: 503, message: "Profile photos are not set up on this server yet. Ask an administrator to finish the database update." },
  PHOTO_REQUIRED: { status: 400, message: "Choose a photo first." },
  PHOTO_TOO_LARGE: { status: 413, message: "That photo is too large (2 MB maximum)." },
  PHOTO_BAD_TYPE: { status: 415, message: "Use a JPG, PNG or WebP photo." },
  FILE_MISSING: { status: 404, message: "The stored photo could not be found." },
  UNSUPPORTED_FILE_TYPE: { status: 415, message: "Use a JPG, PNG or WebP photo." },
  EMPTY_FILE: { status: 400, message: "That file is empty." },
  FILE_TOO_LARGE: { status: 413, message: "That photo is too large (2 MB maximum)." },
};

function fail(res: Response, error: unknown) {
  if (isBadInput(error)) return res.status(400).json({ error: "One of the values sent is not valid." });
  const code = error instanceof Error ? error.message : "UNKNOWN";
  const known = MESSAGES[code];
  if (known) return res.status(known.status).json({ error: known.message });
  console.error("Photos error:", error);
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

// The image itself, only to people allowed to see it, never from a public address.
router.get("/:userId", async (req, res) => {
  try {
    const f = await photos.getPhoto(uid(req), String(req.params.userId));
    res.setHeader("Content-Type", f.mimeType);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "private, max-age=300");
    res.send(f.buffer);
  } catch (e) {
    fail(res, e);
  }
});
router.put("/:userId", run((req) => photos.setPhoto(uid(req), String(req.params.userId), req.body ?? {})));
router.post("/:userId", run((req) => photos.setPhoto(uid(req), String(req.params.userId), req.body ?? {})));
router.delete("/:userId", run((req) => photos.removePhoto(uid(req), String(req.params.userId))));

export default router;
