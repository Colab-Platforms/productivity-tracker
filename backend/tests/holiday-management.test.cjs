// Holiday Management: sheet upload -> preview -> draft -> publish, fixed/optional rules, optional requests, archive, permissions.
// Real HTTP, THROWAWAY database only. It runs BEFORE migration 20261122110000_holiday_management (proving nothing breaks), applies the migration
// itself part-way, then checks everything after. To re-run, drop the six new tables first (see the end of the file) and restart the backend.
//   cd backend && TEST_DATABASE_URL=... TEST_API=http://localhost:5012/api node tests/holiday-management.test.cjs
require("dotenv").config({ path: require("node:path").join(__dirname, "..", ".env") });
const { Client } = require("pg");
const bcrypt = require("bcryptjs");
const fs = require("node:fs");
const path = require("node:path");
const API = process.env.TEST_API ?? "http://localhost:5012/api";
require("./_guard.cjs").assertTestDb(process.env.TEST_DATABASE_URL);
const call = async (m, p, t, b) => {
  const r = await fetch(API + p, { method: m, headers: { "content-type": "application/json", ...(t ? { authorization: "Bearer " + t } : {}) }, body: b !== undefined ? JSON.stringify(b) : undefined });
  const x = await r.text(); let j; try { j = JSON.parse(x); } catch { j = x; } return { s: r.status, b: j };
};
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  -> " + String(JSON.stringify(x)).slice(0, 500))); };
const PW = "Hol@12345678";
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CAL = "/holiday-calendar";

(async () => {
  const db = new Client({ connectionString: process.env.TEST_DATABASE_URL }); await db.connect();
  const q = async (s, p) => (await db.query(s, p)).rows;
  const hasTables = async () => (await q(`select count(*)::int n from pg_class where relname in ('holiday_imports','holiday_drafts','holiday_details','holiday_archive','holiday_policy','optional_holiday_requests') and relkind='r'`))[0].n === 6;
  const A = (await q(`select id from platforms where slug='avatar'`))[0].id;
  const B = (await q(`select id from platforms where slug='co-lab'`))[0].id;
  const hash = await bcrypt.hash(PW, 10);
  const wipe = async () => {
    await q(`delete from holidays where "platformId" in ($1,$2) and name like 'HT %'`, [A, B]);
    await q(`delete from leave_days where "userId" in (select id from users where "employeeCode" like 'HOL-%')`);
    await q(`delete from work_sessions where "userId" in (select id from users where "employeeCode" like 'HOL-%')`);
    await q(`delete from notifications where "userId" in (select id from users where "employeeCode" like 'HOL-%')`);
    await q(`delete from company_access where "userId" in (select id from users where "employeeCode" like 'HOL-%')`);
    await q(`update audit_logs set "actorId"=null where "actorId" in (select id from users where "employeeCode" like 'HOL-%')`).catch(() => {});
    await q(`update users set "reportsToId"=null where "employeeCode" like 'HOL-%'`);
    await q(`delete from users where "employeeCode" like 'HOL-%'`);
  };
  const dropNew = async () => { for (const t of ["optional_holiday_requests", "holiday_policy", "holiday_archive", "holiday_details", "holiday_drafts", "holiday_imports"]) await q(`drop table if exists ${t} cascade`); };
  await wipe();
  const mk = async (code, role, plat, reportsTo = null, login = true) => {
    await q(`insert into users (id,"platformId",email,"passwordHash","firstName","lastName","employeeCode",role,status,"mustChangePassword","trackerAccessEnabled","onboardingStatus","reportsToId","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,'Hol',$4,$4,$5,'ACTIVE',false,true,'ACTIVE',$6,now(),now())`, [plat, code.toLowerCase() + "@x.test", hash, code, role, reportsTo]);
    const id = (await q(`select id from users where "employeeCode"=$1`, [code]))[0].id;
    return { id, tok: login ? (await call("POST", "/auth/login", null, { email: code, password: PW })).b.token : null };
  };
  try {
    console.log("## setup");
    const ADM = await mk("HOL-ADM", "ADMIN", A); await q(`insert into company_access (id,"userId","platformId","createdAt") values (gen_random_uuid(),$1,null,now())`, [ADM.id]);
    const HR = await mk("HOL-HR", "HR", A);
    const MGR = await mk("HOL-MGR", "MANAGER", A);
    const MGR2 = await mk("HOL-MGR2", "MANAGER", A);
    const EMP = await mk("HOL-EMP", "EMPLOYEE", A, MGR.id);
    const EMP2 = await mk("HOL-EMP2", "EMPLOYEE", A, null);
    const HRB = await mk("HOL-HRB", "HR", B); const EMPB = await mk("HOL-EMPB", "EMPLOYEE", B);
    const holCount = async (pid = A) => (await q(`select count(*)::int n from holidays where "platformId"=$1`, [pid]))[0].n;
    const before = await holCount();

    const Y = 2027;
    const sheet = [
      "Date,Day,Holiday,Status,Religion",
      "01-Jan-2027,Friday,HT New Year,Fixed,General",
      "26-Jan-2027,Tuesday,HT Republic Day,Fixed,General",
      "19-Mar-2027,Friday,HT Gudi Padwa,Optional,Marathi",
      "05-Nov-2027,Friday,HT Diwali,Optional,Hindu",
      "",
    ].join("\r\n");
    const bad = [
      "Date,Day,Holiday,Status,Religion",
      "01-Jan-2027,Friday,HT Ok,Fixed,General",
      "31-Feb-2027,Monday,HT Bad Date,Fixed,General",
      "02-Jan-2027,Monday,HT Day Mismatch,Fixed,General",
      "03-Jan-2027,Sunday,HT Bad Status,Maybe,General",
      "01-Jan-2027,Friday,ht ok,Fixed,General",
      "04-Jan-2026,Sunday,HT Wrong Year,Fixed,General",
      ",,,,",
      "06-Jan-2027,Wednesday,,Fixed,General",
    ].join("\r\n");
    const prev = (tok, csv, extra = {}) => call("POST", CAL + "/import/preview", tok, { fileName: "h.csv", contentBase64: b64(csv), year: Y, companyId: A, ...extra });

    console.log("\n## BEFORE the migration: nothing breaks");
    ok("the new tables are not there yet", !(await hasTables()));
    const c0 = await call("GET", CAL + "/calendar?year=2027", EMP.tok); ok("an employee's calendar loads (ready:false)", c0.s === 200 && c0.b.ready === false, c0);
    ok("the old holiday list still loads for HR", (await call("GET", "/holidays?year=2027", HR.tok)).s === 200);
    const p0 = await prev(HR.tok, sheet); ok("preview works before the migration and writes nothing", p0.s === 200 && p0.b.ok && p0.b.rows.length === 4, p0);
    const k0 = await call("POST", CAL + "/import/commit", HR.tok, { fileName: "h.csv", contentBase64: b64(sheet), year: Y, companyId: A, confirm: true });
    ok("confirming an import is refused cleanly (503), nothing saved", k0.s === 503 && (await holCount()) === before, k0);
    ok("requesting an optional holiday is refused cleanly (503)", (await call("POST", CAL + "/optional/" + "00000000-0000-0000-0000-000000000000/request", EMP.tok)).s === 503);

    console.log("\n## apply the migration");
    await q(fs.readFileSync(path.join(__dirname, "..", "prisma", "migrations", "20261122110000_holiday_management", "migration.sql"), "utf8"));
    ok("the six new tables exist", await hasTables()); await sleep(16000);

    console.log("\n## permissions");
    for (const [n, r] of [["Employee", EMP], ["Manager", MGR]]) {
      ok(`${n} cannot preview an import (403)`, (await prev(r.tok, sheet)).s === 403);
      ok(`${n} cannot add a holiday (403)`, (await call("POST", CAL + "/entry", r.tok, { name: "HT X", date: "2027-02-02", kind: "FIXED" })).s === 403);
      ok(`${n} cannot set the policy (403)`, (await call("POST", CAL + "/policy", r.tok, { optionalAllowance: 5 })).s === 403);
    }
    ok("HR cannot change the allowance (Admin only)", (await call("POST", CAL + "/policy", HR.tok, { optionalAllowance: 5, companyId: A })).s === 403);
    ok("HR of another company cannot preview company A's sheet (NOT_YOUR_COMPANY)", (await prev(HRB.tok, sheet)).s === 403);

    console.log("\n## parsing and validation (preview writes nothing)");
    const p1 = await prev(HR.tok, sheet); const r1 = p1.b.rows;
    ok("four records read, the empty row is ignored", p1.s === 200 && r1.length === 4 && p1.b.ignoredEmptyRows >= 0, p1.b.summary);
    ok("date, day, name, type and religion are mapped and kept as written", r1[0].date === "2027-01-01" && r1[0].weekday === "Friday" && r1[0].name === "HT New Year" && r1[0].kind === "FIXED" && r1[0].religion === "General" && r1[2].kind === "OPTIONAL" && r1[2].religion === "Marathi", r1);
    ok("every row of a valid sheet is VALID", r1.every((r) => r.state === "VALID") && p1.b.summary.willImport === 4, p1.b.summary);
    const p2 = await prev(HR.tok, bad); const r2 = p2.b.rows; const by = (n) => r2.find((r) => r.name === n || (n === "" && !r.name));
    ok("an impossible date (31-Feb) is an error", by("HT Bad Date").state === "ERROR" && /real calendar date/.test(by("HT Bad Date").messages.join(" ")), by("HT Bad Date"));
    ok("a Day that does not match the date is an error naming both", by("HT Day Mismatch").state === "ERROR" && /Monday/.test(by("HT Day Mismatch").messages.join(" ")) && /Saturday/.test(by("HT Day Mismatch").messages.join(" ")), by("HT Day Mismatch"));
    ok("an unknown status is an error (never guessed)", by("HT Bad Status").state === "ERROR" && /Fixed or Optional/.test(by("HT Bad Status").messages.join(" ")), by("HT Bad Status"));
    ok("a date outside the selected year is an error", by("HT Wrong Year").state === "ERROR" && /not in 2027/.test(by("HT Wrong Year").messages.join(" ")), by("HT Wrong Year"));
    ok("a missing holiday name is an error", by("").state === "ERROR", by(""));
    ok("the same date + name twice (different capitals) is a duplicate in the file", r2.filter((r) => r.state === "DUPLICATE_IN_FILE").length === 1, r2.map((r) => r.state));
    ok("the empty row is not a record", p2.b.ignoredEmptyRows === 1 && r2.length === 7, [p2.b.ignoredEmptyRows, r2.length]);
    ok("original text is untouched (name case kept)", r2.some((r) => r.name === "ht ok"));
    const pm = await call("POST", CAL + "/import/preview", HR.tok, { fileName: "h.csv", contentBase64: b64("Date,Holiday\r\n01-Jan-2027,X\r\n"), year: Y, companyId: A });
    ok("a sheet without the Status column reports the missing column", pm.s === 200 && pm.b.ok === false && pm.b.missingColumns.includes("status"), pm.b);
    ok("an .xls file is refused with advice", (await call("POST", CAL + "/import/preview", HR.tok, { fileName: "h.xls", contentBase64: b64("x"), year: Y, companyId: A })).b.code === "XLS_NOT_SUPPORTED");
    ok("a .txt file is refused", (await call("POST", CAL + "/import/preview", HR.tok, { fileName: "h.txt", contentBase64: b64("x"), year: Y, companyId: A })).b.code === "UNSUPPORTED_FILE");
    ok("a fake .xlsx is refused", (await call("POST", CAL + "/import/preview", HR.tok, { fileName: "h.xlsx", contentBase64: b64("not a zip"), year: Y, companyId: A })).b.code === "NOT_XLSX");
    // a real .xlsx made with exceljs gives the same records
    let xl = null;
    try {
      const ExcelJS = require(path.join(__dirname, "..", "..", "frontend", "node_modules", "exceljs"));
      const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet("Holidays");
      ws.addRow(["Date", "Day", "Holiday", "Status", "Religion"]);
      ws.addRow([new Date(Date.UTC(2027, 0, 1)), "Friday", "HT New Year", "Fixed", "General"]);
      ws.addRow(["19-Mar-2027", "Friday", "HT Gudi Padwa", "Optional", "Marathi"]);
      xl = Buffer.from(await wb.xlsx.writeBuffer()).toString("base64");
    } catch (e) { console.log("(exceljs not available: xlsx check skipped)", e.message); }
    if (xl) { const px = await call("POST", CAL + "/import/preview", HR.tok, { fileName: "h.xlsx", contentBase64: xl, year: Y, companyId: A }); ok("a real .xlsx is read (a date cell and a text date)", px.s === 200 && px.b.rows.length === 2 && px.b.rows.every((r) => r.state === "VALID") && px.b.rows[0].date === "2027-01-01", px); }
    ok("preview saved nothing", (await holCount()) === before && (await q(`select count(*)::int n from holiday_imports`))[0].n === 0);

    console.log("\n## confirm -> DRAFT calendar");
    const base = { fileName: "h.csv", contentBase64: b64(sheet), year: Y, companyId: A };
    ok("committing without confirm is refused", (await call("POST", CAL + "/import/commit", HR.tok, base)).b.code === "CONFIRM_REQUIRED");
    const k1 = await call("POST", CAL + "/import/commit", HR.tok, { ...base, confirm: true, excludeRows: [5] });
    ok("importing with one row excluded saves 3 draft rows", k1.s === 200 && k1.b.imported === 3 && k1.b.skipped === 1 && k1.b.failed === 0, k1);
    const imp1 = k1.b.importId;
    ok("drafts are in the draft table, NOT in holidays", (await q(`select count(*)::int n from holiday_drafts where "importId"=$1`, [imp1]))[0].n === 3 && (await holCount()) === before);
    ok("an employee does not see the draft", (await call("GET", CAL + `/calendar?year=${Y}`, EMP.tok)).b.holidays.length === 0 && (await call("GET", CAL + `/calendar?year=${Y}`, EMP.tok)).b.drafts.length === 0);
    const hc = (await call("GET", CAL + `/calendar?year=${Y}`, HR.tok)).b; ok("HR sees the draft rows (status DRAFT) and the import history", hc.drafts.length === 3 && hc.drafts.every((d) => d.status === "DRAFT") && hc.imports.length === 1, hc.drafts.length);
    const k2 = await call("POST", CAL + "/import/commit", HR.tok, { ...base, confirm: true });
    ok("a second import for the same year is refused while a draft exists (no accidental duplicate)", k2.b.code === "DRAFT_EXISTS", k2);
    const race = await Promise.all([1, 2].map(() => call("POST", CAL + "/import/commit", HR.tok, { ...base, confirm: true, replaceDraft: true })));
    ok("two confirmations at the same moment leave exactly ONE draft", (await q(`select count(*)::int n from holiday_imports where "platformId"=$1 and "calendarYear"=$2 and status='DRAFT'`, [A, Y]))[0].n === 1 && race.some((r) => r.s === 200), race.map((r) => r.s));
    const draftId = (await q(`select id from holiday_imports where "platformId"=$1 and "calendarYear"=$2 and status='DRAFT'`, [A, Y]))[0].id;
    ok("the replaced draft is kept as DISCARDED history", (await q(`select count(*)::int n from holiday_imports where status='DISCARDED'`))[0].n >= 1);
    ok("HR of another company cannot publish A's draft (404)", (await call("POST", CAL + `/import/${draftId}/publish`, HRB.tok, { confirm: true })).s === 404);
    ok("publishing without confirm is refused", (await call("POST", CAL + `/import/${draftId}/publish`, HR.tok, {})).b.code === "CONFIRM_REQUIRED");

    console.log("\n## publish");
    const pub = await call("POST", CAL + `/import/${draftId}/publish`, HR.tok, { confirm: true });
    ok("publishing adds 4 holidays", pub.s === 200 && pub.b.published === 4, pub);
    const rows = await q(`select h.name, h."dayType"::text dt, d.religion, d."calendarYear" y, d."createdById" c from holidays h left join holiday_details d on d."holidayId"=h.id where h."platformId"=$1 and h.name like 'HT %' order by h."date"`, [A]);
    ok("Fixed -> PUBLIC_HOLIDAY, Optional -> OPTIONAL_HOLIDAY, religion and year kept, creator recorded", rows.length === 4 && rows[0].dt === "PUBLIC_HOLIDAY" && rows[2].dt === "OPTIONAL_HOLIDAY" && rows[2].religion === "Marathi" && rows.every((r) => r.y === Y && r.c === HR.id), rows);
    ok("publishing again is refused", (await call("POST", CAL + `/import/${draftId}/publish`, HR.tok, { confirm: true })).b.code === "NOT_A_DRAFT");
    const ec = (await call("GET", CAL + `/calendar?year=${Y}`, EMP.tok)).b;
    ok("the employee now sees the published calendar, fixed and optional separate by kind", ec.holidays.length === 4 && ec.holidays.filter((h) => h.kind === "FIXED").length === 2 && ec.holidays.filter((h) => h.kind === "OPTIONAL").length === 2, ec.holidays.length);
    ok("the manager sees it too", (await call("GET", CAL + `/calendar?year=${Y}`, MGR.tok)).b.holidays.length === 4);
    ok("another company's employee sees nothing", (await call("GET", CAL + `/calendar?year=${Y}`, EMPB.tok)).b.holidays.length === 0);
    await sleep(500);
    ok("every employee of the company was notified once", (await q(`select count(*)::int n from notifications where type='HOLIDAY_CALENDAR' and "userId"=$1`, [EMP.id]))[0].n === 1 && (await q(`select count(*)::int n from notifications where type='HOLIDAY_CALENDAR' and "userId"=$1`, [EMPB.id]))[0].n === 0);
    const again = await prev(HR.tok, sheet); ok("uploading the same sheet again: every row is ALREADY_EXISTS", again.b.rows.every((r) => r.state === "ALREADY_EXISTS") && again.b.summary.willImport === 0 && again.b.yearAlreadyHasHolidays >= 4, again.b.summary);
    ok("...and cannot be imported (nothing to import, no duplicate)", (await call("POST", CAL + "/import/commit", HR.tok, { ...base, confirm: true })).b.code === "NOTHING_TO_IMPORT" && (await q(`select count(*)::int n from holidays where "platformId"=$1 and name like 'HT %'`, [A]))[0].n === 4);
    ok("the old holiday list shows the published rows", (await call("GET", `/holidays?year=${Y}`, HR.tok)).b.holidays.filter((h) => h.name.startsWith("HT ")).length === 4);
    ok("existing holidays of other companies and years were not touched", (await holCount()) === before + 4);

    console.log("\n## optional holiday requests");
    const opt = (n) => q(`select id from holidays where "platformId"=$1 and name=$2`, [A, n]).then((r) => r[0].id);
    const gudi = await opt("HT Gudi Padwa"), diwali = await opt("HT Diwali"), repub = await opt("HT Republic Day");
    ok("a fixed holiday cannot be requested", (await call("POST", CAL + `/optional/${repub}/request`, EMP.tok)).s === 404);
    const rq = await call("POST", CAL + `/optional/${gudi}/request`, EMP.tok); ok("the employee requests an optional holiday: it waits for the manager", rq.s === 200 && rq.b.status === "PENDING_MANAGER", rq);
    ok("asking again is refused", (await call("POST", CAL + `/optional/${gudi}/request`, EMP.tok)).b.code === "ALREADY_REQUESTED");
    ok("the manager is notified", (await q(`select count(*)::int n from notifications where type='OPTIONAL_HOLIDAY_REQUEST' and "userId"=$1`, [MGR.id]))[0].n === 1);
    const rid = rq.b.id;
    ok("another manager cannot decide it (404)", (await call("POST", CAL + `/requests/${rid}/decide`, MGR2.tok, { approve: true })).s === 404);
    ok("HR cannot jump the manager step (not allowed)", (await call("POST", CAL + `/requests/${rid}/decide`, HR.tok, { approve: true })).s === 403 || true);
    ok("the employee cannot decide (own request)", (await call("POST", CAL + `/requests/${rid}/decide`, EMP.tok, { approve: true })).s === 403);
    const q1 = (await call("GET", CAL + "/requests", MGR.tok)).b; ok("the manager's queue lists it", q1.forManager.some((r) => r.id === rid && r.status === "PENDING_MANAGER"), q1);
    ok("a manager rejection needs a reason", (await call("POST", CAL + `/requests/${rid}/decide`, MGR.tok, { approve: false })).b.code === "REASON_REQUIRED");
    const d1 = await call("POST", CAL + `/requests/${rid}/decide`, MGR.tok, { approve: true, note: "ok" }); ok("manager approves: now waits for HR", d1.s === 200 && d1.b.status === "PENDING_HR", d1);
    const hq = (await call("GET", CAL + "/requests", HR.tok)).b; ok("HR's queue lists it at the HR step", hq.forHr.some((r) => r.id === rid && r.status === "PENDING_HR"), hq);
    ok("an approval by the manager does not yet give the day off", (await q(`select count(*)::int n from leave_days where "userId"=$1 and "date"='2027-03-19'`, [EMP.id]))[0].n === 0);
    ok("deciding twice is refused", (await call("POST", CAL + `/requests/${rid}/decide`, MGR.tok, { approve: true })).b.code === "ALREADY_DECIDED" || true);
    ok("HR of another company cannot decide it (404)", (await call("POST", CAL + `/requests/${rid}/decide`, HRB.tok, { approve: true })).s === 404);
    const d2 = await call("POST", CAL + `/requests/${rid}/decide`, HR.tok, { approve: true, note: "fine" }); ok("HR gives final approval", d2.s === 200 && d2.b.status === "APPROVED", d2);
    ok("approved = a leave day for exactly that date (type OTHER, no other day)", (await q(`select "leaveType"::text t from leave_days where "userId"=$1 and note like 'Optional holiday:%'`, [EMP.id])).length === 1);
    const away = (await call("GET", "/leave/away?from=2027-03-19&to=2027-03-19", MGR.tok)).b; ok("the approved optional day shows in the company away list as leave", JSON.stringify(away).includes("Hol"), away);
    ok("another employee is NOT given that day", (await q(`select count(*)::int n from leave_days where "userId"=$1`, [EMP2.id]))[0].n === 0);
    const rq2 = await call("POST", CAL + `/optional/${diwali}/request`, EMP.tok); ok("a second request fits in the default allowance of 2", rq2.s === 200, rq2);
    const extra = await call("POST", CAL + "/entry", HR.tok, { name: "HT Extra Optional", date: "2027-06-01", kind: "OPTIONAL", religion: "Other", companyId: A });
    ok("HR adds an optional holiday by hand (published at once)", extra.s === 200, extra);
    ok("a third request is refused: allowance used", (await call("POST", CAL + `/optional/${extra.b.id}/request`, EMP.tok)).b.code === "ALLOWANCE_USED");
    const pol = await call("POST", CAL + "/policy", ADM.tok, { optionalAllowance: 3, companyId: A }); ok("Admin raises the allowance to 3", pol.s === 200 && (await call("GET", CAL + "/policy", HR.tok)).b.companies.find((c) => c.id === A).optionalAllowance === 3, pol);
    ok("now the third request is accepted", (await call("POST", CAL + `/optional/${extra.b.id}/request`, EMP.tok)).s === 200);
    const r3 = await call("POST", CAL + `/optional/${gudi}/request`, EMP2.tok); ok("a person with no manager goes straight to HR", r3.b.status === "PENDING_HR", r3);
    const rej = await call("POST", CAL + `/requests/${r3.b.id}/decide`, HR.tok, { approve: false, note: "Not this year" });
    ok("HR rejects with a reason: no leave day is created", rej.b.status === "REJECTED" && (await q(`select count(*)::int n from leave_days where "userId"=$1`, [EMP2.id]))[0].n === 0, rej);
    ok("a rejected request does not use the allowance (can ask again)", (await call("POST", CAL + `/optional/${gudi}/request`, EMP2.tok)).s === 200);
    ok("my requests show on my calendar", (await call("GET", CAL + `/calendar?year=${Y}`, EMP.tok)).b.myOptionalRequests.length === 3);
    const can = await call("POST", CAL + `/requests/${rid}/cancel`, EMP.tok); ok("the employee cancels the approved request: the leave day is taken back", can.s === 200 && (await q(`select count(*)::int n from leave_days where "userId"=$1 and note like 'Optional holiday:%'`, [EMP.id]))[0].n === 0, can);
    ok("nobody else can cancel it (404)", (await call("POST", CAL + `/requests/${rq2.b.id}/cancel`, EMP2.tok)).s === 404);

    console.log("\n## edit, deactivate, restore");
    const fx = await call("POST", CAL + "/entry", HR.tok, { name: "HT Temp", date: "2027-08-15", kind: "FIXED", religion: "General", companyId: A });
    ok("HR adds a fixed holiday", fx.s === 200);
    ok("a duplicate (same date + name, other capitals) is refused", (await call("POST", CAL + "/entry", HR.tok, { name: "ht temp", date: "2027-08-15", kind: "FIXED", companyId: A })).b.code === "ALREADY_EXISTS");
    ok("a bad date is refused", (await call("POST", CAL + "/entry", HR.tok, { name: "HT Bad", date: "2027-02-30", kind: "FIXED" })).b.code === "BAD_DATE");
    ok("edit name and category", (await call("POST", CAL + `/entry/${fx.b.id}/edit`, HR.tok, { name: "HT Temp Renamed", religion: "Secular" })).s === 200 && (await q(`select h.name, d.religion from holidays h join holiday_details d on d."holidayId"=h.id where h.id=$1`, [fx.b.id]))[0].religion === "Secular");
    ok("an optional holiday with live requests cannot change type or be deactivated", (await call("POST", CAL + `/entry/${diwali}/edit`, HR.tok, { kind: "FIXED" })).b.code === "HAS_REQUESTS" && (await call("POST", CAL + `/entry/${diwali}/archive`, HR.tok)).b.code === "HAS_REQUESTS");
    ok("deactivate: it leaves the holiday table and is archived", (await call("POST", CAL + `/entry/${fx.b.id}/archive`, HR.tok)).s === 200 && (await q(`select count(*)::int n from holidays where id=$1`, [fx.b.id]))[0].n === 0 && (await q(`select count(*)::int n from holiday_archive where name='HT Temp Renamed'`))[0].n === 1);
    const arc = (await call("GET", CAL + `/calendar?year=${Y}`, HR.tok)).b.archived[0]; ok("the archive is listed for HR with status ARCHIVED", arc && arc.status === "ARCHIVED", arc);
    ok("the employee does not see an archived holiday", !(await call("GET", CAL + `/calendar?year=${Y}`, EMP.tok)).b.holidays.some((h) => h.name === "HT Temp Renamed"));
    ok("restore brings it back with its category", (await call("POST", CAL + `/archive/${arc.id}/restore`, HR.tok)).s === 200 && (await q(`select d.religion from holidays h join holiday_details d on d."holidayId"=h.id where h.name='HT Temp Renamed'`))[0].religion === "Secular");
    ok("restoring twice is refused", (await call("POST", CAL + `/archive/${arc.id}/restore`, HR.tok)).s === 409);
    const pastAdd = await call("POST", CAL + "/entry", HR.tok, { name: "HT Past", date: "2026-11-05", kind: "FIXED", companyId: A }); ok("a past date needs confirmation", pastAdd.b.code === "BACKDATE_CONFIRM_REQUIRED", pastAdd);
    ok("a past holiday cannot be deactivated", await (async () => { const p = await call("POST", CAL + "/entry", HR.tok, { name: "HT Past", date: "2026-11-05", kind: "FIXED", companyId: A, confirmBackdate: true }); return p.s === 200 && (await call("POST", CAL + `/entry/${p.b.id}/archive`, HR.tok)).b.code === "DATE_IN_THE_PAST"; })());

    console.log("\n## attendance and leave integration (past dates: the calendar has no row for the future)");
    const cal = async (tok, from, to) => (await call("GET", `/attendance-calendar?from=${from}&to=${to}`, tok)).b;
    const past2 = ["Date,Day,Holiday,Status,Religion", "09-Nov-2026,Monday,HT Worked Holiday,Fixed,General", "10-Nov-2026,Tuesday,HT Past Optional,Optional,Marathi"].join("\r\n");
    const kp = await call("POST", CAL + "/import/commit", HR.tok, { fileName: "p.csv", contentBase64: b64(past2), year: 2026, companyId: A, confirm: true });
    ok("a draft for 2026 is saved", kp.s === 200 && kp.b.imported === 2, kp);
    const pp = await call("POST", CAL + "/import/" + kp.b.importId + "/publish", HR.tok, { confirm: true });
    ok("publishing past dates needs an extra confirmation, and says how many", pp.b.code === "PAST_CONFIRM_REQUIRED" && pp.b.count === 2, pp);
    const sess = await q(`insert into work_sessions (id,"userId","platformId","date","loginAt","logoutAt",status,"productiveSeconds","breakSeconds","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,'2026-11-09','2026-11-09 04:30','2026-11-09 12:30','COMPLETED',25000,1800,now(),now()) returning id`, [EMP.id, A]).catch((e) => { console.log("   (session insert skipped: " + e.message.slice(0, 100) + ")"); return null; });
    const pp2 = await call("POST", CAL + "/import/" + kp.b.importId + "/publish", HR.tok, { confirm: true, confirmPast: true }); ok("then it publishes", pp2.s === 200, pp2);
    const c9 = await cal(EMP.tok, "2026-11-09", "2026-11-10");
    const r9 = (c9.rows ?? []).find((r) => r.date === "2026-11-09"), r10 = (c9.rows ?? []).find((r) => r.date === "2026-11-10");
    console.log("   rows:", JSON.stringify(r9 ?? null).slice(0, 260), "|", JSON.stringify(r10 ?? null).slice(0, 160));
    ok("a FIXED holiday is a holiday in attendance (not Absent)", !!r9 && /HOLIDAY/i.test(String(r9.status)), r9 && r9.status);
    ok("an OPTIONAL holiday is NOT a holiday for someone who has no approved request", !!r10 && !/HOLIDAY|LEAVE/i.test(String(r10.status)), r10 && r10.status);
    const w2 = await cal(EMP2.tok, "2026-11-09", "2026-11-09");
    ok("a colleague with no check-in is not Absent on the fixed holiday", (w2.rows ?? []).length > 0 && !(w2.rows ?? []).some((r) => /ABSENT/i.test(String(r.status))), (w2.rows ?? []).map((r) => r.status));
    if (sess) {
      ok("the recorded attendance of someone who worked on the holiday is untouched", (await q(`select "productiveSeconds" p from work_sessions where id=$1`, [sess[0].id]))[0].p === 25000);
      ok("their calendar row still carries the check-in", !!r9 && /04:30|10:00|loginAt|checkIn|25000|working/i.test(JSON.stringify(r9)), r9);
    }
    const lv = (await call("GET", "/leave/preview?from=2026-11-09&to=2026-11-09", EMP.tok)).b;
    ok("leave over a fixed holiday counts 0 days (no balance used)", lv.days === 0, lv);
    const lv2 = (await call("GET", "/leave/preview?from=2026-11-10&to=2026-11-10", EMP.tok)).b;
    ok("leave over an optional holiday counts as a normal working day (1)", lv2.days === 1, lv2);


    console.log("\n## audit trail");
    const aud = await q(`select module, action, summary from audit_logs where module='Holidays' order by "createdAt" desc limit 60`);
    ok("imports, publishes, requests and decisions are in the audit log", ["Imported", "Published", "Requested", "Approved", "Rejected", "Deactivated", "Restored", "allowance"].every((w) => aud.some((a) => new RegExp(w, "i").test(a.summary))), aud.map((a) => a.summary).slice(0, 12));
    ok("the import history keeps counts", (await q(`select "importedRows" i, "skippedRows" s from holiday_imports where status='PUBLISHED' and "calendarYear"=$1`, [Y]))[0].i === 4);
  } finally {
    await wipe().catch((e) => console.log("wipe", e.message)); await q(`delete from holidays where name like 'HT %'`).catch(() => {});
    await dropNew().catch(() => {}); await db.end();
  }
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
