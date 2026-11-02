import { Router } from "express";
import { requireAuth, requireRole } from "../../middlewares/auth.js";
import * as payroll from "./payroll.service.js";
import { guardUuidParams, isBadInput } from "../../lib/params.js";
import * as generate from "./payroll.generate.js";
import { buildPayslipPdf } from "./payroll.pdf.js";

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
    console.error("[payroll]", err);
    res.status(500).json({ error: "Something went wrong" });
    return;
  }
  const status =
    code === "NOT_ALLOWED" || code === "NOT_YOURS" || code === "NOT_YOUR_COMPANY"
      ? 403
      : code === "NOT_FOUND" || code === "USER_NOT_FOUND" || code === "SLIP_NOT_FOUND"
      ? 404
      : 400;
  res.status(status).json({ error: code });
}

const num = (v: unknown, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

router.use(requireAuth);

// Optional list of team ids. Anything that is not a UUID is a bad request.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function teamIdsOf(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > 200) throw new Error("BAD_TEAMS");
  const ids = v.map(String);
  if (!ids.every((x) => UUID.test(x))) throw new Error("BAD_TEAMS");
  return ids;
}

// --- EMPLOYEE -------------------------------------------------------------
// Anyone can list their own slips. The service decides what they may see.
router.get("/me", async (req, res) => {
  try {
    const year = req.query.year ? Number(req.query.year) : undefined;
    res.json(await payroll.listMySlips(req.user!.userId, year));
  } catch (err) {
    fail(res, err);
  }
});

// Download. Ownership is checked inside the service — a payslip is the most
// sensitive document in the system and must never be reachable by guessing
// an id.
router.get("/:id/download", async (req, res) => {
  try {
    const slip = (await payroll.downloadSlip(
      req.user!.userId,
      String(req.params.id)
    )) as {
      fileName?: string;
      filename?: string;
      contentType?: string;
      mimeType?: string;
      base64?: string;
      data?: string;
      buffer?: Buffer;
    };

    const name = slip.fileName ?? slip.filename ?? "payslip.pdf";
    const type = slip.contentType ?? slip.mimeType ?? "application/octet-stream";
    const body =
      slip.buffer ??
      Buffer.from(String(slip.base64 ?? slip.data ?? ""), "base64");

    // Never cached, never stored by a proxy. A shared office machine must not
    // leave someone's salary in the browser cache.
    res.setHeader("Cache-Control", "no-store, private");
    res.setHeader("Content-Type", type);
    res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
    res.send(body);
  } catch (err) {
    fail(res, err);
  }
});

// The payslip document. Employees get their own once published; HR gets any
// in their company. The service decides, not the router.
router.get("/:id/payslip.pdf", async (req, res) => {
  try {
    const { pdf, fileName } = await buildPayslipPdf(
      req.user!.userId,
      String(req.params.id)
    );
    res.setHeader("Cache-Control", "no-store, private");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.send(pdf);
  } catch (err) {
    fail(res, err);
  }
});


// --- HR / ADMIN -----------------------------------------------------------
router.use(requireRole("HR", "ADMIN"));


// --- GENERATION -----------------------------------------------------------
router.post("/generate", async (req, res) => {
  try {
    const now = new Date();
    res.json(
      await generate.generateMonth(
        req.user!.userId,
        num(req.body?.month, now.getMonth() + 1),
        num(req.body?.year, now.getFullYear()),
        req.body?.platformId ? String(req.body.platformId) : undefined,
        teamIdsOf(req.body?.teamIds)
      )
    );
  } catch (err) {
    fail(res, err);
  }
});

// Department picker: this company's teams.
router.get("/teams", async (req, res) => {
  try {
    res.json(await generate.listPayrollTeams(req.user!.userId));
  } catch (err) {
    fail(res, err);
  }
});

// Undo a release for the chosen departments (or everyone).
router.post("/unrelease", async (req, res) => {
  try {
    const now = new Date();
    res.json(
      await generate.unreleaseMonth(
        req.user!.userId,
        num(req.body?.month, now.getMonth() + 1),
        num(req.body?.year, now.getFullYear()),
        teamIdsOf(req.body?.teamIds)
      )
    );
  } catch (err) {
    fail(res, err);
  }
});

// One click: approve + publish + notify everyone in scope.
router.post("/release", async (req, res) => {
  try {
    const now = new Date();
    res.json(
      await generate.releaseMonth(
        req.user!.userId,
        num(req.body?.month, now.getMonth() + 1),
        num(req.body?.year, now.getFullYear()),
        teamIdsOf(req.body?.teamIds)
      )
    );
  } catch (err) {
    fail(res, err);
  }
});

// The review screen: the slip and the attendance it came from, side by side.
router.get("/:id/review", async (req, res) => {
  try {
    res.json(
      await generate.getSlipWithAttendance(req.user!.userId, String(req.params.id))
    );
  } catch (err) {
    fail(res, err);
  }
});

router.post("/:id/deduction", async (req, res) => {
  try {
    res.json(
      await generate.setOtherDeduction(
        req.user!.userId,
        String(req.params.id),
        num(req.body?.amount, 0),
        String(req.body?.note ?? "")
      )
    );
  } catch (err) {
    fail(res, err);
  }
});

router.post("/approve", async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.slipIds) ? req.body.slipIds : [];
    res.json(await generate.approveSlips(req.user!.userId, ids.map(String)));
  } catch (err) {
    fail(res, err);
  }
});

router.get("/month", async (req, res) => {
  try {
    const now = new Date();
    res.json(
      await payroll.listSlipsForMonth(
        req.user!.userId,
        num(req.query.month, now.getMonth() + 1),
        num(req.query.year, now.getFullYear())
      )
    );
  } catch (err) {
    fail(res, err);
  }
});

router.post("/upload", async (req, res) => {
  try {
    res.json(await payroll.uploadSlip(req.user!.userId, req.body ?? {}));
  } catch (err) {
    fail(res, err);
  }
});

// Publish or unpublish a chosen set. Publishing is what makes a slip visible
// to the employee, so it is a separate, deliberate action from uploading.
router.post("/publish", async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.slipIds) ? req.body.slipIds : [];
    const publish = req.body?.publish !== false;
    res.json(
      await payroll.publishSlips(req.user!.userId, ids.map(String), publish)
    );
  } catch (err) {
    fail(res, err);
  }
});

router.post("/publish-month", async (req, res) => {
  try {
    const now = new Date();
    res.json(
      await payroll.publishMonth(
        req.user!.userId,
        num(req.body?.month, now.getMonth() + 1),
        num(req.body?.year, now.getFullYear())
      )
    );
  } catch (err) {
    fail(res, err);
  }
});

// Both verbs, so the frontend needs nothing beyond apiGet/apiPost.
router.post("/:id/delete", async (req, res) => {
  try {
    res.json(await payroll.deleteSlip(req.user!.userId, String(req.params.id)));
  } catch (err) {
    fail(res, err);
  }
});

router.delete("/:id", async (req, res) => {
  try {
    res.json(await payroll.deleteSlip(req.user!.userId, String(req.params.id)));
  } catch (err) {
    fail(res, err);
  }
});

export default router;