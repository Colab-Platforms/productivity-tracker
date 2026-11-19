import { Router, type Response } from "express";
import { requireAuth } from "../../middlewares/auth.js";
import { guardUuidParams, isBadInput } from "../../lib/params.js";
import * as svc from "./loginActivity.service.js";

const router = Router();
guardUuidParams(router);
router.use(requireAuth);

const MESSAGES: Record<string, { status: number; message: string }> = {
  USER_NOT_FOUND: { status: 404, message: "Account not found." },
  NOT_ALLOWED: { status: 403, message: "You are not allowed to see this." },
  NOT_FOUND: { status: 404, message: "That record was not found." },
  BAD_DATE: { status: 400, message: "Dates must look like 2026-11-19." },
};

function fail(res: Response, error: unknown) {
  if (isBadInput(error)) return res.status(400).json({ error: "One of the values sent is not valid." });
  const known = MESSAGES[error instanceof Error ? error.message : ""];
  if (known) return res.status(known.status).json({ error: known.message });
  console.error("Login activity error:", error);
  return res.status(500).json({ error: "Something went wrong" });
}

// Anyone: their OWN history. The person comes from the sign-in, never from the request.
router.get("/mine", async (req, res) => {
  try {
    res.json(await svc.mine(req.user!.userId, req.query as Record<string, unknown>));
  } catch (e) {
    fail(res, e);
  }
});

// Admin and HR: everyone in the companies they act on (the service refuses every other role). Read only: there is no route that changes a record.
router.get("/", async (req, res) => {
  try {
    res.json(await svc.list(req.user!.userId, req.query as svc.Filters));
  } catch (e) {
    fail(res, e);
  }
});

router.get("/:id", async (req, res) => {
  try {
    res.json(await svc.detail(req.user!.userId, String(req.params.id)));
  } catch (e) {
    fail(res, e);
  }
});

export default router;
