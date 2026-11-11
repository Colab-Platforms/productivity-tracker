import { Router, type Request, type Response } from "express";
import { requireAuth } from "../../middlewares/auth.js";
import * as policies from "./policies.service.js";
import { guardUuidParams, isBadInput } from "../../lib/params.js";

const router = Router();
guardUuidParams(router);

// Every service error code needs an entry here, otherwise it becomes a 500.
const MESSAGES: Record<string, { status: number; message: string }> = {
  NOT_ALLOWED: { status: 403, message: "Only HR and Admin can do that." },
  NOT_FOUND: { status: 404, message: "That policy was not found." },
  USER_NOT_FOUND: { status: 404, message: "User not found." },
  TEAM_NOT_FOUND: { status: 404, message: "One of those teams doesn't exist in your company." },
  BAD_CATEGORY: { status: 400, message: "Pick a valid category." },
  BAD_CATEGORY_NAME: { status: 400, message: "A category name must be 2 to 60 characters." },
  CATEGORY_EXISTS: { status: 409, message: "That category already exists." },
  BAD_AUDIENCE: { status: 400, message: "One of the audience choices is not valid." },
  BAD_VERSION: { status: 400, message: "A version label may use letters, numbers, dots, dashes and underscores (up to 20 characters)." },
  BAD_DATE: { status: 400, message: "Dates must look like 2026-10-31." },
  BAD_STATUS: { status: 400, message: "That status is not valid." },
  TITLE_REQUIRED: { status: 400, message: "Give the policy a title." },
  TITLE_TOO_LONG: { status: 400, message: "That title is too long." },
  FILE_REQUIRED: { status: 400, message: "Attach a file." },
  UNSUPPORTED_FILE_TYPE: { status: 415, message: "Upload a PDF, JPG, PNG, WEBP or Word file." },
  EMPTY_FILE: { status: 400, message: "That file is empty." },
  FILE_TOO_LARGE: { status: 413, message: "That file is too large (10 MB maximum)." },
  FILE_MISSING: { status: 404, message: "The stored file could not be found." },
  OPEN_FIRST: { status: 400, message: "Open the policy first, then confirm you have read it." },
  CONFIRM_REQUIRED: { status: 400, message: "Tick the confirmation box first." },
  NOT_A_DRAFT: { status: 409, message: "Only a draft can be edited. Published policies change through a new version." },
  NOT_PUBLISHED: { status: 409, message: "Only a published policy can get a new version." },
  DRAFT_VERSION_EXISTS: { status: 409, message: "A new version is already being prepared. Publish it or replace its file." },
  VERSION_LABEL_EXISTS: { status: 409, message: "That version label is already used for this policy." },
  NO_DRAFT_VERSION: { status: 409, message: "There is no unpublished version to replace." },
  NOTHING_TO_PUBLISH: { status: 409, message: "There is no unpublished version to publish." },
  OPEN_NOTES: { status: 409, message: "This policy still has open review notes. Resolve them, or confirm you have reviewed them, before publishing." },
  REASON_REQUIRED: { status: 400, message: "Give a short reason for dismissing the note." },
  DOWNLOAD_NOT_ALLOWED: { status: 403, message: "HR has not allowed downloading this policy. You can read it here." },
  FEATURES_NOT_READY: { status: 503, message: "Policy management is not set up on this server yet. Ask an administrator to finish the database update." },
};

function fail(res: Response, error: unknown) {
  if (isBadInput(error)) {
    res.status(400).json({ error: "One of the values sent is not valid." });
    return;
  }
  const code = error instanceof Error ? error.message : "UNKNOWN";
  const known = MESSAGES[code];
  if (known) return res.status(known.status).json({ error: known.message });
  console.error("Policies error:", error);
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
const pid = (req: Request) => String(req.params.id);
const text = (v: unknown, max = 80) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const versionNo = (req: Request) => {
  const raw = text(req.query.version, 6);
  if (raw === undefined) return undefined;
  if (!/^\d{1,4}$/.test(raw)) throw new Error("BAD_STATUS");
  return Number(raw);
};

router.use(requireAuth);

// An owner HR/Admin can manage another company's policies by adding `?company=<id>` to a request. The service re-checks on every
// request that the person really is an owner HR/Admin; anyone else gets a 403.
router.use((req, res, next) => {
  const raw = req.query.company;
  if (raw === undefined) return next();
  const id = typeof raw === "string" ? raw : "";
  if (!UUID.test(id)) return fail(res, new Error("NOT_FOUND"));
  return policies.withActingCompany(id, () => next());
});

// --- Everyone (employees see only published policies meant for them; HR/Admin see their company's) ---
router.get("/", run((req) => policies.listMine(uid(req))));
router.get("/companies", run((req) => policies.listCompanies(uid(req))));
router.get("/history", run((req) => policies.history(uid(req))));

// --- HR / Admin: fixed paths first, so they are never read as an :id ---
router.get("/manage", run((req) => policies.manageList(uid(req))));
router.get("/categories", run((req) => policies.listCategories(uid(req))));
router.post("/categories", run((req) => policies.addCategory(uid(req), req.body ?? {})));
router.get(
  "/tracking",
  run((req) => {
    const policyId = text(req.query.policyId, 40);
    const teamId = text(req.query.teamId, 40);
    const userId = text(req.query.userId, 40);
    const companyId = text(req.query.companyId, 40);
    if ([policyId, teamId, userId, companyId].some((x) => x && !UUID.test(x))) throw new Error("BAD_STATUS");
    const status = text(req.query.status, 20);
    if (status && !["ACKNOWLEDGED", "PENDING"].includes(status)) throw new Error("BAD_STATUS");
    return policies.tracking(uid(req), { policyId, teamId, userId, status, search: text(req.query.search, 60), everyone: true, allCompanies: true, companyId });
  })
);
router.post("/", run((req) => policies.createDocument(uid(req), req.body ?? {})));

// --- One policy ---
router.get("/:id", run((req) => policies.getPolicy(uid(req), pid(req))));
router.get("/:id/view", run((req) => policies.viewContent(uid(req), pid(req), { version: versionNo(req) })));
router.get("/:id/file", async (req, res) => {
  try {
    const download = req.query.download === "1";
    const file = await policies.openFile(uid(req), pid(req), { version: versionNo(req), download });
    res.setHeader("Content-Type", file.mimeType);
    res.setHeader("Content-Disposition", `${download ? "attachment" : "inline"}; filename="${file.fileName.replace(/["\r\n]/g, "")}"`);
    res.setHeader("Cache-Control", "no-store, private");
    res.send(file.buffer);
  } catch (e) {
    fail(res, e);
  }
});
router.post("/:id/acknowledge", run((req) => policies.acknowledge(uid(req), pid(req), req.body ?? {})));

router.patch("/:id", run((req) => policies.updateDraft(uid(req), pid(req), req.body ?? {})));
router.post("/:id/file", run((req) => policies.replaceFile(uid(req), pid(req), req.body ?? {})));
router.get("/:id/versions", run((req) => policies.versions(uid(req), pid(req))));
router.post("/:id/versions", run((req) => policies.uploadNewVersion(uid(req), pid(req), req.body ?? {})));
router.post("/:id/publish", run((req) => policies.publish(uid(req), pid(req), req.body ?? {})));
router.post("/:id/archive", run((req) => policies.setActive(uid(req), pid(req), false)));
router.post("/:id/restore", run((req) => policies.setActive(uid(req), pid(req), true)));
router.get("/:id/report", run((req) => policies.report(uid(req), pid(req))));
router.post(
  "/:id/notes/:noteId",
  run((req) => {
    const noteId = String(req.params.noteId);
    if (!UUID.test(noteId)) throw new Error("NOT_FOUND");
    return policies.resolveNote(uid(req), pid(req), noteId, req.body ?? {});
  })
);

export default router;
