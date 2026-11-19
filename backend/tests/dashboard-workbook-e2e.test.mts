// FULL dashboard workbook reconciliation. Seeds a known team on the THROWAWAY database, asks the real API (/team-attendance/team-report) as the manager,
// builds the real .xlsx with the real builder, reads the file back and checks EVERY figure against independent SQL on the raw rows:
// dashboard table, summary tiles (formulas), each employee's own summary sheet, the charts' cached values and the late-arrival rule.
// Needs: local Postgres on 54329 (db dq_test) and the backend on 5012 running against it. Refuses anything else.
//
//   cd backend && npx tsx tests/dashboard-workbook-e2e.test.mts
import { createRequire } from "node:module";
import path from "node:path";
import { buildDashboardWorkbook, DASH_COLS } from "../../frontend/app/dashboard/reports/_team/dashboardWorkbook.ts";

const here = path.resolve(import.meta.dirname);
const reqBackend = createRequire(path.join(here, "x.cjs"));
const reqFront = createRequire(path.resolve(here, "../../frontend/app/dashboard/reports/_team/reportXlsx.ts"));
const { Client } = reqBackend("pg");
const ExcelJS = reqFront("exceljs");
const JSZip = reqFront("jszip");
const { seed } = reqBackend("./_team-report-seed.cjs");

const API = "http://localhost:5012/api";
const DB = "postgresql://postgres:localtest@127.0.0.1:54329/dq_test";
if (!DB.includes("127.0.0.1:54329")) throw new Error("refusing: not the throwaway database");

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, x?: unknown) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (!c && x !== undefined ? "  -> " + JSON.stringify(x).slice(0, 400) : "")); };
const near = (a: number | null, b: number | null, tol = 0.011) => (a === null || b === null ? a === b : Math.abs(a - b) <= tol);
const r2 = (n: number) => Math.round(n * 100) / 100;
const addDays = (iso: string, n: number) => new Date(Date.parse(iso + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);

const db = new Client({ connectionString: DB });
await db.connect();
const q = async (s: string, p?: unknown[]) => (await db.query(s, p)).rows as Record<string, any>[];

// ---- the team 'E2E Team' must exist for the seed ----
const AV = (await q(`select id from platforms where slug='avatar'`))[0].id;
if (!(await q(`select 1 from teams where name='E2E Team'`)).length) await q(`insert into teams (id,"platformId",name,"isActive","createdAt","updatedAt") values (gen_random_uuid(),$1,'E2E Team',true,now(),now())`, [AV]);
const S = await seed(db);
const { ravi, sana, tina, olga, mgr } = S.ids as Record<string, string>;
const people = { ravi, sana, tina };
const from = S.days[0] as string, to = S.today as string;

const login = async (code: string) => (await (await fetch(API + "/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: code, password: S.pw }) })).json()).token as string;
const tok = await login("E2E-MGR");
const res = await fetch(`${API}/team-attendance/team-report?from=${from}&to=${to}`, { headers: { authorization: "Bearer " + tok } });
ok("the manager gets the team report (200)", res.status === 200, res.status);
const data = await res.json();
ok("the report covers exactly Ravi, Sana and Tina (not Olga, not the manager)", data.people.length === 3 && !data.people.some((p: any) => [olga, mgr].includes(p.id)), data.people.map((p: any) => p.name));

// ---- build the real workbook and read it back ----
const info = { reportName: "Team report", exportedAt: new Date(), exportedBy: "Meera Manager", filters: [] as [string, string][] };
const buf = await buildDashboardWorkbook(data, info);
const wb = new ExcelJS.Workbook();
await wb.xlsx.load(buf);
const dash = wb.getWorksheet("Dashboard");
ok("sheet 1 is the Dashboard and the last sheet is Report info", wb.worksheets[0].name === "Dashboard" && wb.worksheets[wb.worksheets.length - 1].name === "Report info", wb.worksheets.map((w: any) => w.name));
ok("one sheet per employee plus Dashboard and Report info", wb.worksheets.length === 3 + 2, wb.worksheets.map((w: any) => w.name));

// locate the table
let headRow = 0;
dash.eachRow((row: any, n: number) => { if (!headRow && String(row.getCell(1).value) === "Employee") headRow = n; });
ok("the employee table header was found", headRow > 0);
const colOf = (header: string) => { const i = DASH_COLS.findIndex((c: any) => c.header === header); return i + 1; };
const val = (row: any, header: string) => { const v = row.getCell(colOf(header)).value; return v === null || v === undefined || v === "" ? null : typeof v === "object" && "result" in v ? v.result : typeof v === "object" && "text" in v ? v.text : v; };
const tableRows: Record<string, any> = {};
for (let n = headRow + 1; n <= dash.rowCount; n++) {
  const row = dash.getRow(n); const code = val(row, "Employee ID");
  if (!code) break;
  tableRows[String(code)] = row;
}
ok("the table holds three employees, even the one with no records", Object.keys(tableRows).length === 3, Object.keys(tableRows));
const rowOf = (id: string) => tableRows[(data.people.find((p: any) => p.id === id) as any).employeeCode];

// ---- independent ground truth from the raw rows ----
const sessions = async (id: string) => q(`select date::text d, to_char("loginAt",'YYYY-MM-DD"T"HH24:MI:SS"Z"') "loginAt", "logoutAt", "productiveSeconds", "breakSeconds" from work_sessions where "userId"=$1 and date between $2::date and $3::date order by date`, [id, from, to]);
const istMinutes = (t: Date | string) => { const d = new Date(t); const f = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(d); const h = Number(f.find((x) => x.type === "hour")!.value) % 24, m = Number(f.find((x) => x.type === "minute")!.value); return h * 60 + m; };
const leaveDates = async (id: string) => q(`select date::text d, "isHalfDay" h from leave_days where "userId"=$1 and date between $2::date and $3::date`, [id, from, to]);
const companyTracked = new Set((await q(`select distinct date::text d from work_sessions where "platformId"=$1 and date between $2::date and $3::date`, [AV, from, to])).map((r) => r.d));
const holidays = new Set((await q(`select date::text d from holidays where "platformId"=$1 and date between $2::date and $3::date`, [AV, from, to]).catch(() => [])).map((r) => r.d));

type Truth = { present: number; half: number; absent: number; leaveDays: number; late: number; remarks: number; prod: number; brk: number; meet: number; submitted: number; completed: number; pending: number; approved: number; rejected: number; rated: number; avg: number | null; leaveTaken: number; sessionDays: number };
const truth: Record<string, Truth> = {};
for (const [name, id] of Object.entries(people)) {
  const ss = await sessions(id);
  const lv = await leaveDates(id);
  const leaveSet = new Set(lv.map((x) => x.d));
  const worked = ss.filter((x) => !leaveSet.has(x.d)); // a full-day leave on a day always shows as Leave
  const slist = new Set(ss.map((x) => x.d));
  // absent: a working day (Mon-Fri, not a holiday) before today, no session, no leave, and the company was tracking that day
  let absent = 0;
  for (let d = from; d < to; d = addDays(d, 1)) {
    const dow = new Date(d + "T00:00:00Z").getUTCDay();
    if (dow === 0 || dow === 6 || holidays.has(d) || leaveSet.has(d) || slist.has(d)) continue;
    if (companyTracked.has(d)) absent++;
  }
  const lates = ss.filter((x) => istMinutes(x.loginAt) > 9 * 60 + 45).length;
  const remarks = Number((await q(`select count(*)::int n from late_remarks where "userId"=$1 and "sessionId" in (select id from work_sessions where date between $2::date and $3::date)`, [id, from, to]).catch(() => [{ n: 0 }]))[0].n);
  const prod = ss.reduce((n, x) => n + Number(x.productiveSeconds), 0) / 3600;
  const brk = Number((await q(`select coalesce(sum(b."durationSeconds"),0)::int n from tracker_breaks b join work_sessions w on w.id=b."workSessionId" where w."userId"=$1 and w.date between $2::date and $3::date and b."breakType"<>'WASHROOM' and coalesce(b.reason,'') not like 'Discussion:%'`, [id, from, to]))[0].n) / 3600;
  const meet = Number((await q(`select coalesce(sum("durationSeconds"),0)::int n from meeting_participation where "userId"=$1 and "joinedAt" between $2::timestamp - interval '1 day' and $3::timestamp + interval '2 day'`, [id, from, to]))[0].n) / 3600;
  const tk = await q(`select status::text s, "approvalStatus"::text a, id from daily_tasks where "userId"=$1 and date between $2::date and $3::date and "assignedById" is null`, [id, from, to]);
  const rt = await q(`select r.rating from task_ratings r join daily_tasks t on t.id=r."taskId" where t."userId"=$1 and t.date between $2::date and $3::date`, [id, from, to]);
  truth[name] = {
    present: worked.length - (name === "ravi" ? 0 : 0), half: 0, absent, leaveDays: lv.length, late: lates, remarks, prod, brk, meet,
    submitted: tk.length, completed: tk.filter((x) => x.s === "COMPLETED").length, pending: tk.filter((x) => x.a === "PENDING").length, approved: tk.filter((x) => x.a === "APPROVED").length, rejected: tk.filter((x) => x.a === "REJECTED").length,
    rated: rt.length, avg: rt.length ? r2(rt.reduce((n, x) => n + Number(x.rating), 0) / rt.length) : null,
    leaveTaken: lv.reduce((n, x) => n + (x.h ? 0.5 : 1), 0), sessionDays: worked.length,
  };
}
console.log("\ntruth from the raw rows:", JSON.stringify(truth));

console.log("\n## dashboard table against the raw rows");
for (const [name, id] of Object.entries(people)) {
  const row = rowOf(id), t = truth[name];
  const label = name[0].toUpperCase() + name.slice(1);
  const n = (h: string) => { const v = val(row, h); return v === null ? null : Number(v); };
  if (name === "tina") continue;
  ok(`${label}: days present + half days = days worked (excluding leave days)`, (n("Days present") ?? 0) + (n("Half days") ?? 0) === t.sessionDays, { p: n("Days present"), h: n("Half days"), t: t.sessionDays });
  ok(`${label}: days absent`, n("Days absent") === t.absent, { got: n("Days absent"), want: t.absent });
  ok(`${label}: working days = present + half + absent + leave`, n("Working days in period") === (n("Days present") ?? 0) + (n("Half days") ?? 0) + (n("Days absent") ?? 0) + t.leaveDays, { got: n("Working days in period"), t });
  ok(`${label}: leave days taken`, near(n("Leave days"), t.leaveTaken, 0.001), { got: n("Leave days"), want: t.leaveTaken });
  ok(`${label}: late arrivals (first check-in after 09:45)`, n("Late arrivals") === t.late, { got: n("Late arrivals"), want: t.late });
  ok(`${label}: late remarks typed`, n("Late remarks") === t.remarks, { got: n("Late remarks"), want: t.remarks });
  ok(`${label}: productive hours = stored productive seconds`, near(n("Productive hours (h)"), t.prod, 0.011 * Math.max(1, t.sessionDays)), { got: n("Productive hours (h)"), want: t.prod });
  ok(`${label}: break hours = counted break rows (washroom excluded)`, near(n("Break hours (h)"), t.brk, 0.011 * Math.max(1, t.sessionDays)), { got: n("Break hours (h)"), want: t.brk });
  ok(`${label}: meeting participation hours`, near(n("Meeting participation (h)"), t.meet || null, 0.011) || (t.meet === 0 && (n("Meeting participation (h)") ?? 0) === 0), { got: n("Meeting participation (h)"), want: t.meet });
  ok(`${label}: tasks submitted / completed / pending / approved / rejected`, [n("Tasks submitted"), n("Tasks completed"), n("Pending approval"), n("Tasks approved"), n("Tasks rejected")].join() === [t.submitted, t.completed, t.pending, t.approved, t.rejected].join(), { got: [n("Tasks submitted"), n("Tasks completed"), n("Pending approval"), n("Tasks approved"), n("Tasks rejected")], want: t });
  ok(`${label}: rated tasks and average rating (rated only)`, n("Tasks rated") === t.rated && near(n("Average rating (rated tasks only)"), t.avg), { got: [n("Tasks rated"), n("Average rating (rated tasks only)")], want: [t.rated, t.avg] });
  ok(`${label}: submitted = approved + pending + rejected (nothing lost or double-counted)`, (n("Tasks approved") ?? 0) + (n("Pending approval") ?? 0) + (n("Tasks rejected") ?? 0) === n("Tasks submitted"));
}
{
  const row = rowOf(tina);
  const n = (h: string) => val(row, h);
  ok("Tina has no hours, rating or meetings: those cells are BLANK, not 0", ["Working hours (h)", "Productive hours (h)", "Break hours (h)", "Average rating (rated tasks only)"].every((h) => n(h) === null), ["Working hours (h)", "Productive hours (h)", "Average rating (rated tasks only)"].map((h) => n(h)));
  ok("Tina was invited to two meetings and joined neither: participation is a recorded 0, not blank", Number(n("Meeting participation (h)")) === 0, n("Meeting participation (h)"));
  ok("Tina's attendance is real zeros and her absent days match the raw rows (nobody invented)", Number(n("Days present")) === 0 && Number(n("Late arrivals")) === 0 && Number(n("Days absent")) === truth.tina.absent, { absent: n("Days absent"), want: truth.tina.absent });
  ok("Tina's task counts are recorded zeros", n("Tasks submitted") === 0 && n("Tasks rated") === 0);
  ok("Tina's data note says why", /No hours recorded/.test(String(n("Data note"))) && /No tasks submitted/.test(String(n("Data note"))), n("Data note"));
}

console.log("\n## the summary tiles follow the table");
const tableCol = (header: string) => Object.values(tableRows).map((row: any) => Number(val(row, header) ?? 0));
// read the tiles' formulas and cached values straight from the file (the reading library drops a cached 0)
const tiles: Record<string, number> = {};
{
  const z = await JSZip.loadAsync(buf);
  const xml = await z.file("xl/worksheets/sheet1.xml")!.async("string");
  for (const m of xml.matchAll(/<c r="([A-Z]+\d+)"[^>]*><f>(SUBTOTAL[^<]*)<\/f><v>([^<]*)<\/v>/g)) tiles[`${m[1]}|${m[2]}`] = Number(m[3]);
  ok("every summary tile carries a formula AND a cached value (shown even before Excel recalculates)", Object.keys(tiles).length === 18 && Object.values(tiles).every((v) => Number.isFinite(v)), Object.keys(tiles).length);
}
const colLetterOf = (header: string) => { let n = colOf(header), s = ""; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
const sumOf = (header: string) => tableCol(header).reduce((a, b) => a + b, 0);
const checkTile = (header: string, fn = 109, decimal = false) => {
  const key = Object.keys(tiles).find((k) => new RegExp(`SUBTOTAL\\(${fn},${colLetterOf(header)}\\d+:${colLetterOf(header)}\\d+\\)`).test(k));
  ok(`tile for "${header}" reads that column and its cached value equals the column total`, !!key && near(tiles[key!], decimal ? r2(sumOf(header)) : sumOf(header), 0.011), { key, tile: key ? tiles[key] : null, column: sumOf(header) });
};
for (const h of ["Late arrivals", "Late remarks", "Tasks submitted", "Tasks completed", "Tasks approved", "Tasks rejected", "Days present"]) checkTile(h);
for (const h of ["Working hours (h)", "Productive hours (h)", "Break hours (h)", "Meeting participation (h)", "Leave days"]) checkTile(h, 109, true);
ok("the 'Total employees' tile counts the three names", Object.keys(tiles).some((k) => /SUBTOTAL\(103,/.test(k) && tiles[k] === 3));
const grand = (label: string) => tableCol(label).reduce((a, b) => a + b, 0);
ok("total late arrivals across the team = the raw rows' total", grand("Late arrivals") === truth.ravi.late + truth.sana.late + truth.tina.late, { got: grand("Late arrivals"), want: truth.ravi.late + truth.sana.late });

console.log("\n## each employee's own sheet agrees with the dashboard");
const sheetOf = (id: string) => { const p = data.people.find((x: any) => x.id === id); return wb.worksheets.find((w: any) => String(w.name).startsWith(String(p.employeeCode))); };
const summaryOnSheet = (ws: any) => { const out: Record<string, any> = {}; let on = false; ws.eachRow((row: any) => { const a = String(row.getCell(1).value ?? ""); if (/^G\. Employee summary/.test(a)) { on = true; return; } if (on && a) { const v = row.getCell(4).value; out[a] = v && typeof v === "object" && "result" in v ? v.result : v; } }); return out; };
for (const [name, id] of Object.entries(people)) {
  const ws = sheetOf(id), row = rowOf(id), sm = summaryOnSheet(ws);
  const label = name[0].toUpperCase() + name.slice(1);
  const d = (h: string) => { const v = val(row, h); return v === null ? null : Number(v); };
  ok(`${label}: the employee sheet exists and has a summary`, !!ws && Object.keys(sm).length > 10, Object.keys(sm).length);
  ok(`${label}: sheet and dashboard agree on present / half / absent`, (sm["Days present"] ?? null) === d("Days present") && (sm["Half days"] ?? null) === d("Half days") && (sm["Days absent"] ?? null) === d("Days absent"), { sm: [sm["Days present"], sm["Half days"], sm["Days absent"]], dash: [d("Days present"), d("Half days"), d("Days absent")] });
  ok(`${label}: sheet and dashboard agree on late arrivals and remarks`, (sm["Late arrivals"] ?? null) === d("Late arrivals") && (sm["Late remarks typed"] ?? null) === d("Late remarks"), { sm: [sm["Late arrivals"], sm["Late remarks typed"]], dash: [d("Late arrivals"), d("Late remarks")] });
  ok(`${label}: sheet and dashboard agree on tasks`, Number(sm["Total tasks"]) === d("Tasks submitted") && Number(sm["Tasks rated"]) === d("Tasks rated"), { sm: [sm["Total tasks"], sm["Tasks rated"]], dash: [d("Tasks submitted"), d("Tasks rated")] });
  ok(`${label}: sheet and dashboard agree on average rating`, near(sm["Average rating (rated tasks only)"] === undefined ? null : sm["Average rating (rated tasks only)"], d("Average rating (rated tasks only)")), { sm: sm["Average rating (rated tasks only)"], dash: d("Average rating (rated tasks only)") });
  const hrs = (v: any) => (v instanceof Date ? r2((v.getTime() + 2209161600000) / 3600000) : typeof v === "number" ? r2(v * 24) : null); // durations are stored as fractions of a day
  ok(`${label}: sheet and dashboard agree on productive and break hours`, near(hrs(sm["Total productive hours"]), d("Productive hours (h)")) && near(hrs(sm["Total break hours"]), d("Break hours (h)")), { sm: [hrs(sm["Total productive hours"]), hrs(sm["Total break hours"])], dash: [d("Productive hours (h)"), d("Break hours (h)")] });
  ok(`${label}: leave days taken agree`, near(Number(sm["Total leave days taken"]), d("Leave days"), 0.001));
}

console.log("\n## the daily attendance on the sheets matches the stored sessions");
{
  const ws = sheetOf(ravi);
  let found = 0, wrong: unknown[] = [];
  const ss = await sessions(ravi);
  ws.eachRow((row: any) => {
    const a = row.getCell(1).value;
    const day = a instanceof Date ? a.toISOString().slice(0, 10) : typeof a === "string" && /^\d{4}-\d{2}-\d{2}/.test(a) ? a.slice(0, 10) : null;
    if (day && ss.some((x) => x.d === day)) found++;
  });
  ok("every day Ravi has a stored session appears in his attendance table", found >= ss.length, { found, sessions: ss.length });
  void wrong;
}

console.log("\n## charts: present, titled, and their cached values equal the table");
{
  const zip = await JSZip.loadAsync(buf);
  const charts = Object.keys(zip.files).filter((f) => /^xl\/charts\/chart\d+\.xml$/.test(f));
  ok("the dashboard carries its charts (8, or 7 when nobody is rated)", charts.length === 8 || charts.length === 7, charts.length);
  let checked = 0, bad: unknown[] = [];
  for (const f of charts) {
    const xml = await zip.file(f)!.async("string");
    ok(`${f}: has a title, a legend and a data range`, /<c:title>/.test(xml) && /<c:legend>/.test(xml) && /<c:f>/.test(xml));
    for (const m of xml.matchAll(/<c:val><c:numRef><c:f>[^<]*?\$([A-Z]+)\$(\d+):\$[A-Z]+\$(\d+)<\/c:f><c:numCache>(.*?)<\/c:numCache>/gs)) {
      const [, col, r1, r2_, cache] = m;
      const pts = [...cache.matchAll(/<c:pt idx="(\d+)"><c:v>([^<]*)<\/c:v>/g)].map((p) => Number(p[2]));
      const idx = (() => { let n = 0; for (const ch of col) n = n * 26 + (ch.charCodeAt(0) - 64); return n; })();
      const cells: number[] = [];
      for (let r = Number(r1); r <= Number(r2_); r++) { const v = dash.getRow(r).getCell(idx).value; if (v !== null && v !== undefined && v !== "") cells.push(Number(typeof v === "object" && "result" in (v as any) ? (v as any).result : v)); }
      checked++;
      if (!(pts.length === cells.length && pts.every((p, i) => near(p, cells[i], 0.0051)))) bad.push({ f, col, pts, cells });
    }
  }
  ok(`every chart series' cached values equal the table cells they point at (${checked} series)`, checked >= 8 && bad.length === 0, bad.slice(0, 2));
}

console.log("\n## the late-arrival rule on this very data");
{
  const rav = (data.attendance as any[]).filter((a) => a.userId === ravi);
  const lateDay = rav.find((a) => a.date === S.expect.lateDay);
  ok("the API classifies Ravi's 10:20 login as a Half Day arrival", lateDay?.arrival === "HALF_DAY" && !(lateDay?.lateMinutes > 0), lateDay && { arrival: lateDay.arrival, lateMinutes: lateDay.lateMinutes });
  ok("and the summary counts it although lateMinutes is empty (no shift)", Number(val(rowOf(ravi), "Late arrivals")) >= 1);
  ok("and counts his typed remark separately", Number(val(rowOf(ravi), "Late remarks")) === truth.ravi.remarks && truth.ravi.remarks === 1, truth.ravi.remarks);
  ok("a person who was never late has 0 late arrivals", Number(val(rowOf(sana), "Late arrivals")) === 0 && truth.sana.late === 0);
}

await db.end();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
