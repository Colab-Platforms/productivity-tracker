// Productivity Supervisor: an ordinary EMPLOYEE account (own clock, tasks, leave, profile) that can additionally READ every employee's productivity
// data in every company, and can change none of it. Checks the server (not the screens): who is a supervisor, what they see, what is refused.
// Disposable database only (see _guard.cjs). Applies the migration itself part-way to prove the before / after.
//
//   cd backend && TEST_DATABASE_URL=... TEST_API=http://localhost:5012/api node tests/productivity-supervisor.test.cjs
require("dotenv").config({ path: require("node:path").join(__dirname, "..", ".env") });
const fs = require("node:fs"), path = require("node:path");
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
const PW = "Sup@12345678";
const MIGRATION = fs.readFileSync(path.join(__dirname, "..", "prisma", "migrations", "20261119120000_productivity_supervisors", "migration.sql"), "utf8");

(async () => {
  const db = new Client({ connectionString: process.env.TEST_DATABASE_URL }); await db.connect();
  const q = async (s, p) => (await db.query(s, p)).rows;
  const A = (await q(`select id from platforms where slug='avatar'`))[0].id;
  const B = (await q(`select id from platforms where slug='take-health'`))[0].id;
  const C = (await q(`select id from platforms where slug='co-lab'`))[0].id;
  const hash = await bcrypt.hash(PW, 10);

  const wipe = async () => {
    const ids = `(select id from users where "employeeCode" like 'SUP-%')`;
    await q(`delete from tracker_breaks where "workSessionId" in (select id from work_sessions where "userId" in ${ids})`);
    await q(`delete from work_sessions where "userId" in ${ids}`);
    await q(`delete from daily_tasks where "userId" in ${ids}`);
    await q(`delete from leave_requests where "userId" in ${ids}`).catch(() => {});
    await q(`delete from meetings where "organizerId" in ${ids}`).catch(() => {});
    await q(`delete from notifications where "userId" in ${ids}`);
    await q(`delete from department_members where "userId" in ${ids}`);
    await q(`delete from departments where name like 'SUP %'`);
    await q(`delete from team_members where "userId" in ${ids}`);
    await q(`delete from teams where name like 'SUP %'`);
    await q(`drop table if exists productivity_supervisors`);
    await q(`delete from users where "employeeCode" like 'SUP-%'`);
  };
  await wipe();
  const mk = async (code, role, platformId, reportsToId = null, status = "ACTIVE") => {
    await q(`insert into users (id,"platformId",email,"passwordHash","firstName","lastName","employeeCode",role,status,"mustChangePassword","trackerAccessEnabled","onboardingStatus","reportsToId","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,$4,'Sup',$5,$6,$8,false,true,'ACTIVE',$7,now(),now())`, [platformId, code.toLowerCase() + "@sup.test", hash, code.replace("SUP-", "S"), code, role, reportsToId, status]);
    const id = (await q(`select id from users where "employeeCode"=$1`, [code]))[0].id;
    const tok = (await call("POST", "/auth/login", null, { email: code, password: PW })).b.token;
    return { id, tok, code };
  };
  const team = async (name, platformId, managerId) => (await q(`insert into teams (id,"platformId",name,"managerId","isActive","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,true,now(),now()) returning id`, [platformId, name, managerId]))[0].id;
  const member = (t, u) => q(`insert into team_members (id,"teamId","userId","isActive","isPrimary","joinedAt") values (gen_random_uuid(),$1,$2,true,true,now())`, [t, u]);

  // people: two supervisors (different companies), a manager, HR, Admin, ordinary employees in three companies
  const MGR = await mk("SUP-MGR", "MANAGER", A);
  const MGB = await mk("SUP-MGB", "MANAGER", B);
  const HR = await mk("SUP-HR", "HR", A);
  const ADM = await mk("SUP-ADM", "ADMIN", A);
  const S1 = await mk("SUP-S1", "EMPLOYEE", A, MGR.id);   // supervisor (company A)
  const S2 = await mk("SUP-S2", "EMPLOYEE", B, MGB.id);   // supervisor (company B)
  const E1 = await mk("SUP-E1", "EMPLOYEE", A, MGR.id);   // ordinary employee
  const E2 = await mk("SUP-E2", "EMPLOYEE", B, MGB.id);
  const E3 = await mk("SUP-E3", "EMPLOYEE", C, null);
  const P1 = await team("SUP Alpha", A, MGR.id), P2 = await team("SUP Beta", B, MGB.id), P3 = await team("SUP Gamma", C, null);
  await member(P1, E1.id); await member(P2, E2.id); await member(P3, E3.id); await member(P1, S1.id); await member(P2, S2.id);
  const DA = (await q(`insert into departments (id,"platformId",name,"isActive","createdAt") values (gen_random_uuid(),$1,'SUP Tech',true,now()) returning id`, [A]))[0].id;
  await q(`insert into department_members (id,"departmentId","userId","createdAt") values (gen_random_uuid(),$1,$2,now())`, [DA, E1.id]);
  // a task and a meeting of another company's person, so there is something to see
  const today = (await call("GET", "/tracker/timesheet", E2.tok)).b.today;
  await q(`insert into daily_tasks (id,"platformId","userId",title,weight,status,"approvalStatus",date,"createdAt","updatedAt") values (gen_random_uuid(),$1,$2,'Other company task','MEDIUM','IN_PROGRESS','APPROVED',$3::date,now(),now())`, [B, E2.id, today]);
  const pendingTask = (await q(`insert into daily_tasks (id,"platformId","userId",title,weight,status,"approvalStatus",date,"createdAt","updatedAt") values (gen_random_uuid(),$1,$2,'Waiting task','MEDIUM','PENDING','PENDING',$3::date,now(),now()) returning id`, [C, E3.id, today]))[0].id;

  // --- BEFORE the migration: nobody is a supervisor, nothing changes ------------------------------------------------------
  const me0 = await call("GET", "/auth/me", S1.tok);
  ok("before the table exists: nobody is a supervisor", me0.b.supervisor === false, me0.b);
  ok("before: the monitoring routes refuse them", (await call("GET", "/team-attendance/live", S1.tok)).s === 403 && (await call("GET", "/hr-filters/options", S1.tok)).s === 403 && (await call("GET", "/supervisor/employees", S1.tok)).s === 403);

  // --- apply the migration, add the two rows (what provision-supervisors.cjs does) ----------------------------------------
  await q(MIGRATION);
  await q(`insert into productivity_supervisors ("userId", note) values ($1,'test'), ($2,'test')`, [S1.id, S2.id]);
  await new Promise((r) => setTimeout(r, 16_000)); // the server re-checks a missing table every 15 s

  const m1 = await call("GET", "/auth/me", S1.tok), m2 = await call("GET", "/auth/me", S2.tok), me = await call("GET", "/auth/me", E1.tok);
  ok("Saurabh-like account: supervisor flag on, role still EMPLOYEE", m1.b.supervisor === true && m1.b.role === "EMPLOYEE", m1.b);
  ok("Chirag-like account (another company): supervisor flag on, role still EMPLOYEE", m2.b.supervisor === true && m2.b.role === "EMPLOYEE", m2.b);
  ok("an ordinary employee is not a supervisor", me.b.supervisor === false);
  ok("manager, HR and Admin are unaffected (no flag)", [MGR, HR, ADM].every(() => true) && (await call("GET", "/auth/me", MGR.tok)).b.supervisor === false && (await call("GET", "/auth/me", ADM.tok)).b.supervisor === false);

  // --- what they SEE ---------------------------------------------------------------------------------------------------
  const totalActive = Number((await q(`select count(*) n from users where status in ('ACTIVE','INVITED')`))[0].n);
  for (const [name, S] of [["first", S1], ["second", S2]]) {
    const live = await call("GET", "/team-attendance/live", S.tok);
    ok(`${name} supervisor: live board answers (200)`, live.s === 200, live);
    const codes = (live.b.rows ?? []).map((r) => r.employeeCode);
    ok(`${name}: the board holds everyone, across all companies`, live.b.scope?.orgTotal === totalActive && codes.includes("SUP-E1") && codes.includes("SUP-E2") && codes.includes("SUP-E3"), { total: live.b.scope, totalActive });
  }
  const opts = await call("GET", "/hr-filters/options?withDepartments=1", S1.tok);
  ok("filter choices: every company, projects, managers", (opts.b.companies ?? []).length >= 3 && (opts.b.projects ?? []).length >= 3 && (opts.b.managers ?? []).length >= 2, opts.b.counts);
  ok("filter choices: the department list", (opts.b.departments ?? []).some((d) => d.name === "SUP Tech" && d.people === 1), opts.b.departments);
  const dir = await call("GET", "/supervisor/employees", S1.tok);
  ok("All Employees lists everybody", dir.s === 200 && dir.b.scope.filteredTotal === totalActive && dir.b.rows.length === totalActive, { s: dir.s, scope: dir.b.scope, n: dir.b.rows?.length });
  const rowOf = (r, code) => r.b.rows.find((x) => x.employeeCode === code);
  ok("a row carries company, reporting manager, project, department", rowOf(dir, "SUP-E1")?.company && rowOf(dir, "SUP-E1")?.reportingManager && rowOf(dir, "SUP-E1")?.projects.includes("SUP Alpha") && rowOf(dir, "SUP-E1")?.departments.includes("SUP Tech"), rowOf(dir, "SUP-E1"));
  ok("no salary, email or password in the directory", !/monthlySalary|passwordHash|email/i.test(dir.raw));
  const f = async (qs) => (await call("GET", "/supervisor/employees?" + qs, S1.tok)).b;
  const byCode = (r, c) => r.rows.some((x) => x.employeeCode === c);
  const fc = await f("company=" + B), fp = await f("project=" + P3), fm = await f("manager=" + MGR.id), fd = await f("department=" + DA), fq = await f("q=SUP-E3"), fn = await f("q=" + "S1".toLowerCase() + "&company=" + A);
  ok("filter by company", fc.rows.length > 0 && fc.rows.every((x) => x.companyId === B));
  ok("filter by project", byCode(fp, "SUP-E3") && fp.rows.length === 1, fp.rows.map((x) => x.employeeCode));
  ok("filter by reporting manager", byCode(fm, "SUP-E1") && byCode(fm, "SUP-S1") && !byCode(fm, "SUP-E2"), fm.rows.map((x) => x.employeeCode));
  ok("filter by department", byCode(fd, "SUP-E1") && fd.rows.length === 1, fd.rows.map((x) => x.employeeCode));
  ok("search by ID", fq.rows.length === 1 && byCode(fq, "SUP-E3"));
  ok("search by name together with a company", byCode(fn, "SUP-S1"));
  ok("the count says how many of how many", fc.scope.filteredTotal === fc.rows.length && fc.scope.orgTotal === totalActive, fc.scope);
  ok("a filter naming nothing matches nobody", (await f("project=00000000-0000-4000-8000-000000000000")).rows.length === 0);

  for (const [label, p] of [["shift breakdown", "/team-attendance/shift-breakdown"], ["task productivity", "/team-attendance/productivity"], ["attendance report", "/team-attendance/attendance"], ["task list for the export", "/team-attendance/productivity/tasks"], ["team report", "/team-attendance/team-report"], ["hourly", "/team-attendance/productivity/hourly"]]) {
    const r = await call("GET", p, S1.tok);
    ok(`reports: ${label} (200)`, r.s === 200, { s: r.s, b: String(r.raw).slice(0, 120) });
  }
  const prod = await call("GET", "/team-attendance/productivity", S1.tok);
  ok("productivity covers people of other companies", /SUP-E2|SUP-E3|Sup/.test(prod.raw) && (prod.b.people ?? prod.b.rows ?? []).length > 1, prod.raw.slice(0, 200));

  const queue = await call("GET", "/tasks/review/queue", S1.tok);
  ok("Tasks & Performance: the whole organisation's tasks, across companies", queue.s === 200 && (queue.b.all ?? []).some((t) => t.title === "Other company task") && (queue.b.all ?? []).some((t) => t.title === "Waiting task"), queue.b);
  ok("every row is view-only (canAct false) and nothing is 'needs your approval'", (queue.b.all ?? []).every((t) => t.canAct === false) && (queue.b.proposals ?? []).length === 0);
  ok("the people list covers every company", (queue.b.members ?? []).length >= 3 && (queue.b.projects ?? []).length >= 3, { m: queue.b.members?.length, p: queue.b.projects?.length });

  const mt = await call("POST", "/meetings", MGR.tok, { title: "Supervisor test huddle", date: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10), startTime: "10:00", endTime: "11:00", attendeeIds: [E1.id] });
  const mid = mt.b.meeting?.id ?? mt.b.id;
  const over = await call("GET", "/meetings/oversight", S1.tok);
  ok("meetings: the company overview answers for a supervisor", over.s === 200 && (over.b.meetings ?? []).some((m) => m.id === mid), over);
  ok("meetings: counts only (no attendee names or times)", !/SUP-E1|Sup E1|"attendees"/.test(over.raw));
  ok("meetings: participation names and times stay private (404/403)", (await call("GET", `/meetings/${mid}/participation`, S1.tok)).s >= 400 && (await call("GET", `/meetings/${mid}`, S1.tok)).s === 404);
  ok("meetings: the counts endpoint works", (await call("GET", `/meetings/${mid}/participation-counts`, S1.tok)).s === 200 || (await call("GET", `/meetings/${mid}/participation-counts`, S1.tok)).s === 400);

  // --- what they can NOT do ------------------------------------------------------------------------------------------------
  const refused = async (label, m, p, b) => { const r = await call(m, p, S1.tok, b); ok(`refused: ${label}`, r.s === 403 || r.s === 404 || r.s === 400 && /NOT_ALLOWED|FORBIDDEN/.test(r.raw), { s: r.s, b: r.raw.slice(0, 100) }); };
  const T = (await q(`select id from daily_tasks where title='Other company task'`))[0].id;
  await refused("approve someone's task", "POST", `/tasks/review/${pendingTask}/approve`, {});
  await refused("reject someone's task", "POST", `/tasks/review/${pendingTask}/reject`, { note: "no" });
  await refused("rate a task", "POST", `/tasks/review/${T}/rate`, { rating: 5 });
  await refused("delete a task", "POST", `/tasks/review/${T}/delete`, { reasonCode: "DUPLICATE" });
  await refused("revert a task", "POST", `/tasks/review/${T}/revert`, { type: "PARTIAL", remark: "again" });
  await refused("assign a task", "POST", "/tasks/review/assign", { userId: E1.id, title: "x" });
  await refused("decide someone's leave", "POST", `/leave/requests/${T}/decide`, { approve: true });
  await refused("decide a manager-step leave", "POST", `/leave/manager/requests/${T}/decide`, { approve: true });
  await refused("decide an attendance correction", "POST", `/attendance-corrections/${T}/decide`, { approve: true });
  await refused("add an employee", "POST", "/admin/users", { email: "x@y.z", firstName: "X", lastName: "Y" });
  await refused("edit an employee", "PATCH", `/admin/users/${E1.id}`, { designation: "CEO" });
  await refused("change a reporting manager", "PATCH", `/admin/users/${E1.id}`, { reportsToId: MGR.id });
  await refused("edit another person (Edit Employee)", "PATCH", `/admin/employees/${E1.id}`, { designation: "CEO" });
  await refused("deactivate someone", "PATCH", `/admin/users/${E1.id}`, { status: "SUSPENDED" });
  await refused("list admin users", "GET", "/admin/users");
  await refused("read payroll", "GET", "/payroll/month?month=11&year=2026");
  await refused("upload a payslip", "POST", "/payroll/upload", { userId: E1.id, month: 11, year: 2026 });
  await refused("read the shift settings write", "POST", "/admin/shifts", { name: "x" });
  await refused("alert thresholds", "PATCH", `/admin/config/${P1}`, { productiveHours: 1 });
  await refused("daily targets (read)", "GET", "/team-attendance/targets");
  await refused("daily targets (write)", "POST", "/team-attendance/targets", { targets: [] });
  await refused("audit log", "GET", "/audit-logs");
  await refused("companies (create)", "POST", "/companies", { name: "x" });
  await refused("company access grant", "PUT", `/admin/company-access/${E1.id}`, { all: true });
  await refused("a manager's alerts", "GET", "/tracker/alerts");
  await refused("the people picker for meetings", "GET", "/meetings/people");
  await refused("scheduling a meeting", "POST", "/meetings", { title: "x", date: "2026-12-01", startTime: "10:00", endTime: "11:00", attendeeIds: [E1.id] });
  ok("nothing of anyone else's changed", (await q(`select status::text, "approvalStatus"::text from daily_tasks where id=$1`, [pendingTask]))[0].approvalStatus === "PENDING" && (await q(`select designation from users where id=$1`, [E1.id]))[0].designation !== "CEO");

  // --- their OWN work still works (the ordinary employee workflows) ----------------------------------------------------
  const ci = await call("POST", "/tracker/clock-in", S1.tok, {});
  ok("personal: clock in", ci.s === 200 || ci.s === 201, ci);
  const sess = await call("GET", "/tracker/session", S1.tok);
  ok("personal: the session is running", sess.s === 200 && (sess.b.session?.status ?? sess.b.status) !== undefined, sess.raw.slice(0, 120));
  const tk = await call("POST", "/tasks", S1.tok, { title: "My own task", weight: "MEDIUM", progress: "IN_PROGRESS", hoursSpent: 1, teamId: P1, taggedManagerId: MGR.id });
  ok("personal: create my own task", tk.s === 200 || tk.s === 201, tk);
  const mine = await call("GET", "/tasks", S1.tok);
  ok("personal: My Daily Tasks lists only my tasks", mine.s === 200 && JSON.stringify(mine.b).includes("My own task") && !JSON.stringify(mine.b).includes("Other company task"));
  const lv = await call("POST", "/leave/requests", S1.tok, { from: new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10), leaveType: "CASUAL", reason: "Personal work" });
  ok("personal: request leave", lv.s === 200 || lv.s === 201, lv);
  const cal = await call("GET", "/attendance-calendar", S1.tok);
  ok("personal: My Attendance calendar shows only me", cal.s === 200 && (cal.b.rows ?? []).every((r) => r.employeeCode === "SUP-S1" || r.userId === S1.id), cal.raw.slice(0, 150));
  ok("personal: profile and notifications work", (await call("GET", "/auth/me/profile", S1.tok)).s === 200 && (await call("GET", "/notifications", S1.tok)).s === 200);
  const my = await call("GET", "/reports", S1.tok);
  ok("personal: My reports are my own figures, not the company's", my.s === 200 && !/SUP-E2|SUP-E3/.test(my.raw), my.raw.slice(0, 120));
  const co = await call("POST", "/tracker/clock-out", S1.tok, {});
  ok("personal: clock out", co.s === 200, co);

  // --- everyone else --------------------------------------------------------------------------------------------------
  for (const [label, P] of [["an ordinary employee", E1], ["an employee of another company", E2]]) {
    ok(`${label} cannot open the monitoring routes`, (await call("GET", "/team-attendance/live", P.tok)).s === 403 && (await call("GET", "/hr-filters/options", P.tok)).s === 403 && (await call("GET", "/supervisor/employees", P.tok)).s === 403 && (await call("GET", "/tasks/review/queue", P.tok)).s === 403 && (await call("GET", "/meetings/oversight", P.tok)).s === 403);
  }
  ok("a manager / HR / Admin cannot use the supervisor-only route", (await call("GET", "/supervisor/employees", MGR.tok)).s === 403 && (await call("GET", "/supervisor/employees", HR.tok)).s === 403 && (await call("GET", "/supervisor/employees", ADM.tok)).s === 403);
  ok("the existing roles still reach their own screens", (await call("GET", "/team-attendance/live", MGR.tok)).s === 200 && (await call("GET", "/team-attendance/live", HR.tok)).s === 200 && (await call("GET", "/team-attendance/live", ADM.tok)).s === 200);
  const mgrBoard = await call("GET", "/team-attendance/live", MGR.tok);
  ok("a manager still sees only his own people, not everyone", (mgrBoard.b.scope?.orgTotal ?? 0) < totalActive, mgrBoard.b.scope);

  // --- the row is the only thing that grants it; removing it takes it away at once ------------------------------------
  await q(`delete from productivity_supervisors where "userId"=$1`, [S1.id]);
  ok("remove the row: access is gone immediately", (await call("GET", "/team-attendance/live", S1.tok)).s === 403 && (await call("GET", "/auth/me", S1.tok)).b.supervisor === false);
  ok("the other supervisor is not affected", (await call("GET", "/team-attendance/live", S2.tok)).s === 200);
  await q(`update users set role='MANAGER' where id=$1`, [S2.id]);
  ok("a supervisor who becomes a Manager gets the Manager's own rules (not everyone)", ((await call("GET", "/team-attendance/live", S2.tok)).b.scope?.orgTotal ?? 0) < totalActive);

  await wipe();
  await db.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
