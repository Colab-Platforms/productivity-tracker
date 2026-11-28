// ===========================================================================
// UPDATE EXISTING EMPLOYEES FROM A SHEET
//
// For people who are already in the system: fill in what is missing (reporting
// manager, team, role, shift, joining date, mobile, email, designation) from
// the same Excel/CSV layout the import uses.
//
// The rules, in plain words:
//   - People are matched by Employee ID. Names and IDs are NEVER changed by an
//     update; a name that differs is only noted.
//   - A BLANK cell in the sheet means "leave as it is", never "erase".
//   - A field that is empty in the system is FILLED.
//   - A field that already has a different value is a CONFLICT. It is left
//     alone unless HR ticks that exact person + field to overwrite it.
//   - preview writes nothing. commit re-validates, then applies everything in
//     ONE transaction (all rows or none) and writes an audit entry per person
//     recording what changed from what.
//   - Same company isolation and role limits as adding people: HR can only
//     touch their own company, and only an Admin can grant or alter HR/Admin.
// ===========================================================================

import { prisma } from "../../lib/prisma.js";
import { canAccess } from "../../lib/companyAccess.logic.js";
import {
  dayLabel,
  dayNumbers,
  EMAIL_RE,
  hhmm,
  loadViewer,
  normName,
  parseJoinDate,
  parseTime,
  text,
  validMobile,
  type Cell,
  type Issue,
  type ImportField,
  type ImportOptions,
  type Mapping,
  type ParsedRow,
  type Viewer,
} from "./employeeImport.service.js";
import { canonicalDesignation } from "../../lib/designations.js";
import { checkPersonal, compare as comparePersonal, LABEL as PERSONAL_LABEL, PERSONAL_FIELDS, SENSITIVE, type PersonalField, type PersonalValues } from "../personal/personal.logic.js";
import { currentFor, personalReady } from "../personal/personal.service.js";
import { platformToday } from "../../lib/dates.js";
import { linkedManagerIdsOf, linksReady } from "../../lib/reportingLinks.js";

export type UpdateField = "employmentType" | "secondaryManager" | "email" | "mobile" | "designation" | "role" | "team" | "projects" | "reportsTo" | "dateOfJoining" | "shift" | PersonalField;
const LABEL: Record<UpdateField, string> = {
  email: "Work email", mobile: "Mobile number", designation: "Designation", role: "System role", team: "Team",
  projects: "Projects", reportsTo: "Reports to", dateOfJoining: "Date of joining", shift: "Shift", employmentType: "Employee type", secondaryManager: "Secondary manager",
  ...PERSONAL_LABEL,
};

export type Change = { field: UpdateField; label: string; current: string; proposed: string; kind: "fill" | "conflict"; applied: boolean };
export type UpdateStatus = "UPDATE" | "NO_CHANGE" | "INVALID" | "SKIPPED";
export type UpdateRow = {
  rowNumber: number;
  status: UpdateStatus;
  skipReason?: string;
  employeeId: string;
  name: string;
  company: string;
  changes: Change[];
  issues: Issue[];
  notes: string[];
};

export type UpdateInput = {
  rows: ParsedRow[];
  mapping: Mapping;
  options?: ImportOptions;
  // rowNumber -> the fields HR ticked to OVERWRITE an existing different value
  overwrite?: Record<string, string[]>;
};

const MAX_ROWS = 2000;
const ROLE_MAP: Record<string, "EMPLOYEE" | "MANAGER" | "HR" | "ADMIN"> = {
  employee: "EMPLOYEE", manager: "MANAGER", hr: "HR", humanresources: "HR", admin: "ADMIN", administrator: "ADMIN",
};
const isoDay = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : "");
const dmy = (iso: string) => (iso ? iso.split("-").reverse().join("-") : "");
const digits = (s: string) => s.replace(/\D/g, "");

type Apply = {
  email?: string;
  phone?: string;
  designation?: string;
  role?: "EMPLOYEE" | "MANAGER" | "HR" | "ADMIN";
  dateOfJoining?: string;
  shift?: { start: string; end: string; days: number[]; shiftId: string | null };
  reportsToId?: string | null;
  teamId?: string;
  projectIds?: string[];
  personal?: PersonalValues;
  employmentType?: string;
  secondaryManagerId?: string;
};

type Work = { row: UpdateRow; userId: string | null; platformId: string | null; platformName: string; apply: Apply; before: Record<string, string> };

async function runUpdateValidation(viewer: Viewer, input: UpdateInput) {
  const options = input.options ?? {};
  const mapping = input.mapping ?? {};
  if (input.rows !== undefined && input.rows !== null && !Array.isArray(input.rows)) throw new Error("NO_ROWS");
  const rows = input.rows ?? [];
  if (rows.length === 0) throw new Error("NO_ROWS");
  if (rows.length > MAX_ROWS) throw new Error("TOO_MANY_ROWS");

  const get = (r: ParsedRow, f: ImportField): Cell | undefined => {
    const idx = mapping[f];
    return idx === null || idx === undefined ? undefined : r.cells[idx];
  };

  const getX = (r: ParsedRow, f: string): Cell | undefined => {
    const idx = (mapping as Record<string, number | null | undefined>)[f];
    return idx === null || idx === undefined ? undefined : r.cells[idx];
  };
  const live = rows.filter((r) => !r.skip);

  // A row with a BLANK Employee ID is looked up by work email, or else by exact name, among the people this viewer may act on. Only ONE match is accepted
  // (two people with the same name, or an email and a name that point at different people, are refused); the existing Employee ID is then used as if it had
  // been typed, and the preview says how it was found. Nothing is ever created from a name.
  const loose = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, "");
  const resolvedCode = new Map<number, string>();
  const resolveNote = new Map<number, string>();
  const resolveError = new Map<number, string>();
  // An ID typed in the sheet that NO account has (for example an old username such as "vishwaa_avatar") is treated like a blank one: the person is looked up by
  // email or exact name and their real HRMS ID is used. An ID that DOES exist is never second-guessed (it is used as typed).
  const typedIds = Array.from(new Set(live.map((r) => text(get(r, "employeeId")).trim()).filter(Boolean)));
  const existingIds = new Set(
    typedIds.length
      ? (await prisma.user.findMany({ where: { OR: typedIds.map((c) => ({ employeeCode: { equals: c, mode: "insensitive" as const } })) }, select: { employeeCode: true } })).map((u) => String(u.employeeCode).toLowerCase())
      : []
  );
  const typedOf = (r: ParsedRow) => text(get(r, "employeeId")).trim();
  const blankRows = live.filter((r) => typedOf(r) === "" || !existingIds.has(typedOf(r).toLowerCase()));
  const why = (r: ParsedRow) => (typedOf(r) === "" ? "Employee ID was blank" : "The ID \"" + typedOf(r) + "\" in the sheet is not an HRMS ID");
  if (blankRows.length) {
    const pool = await prisma.user.findMany({
      where: { ...(viewer.access.all ? {} : { platformId: { in: viewer.access.ids } }), role: { not: "ADMIN" }, employeeCode: { not: null } },
      select: { employeeCode: true, firstName: true, lastName: true, email: true, platformId: true, platform: { select: { name: true } } },
    });
    for (const r of blankRows) {
      const company = text(get(r, "company")).trim();
      const inCompany = (u: (typeof pool)[number]) => !company || loose(company) === loose(u.platform.name);
      const email = text(get(r, "email")).trim().toLowerCase();
      const name = text(get(r, "fullName")).trim();
      const byEmail = email ? pool.filter((u) => String(u.email).toLowerCase() === email && inCompany(u)) : [];
      const byName = name ? pool.filter((u) => loose(`${u.firstName}${u.lastName}`) === loose(name) && inCompany(u)) : [];
      if (!email && !name) { resolveError.set(r.rowNumber, "Employee ID is required: it is how the person is found. (No name or email on this row to look them up by.)"); continue; }
      if (byEmail.length === 1 && (byName.length === 0 || byName.some((u) => u.employeeCode === byEmail[0].employeeCode))) {
        resolvedCode.set(r.rowNumber, byEmail[0].employeeCode!);
        resolveNote.set(r.rowNumber, `${why(r)}: found by work email, existing ID ${byEmail[0].employeeCode} used.`);
      } else if (byEmail.length === 1 && byName.length > 0) {
        resolveError.set(r.rowNumber, `The email belongs to ${byEmail[0].employeeCode} but the name matches ${byName.map((u) => u.employeeCode).join(", ")}. Fill in the Employee ID to say which person this is.`);
      } else if (byName.length === 1) {
        resolvedCode.set(r.rowNumber, byName[0].employeeCode!);
        resolveNote.set(r.rowNumber, `${why(r)}: matched by exact name, existing ID ${byName[0].employeeCode} used. Check it is the right person.`);
      } else if (byName.length > 1) {
        resolveError.set(r.rowNumber, `More than one person is called "${name}" (${byName.map((u) => u.employeeCode).join(", ")}). Fill in the Employee ID.`);
      } else {
        resolveError.set(r.rowNumber, `${why(r)} and no existing employee matches ${email ? `the email ${email}` : `the name "${name}"`}. Fill in the Employee ID (to add a new person use Import Employees).`);
      }
    }
  }
  const idOf = (r: ParsedRow) => resolvedCode.get(r.rowNumber) ?? text(get(r, "employeeId")).trim();
  const codes = Array.from(new Set(live.map((r) => idOf(r)).filter(Boolean)));

  // --- one batch of reads, joined in memory --------------------------------------
  const found = codes.length
    ? await prisma.user.findMany({
        where: { OR: codes.map((c) => ({ employeeCode: { equals: c, mode: "insensitive" as const } })) },
        include: {
          shift: { select: { startTime: true, endTime: true, workingDays: true } },
          teamMemberships: { where: { isActive: true }, select: { teamId: true, isPrimary: true } },
          platform: { select: { name: true, timezone: true } },
        },
      })
    : [];
  const platformIds = Array.from(new Set(found.map((u) => u.platformId)));
  const crossManagers = (
    await prisma.user.findMany({
      where: { ...(viewer.access.all ? {} : { platformId: { in: viewer.access.ids } }), role: { in: ["MANAGER", "ADMIN"] }, status: "ACTIVE", employeeCode: { not: null } },
      select: { id: true, platformId: true, employeeCode: true, firstName: true, lastName: true, role: true, status: true, platform: { select: { name: true } } },
    })
  ).map((x) => ({ ...x, platformName: x.platform.name }));
  const [people, teams, shifts] = await Promise.all([
    platformIds.length
      ? prisma.user.findMany({
          where: { platformId: { in: platformIds } },
          select: { id: true, platformId: true, employeeCode: true, firstName: true, lastName: true, email: true, role: true, status: true, reportsToId: true },
        })
      : Promise.resolve([]),
    prisma.team.findMany({ where: { isActive: true }, select: { id: true, platformId: true, name: true } }),
    prisma.shift.findMany({ where: { isActive: true }, select: { id: true, platformId: true, startTime: true, endTime: true, workingDays: true } }),
  ]);

  const personalNow = await currentFor(found.map((u) => u.id));
  const personalIsReady = await personalReady();
  const typeNow = new Map<string, string>();
  try { for (const t of await prisma.employeeProfile.findMany({ where: { userId: { in: found.map((u) => u.id) } }, select: { userId: true, employmentType: true } })) typeNow.set(t.userId, String(t.employmentType)); } catch { /* table missing: nobody has a type yet */ }
  const linksOk = await linksReady();
  const linksNow = linksOk ? await linkedManagerIdsOf(found.map((u) => u.id)) : new Map<string, string[]>();
  const byCode = new Map(found.map((u) => [String(u.employeeCode ?? "").toLowerCase(), u]));
  const personById = new Map<string, { firstName: string; lastName: string; employeeCode: string | null }>([...crossManagers.map((p) => [p.id, p] as const), ...people.map((p) => [p.id, p] as const)]);
  const personByCode = new Map(people.map((p) => [`${p.platformId}|${String(p.employeeCode ?? "").toLowerCase()}`, p]));
  const personName = (id: string | null) => {
    const p = id ? personById.get(id) : null;
    return p ? `${p.firstName} ${p.lastName}`.trim() + (p.employeeCode ? ` (${p.employeeCode})` : "") : "";
  };

  const work: Work[] = [];
  const seenCodes = new Map<string, number[]>();

  for (const r of rows) {
    const issues: Issue[] = [];
    const notes: string[] = [];
    const changes: Change[] = [];
    const apply: Apply = {};
    const before: Record<string, string> = {};
    const err = (field: Issue["field"], code: string, message: string) => issues.push({ field, severity: "error", code, message });
    const chosen = new Set(input.overwrite?.[String(r.rowNumber)] ?? []);

    const row: UpdateRow = { rowNumber: r.rowNumber, status: "NO_CHANGE", employeeId: idOf(r), name: text(get(r, "fullName")).trim(), company: text(get(r, "company")).trim(), changes, issues, notes };
    const w: Work = { row, userId: null, platformId: null, platformName: "", apply, before };
    work.push(w);

    if (r.skip) {
      row.status = "SKIPPED";
      row.skipReason = r.skip === "example" ? "Example row - never used" : r.skip === "blank" ? "Empty row" : "Not an employee (no name or ID) - treated as a note";
      continue;
    }

    const code = row.employeeId;
    if (!code) {
      err("employeeId", "REQUIRED", resolveError.get(r.rowNumber) ?? "Employee ID is required: it is how the person is found.");
      row.status = "INVALID";
      continue;
    }
    seenCodes.set(code.toLowerCase(), [...(seenCodes.get(code.toLowerCase()) ?? []), r.rowNumber]);

    const user = byCode.get(code.toLowerCase());
    if (!user) {
      err("employeeId", "NOT_FOUND", resolveError.get(r.rowNumber) ?? `No employee has the ID ${code}. To add a new person use Import Employees.`);
      row.status = "INVALID";
      continue;
    }
    if (resolveNote.has(r.rowNumber)) notes.push(resolveNote.get(r.rowNumber)!);
    w.userId = user.id;
    w.platformId = user.platformId;
    w.platformName = user.platform.name;
    row.name = `${user.firstName} ${user.lastName}`.trim();
    row.company = user.platform.name;

    if (!canAccess(viewer.access, user.platformId)) {
      err("employeeId", "OUTSIDE_YOUR_COMPANY", "This person belongs to a company you cannot act on.");
      row.status = "INVALID";
      continue;
    }
    const sheetCompany = text(get(r, "company")).trim();
    if (sheetCompany && normName(sheetCompany) !== normName(user.platform.name)) {
      err("company", "COMPANY_MISMATCH", `${code} belongs to ${user.platform.name}, not "${sheetCompany}".`);
    }
    const sheetName = text(get(r, "fullName")).trim();
    if (sheetName && normName(sheetName) !== normName(`${user.firstName} ${user.lastName}`)) {
      notes.push(`The sheet says "${sheetName}"; the system has "${row.name}". Names are never changed by an update.`);
    }

    // Fields only an Admin may change (role, team, projects, reporting lines, secondary manager). When HR uploads a sheet that names them, that part is SKIPPED with a
    // visible note and the rest of the row is still saved. HR never applies them.
    const skipAdminOnly = (what: string, detail = "") => notes.push(`${what} was NOT changed: only an Admin can change it${detail ? ` (${detail})` : ""}. Everything else on this row is saved; an Admin can apply this part.`);

    // a helper that records one proposed change
    const propose = (field: UpdateField, current: string, proposed: string, blank: boolean, fieldChosen = chosen.has(field)) => {
      before[field] = current;
      const kind: Change["kind"] = blank ? "fill" : "conflict";
      changes.push({ field, label: LABEL[field], current, proposed, kind, applied: kind === "fill" || fieldChosen });
    };

    // --- email -----------------------------------------------------------------
    const email = text(get(r, "email")).trim().toLowerCase();
    if (email) {
      if (!EMAIL_RE.test(email) || email.length > 254) err("email", "BAD_EMAIL", `"${email}" is not a valid email address.`);
      else if (email !== String(user.email).toLowerCase()) {
        if (people.some((p) => p.platformId === user.platformId && p.id !== user.id && String(p.email).toLowerCase() === email)) {
          err("email", "EMAIL_TAKEN", `${email} is already used by someone else in ${user.platform.name}.`);
        } else {
          apply.email = email;
          propose("email", user.email, email, !user.email || String(user.email).endsWith(".local"));
        }
      }
    }

    // --- mobile ----------------------------------------------------------------
    const mobile = text(get(r, "mobile")).trim();
    if (mobile) {
      if (!validMobile(mobile)) err("mobile", "BAD_MOBILE", `"${mobile}" is not a valid mobile number (10 to 15 digits, optional +).`);
      else if (digits(mobile) !== digits(user.phone ?? "")) {
        apply.phone = mobile;
        propose("mobile", user.phone ?? "", mobile, !user.phone);
      }
    }

    // --- designation -----------------------------------------------------------
    const designationText = text(get(r, "designation")).trim();
    if (designationText) {
      const designation = canonicalDesignation(designationText);
      if (!designation) err("designation", "NOT_IN_LIST", `"${designationText}" is not in the designation list. Use one of the listed designations.`);
      else if (designation !== (user.designation ?? "").trim()) {
        apply.designation = designation;
        propose("designation", user.designation ?? "", designation, !(user.designation ?? "").trim());
      }
    }

    // --- role ------------------------------------------------------------------
    const roleText = text(get(r, "role")).trim();
    if (roleText) {
      const role = ROLE_MAP[roleText.toLowerCase().replace(/[^a-z]/g, "")];
      if (!role) err("role", "BAD_ROLE", `"${roleText}" is not a role. Use Employee, Manager, HR or Admin.`);
      else if (role !== String(user.role)) {
        if (viewer.role !== "ADMIN") {
          skipAdminOnly("System role");
        } else {
          apply.role = role;
          // Everyone starts as Employee, so Employee counts as "not set yet".
          propose("role", String(user.role), role, user.role === "EMPLOYEE");
        }
      }
    }

    // --- team and projects ---------------------------------------------------------
    const teamIn = (name: string) => teams.find((t) => t.platformId === user.platformId && normName(t.name) === normName(name));
    const primary = user.teamMemberships.find((m) => m.isPrimary);
    const teamText = text(get(r, "team")).trim();
    if (teamText && viewer.role !== "ADMIN") skipAdminOnly("Team");
    else if (teamText) {
      const t = teamIn(teamText);
      if (!t) err("team", "UNKNOWN_TEAM", `"${teamText}" is not a team in ${user.platform.name}. Create it in Admin → Teams first.`);
      else if (!primary || primary.teamId !== t.id) {
        apply.teamId = t.id;
        const cur = primary ? (teams.find((x) => x.id === primary.teamId)?.name ?? "") : "";
        propose("team", cur, t.name, !primary);
      }
    }
    const projectText = text(get(r, "projects")).trim();
    if (projectText && viewer.role !== "ADMIN") skipAdminOnly("Projects");
    else if (projectText) {
      const add: string[] = [];
      const names: string[] = [];
      for (const n of projectText.split(/[;,|]/).map((x) => x.trim()).filter(Boolean)) {
        const t = teamIn(n);
        if (!t) err("projects", "UNKNOWN_PROJECT", `"${n}" is not a project/team in ${user.platform.name}.`);
        else if (!user.teamMemberships.some((m) => m.teamId === t.id) && !add.includes(t.id)) {
          add.push(t.id);
          names.push(t.name);
        }
      }
      if (add.length) {
        apply.projectIds = add;
        propose("projects", "", names.join(", "), true);
      }
    }

    // --- reports to --------------------------------------------------------------------
    const mName = text(get(r, "reportsToName")).trim();
    const mId = text(get(r, "reportsToId")).trim();
    if (mName || mId) {
      const none = (s: string) => s.toUpperCase() === "NONE";
      let target: string | null | undefined;
      if (none(mName) || none(mId)) target = null;
      else if (mId) {
        const p = personByCode.get(`${user.platformId}|${mId.toLowerCase()}`);
        if (!p) err("reportsToId", "MANAGER_NOT_FOUND", `Reporting manager ${mId} was not found in ${user.platform.name}.`);
        else if (mName && normName(mName) !== normName(`${p.firstName} ${p.lastName}`)) {
          err("reportsToId", "MANAGER_MISMATCH", `Reports-to name "${mName}" and ID ${mId} point to different people (${mId} is ${p.firstName} ${p.lastName}).`.replace("  ", " "));
        } else target = p.id;
      } else {
        // The manager is looked for in the employee's OWN company first, then among the active Managers and Admins of every company this viewer may act on
        // (a reporting line may cross companies, and an Admin such as Jayesh may sit in another company). A form of address after the name (sir, madam, mr...) is dropped;
        // a SINGLE remaining word is accepted only when exactly ONE active Manager or Admin in that list has that first name. The preview says where and how it was found.
        const stripped = normName(mName.replace(/\b(sir|ma'?am|mam|madam|mr|mrs|ms|miss|dr|shri|smt)\b\.?/gi, " ").replace(/\./g, " "));
        const full = (x: { firstName: string; lastName: string }) => normName(`${x.firstName} ${x.lastName}`);
        const isMgr = (x: { status: unknown; role: unknown }) => String(x.status) === "ACTIVE" && (x.role === "MANAGER" || x.role === "ADMIN");
        const searches = [
          { list: people.filter((x) => x.platformId === user.platformId), where: user.platform.name, own: true },
          { list: crossManagers.filter((x) => x.platformId !== user.platformId), where: "", own: false },
        ];
        let hits: { id: string; firstName: string; lastName: string; employeeCode: string | null; platformName?: string }[] = [];
        let how: "full" | "first" | "" = "";
        let ownSearch = true;
        for (const sr of searches) {
          ownSearch = sr.own;
          hits = sr.list.filter((x) => full(x) === normName(mName));
          how = "full";
          if (hits.length === 0 && stripped && stripped !== normName(mName)) hits = sr.list.filter((x) => full(x) === stripped);
          if (hits.length === 0 && stripped && !stripped.includes(" ")) {
            hits = sr.list.filter((x) => isMgr(x) && normName(x.firstName) === stripped);
            how = "first";
          }
          if (hits.length) break;
        }
        const where = (h: { platformName?: string }) => (ownSearch ? user.platform.name : h.platformName ?? "another company");
        if (hits.length === 0) err("reportsToId", "MANAGER_NOT_FOUND", `Reporting manager "${mName}" was not found in ${user.platform.name}, or among the active Managers and Admins of the other companies you manage.`);
        else if (hits.length > 1) err("reportsToId", "MANAGER_AMBIGUOUS", `More than one ${how === "first" ? "Manager or Admin" : "person"} is called "${mName}" (${hits.map((x) => x.employeeCode).join(", ")}). Write the full name or the manager's employee ID.`);
        else {
          if (how === "first") notes.push(`Reporting manager "${mName}" was read as ${hits[0].firstName} ${hits[0].lastName} (${hits[0].employeeCode}, ${where(hits[0])}): the only active Manager or Admin with that first name. Check it is right.`);
          else if (!ownSearch) notes.push(`Reporting manager ${hits[0].firstName} ${hits[0].lastName} (${hits[0].employeeCode}) was found in ${where(hits[0])}, another company you manage.`);
          target = hits[0].id;
        }
      }
      if (target === user.id) {
        err("reportsToId", "MANAGER_SELF", "A person cannot report to themselves.");
        target = undefined;
      }
      if (target !== undefined && target !== user.reportsToId && viewer.role !== "ADMIN") {
        // HR may upload a sheet that repeats the CURRENT reporting manager (no change, no error); a different one is Admin only.
        skipAdminOnly("Reporting manager", "the sheet names a different manager than the one saved");
      } else if (target !== undefined && target !== user.reportsToId) {
        apply.reportsToId = target;
        propose("reportsTo", personName(user.reportsToId), target === null ? "NONE (no manager)" : personName(target), user.reportsToId === null);
      }
    }

    // --- date of joining ---------------------------------------------------------------
    const doj = parseJoinDate(get(r, "dateOfJoining"));
    if (doj.error) err("dateOfJoining", "BAD_DATE", doj.error);
    else if (doj.value && doj.value !== isoDay(user.dateOfJoining)) {
      apply.dateOfJoining = doj.value;
      propose("dateOfJoining", dmy(isoDay(user.dateOfJoining)), dmy(doj.value), !user.dateOfJoining);
    }

    // --- personal details (gender, date of birth, address, ...) ------------------------------------
    // Blank = leave as is. A value is checked by the same rules as the profile form; a different value already stored is a CONFLICT (needs the overwrite tick).
    {
      const given: Record<string, unknown> = {};
      for (const f of PERSONAL_FIELDS) {
        const idx = (mapping as Record<string, number | null | undefined>)[f];
        const cell = idx === null || idx === undefined ? undefined : r.cells[idx];
        if (cell !== undefined && cell !== null && String(cell).trim() !== "") given[f] = cell;
      }
      if (Object.keys(given).length) {
        if (!personalIsReady) {
          err("row", "PERSONAL_NOT_READY", "Personal details cannot be saved on this server yet (the database update has not been applied). Remove those columns or finish the update.");
        } else {
          const checked = checkPersonal(given, platformToday(user.platform.timezone ?? "Asia/Kolkata").toISOString().slice(0, 10));
          for (const e of checked.errors) err(e.field, e.code, e.message);
          const cur = personalNow.get(user.id) ?? {};
          const personal: PersonalValues = {};
          for (const c of comparePersonal(cur, checked.values)) {
            if (c.kind === "same" || c.kind === "clear") continue;
            personal[c.field] = checked.values[c.field];
            propose(c.field, c.current, c.proposed, c.kind === "fill");
          }
          if (Object.keys(personal).length) apply.personal = personal;
        }
      }
    }

    // --- employee type (Permanent / Probation / Contract / Intern) --------------------------------------------
    const typeText = text(getX(r, "employmentType")).trim();
    if (typeText) {
      const TYPES: Record<string, string> = { permanent: "PERMANENT", probation: "PROBATION", probationary: "PROBATION", contract: "CONTRACT", contractual: "CONTRACT", intern: "INTERN", internship: "INTERN" };
      const t = TYPES[typeText.toLowerCase().replace(/[^a-z]/g, "")];
      const pretty = (v: string) => (v ? v.charAt(0) + v.slice(1).toLowerCase() : "");
      if (!t) err("row", "BAD_EMPLOYEE_TYPE", `"${typeText}" is not an employee type. Use Permanent, Probation, Contract or Intern.`);
      else if (t !== (typeNow.get(user.id) ?? "")) {
        apply.employmentType = t;
        propose("employmentType", pretty(typeNow.get(user.id) ?? ""), pretty(t), !typeNow.get(user.id));
      }
    }

    // --- secondary manager (an ADDITIONAL reporting manager; Admin only, never replaces the main one) ------------------
    const secText = text(getX(r, "secondaryManager")).trim();
    if (secText && viewer.role !== "ADMIN") skipAdminOnly("Secondary manager");
    else if (secText) {
      if (!linksOk) err("row", "SECONDARY_NOT_READY", "Secondary managers cannot be saved on this server yet (the database update has not been applied).");
      else {
        const codeIn = /\(([^)]+)\)\s*$/.exec(secText)?.[1]?.trim();
        const nameIn = secText.replace(/\([^)]*\)\s*$/, "").trim();
        const pool = people.filter((p) => p.platformId === user.platformId && String(p.status) === "ACTIVE" && (p.role === "MANAGER" || p.role === "ADMIN"));
        const hits = codeIn ? pool.filter((p) => String(p.employeeCode ?? "").toLowerCase() === codeIn.toLowerCase()) : pool.filter((p) => normName(`${p.firstName} ${p.lastName}`) === normName(nameIn));
        const have = linksNow.get(user.id) ?? [];
        if (hits.length === 0) err("row", "SECONDARY_NOT_FOUND", `Secondary manager "${secText}" is not an active Manager or Admin in ${user.platform.name}.`);
        else if (hits.length > 1) err("row", "SECONDARY_AMBIGUOUS", `More than one manager is called "${secText}". Write the name followed by the employee ID, e.g. "Name (ID)".`);
        else if (hits[0].id === user.id) err("row", "SECONDARY_SELF", "A person cannot be their own secondary manager.");
        else if (hits[0].id === user.reportsToId) notes.push(`Secondary manager ${secText} is already this person's main reporting manager: not added.`);
        else if (!have.includes(hits[0].id)) {
          if (have.length >= 5) err("row", "TOO_MANY_MANAGERS", "A person can have at most 5 additional reporting managers.");
          else {
            apply.secondaryManagerId = hits[0].id;
            propose("secondaryManager", have.map((id) => personName(id)).filter(Boolean).join(", "), personName(hits[0].id), true);
          }
        }
      }
    }

    // --- shift ---------------------------------------------------------------------------
    let startO = parseTime(get(r, "shiftStart"), options);
    let endO = parseTime(get(r, "shiftEnd"), options);
    let daysRaw = text(get(r, "workingDays"));
    // "Office timings" (one cell such as "10:00 AM - 7:00 PM") is read as the shift start and end ONLY when the separate Shift start / Shift end columns are empty.
    // Working days are never invented: they come from the Working days column or the person's current shift; if neither exists the timings are reported, not applied.
    const timingsText = text(getX(r, "officeTimings")).trim();
    // Office timings are a day (morning to evening) range: an end that is earlier than the start, with no AM/PM written, is the EVENING (9:30 to 6:30 = 09:30 to 18:30).
    // Owner's decision 2026-11-28: no tick is needed for this cell, and the row says so. The separate Shift start / Shift end columns still need the tick.
    let officeDayShift = false;
    if (timingsText && "empty" in startO && "empty" in endO) {
      const parts = timingsText.split(/\s*(?:-|–|—|\bto\b)\s*/i).filter(Boolean);
      if (parts.length !== 2) err("row", "BAD_OFFICE_TIMINGS", `Office timings "${timingsText}" should look like "10:00 AM - 7:00 PM".`);
      else {
        // Words in the cell state AM/PM outright ("morning 9:30", "6:30 evening"), so they need no confirmation tick.
        const withWords = (s: string) => {
          const am = /\b(morning|a\.?m\.?)\b/i.test(s), pm = /\b(afternoon|evening|night|p\.?m\.?)\b/i.test(s);
          const core = s.replace(/\b(morning|afternoon|evening|night|a\.?m\.?|p\.?m\.?)\b/gi, "").replace(/\s+/g, " ").trim();
          return am !== pm && /^\d{1,2}([:.]\d{2})?$/.test(core) ? `${core.replace(".", ":")} ${am ? "AM" : "PM"}` : s;
        };
        startO = parseTime(withWords(parts[0]), options);
        endO = parseTime(withWords(parts[1]), options);
        officeDayShift = true;
        if (daysRaw.trim() === "") {
          if (user.shift) daysRaw = dayLabel([...user.shift.workingDays].sort((a, b) => a - b));
          else {
            // Owner's rule (2026-11-28): the working days are Monday to Saturday when the sheet gives none and the person has no shift yet.
            daysRaw = "Mon to Sat";
            notes.push(`Working days were not in the sheet: Monday to Saturday used (company rule), shown here so you can check it.`);
          }
        }
      }
    }
    const daysO = dayNumbers(daysRaw);
    if (!("empty" in startO) || !("empty" in endO) || daysRaw.trim() !== "") {
      let start: string | null = null;
      let end: string | null = null;
      if ("error" in startO) err("shiftStart", startO.needs ? "TIME_NEEDS_CONFIRMATION" : "BAD_TIME", `Shift start: ${startO.error}`);
      else if ("value" in startO) {
        start = startO.value;
        if (startO.note) notes.push(`Shift start: ${startO.note} (confirmed)`);
      } else err("shiftStart", "SHIFT_INCOMPLETE", "Shift start is missing (end time or days were given).");
      if ("error" in endO) err("shiftEnd", endO.needs ? "TIME_NEEDS_CONFIRMATION" : "BAD_TIME", `Shift end: ${endO.error}`);
      else if ("value" in endO) {
        end = endO.value;
        if (endO.note) notes.push(`Shift end: ${endO.note} (confirmed)`);
      } else err("shiftEnd", "SHIFT_INCOMPLETE", "Shift end is missing (start time or days were given).");
      if (daysO.error) err("workingDays", "BAD_DAYS", daysO.error);
      else if (!daysO.days) err("workingDays", "SHIFT_INCOMPLETE", "Working days are missing (shift times were given).");

      if (start && end && daysO.days) {
        if (end <= start) {
          const [eh, em] = end.split(":").map(Number);
          const asPm = hhmm(eh + 12, em);
          if (eh < 12 && asPm > start && officeDayShift) {
            notes.push(`Office timings: ${start} to ${end} read as ${start} to ${asPm} (morning to evening).`);
            end = asPm;
          } else if (eh < 12 && asPm > start && options.pmEndTimes) {
            notes.push(`Shift end ${end} is before the start ${start}: read as ${asPm} (PM) (confirmed)`);
            end = asPm;
          } else {
            err("shiftEnd", "END_BEFORE_START", eh < 12 && asPm > start ? `Shift end ${end} is not after the start ${start}. If it means ${asPm}, tick "Read an early end time as PM".` : `Shift end ${end} is not after the start ${start}.`);
            end = null;
          }
        }
        if (start && end) {
          const days = daysO.days;
          const match = shifts.find((s) => s.platformId === user.platformId && s.startTime === start && s.endTime === end && s.workingDays.length === days.length && s.workingDays.every((d) => days.includes(d)));
          const label = `${start}-${end} ${dayLabel(days)}`;
          const cur = user.shift ? `${user.shift.startTime}-${user.shift.endTime} ${dayLabel([...user.shift.workingDays].sort((a, b) => a - b))}` : "";
          const same = user.shift && user.shift.startTime === start && user.shift.endTime === end && user.shift.workingDays.length === days.length && user.shift.workingDays.every((d) => days.includes(d));
          if (!same) {
            if (!match && !options.createMissingShifts) {
              err("shiftStart", "SHIFT_NOT_FOUND", `No ${label} shift exists in ${user.platform.name}. Tick "Create shifts that don't exist yet", or add it in Admin → Shifts.`);
            } else {
              apply.shift = { start, end, days, shiftId: match?.id ?? null };
              propose("shift", cur, label + (match ? "" : " (new shift)"), !user.shift);
            }
          }
        }
      }
    }
  }

  // --- the same person twice in one sheet is ambiguous --------------------------------
  for (const [code, list] of seenCodes) {
    if (list.length < 2) continue;
    for (const w of work) {
      if (w.row.employeeId.toLowerCase() === code && w.row.status !== "SKIPPED") {
        w.row.issues.push({ field: "employeeId", severity: "error", code: "DUPLICATE_IN_FILE", message: `${w.row.employeeId} appears on rows ${list.join(", ")}. Each person should appear once.` });
      }
    }
  }
  // two people given the same new email
  const emailRows = new Map<string, Work[]>();
  for (const w of work) if (w.apply.email) emailRows.set(`${w.platformId}|${w.apply.email}`, [...(emailRows.get(`${w.platformId}|${w.apply.email}`) ?? []), w]);
  for (const g of emailRows.values()) {
    if (g.length > 1) for (const w of g) w.row.issues.push({ field: "email", severity: "error", code: "DUPLICATE_EMAIL_IN_FILE", message: `Email ${w.apply.email} is given to more than one person in this sheet.` });
  }

  // --- circular reporting, checked against the people AS THEY WOULD BE after the update ------
  const managerOf = new Map(people.map((p) => [p.id, p.reportsToId as string | null]));
  const willApply = (w: Work) => w.row.changes.find((c) => c.field === "reportsTo");
  for (const w of work) {
    const c = willApply(w);
    // Conflicts not yet ticked are assumed applied here: the worst case is shown
    // so a loop is never discovered only after someone ticks the box.
    if (w.userId && c && w.apply.reportsToId !== undefined) managerOf.set(w.userId, w.apply.reportsToId);
  }
  for (const w of work) {
    if (!w.userId || !willApply(w) || w.apply.reportsToId === undefined) continue;
    let cur = w.apply.reportsToId;
    const seen = new Set<string>();
    while (cur && !seen.has(cur)) {
      if (cur === w.userId) {
        w.row.issues.push({ field: "reportsToId", severity: "error", code: "CIRCULAR", message: "Circular reporting: following 'Reports to' leads back to this same person." });
        break;
      }
      seen.add(cur);
      cur = managerOf.get(cur) ?? null;
    }
  }

  // --- verdicts ---------------------------------------------------------------------------------
  for (const w of work) {
    if (w.row.status === "SKIPPED") continue;
    const bad = w.row.issues.some((i) => i.severity === "error");
    w.row.status = bad ? "INVALID" : w.row.changes.length > 0 ? "UPDATE" : "NO_CHANGE";
  }

  const shiftsToCreate: { platformId: string; platformName: string; start: string; end: string; days: number[]; people: number }[] = [];
  for (const w of work) {
    if (w.row.status !== "UPDATE" || !w.apply.shift || w.apply.shift.shiftId) continue;
    if (!w.row.changes.find((c) => c.field === "shift")?.applied) continue;
    const s = w.apply.shift;
    const hit = shiftsToCreate.find((x) => x.platformId === w.platformId && x.start === s.start && x.end === s.end && x.days.join() === s.days.join());
    if (hit) hit.people++;
    else shiftsToCreate.push({ platformId: w.platformId!, platformName: w.platformName, start: s.start, end: s.end, days: s.days, people: 1 });
  }

  const upd = work.filter((w) => w.row.status === "UPDATE");
  const applied = (w: Work) => w.row.changes.filter((c) => c.applied);
  return {
    work,
    shiftsToCreate,
    summary: {
      total: work.length,
      toUpdate: upd.filter((w) => applied(w).length > 0).length,
      fieldsToFill: upd.reduce((n, w) => n + w.row.changes.filter((c) => c.kind === "fill").length, 0),
      conflicts: upd.reduce((n, w) => n + w.row.changes.filter((c) => c.kind === "conflict").length, 0),
      conflictsChosen: upd.reduce((n, w) => n + w.row.changes.filter((c) => c.kind === "conflict" && c.applied).length, 0),
      noChange: work.filter((w) => w.row.status === "NO_CHANGE").length,
      invalid: work.filter((w) => w.row.status === "INVALID").length,
      skipped: work.filter((w) => w.row.status === "SKIPPED").length,
    },
  };
}

const NEEDS: Record<string, keyof ImportOptions> = {
  TIME_NEEDS_CONFIRMATION: "decimalTimes",
  END_BEFORE_START: "pmEndTimes",
  SHIFT_NOT_FOUND: "createMissingShifts",
};

export async function previewUpdate(viewerId: string, input: UpdateInput) {
  const viewer = await loadViewer(viewerId);
  const out = await runUpdateValidation(viewer, input);

  // The full list of interpretations this sheet needs, found by running the same
  // validation with every one switched on and seeing which rows relied on them.
  const all: ImportOptions = { decimalTimes: true, pmEndTimes: true, createMissingShifts: true };
  const hypo = await runUpdateValidation(viewer, { ...input, options: { ...(input.options ?? {}), ...all } });
  const needs: Record<string, number> = {};
  for (const w of hypo.work) {
    if (w.row.status === "INVALID" || w.row.status === "SKIPPED") continue;
    // Counted once per person, however many of their notes mention the rule.
    if (w.row.notes.some((n) => /\(hours\.minutes\)/.test(n))) needs.decimalTimes = (needs.decimalTimes ?? 0) + 1;
    if (w.row.notes.some((n) => /\(PM\)/.test(n))) needs.pmEndTimes = (needs.pmEndTimes ?? 0) + 1;
    if (w.row.changes.some((c) => c.field === "shift" && /\(new shift\)/.test(c.proposed))) needs.createMissingShifts = (needs.createMissingShifts ?? 0) + 1;
  }
  for (const w of out.work) for (const i of w.row.issues) if (NEEDS[i.code] && i.severity === "error") needs[NEEDS[i.code]] = Math.max(needs[NEEDS[i.code]] ?? 0, 1);

  return { summary: out.summary, needsConfirmation: needs, shiftsToCreate: out.shiftsToCreate, rows: out.work.map((w) => w.row) };
}

export async function commitUpdate(viewerId: string, input: UpdateInput & { confirm?: boolean; expectedUpdates?: number }) {
  if (input.confirm !== true) throw new Error("CONFIRM_REQUIRED");
  const viewer = await loadViewer(viewerId);
  const out = await runUpdateValidation(viewer, input);

  const todo = out.work.filter((w) => w.row.status === "UPDATE" && w.userId && w.row.changes.some((c) => c.applied));
  if (todo.length === 0) throw new Error("NOTHING_TO_UPDATE");
  if (typeof input.expectedUpdates === "number" && input.expectedUpdates !== todo.length) throw new Error("PREVIEW_CHANGED");

  const shiftsCreated: { company: string; name: string }[] = [];
  try {
    const applied = await prisma.$transaction(
      async (tx) => {
        const newShift = new Map<string, string>();
        for (const s of out.shiftsToCreate) {
          const base = `${s.start}-${s.end} ${dayLabel(s.days)}`;
          let name = base;
          for (let n = 2; await tx.shift.findFirst({ where: { platformId: s.platformId, name }, select: { id: true } }); n++) name = `${base} (${n})`;
          const sh = await tx.shift.create({ data: { platformId: s.platformId, name, startTime: s.start, endTime: s.end, workingDays: s.days, spansMidnight: false }, select: { id: true } });
          newShift.set(`${s.platformId}|${s.start}|${s.end}|${s.days.join()}`, sh.id);
          shiftsCreated.push({ company: s.platformName, name });
        }

        const result: { rowNumber: number; employeeId: string; name: string; applied: { field: string; from: string; to: string }[] }[] = [];
        for (const w of todo) {
          const on = (f: UpdateField) => w.row.changes.find((c) => c.field === f)?.applied === true;
          const a = w.apply;
          const data: Record<string, unknown> = {};
          if (on("email") && a.email) data.email = a.email;
          if (on("mobile") && a.phone) data.phone = a.phone;
          if (on("designation") && a.designation) data.designation = a.designation;
          if (on("role") && a.role) data.role = a.role;
          if (on("dateOfJoining") && a.dateOfJoining) data.dateOfJoining = new Date(`${a.dateOfJoining}T00:00:00Z`);
          if (on("reportsTo") && a.reportsToId !== undefined) data.reportsToId = a.reportsToId;
          if (on("shift") && a.shift) data.shiftId = a.shift.shiftId ?? newShift.get(`${w.platformId}|${a.shift.start}|${a.shift.end}|${a.shift.days.join()}`) ?? null;
          if (Object.keys(data).length) await tx.user.update({ where: { id: w.userId! }, data });

          if (on("employmentType") && a.employmentType) {
            await tx.employeeProfile.upsert({ where: { userId: w.userId! }, create: { userId: w.userId!, employmentType: a.employmentType as never }, update: { employmentType: a.employmentType as never } });
          }
          if (on("secondaryManager") && a.secondaryManagerId) {
            await tx.reportingManagerLink.upsert({
              where: { userId_managerId: { userId: w.userId!, managerId: a.secondaryManagerId } },
              create: { userId: w.userId!, managerId: a.secondaryManagerId, createdById: viewer.id },
              update: {},
            });
          }
          if (on("team") && a.teamId) {
            await tx.teamMember.upsert({
              where: { teamId_userId: { teamId: a.teamId, userId: w.userId! } },
              update: { isActive: true, leftAt: null, isPrimary: true },
              create: { teamId: a.teamId, userId: w.userId!, isPrimary: true },
            });
            // The previous main team stays a membership; it just stops being the main one.
            await tx.teamMember.updateMany({ where: { userId: w.userId!, isPrimary: true, teamId: { not: a.teamId } }, data: { isPrimary: false } });
          }
          if (on("projects") && a.projectIds) {
            for (const teamId of a.projectIds) {
              await tx.teamMember.upsert({
                where: { teamId_userId: { teamId, userId: w.userId! } },
                update: { isActive: true, leftAt: null },
                create: { teamId, userId: w.userId!, isPrimary: false },
              });
            }
          }

          if (a.personal) {
            const pdata: Record<string, unknown> = {};
            for (const f of PERSONAL_FIELDS) {
              if (!on(f) || !(f in a.personal)) continue;
              const v = a.personal[f] ?? null;
              pdata[f] = f === "dateOfBirth" && v ? new Date(`${v}T00:00:00.000Z`) : v;
            }
            if (Object.keys(pdata).length) {
              await tx.employeePersonalDetails.upsert({
                where: { userId: w.userId! },
                create: { userId: w.userId!, platformId: w.platformId!, updatedById: viewer.id, ...pdata } as never,
                update: { updatedById: viewer.id, ...pdata } as never,
              });
            }
          }

          const done = w.row.changes.filter((c) => c.applied).map((c) => ({ field: c.label, from: c.current, to: c.proposed }));
          // Sensitive personal values are never written to the audit log: only that the field changed.
          const sensitive = new Set<string>(SENSITIVE.map((f) => PERSONAL_LABEL[f]));
          const auditDone = done.map((d) => (sensitive.has(d.field) ? { field: d.field, from: "(not recorded)", to: "(not recorded)" } : d));
          // A permanent before/after record, so "who changed this and from what" is answerable.
          await tx.auditLog.create({
            data: { actorId: viewer.id, platformId: w.platformId, method: "UPDATE", path: "/api/admin/employees/update/applied", status: 200, detail: { employee: w.row.employeeId, changes: auditDone } as never },
            select: { id: true },
          });
          result.push({ rowNumber: w.row.rowNumber, employeeId: w.row.employeeId, name: w.row.name, applied: done });
        }
        return result;
      },
      { timeout: 120_000, maxWait: 20_000 }
    );

    return {
      summary: {
        updated: applied.length,
        fieldsChanged: applied.reduce((n, r) => n + r.applied.length, 0),
        unchanged: out.summary.noChange,
        conflictsLeftAlone: out.summary.conflicts - out.summary.conflictsChosen,
        invalid: out.summary.invalid,
        skipped: out.summary.skipped,
      },
      shiftsCreated,
      rows: applied,
    };
  } catch (e) {
    console.error("[employee update] rolled back:", e);
    throw new Error("UPDATE_FAILED");
  }
}
