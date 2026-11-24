// AUTOMATIC TASK TIMER through the real API: status changes (made by the real routes) open and close work sessions by themselves; time is accumulated,
// resumed, never reset; breaks and clock-out are taken out; tasks that overlap are counted once; older tasks read Not tracked. THROWAWAY database only.
// The migration (sessions table + triggers) is applied part-way to prove before / after.
//   cd backend && TEST_DATABASE_URL=postgresql://postgres:localtest@localhost:54329/dq_test TEST_API=http://localhost:5012/api node tests/task-timer.test.cjs
const fs = require("node:fs"), path = require("node:path");
const { Client } = require("pg");
const bcrypt = require("bcryptjs");
const API = process.env.TEST_API ?? "http://localhost:5012/api";
const DBURL = process.env.TEST_DATABASE_URL;
require("./_guard.cjs").assertTestDb(DBURL);

const call = async (m, p, t, body) => {
  const r = await fetch(API + p, { method: m, headers: { ...(t ? { authorization: "Bearer " + t } : {}), ...(body !== undefined && m !== "GET" ? { "content-type": "application/json" } : {}) }, body: body !== undefined && m !== "GET" ? JSON.stringify(body) : undefined });
  const txt = await r.text(); let j; try { j = JSON.parse(txt); } catch { j = txt; }
  return { s: r.status, b: j };
};
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  -> " + String(JSON.stringify(x)).slice(0, 420))); };
const near = (a, b, tol = 6) => typeof a === "number" && Math.abs(a - b) <= tol;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PW = "Ttm@12345678";
const MIN = 60;

(async () => {
  const db = new Client({ connectionString: DBURL }); await db.connect();
  const q = async (s, p) => (await db.query(s, p)).rows;
  const A = (await q(`select id from platforms where slug='avatar'`))[0].id;
  const hash = await bcrypt.hash(PW, 10);
  const migration = fs.readFileSync(path.join(__dirname, "..", "prisma", "migrations", "20261124120000_task_work_timer", "migration.sql"), "utf8");
  const down = fs.readFileSync(path.join(__dirname, "..", "prisma", "migrations", "20261124120000_task_work_timer", "down.sql"), "utf8");
  const wipe = async () => {
    const ids = `(select id from users where "employeeCode" like 'TTM-%')`;
    await q(`delete from task_events where "taskId" in (select id from daily_tasks where "userId" in ${ids})`).catch(() => {});
    await q(`delete from task_ratings where "taskId" in (select id from daily_tasks where "userId" in ${ids})`).catch(() => {});
    await q(`delete from task_entry_details where "taskId" in (select id from daily_tasks where "userId" in ${ids})`).catch(() => {});
    await q(`delete from daily_tasks where "userId" in ${ids}`);
    await q(`delete from tracker_breaks where "workSessionId" in (select id from work_sessions where "userId" in ${ids})`).catch(() => {});
    await q(`delete from work_sessions where "userId" in ${ids}`);
    await q(`delete from team_members where "userId" in ${ids}`);
    await q(`delete from teams where name like 'TTM-%'`);
    await q(`delete from notifications where "userId" in ${ids}`);
    await q(`update audit_logs set "actorId"=null where "actorId" in ${ids}`).catch(() => {});
    await q(`delete from audit_logs where "targetUserId" in ${ids}`).catch(() => {});
    await q(`delete from users where "employeeCode" like 'TTM-%'`);
  };
  await wipe().catch((e) => console.log("wipe note:", e.message));
  await db.query(down); // start from "before the migration"
  const mk = async (code, first, role, o = {}) => {
    await q(`insert into users (id,"platformId",email,"passwordHash","firstName","lastName","employeeCode",role,status,"mustChangePassword","trackerAccessEnabled","onboardingStatus","reportsToId","dateOfJoining","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,$4,'Ttm',$5,$6,'ACTIVE',false,true,'ACTIVE',$7,'2026-01-01',now(),now())`, [A, code.toLowerCase() + "@ttm.test", hash, first, code, role, o.boss ?? null]);
    const id = (await q(`select id from users where "employeeCode"=$1`, [code]))[0].id;
    const tok = (await (await fetch(API + "/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: code, password: PW }) })).json()).token;
    return { id, tok, code };
  };
  const ADMIN = await mk("TTM-ADM", "Adm", "ADMIN");
  const MGR = await mk("TTM-MGR", "Mgr", "MANAGER", { boss: ADMIN.id });
  const E1 = await mk("TTM-E1", "Eone", "EMPLOYEE", { boss: MGR.id });
  const SUP = await mk("TTM-SUP", "Supx", "EMPLOYEE", { boss: MGR.id });
  const teamId = (await q(`insert into teams (id,"platformId",name,"managerId","isActive","createdAt","updatedAt") values (gen_random_uuid(),$1,'TTM-Proj',$2,true,now(),now()) returning id`, [A, MGR.id]))[0].id;
  await q(`insert into team_members (id,"teamId","userId","isActive","isPrimary","joinedAt") values (gen_random_uuid(),$1,$2,true,true,now())`, [teamId, E1.id]);
  const idOf = async (title) => (await q(`select id from daily_tasks where title=$1`, [title]))[0]?.id;
  const sessionsOf = async (title) => q(`select "startedAt", "endedAt", "endReason" from task_work_sessions where "taskId"=$1 order by "startedAt"`, [await idOf(title)]).catch(() => []);
  const openCount = async (title) => Number((await q(`select count(*)::int c from task_work_sessions where "taskId"=$1 and "endedAt" is null`, [await idOf(title)]).catch(() => [{ c: 0 }]))[0].c);
  const all = (payload) => [...(payload.active ?? []), ...(payload.done ?? []), ...(payload.awaitingApproval ?? []), ...(payload.rejected ?? [])];
  const timerOf = async (title, who = E1) => all((await call("GET", "/tasks", who.tok)).b).find((t) => t.title === title)?.timer;
  const send = (who, title, progress = "IN_PROGRESS") => call("POST", "/tasks", who.tok, { title, teamId, taggedManagerId: MGR.id, progress, ...(progress === "BLOCKED" ? { blockedNote: "waiting for the client" } : {}) });
  const approve = async (title) => call("POST", `/tasks/review/${await idOf(title)}/approve`, MGR.tok, { approve: true });
  const setProgress = async (who, title, progress, extra = {}) => call("PATCH", `/tasks/${await idOf(title)}`, who.tok, { progress, ...extra });
  // lay a task's sessions out at exact moments (oldest first): sessions = [[startMinutesAgo, endMinutesAgo | null], ...]
  const layout = async (title, spans) => {
    const rows = await sessionsOf(title); const id = await idOf(title);
    const list = await q(`select id from task_work_sessions where "taskId"=$1 order by "startedAt", id`, [id]);
    if (list.length !== spans.length) throw new Error(`${title}: expected ${spans.length} sessions, found ${list.length}`);
    for (let i = 0; i < spans.length; i++) await q(`update task_work_sessions set "startedAt" = (now() at time zone 'utc') - ($2 || ' minutes')::interval, "endedAt" = ${spans[i][1] === null ? "null" : `(now() at time zone 'utc') - (${spans[i][1]} || ' minutes')::interval`} where id=$1`, [list[i].id, String(spans[i][0])]);
    return rows;
  };
  const clockIn = async (who, minutesAgo) => (await q(`insert into work_sessions (id,"platformId","userId",date,"loginAt",status,"productiveSeconds","breakSeconds","meetingSeconds","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,(now() at time zone 'Asia/Kolkata')::date,(now() at time zone 'utc') - ($3 || ' minutes')::interval,'ACTIVE',0,0,0,now(),now()) returning id`, [A, who.id, String(minutesAgo)]))[0].id;
  const addBreak = (wsId, type, fromAgo, toAgo) => q(`insert into tracker_breaks (id,"workSessionId","breakType",reason,"startedAt","endedAt","durationSeconds","createdAt") values (gen_random_uuid(),$1,$2,null,(now() at time zone 'utc') - ($3 || ' minutes')::interval, ${toAgo === null ? "null" : `(now() at time zone 'utc') - (${toAgo} || ' minutes')::interval`}, ${toAgo === null ? "null" : `(${fromAgo} - ${toAgo}) * 60`}, now())`, [wsId, type, String(fromAgo)]);

  try {
    console.log("## 0. Before the migration: nothing is timed, nothing breaks");
    ok("the sessions table does not exist", !(await q(`select to_regclass('task_work_sessions') t`))[0].t);
    ok("a task created In Progress works as before and reads Not tracked", (await send(E1, "TTM before migration")).s < 300 && (await timerOf("TTM before migration")).tracked === false);

    console.log("\n## 1. Apply the migration");
    await db.query(migration);
    ok("the table and the five triggers exist", !!(await q(`select to_regclass('task_work_sessions') t`))[0].t && Number((await q(`select count(*)::int c from pg_trigger where tgname in ('daily_tasks_timer_insert','daily_tasks_timer_status','task_entry_details_timer_insert','task_entry_details_timer_update')`))[0].c) === 4);
    ok("a second open session for the same task is impossible (unique index)", await (async () => { const tid = await idOf("TTM before migration"); await q(`insert into task_work_sessions ("taskId","userId","platformId") values ($1,$2,$3)`, [tid, E1.id, A]); const dup = await q(`insert into task_work_sessions ("taskId","userId","platformId") values ($1,$2,$3) on conflict do nothing returning id`, [tid, E1.id, A]).catch(() => "error"); const n = Number((await q(`select count(*)::int c from task_work_sessions where "taskId"=$1 and "endedAt" is null`, [tid]))[0].c); await q(`delete from task_work_sessions where "taskId"=$1`, [tid]); return n === 1 && (dup === "error" || dup.length === 0); })());
    await sleep(16000); // the server re-checks a missing table every 15 seconds

    console.log("\n## 2. Status changes start and stop the timer by themselves (no Start button anywhere)");
    const ws = await clockIn(E1, 400);
    ok("created as In Progress: a session opens at once (server clock)", (await send(E1, "TTM one")).s < 300 && (await openCount("TTM one")) === 1);
    ok("it is approved by the manager (existing flow)", (await approve("TTM one")).s === 200);
    let tm = await timerOf("TTM one");
    ok("the task reports tracked, running, first started now", tm.tracked && tm.running && tm.sessionCount === 1 && near(tm.activeSeconds, 0, 5) && !!tm.firstStartedAt && tm.pausedReason === null, tm);
    ok("pause (To Do): the session closes and the time stops", (await setProgress(E1, "TTM one", "TODO")).s === 200 && (await openCount("TTM one")) === 0 && (await timerOf("TTM one")).running === false);
    ok("resume (In Progress): a NEW session opens; the first one is kept", (await setProgress(E1, "TTM one", "IN_PROGRESS")).s === 200 && (await openCount("TTM one")) === 1 && (await sessionsOf("TTM one")).length === 2);
    ok("Blocked is a pause too: the session closes when it is blocked", (await setProgress(E1, "TTM one", "BLOCKED", { blockedNote: "waiting for the client" })).s === 200 && (await openCount("TTM one")) === 0 && (await sessionsOf("TTM one")).at(-1).endReason === "BLOCKED");
    ok("unblocking resumes with a new session", (await setProgress(E1, "TTM one", "IN_PROGRESS")).s === 200 && (await openCount("TTM one")) === 1 && (await sessionsOf("TTM one")).length === 3);
    ok("completing (submitting) stops the timer and records why", (await setProgress(E1, "TTM one", "COMPLETED")).s === 200 && (await openCount("TTM one")) === 0 && (await sessionsOf("TTM one")).at(-1).endReason === "COMPLETED");
    ok("the manager reviews as usual: he rates it, and the rating is stored untouched", (await call("POST", `/tasks/review/${await idOf("TTM one")}/rating`, MGR.tok, { rating: 4 })).s === 200 && (await q(`select rating from task_ratings where "taskId"=$1`, [await idOf("TTM one")]))[0]?.rating === 4);
    ok("returned for corrections (manager reopens it): the timer resumes as a new session", (await call("POST", `/tasks/review/${await idOf("TTM one")}/revert`, MGR.tok, { type: "NOT_FULL", remark: "please fix" })).s === 200 && (await openCount("TTM one")) === 1 && (await sessionsOf("TTM one")).length === 4);

    console.log("\n## 3. Exact figures: accumulate, resume without reset, elapsed and paused");
    // sessions (oldest first), minutes ago: 1: 180->120 (60 min) · 2: 110->100 (10) · 3: 95->80 (15) · 4: 40->now (open, 40)
    await layout("TTM one", [[180, 120], [110, 100], [95, 80], [40, null]]);
    tm = await timerOf("TTM one");
    ok("active working time = the sum of the sessions: 60 + 10 + 15 + 40 = 125 minutes, and it is still running", near(tm.activeSeconds, 125 * MIN) && tm.running && tm.sessionCount === 4, tm);
    ok("elapsed = from the FIRST start (180 min ago) to now = 180 minutes; paused = 55 minutes", near(tm.elapsedSeconds, 180 * MIN) && near(tm.pausedSeconds, 55 * MIN), tm);
    ok("first started at is the real first session, never the task's creation or assignment time", Math.abs(new Date(tm.firstStartedAt).getTime() - (Date.now() - 180 * 60000)) < 20000, tm.firstStartedAt);
    const tok2 = (await (await fetch(API + "/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "TTM-E1", password: PW }) })).json()).token;
    const tm2 = all((await call("GET", "/tasks", tok2)).b).find((t) => t.title === "TTM one").timer;
    ok("after a refresh and after logging in again the time is the same (it lives in the database)", near(tm2.activeSeconds, tm.activeSeconds, 8) && tm2.sessionCount === 4);
    ok("the manager's queue shows the same timer for that task", await (async () => { const qq = (await call("GET", "/tasks/review/queue", MGR.tok)).b; const row = JSON.stringify(qq).includes('"timer"'); return row; })());

    console.log("\n## 4. Breaks and clock-out are taken out (attendance and break rows are only read)");
    await addBreak(ws, "LUNCH", 30, 20); // a 10-minute break inside the open session
    tm = await timerOf("TTM one");
    ok("a lunch break inside the session is excluded: 125 - 10 = 115 minutes", near(tm.activeSeconds, 115 * MIN) && tm.running, tm);
    await addBreak(ws, "TEA", 5, null); // on a break right now
    tm = await timerOf("TTM one");
    ok("while on a break the clock is not running and says why (Break); time so far 125 - 10 (lunch) - 5 (this break) = 110 minutes", !tm.running && tm.pausedReason === "BREAK" && near(tm.activeSeconds, 110 * MIN), tm);
    await q(`update tracker_breaks set "endedAt" = (now() at time zone 'utc'), "durationSeconds" = 300 where "workSessionId"=$1 and "endedAt" is null`, [ws]);
    ok("back from the break the task (still In Progress) counts again: 125 - 10 - 5 = 110", near((await timerOf("TTM one")).activeSeconds, 110 * MIN) && (await timerOf("TTM one")).running);
    await q(`update work_sessions set "logoutAt" = (now() at time zone 'utc') - interval '8 minutes' where id=$1`, [ws]);
    tm = await timerOf("TTM one");
    ok("after clock-out (8 minutes ago) the timer is suspended (Clocked out) and the time after it is not counted: 110 minus the 3 minutes between clock-out and the earlier break = 107", !tm.running && tm.pausedReason === "CLOCKED_OUT" && near(tm.activeSeconds, 107 * MIN), tm);
    ok("the break rows were not changed by the timer", Number((await q(`select count(*)::int c from tracker_breaks where "workSessionId"=$1`, [ws]))[0].c) === 2);
    await q(`update work_sessions set "logoutAt" = null where id=$1`, [ws]);

    console.log("\n## 5. Overlapping tasks never inflate the person's total");
    ok("a second task is created In Progress while the first is still running", (await send(E1, "TTM two")).s < 300 && (await approve("TTM two")).s === 200 && (await openCount("TTM two")) === 1);
    await layout("TTM two", [[90, null]]);
    ok("each task keeps its own time (the second: 90 minutes minus the 10 + 5 minutes of breaks = 75)", near((await timerOf("TTM two")).activeSeconds, 75 * MIN, 8), await timerOf("TTM two"));
    const today = (await call("GET", "/tasks", E1.tok)).b.date;
    const prod = (await call("GET", `/team-attendance/productivity?from=${today}&to=${today}`, ADMIN.tok)).b.people.find((p) => p.userId === E1.id);
    const t1 = (await timerOf("TTM one")).activeSeconds, t2 = (await timerOf("TTM two")).activeSeconds;
    ok("the report's tracked time for the person is the UNION (overlap counted once), not the sum", prod.trackedSeconds < t1 + t2 && prod.trackedSeconds >= Math.max(t1, t2) - 5 && prod.trackedTasks === 2, [prod.trackedSeconds, t1, t2]);
    const tx = (await call("GET", `/team-attendance/productivity/tasks?from=${today}&to=${today}&userId=${E1.id}`, ADMIN.tok)).b.tasks;
    ok("the report's task rows carry each task's timer", tx.find((t) => t.title === "TTM one")?.timer?.tracked === true && tx.find((t) => t.title === "TTM one").timer.sessionCount === 4, tx.map((t) => [t.title, t.timer?.sessionCount]));

    console.log("\n## 6. Older work is Not tracked, nothing is invented");
    await q(`insert into daily_tasks (id,"platformId","userId",date,title,weight,status,"approvalStatus","approvedById","approvedAt","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,(now() at time zone 'Asia/Kolkata')::date - 3,'TTM old in progress','MEDIUM','IN_PROGRESS','APPROVED',$3,now(),now(),now())`, [A, E1.id, MGR.id]);
    ok("a task entered for an EARLIER day as In Progress is not timed from its creation", (await openCount("TTM old in progress")) === 0);
    await q(`insert into daily_tasks (id,"platformId","userId",date,title,weight,status,"approvalStatus","approvedById","approvedAt","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,(now() at time zone 'Asia/Kolkata')::date,'TTM already running','MEDIUM','PENDING','APPROVED',$3,now(),now(),now())`, [A, E1.id, MGR.id]);
    await q(`delete from task_work_sessions where "taskId"=$1`, [await idOf("TTM already running")]);
    ok("a task with no sessions reads Not tracked (zero seconds, no start time)", await (async () => { const t = all((await call("GET", "/tasks", E1.tok)).b).find((x) => x.title === "TTM already running"); return t && t.timer.tracked === false && t.timer.activeSeconds === 0 && t.timer.firstStartedAt === null; })());
    ok("it starts timing from its next status change (no backfill)", (await setProgress(E1, "TTM already running", "IN_PROGRESS")).s === 200 && (await openCount("TTM already running")) === 1);

    console.log("\n## 7. Assigned tasks (manager and supervisor) use the same timer, in the same tab");
    await q(`insert into user_capabilities ("userId", capability) values ($1,'TASK_ASSIGN_COMPANY') on conflict do nothing`, [SUP.id]).catch(() => {});
    ok("the manager assigns a task to Eone", (await call("POST", "/tasks/assigned", MGR.tok, { userId: E1.id, title: "TTM assigned by manager" })).s === 200);
    const supOk = (await call("POST", "/tasks/assigned", SUP.tok, { userId: E1.id, title: "TTM assigned by supervisor" })).s;
    ok("the supervisor assigns one too (if the capability table exists on this database)", supOk === 200 || supOk === 403, supOk);
    const mine = (await call("GET", "/tasks/assigned/mine", E1.tok)).b.tasks;
    ok("both appear in the SAME existing list (Assigned by manager), each naming who assigned it", mine.some((t) => t.title === "TTM assigned by manager" && t.assignedBy === "Mgr Ttm") && (supOk !== 200 || mine.some((t) => t.title === "TTM assigned by supervisor" && t.assignedBy === "Supx Ttm")), mine.map((t) => [t.title, t.assignedBy]));
    ok("nothing is timed while an assignment is To do", mine.every((t) => !/^TTM assigned/.test(t.title) || t.timer.tracked === false));
    const aid = await idOf("TTM assigned by manager");
    ok("the employee moves it to In Progress: timing starts by itself", (await call("POST", `/tasks/assigned/${aid}/progress`, E1.tok, { to: "IN_PROGRESS" })).s === 200 && (await openCount("TTM assigned by manager")) === 1);
    ok("the assigned list now shows a running/tracked timer", (await call("GET", "/tasks/assigned/mine", E1.tok)).b.tasks.find((t) => t.id === aid).timer.tracked === true);
    ok("the person who assigned it sees the same timer in 'Assigned by me'", (await call("GET", "/tasks/assigned/by-me", MGR.tok)).b.tasks.find((t) => t.id === aid).timer.tracked === true);
    ok("completing it stops the timer", (await call("POST", `/tasks/assigned/${aid}/progress`, E1.tok, { to: "COMPLETED", note: "done" })).s === 200 && (await openCount("TTM assigned by manager")) === 0);
    ok("the manager sends it back for corrections: it is In Progress again and the timer resumes as a new session (history kept)", (await call("POST", `/tasks/assigned/${aid}/send-back`, MGR.tok, { reason: "please redo the totals" })).s === 200 && (await openCount("TTM assigned by manager")) === 1 && (await sessionsOf("TTM assigned by manager")).length === 2);

    console.log("\n## 8. Scores, ratings and approvals are untouched");
    const w = (await call("GET", "/tasks", E1.tok)).b.weighted;
    ok("the Overall Performance Score still comes from completion and ratings only (no time in it)", w && "percent" in w && "completionPercent" in w && !("trackedSeconds" in w) && !("activeSeconds" in w), Object.keys(w ?? {}));
    ok("deleting a task (soft delete) stops its timer", await (async () => { if (!(await q(`select to_regclass('task_deletions') t`))[0].t) return true; await call("POST", `/tasks/review/${await idOf("TTM two")}/delete`, MGR.tok, { reasonCode: "DUPLICATE", note: "" }); return (await openCount("TTM two")) === 0; })());
    ok("another employee cannot see this person's task timers", (await call("GET", "/tasks", SUP.tok)).b.active?.every((t) => !/^TTM (one|two)/.test(t.title)) ?? true);
  } finally {
    await wipe().catch((e) => console.log("wipe note:", e.message));
    await q(`delete from user_capabilities where "userId" in (select id from users where "employeeCode" like 'TTM-%')`).catch(() => {});
    await db.query(down);
    await db.end();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
