import { Router, type Request, type Response } from "express";
import { requireAuth, requireRole } from "../../middlewares/auth.js";
import { guardUuidParams, isBadInput } from "../../lib/params.js";
import * as cal from "./holidayCalendar.service.js";

const router = Router();
guardUuidParams(router);
router.use(requireAuth);

// Every code a service may throw needs an entry here, or it would become a 500.
const MESSAGES: Record<string, { status: number; message: string }> = {
  FEATURES_NOT_READY: { status: 503, message: "Holiday management is not set up on this server yet. Ask an administrator to finish the database update." },
  NOT_ALLOWED: { status: 403, message: "You do not have permission to do this." },
  NOT_YOUR_COMPANY: { status: 403, message: "That company is not one you manage." },
  NOT_FOUND: { status: 404, message: "That record was not found." },
  USER_NOT_FOUND: { status: 404, message: "Your account was not found." },
  BAD_YEAR: { status: 400, message: "Choose a year between 2020 and 2100." },
  BAD_DATE: { status: 400, message: "That is not a valid date." },
  BAD_KIND: { status: 400, message: "The holiday type must be Fixed or Optional." },
  BAD_ALLOWANCE: { status: 400, message: "The allowance must be a whole number from 0 to 30." },
  BAD_DECISION: { status: 400, message: "Approve or reject." },
  NAME_REQUIRED: { status: 400, message: "The holiday name is required." },
  NAME_TOO_LONG: { status: 400, message: "The holiday name is too long (120 characters at most)." },
  REASON_REQUIRED: { status: 400, message: "Write a short reason (at least 3 characters)." },
  EMPTY_FILE: { status: 400, message: "The file is empty." },
  FILE_TOO_LARGE: { status: 400, message: "The file is larger than 5 MB." },
  NOT_XLSX: { status: 400, message: "That file is not a real .xlsx workbook." },
  UNREADABLE_FILE: { status: 400, message: "The file could not be read. Check it opens normally and try again." },
  NO_ROWS: { status: 400, message: "The file has no rows." },
  TOO_MANY_ROWS: { status: 400, message: "The file has more than 1,000 rows." },
  XLS_NOT_SUPPORTED: { status: 400, message: "Old .xls files cannot be read. Open it in Excel, save it as .xlsx or .csv, and upload that." },
  UNSUPPORTED_FILE: { status: 400, message: "Upload an .xlsx or .csv file." },
  MISSING_COLUMNS: { status: 400, message: "The sheet is missing required columns (Date, Holiday, Status)." },
  CONFIRM_REQUIRED: { status: 400, message: "Please confirm first." },
  NOTHING_TO_IMPORT: { status: 400, message: "There are no valid rows to import." },
  PREVIEW_OUT_OF_DATE: { status: 409, message: "The sheet or the calendar changed since the preview. Preview it again." },
  DRAFT_EXISTS: { status: 409, message: "There is already an unpublished draft for this year. Publish or discard it first, or choose to replace it." },
  NOT_A_DRAFT: { status: 409, message: "That draft was already published or discarded." },
  PAST_CONFIRM_REQUIRED: { status: 409, message: "Some dates are in the past. Publishing changes how those days count in reports. Confirm to continue." },
  ALREADY_EXISTS: { status: 409, message: "That holiday already exists in this calendar." },
  ALREADY_RESTORED: { status: 409, message: "That holiday was already restored." },
  DATE_IN_THE_PAST: { status: 409, message: "A holiday that has already passed cannot be changed or removed (reports have counted it)." },
  DATE_TOO_OLD: { status: 400, message: "That date is too far in the past." },
  BACKDATE_CONFIRM_REQUIRED: { status: 409, message: "That date has passed. Confirm that you understand reports for that day will change." },
  HAS_REQUESTS: { status: 409, message: "People have already asked for or been given this optional holiday. Cancel those requests first." },
  ALLOWANCE_USED: { status: 409, message: "The optional-holiday allowance for this year is already used." },
  ALREADY_REQUESTED: { status: 409, message: "You have already asked for this holiday." },
  NOT_CANCELLABLE: { status: 409, message: "This request can no longer be cancelled." },
  ALREADY_DECIDED: { status: 409, message: "This request was already decided." },
  OWN_REQUEST: { status: 403, message: "You cannot decide your own request." },
};
function fail(res: Response, err: unknown) {
  if (isBadInput(err)) return res.status(400).json({ error: "One of the values sent is not valid." });
  const code = err instanceof Error ? err.message : "UNKNOWN";
  const known = MESSAGES[code];
  if (known) return res.status(known.status).json({ error: known.message, code, ...(code === "PAST_CONFIRM_REQUIRED" ? { count: (err as { count?: number }).count } : {}) });
  console.error("[holiday-calendar]", err);
  return res.status(500).json({ error: "Something went wrong" });
}
const wrap = (fn: (req: Request) => Promise<unknown>) => async (req: Request, res: Response) => {
  try { res.json(await fn(req)); } catch (e) { fail(res, e); }
};
const uid = (req: Request) => req.user!.userId;
const hr = requireRole("HR", "ADMIN");

// ---- everyone signed in ----
router.get("/calendar", wrap((req) => cal.calendarFor(uid(req), req.query.year, req.query.companyId)));
router.get("/upcoming", wrap((req) => cal.upcoming(uid(req), Number(req.query.days) || 90)));
router.post("/optional/:id/request", wrap((req) => cal.requestOptional(uid(req), String(req.params.id))));
router.post("/requests/:id/cancel", wrap((req) => cal.cancelOptional(uid(req), String(req.params.id))));
router.get("/requests", wrap((req) => cal.requestQueue(uid(req))));
router.post("/requests/:id/decide", wrap((req) => cal.decideOptional(uid(req), String(req.params.id), req.body ?? {})));

// ---- HR / Admin ----
router.get("/template", hr, (_req, res) => {
  const csv = "﻿Date,Day,Holiday,Status,Religion\r\n01-Jan-2026,Thursday,New Year,Fixed,General\r\n26-Jan-2026,Monday,Republic Day IN,Fixed,General\r\n19-Mar-2026,Thursday,Gudi Padwa,Optional,Marathi\r\n";
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="holiday-sheet-template.csv"');
  res.send(csv);
});
router.post("/import/preview", hr, wrap((req) => cal.previewSheet(uid(req), req.body ?? {})));
router.post("/import/commit", hr, wrap((req) => cal.commitImport(uid(req), req.body ?? {})));
router.post("/import/:id/publish", hr, wrap((req) => cal.publishDraft(uid(req), String(req.params.id), req.body ?? {})));
router.post("/import/:id/discard", hr, wrap((req) => cal.discardDraft(uid(req), String(req.params.id))));
router.post("/entry", hr, wrap((req) => cal.addEntry(uid(req), req.body ?? {})));
router.post("/entry/:id/edit", hr, wrap((req) => cal.editEntry(uid(req), String(req.params.id), req.body ?? {})));
router.post("/entry/:id/archive", hr, wrap((req) => cal.archiveEntry(uid(req), String(req.params.id))));
router.post("/archive/:id/restore", hr, wrap((req) => cal.restoreEntry(uid(req), String(req.params.id))));
router.get("/policy", hr, wrap((req) => cal.getPolicy(uid(req))));
router.post("/policy", hr, wrap((req) => cal.setPolicy(uid(req), req.body ?? {})));

export default router;
