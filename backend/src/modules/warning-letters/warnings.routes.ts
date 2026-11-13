import { Router, type Request, type Response } from "express";
import { requireAuth } from "../../middlewares/auth.js";
import * as letters from "./warnings.service.js";
import { guardUuidParams, isBadInput } from "../../lib/params.js";

const router = Router();
guardUuidParams(router, ["id", "userId"]);

// Every service error code needs an entry here, otherwise it becomes a 500.
const MESSAGES: Record<string, { status: number; message: string }> = {
  NOT_ALLOWED: { status: 403, message: "Only HR and Admin can do that." },
  NOT_FOUND: { status: 404, message: "That warning letter was not found." },
  NOT_YOURSELF: { status: 403, message: "You cannot issue a warning letter to yourself." },
  TITLE_REQUIRED: { status: 400, message: "Give the letter a name (at least 3 characters)." },
  TITLE_TOO_LONG: { status: 400, message: "The letter name is too long (120 characters at most)." },
  REASON_REQUIRED: { status: 400, message: "Write the reason (at least 3 characters)." },
  REASON_TOO_LONG: { status: 400, message: "The reason is too long (1,000 characters at most)." },
  LETTER_REQUIRED: { status: 400, message: "Upload the letter or type it in." },
  FILE_OR_TEXT: { status: 400, message: "Either upload a file or type the letter, not both." },
  TEXT_TOO_SHORT: { status: 400, message: "The letter text is too short." },
  TEXT_TOO_LONG: { status: 400, message: "The letter text is too long (8,000 characters at most)." },
  BAD_DATE: { status: 400, message: "The issue date must look like 2026-11-12." },
  BAD_ISSUE_DATE: { status: 400, message: "The issue date cannot be in the future or more than a year ago." },
  UNSUPPORTED_FILE_TYPE: { status: 415, message: "Upload a PDF, JPG, PNG, WEBP or Word file." },
  EMPTY_FILE: { status: 400, message: "That file is empty." },
  FILE_TOO_LARGE: { status: 413, message: "That file is too large (10 MB maximum)." },
  FILE_MISSING: { status: 404, message: "The stored file could not be found." },
  ALREADY_ACKNOWLEDGED: { status: 409, message: "You already acknowledged this letter." },
};

function fail(res: Response, error: unknown) {
  if (isBadInput(error)) return res.status(400).json({ error: "One of the values sent is not valid." });
  const code = error instanceof Error ? error.message : "UNKNOWN";
  const known = MESSAGES[code];
  if (known) return res.status(known.status).json({ error: known.message });
  console.error("Warning letters error:", error);
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

// The signed-in person's own letters (the id comes from the sign-in, never from the request).
router.get("/mine", run((req) => letters.mine(uid(req))));
// HR / Admin: one employee's letters.
router.get("/person/:userId", run((req) => letters.forPerson(uid(req), String(req.params.userId))));
// HR / Admin: issue a letter (upload a file, or type the text and the system builds the PDF).
router.post("/", run((req) => letters.issue(uid(req), req.body ?? {})));
// The letter itself: only the employee it is for, or HR/Admin of that company. Never a public address.
router.get("/:id/file", async (req, res) => {
  try {
    const f = await letters.openFile(uid(req), String(req.params.id));
    const download = req.query.download === "1";
    res.setHeader("Content-Type", f.mimeType);
    res.setHeader("Content-Disposition", `${download ? "attachment" : "inline"}; filename="${f.fileName.replace(/["\r\n]/g, "")}"`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store, private");
    res.send(f.buffer);
  } catch (e) {
    fail(res, e);
  }
});
// The employee confirms receipt (once).
router.post("/:id/acknowledge", run((req) => letters.acknowledge(uid(req), String(req.params.id))));

export default router;
