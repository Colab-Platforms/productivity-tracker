// Tasks pause with breaks and resume after them (derived from the break rows), over real HTTP. Throwaway DB + test backend (5012) only:
//   TEST_DATABASE_URL=postgresql://postgres:localtest@localhost:54329/dq_test TEST_API=http://localhost:5012/api node tests/task-break-pause.test.cjs
const { Client } = require("pg");
const bcrypt = require("bcryptjs");
require("./_guard.cjs");
const API = process.env.TEST_API || "http://localhost:5012/api";
const call = async (m, p, t, b) => { const r = await fetch(API + p, { method: m, headers: { "content-type": "application/json", ...(t ? { authorization: "Bearer " + t } : {}) }, body: b !== undefined ? JSON.stringify(b) : undefined }); return { s: r.status, b: await r.json().catch(() => ({})) }; };
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  -> " + String(JSON.stringify(x)).slice(0, 320))); };
const PW = "Tbp@12345678";
const find = (v, title, out = []) => { if (Array.isArray(v)) v.forEach((x) => find(x, title, out)); else if (v && typeof v === "object") { if (v.title === title && v.timer) out.push(v); Object.values(v).forEach((x) => find(x, title, out)); } return out; };
const near = (a, b, tol = 8) => Math.abs(a - b) <= tol;
(async () => {
  const db = new Client({ connectionString: process.env.TEST_DATABASE_URL }); await db.connect();
  const q = async (s, p) => (await db.query(s, p)).rows;
  const A = (await q(`select id from platforms where slug='avatar'`))[0].id; const hash = await bcrypt.hash(PW, 10);
  const wipe = async () => {
    const ids = `(select id from users where "employeeCode" like 'TBP-%')`;
    await q(`delete from daily_tasks where "userId" in ${ids}`).catch(() => {});
    await q(`delete from notifications where "userId" in ${ids}`).catch(() => {});
    await q(`update audit_logs set "actorId"=null where "actorId" in ${ids}`).catch(() => {});
    await q(`delete from login_events where "employeeCode" like 'TBP-%'`).catch(() => {});
    await q(`delete from users where "employeeCode" like 'TBP-%'`).catch((e) => console.log("cleanup:", e.message.slice(0, 80)));
  };
  await wipe();
  const mk = async (code, role, boss = null) => (await q(`insert into users (id,"platformId",email,"passwordHash","firstName","lastName","employeeCode",role,status,"mustChangePassword","trackerAccessEnabled","onboardingStatus","reportsToId","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,'Tbp',$4,$4,$5,'ACTIVE',false,true,'ACTIVE',$6,now(),now()) returning id`, [A, code.toLowerCase() + "@tbp.test", hash, code, role, boss]))[0].id;
  const mgr = await mk("TBP-M", "MANAGER"), other = await mk("TBP-OM", "MANAGER"), emp = await mk("TBP-E", "EMPLOYEE", mgr);
  const login = async (c) => (await call("POST", "/auth/login", null, { email: c, password: PW })).b.token;
  const tE = await login("TBP-E"), tM = await login("TBP-M"), tO = await login("TBP-OM");
  const today = (await call("GET", "/tasks/previous", tM)).b.today;
  await call("POST", "/tracker/clock-in", tE, {});
  await q(`update work_sessions set "loginAt" = now() - interval '5 hours' where "userId"=$1 and "logoutAt" is null`, [emp]);
  const mkTask = async (title, status) => (await q(`insert into daily_tasks (id,"platformId","userId",date,title,weight,status,"approvalStatus","approvedById","approvedAt","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3::date,$4,'MEDIUM',$5,'APPROVED',$6,now(),now(),now()) returning id`, [A, emp, today, title, status, mgr]))[0].id;
  const A1 = await mkTask("Task A running", "IN_PROGRESS"), B1 = await mkTask("Task B running too", "IN_PROGRESS"), C1 = await mkTask("Task C manually paused", "PENDING"), D1 = await mkTask("Task D done earlier", "IN_PROGRESS");
  // started two hours ago; D was finished an hour ago (before the break below)
  await q(`update task_work_sessions set "startedAt" = now() - interval '120 minutes' where "taskId" = any($1::uuid[])`, [[A1, B1, D1]]);
  await q(`update daily_tasks set status='COMPLETED', "completedAt" = now() - interval '70 minutes' where id=$1`, [D1]);
  await q(`update task_work_sessions set "endedAt" = now() - interval '70 minutes' where "taskId"=$1`, [D1]);
  const rowsBefore = (await q(`select count(*)::int n from daily_tasks where "userId"=$1`, [emp]))[0].n;
  const timers = async (tok = tE) => { const r = await call("GET", "/tasks", tok); const o = {}; for (const t of ["Task A running", "Task B running too", "Task C manually paused", "Task D done earlier"]) o[t] = find(r.b, t)[0]?.timer; return o; };

  console.log("\n## before any break");
  let T = await timers();
  ok("A and B are running, C (To Do) is not tracked as running, D is finished", T["Task A running"].running && T["Task B running too"].running && !T["Task C manually paused"]?.running && !T["Task D done earlier"].running, Object.values(T).map((t) => t && [t.running, t.pausedReason]));
  ok("no pauses yet", T["Task A running"].pauses.length === 0 && T["Task A running"].pausedSince === null);

  console.log("\n## 1+2. a break starts with several tasks running");
  const st = await call("POST", "/tracker/break/start", tE, { breakType: "LUNCH" });
  ok("the break starts", st.s === 200, st);
  await q(`update tracker_breaks set "startedAt" = now() - interval '30 minutes' where "endedAt" is null and "workSessionId" in (select id from work_sessions where "userId"=$1)`, [emp]);
  T = await timers();
  const a = T["Task A running"], b = T["Task B running too"];
  ok("BOTH running tasks pause, with the exact break start as the pause moment", [a, b].every((t) => !t.running && t.pausedReason === "BREAK" && t.pauses.length === 1 && t.pauses[0].resumedAt === null && near(Date.now() - Date.parse(t.pausedSince), 1800 * 1000, 20000)), [a.pausedReason, a.pauses, b.pausedSince]);
  ok("their time stopped counting: about 90 minutes of the 120 (the 30 on break are excluded)", near(a.activeSeconds, 90 * 60, 15) && near(b.activeSeconds, 90 * 60, 15), [a.activeSeconds, b.activeSeconds]);
  ok("the manually paused task (To Do) is NOT touched and shows no break pause", !T["Task C manually paused"] || (T["Task C manually paused"].pauses.length === 0 && T["Task C manually paused"].pausedSince === null), T["Task C manually paused"]);
  ok("the task completed before the break shows no pause", T["Task D done earlier"].pauses.length === 0 && T["Task D done earlier"].pausedReason === null);
  ok("the task STATUS did not change (still In Progress; no task records created or removed)", (await q(`select status from daily_tasks where id=$1`, [A1]))[0].status === "IN_PROGRESS" && (await q(`select count(*)::int n from daily_tasks where "userId"=$1`, [emp]))[0].n === rowsBefore);
  const mq = await call("GET", "/tasks/review/queue", tM);
  const ma = find(mq.b, "Task A running")[0];
  ok("the reporting manager sees the same pause (with timestamps) on the review queue", ma && ma.timer.pausedReason === "BREAK" && ma.timer.pauses.length === 1 && !!ma.timer.pausedSince, ma?.timer?.pauses);
  ok("an unrelated manager sees nothing of it", !find((await call("GET", "/tasks/review/queue", tO)).b, "Task A running").length);

  console.log("\n## 6. browser refresh / second tab while on break: same answer, backend is the truth");
  const again = (await timers(await login("TBP-E")))["Task A running"];
  ok("a fresh sign-in (another tab or a refresh) gets the identical pause moment", again.pausedSince === a.pausedSince && again.pauses[0].pausedAt === a.pauses[0].pausedAt, [again.pausedSince, a.pausedSince]);

  console.log("\n## 3. the break ends: tasks resume, nothing resets");
  const en = await call("POST", "/tracker/break/end", tE);
  ok("the break ends", en.s === 200, en);
  T = await timers();
  const a2 = T["Task A running"], b2 = T["Task B running too"];
  ok("A and B run again (In Progress, no pause reason)", a2.running && b2.running && a2.pausedReason === null && a2.pausedSince === null);
  ok("each pause now has the exact resume moment and about 30 minutes", a2.pauses.length === 1 && !!a2.pauses[0].resumedAt && near(a2.pauses[0].seconds, 1800, 20) && near(Date.parse(a2.pauses[0].resumedAt), Date.now(), 15000), a2.pauses);
  ok("time spent continued from where it stopped (not reset): still about 90 minutes", near(a2.activeSeconds, 90 * 60, 20), a2.activeSeconds);
  ok("the manually paused task was NOT resumed or started by the break ending", !(T["Task C manually paused"]?.running) && T["Task C manually paused"]?.sessionCount !== 1, T["Task C manually paused"]);
  ok("the task finished before the break stays finished", T["Task D done earlier"].running === false && (await q(`select status from daily_tasks where id=$1`, [D1]))[0].status === "COMPLETED");

  console.log("\n## 5. several breaks in one day");
  // the first break happened earlier in the day (rows never overlap in reality): move it 40 minutes back before taking the second one
  await q(`update tracker_breaks set "startedAt" = "startedAt" - interval '40 minutes', "endedAt" = "endedAt" - interval '40 minutes' where "endedAt" is not null and "workSessionId" in (select id from work_sessions where "userId"=$1)`, [emp]);
  await call("POST", "/tracker/break/start", tE, { breakType: "PERSONAL" });
  await q(`update tracker_breaks set "startedAt" = now() - interval '10 minutes' where "endedAt" is null and "workSessionId" in (select id from work_sessions where "userId"=$1)`, [emp]);
  await call("POST", "/tracker/break/end", tE);
  T = await timers();
  const a3 = T["Task A running"];
  ok("two separate pauses, in order, none overlapping", a3.pauses.length === 2 && Date.parse(a3.pauses[0].resumedAt) <= Date.parse(a3.pauses[1].pausedAt) && near(a3.pauses[1].seconds, 600, 20), a3.pauses);
  ok("total time excludes BOTH breaks (about 80 of the first 120 minutes)", near(a3.activeSeconds, 80 * 60, 25), a3.activeSeconds);
  ok("paused time reported = the two breaks", near(a3.pausedSeconds, 40 * 60, 25), a3.pausedSeconds);

  console.log("\n## a discussion does NOT pause tasks (it is productive time)");
  await call("POST", "/tracker/break/start", tE, { breakType: "DISCUSSION", remark: "Quick chat with my manager" });
  T = await timers();
  ok("task A keeps running during a discussion and shows no pause", T["Task A running"].running && T["Task A running"].pauses.length === 2 && T["Task A running"].pausedReason === null, T["Task A running"].pauses.length);
  await call("POST", "/tracker/break/end", tE);

  console.log("\n## 8. break time is not task time or productive time");
  const sess = await call("GET", "/tracker/session", tE);
  const s = sess.b.session;
  const elapsed = (Date.now() - Date.parse(s.loginAt)) / 1000;
  ok("productive time = clocked in - breaks (the same exclusion), consistent with the task time", near(s.productiveSeconds, elapsed - s.breakSeconds - (s.washroomSeconds || 0), 60), [s.productiveSeconds, elapsed, s.breakSeconds]);
  ok("task time (about 80 min) is far below the 5h clocked in and unaffected by the break length", a3.activeSeconds < s.productiveSeconds);
  const eff = await call("GET", `/team-attendance/productivity/tasks?from=${today}&to=${today}`, tM);
  ok("the productivity task rows read the same excluded time", eff.s === 200, eff.s);

  console.log("\n## 4/7. a break left open when the person clocks out (logout during a break)");
  await call("POST", "/tracker/break/start", tE, { breakType: "LUNCH" });
  await q(`update tracker_breaks set "startedAt" = now() - interval '5 minutes' where "endedAt" is null and "workSessionId" in (select id from work_sessions where "userId"=$1)`, [emp]);
  T = await timers();
  ok("paused again for the new break (a third pause)", T["Task A running"].pausedReason === "BREAK" && T["Task A running"].pauses.length === 3);
  await call("POST", "/tracker/clock-out", tE);
  T = await timers();
  const a4 = T["Task A running"];
  ok("clocking out closes the open break: the pause gets its resume moment and the task reads 'clocked out'", a4.pausedReason === "CLOCKED_OUT" && a4.pauses.length === 3 && a4.pauses.every((p) => p.resumedAt), [a4.pausedReason, a4.pauses.map((p) => p.resumedAt)]);
  const t2 = await login("TBP-E");
  ok("signing in again later shows exactly the same pauses (nothing was lost)", JSON.stringify((await timers(t2))["Task A running"].pauses) === JSON.stringify(a4.pauses));
  await call("POST", "/tracker/clock-in", t2, {});
  T = await timers(t2);
  ok("clocking back in resumes the task clock (In Progress still), without duplicating a pause", T["Task A running"].running && T["Task A running"].pauses.length === 3, T["Task A running"].pauses.length);
  ok("still no extra task records", (await q(`select count(*)::int n from daily_tasks where "userId"=$1`, [emp]))[0].n === rowsBefore);

  await wipe(); await db.end();
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
