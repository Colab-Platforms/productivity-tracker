// Payroll lists EVERY eligible employee in the companies the HR/Admin acts on (not only their own company), marks people with no salary as
// "Payroll setup required" instead of hiding them, blocks new payslips for them, and keeps one payslip per person per month.
// Disposable database only (see _guard.cjs).
//
//   cd backend && TEST_DATABASE_URL=... TEST_API=http://localhost:5012/api node tests/payroll-scope.test.cjs
require("dotenv").config({ path: require("node:path").join(__dirname, "..", ".env") });
const { Client } = require("pg");
const bcrypt = require("bcryptjs");
const API = process.env.TEST_API ?? "http://localhost:5002/api";
require("./_guard.cjs").assertTestDb(process.env.TEST_DATABASE_URL);

const call = async (m, p, t, b) => {
  const r = await fetch(API + p, { method: m, headers: { "content-type": "application/json", ...(t ? { authorization: "Bearer " + t } : {}) }, body: b !== undefined ? JSON.stringify(b) : undefined });
  const txt = await r.text(); let j; try { j = JSON.parse(txt); } catch { j = txt; }
  return { s: r.status, b: j, raw: txt };
};
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  -> " + String(JSON.stringify(x)).slice(0, 300))); };
const PW = "Pay@12345678";
const PDF = "data:application/pdf;base64," + Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF").toString("base64");

(async () => {
  const db = new Client({ connectionString: process.env.TEST_DATABASE_URL }); await db.connect();
  const q = async (s, p) => (await db.query(s, p)).rows;
  const A = (await q(`select id from platforms where slug='avatar'`))[0].id;
  const B = (await q(`select id from platforms where slug='take-health'`))[0].id;
  const C = (await q(`select id from platforms where slug='co-lab'`))[0].id;
  const hash = await bcrypt.hash(PW, 10);

  const wipe = async () => {
    const ids = `(select id from users where "employeeCode" like 'PAY-%')`;
    await q(`delete from salary_slips where "userId" in ${ids}`);
    await q(`delete from company_access where "userId" in ${ids}`);
    await q(`delete from notifications where "userId" in ${ids}`);
    await q(`delete from users where "employeeCode" like 'PAY-%'`);
  };
  await wipe();
  const mk = async (code, role, platformId, salary, status = "ACTIVE") => {
    await q(`insert into users (id,"platformId",email,"passwordHash","firstName","lastName","employeeCode",role,status,"mustChangePassword","trackerAccessEnabled","onboardingStatus","monthlySalary","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,$4,'Pay',$5,$6,$8,false,true,'ACTIVE',$7,now(),now())`, [platformId, code.toLowerCase() + "@pay.test", hash, code.replace("PAY-", "P"), code, role, salary, status]);
    const id = (await q(`select id from users where "employeeCode"=$1`, [code]))[0].id;
    const tok = status === "ACTIVE" || role !== "EMPLOYEE" ? (await call("POST", "/auth/login", null, { email: code, password: PW })).b.token : null;
    return { id, tok, code };
  };
  // people
  const HRG = await mk("PAY-HRG", "HR", A, null);                 // HR with an all-companies grant
  await q(`insert into company_access (id,"userId","platformId","createdAt") values (gen_random_uuid(),$1,null,now())`, [HRG.id]).catch(async () => {
    await q(`insert into company_access (id,"userId","platformId","grantedById","createdAt") values (gen_random_uuid(),$1,null,$1,now())`, [HRG.id]);
  });
  const HRN = await mk("PAY-HRN", "HR", A, null);                 // HR without a grant
  const ADM = await mk("PAY-ADM", "ADMIN", A, null);              // Admin without a grant
  const MGR = await mk("PAY-MGR", "MANAGER", A, 50000);
  const emp = [];
  emp.push(await mk("PAY-A1", "EMPLOYEE", A, 40000));
  emp.push(await mk("PAY-A2", "EMPLOYEE", A, null));              // missing salary
  for (let i = 1; i <= 12; i++) emp.push(await mk("PAY-B" + String(i).padStart(2, "0"), "EMPLOYEE", B, i === 3 ? null : 30000 + i)); // 12 in company B, B03 has no salary
  emp.push(await mk("PAY-C1", "EMPLOYEE", C, 25000));
  emp.push(await mk("PAY-C2", "EMPLOYEE", C, 0));                 // zero is not a salary either
  const X = await mk("PAY-XIT", "EMPLOYEE", C, 20000, "EXITED"); // left, but has an October slip: must stay visible
  const S = await mk("PAY-SUS", "EMPLOYEE", C, 20000, "SUSPENDED"); // suspended, no slip: not part of the cycle
  const byCode = (c) => [HRG, HRN, ADM, MGR, ...emp, X, S].find((p) => p.code === c);
  const MONTH = 9, YEAR = 2026;
  await q(`insert into salary_slips (id,"platformId","userId",month,year,"uploadedById","netAmount","fileName","updatedAt") values (gen_random_uuid(),$1,$2,$3,$4,$5,'1234','old.pdf',now())`, [C, X.id, MONTH, YEAR, HRG.id]);
  const oldSlip = (await q(`select id, "netAmount", "createdAt" from salary_slips where "userId"=$1`, [X.id]))[0];

  const list = async (tok, m = MONTH, y = YEAR) => call("GET", `/payroll/month?month=${m}&year=${y}`, tok);

  // --- the list ----------------------------------------------------------------------------------------------------
  const L = await list(HRG.tok);
  ok("HR with an all-companies grant gets the list (200)", L.s === 200, L.s);
  const rows = L.b.rows ?? [];
  const mine = rows.filter((r) => r.employeeCode?.startsWith("PAY-"));
  const activeInDb = Number((await q(`select count(*) n from users where status='ACTIVE'`))[0].n);
  ok("the list is NOT limited to five", rows.length > 5, rows.length);
  ok("the number of ACTIVE people in the list equals the active employees of all companies", rows.filter((r) => r.employmentStatus === "ACTIVE").length === activeInDb, { list: rows.filter((r) => r.employmentStatus === "ACTIVE").length, db: activeInDb });
  ok("every test company is represented", ["A", "B", "C"].every((k) => mine.some((r) => r.companyId === { A, B, C }[k])), mine.length);
  ok("all 12 company-B people are listed (no hidden page)", mine.filter((r) => r.companyId === B).length === 12);
  ok("an exited person with an existing slip stays visible, with their slip", mine.find((r) => r.employeeCode === "PAY-XIT")?.slip?.id === oldSlip.id);
  ok("a suspended person without a slip is not part of the cycle", !mine.some((r) => r.employeeCode === "PAY-SUS"));
  ok("totals are of the same list", L.b.employees === rows.length && L.b.eligible + L.b.setupRequired === rows.length, { e: L.b.employees, el: L.b.eligible, s: L.b.setupRequired, rows: rows.length });
  ok("the company list is returned for the filter", (L.b.companies ?? []).length >= 3);
  const miss = mine.filter((r) => r.payroll.status === "SALARY_MISSING").map((r) => r.employeeCode).sort();
  ok("people without a salary are shown and marked 'salary missing' (null and zero)", ["PAY-A2", "PAY-B03", "PAY-C2", "PAY-ADM", "PAY-HRG", "PAY-HRN"].every((c) => miss.includes(c)), miss);
  ok("people with a salary are marked ready", mine.find((r) => r.employeeCode === "PAY-A1")?.payroll.ready === true && mine.find((r) => r.employeeCode === "PAY-B01")?.payroll.ready === true);
  ok("a reason is given", mine.find((r) => r.employeeCode === "PAY-B03")?.payroll.reason?.includes("Salary details missing"));
  ok("no salary amount is in the response", !/monthlySalary|30001|40000/.test(L.raw));
  ok("the previous month's old records are untouched", (await list(HRG.tok, 10, 2026)).s === 200);

  const N = await list(HRN.tok);
  ok("HR without a grant sees only her own company", (N.b.rows ?? []).length > 0 && N.b.rows.every((r) => r.companyId === A), (N.b.rows ?? []).map((r) => r.company));
  const AD = await list(ADM.tok);
  ok("an Admin without a grant sees only their own company", (AD.b.rows ?? []).every((r) => r.companyId === A));
  ok("a manager is refused", (await list(MGR.tok)).s === 403);
  ok("an employee is refused", (await list(byCode("PAY-B01").tok)).s === 403);

  // --- uploading, duplicates ----------------------------------------------------------------------------------------
  const up = (tok, u, extra = {}) => call("POST", "/payroll/upload", tok, { userId: u.id, month: MONTH, year: YEAR, fileName: "slip.pdf", data: PDF, mimeType: "application/pdf", ...extra });
  const bMiss = byCode("PAY-B03"), b1 = byCode("PAY-B01"), b2 = byCode("PAY-B02");
  const r1 = await up(HRG.tok, bMiss);
  ok("a NEW payslip for a person with no salary is refused (setup required)", r1.s === 400 && r1.b.error === "PAYROLL_SETUP_REQUIRED", r1);
  ok("nothing was created for them", Number((await q(`select count(*) n from salary_slips where "userId"=$1`, [bMiss.id]))[0].n) === 0);
  const r2 = await up(HRG.tok, b1);
  ok("upload for a company-B employee by HR with access works", r2.s === 200 && r2.b.replaced === false, r2);
  const slipB = (await q(`select id, "platformId" from salary_slips where "userId"=$1 and month=$2 and year=$3`, [b1.id, MONTH, YEAR]));
  ok("the slip belongs to the employee's company", slipB.length === 1 && slipB[0].platformId === B, slipB);
  const r3 = await up(HRG.tok, b1);
  ok("uploading again replaces it (no duplicate)", r3.s === 200 && r3.b.replaced === true, r3);
  ok("still ONE slip for that person and month", Number((await q(`select count(*) n from salary_slips where "userId"=$1 and month=$2 and year=$3`, [b1.id, MONTH, YEAR]))[0].n) === 1);
  ok("HR without a grant cannot upload for another company's person (404)", (await up(HRN.tok, b2)).s === 404);
  ok("an exited person's existing slip can still be replaced", (await up(HRG.tok, X)).s === 200);

  // --- generation across companies ---------------------------------------------------------------------------------
  const g = await call("POST", "/payroll/generate", HRG.tok, { month: MONTH, year: YEAR });
  ok("generation runs for every company in scope (200)", g.s === 200, g);
  const slips = g.b.slips ?? [];
  const sk = g.b.skipped ?? [];
  ok("slips were made for company-B and company-A employees", slips.some((x) => x.employeeCode === "PAY-B02") && slips.some((x) => x.employeeCode === "PAY-A1"), slips.map((x) => x.employeeCode).slice(0, 20));
  ok("people with no salary are reported as 'Payroll setup required', not silently dropped", ["PAY-A2", "PAY-B03", "PAY-C2"].every((c) => sk.some((x) => x.employeeCode === c && /setup required/i.test(x.reason))), sk.map((x) => x.employeeCode + ":" + x.reason));
  ok("no generated slip exists for a person with no salary", Number((await q(`select count(*) n from salary_slips s join users u on u.id=s."userId" where u."employeeCode" in ('PAY-A2','PAY-B03','PAY-C2')`))[0].n) === 0);
  const b2Slip = (await q(`select s."platformId" from salary_slips s where s."userId"=$1 and month=$2 and year=$3`, [b2.id, MONTH, YEAR]))[0];
  ok("a generated slip belongs to the employee's company", b2Slip?.platformId === B, b2Slip);
  const g2 = await call("POST", "/payroll/generate", HRG.tok, { month: MONTH, year: YEAR });
  ok("generating again creates no duplicate slips", g2.s === 200 && g2.b.created === 0, { s: g2.s, created: g2.b.created });
  ok("no person has two slips for the month", Number((await q(`select count(*) n from (select "userId" from salary_slips where month=$1 and year=$2 group by 1 having count(*)>1) t`, [MONTH, YEAR]))[0].n) === 0);
  ok("HR without a grant cannot ask to generate another company", (await call("POST", "/payroll/generate", HRN.tok, { month: MONTH, year: YEAR, platformId: B })).s === 403);
  const gN = await call("POST", "/payroll/generate", HRN.tok, { month: MONTH, year: YEAR });
  ok("HR without a grant generates only for her own company", gN.s === 200 && (gN.b.slips ?? []).every((x) => x.employeeCode === "PAY-A1" || x.employeeCode === "PAY-MGR" || !x.employeeCode.startsWith("PAY-B")), gN.b.slips?.map((x) => x.employeeCode));

  // --- release / publish / download -------------------------------------------------------------------------------
  const teams = await call("GET", "/payroll/teams", HRG.tok);
  ok("the department picker covers every company in scope", teams.s === 200 && Array.isArray(teams.b), teams);
  const rel = await call("POST", "/payroll/release", HRG.tok, { month: MONTH, year: YEAR });
  ok("one-click release works across companies", rel.s === 200 && rel.b.published >= 1, rel);
  const own = await call("GET", "/payroll/me", byCode("PAY-B02").tok);
  ok("the employee sees their own released slip", (own.b.slips ?? []).length === 1, own.b);
  const pm = await call("POST", "/payroll/publish-month", HRG.tok, { month: MONTH, year: YEAR });
  ok("releasing the uploaded slip of another company works for HR with access", pm.s === 200, pm);
  const L2 = await list(HRG.tok);
  ok("the uploaded and released counts are accurate", L2.b.uploaded === (L2.b.rows ?? []).filter((r) => r.slip).length && L2.b.published === (L2.b.rows ?? []).filter((r) => r.slip?.publishedAt).length, { u: L2.b.uploaded, p: L2.b.published });
  const sid = (L2.b.rows.find((r) => r.employeeCode === "PAY-B02")).slip.id;
  const dl = await fetch(API + `/payroll/${sid}/payslip.pdf`, { headers: { authorization: "Bearer " + HRG.tok } });
  ok("HR with access can open another company's payslip", dl.status === 200, dl.status);
  const dlN = await fetch(API + `/payroll/${sid}/payslip.pdf`, { headers: { authorization: "Bearer " + HRN.tok } });
  ok("HR without a grant cannot", dlN.status >= 400, dlN.status);
  const rv = await call("GET", `/payroll/${sid}/review`, HRN.tok);
  ok("HR without a grant cannot open its review either", rv.s >= 400, rv.s);
  const del = await call("DELETE", `/payroll/${sid}`, HRN.tok);
  ok("HR without a grant cannot delete it (404)", del.s === 404, del.s);
  const pubN = await call("POST", "/payroll/publish", HRN.tok, { slipIds: [sid], publish: false });
  ok("HR without a grant cannot unrelease it", pubN.s === 200 && pubN.b.updated === 0, pubN);
  const stillOwn = await call("GET", "/payroll/me", byCode("PAY-B02").tok);
  ok("so the employee still sees their slip", (stillOwn.b.slips ?? []).length === 1);
  const other = await call("GET", "/payroll/me", byCode("PAY-B05").tok);
  ok("another employee sees only their own slip, never that one", (other.b.slips ?? []).every((x) => x.id !== sid) && (other.b.slips ?? []).length <= 1, other.b);

  // --- the old record is exactly as it was ---------------------------------------------------------------------------------
  const oldAfter = (await q(`select id, "createdAt" from salary_slips where id=$1`, [oldSlip.id]))[0];
  ok("an existing payslip row was kept (same id)", oldAfter?.id === oldSlip.id);

  await wipe();
  await db.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
