// ===========================================================================
// ADMIN ROUTES
//
// Two jobs only: check the caller is allowed in, and turn a thrown error
// code into an HTTP status with wording a human can act on. All the thinking
// lives in the service.
//
// requireRole runs on the whole router rather than route by route. One line
// that cannot be forgotten on a new endpoint beats sixteen that can.
// ===========================================================================

import { Router } from "express";
import { requireAuth, requireRole } from "../../middlewares/auth.js";
import * as admin from "./admin.service.js";
import * as importer from "./employeeImport.service.js";
import * as updater from "./employeeUpdate.service.js";
import * as editor from "./employeeEdit.service.js";
import * as companyAdmin from "./companyAdmin.service.js";
import { guardUuidParams, isBadInput, isUuid } from "../../lib/params.js";
import { accessFor, assertCompany } from "../../lib/companyAccess.js";
import { peekEmployeeCode } from "./employeeCode.js";
import { parseFilters } from "../hr-filters/hrFilters.logic.js";

const router = Router();
guardUuidParams(router);

router.use(requireAuth, requireRole("ADMIN", "HR"));

const MESSAGES: Record<string, { status: number; message: string }> = {
  NOT_FOUND: { status: 404, message: "Not found, or not part of your platform." },
  TEAM_NOT_FOUND: { status: 404, message: "That team doesn't exist on your platform." },
  MISSING_FIELDS: { status: 400, message: "Please fill in all the required fields." },
  EMAIL_TAKEN: { status: 409, message: "Someone on this platform already uses that email." },
  ROLE_NOT_ALLOWED: { status: 403, message: "Only an Admin can create or change HR and Admin accounts." },
  WEAK_PASSWORD: { status: 400, message: "The password must be at least 8 characters." },
  BAD_DATE: { status: 400, message: "Dates must be in YYYY-MM-DD format." },
  BAD_RANGE: { status: 400, message: "The end date cannot be before the start date." },
  RANGE_TOO_LONG: { status: 400, message: "Mark at most 120 days of leave at a time." },
  NO_WORKING_DAYS: { status: 400, message: "A shift needs at least one working day." },
  // employee import
  EMPTY_FILE: { status: 400, message: "That file is empty." },
  FILE_TOO_LARGE: { status: 413, message: "That file is larger than 5 MB." },
  UNSUPPORTED_FILE: { status: 400, message: "Upload an .xlsx or .csv file." },
  NOT_XLSX: { status: 400, message: "That file is not a real .xlsx workbook, whatever its name says." },
  UNREADABLE_FILE: { status: 400, message: "That workbook could not be read. Is it damaged or password protected?" },
  NO_HEADER_ROW: { status: 400, message: "Could not find a heading row (Full name, Employee ID, Company...). Check the first sheet." },
  NO_ROWS: { status: 400, message: "There are no employee rows in that file." },
  TOO_MANY_ROWS: { status: 400, message: "Import at most 2,000 employees at a time." },
  CONFIRM_REQUIRED: { status: 400, message: "Please confirm the import first." },
  NOTHING_TO_IMPORT: { status: 400, message: "No valid rows to import. Fix the errors shown in the preview." },
  PREVIEW_CHANGED: { status: 409, message: "The data changed since you reviewed it. Review the preview again, then import." },
  NOTHING_TO_UPDATE: { status: 400, message: "Nothing to update. There are no changes selected." },
  UPDATE_FAILED: { status: 500, message: "The update failed and was rolled back. Nothing was changed. Please review and try again." },
  IMPORT_FAILED: { status: 500, message: "The import failed and was rolled back. Nothing was saved. Please review and try again." },
  MANAGER_UNRESOLVED: { status: 500, message: "A reporting manager could not be linked. Nothing was saved." },
  // employee edit, IDs, designations, company access
  EMPLOYEE_CODE_LOCKED: { status: 403, message: "An employee ID never changes." },
  EMPLOYEE_CODE_ADMIN_ONLY: { status: 403, message: "Employee IDs are generated automatically. Only an Admin can enter one by hand." },
  CODE_TAKEN: { status: 409, message: "That employee ID is already in use." },
  CODE_ALLOCATION_FAILED: { status: 500, message: "Could not allocate an employee ID. Nothing was saved. Please try again." },
  COMPANY_TRANSFER_NOT_SUPPORTED: { status: 400, message: "A person's company cannot be changed here, because their attendance, tasks and leave belong to it." },
  DUPLICATE_PERSON: { status: 409, message: "Someone with this name already works in this company. If this is a different person, confirm it and save again." },
  BAD_EMAIL: { status: 400, message: "Enter a valid email address." },
  BAD_SALARY: { status: 400, message: "Salary must be a number from 0 to 10,000,000." },
  SALARY_NOT_ALLOWED: { status: 403, message: "Only an Admin or top management can change a salary." },
  SALARY_OVERWRITE_NEEDS_CONFIRM: { status: 409, message: "This person already has a salary. Confirm that you want to replace it." },
  DESIGNATION_OVERWRITE_NEEDS_CONFIRM: { status: 409, message: "This person already has a designation. Confirm that you want to replace it." },
  DESIGNATION_NOT_IN_LIST: { status: 400, message: "Pick a designation from the list. Designations are the same for every company; a new one has to be added by a developer." },
  DESIGNATION_EXISTS: { status: 409, message: "That designation already exists in this company." },
  BAD_NAME: { status: 400, message: "A name must be 2 to 80 characters." },
  BAD_MANAGER: { status: 400, message: "Pick an active manager or admin of the same company, other than the person themselves." },
  MANAGER_WRONG_ROLE: { status: 400, message: "An employee must report to a Manager, and a Manager must report to an Admin." },
  MANAGER_CYCLE: { status: 400, message: "That would make two people report to each other." },
  BAD_EMPLOYMENT_TYPE: { status: 400, message: "Pick a valid employee type." },
  FEATURES_NOT_READY: { status: 503, message: "This feature is not set up on this server yet. Ask an administrator to finish the database update." },
  ACCESS_NOT_ALLOWED: { status: 403, message: "Only an Admin or top management can change which companies a person can act on (Admins: HR users only, never the all-companies option), and nobody can change their own." },
  ACCESS_ONLY_HR_ADMIN: { status: 400, message: "Company access can only be given to HR and Admin accounts." },
  NOTHING_TO_UPDATE_DESIGNATION: { status: 400, message: "Nothing to update." },
};

function fail(res: any, error: unknown) {
  if (isBadInput(error)) {
    res.status(400).json({ error: "One of the values sent is not valid." });
    return;
  }
  const code = error instanceof Error ? error.message : "UNKNOWN";

  const mapped = MESSAGES[code];
  if (mapped) return res.status(mapped.status).json({ error: mapped.message });

  // Prisma's unique-constraint error (e.g. two teams or shifts with one name
  // on the same platform) is the user's mistake, not a server fault.
  if ((error as { code?: string } | null)?.code === "P2002") {
    return res.status(409).json({ error: "That name is already in use." });
  }

  // Codes that carry the offending field, e.g. BAD_TIME:startTime
  if (code.startsWith("BAD_TIME:")) {
    return res
      .status(400)
      .json({ error: `${code.split(":")[1]} must be a 24-hour time like 09:30.` });
  }
  if (code.startsWith("BAD_NUMBER:")) {
    return res.status(400).json({ error: `${code.split(":")[1]} isn't a valid number.` });
  }

  console.error("[admin]", error);
  return res.status(500).json({ error: "Something went wrong." });
}

const id = (v: unknown) => String(v);

// --- options ---------------------------------------------------------------

router.get("/options", async (req, res) => {
  try {
    res.json(await admin.getAdminOptions(req.user!.userId));
  } catch (e) {
    fail(res, e);
  }
});

// --- add / import employees -------------------------------------------------
// One pipeline for the single form and the spreadsheet import. The router-level
// guard above already limits all of it to HR and Admin.

// The next employee ID for a company, for the Add Employee form. Read only; only companies this person may act on.
router.get("/employees/next-id", async (req, res) => {
  try {
    const companyId = String(req.query.companyId ?? "");
    if (!isUuid(companyId)) {
      res.status(400).json({ error: "One of the values sent is not valid." });
      return;
    }
    assertCompany(await accessFor(req.user!.userId), companyId);
    res.json({ code: await peekEmployeeCode(companyId) });
  } catch (e) {
    fail(res, e);
  }
});

router.get("/employees/lookups", async (req, res) => {
  try {
    res.json(await importer.employeeLookups(req.user!.userId));
  } catch (e) {
    fail(res, e);
  }
});

router.get("/employees/template", (_req, res) => {
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="employee-import-template.csv"');
  res.send(importer.importTemplateCsv());
});

router.post("/employees/parse", async (req, res) => {
  try {
    res.json(
      await importer.parseEmployeeFile({
        fileName: String(req.body?.fileName ?? ""),
        contentBase64: String(req.body?.contentBase64 ?? ""),
        sheetName: req.body?.sheetName ? String(req.body.sheetName) : undefined,
      })
    );
  } catch (e) {
    fail(res, e);
  }
});

router.post("/employees/preview", async (req, res) => {
  try {
    res.json(await importer.previewEmployees(req.user!.userId, req.body ?? {}));
  } catch (e) {
    fail(res, e);
  }
});

router.post("/employees/update/preview", async (req, res) => {
  try {
    res.json(await updater.previewUpdate(req.user!.userId, req.body ?? {}));
  } catch (e) {
    fail(res, e);
  }
});

router.post("/employees/update/commit", async (req, res) => {
  try {
    res.json(await updater.commitUpdate(req.user!.userId, req.body ?? {}));
  } catch (e) {
    fail(res, e);
  }
});

router.post("/employees/commit", async (req, res) => {
  try {
    res.status(201).json(await importer.commitEmployees(req.user!.userId, req.body ?? {}));
  } catch (e) {
    fail(res, e);
  }
});

// --- people ----------------------------------------------------------------

// Edit Employee: the companies you may pick from, one person's edit model (details + permissions + dropdowns of THEIR company), and
// the dropdown choices of a company. Fixed paths first so they are never read as an :id.
router.get("/employees/companies", async (req, res) => {
  try {
    res.json(await editor.companiesFor(req.user!.userId));
  } catch (e) {
    fail(res, e);
  }
});
router.get("/employees/dropdowns", async (req, res) => {
  try {
    res.json(await editor.dropdownsFor(req.user!.userId, String(req.query.companyId ?? "")));
  } catch (e) {
    fail(res, e);
  }
});
router.get("/employees/:id/edit", async (req, res) => {
  try {
    res.json(await editor.editModel(req.user!.userId, id(req.params.id)));
  } catch (e) {
    fail(res, e);
  }
});

// Designation lists (one per company) and company access (top management only).
router.get("/designations", async (req, res) => {
  try {
    res.json(await companyAdmin.listDesignations(req.user!.userId, req.query.companyId ? String(req.query.companyId) : undefined));
  } catch (e) {
    fail(res, e);
  }
});
router.post("/designations", async (req, res) => {
  try {
    res.status(201).json(await companyAdmin.addDesignation(req.user!.userId, req.body ?? {}));
  } catch (e) {
    fail(res, e);
  }
});
router.patch("/designations/:id", async (req, res) => {
  try {
    res.json(await companyAdmin.updateDesignation(req.user!.userId, id(req.params.id), req.body ?? {}));
  } catch (e) {
    fail(res, e);
  }
});
router.get("/company-access", async (req, res) => {
  try {
    res.json(await companyAdmin.listAccess(req.user!.userId));
  } catch (e) {
    fail(res, e);
  }
});
// PUT is the proper verb; POST does the same so the browser's plain post helper can call it.
for (const verb of ["put", "post"] as const) {
  router[verb]("/company-access/:userId", async (req, res) => {
    try {
      res.json(await companyAdmin.setAccess(req.user!.userId, id(req.params.userId), req.body ?? {}));
    } catch (e) {
      fail(res, e);
    }
  });
}

router.get("/users", async (req, res) => {
  try {
    // project, reporting manager and designation come from the shared HR filters (company, role, status and search keep their own parameters)
    const f = parseFilters(req.query as Record<string, unknown>);
    const [users, orgTotal] = await Promise.all([
      admin.listUsers(req.user!.userId, {
        search: req.query.search ? String(req.query.search) : undefined,
        role: req.query.role ? String(req.query.role) : undefined,
        status: req.query.status ? String(req.query.status) : undefined,
        companyId: req.query.companyId ? String(req.query.companyId) : undefined,
        projectIds: f.projectIds,
        managerIds: f.managerIds,
        designation: f.designation ?? undefined,
      }),
      admin.peopleScopeCount(req.user!.userId),
    ]);
    res.json({ users, scope: { orgTotal, filteredTotal: users.length } });
  } catch (e) {
    fail(res, e);
  }
});

router.post("/users", async (req, res) => {
  try {
    const user = await admin.createUser(req.user!.userId, req.body ?? {});
    res.status(201).json({ user });
  } catch (e) {
    fail(res, e);
  }
});

router.patch("/users/:id", async (req, res) => {
  try {
    const out = await editor.updateEmployee(req.user!.userId, id(req.params.id), req.body ?? {});
    res.json({ ok: true, changed: out.changed });
  } catch (e) {
    fail(res, e);
  }
});

router.post("/users/:id/password", async (req, res) => {
  try {
    const password = String(req.body?.password ?? "");
    res.json(await admin.resetPassword(req.user!.userId, id(req.params.id), password));
  } catch (e) {
    fail(res, e);
  }
});

// --- teams -----------------------------------------------------------------

router.get("/teams", async (req, res) => {
  try {
    res.json({ teams: await admin.listTeams(req.user!.userId) });
  } catch (e) {
    fail(res, e);
  }
});

router.post("/teams", async (req, res) => {
  try {
    const team = await admin.createTeam(req.user!.userId, req.body ?? {});
    res.status(201).json({ team });
  } catch (e) {
    fail(res, e);
  }
});

router.patch("/teams/:id", async (req, res) => {
  try {
    await admin.updateTeam(req.user!.userId, id(req.params.id), req.body ?? {});
    res.json({ ok: true });
  } catch (e) {
    fail(res, e);
  }
});

router.post("/teams/:id/members", async (req, res) => {
  try {
    const userId = String(req.body?.userId ?? "");
    res.json(await admin.addTeamMember(req.user!.userId, id(req.params.id), userId));
  } catch (e) {
    fail(res, e);
  }
});

router.delete("/teams/:id/members/:userId", async (req, res) => {
  try {
    res.json(
      await admin.removeTeamMember(
        req.user!.userId,
        id(req.params.id),
        id(req.params.userId)
      )
    );
  } catch (e) {
    fail(res, e);
  }
});

// --- shifts ----------------------------------------------------------------

router.get("/shifts", async (req, res) => {
  try {
    res.json({ shifts: await admin.listShifts(req.user!.userId) });
  } catch (e) {
    fail(res, e);
  }
});

// Shifts and alert thresholds are organization-wide rules: only an Admin may change them (HR can still read them to assign people).
router.post("/shifts", requireRole("ADMIN"), async (req, res) => {
  try {
    const shift = await admin.createShift(req.user!.userId, req.body ?? {});
    res.status(201).json({ shift });
  } catch (e) {
    fail(res, e);
  }
});

router.patch("/shifts/:id", requireRole("ADMIN"), async (req, res) => {
  try {
    await admin.updateShift(req.user!.userId, id(req.params.id), req.body ?? {});
    res.json({ ok: true });
  } catch (e) {
    fail(res, e);
  }
});

// --- thresholds ------------------------------------------------------------

router.patch("/config/:teamId", requireRole("ADMIN"), async (req, res) => {
  try {
    const config = await admin.updateTeamConfig(
      req.user!.userId,
      id(req.params.teamId),
      req.body ?? {}
    );
    res.json({ config });
  } catch (e) {
    fail(res, e);
  }
});

// --- leave -----------------------------------------------------------------

router.get("/leave", async (req, res) => {
  try {
    const now = new Date().toISOString().slice(0, 10);
    const from = String(req.query.from ?? `${now.slice(0, 7)}-01`);
    const to = String(req.query.to ?? now);
    res.json({ leave: await admin.listLeave(req.user!.userId, from, to) });
  } catch (e) {
    fail(res, e);
  }
});

router.post("/leave", async (req, res) => {
  try {
    res.status(201).json(await admin.markLeave(req.user!.userId, req.body ?? {}));
  } catch (e) {
    fail(res, e);
  }
});

router.delete("/leave", async (req, res) => {
  try {
    const userId = String(req.query.userId ?? "");
    const date = String(req.query.date ?? "");
    res.json(await admin.unmarkLeave(req.user!.userId, userId, date));
  } catch (e) {
    fail(res, e);
  }
});

export default router;