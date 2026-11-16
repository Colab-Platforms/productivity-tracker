// The data behind the dashboard workbook (GET /team-attendance/team-report) for Manager, HR and Admin: who is included (everybody in scope, even with
// no records), the new read-only fields (employment status, joining date, real submission time, late-submission details), deleted tasks left out,
// unrated stays unrated, nothing changes while the report is read. Disposable database only (see _guard.cjs).
//
//   cd backend && TEST_DATABASE_URL=... TEST_API=http://localhost:5012/api node tests/dashboard-report-data.test.cjs
const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("pg");
const bcrypt = require("bcryptjs");
const API = process.env.TEST_API ?? "http://localhost:5012/api";
const DB = process.env.TEST_DATABASE_URL;
require("./_guard.cjs").assertTestDb(DB);

const call = async (m, p, t, body) => {
  const r = await fetch(API + p, { method: m, headers: { ...(t ? { authorization: "Bearer " + t } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const txt = await r.text(); let j; try { j = JSON.parse(txt); } catch { j = txt; }
  return { s: r.status, b: j };
};
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  -> " + String(JSON.stringify(x)).slice(0, 500))); };
const PW = "Tdr@12345678";
const addDays = (s, n) => new Date(Date.parse(s + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);

(async () => {
  const db = new Client({ connectionString: DB }); await db.connect();
  const q = async (s, p) => (await db.query(s, p)).rows;
  for (const m of ["20261116110000_task_late_submissions", "20261116120000_task_deletions"]) {
    const table = m.includes("late") ? "task_late_details" : "task_deletions";
    if (!(await q(`select to_regclass('${table}') t`))[0].t) await db.query(fs.readFileSync(path.join(__dirname, "..", "prisma", "migrations", m, "migration.sql"), "utf8"));
  }
  const A = (await q(`select id from platforms where slug='avatar'`))[0].id;
  const B = (await q(`select id from platforms where slug='avance'`))[0].id;
  const tz = (await q(`select timezone from platforms where id=$1`, [A]))[0].timezone;
  const TODAY = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const hash = await bcrypt.hash(PW, 10);
  const wipe = async () => {
    const ids = (await q(`select id from users where "employeeCode" like 'TDR-%'`)).map((r) => r.id);
    if (ids.length) {
      await q(`delete from company_access where "userId" = any($1)`, [ids]).catch(() => {});
      await q(`delete from task_deletions where "taskId" in (select id from daily_tasks where "userId" = any($1))`, [ids]).catch(() => {});
      await q(`delete from task_ratings where "taskId" in (select id from daily_tasks where "userId" = any($1))`, [ids]).catch(() => {});
      await q(`delete from task_late_details where "userId" = any($1)`, [ids]).catch(() => {});
      await q(`delete from task_entry_details where "taskId" in (select id from daily_tasks where "userId" = any($1))`, [ids]).catch(() => {});
      await q(`delete from task_events where "taskId" in (select id from daily_tasks where "userId" = any($1))`, [ids]).catch(() => {});
      await q(`delete from daily_tasks where "userId" = any($1)`, [ids]);
      await q(`delete from notifications where "userId" = any($1)`, [ids]);
      await q(`delete from team_members where "userId" = any($1)`, [ids]);
    }
    await q(`delete from teams where name like 'TDR %'`);
    await q(`delete from users where "employeeCode" like 'TDR-%'`).catch(() => {});
  };
  await wipe();
  const mk = async (code, first, role, plat, reportsTo, status = "ACTIVE", joined = "2026-01-01") => (await q(`insert into users (id,"platformId",email,"passwordHash","firstName","lastName","employeeCode",role,status,"mustChangePassword","trackerAccessEnabled","onboardingStatus","dateOfJoining","reportsToId","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,$4,'Tdr',$5,$6,$8,false,true,'ACTIVE',$9,$7,now(),now()) returning id`, [plat, code.toLowerCase() + "@tdr.test", hash, first, code, role, reportsTo ?? null, status, joined]))[0].id;
  const team = async (name, mgr, plat) => (await q(`insert into teams (id,"platformId",name,"managerId","isActive","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,true,now(),now()) returning id`, [plat, name, mgr]))[0].id;
  const login = async (code) => (await (await fetch(API + "/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: code, password: PW }) })).json()).token;

  const M1 = await mk("TDR-M1", "Manone", "MANAGER", A), M2 = await mk("TDR-M2", "Mantwo", "MANAGER", A);
  const AD = await mk("TDR-AD", "Admin", "ADMIN", A), HR = await mk("TDR-HR", "Hrp", "HR", A), HRG = await mk("TDR-HRG", "Hrgrant", "HR", A), MB = await mk("TDR-MB", "Manbee", "MANAGER", B);
  const E1 = await mk("TDR-E1", "Eone", "EMPLOYEE", A, M1), E2 = await mk("TDR-E2", "Etwo", "EMPLOYEE", A, M1, "ACTIVE", TODAY), E3 = await mk("TDR-E3", "Ethree", "EMPLOYEE", A, M2), EB = await mk("TDR-EB", "Ebee", "EMPLOYEE", B, MB);
  const P1 = await team("TDR Alpha", M1, A);
  await q(`insert into team_members (id,"teamId","userId","isActive","isPrimary","joinedAt") values (gen_random_uuid(),$1,$2,true,true,now())`, [P1, E1]);
  await q(`insert into company_access (id,"userId","platformId","createdAt") values (gen_random_uuid(),$1,$2,now())`, [HRG, B]).catch(async () => { await q(`insert into company_access (id,"userId","platformId","createdAt","createdById") values (gen_random_uuid(),$1,$2,now(),$3)`, [HRG, B, AD]); });
  const tok = {};
  for (const [k, c] of Object.entries({ M1: "TDR-M1", M2: "TDR-M2", AD: "TDR-AD", HR: "TDR-HR", HRG: "TDR-HRG", MB: "TDR-MB", E1: "TDR-E1" })) tok[k] = await login(c);

  // E1's tasks: normal, rated, rejected, late-submitted (yesterday), deleted
  const mkTask = async (title, extra = {}) => { const r = await call("POST", "/tasks", tok.E1, { title, weight: "MEDIUM", progress: "IN_PROGRESS", hoursSpent: 1, teamId: P1, taggedManagerId: M1, ...extra }); if (r.s !== 200) throw new Error(JSON.stringify(r.b)); return (await q(`select id from daily_tasks where title=$1 and "userId"=$2`, [title, E1]))[0].id; };
  const tNormal = await mkTask("DR normal"), tRated = await mkTask("DR rated", { progress: "COMPLETED" }), tRej = await mkTask("DR rejected"), tDel = await mkTask("DR deleted", { progress: "COMPLETED" });
  await call("POST", `/tasks/review/${tRated}/approve`, tok.M1, { approve: true });
  await call("POST", `/tasks/review/${tRated}/rating`, tok.M1, { rating: 4, comment: "Good" });
  await call("POST", `/tasks/review/${tRej}/approve`, tok.M1, { approve: false, rejectionNote: "No" });
  await call("POST", `/tasks/review/${tDel}/approve`, tok.M1, { approve: true });
  await call("POST", `/tasks/review/${tDel}/rating`, tok.M1, { rating: 5, comment: "Deleted later" });
  await new Promise((r) => setTimeout(r, 16000)); // let the server notice the late / deletion tables if they were just created
  const yesterday = addDays(TODAY, -1);
  const late = await call("POST", "/tasks/bulk", tok.E1, { forDate: yesterday, lateReason: "Forgot to add it", rows: [{ key: "l", title: "DR late", teamId: P1, taggedManagerId: M1, progress: "IN_PROGRESS", hoursSpent: 1, weight: "LOW" }] });
  const tLate = (await q(`select id from daily_tasks where title='DR late' and "userId"=$1`, [E1]))[0].id;
  await call("POST", `/tasks/review/${tLate}/approve`, tok.M1, { approve: true });
  const del = await call("POST", `/tasks/review/${tDel}/delete`, tok.M1, { reasonCode: "MISTAKE", note: "wrong person" });
  ok("setup: a late-submitted task and a deleted task exist", late.b.submitted === 1 && del.s === 200, [late.b, del.s]);

  const counts = async () => JSON.stringify(await q(`select (select count(*) from daily_tasks) t, (select count(*) from users) u, (select count(*) from task_ratings) r, (select count(*) from work_sessions) w, (select count(*) from task_deletions) d, (select count(*) from audit_logs where path like '/api/team-attendance%') a`));
  const before = await counts();
  const rep = (t, extra = "") => call("GET", `/team-attendance/team-report?from=${addDays(TODAY, -6)}&to=${TODAY}${extra}`, t);

  console.log("\n## Manager: only their team, everybody in it");
  const m1 = await rep(tok.M1);
  const ids1 = m1.b.people.map((p) => p.employeeCode).sort();
  ok("the manager's report holds exactly the people who report to them (E1 and E2), E2 even though E2 has no records at all", m1.s === 200 && ids1.join() === "TDR-E1,TDR-E2", ids1);
  ok("the other manager's employee and another company's employee are not in it", !ids1.includes("TDR-E3") && !ids1.includes("TDR-EB"));
  const p1 = m1.b.people.find((p) => p.employeeCode === "TDR-E1"), p2 = m1.b.people.find((p) => p.employeeCode === "TDR-E2");
  ok("each person carries employment status and joining date (the new fields)", p1.status === "ACTIVE" && p1.joinedOn === "2026-01-01" && p2.joinedOn === TODAY, [p1, p2]);
  ok("designation, company, reporting manager and team are present for the dashboard table", p1.company && p1.reportingManager === "Manone Tdr" && p1.projects.includes("TDR Alpha"), p1);
  const titles = m1.b.tasks.map((t) => t.title).sort();
  ok("all of E1's tasks are in: normal, rated, rejected and the late-submitted one", ["DR late", "DR normal", "DR rated", "DR rejected"].every((t) => titles.includes(t)), titles);
  ok("the task a manager DELETED is not in the report (and its rating is gone with it)", !titles.includes("DR deleted") && !m1.b.tasks.some((t) => t.rating === 5), titles);
  const tk = (t) => m1.b.tasks.find((x) => x.title === t);
  ok("an unrated task has rating null (never 0), a rated one has its stars and feedback", tk("DR normal").rating === null && tk("DR rated").rating === 4 && tk("DR rated").ratingComment === "Good", [tk("DR normal").rating, tk("DR rated").rating]);
  ok("every task carries its REAL submission time (within the last minute of the test)", m1.b.tasks.every((t) => t.submittedAt && Math.abs(Date.now() - Date.parse(t.submittedAt)) < 5 * 60 * 1000), m1.b.tasks.map((t) => t.submittedAt));
  ok("the late-submitted task says how late and why; the original date is yesterday while it was submitted today; normal tasks have no late flag", tk("DR late").late && tk("DR late").late.lateByDays === 1 && tk("DR late").late.reason === "Forgot to add it" && tk("DR late").date === yesterday && tk("DR late").submittedAt.slice(0, 10) >= TODAY.slice(0, 10) && tk("DR normal").late === null, tk("DR late"));
  ok("approval and progress arrive as separate fields", tk("DR rejected").approvalStatus === "REJECTED" && tk("DR rejected").progress === "IN_PROGRESS" && tk("DR rated").progress === "COMPLETED" && tk("DR rated").approvalStatus === "APPROVED");
  ok("the report names the scope: how many people the viewer is authorised for", m1.b.scope && m1.b.scope.orgTotal >= 2, m1.b.scope);

  console.log("\n## Manager: the other manager and the other company");
  const m2 = await rep(tok.M2), mb = await rep(tok.MB);
  ok("the other manager gets only their own employee, never E1 or E2", m2.b.people.map((p) => p.employeeCode).join() === "TDR-E3" && !m2.b.tasks.some((t) => t.userId === E1), m2.b.people.map((p) => p.employeeCode));
  ok("a manager of another company gets only theirs", mb.b.people.map((p) => p.employeeCode).join() === "TDR-EB", mb.b.people.map((p) => p.employeeCode));
  ok("a manager cannot reach another person with the userId filter", (await call("GET", `/team-attendance/team-report?from=${TODAY}&to=${TODAY}&userId=${E3}`, tok.M1)).b.people.every((p) => p.employeeCode !== "TDR-E3"));

  console.log("\n## HR");
  const hr = await rep(tok.HR);
  const hrCodes = hr.b.people.map((p) => p.employeeCode).filter((c) => c && c.startsWith("TDR-")).sort();
  ok("HR without a grant gets everybody of their own company, with or without activity (employees E1, E2, E3 and the company's managers, HR and Admin), not the other company's", hrCodes.join() === "TDR-AD,TDR-E1,TDR-E2,TDR-E3,TDR-HR,TDR-HRG,TDR-M1,TDR-M2" && !hrCodes.includes("TDR-EB") && !hrCodes.includes("TDR-MB"), hrCodes);
  const hrg = await rep(tok.HRG);
  const hrgCodes = hrg.b.people.map((p) => p.employeeCode).filter((c) => c && c.startsWith("TDR-")).sort();
  ok("HR with access to a second company gets both companies' people", hrgCodes.join() === "TDR-AD,TDR-E1,TDR-E2,TDR-E3,TDR-EB,TDR-HR,TDR-HRG,TDR-M1,TDR-M2,TDR-MB", hrgCodes);
  ok("HR's report has no deleted task, and shows the late flag of an approved late task (HR never sees a task still waiting for its manager)", !hr.b.tasks.some((t) => t.title === "DR deleted") && hr.b.tasks.find((t) => t.title === "DR late")?.late?.lateByDays === 1);
  ok("the HR filter (company) narrows the report; it never widens it", (await rep(tok.HR, `&company=${B}`)).b.people.filter((p) => p.employeeCode?.startsWith("TDR-")).length === 0);

  console.log("\n## Admin");
  const ad = await rep(tok.AD);
  const adCodes = ad.b.people.map((p) => p.employeeCode).filter((c) => c && c.startsWith("TDR-")).sort();
  ok("Admin gets the whole company they act on, within their access (not the other company)", adCodes.join() === "TDR-AD,TDR-E1,TDR-E2,TDR-E3,TDR-HR,TDR-HRG,TDR-M1,TDR-M2", adCodes);
  ok("an Employee cannot open the report (403)", (await call("GET", `/team-attendance/team-report?from=${TODAY}&to=${TODAY}`, tok.E1)).s === 403);
  ok("not signed in is refused", (await call("GET", `/team-attendance/team-report?from=${TODAY}&to=${TODAY}`, null)).s === 401);

  console.log("\n## dates");
  const one = await call("GET", `/team-attendance/team-report?from=${TODAY}&to=${TODAY}`, tok.M1);
  ok("a one-day range works and keeps everyone in scope (E2 has nothing, still listed)", one.b.days === 1 && one.b.people.length === 2);
  ok("only tasks of the chosen days are returned: yesterday's late task is not in a today-only report", !one.b.tasks.some((t) => t.title === "DR late"));
  ok("a range over 93 days is refused, an end before the start is refused", (await call("GET", `/team-attendance/team-report?from=${addDays(TODAY, -100)}&to=${TODAY}`, tok.M1)).s === 400 && (await call("GET", `/team-attendance/team-report?from=${TODAY}&to=${addDays(TODAY, -2)}`, tok.M1)).s === 400);

  console.log("\n## reading changes nothing");
  await rep(tok.M1); await rep(tok.HR); await rep(tok.AD);
  const after = await counts();
  const parsed = (x) => JSON.parse(x)[0];
  ok("no task, user, rating, session or deletion was created, changed or removed by generating the reports", parsed(before).t === parsed(after).t && parsed(before).u === parsed(after).u && parsed(before).r === parsed(after).r && parsed(before).w === parsed(after).w && parsed(before).d === parsed(after).d, [before, after]);
  const again = await rep(tok.M1);
  ok("the same request twice gives the same people and tasks", JSON.stringify(again.b.people) === JSON.stringify(m1.b.people) && again.b.tasks.length === m1.b.tasks.length);

  await wipe();
  await db.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
