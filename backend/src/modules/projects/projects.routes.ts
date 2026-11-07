import { Router } from "express";
import { requireAuth, requireRole } from "../../middlewares/auth.js";
import * as projects from "./projects.service.js";
import { guardUuidParams, isBadInput } from "../../lib/params.js";

const router = Router();
guardUuidParams(router);

function fail(
  res: { status: (n: number) => { json: (b: unknown) => void } },
  err: unknown
) {
  if (isBadInput(err)) {
    res.status(400).json({ error: "One of the values sent is not valid." });
    return;
  }
  const code = err instanceof Error ? err.message : "UNKNOWN";
  // Only short error codes (MISSING_FIELDS, NOT_FOUND...) go back to the browser. Anything else is an
  // unexpected failure (for example database error text with file paths): log it, tell the user nothing.
  if (!/^[A-Z][A-Z0-9_:]*$/.test(code)) {
    console.error("[projects]", err);
    res.status(500).json({ error: "Something went wrong" });
    return;
  }
  const status =
    code === "NOT_ALLOWED" || code === "NOT_YOUR_COMPANY"
      ? 403
      : code === "NOT_FOUND" ||
        code === "USER_NOT_FOUND" ||
        code === "MANAGER_NOT_FOUND" ||
        code === "NOT_A_MEMBER"
      ? 404
      : code === "FEATURES_NOT_READY"
      ? 503
      : 400;
  res.status(status).json({ error: code });
}

router.use(requireAuth);

// Managers may read the projects they run; the service decides.
router.get("/", async (req, res) => {
  try {
    res.json(await projects.listProjects(req.user!.userId));
  } catch (err) {
    fail(res, err);
  }
});

// Every write below (create/edit a project, its managers and members) is Admin-only. HR can still read the list above.
router.use(requireRole("ADMIN"));

router.post("/", async (req, res) => {
  try {
    res.json(await projects.saveProject(req.user!.userId, req.body ?? {}));
  } catch (err) {
    fail(res, err);
  }
});

router.post("/:id/co-managers", async (req, res) => {
  try {
    res.json(
      await projects.addCoManager(req.user!.userId, String(req.params.id), String(req.body?.userId ?? ""))
    );
  } catch (err) {
    fail(res, err);
  }
});

router.post("/:id/co-managers/:userId/remove", async (req, res) => {
  try {
    res.json(
      await projects.removeCoManager(req.user!.userId, String(req.params.id), String(req.params.userId))
    );
  } catch (err) {
    fail(res, err);
  }
});

router.post("/:id/members", async (req, res) => {
  try {
    res.json(
      await projects.addMember(
        req.user!.userId,
        String(req.params.id),
        req.body ?? {}
      )
    );
  } catch (err) {
    fail(res, err);
  }
});

router.post("/:id/members/:userId/primary", async (req, res) => {
  try {
    res.json(
      await projects.makePrimary(
        req.user!.userId,
        String(req.params.id),
        String(req.params.userId)
      )
    );
  } catch (err) {
    fail(res, err);
  }
});

router.post("/:id/members/:userId/remove", async (req, res) => {
  try {
    res.json(
      await projects.removeMember(
        req.user!.userId,
        String(req.params.id),
        String(req.params.userId)
      )
    );
  } catch (err) {
    fail(res, err);
  }
});

export default router;