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

export type UpdateField = "email" | "mobile" | "designation" | "role" | "team" | "projects" | "reportsTo" | "dateOfJoining" | "shift";
const LABEL: Record<UpdateField, string> = {
  email: "Work email", mobile: "Mobile number", designation: "Designation", role: "System role", team: "Team",
  projects: "Projects", reportsTo: "Reports to", dateOfJoining: "Date of joining", shift: "Shift",
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

  const live = rows.filter((r) => !r.skip);
  const codes = Array.from(new Set(live.map((r) => text(get(r, "employeeId")).trim()).filter(Boolean)));

  // --- one batch of reads, joined in memory --------------------------------------
  const found = codes.length
    ? await prisma.user.findMany({
        where: { OR: codes.map((c) => ({ employeeCode: { equals: c, mode: "insensitive" as const } })) },
        include: {
          shift: { select: { startTime: true, endTime: true, workingDays: true } },
          teamMemberships: { where: { isActive: true }, select: { teamId: true, isPrimary: true } },
          platform: { select: { name: true } },
        },
      })
    : [];
  const platformIds = Array.from(new Set(found.map((u) => u.platformId)));
  const [people, teams, shifts] = await Promise.all([
    platformIds.length
      ? prisma.user.findMany({
          where: { platformId: { in: platformIds } },
          select: { id: true, platformId: true, employeeCode: true, firstName: true, lastName: true, email: true, role: true, reportsToId: true },
        })
      : Promise.resolve([]),
    prisma.team.findMany({ where: { isActive: true }, select: { id: true, platformId: true, name: true } }),
    prisma.shift.findMany({ where: { isActive: true }, select: { id: true, platformId: true, startTime: true, endTime: true, workingDays: true } }),
  ]);

  const byCode = new Map(found.map((u) => [String(u.employeeCode ?? "").toLowerCase(), u]));
  const personById = new Map(people.map((p) => [p.id, p]));
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

    const row: UpdateRow = { rowNumber: r.rowNumber, status: "NO_CHANGE", employeeId: text(get(r, "employeeId")).trim(), name: text(get(r, "fullName")).trim(), company: text(get(r, "company")).trim(), changes, issues, notes };
    const w: Work = { row, userId: null, platformId: null, platformName: "", apply, before };
    work.push(w);

    if (r.skip) {
      row.status = "SKIPPED";
      row.skipReason = r.skip === "example" ? "Example row - never used" : r.skip === "blank" ? "Empty row" : "Not an employee (no name or ID) - treated as a note";
      continue;
    }

    const code = row.employeeId;
    if (!code) {
      err("employeeId", "REQUIRED", "Employee ID is required: it is how the person is found.");
      row.status = "INVALID";
      continue;
    }
    seenCodes.set(code.toLowerCase(), [...(seenCodes.get(code.toLowerCase()) ?? []), r.rowNumber]);

    const user = byCode.get(code.toLowerCase());
    if (!user) {
      err("employeeId", "NOT_FOUND", `No employee has the ID ${code}. To add a new person use Import Employees.`);
      row.status = "INVALID";
      continue;
    }
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
    const designation = text(get(r, "designation")).trim();
    if (designation && designation !== (user.designation ?? "").trim()) {
      apply.designation = designation;
      propose("designation", user.designation ?? "", designation, !(user.designation ?? "").trim());
    }

    // --- role ------------------------------------------------------------------
    const roleText = text(get(r, "role")).trim();
    if (roleText) {
      const role = ROLE_MAP[roleText.toLowerCase().replace(/[^a-z]/g, "")];
      if (!role) err("role", "BAD_ROLE", `"${roleText}" is not a role. Use Employee, Manager, HR or Admin.`);
      else if (role !== String(user.role)) {
        if ((role === "HR" || role === "ADMIN" || user.role === "HR" || user.role === "ADMIN") && viewer.role !== "ADMIN") {
          err("role", "ROLE_NOT_ALLOWED", "Only an Admin can give or change the HR and Admin roles.");
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
    if (teamText) {
      const t = teamIn(teamText);
      if (!t) err("team", "UNKNOWN_TEAM", `"${teamText}" is not a team in ${user.platform.name}. Create it in Admin → Teams first.`);
      else if (!primary || primary.teamId !== t.id) {
        apply.teamId = t.id;
        const cur = primary ? (teams.find((x) => x.id === primary.teamId)?.name ?? "") : "";
        propose("team", cur, t.name, !primary);
      }
    }
    const projectText = text(get(r, "projects")).trim();
    if (projectText) {
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
        const hits = people.filter((p) => p.platformId === user.platformId && normName(`${p.firstName} ${p.lastName}`) === normName(mName));
        if (hits.length === 0) err("reportsToId", "MANAGER_NOT_FOUND", `Reporting manager "${mName}" was not found in ${user.platform.name}.`);
        else if (hits.length > 1) err("reportsToId", "MANAGER_AMBIGUOUS", `More than one person is called "${mName}". Add the manager's employee ID.`);
        else target = hits[0].id;
      }
      if (target === user.id) {
        err("reportsToId", "MANAGER_SELF", "A person cannot report to themselves.");
        target = undefined;
      }
      if (target !== undefined && target !== user.reportsToId) {
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

    // --- shift ---------------------------------------------------------------------------
    const startO = parseTime(get(r, "shiftStart"), options);
    const endO = parseTime(get(r, "shiftEnd"), options);
    const daysRaw = text(get(r, "workingDays"));
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
          if (eh < 12 && asPm > start && options.pmEndTimes) {
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

          const done = w.row.changes.filter((c) => c.applied).map((c) => ({ field: c.label, from: c.current, to: c.proposed }));
          // A permanent before/after record, so "who changed this and from what" is answerable.
          await tx.auditLog.create({
            data: { actorId: viewer.id, platformId: w.platformId, method: "UPDATE", path: "/api/admin/employees/update/applied", status: 200, detail: { employee: w.row.employeeId, changes: done } as never },
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
