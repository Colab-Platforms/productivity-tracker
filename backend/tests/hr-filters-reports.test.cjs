// HR filters on the Attendance report, Shift breakdown, Task productivity (and hourly), Reports and Leave: tables, KPIs and totals come from the same
// narrowed list, the numbers of the people who stay are IDENTICAL to the unfiltered ones, and filtering is never authorization.
// Disposable database only (see _guard.cjs).
//
//   cd backend && TEST_DATABASE_URL=... TEST_API=http://localhost:5012/api node tests/hr-filters-reports.test.cjs
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
const PW = "Grp@12345678";
const qs = (o) => "?" + new URLSearchParams(o).toString();
const add = (s, n) => new Date(new Date(s + "T00:00:00Z").getTime() + n * 864e5).toISOString().slice(0, 10);

(async () => {
  const db = new Client({ connectionString: process.env.TEST_DATABASE_URL }); await db.connect();
  const q = async (s, p) => (await db.query(s, p)).rows;
  const AV = (await q(`select id from platforms where slug='avatar'`))[0].id;
  const AVN = (await q(`select id from platforms where slug='avance'`))[0].id;
  const hash = await bcrypt.hash(PW, 10);
  const wipe = async () => {
    const ids = `(select id from users where "employeeCode" like 'GRP-%')`;
    for (const s of [
      `delete from daily_tasks where "userId" in ${ids}`,
      `delete from leave_days where "userId" in ${ids}`,
      `delete from leave_approval_events where "requestId" in (select id from leave_requests where "userId" in ${ids})`,
      `delete from request_approvals where kind='LEAVE' and "requestId" in (select id from leave_requests where "userId" in ${ids})`,
      `delete from leave_requests where "userId" in ${ids}`,
      `delete from work_sessions where "userId" in ${ids}`,
      `delete from company_access where "userId" in ${ids}`,
      `delete from team_members where "userId" in ${ids}`,
      `delete from teams where name like 'GRP-%'`,
      `delete from notifications where "userId" in ${ids}`,
      `delete from audit_logs where "userId" in ${ids}`,
      `delete from users where "employeeCode" like 'GRP-%'`,
    ]) await q(s).catch(() => {});
  };
  await wipe();
  const mk = async (code, role, pid, o = {}) => {
    await q(`insert into users (id,"platformId",email,"passwordHash","firstName","lastName","employeeCode",role,status,"mustChangePassword","trackerAccessEnabled","onboardingStatus","reportsToId","dateOfJoining","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,$4,'Grp',$5,$6,'ACTIVE',false,true,'ACTIVE',$7,'2026-01-01',now(),now())`, [pid, code.toLowerCase() + "@grp.test", hash, o.first ?? code.replace("GRP-", ""), code, role, o.boss ?? null]);
    const id = (await q(`select id from users where "employeeCode"=$1`, [code]))[0].id;
    const tok = (await (await fetch(API + "/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: code, password: PW }) })).json()).token;
    return { id, tok };
  };
  const HRALL = await mk("GRP-HRALL", "HR", AV); await q(`insert into company_access (id,"userId","platformId","createdAt") values (gen_random_uuid(),$1,null,now())`, [HRALL.id]);
  const HROWN = await mk("GRP-HROWN", "HR", AV);
  const M1 = await mk("GRP-M1", "MANAGER", AV, { first: "Mia" });
  const M2 = await mk("GRP-M2", "MANAGER", AVN, { first: "Max" });
  const E1 = await mk("GRP-E1", "EMPLOYEE", AV, { first: "Ravi", boss: M1.id });
  const E2 = await mk("GRP-E2", "EMPLOYEE", AV, { first: "Sana", boss: M1.id });
  const E3 = await mk("GRP-E3", "EMPLOYEE", AV, { first: "Asha" });
  const E4 = await mk("GRP-E4", "EMPLOYEE", AVN, { first: "Omar", boss: M2.id });
  const E5 = await mk("GRP-E5", "EMPLOYEE", AVN, { first: "Zoya", boss: M2.id });
  const team = async (name, pid, ms) => {
    const id = (await q(`insert into teams (id,"platformId",name,"isActive","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,true,now(),now()) returning id`, [pid, name]))[0].id;
    for (const u of ms) await q(`insert into team_members (id,"teamId","userId","isActive","isPrimary","joinedAt") values (gen_random_uuid(),$1,$2,true,false,now())`, [id, u.id]);
    return id;
  };
  const P1 = await team("GRP-Alpha", AV, [E1, E2]);
  const P2 = await team("GRP-Beta", AV, [E1, E3]);
  const P3 = await team("GRP-Gamma", AVN, [E4, E5]);
  const today = (await call("GET", "/tracker/timesheet", E1.tok)).b.today;
  const at = (day, h) => new Date(`${day}T${h}:00+05:30`).toISOString();
  const session = (u, pid, day, inH = "09:30") => q(`insert into work_sessions (id,"platformId","userId",date,"loginAt","logoutAt",status,"productiveSeconds","breakSeconds","meetingSeconds","wasLateLogin","lateByMinutes","autoClosed","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3::date,$4,$5,'COMPLETED',25200,1800,0,false,0,false,now(),now())`, [pid, u.id, day, at(day, inH), at(day, "17:30")]);
  const staff = [[E1, AV], [E2, AV], [E3, AV], [E4, AVN], [E5, AVN]];
  for (const [u, pid] of staff) await session(u, pid, today, u === E2 ? "10:05" : "09:30");
  // finished, approved tasks completed today (for task productivity)
  for (const [u, pid] of [[E1, AV], [E4, AVN]]) await q(`insert into daily_tasks (id,"platformId","userId",date,title,weight,status,"approvalStatus","completedAt","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3::date,'GRP task','MEDIUM','COMPLETED','APPROVED',now(),now(),now())`, [pid, u.id, today]);
  // leave requests: A1 casual approved (3 days ago), B1 sick pending (today), B2 casual pending (+3 days)
  const lr = (u, pid, type, from, to, status) => q(`insert into leave_requests (id,"platformId","userId","fromDate","toDate","leaveType","isHalfDay","isFirstHalf","dayCount",reason,status,"createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3::date,$4::date,$5::"LeaveDayType",false,true,1,'grp',$6::"LeaveRequestStatus",now(),now())`, [pid, u.id, from, to, type, status]);
  await lr(E1, AV, "CASUAL", add(today, -3), add(today, -3), "APPROVED");
  await lr(E4, AVN, "SICK", today, today, "PENDING");
  await lr(E5, AVN, "CASUAL", add(today, 3), add(today, 3), "PENDING");

  const codesOf = (rows, key = "employeeCode") => (rows ?? []).map((r) => r[key]).filter((c) => c && c.startsWith("GRP-E")).sort();
  const E = (...n) => n.map((i) => `GRP-E${i}`);
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  console.log("\n## Attendance report");
  const att = (u, o = {}) => call("GET", "/team-attendance/attendance" + qs({ from: today, to: today, ...o }), u.tok);
  const a0 = await att(HRALL);
  ok("unfiltered: HR with access sees both companies, scope is the organization", eq(codesOf(a0.b.rows), E(1, 2, 3, 4, 5)) && a0.b.scope.filteredTotal === a0.b.scope.orgTotal, [codesOf(a0.b.rows), a0.b.scope]);
  const a1 = await att(HRALL, { project: `${P1},${P2}` });
  ok("two projects: E1 (on both) once, with E2 and E3", eq(codesOf(a1.b.rows), E(1, 2, 3)) && a1.b.rows.filter((r) => r.employeeCode === "GRP-E1").length === 1, codesOf(a1.b.rows));
  ok("KPIs are built from the same people (employees = rows)", a1.b.kpis.employees === a1.b.rows.length && a1.b.scope.filteredTotal >= a1.b.rows.length, [a1.b.kpis, a1.b.scope]);
  const row = (r, c) => (r.b.rows ?? []).find((x) => x.employeeCode === c);
  ok("a filtered person's row is IDENTICAL to the unfiltered row (no calculation changed)", JSON.stringify(row(a1, "GRP-E2")) === JSON.stringify(row(a0, "GRP-E2")) && JSON.stringify(row(a1, "GRP-E1")) === JSON.stringify(row(a0, "GRP-E1")));
  ok("company + manager together", eq(codesOf((await att(HRALL, { company: AVN, manager: M2.id })).b.rows), E(4, 5)));
  ok("search together with a dropdown", eq(codesOf((await att(HRALL, { company: AV, q: "sana" })).b.rows), E(2)));
  ok("HR without a grant: company B by filter returns nobody", codesOf((await att(HROWN, { company: AVN })).b.rows).length === 0 && !codesOf((await att(HROWN)).b.rows).includes("GRP-E4"));
  ok("a manager cannot widen it", codesOf((await att(M1, { company: AVN })).b.rows).length === 0 && eq(codesOf((await att(M1)).b.rows), E(1, 2)));

  console.log("\n## Shift breakdown");
  const sb = (u, o = {}) => call("GET", "/team-attendance/shift-breakdown" + qs({ date: today, ...o }), u.tok);
  const s0 = await sb(HRALL), s1 = await sb(HRALL, { project: P3 });
  ok("shift breakdown: filtered to the project, with the organization total", eq(codesOf(s1.b.rows), E(4, 5)) && s1.b.scope.filteredTotal < s1.b.scope.orgTotal, [codesOf(s1.b.rows), s1.b.scope]);
  ok("...and a person's figures equal the unfiltered ones", JSON.stringify(row(s1, "GRP-E4")) === JSON.stringify(row(s0, "GRP-E4")));
  ok("HR without a grant: nothing outside their company", codesOf((await sb(HROWN, { project: P3 })).b.rows).length === 0);

  console.log("\n## Task productivity (and hourly)");
  const pr = (u, o = {}) => call("GET", "/team-attendance/productivity" + qs({ from: today, to: today, ...o }), u.tok);
  const pcodes = (r) => (r.b.people ?? []).map((p) => p.employeeCode).filter((c) => c && c.startsWith("GRP-E")).sort();
  const p0 = await pr(HRALL), p1 = await pr(HRALL, { company: AVN });
  ok("productivity: both companies unfiltered", eq(pcodes(p0), E(1, 2, 3, 4, 5)), pcodes(p0));
  ok("productivity: company filter + scope", eq(pcodes(p1), E(4, 5)) && p1.b.scope.filteredTotal < p1.b.scope.orgTotal, [pcodes(p1), p1.b.scope]);
  ok("a person's completed tasks and percent are identical to the unfiltered ones", JSON.stringify(p1.b.people.find((x) => x.employeeCode === "GRP-E4")) === JSON.stringify(p0.b.people.find((x) => x.employeeCode === "GRP-E4")));
  ok("productivity: HR without a grant gets nobody from company B", pcodes(await pr(HROWN, { company: AVN })).length === 0);
  const hr1 = await call("GET", "/team-attendance/productivity/hourly" + qs({ date: today, project: P3 }), HRALL.tok);
  ok("hourly: filtered to the project", eq(pcodes(hr1), E(4, 5)) && !!hr1.b.scope, pcodes(hr1));

  console.log("\n## Reports & Analytics (/reports)");
  const rp = (u, o = {}) => call("GET", "/reports" + qs({ from: today, to: today, groupBy: "person", ...o }), u.tok);
  const r0 = await rp(HRALL), r1 = await rp(HRALL, { project: `${P1},${P2}` });
  ok("reports: unfiltered shows both companies", eq(codesOf(r0.b.people), E(1, 2, 3, 4, 5)), codesOf(r0.b.people));
  ok("reports: two projects, E1 counted once", eq(codesOf(r1.b.people), E(1, 2, 3)), codesOf(r1.b.people));
  ok("reports: the filtered total sits next to the organization total", r1.b.peopleScope.filteredTotal < r1.b.peopleScope.orgTotal && r0.b.peopleScope.filteredTotal === r0.b.peopleScope.orgTotal, [r0.b.peopleScope, r1.b.peopleScope]);
  const sum = (r, f) => (r.b.people ?? []).filter((p) => p.employeeCode?.startsWith("GRP-E")).reduce((n, p) => n + (p[f] ?? 0), 0);
  ok("reports: a person's productive seconds equal the unfiltered figure", JSON.stringify(r1.b.people.find((p) => p.employeeCode === "GRP-E1")) === JSON.stringify(r0.b.people.find((p) => p.employeeCode === "GRP-E1")));
  ok("reports: HR without a grant never gets company B", codesOf((await rp(HROWN, { company: AVN })).b.people).length === 0);

  console.log("\n## Leave");
  const lv = (u, o = {}) => call("GET", "/leave/requests" + qs(o), u.tok);
  const lcodes = (r) => (r.b.requests ?? []).map((x) => x.person.employeeCode).filter((c) => c && c.startsWith("GRP-E")).sort();
  const l0 = await lv(HRALL);
  ok("leave: HR with access sees requests of both companies", eq(lcodes(l0), E(1, 4, 5)), lcodes(l0));
  ok("leave: company filter", eq(lcodes(await lv(HRALL, { company: AVN })), E(4, 5)));
  ok("leave: project filter", eq(lcodes(await lv(HRALL, { project: P3 })), E(4, 5)) && eq(lcodes(await lv(HRALL, { project: P1 })), E(1)));
  ok("leave: reporting manager filter", eq(lcodes(await lv(HRALL, { manager: M2.id })), E(4, 5)));
  ok("leave: leave type filter (sick)", eq(lcodes(await lv(HRALL, { leaveType: "SICK" })), E(4)));
  ok("leave: approval status filter (approved)", eq(lcodes(await lv(HRALL, { status: "APPROVED" })), E(1)));
  ok("leave: approval stage filter (pending HR)", eq(lcodes(await lv(HRALL, { stage: "PENDING_HR" })), E(4, 5)) && eq(lcodes(await lv(HRALL, { stage: "APPROVED" })), E(1)));
  ok("leave: date range filter (the next 5 days)", eq(lcodes(await lv(HRALL, { from: today, to: add(today, 5) })), E(4, 5)) && eq(lcodes(await lv(HRALL, { from: add(today, -5), to: add(today, -1) })), E(1)));
  ok("leave: filters work together", eq(lcodes(await lv(HRALL, { company: AVN, leaveType: "CASUAL", from: today, to: add(today, 5) })), E(5)));
  ok("leave: the filtered people count sits next to the organization total", (await lv(HRALL, { company: AVN })).b.scope.filteredTotal < l0.b.scope.orgTotal, (await lv(HRALL, { company: AVN })).b.scope);
  ok("leave: HR without a grant never sees company B's requests", lcodes(await lv(HROWN)).every((c) => c === "GRP-E1") && lcodes(await lv(HROWN, { company: AVN })).length === 0);
  const ls0 = await call("GET", "/leave/summary", HRALL.tok), ls1 = await call("GET", "/leave/summary" + qs({ project: P3 }), HRALL.tok);
  const scodes = (r) => (r.b.people ?? []).map((p) => p.employeeCode).filter((c) => c && c.startsWith("GRP-E")).sort();
  ok("leave taken: filtered to the project, both totals shown", eq(scodes(ls1), E(4, 5)) && ls1.b.scope.filteredTotal < ls1.b.scope.orgTotal && eq(scodes(ls0), E(1, 2, 3, 4, 5)), [scodes(ls1), ls1.b.scope]);
  ok("leave taken: a person's figures equal the unfiltered ones", JSON.stringify(ls1.b.people.find((p) => p.employeeCode === "GRP-E4")) === JSON.stringify(ls0.b.people.find((p) => p.employeeCode === "GRP-E4")));
  ok("leave: a bad date range is refused (400)", (await lv(HRALL, { from: "2026-12-10", to: "2026-12-01" })).s === 400);

  await wipe();
  await db.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
