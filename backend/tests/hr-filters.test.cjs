// HR filters over HTTP on the Attendance board, the Calendar, the Employees list and the filter options: cascading, unique counts, search together
// with dropdowns, cards equal rows, and filtering is never authorization. Disposable database only (see _guard.cjs).
//
//   cd backend && TEST_DATABASE_URL=... TEST_API=http://localhost:5012/api node tests/hr-filters.test.cjs
require("dotenv").config({ path: require("node:path").join(__dirname, "..", ".env") });
const { Client } = require("pg");
const bcrypt = require("bcryptjs");
const API = process.env.TEST_API ?? "http://localhost:5002/api";
require("./_guard.cjs").assertTestDb(process.env.TEST_DATABASE_URL);

const call = async (m, p, t) => {
  const r = await fetch(API + p, { method: m, headers: { ...(t ? { authorization: "Bearer " + t } : {}) } });
  const txt = await r.text(); let j; try { j = JSON.parse(txt); } catch { j = txt; }
  return { s: r.status, b: j };
};
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  -> " + String(JSON.stringify(x)).slice(0, 400))); };
const PW = "Hfl@12345678";
const qs = (o) => "?" + new URLSearchParams(o).toString();

(async () => {
  const db = new Client({ connectionString: process.env.TEST_DATABASE_URL }); await db.connect();
  const q = async (s, p) => (await db.query(s, p)).rows;
  const AV = (await q(`select id from platforms where slug='avatar'`))[0].id;
  const AVN = (await q(`select id from platforms where slug='avance'`))[0].id;
  const hash = await bcrypt.hash(PW, 10);
  const wipe = async () => {
    const ids = `(select id from users where "employeeCode" like 'HFL-%')`;
    await q(`delete from company_access where "userId" in ${ids}`);
    await q(`delete from team_members where "userId" in ${ids}`);
    await q(`delete from teams where name like 'HFL-%'`);
    await q(`delete from audit_logs where "userId" in ${ids}`).catch(() => {});
    await q(`delete from users where "employeeCode" like 'HFL-%'`);
  };
  await wipe();
  const mk = async (code, role, platformId, o = {}) => {
    await q(`insert into users (id,"platformId",email,"passwordHash","firstName","lastName","employeeCode",role,status,designation,"mustChangePassword","trackerAccessEnabled","onboardingStatus","reportsToId","dateOfJoining","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8,$9,false,true,'ACTIVE',$10,'2026-01-01',now(),now())`, [platformId, code.toLowerCase() + "@hfl.test", hash, o.first ?? code.replace("HFL-", ""), o.last ?? "Hfl", code, role, o.status ?? "ACTIVE", o.designation ?? null, o.boss ?? null]);
    const id = (await q(`select id from users where "employeeCode"=$1`, [code]))[0].id;
    const tok = (await (await fetch(API + "/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: code, password: PW }) })).json()).token;
    return { id, tok, code };
  };
  const HRA = await mk("HFL-HRA", "HR", AV); // HR of company A, NO grant: sees company A only
  const HRALL = await mk("HFL-HRALL", "HR", AV); // HR with an all-companies grant
  await q(`insert into company_access (id,"userId","platformId","createdAt") values (gen_random_uuid(),$1,null,now())`, [HRALL.id]);
  const AD = await mk("HFL-AD", "ADMIN", AV);
  const M1 = await mk("HFL-M1", "MANAGER", AV, { first: "Mia", boss: AD.id });
  const M2 = await mk("HFL-M2", "MANAGER", AVN, { first: "Max" });
  const E1 = await mk("HFL-E1", "EMPLOYEE", AV, { first: "Ravi", designation: "Tester", boss: M1.id });
  const E2 = await mk("HFL-E2", "EMPLOYEE", AV, { first: "Sana", designation: "Designer", boss: M1.id });
  const E3 = await mk("HFL-E3", "EMPLOYEE", AV, { first: "Asha", designation: "Tester" });
  const E4 = await mk("HFL-E4", "EMPLOYEE", AVN, { first: "Omar", designation: "Tester", boss: M2.id });
  const E5 = await mk("HFL-E5", "EMPLOYEE", AVN, { first: "Zoya", designation: "Analyst", boss: M2.id });
  const team = async (name, platformId, members) => {
    const id = (await q(`insert into teams (id,"platformId",name,"isActive","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,true,now(),now()) returning id`, [platformId, name]))[0].id;
    for (const u of members) await q(`insert into team_members (id,"teamId","userId","isActive","isPrimary","joinedAt") values (gen_random_uuid(),$1,$2,true,false,now())`, [id, u.id]);
    return id;
  };
  const P1 = await team("HFL-Alpha", AV, [E1, E2]);
  const P2 = await team("HFL-Beta", AV, [E1, E3]); // E1 is on BOTH Alpha and Beta
  const P3 = await team("HFL-Gamma", AVN, [E4, E5]);

  const live = (u, o = {}) => call("GET", "/team-attendance/live" + qs(o), u.tok);
  const codes = (r) => (r.b.rows ?? []).map((x) => x.employeeCode).filter((c) => c.startsWith("HFL-E")).sort();
  const optsOf = (u, o = {}) => call("GET", "/hr-filters/options" + qs(o), u.tok);

  console.log("\n## options: real records, only what the viewer may see, cascading");
  const o1 = await optsOf(HRALL);
  ok("HR with an all-companies grant sees both companies and all three projects", [AV, AVN].every((id) => o1.b.companies.some((c) => c.id === id)) && ["HFL-Alpha", "HFL-Beta", "HFL-Gamma"].every((n) => o1.b.projects.some((p) => p.name === n)), o1.b);
  const o2 = await optsOf(HRA);
  ok("HR without a grant sees only their own company and its projects", o2.b.companies.length === 1 && o2.b.companies[0].id === AV && !o2.b.projects.some((p) => p.name === "HFL-Gamma"), o2.b);
  const oc = await optsOf(HRALL, { company: AVN });
  ok("choosing a company narrows the projects to that company's", oc.b.projects.every((p) => p.companyId === AVN) && oc.b.projects.some((p) => p.name === "HFL-Gamma") && !oc.b.projects.some((p) => p.name === "HFL-Alpha"), oc.b.projects);
  ok("...and the managers to those with people in that company", oc.b.managers.some((m) => m.id === M2.id) && !oc.b.managers.some((m) => m.id === M1.id), oc.b.managers);
  const op = await optsOf(HRALL, { project: `${P1}` });
  ok("choosing a project narrows the managers to that project's people", op.b.managers.some((m) => m.id === M1.id) && !op.b.managers.some((m) => m.id === M2.id), op.b.managers);
  ok("the project list carries each project's unique people", o1.b.projects.find((p) => p.name === "HFL-Alpha").people === 2 && o1.b.projects.find((p) => p.name === "HFL-Beta").people === 2, o1.b.projects);
  ok("designations come from real people", ["Tester", "Designer", "Analyst"].every((d) => o1.b.designations.some((x) => x.name === d)), o1.b.designations);
  ok("a manager gets options of their own people only", (await optsOf(M1)).b.companies.length === 1 && (await optsOf(M1)).b.counts.orgTotal === 2, (await optsOf(M1)).b.counts);
  ok("an employee has nothing to filter (403)", (await optsOf(E1)).s === 403);

  console.log("\n## unique counts and filters working together (Attendance board)");
  const all = await live(HRALL);
  ok("HR with the grant sees all companies on the board", ["HFL-E1", "HFL-E4"].every((c) => codes(all).includes(c)), codes(all));
  ok("scope shows the organization total next to the filtered total", all.b.scope.orgTotal >= 10 && all.b.scope.filteredTotal === all.b.scope.orgTotal, all.b.scope);
  const byProject = await live(HRALL, { project: `${P1},${P2}` });
  ok("two projects: E1 (on both) is shown ONCE, with E2 and E3", JSON.stringify(codes(byProject)) === JSON.stringify(["HFL-E1", "HFL-E2", "HFL-E3"]) && byProject.b.rows.filter((r) => r.employeeCode === "HFL-E1").length === 1, codes(byProject));
  ok("the cards equal the rows (no page-only counting)", byProject.b.summary.total === byProject.b.rows.length && byProject.b.scope.filteredTotal === byProject.b.rows.length, [byProject.b.summary, byProject.b.scope]);
  const byCompany = await live(HRALL, { company: AVN });
  ok("company filter", JSON.stringify(codes(byCompany)) === JSON.stringify(["HFL-E4", "HFL-E5"]) && byCompany.b.rows.filter((r) => r.employeeCode.startsWith("HFL-")).every((r) => /Avance/.test(r.company)), codes(byCompany));
  const byMgr = await live(HRALL, { manager: M1.id });
  ok("reporting manager filter shows who reports to them", JSON.stringify(codes(byMgr)) === JSON.stringify(["HFL-E1", "HFL-E2"]), codes(byMgr));
  const both = await live(HRALL, { project: P2, manager: M1.id });
  ok("project AND manager together narrow further", JSON.stringify(codes(both)) === JSON.stringify(["HFL-E1"]), codes(both));
  const searched = await live(HRALL, { q: "sana", company: AV });
  ok("search works together with a dropdown", JSON.stringify(codes(searched)) === JSON.stringify(["HFL-E2"]), codes(searched));
  const bySearchId = await live(HRALL, { q: "hfl-e5" });
  ok("search finds an employee ID", JSON.stringify(codes(bySearchId)) === JSON.stringify(["HFL-E5"]), codes(bySearchId));
  ok("a filter that matches nobody gives an empty board, with the organization total kept", (await live(HRALL, { q: "zzzzzz" })).b.rows.length === 0 && (await live(HRALL, { q: "zzzzzz" })).b.scope.orgTotal >= 10);

  console.log("\n## the new columns");
  const r1 = all.b.rows.find((r) => r.employeeCode === "HFL-E1");
  ok("project column: every project the person is on", JSON.stringify(r1.projects) === JSON.stringify(["HFL-Alpha", "HFL-Beta"]), r1.projects);
  ok("reporting manager column", r1.reportingManager === "Mia Hfl" && all.b.rows.find((r) => r.employeeCode === "HFL-E3").reportingManager === null, r1.reportingManager);
  ok("company, shift, clock times and durations are still there", "company" in r1 && "shiftName" in r1 && "loginAt" in r1 && "logoutAt" in r1 && "breakSeconds" in r1 && "meetingSeconds" in r1 && "productiveSeconds" in r1 && "status" in r1, Object.keys(r1));

  console.log("\n## filtering is never authorization");
  const hra = await live(HRA);
  ok("HR without a grant sees only their own company on the board", ["HFL-E1", "HFL-E2", "HFL-E3"].every((c) => codes(hra).includes(c)) && !codes(hra).some((c) => c === "HFL-E4" || c === "HFL-E5"), codes(hra));
  const sneak = await live(HRA, { company: AVN });
  ok("asking for a company outside their access returns nobody (no leak)", codes(sneak).length === 0 && sneak.b.rows.length === 0, codes(sneak));
  const sneakProject = await live(HRA, { project: P3 });
  ok("asking for a project outside their access returns nobody", sneakProject.b.rows.length === 0);
  const mgr = await live(M1);
  ok("a manager sees only their own people on the board", JSON.stringify(codes(mgr)) === JSON.stringify(["HFL-E1", "HFL-E2"]), codes(mgr));
  ok("...and cannot widen it with a company filter", (await live(M1, { company: AVN })).b.rows.length === 0 && JSON.stringify(codes(await live(M1, { project: P3 }))) === "[]");
  ok("an employee cannot open the board (403)", (await live(E1)).s === 403);
  ok("bad ids are ignored, not an error", (await live(HRALL, { company: "not-an-id; drop table users" })).s === 200);

  console.log("\n## Calendar");
  const today = all.b.date;
  const cal = (u, o = {}) => call("GET", "/attendance-calendar" + qs({ from: today, to: today, ...o }), u.tok);
  const c0 = await cal(HRALL);
  const calCodes = (r) => (r.b.people ?? []).map((p) => p.code).filter((c) => c.startsWith("HFL-E")).sort();
  ok("the calendar lists everyone HR may see", ["HFL-E1", "HFL-E4"].every((c) => calCodes(c0).includes(c)) && c0.b.scope.orgTotal === c0.b.scope.filteredTotal, c0.b.scope);
  const c1 = await cal(HRALL, { project: `${P1},${P2}` });
  ok("calendar: two projects, E1 once", JSON.stringify(calCodes(c1)) === JSON.stringify(["HFL-E1", "HFL-E2", "HFL-E3"]), calCodes(c1));
  ok("calendar: the filtered count differs from the organization total", c1.b.scope.filteredTotal === c1.b.people.length && c1.b.scope.filteredTotal < c1.b.scope.orgTotal, c1.b.scope);
  ok("calendar: the day counts add up to the filtered people", Object.values(c1.b.counts).reduce((a, b) => a + b, 0) === c1.b.rows.length && c1.b.rows.length <= c1.b.people.length, [c1.b.counts, c1.b.rows.length]);
  const c2 = await cal(HRALL, { company: AVN, manager: M2.id, q: "zoya" });
  ok("calendar: company + manager + search together", JSON.stringify(calCodes(c2)) === JSON.stringify(["HFL-E5"]), calCodes(c2));
  ok("calendar: the old teamId still works (it means project)", JSON.stringify(calCodes(await cal(HRALL, { teamId: P3 }))) === JSON.stringify(["HFL-E4", "HFL-E5"]));
  ok("calendar: HR without a grant cannot reach another company by filter", calCodes(await cal(HRA, { company: AVN })).length === 0);
  ok("calendar: an employee still sees only themselves", (await cal(E1)).b.people.length === 1);

  console.log("\n## Employees list");
  const emp = (u, o = {}) => call("GET", "/admin/users" + qs(o), u.tok);
  const ec = (r) => (r.b.users ?? []).map((x) => x.employeeCode).filter((c) => c.startsWith("HFL-E")).sort();
  const e0 = await emp(HRALL);
  ok("the list carries the organization total and the filtered total", e0.b.scope.orgTotal >= 10 && e0.b.scope.filteredTotal === e0.b.users.length, e0.b.scope);
  ok("project filter (two projects, E1 once)", JSON.stringify(ec(await emp(HRALL, { project: `${P1},${P2}` }))) === JSON.stringify(["HFL-E1", "HFL-E2", "HFL-E3"]));
  ok("reporting manager filter", JSON.stringify(ec(await emp(HRALL, { manager: M2.id }))) === JSON.stringify(["HFL-E4", "HFL-E5"]));
  ok("designation filter", JSON.stringify(ec(await emp(HRALL, { designation: "tester" }))) === JSON.stringify(["HFL-E1", "HFL-E3", "HFL-E4"]));
  ok("company + designation + search together", JSON.stringify(ec(await emp(HRALL, { companyId: AV, designation: "Tester", search: "asha" }))) === JSON.stringify(["HFL-E3"]));
  ok("status filter", JSON.stringify(ec(await emp(HRALL, { status: "ACTIVE", project: P1 }))) === JSON.stringify(["HFL-E1", "HFL-E2"]));
  ok("HR without a grant: another company is refused or empty, never shown", ec(await emp(HRA, { project: P3 })).length === 0 && !ec(await emp(HRA)).includes("HFL-E4"));

  await wipe();
  await db.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
