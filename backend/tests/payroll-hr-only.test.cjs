// Payroll management is HR only; Payroll Oversight is gone from the Admin menu. Real HTTP, THROWAWAY database only.
//   cd backend && TEST_DATABASE_URL=... TEST_API=http://localhost:5012/api node tests/payroll-hr-only.test.cjs
require("dotenv").config({ path: require("node:path").join(__dirname, "..", ".env") });
const { Client } = require("pg"); const bcrypt = require("bcryptjs"); const fs = require("node:fs"); const path = require("node:path");
const API = process.env.TEST_API ?? "http://localhost:5012/api";
require("./_guard.cjs").assertTestDb(process.env.TEST_DATABASE_URL);
const call = async (m, p, t, b) => { const r = await fetch(API + p, { method: m, headers: { "content-type": "application/json", ...(t ? { authorization: "Bearer " + t } : {}) }, body: b !== undefined ? JSON.stringify(b) : undefined }); const x = await r.text(); let j; try { j = JSON.parse(x); } catch { j = x; } return { s: r.status, b: j }; };
let pass = 0, fail = 0; const ok = (n, c, x) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  -> " + String(JSON.stringify(x)).slice(0, 300))); };
const PW = "Phr@12345678";
(async () => {
  const db = new Client({ connectionString: process.env.TEST_DATABASE_URL }); await db.connect(); const q = async (s, p) => (await db.query(s, p)).rows;
  const A = (await q(`select id from platforms where slug='avatar'`))[0].id; const hash = await bcrypt.hash(PW, 10);
  const wipe = async () => { await q(`delete from salary_slips where "userId" in (select id from users where "employeeCode" like 'PHR-%')`).catch(() => {}); await q(`delete from company_access where "userId" in (select id from users where "employeeCode" like 'PHR-%')`); await q(`update audit_logs set "actorId"=null where "actorId" in (select id from users where "employeeCode" like 'PHR-%')`).catch(() => {}); await q(`delete from users where "employeeCode" like 'PHR-%'`); };
  await wipe();
  const mk = async (code, role) => { const id = (await q(`insert into users (id,"platformId",email,"passwordHash","firstName","lastName","employeeCode",role,status,"monthlySalary","mustChangePassword","trackerAccessEnabled","onboardingStatus","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,$4,'Phr',$4,$5,'ACTIVE',50000,false,true,'ACTIVE',now(),now()) returning id`, [A, code.toLowerCase() + "@x.test", hash, code, role]))[0].id; if (role === "ADMIN") await q(`insert into company_access (id,"userId","platformId","createdAt") values (gen_random_uuid(),$1,null,now())`, [id]); const r = await fetch(API + "/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: code, password: PW }) }); return { id, tok: (await r.json()).token }; };
  try {
    const ADM = await mk("PHR-ADM", "ADMIN"), HR = await mk("PHR-HR", "HR"), MGR = await mk("PHR-MGR", "MANAGER"), EMP = await mk("PHR-EMP", "EMPLOYEE");
    const salaryBefore = (await q(`select sum("monthlySalary")::int s from users where "employeeCode" like 'PHR-%'`))[0].s;
    const m = new Date(), mo = m.getUTCMonth() + 1, yr = m.getUTCFullYear();
    console.log("## server: Admin is refused every payroll-management call");
    const probes = [["GET", `/payroll/month?month=${mo}&year=${yr}`], ["GET", "/payroll/teams"], ["POST", "/payroll/generate", { month: mo, year: yr }], ["POST", "/payroll/release", { month: mo, year: yr }], ["POST", "/payroll/unrelease", { month: mo, year: yr }], ["POST", "/payroll/approve", { month: mo, year: yr }], ["POST", "/payroll/upload", {}], ["POST", "/payroll/publish-month", { month: mo, year: yr }], ["GET", "/payroll/00000000-0000-0000-0000-000000000000/review"], ["POST", "/payroll/00000000-0000-0000-0000-000000000000/delete"]];
    for (const [meth, p, b] of probes) ok(`Admin ${meth} ${p.split("?")[0]} -> 403`, (await call(meth, p, ADM.tok, b)).s === 403, (await call(meth, p, ADM.tok, b)).s);
    console.log("\n## HR keeps payroll management");
    ok("HR opens the month list (200)", (await call("GET", `/payroll/month?month=${mo}&year=${yr}`, HR.tok)).s === 200);
    ok("HR opens the team list (200)", (await call("GET", "/payroll/teams", HR.tok)).s === 200);
    console.log("\n## other roles stay refused");
    for (const [n, u] of [["Manager", MGR], ["Employee", EMP]]) ok(`${n} cannot open the month list (403)`, (await call("GET", `/payroll/month?month=${mo}&year=${yr}`, u.tok)).s === 403);
    console.log("\n## everybody still reaches their OWN payslips (an Admin is a person too)");
    for (const [n, u] of [["Admin", ADM], ["HR", HR], ["Employee", EMP]]) ok(`${n}: /payroll/me answers (200)`, (await call("GET", "/payroll/me", u.tok)).s === 200);
    const slip = (await q(`insert into salary_slips (id,"platformId","userId",month,year,"createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,$4,now(),now()) returning id`, [A, ADM.id, mo, yr]).catch((e) => { console.log("   (slip insert skipped: " + e.message.slice(0, 80) + ")"); return null; }));
    if (slip) { const r = await fetch(API + `/payroll/${slip[0].id}/download`, { headers: { authorization: "Bearer " + ADM.tok } }); ok("an Admin cannot open their own UNPUBLISHED slip (same as any employee)", r.status === 403 || r.status === 404 || r.status === 409, r.status); ok("an Admin cannot open another person's slip", (await fetch(API + `/payroll/${slip[0].id}/download`, { headers: { authorization: "Bearer " + EMP.tok } })).status >= 400); }
    console.log("\n## the menu and pages");
    const layout = fs.readFileSync(path.join(__dirname, "..", "..", "frontend", "app", "dashboard", "layout.tsx"), "utf8");
    ok("'Payroll Oversight' is not in the sidebar any more", !/Payroll Oversight/.test(layout));
    ok("HR still has its Payroll entry", /label: "Payroll", ready: true, roles: \["HR"\]/.test(layout));
    ok("no Admin-only payroll entry remains", !/href: "\/dashboard\/payroll"[^\n]*roles: \["ADMIN"\]/.test(layout));
    ok("the payroll pages allow HR only", /me\?\.role === "HR"/.test(fs.readFileSync(path.join(__dirname, "..", "..", "frontend", "app", "dashboard", "payroll", "page.tsx"), "utf8")) && /me\.role !== "HR"/.test(fs.readFileSync(path.join(__dirname, "..", "..", "frontend", "app", "dashboard", "payroll", "approve", "page.tsx"), "utf8")));
    console.log("\n## nothing was changed");
    ok("salaries are untouched", (await q(`select sum("monthlySalary")::int s from users where "employeeCode" like 'PHR-%'`))[0].s === salaryBefore);
  } finally { await wipe().catch((e) => console.log("wipe", e.message)); await db.end(); }
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
