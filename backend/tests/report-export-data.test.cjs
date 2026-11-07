// Data behind the Excel exports of Attendance, Shift breakdown and Task productivity: the new fields (projects, reporting manager, Team Huddle,
// the tasks behind the productivity report), who may see them, and that nothing the reports already showed changed.
// Disposable database only (see _guard.cjs).
//
//   cd backend && TEST_DATABASE_URL=... TEST_API=http://localhost:5012/api node tests/report-export-data.test.cjs
const { Client } = require("pg");
const bcrypt = require("bcryptjs");
const API = process.env.TEST_API ?? "http://localhost:5012/api";
const DB = process.env.TEST_DATABASE_URL;
require("./_guard.cjs").assertTestDb(DB);

const call = async (m, p, t) => {
  const r = await fetch(API + p, { method: m, headers: { ...(t ? { authorization: "Bearer " + t } : {}) } });
  const txt = await r.text(); let j; try { j = JSON.parse(txt); } catch { j = txt; }
  return { s: r.status, b: j };
};
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  -> " + String(JSON.stringify(x)).slice(0, 400))); };
const PW = "Rxp@12345678";
const qs = (o) => "?" + new URLSearchParams(o).toString();
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

(async () => {
  const db = new Client({ connectionString: DB }); await db.connect();
  const q = async (s, p) => (await db.query(s, p)).rows;
  const AV = (await q(`select id from platforms where slug='avatar'`))[0].id;
  const AVN = (await q(`select id from platforms where slug='avance'`))[0].id;
  const hash = await bcrypt.hash(PW, 10);
  const wipe = async () => {
    const ids = `(select id from users where "employeeCode" like 'RXP-%')`;
    for (const s of [
      `delete from task_entry_details where "taskId" in (select id from daily_tasks where "userId" in ${ids})`,
      `delete from daily_tasks where "userId" in ${ids}`,
      `delete from tracker_breaks where "workSessionId" in (select id from work_sessions where "userId" in ${ids})`,
      `delete from work_sessions where "userId" in ${ids}`,
      `delete from company_access where "userId" in ${ids}`,
      `delete from team_members where "userId" in ${ids}`,
      `delete from teams where name like 'RXP-%'`,
      `delete from notifications where "userId" in ${ids}`,
      `delete from users where "employeeCode" like 'RXP-%'`,
    ]) await q(s).catch(() => {});
  };
  await wipe();
  const mk = async (code, role, pid, o = {}) => {
    await q(`insert into users (id,"platformId",email,"passwordHash","firstName","lastName","employeeCode",role,status,"mustChangePassword","trackerAccessEnabled","onboardingStatus","reportsToId","dateOfJoining","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,$4,'Rxp',$5,$6,'ACTIVE',false,true,'ACTIVE',$7,'2026-01-01',now(),now())`, [pid, code.toLowerCase() + "@rxp.test", hash, o.first ?? code.replace("RXP-", ""), code, role, o.boss ?? null]);
    const id = (await q(`select id from users where "employeeCode"=$1`, [code]))[0].id;
    const tok = (await (await fetch(API + "/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: code, password: PW }) })).json()).token;
    return { id, tok, first: o.first ?? code.replace("RXP-", "") };
  };
  const HRALL = await mk("RXP-HRALL", "HR", AV); await q(`insert into company_access (id,"userId","platformId","createdAt") values (gen_random_uuid(),$1,null,now())`, [HRALL.id]);
  const HROWN = await mk("RXP-HROWN", "HR", AV);
  const M1 = await mk("RXP-M1", "MANAGER", AV, { first: "Mia" });
  const M2 = await mk("RXP-M2", "MANAGER", AVN, { first: "Max" });
  const E1 = await mk("RXP-E1", "EMPLOYEE", AV, { first: "Ravi", boss: M1.id });
  const E2 = await mk("RXP-E2", "EMPLOYEE", AV, { first: "Sana", boss: M1.id });
  const E3 = await mk("RXP-E3", "EMPLOYEE", AV, { first: "Asha" });
  const E4 = await mk("RXP-E4", "EMPLOYEE", AVN, { first: "Omar", boss: M2.id });
  const team = async (name, pid, ms) => {
    const id = (await q(`insert into teams (id,"platformId",name,"isActive","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,true,now(),now()) returning id`, [pid, name]))[0].id;
    for (const u of ms) await q(`insert into team_members (id,"teamId","userId","isActive","isPrimary","joinedAt") values (gen_random_uuid(),$1,$2,true,false,now())`, [id, u.id]);
    return id;
  };
  const P1 = await team("RXP-Alpha", AV, [E1, E2]);
  const P2 = await team("RXP-Beta", AV, [E1, E3]);
  const P3 = await team("RXP-Gamma", AVN, [E4]);
  const today = (await call("GET", "/tracker/timesheet", E1.tok)).b.today;
  const at = (day, h) => new Date(`${day}T${h}:00+05:30`).toISOString();
  const session = async (u, pid, day) => (await q(`insert into work_sessions (id,"platformId","userId",date,"loginAt","logoutAt",status,"productiveSeconds","breakSeconds","meetingSeconds","wasLateLogin","lateByMinutes","autoClosed","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3::date,$4,$5,'COMPLETED',25200,1800,0,false,0,false,now(),now()) returning id`, [pid, u.id, day, at(day, "09:30"), at(day, "17:30")]))[0].id;
  const brk = (sid, type, from, to) => q(`insert into tracker_breaks (id,"workSessionId","breakType","startedAt","endedAt","durationSeconds","autoClosed","createdAt") values (gen_random_uuid(),$1,$2,$3,$4,$5,false,now())`, [sid, type, at(today, from), at(today, to), (Number(to.slice(0, 2)) * 60 + Number(to.slice(3)) - Number(from.slice(0, 2)) * 60 - Number(from.slice(3))) * 60]);
  for (const [u, pid] of [[E1, AV], [E2, AV], [E3, AV], [E4, AVN]]) {
    const sid = await session(u, pid, today);
    if (u === E1) { await brk(sid, "TEA", "11:00", "11:15"); await brk(sid, "LUNCH", "13:00", "13:30"); await brk(sid, "WASHROOM", "15:00", "15:05"); }
  }

  // tasks for E1 (and one for E4): finished+approved (counts), pending, rejected, an older task finished today (counts today), a cancelled one
  const task = async (u, pid, o) => {
    const lit = (v) => { if (!/^[A-Z_]+$/.test(v)) throw new Error('bad literal'); return `'${v}'`; };
    const id = (await q(`insert into daily_tasks (id,"platformId","userId",date,title,description,weight,status,"approvalStatus","teamId","completedAt","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3::date,$4,$5,${lit(o.weight ?? "MEDIUM")},${lit(o.status)},${lit(o.approval)},$6,$7,now(),now()) returning id`, [pid, u.id, o.date ?? today, o.title, o.desc ?? null, o.team ?? null, o.done ?? null]))[0].id;
    if (o.hours !== undefined || o.tag) await q(`insert into task_entry_details (id,"platformId","taskId","hoursSpent","taggedManagerId","blocked","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,$4,$5,now(),now())`, [pid, id, o.hours ?? null, o.tag ?? null, !!o.blocked]);
    return id;
  };
  const yesterday = new Date(new Date(today + "T00:00:00Z").getTime() - 864e5).toISOString().slice(0, 10);
  const nowIso = new Date().toISOString();
  await task(E1, AV, { title: "RXP finished", desc: "done and approved", weight: "HIGH", status: "COMPLETED", approval: "APPROVED", team: P1, done: nowIso, hours: 3.5, tag: M1.id });
  await task(E1, AV, { title: "RXP waiting", status: "IN_PROGRESS", approval: "PENDING", team: P2, hours: 1.25, tag: M1.id });
  await task(E1, AV, { title: "RXP blocked", status: "IN_PROGRESS", approval: "APPROVED", team: P1, hours: 0.5, tag: M1.id, blocked: true });
  await task(E1, AV, { title: "RXP rejected", status: "PENDING", approval: "REJECTED", team: P2 });
  await task(E1, AV, { title: "RXP older finished today", date: yesterday, status: "COMPLETED", approval: "APPROVED", team: P1, done: nowIso, hours: 2 });
  await task(E1, AV, { title: "RXP cancelled", status: "CANCELLED", approval: "APPROVED", team: P1 });
  await task(E2, AV, { title: "RXP sana finished", status: "COMPLETED", approval: "APPROVED", team: P1, done: nowIso, hours: 1 });
  await task(E4, AVN, { title: "RXP omar finished", status: "COMPLETED", approval: "APPROVED", team: P3, done: nowIso, hours: 4 });

  const codes = (rows, key = "employeeCode") => [...new Set((rows ?? []).map((r) => r[key]).filter((c) => c && c.startsWith("RXP-E")))].sort();
  const row = (res, c) => (res.b.rows ?? []).find((x) => x.employeeCode === c);

  console.log("\n## Attendance report: the fields the Excel adds");
  const att = await call("GET", "/team-attendance/attendance" + qs({ from: today, to: today }), HRALL.tok);
  const a1 = row(att, "RXP-E1"), a3 = row(att, "RXP-E3");
  ok("every row carries projects, reportingManager and huddleHours", att.b.rows.every((r) => Array.isArray(r.projects) && "reportingManager" in r && "huddleHours" in r), att.b.rows[0]);
  ok("E1 is on two projects, listed alphabetically, once each", eq(a1.projects, ["RXP-Alpha", "RXP-Beta"]), a1.projects);
  ok("E1's reporting manager is named; E3 has none (null, not invented)", a1.reportingManager === "Mia Rxp" && a3.reportingManager === null, [a1.reportingManager, a3.reportingManager]);
  ok("no Team Huddle recorded -> blank (null), not 0", a1.huddleHours === null);
  ok("the figures the report already had are still there", a1.statusLabel && a1.workedHours !== null && a1.productiveHours !== null && a1.breakHours !== null && "tasksCompleted" in a1 && "tasksPlanned" in a1 && a1.loginAt && a1.logoutAt, a1);
  ok("one row per person per day (no duplicates)", new Set(att.b.rows.map((r) => r.userId + "|" + r.date)).size === att.b.rows.length);
  ok("KPIs match the rows", att.b.kpis.employees === new Set(att.b.rows.map((r) => r.userId)).size);

  console.log("\n## Shift breakdown: the fields the Excel adds");
  const sb = await call("GET", "/team-attendance/shift-breakdown" + qs({ date: today }), HRALL.tok);
  const s1 = row(sb, "RXP-E1");
  ok("rows carry projects and reportingManager", s1.projects && eq(s1.projects, ["RXP-Alpha", "RXP-Beta"]) && s1.reportingManager === "Mia Rxp", s1);
  ok("tea 15 min, lunch 30 min, washroom 5 min come through (washroom is not in the break total)", s1.teaSeconds === 900 && s1.lunchSeconds === 1800 && s1.bioSeconds === 300, [s1.teaSeconds, s1.lunchSeconds, s1.bioSeconds]);
  ok("a person with no session still has a row with project and manager", sb.b.rows.every((r) => Array.isArray(r.projects) && "reportingManager" in r) && !!row(sb, "RXP-E4"));
  ok("login, logout, shift length and productive time are present", s1.loginAt && s1.logoutAt && s1.shiftSeconds > 0 && s1.productiveSeconds !== null && s1.productiveTargetSeconds > 0);
  ok("one row per person", new Set(sb.b.rows.map((r) => r.userId)).size === sb.b.rows.length);

  console.log("\n## Task productivity: the report and the tasks behind it");
  const prod = await call("GET", "/team-attendance/productivity" + qs({ from: today, to: today }), HRALL.tok);
  const tasks = await call("GET", "/team-attendance/productivity/tasks" + qs({ from: today, to: today }), HRALL.tok);
  const p1 = (prod.b.people ?? []).find((p) => p.employeeCode === "RXP-E1");
  ok("each person carries projects and reportingManager", p1 && eq(p1.projects, ["RXP-Alpha", "RXP-Beta"]) && p1.reportingManager === "Mia Rxp", p1);
  ok("the tasks endpoint answers with scope and the same period", tasks.s === 200 && tasks.b.from === today && tasks.b.to === today && tasks.b.scope, tasks.b);
  const mine = (tasks.b.tasks ?? []).filter((t) => t.employeeCode?.startsWith("RXP-E"));
  const ids = mine.map((t) => t.id);
  ok("no task appears twice", new Set(ids).size === ids.length, ids.length);
  ok("every task of the people in range is there: date-in-range ones AND the older one finished today", ["RXP finished", "RXP waiting", "RXP blocked", "RXP rejected", "RXP cancelled", "RXP older finished today", "RXP sana finished", "RXP omar finished"].every((t) => mine.some((x) => x.title === t)), mine.map((t) => t.title));
  const byTitle = (t) => mine.find((x) => x.title === t);
  const f = byTitle("RXP finished");
  ok("a task row has employee, ID, project, reporting manager, tagged manager, description, date, priority, hours, progress, approval", f.employee === "Ravi Rxp" && f.employeeCode === "RXP-E1" && f.project === "RXP-Alpha" && f.reportingManager === "Mia Rxp" && f.taggedManager === "Mia Rxp" && f.description === "done and approved" && f.date === today && f.priority === "HIGH" && f.hoursSpent === 3.5 && f.progress === "COMPLETED" && f.approvalStatus === "APPROVED", f);
  ok("progress is shown the way the form states it (in progress / blocked / cancelled)", byTitle("RXP waiting").progress === "IN_PROGRESS" && byTitle("RXP blocked").progress === "BLOCKED" && byTitle("RXP cancelled").progress === "CANCELLED");
  ok("approval status is exact (pending / rejected)", byTitle("RXP waiting").approvalStatus === "PENDING" && byTitle("RXP rejected").approvalStatus === "REJECTED");
  ok("a task with no hours entered is blank, not 0", byTitle("RXP rejected").hoursSpent === null);
  const counted = mine.filter((t) => t.counted).map((t) => t.title).sort();
  ok("'counted' = completed + approved + finished in range (the report's own rule), including the older task finished today", eq(counted, ["RXP finished", "RXP older finished today", "RXP omar finished", "RXP sana finished"].sort()), counted);
  const reportTotal = (prod.b.people ?? []).filter((p) => p.employeeCode?.startsWith("RXP-E")).reduce((s, p) => s + (p.completedTotal ?? 0), 0);
  ok("the number of counted tasks equals the report's 'Tasks completed' total", reportTotal === counted.length && reportTotal === 4, [reportTotal, counted.length]);

  console.log("\n## who may see what");
  const tM1 = await call("GET", "/team-attendance/productivity/tasks" + qs({ from: today, to: today }), M1.tok);
  ok("a manager gets only the tasks of the people who report to them", eq(codes(tM1.b.tasks), ["RXP-E1", "RXP-E2"]), codes(tM1.b.tasks));
  const tOwn = await call("GET", "/team-attendance/productivity/tasks" + qs({ from: today, to: today }), HROWN.tok);
  ok("HR without an all-company grant gets no other company's tasks", !codes(tOwn.b.tasks).includes("RXP-E4") && codes(tOwn.b.tasks).includes("RXP-E1"), codes(tOwn.b.tasks));
  ok("HR with the grant gets both companies", eq(codes(tasks.b.tasks), ["RXP-E1", "RXP-E2", "RXP-E4"]), codes(tasks.b.tasks));
  ok("an employee cannot open the tasks endpoint (403)", (await call("GET", "/team-attendance/productivity/tasks" + qs({ from: today, to: today }), E1.tok)).s === 403);
  ok("not signed in -> 401", (await call("GET", "/team-attendance/productivity/tasks")).s === 401);
  ok("a manager cannot widen it with a company filter", codes((await call("GET", "/team-attendance/productivity/tasks" + qs({ from: today, to: today, company: AVN }), M1.tok)).b.tasks).length === 0);

  console.log("\n## filters narrow the export data, never widen it");
  const tProj = await call("GET", "/team-attendance/productivity/tasks" + qs({ from: today, to: today, project: P3 }), HRALL.tok);
  ok("Project filter: only that project's people", eq(codes(tProj.b.tasks), ["RXP-E4"]), codes(tProj.b.tasks));
  const tSearch = await call("GET", "/team-attendance/productivity/tasks" + qs({ from: today, to: today, q: "sana" }), HRALL.tok);
  ok("Employee search: only matching people", eq(codes(tSearch.b.tasks), ["RXP-E2"]), codes(tSearch.b.tasks));
  const tMgr = await call("GET", "/team-attendance/productivity/tasks" + qs({ from: today, to: today, manager: M1.id }), HRALL.tok);
  ok("Reporting-manager filter works", eq(codes(tMgr.b.tasks), ["RXP-E1", "RXP-E2"]), codes(tMgr.b.tasks));
  const pf = await call("GET", "/team-attendance/productivity" + qs({ from: today, to: today, project: P3 }), HRALL.tok);
  ok("the report and the task list use the same filtered people", eq(codes(pf.b.people), codes(tProj.b.tasks)));
  const tOther = await call("GET", "/team-attendance/productivity/tasks" + qs({ from: yesterday, to: yesterday }), HRALL.tok);
  ok("a different day: the older task (dated yesterday) is listed on its own date", (tOther.b.tasks ?? []).some((t) => t.title === "RXP older finished today" && t.date === yesterday));
  ok("a range over 93 days is refused (400)", (await call("GET", "/team-attendance/productivity/tasks" + qs({ from: "2026-01-01", to: "2026-06-01" }), HRALL.tok)).s === 400);
  ok("a bad id is refused, not a database error", (await call("GET", "/team-attendance/productivity/tasks?userId=nope", HRALL.tok)).s === 400);

  await wipe();
  console.log(`\n${pass} passed, ${fail} failed`);
  await db.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("CRASH", e); process.exit(1); });
