// Admin console overview over HTTP: Admin only, limited to the companies the Admin acts on, numbers equal the raw rows.
// Disposable database only (see _guard.cjs).
//
//   cd backend && TEST_DATABASE_URL=... TEST_API=http://localhost:5012/api node tests/admin-console.test.cjs
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
const PW = "Adc@12345678";

(async () => {
  const db = new Client({ connectionString: process.env.TEST_DATABASE_URL }); await db.connect();
  const q = async (s, p) => (await db.query(s, p)).rows;
  const AV = (await q(`select id from platforms where slug='avatar'`))[0].id;
  const AVN = (await q(`select id from platforms where slug='avance'`))[0].id;
  const hash = await bcrypt.hash(PW, 10);
  const wipe = async () => {
    const ids = `(select id from users where "employeeCode" like 'ADC-%')`;
    await q(`delete from task_entry_details where "taskId" in (select id from daily_tasks where "userId" in ${ids})`);
    await q(`delete from daily_tasks where "userId" in ${ids}`);
    await q(`delete from work_sessions where "userId" in ${ids}`);
    await q(`delete from teams where name like 'ADC-%'`);
    await q(`delete from notifications where "userId" in ${ids}`);
    await q(`delete from audit_logs where "userId" in ${ids}`).catch(() => {});
    await q(`delete from users where "employeeCode" like 'ADC-%'`);
  };
  await wipe();
  const mk = async (code, role, platformId, reportsToId = null) => {
    await q(`insert into users (id,"platformId",email,"passwordHash","firstName","lastName","employeeCode",role,status,"mustChangePassword","trackerAccessEnabled","onboardingStatus","reportsToId","dateOfJoining","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,$4,'Adc',$5,$6,'ACTIVE',false,true,'ACTIVE',$7,'2026-01-01',now(),now())`, [platformId, code.toLowerCase() + "@adc.test", hash, code.replace("ADC-", "D"), code, role, reportsToId]);
    const id = (await q(`select id from users where "employeeCode"=$1`, [code]))[0].id;
    const tok = (await (await fetch(API + "/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: code, password: PW }) })).json()).token;
    return { id, tok };
  };
  const AD = await mk("ADC-AD", "ADMIN", AV), ADB = await mk("ADC-ADB", "ADMIN", AVN), HR = await mk("ADC-HR", "HR", AV);
  const M = await mk("ADC-M", "MANAGER", AV, AD.id);
  const E1 = await mk("ADC-E1", "EMPLOYEE", AV, M.id), E2 = await mk("ADC-E2", "EMPLOYEE", AV, M.id), NB = await mk("ADC-NB", "EMPLOYEE", AV);
  const EB = await mk("ADC-EB", "EMPLOYEE", AVN);
  const today = (await call("GET", "/tracker/timesheet", E1.tok)).b.today;
  await q(`insert into teams (id,"platformId",name,"managerId","isActive","createdAt","updatedAt") values (gen_random_uuid(),$1,'ADC-Project',$2,true,now(),now())`, [AV, M.id]);
  // a worked day today for E1 (8h productive) so the productivity figure has something to show
  const login = new Date(Date.now() - 9 * 3600e3).toISOString(), logout = new Date().toISOString();
  await q(`insert into work_sessions (id,"platformId","userId",date,"loginAt","logoutAt",status,"productiveSeconds","breakSeconds","meetingSeconds","wasLateLogin","lateByMinutes","autoClosed","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3::date,$4,$5,'COMPLETED',28800,0,0,false,0,false,now(),now())`, [AV, E1.id, today, login, logout]);
  const T = (await q(`insert into daily_tasks (id,"platformId","userId",date,title,weight,status,"approvalStatus","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3::date,'Dash task','MEDIUM','COMPLETED','APPROVED',now(),now()) returning id`, [AV, E1.id, today]))[0].id;
  await q(`insert into task_entry_details (id,"platformId","taskId","hoursSpent","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,3.5,now(),now())`, [AV, T]);

  console.log("\n## who may open it");
  ok("no sign-in = 401", (await call("GET", "/admin-console/overview")).s === 401);
  ok("HR is refused (403)", (await call("GET", "/admin-console/overview", HR.tok)).s === 403);
  ok("a manager is refused (403)", (await call("GET", "/admin-console/overview", M.tok)).s === 403);
  ok("an employee is refused (403)", (await call("GET", "/admin-console/overview", E1.tok)).s === 403);

  console.log("\n## the Admin's numbers equal the rows");
  const r = await call("GET", "/admin-console/overview", AD.tok);
  ok("the Admin gets it", r.s === 200 && r.b.today === today, r);
  const d = r.b;
  const raw = async (company) => (await q(`select role::text r, count(*)::int n from users where "platformId"=$1 and status in ('ACTIVE','INVITED') group by role`, [company])).reduce((o, x) => ({ ...o, [x.r]: x.n }), {});
  const rawAv = await raw(AV);
  const total = Object.values(rawAv).reduce((a, b) => a + b, 0);
  ok("people total equals the active people of the Admin's company", d.people.total === total, [d.people.total, total]);
  ok("people by role equal the raw counts", ["ADMIN", "HR", "MANAGER", "EMPLOYEE"].every((k) => (d.people.byRole[k] ?? 0) === (rawAv[k] ?? 0)), [d.people.byRole, rawAv]);
  ok("another company's people are not in the Admin's numbers", !d.people.byCompany.some((c) => c.id === AVN) && d.people.companies === 1, d.people.byCompany);
  const mgr = d.people.managers.find((m) => m.employeeCode === "ADC-M");
  ok("manager distribution: the manager has 2 employees", mgr?.employees === 2, d.people.managers);
  ok("the employee with no reporting line is counted as unmapped", d.people.unmappedCount >= 1, d.people.unmappedCount);
  ok("projects count equals the active teams", d.people.projects === (await q(`select count(*)::int n from teams where "platformId"=$1 and "isActive"=true`, [AV]))[0].n, d.people.projects);
  ok("attendance has 7 days and the last one is today", d.attendance.trend.length === 7 && d.attendance.trend.at(-1).date === today, d.attendance.trend.map((t) => t.date));
  ok("someone who worked today is counted as present (or late/half day) today", (d.attendance.today.PRESENT ?? 0) + (d.attendance.today.LATE ?? 0) + (d.attendance.today.HALF_DAY ?? 0) >= 1, d.attendance.today);
  const prodToday = d.productivity.trend.at(-1);
  ok("productivity today = the stored productive hours (8 h for the one person who worked)", prodToday.people >= 1 && prodToday.avgHours > 0, prodToday);
  ok("tasks today: one planned, approved and completed task", d.tasks.today.planned >= 1 && d.tasks.today.approved >= 1 && d.tasks.today.completed >= 1, d.tasks.today);
  ok("the week's recorded hours include the 3.5 h on that task", d.tasks.week.hoursSpent >= 3.5, d.tasks.week);
  ok("leave counters are numbers", ["awaitingHr", "awaitingFirstLevel", "awaitingMyApproval"].every((k) => typeof d.leave[k] === "number"), d.leave);
  ok("recent activity is a short list", Array.isArray(d.activity) && d.activity.length <= 8, d.activity?.length);

  console.log("\n## another company's Admin sees only their own");
  const rb = await call("GET", "/admin-console/overview", ADB.tok);
  ok("the other Admin gets their own numbers", rb.s === 200 && rb.b.people.byCompany.length === 1 && rb.b.people.byCompany[0].id === AVN, rb.b.people?.byCompany);
  ok("...and none of the first company's people or projects", !rb.b.people.managers.some((m) => m.employeeCode === "ADC-M") && rb.b.tasks.today.planned === 0, rb.b.tasks?.today);

  await wipe();
  await db.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
