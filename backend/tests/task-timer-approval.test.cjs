// Manager approval must never start, restart, stop or reset any task timer. Two tasks run at once; approvals, double approvals, refreshes, ratings, edits and a
// reopen are made through the REAL routes and the stored work sessions are compared before and after each step. THROWAWAY database only.
//   cd backend && TEST_DATABASE_URL=postgresql://postgres:localtest@localhost:54329/dq_test TEST_API=http://localhost:5012/api node tests/task-timer-approval.test.cjs
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
const ok = (n, c, x) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  -> " + String(JSON.stringify(x)).slice(0, 500))); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PW = "Tap@12345678";

(async () => {
  const db = new Client({ connectionString: DBURL }); await db.connect();
  const q = async (s, p) => (await db.query(s, p)).rows;
  const A = (await q(`select id from platforms where slug='avatar'`))[0].id;
  const hash = await bcrypt.hash(PW, 10);
  if (!(await q(`select to_regclass('task_work_sessions') t`))[0].t) { console.log("task_work_sessions is missing: apply migration 20261124120000_task_work_timer first"); process.exit(2); }
  const ids = `(select id from users where "employeeCode" like 'TAT-%')`;
  const wipe = async () => {
    await q(`delete from task_events where "taskId" in (select id from daily_tasks where "userId" in ${ids})`).catch(() => {});
    await q(`delete from task_ratings where "taskId" in (select id from daily_tasks where "userId" in ${ids})`).catch(() => {});
    await q(`delete from task_review_attempts where "taskId" in (select id from daily_tasks where "userId" in ${ids})`).catch(() => {});
    await q(`delete from task_time_reviews where "taskId" in (select id from daily_tasks where "userId" in ${ids})`).catch(() => {});
    await q(`delete from task_entry_details where "taskId" in (select id from daily_tasks where "userId" in ${ids})`).catch(() => {});
    await q(`delete from daily_tasks where "userId" in ${ids}`).catch(() => {});
    await q(`delete from work_sessions where "userId" in ${ids}`).catch(() => {});
    await q(`delete from team_members where "userId" in ${ids}`).catch(() => {});
    await q(`delete from teams where name like 'TAT-%'`).catch(() => {});
    await q(`delete from notifications where "userId" in ${ids}`).catch(() => {});
    await q(`update audit_logs set "actorId"=null where "actorId" in ${ids}`).catch(() => {});
    await q(`delete from audit_logs where "targetUserId" in ${ids}`).catch(() => {});
    await q(`delete from login_events where "employeeCode" like 'TAT-%'`).catch(() => {});
    await q(`delete from users where "employeeCode" like 'TAT-%'`).catch((e) => console.log("wipe:", e.message.slice(0, 80)));
  };
  await wipe();
  const mk = async (code, first, role, boss = null) => {
    await q(`insert into users (id,"platformId",email,"passwordHash","firstName","lastName","employeeCode",role,status,"mustChangePassword","trackerAccessEnabled","onboardingStatus","reportsToId","dateOfJoining","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,$4,'Tat',$5,$6,'ACTIVE',false,true,'ACTIVE',$7,'2026-01-01',now(),now())`, [A, code.toLowerCase() + "@tat.test", hash, first, code, role, boss]);
    const id = (await q(`select id from users where "employeeCode"=$1`, [code]))[0].id;
    const tok = (await (await fetch(API + "/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: code, password: PW }) })).json()).token;
    return { id, tok };
  };
  const ADMIN = await mk("TAT-ADM", "Adm", "ADMIN");
  const MGR = await mk("TAT-MGR", "Mgr", "MANAGER", ADMIN.id);
  const E = await mk("TAT-E1", "Eone", "EMPLOYEE", MGR.id);
  const teamId = (await q(`insert into teams (id,"platformId",name,"managerId","isActive","createdAt","updatedAt") values (gen_random_uuid(),$1,'TAT-Proj',$2,true,now(),now()) returning id`, [A, MGR.id]))[0].id;
  await q(`insert into team_members (id,"teamId","userId","isActive","isPrimary","joinedAt") values (gen_random_uuid(),$1,$2,true,true,now())`, [teamId, E.id]);
  // the employee is clocked in (otherwise a task timer reads "paused due to clock-out")
  await q(`insert into work_sessions (id,"platformId","userId",date,"loginAt",status,"productiveSeconds","breakSeconds","meetingSeconds","wasLateLogin","lateByMinutes","autoClosed","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,(now() at time zone 'Asia/Kolkata')::date,now() - interval '2 hours','ACTIVE',0,0,0,false,0,false,now(),now())`, [A, E.id]);

  const send = (title, progress = "IN_PROGRESS") => call("POST", "/tasks", E.tok, { title, teamId, taggedManagerId: MGR.id, progress, weight: "LOW", ...(progress === "BLOCKED" ? { blockedNote: "waiting for access" } : {}) });
  const idOf = async (title) => (await q(`select id from daily_tasks where title=$1`, [title]))[0]?.id;
  const sessions = async (...tasks) => (await q(`select "taskId", id, "startedAt"::text s, "endedAt"::text e, "endReason" r from task_work_sessions where "taskId" = any($1::uuid[]) order by "taskId", "startedAt", id`, [tasks])).map((x) => JSON.stringify(x)).join("|");
  const of = async (id) => (await q(`select "taskId", id, "startedAt"::text s, "endedAt"::text e from task_work_sessions where "taskId"=$1 order by "startedAt", id`, [id])).map((x) => JSON.stringify(x)).join("|");
  const timers = async () => { const t = (await call("GET", "/tasks", E.tok)).b; const all = t.tasks ?? []; return Object.fromEntries(all.map((x) => [x.title, x.timer])); };
  const approve = (id, body = { approve: true }) => call("POST", `/tasks/review/${id}/approve`, MGR.tok, body);

  console.log("## 1. start Task A and Task B, both run");
  await send("TAT A"); await send("TAT B"); await send("TAT C todo", "TODO");
  const a = await idOf("TAT A"), b = await idOf("TAT B"), c = await idOf("TAT C todo");
  ok("A and B each have exactly one OPEN session", Number((await q(`select count(*)::int n from task_work_sessions where "taskId" = any($1::uuid[]) and "endedAt" is null`, [[a, b]]))[0].n) === 2);
  ok("a To Do task has no session", Number((await q(`select count(*)::int n from task_work_sessions where "taskId"=$1`, [c]))[0].n) === 0);
  await sleep(2500);
  let t = await timers();
  ok("both timers report running", t["TAT A"]?.running === true && t["TAT B"]?.running === true, [t["TAT A"], t["TAT B"]]);
  const beforeA = await of(a), beforeB = await of(b);
  const actA = t["TAT A"].activeSeconds, actB = t["TAT B"].activeSeconds;

  console.log("\n## 2. Manager approves Task A (B keeps running, nothing restarts)");
  const r1 = await approve(a);
  ok("approval answers 200", r1.s === 200, r1);
  ok("A's stored sessions are byte-for-byte the same (same session, same start, still open)", (await of(a)) === beforeA, [beforeA, await of(a)]);
  ok("B's stored sessions are byte-for-byte the same", (await of(b)) === beforeB);
  ok("no extra session rows were created", Number((await q(`select count(*)::int n from task_work_sessions where "taskId" = any($1::uuid[])`, [[a, b]]))[0].n) === 2);
  t = await timers();
  ok("A still running with its time carried on (not reset)", t["TAT A"].running === true && t["TAT A"].activeSeconds >= actA, [actA, t["TAT A"]]);
  ok("B still running with its time carried on", t["TAT B"].running === true && t["TAT B"].activeSeconds >= actB, [actB, t["TAT B"]]);
  ok("approval changed only the approval fields", (await q(`select "approvalStatus" a, status::text s from daily_tasks where id=$1`, [a]))[0].a === "APPROVED" && (await q(`select status::text s from daily_tasks where id=$1`, [a]))[0].s === "IN_PROGRESS");

  console.log("\n## 3. double click, simultaneous approvals and repeated reads");
  const dbl = await Promise.all([approve(b), approve(b), approve(b)]);
  ok("three simultaneous approvals: one wins, the others are refused", dbl.filter((x) => x.s === 200).length === 1 && dbl.filter((x) => x.s !== 200).length === 2, dbl.map((x) => x.s));
  ok("still exactly one open session for B, same start", (await of(b)) === beforeB && Number((await q(`select count(*)::int n from task_work_sessions where "taskId"=$1 and "endedAt" is null`, [b]))[0].n) === 1);
  ok("a repeated approval of A is refused and changes nothing", (await approve(a)).s === 409 && (await of(a)) === beforeA);
  const reads = await Promise.all([1, 2, 3, 4, 5].map(() => call("GET", "/tasks", E.tok)));
  ok("refreshing (five parallel reads) writes nothing", reads.every((x) => x.s === 200) && (await of(a)) === beforeA && (await of(b)) === beforeB);
  ok("the manager's queue read writes nothing either", (await call("GET", "/tasks/review/queue", MGR.tok)).s === 200 && (await of(a)) === beforeA);

  console.log("\n## 4. Task A is completed first, THEN approved; B keeps running");
  await send("TAT D"); await send("TAT E");
  const d = await idOf("TAT D"), e = await idOf("TAT E");
  await sleep(1500);
  await call("PATCH", `/tasks/${d}`, E.tok, { progress: "COMPLETED" });
  const dDone = await of(d), eBefore = await of(e);
  ok("D's session was closed by completing it", /"e":"/.test(dDone) && !/"e":null/.test(dDone), dDone);
  const rd = await approve(d);
  ok("approving a completed task does not restart it", rd.s === 200 && (await of(d)) === dDone && Number((await q(`select count(*)::int n from task_work_sessions where "taskId"=$1 and "endedAt" is null`, [d]))[0].n) === 0, [dDone, await of(d)]);
  ok("and does not touch E, which is still running", (await of(e)) === eBefore);
  ok("D stays Completed", (await q(`select status::text s from daily_tasks where id=$1`, [d]))[0].s === "COMPLETED");

  console.log("\n## 5. a To Do task is approved: it does not start");
  const rc = await approve(c);
  ok("approving a To Do task creates no session", rc.s === 200 && Number((await q(`select count(*)::int n from task_work_sessions where "taskId"=$1`, [c]))[0].n) === 0);
  ok("and it is still To Do", (await q(`select status::text s from daily_tasks where id=$1`, [c]))[0].s === "PENDING");

  console.log("\n## 6. approving several tasks in a row");
  await send("TAT F"); await send("TAT G"); await send("TAT H");
  const f = await idOf("TAT F"), g = await idOf("TAT G"), h = await idOf("TAT H");
  await sleep(1200);
  const snap = await sessions(f, g, h);
  await approve(f); await approve(g); await approve(h);
  ok("three approvals in a row leave every session untouched", (await sessions(f, g, h)) === snap, [snap, await sessions(f, g, h)]);

  console.log("\n## 7. rating and editing the details do not touch the timer");
  const eSnap = await of(e);
  await approve(e);
  const rt = await call("POST", `/tasks/review/${d}/rating`, MGR.tok, { rating: 4, comment: "ok", expectedMinutes: 30 });
  ok("rating a completed task answers 200", rt.s === 200, rt);
  ok("rating does not reopen or restart it", (await of(d)) === dDone);
  ok("approving E and rating D leave E's session unchanged", (await of(e)) === eSnap);
  const ed = await call("POST", `/tasks/${f}/correction`, E.tok, { reason: "typo fix", title: "TAT F fixed" });
  ok("a correction REQUEST (nothing applied yet) changes no session", (await sessions(f, g, h)) === snap, ed.s);

  console.log("\n## 8. reopen a completed task (the one place a manager restarts time, on purpose) leaves other tasks alone");
  const gSnap = await of(g), hSnap = await of(h);
  const rv = await call("POST", `/tasks/review/${d}/revert`, MGR.tok, { type: "PARTIAL", remark: "needs more work", reason: "QUALITY" });
  ok("reopen answers 200", rv.s === 200, rv);
  ok("only D gets a NEW session; its earlier session is kept untouched", Number((await q(`select count(*)::int n from task_work_sessions where "taskId"=$1`, [d]))[0].n) === 2 && (await of(d)).startsWith(dDone.split("|")[0]), await of(d));
  ok("G, H and E were not touched by it", (await of(g)) === gSnap && (await of(h)) === hSnap && (await of(e)) === eSnap);

  console.log("\n## 8b. approving with a comment, approving a Blocked task, and approving a correction request");
  await send("TAT I blocked", "BLOCKED");
  await send("TAT J");
  const bl = await idOf("TAT I blocked"), j = await idOf("TAT J");
  await sleep(1200);
  const jSnap = await of(j), blSnap = await of(bl);
  ok("a Blocked task has no open session", Number((await q(`select count(*)::int n from task_work_sessions where "taskId"=$1 and "endedAt" is null`, [bl]))[0].n) === 0);
  const ac = await approve(bl, { approve: true, comment: "go ahead" });
  ok("approving a Blocked task WITH a comment answers 200", ac.s === 200, ac);
  ok("it does not start the Blocked task and does not touch J", (await of(bl)) === blSnap && (await of(j)) === jSnap, [blSnap, await of(bl)]);
  ok("the comment was saved", (await q(`select "approvalNote" n from task_entry_details where "taskId"=$1`, [bl]))[0]?.n === "go ahead");
  await approve(j, { approve: true, comment: "fine" });
  ok("approving J with a comment leaves J's session identical", (await of(j)) === jSnap);
  const cq = await call("POST", `/tasks/${j}/correction`, E.tok, { reason: "wrong wording", title: "TAT J corrected", hoursSpent: 2 });
  ok("employee asks for a correction on the approved running task", cq.s === 200 || cq.s === 201, cq);
  const reqId = (await call("GET", "/tasks/corrections/pending", MGR.tok)).b.corrections?.find((x) => x.taskId === j)?.requestId;
  const dc = await call("POST", `/tasks/review/${j}/correction`, MGR.tok, { requestId: reqId, approve: true });
  ok("manager approves the correction", dc.s === 200, dc);
  ok("applying the correction does not restart, stop or split J's timer", (await of(j)) === jSnap && (await q(`select title from daily_tasks where id=$1`, [j]))[0].title === "TAT J corrected", [jSnap, await of(j)]);
  ok("and B, E, G, H are still the same", (await of(b)) === beforeB && (await of(e)) === eSnap && (await of(g)) === gSnap && (await of(h)) === hSnap);

  console.log("\n## 9. the live signal and reconnect: a reload after every step shows the same running tasks");
  t = await timers();
  ok("A, B, E, F, G, H are all still running after everything", ["TAT A", "TAT B", "TAT E", "TAT F fixed", "TAT G", "TAT H"].every((k) => k === "TAT F fixed" ? (t["TAT F"]?.running === true) : t[k]?.running === true), Object.fromEntries(Object.entries(t).map(([k, v]) => [k, v?.running])));
  ok("each task still has exactly ONE open session at most", (await q(`select "taskId" from task_work_sessions where "endedAt" is null group by "taskId" having count(*) > 1`)).length === 0);

  await wipe(); await db.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
