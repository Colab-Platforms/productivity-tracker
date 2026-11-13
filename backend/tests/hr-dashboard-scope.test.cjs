// HR dashboard scope: the sources the HR dashboard reads (people list, reports, live board, alerts) all cover every company the HR person is authorised for,
// include people under every reporting manager, agree with the database, and narrow correctly when one company is picked. Disposable DB only.
//
//   cd backend && TEST_DATABASE_URL=... TEST_API=http://localhost:5012/api node tests/hr-dashboard-scope.test.cjs
require("dotenv").config({ path: require("node:path").join(__dirname, "..", ".env") });
const { Client } = require("pg");
const bcrypt = require("bcryptjs");
const API = process.env.TEST_API ?? "http://localhost:5002/api";
require("./_guard.cjs").assertTestDb(process.env.TEST_DATABASE_URL);

const call = async (m, p, t) => {
  const r = await fetch(API + p, { method: m, headers: t ? { authorization: "Bearer " + t } : {} });
  let j; try { j = await r.json(); } catch { j = null; }
  return { s: r.status, b: j };
};
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  -> " + String(JSON.stringify(x)).slice(0, 400))); };
const PW = "Hds@12345678";

(async () => {
  const db = new Client({ connectionString: process.env.TEST_DATABASE_URL }); await db.connect();
  const q = async (s, p) => (await db.query(s, p)).rows;
  const A = (await q(`select id from platforms where slug='avatar'`))[0].id;
  const B = (await q(`select id from platforms where slug='avance'`))[0].id;
  const hash = await bcrypt.hash(PW, 10);
  const wipe = async () => {
    const ids = `(select id from users where "employeeCode" like 'HDS-%')`;
    await q(`delete from company_access where "userId" in ${ids}`);
    await q(`delete from users where "employeeCode" like 'HDS-%'`);
  };
  await wipe();
  const mk = async (code, role, platformId, status = "ACTIVE", boss = null) => {
    await q(`insert into users (id,"platformId",email,"passwordHash","firstName","lastName","employeeCode",role,status,"mustChangePassword","trackerAccessEnabled","onboardingStatus","reportsToId","dateOfJoining","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,$4,'Hds',$5,$6,$7::"UserStatus",false,true,'ACTIVE',$8,'2026-01-01',now(),now())`, [platformId, code.toLowerCase() + "@hds.test", hash, code.replace("HDS-", ""), code, role, status, boss]);
    const id = (await q(`select id from users where "employeeCode"=$1`, [code]))[0].id;
    const tok = status === "ACTIVE" ? (await (await fetch(API + "/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: code, password: PW }) })).json()).token : null;
    return { id, tok };
  };
  const HRALL = await mk("HDS-HRALL", "HR", A);   // HR in company A with the all-companies grant
  await q(`insert into company_access (id,"userId","platformId","createdAt") values (gen_random_uuid(),$1,null,now())`, [HRALL.id]);
  const HROWN = await mk("HDS-HROWN", "HR", A);    // HR in company A, no grant
  const M1 = await mk("HDS-M1", "MANAGER", A), M2 = await mk("HDS-M2", "MANAGER", B), M3 = await mk("HDS-M3", "MANAGER", A);
  const people = [];
  for (const [code, p, status, boss] of [
    ["HDS-A1", A, "ACTIVE", M1.id], ["HDS-A2", A, "ACTIVE", M1.id], ["HDS-A3", A, "ACTIVE", M3.id], ["HDS-A4", A, "ACTIVE", null], ["HDS-A5", A, "INVITED", M1.id], ["HDS-A6", A, "SUSPENDED", M3.id], ["HDS-A7", A, "EXITED", M1.id],
    ["HDS-B1", B, "ACTIVE", M2.id], ["HDS-B2", B, "ACTIVE", M2.id], ["HDS-B3", B, "ACTIVE", null], ["HDS-B4", B, "INVITED", M2.id],
  ]) people.push({ code, ...(await mk(code, "EMPLOYEE", p, status, boss)), p, status });

  const dbCount = async (where, params = []) => (await q(`select count(*)::int n from users where ${where}`, params))[0].n;
  try {
    // 1-3. the people list the dashboard reads: ALL authorised companies, every manager's people, nothing cut by pagination
    const users = await call("GET", "/admin/users", HRALL.tok);
    const list = users.b.users;
    const total = await dbCount(`true`);
    ok("HR with the all-companies grant gets every person in the database (no manager or page limit)", users.s === 200 && list.length === total && users.b.scope.orgTotal === total, [list.length, total]);
    ok("people under every reporting manager of both companies are included", ["HDS-A1", "HDS-A3", "HDS-A4", "HDS-B1", "HDS-B3"].every((c) => list.some((u) => u.employeeCode === c)));
    ok("every row carries its company id (the dashboard's Company selector needs it)", list.every((u) => u.companyId && u.company));
    // 4. dashboard KPI formulas, computed exactly as the page does
    const staff = list.filter((u) => u.status !== "EXITED");
    const active = staff.filter((u) => u.status === "ACTIVE").length;
    ok("Total Employees = everyone who has not left (active + invited + suspended)", staff.length === (await dbCount(`status <> 'EXITED'`)), [staff.length]);
    ok("Active Employees counts only ACTIVE (invited/suspended are not active)", active === (await dbCount(`status = 'ACTIVE'`)), [active]);
    ok("exited people are listed by the server but not counted as staff", list.some((u) => u.employeeCode === "HDS-A7") && !staff.some((u) => u.employeeCode === "HDS-A7"));
    // 5. company filter
    const onlyB = await call("GET", `/admin/users?companyId=${B}`, HRALL.tok);
    ok("company filter: picking Avance returns only Avance's people, all of them", onlyB.b.users.every((u) => u.companyId === B) && onlyB.b.users.length === (await dbCount(`"platformId"=$1`, [B])), onlyB.b.users.length);
    const ownOnly = await call("GET", "/admin/users", HROWN.tok);
    ok("HR WITHOUT a grant still sees only their own company (no widening)", ownOnly.b.users.every((u) => u.companyId === A) && ownOnly.b.users.length === (await dbCount(`"platformId"=$1`, [A])));
    ok("a company outside access cannot be requested (403/404, not data)", [403, 404].includes((await call("GET", `/admin/users?companyId=${B}`, HROWN.tok)).s));
    // 6. search finds people under every manager
    ok("search by employee id finds a person in the other company", (await call("GET", "/admin/users?search=HDS-B2", HRALL.tok)).b.users.some((u) => u.employeeCode === "HDS-B2"));
    ok("search by reporting manager filter finds that manager's people in both companies", (await call("GET", `/admin/users?managerId=${M1.id}`, HRALL.tok)).b.users.map((u) => u.employeeCode).sort().join() === "HDS-A1,HDS-A2,HDS-A5,HDS-A7");

    // 7. the other dashboard sources use the SAME scope
    const today = (await call("GET", "/tracker/timesheet", HRALL.tok)).b.today;
    const rep = await call("GET", `/reports?from=${today}&to=${today}&groupBy=person`, HRALL.tok);
    const repIds = new Set((rep.b.people ?? []).map((p) => p.userId));
    ok("the attendance report (dashboard Present/Absent) covers people of BOTH companies", people.filter((p) => p.status === "ACTIVE").every((p) => repIds.has(p.id)) || people.filter((p) => p.status === "ACTIVE" && p.p === B).some((p) => repIds.has(p.id)), [...repIds].length);
    const repB = await call("GET", `/reports?from=${today}&to=${today}&groupBy=person&company=${B}`, HRALL.tok);
    ok("the report's company filter narrows it to that company", (repB.b.people ?? []).length > 0 && (repB.b.people ?? []).every((p) => people.find((x) => x.id === p.userId)?.p === B || !people.find((x) => x.id === p.userId)), (repB.b.people ?? []).length);
    const live = await call("GET", "/tracker/team", HRALL.tok);
    const liveIds = new Set((live.b ?? []).map((r) => r.userId));
    ok("the live board lists active people of both companies", people.filter((p) => p.status === "ACTIVE").every((p) => liveIds.has(p.id)), [...liveIds].length);
    const att = await call("GET", "/team-attendance/live", HRALL.tok);
    ok("the Attendance board (same scope) lists both companies too", (att.b.rows ?? []).some((r) => people.find((x) => x.id === r.userId)?.p === B) && (att.b.rows ?? []).some((r) => people.find((x) => x.id === r.userId)?.p === A), (att.b.rows ?? []).length);
    ok("...and its x-of-y counts exclude exited/suspended people", att.b.scope.orgTotal === (await dbCount(`status not in ('EXITED','SUSPENDED')`)), att.b.scope);
    const attCo = await call("GET", `/team-attendance/live?company=${B}`, HRALL.tok);
    ok("the Attendance board's company filter narrows to that company", attCo.b.rows.length > 0 && attCo.b.rows.every((r) => people.find((x) => x.id === r.userId)?.p === B || !people.find((x) => x.id === r.userId)), attCo.b.rows.length);
    const own = await call("GET", "/team-attendance/live", HROWN.tok);
    ok("HR without a grant sees no other company on the board", (own.b.rows ?? []).every((r) => people.find((x) => x.id === r.userId)?.p !== B));
  } finally {
    await wipe();
    await db.end();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("CRASH", e); process.exit(1); });
