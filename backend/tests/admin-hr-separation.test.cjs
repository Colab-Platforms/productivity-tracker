// Admin (owner) vs HR separation: what only Admin may do, what HR keeps, what Manager/Employee never get. API level, real tokens.
// Throwaway database only. Needs the backend on BASE (default http://localhost:5012/api) running against TEST_DATABASE_URL.
//   TEST_DATABASE_URL=postgresql://postgres:localtest@127.0.0.1:54329/hrms_test node tests/admin-hr-separation.test.cjs
const path = require("node:path");
const { assertTestDb } = require("./_guard.cjs");
const B = path.join(__dirname, "..", "node_modules") + path.sep;
const { Client } = require(B + "pg"); const bcrypt = require(B + "bcryptjs");
const URL_ = process.env.TEST_DATABASE_URL; assertTestDb(URL_);
const BASE = process.env.BASE || "http://localhost:5012/api", PW = "Ads@12345678";
let pass = 0, fail = 0;
const check = (n, ok, d = "") => { if (ok) pass++; else fail++; console.log((ok ? "PASS " : "FAIL ") + n + (ok ? "" : "  -> " + String(d).slice(0, 220))); };
const api = async (method, p, token, body) => { const r = await fetch(BASE + p, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) }, body: body ? JSON.stringify(body) : undefined }); let j = null; try { j = await r.json(); } catch {} return { s: r.status, j }; };
const login = async (code) => (await api("POST", "/auth/login", null, { email: code, password: PW })).j?.token;
const denied = (r) => r.s === 403;

(async () => {
  const db = new Client({ connectionString: URL_ }); await db.connect();
  const q = async (s, p) => (await db.query(s, p)).rows;
  const P = (await q(`select id from platforms where slug='avatar'`))[0].id;
  const hash = await bcrypt.hash(PW, 10);
  const wipe = async () => {
    const ids = `select id from users where "employeeCode" like 'ADS-%' or email like 'ads.new.%'`;
    await q(`delete from team_members where "userId" in (${ids})`).catch(() => {});
    await q(`delete from team_members where "teamId" in (select id from teams where name like 'ADS Proj%')`).catch(() => {});
    await q(`delete from team_managers where "teamId" in (select id from teams where name like 'ADS Proj%')`).catch(() => {});
    await q(`delete from teams where name like 'ADS Proj%'`).catch(() => {});
    await q(`delete from company_access where "userId" in (${ids})`);
    await q(`delete from users where "employeeCode" like 'ADS-%' or email like 'ads.new.%'`).catch(() => {});
    await q(`delete from platforms where name like 'ADS Test Co%'`).catch(() => {});
  };
  await wipe();
  const mk = async (code, first, role, reportsTo = null) => (await q(`insert into users (id,"platformId",email,"passwordHash","firstName","lastName","employeeCode",role,status,"mustChangePassword","trackerAccessEnabled","onboardingStatus","dateOfJoining","reportsToId","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,$4,'Sep',$5,$6,'ACTIVE',false,true,'ACTIVE','2026-01-01',$7,now(),now()) returning id`, [P, code.toLowerCase() + "@ads.test", hash, first, code, role, reportsTo]))[0].id;
  const grant = (id) => q(`insert into company_access (id,"userId","platformId","createdAt") values (gen_random_uuid(),$1,null,now())`, [id]);
  const owners = [];
  for (const [c, f] of [["ADS-O1", "Sanjay"], ["ADS-O2", "Jayesh"], ["ADS-O3", "Devang"], ["ADS-O4", "Aayush"]]) { const id = await mk(c, f, "ADMIN"); await grant(id); owners.push([c, id]); }
  const hrg = await mk("ADS-HRG", "Sonali", "HR"); await grant(hrg);   // HR with the all-companies grant (like Sonali)
  const hrn = await mk("ADS-HRN", "Hana", "HR");                        // HR with no grant
  const mgr = await mk("ADS-MG", "Mira", "MANAGER");
  const mgr2 = await mk("ADS-MG2", "Milo", "MANAGER");
  const emp = await mk("ADS-EM", "Emma", "EMPLOYEE", mgr);
  const tgt = await mk("ADS-EM2", "Tess", "EMPLOYEE", mgr);
  const T = {}; for (const c of ["ADS-O1", "ADS-O2", "ADS-O3", "ADS-O4", "ADS-HRG", "ADS-HRN", "ADS-MG", "ADS-EM"]) T[c] = await login(c);
  check("all test accounts sign in", Object.values(T).every(Boolean));

  // ---------- ADMIN: all four owners keep every owner control ----------
  const tokO1 = T["ADS-O1"];
  const co = await api("POST", "/companies", tokO1, { name: "ADS Test Co", timezone: "Asia/Kolkata" });
  check("Admin can create a company", co.s === 200, co.s + JSON.stringify(co.j));
  const coId = co.j?.company?.id ?? co.j?.id ?? (await q(`select id from platforms where name='ADS Test Co'`))[0]?.id;
  const ed = await api("POST", "/companies/" + coId, tokO1, { name: "ADS Test Co 2" });
  check("Admin can edit a company", ed.s === 200, ed.s + JSON.stringify(ed.j));
  const pj = await api("POST", "/projects", tokO1, { name: "ADS Proj One", companyId: P, managerId: mgr });
  check("Admin can create a project and assign its manager", pj.s === 200, pj.s + JSON.stringify(pj.j).slice(0, 150));
  const proj = (await q(`select id from teams where name='ADS Proj One'`))[0]; const projId = proj?.id;
  check("the project exists", !!projId);
  const mem = await api("POST", `/projects/${projId}/members`, tokO1, { userId: emp });
  check("Admin can assign a project member", mem.s === 200, mem.s + JSON.stringify(mem.j).slice(0, 150));
  const memT = await api("POST", `/admin/teams/${projId}/members`, tokO1, { userId: tgt });
  check("Admin can use the team-membership route", memT.s === 200, memT.s + JSON.stringify(memT.j).slice(0, 150));
  const rm = await api("DELETE", `/admin/teams/${projId}/members/${tgt}`, tokO1);
  check("Admin can remove a team member", rm.s === 200, rm.s);
  for (const [c] of owners) { const a = await api("GET", "/audit-logs", T[c]); check(`${c}: audit log opens`, a.s === 200, a.s); }
  for (const [c] of owners) { const a = await api("GET", "/admin-console/overview", T[c]); check(`${c}: owner overview opens`, a.s === 200, a.s); }
  const ca = await api("GET", "/admin/company-access", tokO1); check("Admin can open company access", ca.s === 200, ca.s);
  const hier = await api("PATCH", "/admin/users/" + tgt, tokO1, { reportsToId: mgr2 }); check("Admin can change the reporting manager", hier.s === 200, hier.s + JSON.stringify(hier.j));
  const role = await api("PATCH", "/admin/users/" + tgt, tokO1, { role: "MANAGER" }); check("Admin can change a system role", role.s === 200, role.s + JSON.stringify(role.j));
  await api("PATCH", "/admin/users/" + tgt, tokO1, { role: "EMPLOYEE" });
  const cr = await api("POST", "/admin/users", tokO1, { firstName: "New", lastName: "Hr", email: "ads.new.hr@ads.test", password: "Newpass#1234", role: "HR" }); check("Admin can create an HR account", cr.s === 200 || cr.s === 201, cr.s + JSON.stringify(cr.j));
  const sh = await api("GET", "/admin/shifts", tokO1); check("Admin can read shifts", sh.s === 200);

  // ---------- HR (with and without the all-companies grant): cannot reach any Admin-exclusive operation ----------
  for (const [who, tok] of [["HR with all-companies grant", T["ADS-HRG"]], ["HR without grant", T["ADS-HRN"]]]) {
    const R = [
      ["create a company", await api("POST", "/companies", tok, { name: "ADS Test Co X" })],
      ["edit a company", await api("POST", "/companies/" + P, tok, { name: "Renamed" })],
      ["create a project", await api("POST", "/projects", tok, { name: "ADS Proj Two", companyId: P })],
      ["assign a project member", await api("POST", `/projects/${projId}/members`, tok, { userId: tgt })],
      ["add a co-manager", await api("POST", `/projects/${projId}/co-managers`, tok, { userId: mgr2 })],
      ["change a project manager/owner", await api("POST", "/projects", tok, { id: projId, name: "ADS Proj One", companyId: P, managerId: mgr2 })],
      ["create a team", await api("POST", "/admin/teams", tok, { name: "ADS Proj Three" })],
      ["edit a team", await api("PATCH", "/admin/teams/" + projId, tok, { name: "ADS Proj Renamed" })],
      ["add a team member", await api("POST", `/admin/teams/${projId}/members`, tok, { userId: tgt })],
      ["remove a team member", await api("DELETE", `/admin/teams/${projId}/members/${emp}`, tok)],
      ["read the audit log", await api("GET", "/audit-logs", tok)],
      ["read audit filters", await api("GET", "/audit-logs/filters", tok)],
      ["change a person's system role", await api("PATCH", "/admin/users/" + tgt, tok, { role: "MANAGER" })],
      ["change the reporting manager", await api("PATCH", "/admin/users/" + tgt, tok, { reportsToId: mgr })], // a real change (the person currently reports to mgr2)
      ["create an Admin account", await api("POST", "/admin/users", tok, { firstName: "X", lastName: "Y", email: "ads.new.admin@ads.test", password: "Newpass#1234", role: "ADMIN" })],
      ["create an HR account", await api("POST", "/admin/users", tok, { firstName: "X", lastName: "Y", email: "ads.new.hr2@ads.test", password: "Newpass#1234", role: "HR" })],
      ["open company access", await api("GET", "/admin/company-access", tok)],
      ["grant company-wide access", await api("POST", "/admin/company-access/" + hrn, tok, { all: true })],
      ["open the owner overview", await api("GET", "/admin-console/overview", tok)],
      ["create a shift", await api("POST", "/admin/shifts", tok, { name: "x", startTime: "09:00", endTime: "18:00" })],
      ["change alert thresholds", await api("PATCH", "/admin/config/" + projId, tok, { dailyWorkHours: 7 })],
    ];
    for (const [what, r] of R) check(`${who}: cannot ${what} (got ${r.s})`, denied(r) || (r.s === 404 && /read the audit/.test(what) === false && false), r.s + JSON.stringify(r.j).slice(0, 100));
    // nothing leaked through
    check(`${who}: no project/team/company was created or changed by those attempts`, (await q(`select count(*)::int c from teams where name in ('ADS Proj Two','ADS Proj Three','ADS Proj Renamed')`))[0].c === 0 && (await q(`select count(*)::int c from platforms where name in ('ADS Test Co X','Renamed')`))[0].c === 0);
    const tu = (await q(`select role::text, "reportsToId" from users where id=$1`, [tgt]))[0];
    check(`${who}: the person's role and reporting manager are unchanged`, tu.role === "EMPLOYEE" && tu.reportsToId === mgr2, JSON.stringify(tu));
  }

  // ---------- HR keeps its daily operations ----------
  for (const [who, tok] of [["HR (grant)", T["ADS-HRG"]], ["HR (no grant)", T["ADS-HRN"]]]) {
    const ops = [
      ["read the company list", "GET", "/companies"], ["read projects", "GET", "/projects"], ["open the people list", "GET", "/admin/users"],
      ["see employee dropdowns", "GET", "/admin/employees/dropdowns?companyId=" + P], ["open document tracking", "GET", "/documents/tracking"], ["open joiners", "GET", "/onboarding/candidates"],
      ["open team attendance", "GET", "/team-attendance/live"], ["see leave requests", "GET", "/leave/requests"], ["see leave summary", "GET", "/leave/summary"],
      ["see HR filter options", "GET", "/hr-filters/options"], ["open the Query Desk", "GET", "/queries"], ["read holidays", "GET", "/holidays"],
    ];
    for (const [what, m, p] of ops) { const r = await api(m, p, tok); check(`${who}: can ${what}`, r.s === 200, r.s + JSON.stringify(r.j).slice(0, 100)); }
    const edit = await api("PATCH", "/admin/users/" + tgt, tok, { phone: "9999900000" }); check(`${who}: can still update an employee's details`, edit.s === 200, edit.s + JSON.stringify(edit.j));
  }
  const mkEmp = await api("POST", "/admin/users", T["ADS-HRG"], { firstName: "New", lastName: "Joiner", email: "ads.new.emp@ads.test", password: "Newpass#1234", role: "EMPLOYEE" });
  check("HR can still create an Employee account (decision: kept for HR)", mkEmp.s === 200 || mkEmp.s === 201, mkEmp.s + JSON.stringify(mkEmp.j));
  const mkMgr = await api("POST", "/admin/users", T["ADS-HRG"], { firstName: "New", lastName: "Boss", email: "ads.new.mgr@ads.test", password: "Newpass#1234", role: "MANAGER" });
  check("HR can still create a Manager account (decision: kept for HR)", mkMgr.s === 200 || mkMgr.s === 201, mkMgr.s + JSON.stringify(mkMgr.j));

  // ---------- Manager and Employee: no Admin or HR operations ----------
  for (const [who, tok] of [["Manager", T["ADS-MG"]], ["Employee", T["ADS-EM"]]]) {
    const R = [["create a company", await api("POST", "/companies", tok, { name: "ADS Test Co Y" })], ["create a project", await api("POST", "/projects", tok, { name: "ADS Proj Four" })], ["read the audit log", await api("GET", "/audit-logs", tok)], ["open the people admin list", await api("GET", "/admin/users", tok)], ["change a role", await api("PATCH", "/admin/users/" + tgt, tok, { role: "MANAGER" })], ["open the owner overview", await api("GET", "/admin-console/overview", tok)]];
    for (const [what, r] of R) check(`${who}: cannot ${what} (got ${r.s})`, denied(r), r.s);
  }
  const mgrOwn = await api("GET", "/team-attendance/live", T["ADS-MG"]); check("Manager still sees their reporting team (attendance board opens)", mgrOwn.s === 200, mgrOwn.s);
  const empOwn = await api("GET", "/leave/mine", T["ADS-EM"]); check("Employee still reaches their own leave", empOwn.s === 200, empOwn.s);
  const unauth = await api("GET", "/audit-logs", null); check("no token: audit log answers 401", unauth.s === 401, unauth.s);

  // task approval rules (HR and Admin never approve; only the tagged manager) are covered by hr-team-tasks.test.cjs and task-form-managers.test.cjs and were not changed.

  await wipe(); await db.end();
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("CRASH", e); process.exit(1); });
