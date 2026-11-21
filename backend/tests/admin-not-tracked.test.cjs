// Admins are not employees for attendance, productivity, headcount and reports, but still see everyone. Real HTTP, THROWAWAY database only.
//   cd backend && TEST_DATABASE_URL=... TEST_API=http://localhost:5012/api node tests/admin-not-tracked.test.cjs
require("dotenv").config({ path: require("node:path").join(__dirname, "..", ".env") });
const { Client } = require("pg");
const bcrypt = require("bcryptjs");
const API = process.env.TEST_API ?? "http://localhost:5012/api";
require("./_guard.cjs").assertTestDb(process.env.TEST_DATABASE_URL);
const call = async (m, p, t, b) => { const r = await fetch(API + p, { method: m, headers: { "content-type": "application/json", ...(t ? { authorization: "Bearer " + t } : {}) }, body: b !== undefined ? JSON.stringify(b) : undefined }); const x = await r.text(); let j; try { j = JSON.parse(x); } catch { j = x; } return { s: r.status, b: j }; };
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  -> " + String(JSON.stringify(x)).slice(0, 400))); };
const PW = "Ant@12345678";
const today = new Date().toISOString().slice(0, 10);
(async () => {
  const db = new Client({ connectionString: process.env.TEST_DATABASE_URL }); await db.connect();
  const q = async (s, p) => (await db.query(s, p)).rows;
  const A = (await q(`select id from platforms where slug='avatar'`))[0].id;
  const B = (await q(`select id from platforms where slug='co-lab'`))[0].id;
  const hash = await bcrypt.hash(PW, 10);
  const wipe = async () => {
    const ids = `(select id from users where "employeeCode" like 'ANT-%')`;
    await q(`delete from team_members where "userId" in ${ids}`); await q(`delete from teams where name like 'ANT-%'`);
    await q(`delete from tracker_breaks where "workSessionId" in (select id from work_sessions where "userId" in ${ids})`);
    await q(`delete from late_remarks where "workSessionId" in (select id from work_sessions where "userId" in ${ids})`).catch(() => {});
    await q(`delete from work_sessions where "userId" in ${ids}`); await q(`delete from alerts where "userId" in ${ids}`).catch(() => {});
    await q(`delete from company_access where "userId" in ${ids}`);
    await q(`update audit_logs set "actorId"=null where "actorId" in ${ids}`).catch(() => {});
    await q(`delete from login_events where "userId" in ${ids}`).catch(() => {});
    await q(`update users set "reportsToId"=null where "reportsToId" in ${ids}`);
    await q(`delete from users where "employeeCode" like 'ANT-%'`);
  };
  await wipe();
  const mk = async (code, role, plat, boss = null) => { await q(`insert into users (id,"platformId",email,"passwordHash","firstName","lastName","employeeCode",role,status,"mustChangePassword","trackerAccessEnabled","onboardingStatus","reportsToId","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,$4,'Ant',$5,$6,'ACTIVE',false,true,'ACTIVE',$7,now(),now())`, [plat, code.toLowerCase() + "@ant.test", hash, code.replace("ANT-", ""), code, role, boss]); const id = (await q(`select id from users where "employeeCode"=$1`, [code]))[0].id; return { id, code, tok: (await call("POST", "/auth/login", null, { email: code, password: PW })).b.token }; };
  const AD1 = await mk("ANT-AD1", "ADMIN", A);
  const AD2 = await mk("ANT-AD2", "ADMIN", B);
  for (const a of [AD1, AD2]) await q(`insert into company_access (id,"userId","platformId","createdAt") values (gen_random_uuid(),$1,null,now())`, [a.id]);
  const HR = await mk("ANT-HR", "HR", A);
  await q(`insert into company_access (id,"userId","platformId","createdAt") values (gen_random_uuid(),$1,null,now())`, [HR.id]);
  const MGR = await mk("ANT-MGR", "MANAGER", A, AD1.id);
  const E1 = await mk("ANT-E1", "EMPLOYEE", A, MGR.id);
  const E2 = await mk("ANT-E2", "EMPLOYEE", B, AD2.id); // an employee whose reporting line goes to an Admin
  // the manager runs a project an Admin is also a member of: the Admin must still not appear in the manager's lists
  const team = (await q(`insert into teams (id,"platformId",name,"managerId","isActive","createdAt","updatedAt") values (gen_random_uuid(),$1,'ANT-Proj',$2,true,now(),now()) returning id`, [A, MGR.id]))[0].id;
  for (const u of [E1, AD1]) await q(`insert into team_members (id,"teamId","userId","isActive","isPrimary","joinedAt") values (gen_random_uuid(),$1,$2,true,true,now())`, [team, u.id]);
  const admins = new Set([AD1.id, AD2.id]);
  const noAdmin = (ids) => ids.every((id) => !admins.has(id));
  try {
    console.log("## Admins cannot be clocked in");
    const ci = await call("POST", "/tracker/clock-in", AD1.tok, {});
    ok("an Admin clocking in is refused (403) and nothing is recorded", ci.s === 403 && (await q(`select count(*)::int n from work_sessions where "userId"=$1`, [AD1.id]))[0].n === 0, ci);
    ok("an employee can still clock in", [200, 409].includes((await call("POST", "/tracker/clock-in", E1.tok, {})).s));

    console.log("\n## Admins are not in any measured list (seen by an Admin, HR and a manager)");
    for (const who of [AD1, AD2, HR, MGR]) {
      const live = (await call("GET", "/team-attendance/live", who.tok)).b;
      const liveIds = (live.rows ?? []).map((r) => r.userId);
      ok(`${who.code}: live attendance board has no Admin`, live.rows && noAdmin(liveIds), liveIds.length);
      const cal = (await call("GET", `/attendance-calendar?from=${today}&to=${today}`, who.tok)).b;
      const calIds = [...new Set((cal.rows ?? cal.people ?? []).map((r) => r.userId ?? r.id))];
      ok(`${who.code}: attendance calendar has no Admin`, noAdmin(calIds), calIds.length);
      const att = (await call("GET", `/team-attendance/attendance?from=${today}&to=${today}`, who.tok)).b;
      ok(`${who.code}: attendance report has no Admin (so no Admin is absent)`, noAdmin((att.rows ?? []).map((r) => r.userId)), (att.rows ?? []).length);
      const rep = (await call("GET", `/reports?from=${today}&to=${today}&groupBy=person`, who.tok)).b;
      ok(`${who.code}: Reports has no Admin row (no Admin counted absent or unproductive)`, noAdmin((rep.people ?? []).map((p) => p.userId)), (rep.people ?? []).length);
      const prod = (await call("GET", `/team-attendance/productivity?from=${today}&to=${today}`, who.tok)).b;
      ok(`${who.code}: task productivity has no Admin`, noAdmin((prod.people ?? []).map((p) => p.userId)));
      const tr = (await call("GET", `/team-attendance/team-report?from=${today}&to=${today}`, who.tok)).b;
      ok(`${who.code}: the team / employee workbook data has no Admin`, noAdmin((tr.people ?? []).map((p) => p.id ?? p.userId)), (tr.people ?? []).length);
    }

    console.log("\n## Admins still see everyone else, organisation-wide, independently");
    const sees = async (who) => new Set(((await call("GET", "/team-attendance/live", who.tok)).b.rows ?? []).map((r) => r.userId));
    const s1 = await sees(AD1), s2 = await sees(AD2);
    ok("Admin 1 sees employees of both companies (E1 and E2)", s1.has(E1.id) && s1.has(E2.id));
    ok("Admin 2 sees the same people as Admin 1 (no hierarchy narrows one Admin)", s1.size === s2.size && [...s1].every((id) => s2.has(id)), [s1.size, s2.size]);
    ok("E2 reports to Admin 2, yet Admin 1 sees E2 too", s1.has(E2.id));
    const dbEmployees = (await q(`select count(*)::int n from users where role<>'ADMIN' and status in ('ACTIVE','INVITED')`))[0].n;
    ok("the Admin's live board covers every active / invited non-Admin person in the database", s1.size === dbEmployees, [s1.size, dbEmployees]);

    console.log("\n## Headcount and the Employee sheet");
    const emp = (await call("GET", "/admin/users?employeesOnly=1", AD1.tok)).b;
    ok("employee headcount list (employeesOnly) has no Admin", noAdmin(emp.users.map((u) => u.id)) && emp.users.length > 0);
    ok("...and its organisation total leaves Admins out too", emp.scope.orgTotal === (await q(`select count(*)::int n from users where role<>'ADMIN'`))[0].n, emp.scope);
    const cnt = (await call("GET", "/admin/users/status-counts?employeesOnly=1", AD1.tok)).b;
    ok("status counts for employees equal that list", cnt.total === emp.users.length, [cnt.total, emp.users.length]);
    const um = (await call("GET", "/admin/users", AD1.tok)).b;
    ok("User Management still lists the Admin accounts (they stay active and manageable)", um.users.some((u) => u.id === AD1.id) && um.users.some((u) => u.id === AD2.id));
    const ov = (await call("GET", "/admin-console/overview", AD1.tok)).b;
    const dbHead = (await q(`select count(*)::int n from users where role<>'ADMIN' and status in ('ACTIVE','INVITED')`))[0].n;
    ok("the Admin home 'People' number leaves Admins out", ov.people?.total === dbHead && !ov.people?.byRole?.ADMIN, [ov.people?.total, dbHead, ov.people?.byRole]);

    console.log("\n## Admins keep their accounts and permissions");
    ok("both Admins can still sign in", !!AD1.tok && !!AD2.tok);
    ok("an Admin can still open Admin-only screens (audit log)", (await call("GET", "/audit-logs", AD2.tok)).s === 200);
    ok("an Admin can still read login activity for the organisation", [200].includes((await call("GET", "/login-activity", AD1.tok)).s));
  } finally { await wipe().catch((e) => console.log("wipe note:", e.message)); await db.end(); }
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
