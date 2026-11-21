// ===========================================================================
// ONBOARDING ROUTES
//
// requireAuth only. Whether the caller is HR is decided inside the service,
// because several of these endpoints serve both HR and the candidate with
// different data rather than being staff-only outright.
// ===========================================================================

import { Router } from "express";
import { requireAuth } from "../../middlewares/auth.js";
import * as onboarding from "./onboarding.service.js";
import { sendWelcome } from "./onboarding.mail.js";
import { guardUuidParams, isBadInput } from "../../lib/params.js";

const router = Router();
guardUuidParams(router);

router.use(requireAuth);

const MESSAGES: Record<string, { status: number; message: string }> = {
  NOT_FOUND: { status: 404, message: "Not found, or not part of your platform." },
  FORBIDDEN: { status: 403, message: "That isn't yours to do." },
  TEAM_NOT_FOUND: { status: 404, message: "That team doesn't exist on your platform." },
  MISSING_FIELDS: { status: 400, message: "Please fill in all the required fields." },
  BAD_DATE: { status: 400, message: "Dates must be real days in YYYY-MM-DD format." },
  EMAIL_TAKEN: { status: 409, message: "Someone on this platform already uses that email." },
  WEAK_PASSWORD: { status: 400, message: "The password must be at least 8 characters." },
  SAME_PASSWORD: { status: 400, message: "The new password must be different." },
  WRONG_PASSWORD: { status: 400, message: "That current password isn't right." },
  BAD_CATEGORY: { status: 400, message: "Pick a valid document category." },
  REASON_REQUIRED: { status: 400, message: "Say why you're sending it back." },
  HR_UPLOADS_THIS: { status: 400, message: "HR uploads that document, not you." },
  EMPLOYEE_UPLOADS_THIS: { status: 400, message: "The employee uploads this document themselves. HR reviews it: verify it or reject it with a reason." },
  ALREADY_VERIFIED: { status: 409, message: "That document is already verified, so it cannot be replaced." },
  DUPLICATE_LABEL: { status: 409, message: "A requirement with that name already exists." },
  NAME_TOO_LONG: { status: 400, message: "Keep the name under 100 characters." },
  HELP_TOO_LONG: { status: 400, message: "Keep the description under 300 characters." },
  BAD_EMPLOYMENT_TYPE: { status: 400, message: "Employment type must be permanent, probation, contract or intern." },
  SCOPE_UNAVAILABLE: { status: 503, message: "Limiting a requirement to employment types needs a database update that has not been applied yet." },
  REQUIREMENT_INACTIVE: { status: 400, message: "That document is no longer being collected." },
  NOT_APPLICABLE: { status: 400, message: "That document does not apply to you." },
  UNSUPPORTED_FILE_TYPE: {
    status: 415,
    message: "Upload a PDF, JPG, PNG, WEBP or Word file.",
  },
  FILE_TOO_LARGE: { status: 413, message: "That file is over the 10 MB limit." },
  EMPTY_FILE: { status: 400, message: "That file appears to be empty." },
  FILE_MISSING: { status: 404, message: "That file is no longer on the server." },
  BAD_STORAGE_KEY: { status: 400, message: "That file reference isn't valid." },
};

function fail(res: any, error: unknown) {
  if (isBadInput(error)) {
    res.status(400).json({ error: "One of the values sent is not valid." });
    return;
  }
  const code = error instanceof Error ? error.message : "UNKNOWN";
  const mapped = MESSAGES[code];
  if (mapped) return res.status(mapped.status).json({ error: mapped.message, code });
  console.error("[onboarding]", error);
  return res.status(500).json({ error: "Something went wrong." });
}

const id = (v: unknown) => String(v);

// --- the candidate's own view ----------------------------------------------

router.get("/me", async (req, res) => {
  try {
    res.json(await onboarding.getMyOnboarding(req.user!.userId));
  } catch (e) {
    fail(res, e);
  }
});

router.post("/me/documents", async (req, res) => {
  try {
    res.json(await onboarding.uploadMyDocument(req.user!.userId, req.body ?? {}));
  } catch (e) {
    fail(res, e);
  }
});

router.post("/me/password", async (req, res) => {
  try {
    const current = String(req.body?.currentPassword ?? "");
    const next = String(req.body?.newPassword ?? "");
    res.json(await onboarding.changeOwnPassword(req.user!.userId, current, next));
  } catch (e) {
    fail(res, e);
  }
});

// --- HR: the pipeline -------------------------------------------------------

router.post("/hires", async (req, res) => {
  try {
    const created = await onboarding.createHire(req.user!.userId, req.body ?? {});

    // Sent after the person exists, and never allowed to fail the creation.
    // The response carries the outcome so HR knows whether to pass the
    // password on themselves.
    const mail = await sendWelcome(
      created.user.id,
      created.credentials.temporaryPassword
    );

    res.status(201).json({ ...created, mail });  } catch (e) {
    fail(res, e);
  }
});

router.get("/candidates", async (req, res) => {
  try {
    res.json({ candidates: await onboarding.listCandidates(req.user!.userId) });
  } catch (e) {
    fail(res, e);
  }
});

router.get("/candidates/:id", async (req, res) => {
  try {
    res.json(await onboarding.getCandidate(req.user!.userId, id(req.params.id)));
  } catch (e) {
    fail(res, e);
  }
});

router.post("/candidates/:id/documents", async (req, res) => {
  try {
    res.json(
      await onboarding.uploadForCandidate(
        req.user!.userId,
        id(req.params.id),
        req.body ?? {}
      )
    );
  } catch (e) {
    fail(res, e);
  }
});

router.post("/documents/:id/review", async (req, res) => {
  try {
    const approve = req.body?.approve === true;
    const reason = req.body?.rejectionReason
      ? String(req.body.rejectionReason)
      : undefined;
    res.json(
      await onboarding.reviewDocument(req.user!.userId, id(req.params.id), approve, reason)
    );
  } catch (e) {
    fail(res, e);
  }
});

// --- download ---------------------------------------------------------------

router.get("/documents/:id/file", async (req, res) => {
  try {
    const file = await onboarding.downloadDocument(req.user!.userId, id(req.params.id));

    res.setHeader("Content-Type", file.mimeType);
    // inline so a PDF opens in the browser instead of forcing a download.
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${file.fileName.replace(/"/g, "")}"`
    );
    // Personal data — never let a proxy or the browser cache it.
    res.setHeader("Cache-Control", "no-store, private");
    res.send(file.buffer);
  } catch (e) {
    fail(res, e);
  }
});

// --- requirements config ----------------------------------------------------

router.get("/requirements", async (req, res) => {
  try {
    res.json({ requirements: await onboarding.listRequirements(req.user!.userId) });
  } catch (e) {
    fail(res, e);
  }
});

router.post("/requirements", async (req, res) => {
  try {
    res.json({
      requirement: await onboarding.upsertRequirement(req.user!.userId, req.body ?? {}),
    });
  } catch (e) {
    fail(res, e);
  }
});

export default router;