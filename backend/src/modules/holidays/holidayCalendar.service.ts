// ---------------------------------------------------------------------------
// HOLIDAY MANAGEMENT (draft -> publish, optional holidays, archive). Built ON the existing `holidays` table:
//   Published holiday = a row in holidays (what attendance, reports, leave and the timesheet already read). dayType PUBLIC_HOLIDAY = Fixed,
//   OPTIONAL_HOLIDAY = Optional. An unpublished calendar lives ONLY in holiday_drafts, so it can never affect attendance or pay.
//   New tables (migration 20261122110000_holiday_management) are read with raw SQL and only after holidayReady() says they exist: before the
//   migration everything old keeps working and the new actions answer 503 FEATURES_NOT_READY.
// ---------------------------------------------------------------------------
import readXlsxFile from "read-excel-file/node";
import { prisma } from "../../lib/prisma.js";
import { platformToday } from "../../lib/dates.js";
import { accessFor, deciderIdsForCompany } from "../../lib/companyAccess.js";
import { notifyUsers } from "../../lib/notify.js";
import { auditNote } from "../../lib/auditContext.js";
import { cellToPlain, parseCsv } from "../admin/employeeImport.service.js";
import { allowedPlatforms, viewerContext } from "./holidays.service.js";
import { findHeaderRow, mapHeaders, validateHolidayRows, importable, nameKey, weekdayOf, type Cell, type HolidayRow, type SheetRow } from "./holidayImport.logic.js";

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_ROWS = 1000;
const DAY_MS = 86_400_000;

// ---- is the migration there? (a "yes" is remembered, a "no" is re-checked every 15 s; concurrent callers share one check) ----
let ready: boolean | null = null, checking: Promise<boolean> | null = null, checkedAt = 0;
export async function holidayReady(): Promise<boolean> {
  if (ready === true) return true;
  if (checking) return checking;
  if (ready === false && Date.now() - checkedAt < 15_000) return false;
  checking = (async () => {
    try {
      const r = await prisma.$queryRaw<{ n: number }[]>`select count(*)::int n from pg_class where relname in ('holiday_imports','holiday_drafts','holiday_details','holiday_archive','holiday_policy','optional_holiday_requests') and relkind = 'r'`;
      ready = (r[0]?.n ?? 0) === 6;
    } catch { ready = false; }
    checkedAt = Date.now();
    return ready;
  })().finally(() => { checking = null; });
  return checking;
}
async function need() { if (!(await holidayReady())) throw new Error("FEATURES_NOT_READY"); }

const kindOf = (dayType: string) => (dayType === "OPTIONAL_HOLIDAY" ? "OPTIONAL" : "FIXED");
const dayTypeOf = (kind: string) => (kind === "OPTIONAL" ? "OPTIONAL_HOLIDAY" : "PUBLIC_HOLIDAY");
const iso = (d: Date) => d.toISOString().slice(0, 10);
const asDate = (s: string) => new Date(`${s}T00:00:00Z`);

// ---- reading a sheet ----
export async function readSheet(input: { fileName?: unknown; contentBase64?: unknown }): Promise<{ sheet: string; headerRow: number; headers: Cell[]; rows: SheetRow[] }> {
  const name = String(input.fileName ?? "").toLowerCase();
  const buf = Buffer.from(String(input.contentBase64 ?? ""), "base64");
  if (buf.length === 0) throw new Error("EMPTY_FILE");
  if (buf.length > MAX_BYTES) throw new Error("FILE_TOO_LARGE");
  let data: Cell[][];
  let sheet = "CSV";
  if (name.endsWith(".xlsx")) {
    if (!(buf[0] === 0x50 && buf[1] === 0x4b)) throw new Error("NOT_XLSX");
    try {
      const raw = (await readXlsxFile(buf, { trim: false } as never)) as unknown as { sheet: string; data: unknown[][] }[];
      const pick = raw.find((s) => findHeaderRow(s.data.map((r) => r.map(cellToPlain))) >= 0) ?? raw[0];
      if (!pick) throw new Error("NO_ROWS");
      sheet = pick.sheet;
      data = pick.data.map((r) => r.map(cellToPlain));
    } catch (e) { throw e instanceof Error && /^[A-Z_]+$/.test(e.message) ? e : new Error("UNREADABLE_FILE"); }
  } else if (name.endsWith(".csv")) {
    data = parseCsv(buf.toString("utf8"));
  } else if (name.endsWith(".xls")) {
    throw new Error("XLS_NOT_SUPPORTED"); // the sheet reader only understands .xlsx and .csv; HR can re-save the file as .xlsx
  } else throw new Error("UNSUPPORTED_FILE");
  const h = findHeaderRow(data);
  if (h < 0) {
    const first = data.findIndex((r) => r.some((c) => c !== null && String(c).trim() !== ""));
    if (first < 0) throw new Error("NO_ROWS");
    return { sheet, headerRow: first + 1, headers: data[first] ?? [], rows: data.slice(first + 1).map((cells, i) => ({ rowNumber: first + 2 + i, cells })) };
  }
  const rows = data.slice(h + 1).map((cells, i) => ({ rowNumber: h + 2 + i, cells }));
  if (rows.length > MAX_ROWS) throw new Error("TOO_MANY_ROWS");
  return { sheet, headerRow: h + 1, headers: data[h], rows };
}

async function targetCompany(ctx: Awaited<ReturnType<typeof viewerContext>>, companyId: unknown) {
  const platforms = await allowedPlatforms(ctx);
  const id = String(companyId || ctx.platformId);
  const p = platforms.find((x) => x.id === id);
  if (!p) throw new Error("NOT_YOUR_COMPANY");
  return p;
}
function yearOf(v: unknown): number {
  const y = Number(v);
  if (!Number.isInteger(y) || y < 2020 || y > 2100) throw new Error("BAD_YEAR");
  return y;
}
async function existingKeys(platformId: string, year: number) {
  const rows = await prisma.holiday.findMany({ where: { platformId, date: { gte: new Date(Date.UTC(year, 0, 1)), lte: new Date(Date.UTC(year, 11, 31)) } }, select: { date: true, name: true } });
  return { set: new Set(rows.map((h) => `${iso(h.date)}|${nameKey(h.name)}`)), count: rows.length };
}

function summarise(rows: HolidayRow[], excluded: Set<number>) {
  const ok = importable(rows, excluded);
  return {
    total: rows.length,
    valid: rows.filter((r) => r.state === "VALID").length,
    willImport: ok.length,
    errors: rows.filter((r) => r.state === "ERROR").length,
    duplicatesInFile: rows.filter((r) => r.state === "DUPLICATE_IN_FILE").length,
    alreadyExist: rows.filter((r) => r.state === "ALREADY_EXISTS").length,
    excluded: rows.filter((r) => excluded.has(r.rowNumber)).length,
  };
}

// ---- 1. preview (writes nothing) ----
export async function previewSheet(viewerId: string, body: Record<string, unknown>) {
  const ctx = await viewerContext(viewerId);
  const company = await targetCompany(ctx, body.companyId);
  const year = yearOf(body.year);
  const sheet = await readSheet(body);
  const { map, missing } = mapHeaders(sheet.headers);
  if (missing.length) return { ok: false as const, missingColumns: missing, headers: sheet.headers.map((h) => String(h ?? "")), company, year, rows: [], summary: null };
  const ex = await existingKeys(company.id, year);
  const { rows, ignoredEmpty } = validateHolidayRows({ rows: sheet.rows, map, year, existing: ex.set });
  const draft = (await holidayReady()) ? (await prisma.$queryRaw<{ id: string }[]>`select id from holiday_imports where "platformId" = ${company.id}::uuid and "calendarYear" = ${year} and status = 'DRAFT' limit 1`)[0] : null;
  return {
    ok: true as const, company, year, sheet: sheet.sheet, headerRow: sheet.headerRow, ignoredEmptyRows: ignoredEmpty,
    rows, summary: summarise(rows, new Set()),
    yearAlreadyHasHolidays: ex.count,
    existingDraftId: draft?.id ?? null,
    note: ex.count ? `${year} already has ${ex.count} saved holiday(s). Rows that match one are skipped; nothing existing is changed or deleted. Review, then confirm to add the rest.` : null,
  };
}

// ---- 2. confirm the import: saved as a DRAFT calendar (not visible to employees, not used by attendance) ----
export async function commitImport(viewerId: string, body: Record<string, unknown>) {
  await need();
  const ctx = await viewerContext(viewerId);
  if (body.confirm !== true) throw new Error("CONFIRM_REQUIRED");
  const company = await targetCompany(ctx, body.companyId);
  const year = yearOf(body.year);
  const sheet = await readSheet(body); // the file is read again here: the saved rows are never taken from the browser
  const { map, missing } = mapHeaders(sheet.headers);
  if (missing.length) throw new Error("MISSING_COLUMNS");
  const ex = await existingKeys(company.id, year);
  const { rows } = validateHolidayRows({ rows: sheet.rows, map, year, existing: ex.set });
  const excluded = new Set<number>((Array.isArray(body.excludeRows) ? body.excludeRows : []).map(Number).filter(Number.isInteger));
  const ok = importable(rows, excluded);
  const summary = summarise(rows, excluded);
  if (ok.length === 0) throw new Error("NOTHING_TO_IMPORT");
  if (typeof body.expectedImport === "number" && body.expectedImport !== ok.length) throw new Error("PREVIEW_OUT_OF_DATE"); // the file or the calendar changed since the preview

  const failed = rows.filter((r) => r.state === "ERROR" || r.state === "DUPLICATE_IN_FILE").length;
  const skipped = rows.filter((r) => r.state === "ALREADY_EXISTS").length + excluded.size;
  const importId = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`select pg_advisory_xact_lock(hashtext(${"holiday-import:" + company.id + ":" + year}))`; // two confirmations at once import once
    const draft = (await tx.$queryRaw<{ id: string }[]>`select id from holiday_imports where "platformId" = ${company.id}::uuid and "calendarYear" = ${year} and status = 'DRAFT' limit 1`)[0];
    if (draft) {
      if (body.replaceDraft !== true) throw new Error("DRAFT_EXISTS");
      await tx.$executeRaw`update holiday_imports set status = 'DISCARDED' where id = ${draft.id}::uuid`;
    }
    const id = (await tx.$queryRaw<{ id: string }[]>`insert into holiday_imports ("platformId","calendarYear","fileName","status","totalRows","importedRows","skippedRows","failedRows","createdById") values (${company.id}::uuid, ${year}, ${String(body.fileName ?? "").slice(0, 200)}, 'DRAFT', ${rows.length}, ${ok.length}, ${skipped}, ${failed}, ${viewerId}::uuid) returning id`)[0].id;
    for (const r of ok) {
      await tx.$executeRaw`insert into holiday_drafts ("importId","platformId","date","name","kind","religion") values (${id}::uuid, ${company.id}::uuid, ${r.date}::date, ${r.name}, ${r.kind}, ${r.religion || null})`;
    }
    return id;
  });
  auditNote({ module: "Holidays", action: "CREATE", summary: `Imported ${ok.length} holiday(s) for ${year} as a draft (${company.name})`, recordType: "HolidayImport", recordId: importId, after: { importId, year, company: company.name, imported: ok.length, skipped, failed, file: String(body.fileName ?? "").slice(0, 120) } } as never);
  return { importId, imported: ok.length, skipped, failed, summary, company, year };
}

export async function discardDraft(viewerId: string, importId: string) {
  await need();
  const ctx = await viewerContext(viewerId);
  const imp = (await prisma.$queryRaw<{ platformId: string; status: string; calendarYear: number }[]>`select "platformId", status, "calendarYear" from holiday_imports where id = ${importId}::uuid`)[0];
  if (!imp) throw new Error("NOT_FOUND");
  if (!(await allowedPlatforms(ctx)).some((p) => p.id === imp.platformId)) throw new Error("NOT_FOUND");
  const n = await prisma.$executeRaw`update holiday_imports set status = 'DISCARDED' where id = ${importId}::uuid and status = 'DRAFT'`;
  if (n !== 1) throw new Error("NOT_A_DRAFT");
  auditNote({ module: "Holidays", action: "DELETE", summary: `Discarded the ${imp.calendarYear} draft calendar`, recordType: "HolidayImport", recordId: importId } as never);
  return { ok: true };
}

// ---- 3. publish: the draft becomes real holidays in ONE transaction; nothing existing is replaced or deleted ----
export async function publishDraft(viewerId: string, importId: string, body: Record<string, unknown>) {
  await need();
  const ctx = await viewerContext(viewerId);
  if (body.confirm !== true) throw new Error("CONFIRM_REQUIRED");
  const imp = (await prisma.$queryRaw<{ platformId: string; status: string; calendarYear: number }[]>`select "platformId", status, "calendarYear" from holiday_imports where id = ${importId}::uuid`)[0];
  if (!imp) throw new Error("NOT_FOUND");
  const platforms = await allowedPlatforms(ctx);
  const company = platforms.find((p) => p.id === imp.platformId);
  if (!company) throw new Error("NOT_FOUND");
  if (imp.status !== "DRAFT") throw new Error("NOT_A_DRAFT");
  const today = platformToday(ctx.timezone);
  const drafts = await prisma.$queryRaw<{ id: string; d: string; name: string; kind: string; religion: string | null }[]>`select id, to_char("date",'YYYY-MM-DD') d, name, kind, religion from holiday_drafts where "importId" = ${importId}::uuid order by "date"`;
  const past = drafts.filter((x) => asDate(x.d).getTime() < today.getTime()).length;
  // A holiday dated in the past changes the reports of that day (it stops counting as a working day), so HR must say they understand.
  if (past > 0 && body.confirmPast !== true) { const e = new Error("PAST_CONFIRM_REQUIRED") as Error & { count?: number }; e.count = past; throw e; }

  const counts = await prisma.$transaction(async (tx) => {
    const claimed = await tx.$executeRaw`update holiday_imports set status = 'PUBLISHED', "publishedAt" = now(), "publishedById" = ${viewerId}::uuid where id = ${importId}::uuid and status = 'DRAFT'`;
    if (claimed !== 1) throw new Error("NOT_A_DRAFT"); // published twice at the same moment: the second one stops here
    let added = 0, skipped = 0;
    for (const x of drafts) {
      const dup = await tx.holiday.findFirst({ where: { platformId: imp.platformId, date: asDate(x.d), name: { equals: x.name, mode: "insensitive" } }, select: { id: true } });
      if (dup) { skipped++; continue; }
      const h = await tx.holiday.create({ data: { platformId: imp.platformId, date: asDate(x.d), name: x.name, dayType: dayTypeOf(x.kind) as never } });
      await tx.$executeRaw`insert into holiday_details ("holidayId","religion","calendarYear","importId","createdById","updatedById") values (${h.id}::uuid, ${x.religion}, ${imp.calendarYear}, ${importId}::uuid, ${viewerId}::uuid, ${viewerId}::uuid)`;
      added++;
    }
    await tx.$executeRaw`update holiday_imports set "importedRows" = ${added}, "skippedRows" = "skippedRows" + ${skipped} where id = ${importId}::uuid`;
    return { added, skipped };
  });
  auditNote({ module: "Holidays", action: "APPROVE", summary: `Published the ${imp.calendarYear} holiday calendar (${company.name}): ${counts.added} holiday(s)`, recordType: "HolidayImport", recordId: importId, after: { importId, year: imp.calendarYear, company: company.name, ...counts } } as never);
  await notifyCalendar(imp.platformId, imp.calendarYear, `holiday-publish:${importId}`, `The ${imp.calendarYear} holiday calendar has been published`, `${counts.added} holiday(s) were added to the ${company.name} calendar.`);
  return { published: counts.added, skipped: counts.skipped, year: imp.calendarYear };
}

async function notifyCalendar(platformId: string, year: number, dedupeKey: string, title: string, body: string) {
  try {
    const people = await prisma.user.findMany({ where: { platformId, status: { in: ["ACTIVE", "INVITED"] } }, select: { id: true } });
    await notifyUsers({ platformId, userIds: people.map((p) => p.id), type: "HOLIDAY_CALENDAR", title, body, link: "/dashboard/holidays", dedupeKey, data: { year } });
  } catch (e) { console.error("[holidays] notify failed", e); }
}

// ---- the calendar a person sees ----
export async function policyFor(platformId: string): Promise<number> {
  if (!(await holidayReady())) return 2;
  const r = await prisma.$queryRaw<{ a: number }[]>`select "optionalAllowance" a from holiday_policy where "platformId" = ${platformId}::uuid`;
  return r[0]?.a ?? 2;
}

type Entry = { id: string; platformId: string; company: string | null; date: string; name: string; kind: "FIXED" | "OPTIONAL"; dayType: string; religion: string | null; status: "PUBLISHED" | "DRAFT" | "ARCHIVED"; weekday: string; isPast: boolean; importId?: string | null };

/** Managers of the calendar (HR, Admin) see published + draft + archived for their companies; everybody else only the published calendar of their own company. */
export async function calendarFor(viewerId: string, yearIn?: unknown, companyIn?: unknown) {
  const me = await prisma.user.findUnique({ where: { id: viewerId }, include: { platform: true } });
  if (!me) throw new Error("USER_NOT_FOUND");
  const role = String(me.role);
  const manage = role === "HR" || role === "ADMIN";
  const today = platformToday(me.platform.timezone);
  const year = yearIn ? yearOf(yearIn) : today.getUTCFullYear();
  const from = new Date(Date.UTC(year, 0, 1)), to = new Date(Date.UTC(year, 11, 31));
  const ready = await holidayReady();

  let platforms: { id: string; name: string }[];
  if (manage) {
    platforms = await allowedPlatforms({ role, platformId: me.platformId, userId: me.id });
    if (companyIn && companyIn !== "all") platforms = platforms.filter((p) => p.id === String(companyIn));
  } else platforms = [{ id: me.platformId, name: me.platform.name }];
  const ids = platforms.map((p) => p.id);
  const nameOf = new Map(platforms.map((p) => [p.id, p.name]));

  const rows = await prisma.holiday.findMany({ where: { platformId: { in: ids }, date: { gte: from, lte: to }, dayType: { in: ["PUBLIC_HOLIDAY", "OPTIONAL_HOLIDAY"] as never } }, orderBy: { date: "asc" } });
  const det = ready && rows.length ? await prisma.$queryRaw<{ id: string; religion: string | null; imp: string | null }[]>`select "holidayId" id, religion, "importId"::text imp from holiday_details where "holidayId" = any(${rows.map((r) => r.id)}::uuid[])` : [];
  const dmap = new Map(det.map((d) => [d.id, d]));
  const entries: Entry[] = rows.map((h) => ({ id: h.id, platformId: h.platformId, company: nameOf.get(h.platformId) ?? null, date: iso(h.date), name: h.name, kind: kindOf(String(h.dayType)), dayType: String(h.dayType), religion: dmap.get(h.id)?.religion ?? null, status: "PUBLISHED", weekday: weekdayOf(iso(h.date)), isPast: h.date.getTime() < today.getTime(), importId: dmap.get(h.id)?.imp ?? null }));

  let drafts: Entry[] = [], archived: Entry[] = [], imports: unknown[] = [];
  if (manage && ready) {
    const dr = await prisma.$queryRaw<{ id: string; pid: string; d: string; name: string; kind: string; religion: string | null; imp: string }[]>`select d.id::text id, d."platformId"::text pid, to_char(d."date",'YYYY-MM-DD') d, d.name, d.kind, d.religion, d."importId"::text imp from holiday_drafts d join holiday_imports i on i.id = d."importId" where i.status = 'DRAFT' and d."platformId" = any(${ids}::uuid[]) and d."date" between ${iso(from)}::date and ${iso(to)}::date order by d."date"`;
    drafts = dr.map((x) => ({ id: x.id, platformId: x.pid, company: nameOf.get(x.pid) ?? null, date: x.d, name: x.name, kind: x.kind as "FIXED" | "OPTIONAL", dayType: dayTypeOf(x.kind), religion: x.religion, status: "DRAFT", weekday: weekdayOf(x.d), isPast: asDate(x.d).getTime() < today.getTime(), importId: x.imp }));
    const ar = await prisma.$queryRaw<{ id: string; pid: string; d: string; name: string; dt: string; religion: string | null }[]>`select id::text id, "platformId"::text pid, to_char("date",'YYYY-MM-DD') d, name, "dayType" dt, religion from holiday_archive where "platformId" = any(${ids}::uuid[]) and "calendarYear" = ${year} and "restoredAt" is null order by "date"`;
    archived = ar.map((x) => ({ id: x.id, platformId: x.pid, company: nameOf.get(x.pid) ?? null, date: x.d, name: x.name, kind: kindOf(x.dt), dayType: x.dt, religion: x.religion, status: "ARCHIVED", weekday: weekdayOf(x.d), isPast: asDate(x.d).getTime() < today.getTime() }));
    imports = await prisma.$queryRaw`select id::text id, "platformId"::text "platformId", "calendarYear", "fileName", status, "totalRows", "importedRows", "skippedRows", "failedRows", "createdAt", "publishedAt" from holiday_imports where "platformId" = any(${ids}::uuid[]) and "calendarYear" = ${year} order by "createdAt" desc limit 20`;
  }

  // my own optional-holiday requests (every role has them)
  let mine: unknown[] = [];
  if (ready) mine = await prisma.$queryRaw`select r.id::text id, r."holidayId"::text "holidayId", r.status, h.name, to_char(h."date",'YYYY-MM-DD') date, r."managerNote", r."hrNote", r."createdAt" from optional_holiday_requests r join holidays h on h.id = r."holidayId" where r."userId" = ${viewerId}::uuid and h."date" between ${iso(from)}::date and ${iso(to)}::date order by h."date"`;
  const allowance = await policyFor(me.platformId);
  const used = (mine as { status: string }[]).filter((r) => ["PENDING_MANAGER", "PENDING_HR", "APPROVED"].includes(r.status)).length;

  return {
    year, today: iso(today), years: [year - 1, year, year + 1], canManage: manage, ready,
    companies: platforms, holidays: entries, drafts, archived, imports,
    myOptionalRequests: mine, optionalAllowance: allowance, optionalUsed: used,
  };
}

/** Upcoming published holidays for the signed-in person's company (next `days` days), plus, for a manager, who in the team is away on an approved optional holiday. */
export async function upcoming(viewerId: string, days = 90) {
  const me = await prisma.user.findUnique({ where: { id: viewerId }, include: { platform: true } });
  if (!me) throw new Error("USER_NOT_FOUND");
  const today = platformToday(me.platform.timezone);
  const end = new Date(today.getTime() + Math.min(Math.max(days, 1), 366) * DAY_MS);
  const rows = await prisma.holiday.findMany({ where: { platformId: me.platformId, date: { gte: today, lte: end }, dayType: { in: ["PUBLIC_HOLIDAY", "OPTIONAL_HOLIDAY"] as never } }, orderBy: { date: "asc" }, take: 30 });
  const ready = await holidayReady();
  const det = ready && rows.length ? await prisma.$queryRaw<{ id: string; religion: string | null }[]>`select "holidayId" id, religion from holiday_details where "holidayId" = any(${rows.map((r) => r.id)}::uuid[])` : [];
  const dm = new Map(det.map((d) => [d.id, d.religion]));
  const reqs = ready ? await prisma.$queryRaw<{ h: string; status: string }[]>`select "holidayId"::text h, status from optional_holiday_requests where "userId" = ${viewerId}::uuid and status in ('PENDING_MANAGER','PENDING_HR','APPROVED')` : [];
  const rm = new Map(reqs.map((r) => [r.h, r.status]));
  let teamAway: { date: string; holiday: string; people: string[] }[] = [];
  if (ready && String(me.role) === "MANAGER") {
    const away = await prisma.$queryRaw<{ d: string; name: string; who: string }[]>`select to_char(h."date",'YYYY-MM-DD') d, h.name, u."firstName" || ' ' || u."lastName" who from optional_holiday_requests r join holidays h on h.id = r."holidayId" join users u on u.id = r."userId" where r.status = 'APPROVED' and u."reportsToId" = ${viewerId}::uuid and h."date" between ${iso(today)}::date and ${iso(end)}::date order by h."date", who`;
    const by = new Map<string, { date: string; holiday: string; people: string[] }>();
    for (const a of away) { const k = `${a.d}|${a.name}`; const e = by.get(k) ?? { date: a.d, holiday: a.name, people: [] }; e.people.push(a.who); by.set(k, e); }
    teamAway = [...by.values()];
  }
  return {
    today: iso(today), allowance: await policyFor(me.platformId),
    holidays: rows.map((h) => ({ id: h.id, date: iso(h.date), name: h.name, kind: kindOf(String(h.dayType)), religion: dm.get(h.id) ?? null, weekday: weekdayOf(iso(h.date)), daysAway: Math.round((h.date.getTime() - today.getTime()) / DAY_MS), myRequest: rm.get(h.id) ?? null })),
    teamAway,
  };
}

// ---- manual add / edit / deactivate / restore ----
export async function addEntry(viewerId: string, body: Record<string, unknown>) {
  const ctx = await viewerContext(viewerId);
  const name = String(body.name ?? "").trim();
  if (!name) throw new Error("NAME_REQUIRED");
  if (name.length > 120) throw new Error("NAME_TOO_LONG");
  const kind = String(body.kind ?? "FIXED").toUpperCase();
  if (kind !== "FIXED" && kind !== "OPTIONAL") throw new Error("BAD_KIND");
  const s = String(body.date ?? "");
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m || iso(asDate(s)) !== s) throw new Error("BAD_DATE");
  // One company, or (applyToAll) every company this person manages: Independence Day can be declared once instead of three times.
  const targets = body.applyToAll === true ? await allowedPlatforms(ctx) : [await targetCompany(ctx, body.companyId)];
  const today = platformToday(ctx.timezone);
  if (asDate(s).getTime() < today.getTime()) {
    if (Math.round((today.getTime() - asDate(s).getTime()) / DAY_MS) > 90) throw new Error("DATE_TOO_OLD");
    if (body.confirmBackdate !== true) throw new Error("BACKDATE_CONFIRM_REQUIRED");
  }
  const religion = String(body.religion ?? "").trim().slice(0, 80) || null;
  const ready = await holidayReady();
  let firstId = "";
  let created = 0;
  for (const company of targets) {
    const dup = await prisma.holiday.findFirst({ where: { platformId: company.id, date: asDate(s), name: { equals: name, mode: "insensitive" } }, select: { id: true } });
    if (dup) continue;
    const h = await prisma.holiday.create({ data: { platformId: company.id, date: asDate(s), name, dayType: dayTypeOf(kind) as never } });
    if (ready) await prisma.$executeRaw`insert into holiday_details ("holidayId","religion","calendarYear","createdById","updatedById") values (${h.id}::uuid, ${religion}, ${Number(m[1])}, ${viewerId}::uuid, ${viewerId}::uuid)`;
    created++;
    firstId = firstId || h.id;
  }
  if (created === 0) throw new Error("ALREADY_EXISTS");
  auditNote({ module: "Holidays", action: "CREATE", summary: `Added ${kind === "OPTIONAL" ? "an optional" : "a fixed"} holiday: ${name} (${s})${targets.length > 1 ? ` for ${created} company(ies)` : ""}`, recordType: "Holiday", recordId: firstId } as never);
  return { id: firstId, created };
}

async function loadOwned(ctx: Awaited<ReturnType<typeof viewerContext>>, id: string) {
  const h = await prisma.holiday.findUnique({ where: { id } });
  if (!h) throw new Error("NOT_FOUND");
  if (!(await allowedPlatforms(ctx)).some((p) => p.id === h.platformId)) throw new Error("NOT_FOUND");
  return h;
}
async function liveRequests(holidayId: string): Promise<number> {
  if (!(await holidayReady())) return 0;
  return (await prisma.$queryRaw<{ n: number }[]>`select count(*)::int n from optional_holiday_requests where "holidayId" = ${holidayId}::uuid and status in ('PENDING_MANAGER','PENDING_HR','APPROVED')`)[0].n;
}

export async function editEntry(viewerId: string, id: string, body: Record<string, unknown>) {
  const ctx = await viewerContext(viewerId);
  const h = await loadOwned(ctx, id);
  const today = platformToday(ctx.timezone);
  const data: Record<string, unknown> = {};
  const before = { name: h.name, date: iso(h.date), kind: kindOf(String(h.dayType)) };
  const religionGiven = body.religion !== undefined;
  const timing = body.name !== undefined || body.date !== undefined || body.kind !== undefined;
  if (timing) {
    // Same reasoning as removing: a past holiday has already been counted into reports people have seen.
    if (h.date.getTime() < today.getTime()) throw new Error("DATE_IN_THE_PAST");
    if (body.name !== undefined) { const n = String(body.name).trim(); if (!n) throw new Error("NAME_REQUIRED"); if (n.length > 120) throw new Error("NAME_TOO_LONG"); data.name = n; }
    if (body.date !== undefined) {
      const s = String(body.date); if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || iso(asDate(s)) !== s) throw new Error("BAD_DATE");
      if (asDate(s).getTime() < today.getTime()) throw new Error("DATE_IN_THE_PAST");
      data.date = asDate(s);
    }
    if (body.kind !== undefined) { const k = String(body.kind).toUpperCase(); if (k !== "FIXED" && k !== "OPTIONAL") throw new Error("BAD_KIND"); data.dayType = dayTypeOf(k); }
    if ((data.date || data.dayType) && (await liveRequests(id)) > 0) throw new Error("HAS_REQUESTS"); // people have already asked for / been given this optional day
    const nm = (data.name as string | undefined) ?? h.name, dt = (data.date as Date | undefined) ?? h.date;
    const clash = await prisma.holiday.findFirst({ where: { platformId: h.platformId, date: dt, name: { equals: nm, mode: "insensitive" }, id: { not: id } }, select: { id: true } });
    if (clash) throw new Error("ALREADY_EXISTS");
    await prisma.holiday.update({ where: { id }, data: data as never });
  }
  if (await holidayReady()) {
    const rel = religionGiven ? String(body.religion ?? "").trim().slice(0, 80) || null : undefined;
    const year = (data.date as Date | undefined)?.getUTCFullYear() ?? h.date.getUTCFullYear();
    await prisma.$executeRaw`insert into holiday_details ("holidayId","religion","calendarYear","createdById","updatedById") values (${id}::uuid, null, ${year}, ${viewerId}::uuid, ${viewerId}::uuid) on conflict ("holidayId") do update set "calendarYear" = excluded."calendarYear", "updatedById" = excluded."updatedById", "updatedAt" = now()`;
    if (rel !== undefined) await prisma.$executeRaw`update holiday_details set religion = ${rel} where "holidayId" = ${id}::uuid`;
  }
  auditNote({ module: "Holidays", action: "UPDATE", summary: `Edited the holiday ${h.name}`, recordType: "Holiday", recordId: id, before, after: { ...before, ...Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v instanceof Date ? iso(v) : v])), ...(religionGiven ? { religion: String(body.religion ?? "") } : {}) } } as never);
  return { ok: true };
}

/** Deactivate = a copy goes to the archive, the holiday stops counting everywhere. Nothing is lost: it can be restored. */
export async function archiveEntry(viewerId: string, id: string) {
  await need();
  const ctx = await viewerContext(viewerId);
  const h = await loadOwned(ctx, id);
  if (h.date.getTime() < platformToday(ctx.timezone).getTime()) throw new Error("DATE_IN_THE_PAST");
  if ((await liveRequests(id)) > 0) throw new Error("HAS_REQUESTS");
  await prisma.$transaction(async (tx) => {
    const det = (await tx.$queryRaw<{ religion: string | null }[]>`select religion from holiday_details where "holidayId" = ${id}::uuid`)[0];
    await tx.$executeRaw`insert into holiday_archive ("platformId","date","name","dayType","religion","calendarYear","archivedById") values (${h.platformId}::uuid, ${iso(h.date)}::date, ${h.name}, ${String(h.dayType)}, ${det?.religion ?? null}, ${h.date.getUTCFullYear()}, ${viewerId}::uuid)`;
    await tx.holiday.delete({ where: { id } });
  });
  auditNote({ module: "Holidays", action: "DELETE", summary: `Deactivated the holiday ${h.name} (${iso(h.date)})`, recordType: "Holiday", recordId: id, before: { name: h.name, date: iso(h.date), kind: kindOf(String(h.dayType)) } } as never);
  return { ok: true };
}

export async function restoreEntry(viewerId: string, archiveId: string) {
  await need();
  const ctx = await viewerContext(viewerId);
  const a = (await prisma.$queryRaw<{ platformId: string; d: string; name: string; dt: string; religion: string | null; restoredAt: Date | null }[]>`select "platformId"::text "platformId", to_char("date",'YYYY-MM-DD') d, name, "dayType" dt, religion, "restoredAt" from holiday_archive where id = ${archiveId}::uuid`)[0];
  if (!a || !(await allowedPlatforms(ctx)).some((p) => p.id === a.platformId)) throw new Error("NOT_FOUND");
  if (a.restoredAt) throw new Error("ALREADY_RESTORED");
  const dup = await prisma.holiday.findFirst({ where: { platformId: a.platformId, date: asDate(a.d), name: { equals: a.name, mode: "insensitive" } }, select: { id: true } });
  if (dup) throw new Error("ALREADY_EXISTS");
  await prisma.$transaction(async (tx) => {
    const claimed = await tx.$executeRaw`update holiday_archive set "restoredAt" = now() where id = ${archiveId}::uuid and "restoredAt" is null`;
    if (claimed !== 1) throw new Error("ALREADY_RESTORED");
    const h = await tx.holiday.create({ data: { platformId: a.platformId, date: asDate(a.d), name: a.name, dayType: a.dt as never } });
    await tx.$executeRaw`insert into holiday_details ("holidayId","religion","calendarYear","createdById","updatedById") values (${h.id}::uuid, ${a.religion}, ${Number(a.d.slice(0, 4))}, ${viewerId}::uuid, ${viewerId}::uuid)`;
  });
  auditNote({ module: "Holidays", action: "UPDATE", summary: `Restored the holiday ${a.name} (${a.d})`, recordType: "Holiday", recordId: archiveId } as never);
  return { ok: true };
}

// ---- policy: how many optional holidays a person may take a year (Admin sets it; HR can read) ----
export async function getPolicy(viewerId: string) {
  const ctx = await viewerContext(viewerId);
  const platforms = await allowedPlatforms(ctx);
  const rows = (await holidayReady()) ? await prisma.$queryRaw<{ id: string; a: number }[]>`select "platformId"::text id, "optionalAllowance" a from holiday_policy where "platformId" = any(${platforms.map((p) => p.id)}::uuid[])` : [];
  const m = new Map(rows.map((r) => [r.id, r.a]));
  return { canEdit: ctx.role === "ADMIN", companies: platforms.map((p) => ({ id: p.id, name: p.name, optionalAllowance: m.get(p.id) ?? 2, isDefault: !m.has(p.id) })) };
}
export async function setPolicy(viewerId: string, body: Record<string, unknown>) {
  await need();
  const ctx = await viewerContext(viewerId);
  if (ctx.role !== "ADMIN") throw new Error("NOT_ALLOWED");
  const company = await targetCompany(ctx, body.companyId);
  const n = Number(body.optionalAllowance);
  if (!Number.isInteger(n) || n < 0 || n > 30) throw new Error("BAD_ALLOWANCE");
  const was = await policyFor(company.id);
  await prisma.$executeRaw`insert into holiday_policy ("platformId","optionalAllowance","updatedById") values (${company.id}::uuid, ${n}, ${viewerId}::uuid) on conflict ("platformId") do update set "optionalAllowance" = excluded."optionalAllowance", "updatedById" = excluded."updatedById", "updatedAt" = now()`;
  auditNote({ module: "Holidays", action: "UPDATE", summary: `Optional holiday allowance for ${company.name}: ${was} -> ${n} a year`, recordType: "HolidayPolicy", before: { optionalAllowance: was }, after: { optionalAllowance: n } } as never);
  return { ok: true };
}

// ---- optional holiday requests ----
const LIVE = ["PENDING_MANAGER", "PENDING_HR", "APPROVED"];
type Req = { id: string; platformId: string; userId: string; holidayId: string; status: string; managerId: string | null };

export async function requestOptional(userId: string, holidayId: string) {
  await need();
  const me = await prisma.user.findUnique({ where: { id: userId }, include: { platform: true } });
  if (!me || !["ACTIVE", "INVITED"].includes(String(me.status))) throw new Error("NOT_ALLOWED");
  const h = await prisma.holiday.findUnique({ where: { id: holidayId } });
  if (!h || h.platformId !== me.platformId || String(h.dayType) !== "OPTIONAL_HOLIDAY") throw new Error("NOT_FOUND");
  const today = platformToday(me.platform.timezone);
  if (h.date.getTime() < today.getTime()) throw new Error("DATE_IN_THE_PAST");
  const allowance = await policyFor(me.platformId);
  const year = h.date.getUTCFullYear();
  // the approver: the person's own reporting manager (an active Manager or Admin, never themselves); nobody suitable = straight to HR
  const boss = me.reportsToId ? await prisma.user.findUnique({ where: { id: me.reportsToId }, select: { id: true, role: true, status: true } }) : null;
  const managerId = boss && boss.id !== userId && ["MANAGER", "ADMIN"].includes(String(boss.role)) && String(boss.status) === "ACTIVE" ? boss.id : null;
  const id = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`select pg_advisory_xact_lock(hashtext(${"optional-holiday:" + userId}))`; // two clicks at once count once against the allowance
    const used = (await tx.$queryRaw<{ n: number }[]>`select count(*)::int n from optional_holiday_requests r join holidays x on x.id = r."holidayId" where r."userId" = ${userId}::uuid and r.status in ('PENDING_MANAGER','PENDING_HR','APPROVED') and extract(year from x."date") = ${year}`)[0].n;
    if (used >= allowance) throw new Error("ALLOWANCE_USED");
    const dup = (await tx.$queryRaw<{ n: number }[]>`select count(*)::int n from optional_holiday_requests where "userId" = ${userId}::uuid and "holidayId" = ${holidayId}::uuid and status in ('PENDING_MANAGER','PENDING_HR','APPROVED')`)[0].n;
    if (dup) throw new Error("ALREADY_REQUESTED");
    return (await tx.$queryRaw<{ id: string }[]>`insert into optional_holiday_requests ("platformId","userId","holidayId",status,"managerId") values (${me.platformId}::uuid, ${userId}::uuid, ${holidayId}::uuid, ${managerId ? "PENDING_MANAGER" : "PENDING_HR"}, ${managerId}::uuid) returning id::text id`)[0].id;
  });
  const who = `${me.firstName} ${me.lastName}`.trim();
  const when = `${h.name} (${iso(h.date)})`;
  if (managerId) await notifyUsers({ platformId: me.platformId, userIds: [managerId], type: "OPTIONAL_HOLIDAY_REQUEST", title: "Optional holiday request", body: `${who} asked to take ${when}.`, link: "/dashboard/holidays?tab=requests", dedupeKey: `oh:${id}:request` });
  else await notifyUsers({ platformId: me.platformId, userIds: await deciderIdsForCompany(me.platformId, userId), type: "OPTIONAL_HOLIDAY_REQUEST", title: "Optional holiday request", body: `${who} asked to take ${when}.`, link: "/dashboard/holidays?tab=requests", dedupeKey: `oh:${id}:request` });
  auditNote({ module: "Holidays", action: "CREATE", summary: `Requested the optional holiday ${h.name} (${iso(h.date)})`, recordType: "OptionalHolidayRequest", recordId: id } as never);
  return { id, status: managerId ? "PENDING_MANAGER" : "PENDING_HR" };
}

export async function cancelOptional(userId: string, requestId: string) {
  await need();
  const r = (await prisma.$queryRaw<(Req & { d: string; name: string })[]>`select r.id::text id, r."platformId"::text "platformId", r."userId"::text "userId", r."holidayId"::text "holidayId", r.status, r."managerId"::text "managerId", to_char(h."date",'YYYY-MM-DD') d, h.name from optional_holiday_requests r join holidays h on h.id = r."holidayId" where r.id = ${requestId}::uuid`)[0];
  if (!r || r.userId !== userId) throw new Error("NOT_FOUND");
  if (!LIVE.includes(r.status)) throw new Error("NOT_CANCELLABLE");
  const me = await prisma.user.findUnique({ where: { id: userId }, include: { platform: true } });
  if (asDate(r.d).getTime() < platformToday(me!.platform.timezone).getTime()) throw new Error("DATE_IN_THE_PAST");
  await prisma.$transaction(async (tx) => {
    const n = await tx.$executeRaw`update optional_holiday_requests set status = 'CANCELLED', "updatedAt" = now() where id = ${requestId}::uuid and status in ('PENDING_MANAGER','PENDING_HR','APPROVED')`;
    if (n !== 1) throw new Error("NOT_CANCELLABLE");
    // an approved request had written the leave day for this holiday: take only THAT day back (matched by its note), never other leave
    if (r.status === "APPROVED") await tx.$executeRaw`delete from leave_days where "userId" = ${userId}::uuid and "date" = ${r.d}::date and note = ${"Optional holiday: " + r.name}`;
  });
  auditNote({ module: "Holidays", action: "DELETE", summary: `Cancelled the optional holiday request for ${r.name} (${r.d})`, recordType: "OptionalHolidayRequest", recordId: requestId } as never);
  return { ok: true };
}

/** What waits for this person: a manager = requests that name him; HR/Admin = every request of their companies (HR can decide the ones at the HR step). */
export async function requestQueue(viewerId: string) {
  await need();
  const me = await prisma.user.findUnique({ where: { id: viewerId }, select: { id: true, role: true, platformId: true } });
  if (!me) throw new Error("USER_NOT_FOUND");
  const role = String(me.role);
  let rows: unknown[] = [];
  const cols = `r.id::text id, r.status, r."managerNote", r."hrNote", r."createdAt", r."managerId"::text "managerId", to_char(h."date",'YYYY-MM-DD') date, h.name holiday, u.id::text "userId", u."firstName" || ' ' || u."lastName" person, u."employeeCode" code, p.name company`;
  if (role === "MANAGER" || role === "ADMIN") {
    const mgr = await prisma.$queryRawUnsafe<unknown[]>(`select ${cols} from optional_holiday_requests r join holidays h on h.id = r."holidayId" join users u on u.id = r."userId" join platforms p on p.id = r."platformId" where r."managerId" = $1::uuid order by h."date" desc limit 200`, viewerId);
    rows = mgr;
  }
  let hr: unknown[] = [];
  if (role === "HR" || role === "ADMIN") {
    const access = await accessFor(viewerId);
    const ids = access.all ? (await prisma.platform.findMany({ select: { id: true } })).map((p) => p.id) : [...new Set([...access.ids, me.platformId])]; // every company this person acts on
    hr = await prisma.$queryRawUnsafe<unknown[]>(`select ${cols} from optional_holiday_requests r join holidays h on h.id = r."holidayId" join users u on u.id = r."userId" join platforms p on p.id = r."platformId" where r."platformId" = any($1::uuid[]) order by h."date" desc limit 300`, ids);
  }
  return { role, forManager: rows, forHr: hr };
}

export async function decideOptional(viewerId: string, requestId: string, body: Record<string, unknown>) {
  await need();
  const approve = body.approve === true;
  if (!approve && body.approve !== false) throw new Error("BAD_DECISION");
  const note = String(body.note ?? "").trim().slice(0, 300);
  if (!approve && note.length < 3) throw new Error("REASON_REQUIRED");
  const viewer = await prisma.user.findUnique({ where: { id: viewerId }, select: { id: true, role: true, platformId: true, firstName: true, lastName: true } });
  if (!viewer) throw new Error("USER_NOT_FOUND");
  const r = (await prisma.$queryRaw<(Req & { d: string; name: string })[]>`select r.id::text id, r."platformId"::text "platformId", r."userId"::text "userId", r."holidayId"::text "holidayId", r.status, r."managerId"::text "managerId", to_char(h."date",'YYYY-MM-DD') d, h.name from optional_holiday_requests r join holidays h on h.id = r."holidayId" where r.id = ${requestId}::uuid`)[0];
  if (!r) throw new Error("NOT_FOUND");
  if (r.userId === viewerId) throw new Error("OWN_REQUEST");
  const role = String(viewer.role);
  const asManager = r.status === "PENDING_MANAGER";
  if (asManager) {
    if (r.managerId !== viewerId) throw new Error("NOT_FOUND"); // only the person the request names
  } else if (r.status === "PENDING_HR") {
    if (role !== "HR") throw new Error("NOT_ALLOWED"); // final step: HR (a manager approval already happened, or there was none)
    const access = await accessFor(viewerId);
    if (!(access.all || access.ids.includes(r.platformId) || viewer.platformId === r.platformId)) throw new Error("NOT_FOUND");
  } else throw new Error("ALREADY_DECIDED");

  const person = await prisma.user.findUnique({ where: { id: r.userId }, select: { firstName: true, lastName: true, platformId: true } });
  const who = `${viewer.firstName} ${viewer.lastName}`.trim();
  const when = `${r.name} (${r.d})`;
  let next: string;
  await prisma.$transaction(async (tx) => {
    if (asManager) {
      next = approve ? "PENDING_HR" : "REJECTED";
      const n = await tx.$executeRaw`update optional_holiday_requests set status = ${next}, "managerNote" = ${note || null}, "managerDecidedAt" = now(), "updatedAt" = now(), "decidedById" = ${approve ? null : viewerId}::uuid, "decidedAt" = ${approve ? null : new Date()} where id = ${requestId}::uuid and status = 'PENDING_MANAGER' and "managerId" = ${viewerId}::uuid`;
      if (n !== 1) throw new Error("ALREADY_DECIDED");
      return;
    }
    next = approve ? "APPROVED" : "REJECTED";
    if (approve) {
      // the allowance is checked again at the final step (the policy or the person's other requests may have changed)
      const year = Number(r.d.slice(0, 4));
      const used = (await tx.$queryRaw<{ n: number }[]>`select count(*)::int n from optional_holiday_requests q join holidays x on x.id = q."holidayId" where q."userId" = ${r.userId}::uuid and q.status = 'APPROVED' and extract(year from x."date") = ${year}`)[0].n;
      if (used >= (await policyFor(r.platformId))) throw new Error("ALLOWANCE_USED");
    }
    const n = await tx.$executeRaw`update optional_holiday_requests set status = ${next}, "hrNote" = ${note || null}, "decidedById" = ${viewerId}::uuid, "decidedAt" = now(), "updatedAt" = now() where id = ${requestId}::uuid and status = 'PENDING_HR'`;
    if (n !== 1) throw new Error("ALREADY_DECIDED");
    // Approved = this person does not work that day: the same "leave day" the attendance engine already reads (so it shows as Leave, not Absent).
    // If they already have a leave day on that date nothing is added; nothing existing is replaced.
    if (approve) await tx.$executeRaw`insert into leave_days (id,"platformId","userId","date","leaveType","isHalfDay","isFirstHalf",note,"markedById","createdAt") values (gen_random_uuid(), ${person!.platformId}::uuid, ${r.userId}::uuid, ${r.d}::date, 'OTHER', false, true, ${"Optional holiday: " + r.name}, ${viewerId}::uuid, now()) on conflict ("userId","date") do nothing`;
  });
  const type = "OPTIONAL_HOLIDAY_DECIDED";
  if (asManager && approve) {
    await notifyUsers({ platformId: r.platformId, userIds: await deciderIdsForCompany(r.platformId, r.userId), type: "OPTIONAL_HOLIDAY_REQUEST", title: "Optional holiday waiting for HR", body: `${person?.firstName} ${person?.lastName} asked for ${when}; ${who} approved.`, link: "/dashboard/holidays?tab=requests", dedupeKey: `oh:${requestId}:hr` });
    await notifyUsers({ platformId: r.platformId, userIds: [r.userId], type, title: "Optional holiday: manager approved", body: `${who} approved ${when}. It now waits for HR.`, link: "/dashboard/holidays", dedupeKey: `oh:${requestId}:mgr` });
  } else {
    await notifyUsers({ platformId: r.platformId, userIds: [r.userId], type, title: approve ? "Optional holiday approved" : "Optional holiday not approved", body: `${who} ${approve ? "approved" : "did not approve"} ${when}.${note ? " " + note : ""}`, link: "/dashboard/holidays", dedupeKey: `oh:${requestId}:final` });
  }
  auditNote({ module: "Holidays", action: approve ? "APPROVE" : "REJECT", summary: `${approve ? "Approved" : "Rejected"} the optional holiday request for ${when} (${asManager ? "manager step" : "HR step"})`, recordType: "OptionalHolidayRequest", recordId: requestId, targetUserId: r.userId } as never);
  return { status: next! };
}
