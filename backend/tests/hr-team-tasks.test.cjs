// Team tasks (the task queue): HR and Admin see every employee of the companies they act on, managers only their own reporting team, the HR filters narrow
// it, and seeing a task is NOT approving it (only the tagged manager approves). Disposable database only (see _guard.cjs).
//
//   cd backend && TEST_DATABASE_URL=... TEST_API=http://localhost:5012/api node tests/hr-team-tasks.test.cjs
require("dotenv").config({ path: require("node:path").join(__dirname, "..", ".env") });
const { Client } = require("pg");
const bcrypt = require("bcryptjs");
const API = process.env.TEST_API ?? "http://localhost:5002/api";
require("./_guard.cjs").assertTestDb(process.env.TEST_DATABASE_URL);

const call = async (m, p, t, body) => {
  const r = await fetch(API + p, { method: m, headers: { ...(t ? { authorization: "Bearer " + t } : {}), ...(body && m !== "GET" ? { "content-type": "application/json" } : {}) }, body: body && m !== "GET" ? JSON.stringify(body) : undefined });
  const txt = await r.text(); let j; try { j = JSON.parse(txt); } catch { j = txt; }
  return { s: r.status, b: j };
};
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  -> " + String(JSON.stringify(x)).slice(0, 400))); };
const PW = "Htt@12345678";
const qs = (o) => "?" + new URLSearchParams(o).toString();

(async () => {
  const db = new Client({ connectionString: process.env.TEST_DATABASE_URL }); await db.connect();
  const q = async (s, p) => (await db.query(s, p)).rows;
  const AV = (await q(`select id from platforms where slug='avatar'`))[0].id;
  const AVN = (await q(`select id from platforms where slug='avance'`))[0].id;
  const hash = await bcrypt.hash(PW, 10);
  const wipe = async () => {
    const ids = `(select id from users where "employeeCode" like 'HTT-%')`;
    await q(`delete from task_entry_details where "taskId" in (select id from daily_tasks where "userId" in ${ids})`);
    await q(`delete from daily_tasks where "userId" in ${ids}`);
    await q(`delete from company_access where "userId" in ${ids}`);
    await q(`delete from team_members where "userId" in ${ids}`);
    await q(`delete from teams where name like 'HTT-%'`);
    await q(`delete from notifications where "userId" in ${ids}`);
    await q(`delete from audit_logs where "userId" in ${ids}`).catch(() => {});
    await q(`delete from users where "employeeCode" like 'HTT-%'`);
  };
  await wipe();
  const mk = async (code, role, platformId, o = {}) => {
    await q(`insert into users (id,"platformId",email,"passwordHash","firstName","lastName","employeeCode",role,status,designation,"mustChangePassword","trackerAccessEnabled","onboardingStatus","reportsToId","dateOfJoining","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,$4,'Htt',$5,$6,'ACTIVE',$7,false,true,'ACTIVE',$8,'2026-01-01',now(),now())`, [platformId, code.toLowerCase() + "@htt.test", hash, o.first ?? code.replace("HTT-", ""), code, role, o.designation ?? null, o.boss ?? null]);
    const id = (await q(`select id from users where "employeeCode"=$1`, [code]))[0].id;
    const tok = (await (await fetch(API + "/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: code, password: PW }) })).json()).token;
    return { id, tok };
  };
  const HRALL = await mk("HTT-HRALL", "HR", AV);
  await q(`insert into company_access (id,"userId","platformId","createdAt") values (gen_random_uuid(),$1,null,now())`, [HRALL.id]);
  const HRA = await mk("HTT-HRA", "HR", AV);
  const ADA = await mk("HTT-ADA", "ADMIN", AV); // Admin, own company only
  const ADALL = await mk("HTT-ADALL", "ADMIN", AV);
  await q(`insert into company_access (id,"userId","platformId","createdAt") values (gen_random_uuid(),$1,null,now())`, [ADALL.id]);
  const M1 = await mk("HTT-M1", "MANAGER", AV, { first: "Mia", boss: ADA.id });
  const M2 = await mk("HTT-M2", "MANAGER", AVN, { first: "Max" });
  const M3 = await mk("HTT-M3", "MANAGER", AV, { first: "Mona" });
  const E1 = await mk("HTT-E1", "EMPLOYEE", AV, { first: "Ravi", boss: M1.id });
  const E2 = await mk("HTT-E2", "EMPLOYEE", AV, { first: "Sana", boss: M1.id });
  const E3 = await mk("HTT-E3", "EMPLOYEE", AV, { first: "Asha" });
  const E4 = await mk("HTT-E4", "EMPLOYEE", AVN, { first: "Omar", boss: M2.id });
  const E5 = await mk("HTT-E5", "EMPLOYEE", AVN, { first: "Zoya", boss: M2.id });
  const team = async (name, platformId, members) => {
    const id = (await q(`insert into teams (id,"platformId",name,"isActive","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,true,now(),now()) returning id`, [platformId, name]))[0].id;
    for (const u of members) await q(`insert into team_members (id,"teamId","userId","isActive","isPrimary","joinedAt") values (gen_random_uuid(),$1,$2,true,false,now())`, [id, u.id]);
    return id;
  };
  const P1 = await team("HTT-Alpha", AV, [E1, E2]);
  const P2 = await team("HTT-Beta", AV, [E1, E3]);
  const P3 = await team("HTT-Gamma", AVN, [E4, E5]);
  const today = (await call("GET", "/tracker/timesheet", E1.tok)).b.today;
  const task = async (u, platformId, title, approval, tagged) => {
    const id = (await q(`insert into daily_tasks (id,"platformId","userId",date,title,weight,status,"approvalStatus","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3::date,$4,'MEDIUM','PENDING',$5::"TaskApprovalStatus",now(),now()) returning id`, [platformId, u.id, today, title, approval]))[0].id;
    if (tagged) await q(`insert into task_entry_details (id,"platformId","taskId","hoursSpent","taggedManagerId","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,2,$3,now(),now())`, [platformId, id, tagged.id]);
    return id;
  };
  const T1 = await task(E1, AV, "HTT task Ravi", "PENDING", M1);
  const T2 = await task(E2, AV, "HTT task Sana", "APPROVED", M1);
  const T4 = await task(E4, AVN, "HTT task Omar", "PENDING", M2);
  const T3 = await task(E3, AV, "HTT task Asha (no tag)", "PENDING", null);

  const queue = (u, o = {}) => call("GET", "/tasks/review/queue" + qs({ from: today, to: today, ...o }), u.tok);
  const mine = (r) => (r.b.members ?? []).map((m) => m.employeeCode).filter((c) => c.startsWith("HTT-E")).sort();
  const taskTitles = (r) => (r.b.all ?? []).map((t) => t.title).filter((t) => t.startsWith("HTT task")).sort();
  const rawActive = async (platformId) => (await q(`select count(*)::int n from users where status in ('ACTIVE','INVITED')${platformId ? ` and "platformId"='${platformId}'` : ""}`))[0].n;

  console.log("\n## HR sees every company she acts on");
  const hr = await queue(HRALL);
  ok("HR with the all-companies grant sees both companies' employees in the dropdown list", JSON.stringify(mine(hr)) === JSON.stringify(["HTT-E1", "HTT-E2", "HTT-E3", "HTT-E4", "HTT-E5"]), mine(hr));
  ok("...and the tasks of both companies", JSON.stringify(taskTitles(hr)) === JSON.stringify(["HTT task Asha (no tag)", "HTT task Omar", "HTT task Ravi", "HTT task Sana"]), taskTitles(hr));
  ok("the organization total equals the real number of active people", hr.b.scope.orgTotal === (await rawActive()) && hr.b.scope.filteredTotal === hr.b.scope.orgTotal && hr.b.teamSize === hr.b.members.length, [hr.b.scope, await rawActive(), hr.b.teamSize, hr.b.members.length]);
  const hra = await queue(HRA);
  ok("HR without a grant sees only their own company's people (no leak)", JSON.stringify(mine(hra)) === JSON.stringify(["HTT-E1", "HTT-E2", "HTT-E3"]) && !taskTitles(hra).includes("HTT task Omar"), [mine(hra), taskTitles(hra)]);
  ok("...and their total is that company's active people", hra.b.scope.orgTotal >= (await rawActive(AV)) && hra.b.scope.orgTotal <= (await rawActive(AV)) + 2, [hra.b.scope, await rawActive(AV)]);
  ok("the projects offered are those of the authorised companies only", (hr.b.projects ?? []).some((p) => p.name === "HTT-Gamma") && !(hra.b.projects ?? []).some((p) => p.name === "HTT-Gamma"), [hr.b.projects?.length, hra.b.projects?.length]);
  const adall = await queue(ADALL), ada = await queue(ADA);
  ok("an Admin with all-company access sees everything; an Admin with their own company only sees that company", mine(adall).includes("HTT-E4") && !mine(ada).includes("HTT-E4") && mine(ada).includes("HTT-E1"), [mine(adall), mine(ada)]);

  console.log("\n## filters narrow the list, the counts and the tasks together");
  const fc = await queue(HRALL, { company: AVN });
  ok("company filter", JSON.stringify(mine(fc)) === JSON.stringify(["HTT-E4", "HTT-E5"]) && JSON.stringify(taskTitles(fc)) === JSON.stringify(["HTT task Omar"]), [mine(fc), taskTitles(fc)]);
  ok("the filtered total is shown against the organization total", fc.b.scope.filteredTotal === (await rawActive(AVN)) && fc.b.scope.filteredTotal < fc.b.scope.orgTotal && fc.b.scope.orgTotal === hr.b.scope.orgTotal, [fc.b.scope, await rawActive(AVN)]);
  const fp = await queue(HRALL, { project: `${P1},${P2}` });
  ok("two projects: a person on both (Ravi) is listed once", JSON.stringify(mine(fp)) === JSON.stringify(["HTT-E1", "HTT-E2", "HTT-E3"]) && fp.b.members.filter((m) => m.employeeCode === "HTT-E1").length === 1, mine(fp));
  const fm = await queue(HRALL, { manager: M1.id });
  ok("reporting manager filter", JSON.stringify(mine(fm)) === JSON.stringify(["HTT-E1", "HTT-E2"]) && JSON.stringify(taskTitles(fm)) === JSON.stringify(["HTT task Ravi", "HTT task Sana"]), [mine(fm), taskTitles(fm)]);
  ok("company + manager + project together", JSON.stringify(mine(await queue(HRALL, { company: AV, manager: M1.id, project: P2 }))) === JSON.stringify(["HTT-E1"]));
  ok("a filter outside her access matches nobody (no widening)", mine(await queue(HRA, { company: AVN })).length === 0 && mine(await queue(HRA, { project: P3 })).length === 0);
  ok("the date filter still works with the others", (await queue(HRALL, { from: "2020-01-01", to: "2020-01-02", company: AVN })).b.all.length === 0);

  console.log("\n## managers are unchanged");
  const m1 = await queue(M1);
  ok("a manager sees only their reporting employees and their tasks", JSON.stringify(mine(m1)) === JSON.stringify(["HTT-E1", "HTT-E2"]) && JSON.stringify(taskTitles(m1)) === JSON.stringify(["HTT task Ravi", "HTT task Sana"]), [mine(m1), taskTitles(m1)]);
  ok("...their total is their team, not the organization", m1.b.scope.orgTotal === m1.b.members.length || m1.b.scope.orgTotal === m1.b.teamSize, m1.b.scope);
  const m2 = await queue(M2);
  ok("another company's manager sees only theirs", JSON.stringify(mine(m2)) === JSON.stringify(["HTT-E4", "HTT-E5"]), mine(m2));
  const m3 = await queue(M3);
  ok("a manager with no reports sees nobody (not the whole company)", mine(m3).length === 0, mine(m3));
  ok("a manager cannot widen it with filters", mine(await queue(M1, { company: AVN })).length === 0 && JSON.stringify(mine(await queue(M1, { manager: M2.id }))) === "[]");
  ok("an employee is still refused the queue (403)", (await queue(E1)).s === 403);

  console.log("\n## HR can SEE tasks but cannot approve or reject them");
  const row = (r, title) => (r.b.all ?? []).find((t) => t.title === title);
  ok("HR sees the task's progress fields and that she cannot act on it", row(hr, "HTT task Ravi")?.canAct === false && row(hr, "HTT task Ravi")?.hoursSpent === 2 && row(hr, "HTT task Ravi")?.taggedManager === "Mia Htt", row(hr, "HTT task Ravi"));
  ok("HR sees approval details of an approved task", row(hr, "HTT task Sana")?.approvalStatus === "APPROVED");
  ok("the tagged manager sees it as theirs", row(m1, "HTT task Ravi")?.canAct === true);
  for (const [who, tok] of [["HR (all companies)", HRALL.tok], ["HR (own company)", HRA.tok], ["Admin (all companies)", ADALL.tok], ["Admin (own company)", ADA.tok]]) {
    ok(`${who}: approving a tagged task through the API is refused (403)`, (await call("POST", `/tasks/review/${T1}/approve`, tok, { approve: true })).s === 403);
    ok(`${who}: rejecting is refused too (403)`, (await call("POST", `/tasks/review/${T1}/approve`, tok, { approve: false, rejectionNote: "no" })).s === 403);
  }
  ok("HR cannot approve a task in the other company either (403)", (await call("POST", `/tasks/review/${T4}/approve`, HRALL.tok, { approve: true })).s === 403);
  ok("HR cannot approve a task that has no tagged manager (403)", (await call("POST", `/tasks/review/${T3}/approve`, HRALL.tok, { approve: true })).s === 403);
  ok("a manager the task is NOT tagged to is refused (403)", (await call("POST", `/tasks/review/${T1}/approve`, M3.tok, { approve: true })).s === 403 && (await call("POST", `/tasks/review/${T1}/approve`, M2.tok, { approve: true })).s === 403);
  ok("nothing changed on the task so far", (await q(`select "approvalStatus" from daily_tasks where id=$1`, [T1]))[0].approvalStatus === "PENDING");
  const ap = await call("POST", `/tasks/review/${T1}/approve`, M1.tok, { approve: true });
  ok("the tagged manager approves (200) and the approval is recorded as theirs", ap.s === 200 && (await q(`select "approvalStatus","approvedById" from daily_tasks where id=$1`, [T1]))[0].approvedById === M1.id);
  ok("HR then sees the approval history on the row (approved, by the manager)", row(await queue(HRALL), "HTT task Ravi")?.approvalStatus === "APPROVED");

  await wipe();
  await db.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
