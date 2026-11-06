import { Router, type Response } from "express";
import { requireAuth } from "../../middlewares/auth.js";
import { isBadInput } from "../../lib/params.js";
import { overview } from "./adminConsole.service.js";

const router = Router();
router.use(requireAuth);

// Every service error code needs an entry here, otherwise it becomes a 500.
const MESSAGES: Record<string, { status: number; message: string }> = {
  NOT_ALLOWED: { status: 403, message: "Only an Admin can open the Admin console." },
};

function fail(res: Response, error: unknown) {
  if (isBadInput(error)) return res.status(400).json({ error: "One of the values sent is not valid." });
  const known = MESSAGES[error instanceof Error ? error.message : ""];
  if (known) return res.status(known.status).json({ error: known.message });
  console.error("Admin console error:", error);
  return res.status(500).json({ error: "Something went wrong" });
}

// Read-only. The service checks the role and limits everything to the companies the Admin acts on.
router.get("/overview", async (req, res) => {
  try {
    res.json(await overview(req.user!.userId));
  } catch (e) {
    fail(res, e);
  }
});

export default router;
