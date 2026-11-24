// Overall Performance Score (60% completion + 40% manager rating) through the real API: real sign-ins, real HTTP, THROWAWAY database only.
//   cd backend && TEST_DATABASE_URL=... TEST_API=http://localhost:5012/api node tests/weighted-performance.test.cjs
require("dotenv").config({ path: require("node:path").join(__dirname, "..", ".env") });
const { Client } = require("pg");
const bcrypt = require("bcryptjs");
const API = process.env.TEST_API ?? "http://localhost:5012/api";
require("./_guard.cjs").assertTestDb(process.env.TEST_DATABASE_URL);

const call = async (m, p, t, body) => {
  const r = await fetch(API + p, { method: m, headers: { ...(t ? { authorization: "Bearer " + t } : {}), ...(body && m !== "GET" ? { "content-type": "application/json" } : {}) }, body: body && m !== "GET" ? JSON.stringify(body) : undefined });
  const txt = await r.text(); let j; try { j = JSON.parse(txt); } catch { j = txt; }
  return { s: r.status, b: j };
};
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  -> " + String(JSON.stringify(x)).slice(0, 500))); };
const PW = "Wgt@12345678";

(async () => {
  const db = new Client({ connectionString: process.env.TEST_DATABASE_URL }); await db.connect();
  const q = async (s, p) => (await db.query(s, p)).rows;
  const AV = (await q(`select id from platforms where slug='avatar'`))[0].id;
  const hash = await bcrypt.hash(PW, 10);
  const wipe = async () => {
    const ids = `(select id from users where "employeeCode" like 'WGP-%')`;
    await q(`delete from task_deletions where "taskId" in (select id from daily_tasks where "userId" in ${ids})`).catch(() => {});
    await q(`delete from task_events where "taskId" in (select id from daily_tasks where "userId" in ${ids})`).catch(() => {});
    await q(`delete from task_entry_details where "taskId" in (select id from daily_tasks where "userId" in ${ids})`);
    await q(`delete from task_ratings where "taskId" in (select id from daily_tasks where "userId" in ${ids})`).catch(() => {});
    await q(`delete from daily_tasks where "userId" in ${ids}`);
    await q(`delete from work_sessions where "userId" in ${ids}`);
    await q(`delete from team_members where "userId" in ${ids}`);
    await q(`delete from teams where name like 'WGP-%'`);
    await q(`delete from notifications where "userId" in ${ids}`);
    await q(`delete from audit_logs where "userId" in ${ids}`).catch(() => {});
    await q(`delete from users where "employeeCode" like 'WGP-%'`);
  };
  await wipe().catch((e) => console.log("wipe note:", e.message));
  const mk = async (code, role, o = {}) => {
    await q(`insert into users (id,"platformId",email,"passwordHash","firstName","lastName","employeeCode",role,status,"mustChangePassword","trackerAccessEnabled","onboardingStatus","reportsToId","dateOfJoining","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,$4,'Wgt',$5,$6,'ACTIVE',false,true,'ACTIVE',$7,'2026-01-01',now(),now())`, [AV, code.toLowerCase() + "@wgp.test", hash, o.first ?? code.replace("WGP-", ""), code, role, o.boss ?? null]);
    const id = (await q(`select id from users where "employeeCode"=$1`, [code]))[0].id;
    const tok = (await (await fetch(API + "/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: code, password: PW }) })).json()).token;
    return { id, tok };
  };
  const ADMIN = await mk("WGP-ADMIN", "ADMIN", { first: "AdminW" });
  const HR = await mk("WGP-HR", "HR", { first: "HrW", boss: ADMIN.id });
  const MGR = await mk("WGP-MGR", "MANAGER", { first: "MgrW", boss: ADMIN.id });
  const MGR2 = await mk("WGP-MGR2", "MANAGER", { first: "MgrOther", boss: ADMIN.id });
  const E = await mk("WGP-E", "EMPLOYEE", { first: "EmpW", boss: MGR.id });
  const E2 = await mk("WGP-E2", "EMPLOYEE", { first: "EmpNone", boss: MGR.id }); // no tasks at all
  const teamId = (await q(`insert into teams (id,"platformId",name,"managerId","isActive","createdAt","updatedAt") values (gen_random_uuid(),$1,'WGP-Proj',$2,true,now(),now()) returning id`, [AV, MGR.id]))[0].id;
  for (const u of [E, E2]) await q(`insert into team_members (id,"teamId","userId","isActive","isPrimary","joinedAt") values (gen_random_uuid(),$1,$2,true,true,now())`, [teamId, u.id]);

  const idOf = async (title) => (await q(`select id from daily_tasks where title=$1`, [title]))[0]?.id;
  const send = (title, weight, progress = "IN_PROGRESS") => call("POST", "/tasks", E.tok, { title, teamId, taggedManagerId: MGR.id, weight, progress, hoursSpent: 1 });
  const approve = async (title) => call("POST", `/tasks/review/${await idOf(title)}/approve`, MGR.tok, { approve: true });
  const complete = async (title) => call("PATCH", `/tasks/${await idOf(title)}`, E.tok, { progress: "COMPLETED" });
  const partial = async (who, title, v) => call("POST", `/tasks/review/${await idOf(title)}/partial`, who.tok, { partial: v });
  const today = (await call("GET", "/tasks", E.tok)).b.date;
  const range = `from=${today}&to=${today}`;
  try {
    const rate = async (title, rating, who = MGR) => call("POST", `/tasks/review/${await idOf(title)}/rating`, who.tok, { rating });
    const sendAs = (who, title, weight, progress = "IN_PROGRESS") => call("POST", "/tasks", who.tok, { title, teamId, taggedManagerId: MGR.id, weight, progress, hoursSpent: 1 });
    const approveAs = async (title) => call("POST", `/tasks/review/${await idOf(title)}/approve`, MGR.tok, { approve: true });
    const completeAs = async (who, title) => call("PATCH", `/tasks/${await idOf(title)}`, who.tok, { progress: "COMPLETED" });
    const perf = async (who = E) => (await call("GET", "/tasks", who.tok)).b.weighted;

    console.log("## 1. Nothing yet: N/A");
    let w = await perf();
    ok("no tasks -> N/A, never 0% or 100%", w.percent === null && w.status === "NO_TASKS" && w.tasks === 0, w);

    console.log("\n## 2. Four tasks with four different priorities; 3 completed, 1 open");
    for (const [t, p] of [["WGP A critical", "CRITICAL"], ["WGP B low", "LOW"], ["WGP C high", "HIGH"], ["WGP D medium open", "MEDIUM"]]) ok("send " + t, (await sendAs(E, t, p)).s < 300);
    ok("a fifth task is sent but NOT approved (stays waiting)", (await sendAs(E, "WGP E waiting", "HIGH")).s < 300);
    for (const t of ["WGP A critical", "WGP B low", "WGP C high", "WGP D medium open"]) ok("approve " + t, (await approveAs(t)).s === 200);
    for (const t of ["WGP A critical", "WGP B low", "WGP C high"]) ok("complete " + t, (await completeAs(E, t)).s === 200);
    w = await perf();
    ok("waiting-for-approval task is not eligible and not completed: 4 eligible, 3 completed, 1 waiting", w.tasks === 4 && w.completed === 3 && w.notCompleted === 1 && w.notScored.waitingForApproval === 1, w);
    ok("completed but nobody has rated them: Awaiting evaluation, no overall score, completion 75%", w.status === "AWAITING_EVALUATION" && w.percent === null && w.completionPercent === 75 && w.awaitingRating === 3 && w.ratingPercent === null, w);

    console.log("\n## 3. Ratings arrive: Provisional, then Final");
    ok("the manager rates A 5 stars", (await rate("WGP A critical", 5)).s === 200);
    w = await perf();
    ok("one of three rated: Provisional, uses the finalized rating only: 75 x 0.6 + 100 x 0.4 = 85%, 2 evaluations outstanding", w.status === "PROVISIONAL" && w.provisional && w.percent === 85 && w.awaitingRating === 2 && w.ratedTasks === 1, w);
    ok("B rated 5 and C rated 3", (await rate("WGP B low", 5)).s === 200 && (await rate("WGP C high", 3)).s === 200);
    w = await perf();
    ok("all rated: Final. completion 75% (45) + rating (5+5+3)/15 = 86.67% (34.67) = 79.67%", w.status === "FINAL" && w.percent === 79.67 && w.completionContribution === 45 && w.ratingContribution === 34.67 && w.averageRating === 4.33 && w.ratingPercent === 86.67, w);

    console.log("\n## 4. Priority makes no difference: a second employee with all-LOW tasks, same completion and ratings");
    const E2tasks = ["WGP2 a", "WGP2 b", "WGP2 c", "WGP2 d"];
    for (const t of E2tasks) ok("send " + t, (await sendAs(E2, t, "LOW")).s < 300);
    for (const t of E2tasks) ok("approve " + t, (await approveAs(t)).s === 200);
    for (const t of E2tasks.slice(0, 3)) ok("complete " + t, (await completeAs(E2, t)).s === 200);
    ok("same ratings 5, 5, 3", (await rate("WGP2 a", 5)).s === 200 && (await rate("WGP2 b", 5)).s === 200 && (await rate("WGP2 c", 3)).s === 200);
    const w2 = await perf(E2);
    ok("identical score 79.67% whatever the priorities (Critical/Low/High/Medium vs all Low)", w2.percent === 79.67 && w2.percent === w.percent && w2.status === "FINAL", [w2.percent, w.percent]);

    console.log("\n## 5. A rejected task is never completed");
    ok("send and reject one", (await sendAs(E, "WGP F rejected", "HIGH")).s < 300 && (await call("POST", `/tasks/review/${await idOf("WGP F rejected")}/approve`, MGR.tok, { approve: false, rejectionNote: "not needed" })).s === 200);
    w = await perf();
    ok("it is counted as rejected, not eligible: still 4 eligible, 3 completed, score unchanged", w.tasks === 4 && w.completed === 3 && w.notScored.rejected >= 1 && w.percent === 79.67, w);

    console.log("\n## 6. Every screen shows the same figure (backend -> reports API -> screen)");
    const same = (x, label) => ok(label, x && x.percent === 79.67 && x.status === "FINAL" && x.tasks === 4 && x.completed === 3 && x.ratedTasks === 3, x);
    same((await call("GET", `/tasks/range?${range}`, E.tok)).b.weighted, "Daily Tasks date view");
    same((await call("GET", `/tasks/day?date=${today}`, E.tok)).b.weighted, "My History day tasks");
    same((await call("GET", `/tracker/history?from=${today}&to=${today}`, E.tok)).b.summary?.weighted, "My History summary");
    same((await call("GET", "/tasks/review/queue", MGR.tok)).b.weightedByUser?.[E.id], "manager's queue (per employee)");
    same((await call("GET", "/tasks/review/queue", ADMIN.tok)).b.weightedByUser?.[E.id], "Admin's queue");
    same((await call("GET", "/tasks/review/queue", HR.tok)).b.weightedByUser?.[E.id], "HR's queue");
    const rep = (await call("GET", `/reports?${range}&groupBy=person&userId=${E.id}`, ADMIN.tok)).b;
    same((rep.people ?? []).find((p) => p.userId === E.id)?.weighted, "Reports & Analytics person row");
    const prod = (await call("GET", `/team-attendance/productivity?${range}`, ADMIN.tok)).b;
    same((prod.people ?? []).find((p) => p.userId === E.id)?.weighted, "Task productivity report");
    ok("Task productivity: the other employee with all-Low tasks has the same figure", (prod.people ?? []).find((p) => p.userId === E2.id)?.weighted?.percent === 79.67);
    const tr = (await call("GET", `/team-attendance/team-report?${range}`, ADMIN.tok)).b;
    same(tr.performance?.[E.id], "the team report workbook data (performance per person)");
    const tx = (await call("GET", `/team-attendance/productivity/tasks?${range}&userId=${E.id}`, ADMIN.tok)).b;
    const row = (n) => (tx.tasks ?? []).find((t) => t.title === n);
    ok("task rows say how each task takes part: A completed + rated 5, C rated 3, D eligible not completed, the waiting one not in the score", row("WGP A critical")?.scoreCompleted === true && row("WGP A critical")?.rating === 5 && row("WGP A critical")?.ratingStatus === "RATED" && row("WGP C high")?.rating === 3 && row("WGP D medium open")?.inScore === true && row("WGP D medium open")?.scoreCompleted === false && row("WGP D medium open")?.ratingStatus === "NOT_APPLICABLE" && row("WGP E waiting")?.inScore === false, (tx.tasks ?? []).map((t) => [t.title, t.inScore, t.scoreCompleted, t.ratingStatus]));

    console.log("\n## 7. The reporting-period cutoff: a task finished after the period is unfinished in that report");
    await q(`update daily_tasks set "completedAt" = now() + interval '2 days' where title='WGP B low'`);
    const histProd = (await call("GET", `/team-attendance/productivity?${range}`, ADMIN.tok)).b.people.find((p) => p.userId === E.id).weighted;
    ok("the report (as of the end of the period) counts 2 completed, 1 finished after the period", histProd.completed === 2 && histProd.completedAfterCutoff === 1 && histProd.completionPercent === 50, histProd);
    ok("the live Daily Tasks view (no cutoff) still counts it", (await perf()).completed === 3);
    await q(`update daily_tasks set "completedAt" = now() where title='WGP B low'`);

    console.log("\n## 8. Permissions are unchanged");
    ok("an employee cannot open the team report or the productivity report", (await call("GET", `/team-attendance/productivity?${range}`, E.tok)).s === 403 && (await call("GET", `/team-attendance/productivity/tasks?${range}`, E.tok)).s === 403);
    const other = (await call("GET", `/team-attendance/productivity?${range}`, MGR2.tok)).b;
    ok("a manager who does not manage this employee sees nothing of them", !(other.people ?? []).some((p) => p.userId === E.id));
    ok("an employee's own screens never show another person's score", (await call("GET", "/tasks", E2.tok)).b.weighted.percent === 79.67);
  } finally {
    await wipe().catch(() => {});
    await db.end();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
