// Priority-weighted performance through the real API: real sign-ins, real HTTP, THROWAWAY database only.
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
    const ids = `(select id from users where "employeeCode" like 'WGT-%')`;
    await q(`delete from task_deletions where "taskId" in (select id from daily_tasks where "userId" in ${ids})`).catch(() => {});
    await q(`delete from task_events where "taskId" in (select id from daily_tasks where "userId" in ${ids})`).catch(() => {});
    await q(`delete from task_entry_details where "taskId" in (select id from daily_tasks where "userId" in ${ids})`);
    await q(`delete from task_ratings where "taskId" in (select id from daily_tasks where "userId" in ${ids})`).catch(() => {});
    await q(`delete from daily_tasks where "userId" in ${ids}`);
    await q(`delete from work_sessions where "userId" in ${ids}`);
    await q(`delete from team_members where "userId" in ${ids}`);
    await q(`delete from teams where name like 'WGT-%'`);
    await q(`delete from notifications where "userId" in ${ids}`);
    await q(`delete from audit_logs where "userId" in ${ids}`).catch(() => {});
    await q(`delete from users where "employeeCode" like 'WGT-%'`);
  };
  await wipe().catch((e) => console.log("wipe note:", e.message));
  const mk = async (code, role, o = {}) => {
    await q(`insert into users (id,"platformId",email,"passwordHash","firstName","lastName","employeeCode",role,status,"mustChangePassword","trackerAccessEnabled","onboardingStatus","reportsToId","dateOfJoining","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,$4,'Wgt',$5,$6,'ACTIVE',false,true,'ACTIVE',$7,'2026-01-01',now(),now())`, [AV, code.toLowerCase() + "@wgt.test", hash, o.first ?? code.replace("WGT-", ""), code, role, o.boss ?? null]);
    const id = (await q(`select id from users where "employeeCode"=$1`, [code]))[0].id;
    const tok = (await (await fetch(API + "/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: code, password: PW }) })).json()).token;
    return { id, tok };
  };
  const ADMIN = await mk("WGT-ADMIN", "ADMIN", { first: "AdminW" });
  const HR = await mk("WGT-HR", "HR", { first: "HrW", boss: ADMIN.id });
  const MGR = await mk("WGT-MGR", "MANAGER", { first: "MgrW", boss: ADMIN.id });
  const MGR2 = await mk("WGT-MGR2", "MANAGER", { first: "MgrOther", boss: ADMIN.id });
  const E = await mk("WGT-E", "EMPLOYEE", { first: "EmpW", boss: MGR.id });
  const E2 = await mk("WGT-E2", "EMPLOYEE", { first: "EmpNone", boss: MGR.id }); // no tasks at all
  const teamId = (await q(`insert into teams (id,"platformId",name,"managerId","isActive","createdAt","updatedAt") values (gen_random_uuid(),$1,'WGT-Proj',$2,true,now(),now()) returning id`, [AV, MGR.id]))[0].id;
  for (const u of [E, E2]) await q(`insert into team_members (id,"teamId","userId","isActive","isPrimary","joinedAt") values (gen_random_uuid(),$1,$2,true,true,now())`, [teamId, u.id]);

  const idOf = async (title) => (await q(`select id from daily_tasks where title=$1`, [title]))[0]?.id;
  const send = (title, weight, progress = "IN_PROGRESS") => call("POST", "/tasks", E.tok, { title, teamId, taggedManagerId: MGR.id, weight, progress, hoursSpent: 1 });
  const approve = async (title) => call("POST", `/tasks/review/${await idOf(title)}/approve`, MGR.tok, { approve: true });
  const complete = async (title) => call("PATCH", `/tasks/${await idOf(title)}`, E.tok, { progress: "COMPLETED" });
  const partial = async (who, title, v) => call("POST", `/tasks/review/${await idOf(title)}/partial`, who.tok, { partial: v });
  const today = (await call("GET", "/tasks", E.tok)).b.date;
  const range = `from=${today}&to=${today}`;

  try {
    console.log("## 0. Before any task: N/A, never 0% or 100%");
    const w0 = (await call("GET", "/tasks", E.tok)).b.weighted;
    ok("an employee with no tasks has no percentage (null = N/A) and 0 possible points", w0 && w0.percent === null && w0.possible === 0 && w0.tasks === 0, w0);

    console.log("\n## 1. The owner's example: Critical done, Low done, High partly done, Medium not started");
    const mkTask = async (t, w, p) => { const r = await send(t, w, p); ok(`submit ${t}`, r.s === 200 || r.s === 201, r); await approve(t); };
    await mkTask("WGT A critical done", "CRITICAL", "IN_PROGRESS");
    await mkTask("WGT B low done", "LOW", "IN_PROGRESS");
    await mkTask("WGT C high partial", "HIGH", "IN_PROGRESS");
    await mkTask("WGT D medium todo", "MEDIUM", "TODO");
    ok("A and B finish", (await complete("WGT A critical done")).s === 200 && (await complete("WGT B low done")).s === 200);

    let w = (await call("GET", "/tasks", E.tok)).b.weighted;
    ok("before the manager marks C: earned 6 of 15 (A 5 + B 1) = 40%", w.earned === 6 && w.possible === 15 && w.percent === 40, w);

    console.log("\n## 2. Manager marks C partially completed");
    const pm = await partial(MGR, "WGT C high partial", true);
    ok("the tagged manager can mark an In Progress task partial (200)", pm.s === 200, pm);
    w = (await call("GET", "/tasks", E.tok)).b.weighted;
    ok("now earned 8.5 of 15 = 56.67%", w.earned === 8.5 && w.possible === 15 && w.percent === 56.67, w);
    ok("2 completed, 1 partial, 1 not completed", w.completed === 2 && w.partial === 1 && w.notCompleted === 1, w);
    const by = Object.fromEntries(w.byPriority.map((l) => [l.priority, l]));
    ok("priority breakdown: Critical 5/5, High 2.5/5, Medium 0/4, Low 1/1", by.CRITICAL.earned === 5 && by.HIGH.earned === 2.5 && by.HIGH.possible === 5 && by.MEDIUM.earned === 0 && by.MEDIUM.possible === 4 && by.LOW.earned === 1, by);
    const mine = (await call("GET", "/tasks", E.tok)).b;
    ok("the employee's own task rows say which task is partial", mine.tasks.find((t) => t.title === "WGT C high partial")?.partial === true && mine.tasks.find((t) => t.title === "WGT A critical done")?.partial === false);
    ok("the old star score is still there beside it", mine.score && typeof mine.score.percent === "number", mine.score);
    ok("the employee was told (notification)", (await q(`select count(*)::int n from notifications where "userId"=$1 and title='Marked partially completed'`, [E.id]))[0].n === 1);
    ok("the change is in the audit log", (await q(`select count(*)::int n from audit_logs where summary like 'Marked task "WGT C high partial"%'`))[0].n >= 1);

    console.log("\n## 3. Who may mark partial, and when");
    ok("To Do cannot be marked partial (400)", (await partial(MGR, "WGT D medium todo", true)).s === 400);
    ok("the employee cannot mark their own task (403)", (await partial(E, "WGT C high partial", false)).s === 403);
    ok("another manager cannot (403/404)", [403, 404].includes((await partial(MGR2, "WGT D medium todo", true)).s) && [403, 404].includes((await partial(MGR2, "WGT C high partial", false)).s));
    ok("HR who is not the reviewer cannot mark a task of someone else's team through the route unless allowed by company rules (no 500)", (await partial(HR, "WGT B low done", true)).s < 500);
    // restore B in case HR was allowed
    await q(`update daily_tasks set outcome=null where title='WGT B low done'`);
    ok("a non-boolean is refused (400)", (await call("POST", `/tasks/review/${await idOf("WGT C high partial")}/partial`, MGR.tok, { partial: "yes" })).s === 400);
    const auditCount = async () => (await q(`select count(*)::int n from audit_logs where summary like 'Marked task "WGT C high partial"%'`))[0].n;
    const auditBefore = await auditCount();
    const again = await partial(MGR, "WGT C high partial", true);
    ok("pressing it again changes nothing and does not fail", again.s === 200 && (await auditCount()) === auditBefore);
    ok("the employee sees no extra notification for the repeat", (await q(`select count(*)::int n from notifications where "userId"=$1 and title='Marked partially completed' and body like '%WGT C high partial%'`, [E.id]))[0].n === 1);

    console.log("\n## 4. What does NOT count");
    await send("WGT pending", "CRITICAL", "IN_PROGRESS"); // waiting for approval
    await send("WGT rejected", "CRITICAL", "IN_PROGRESS");
    await call("POST", `/tasks/review/${await idOf("WGT rejected")}/approve`, MGR.tok, { approve: false, rejectionNote: "no" });
    await mkTask("WGT deleted", "CRITICAL", "IN_PROGRESS");
    const del = await call("POST", `/tasks/review/${await idOf("WGT deleted")}/delete`, MGR.tok, { reasonCode: "DUPLICATE", note: "dup" });
    ok("manager deletes a task (soft)", del.s === 200 || del.s === 404 || del.s === 503, del);
    await mkTask("WGT assigned", "CRITICAL", "IN_PROGRESS");
    await q(`update daily_tasks set "assignedById"=$1 where title='WGT assigned'`, [MGR.id]);
    w = (await call("GET", "/tasks", E.tok)).b.weighted;
    ok("pending, rejected, deleted and manager-assigned tasks add no points and no possible points: still 8.5 of 15", w.earned === 8.5 && w.possible === 15 && w.tasks === 4, w);
    ok("waiting and rejected tasks are counted on their own", w.notScored.waitingForApproval >= 1 && w.notScored.rejected >= 1, w.notScored);

    console.log("\n## 5. Undo the partial mark");
    ok("manager clears it", (await partial(MGR, "WGT C high partial", false)).s === 200);
    w = (await call("GET", "/tasks", E.tok)).b.weighted;
    ok("back to 6 of 15 = 40%", w.earned === 6 && w.percent === 40, w);
    await partial(MGR, "WGT C high partial", true);
    w = (await call("GET", "/tasks", E.tok)).b.weighted;
    ok("and 56.67% again after marking again", w.percent === 56.67);

    console.log("\n## 6. The same figure on every screen");
    const rng = (await call("GET", `/tasks/range?${range}`, E.tok)).b;
    ok("Daily Tasks date view (/tasks/range)", rng.weighted?.percent === 56.67, rng.weighted);
    const day = (await call("GET", `/tasks/day?date=${today}`, E.tok)).b;
    ok("My History day tasks (/tasks/day)", day.weighted?.percent === 56.67, day.weighted);
    const queue = (await call("GET", "/tasks/review/queue", MGR.tok)).b;
    ok("manager queue: overall weighted figure", queue.weighted?.percent === 56.67 && queue.weighted.possible === 15, queue.weighted);
    ok("manager queue: per employee, and the employee with no tasks is absent or N/A", queue.weightedByUser?.[E.id]?.percent === 56.67 && (!queue.weightedByUser?.[E2.id] || queue.weightedByUser[E2.id].percent === null), queue.weightedByUser);
    const aq = (await call("GET", "/tasks/review/queue", ADMIN.tok)).b;
    ok("Admin sees the same figure for the same employee", aq.weightedByUser?.[E.id]?.percent === 56.67, aq.weightedByUser?.[E.id]);
    const hq = (await call("GET", "/tasks/review/queue", HR.tok)).b;
    ok("HR sees the same figure for the same employee", hq.weightedByUser?.[E.id]?.percent === 56.67, hq.weightedByUser?.[E.id]);
    const rep = (await call("GET", `/reports?${range}&groupBy=person&userId=${E.id}`, ADMIN.tok)).b;
    const rp = (rep.people ?? []).find((p) => p.userId === E.id);
    ok("Reports & Analytics person row", rp?.weighted?.percent === 56.67 && rp.weighted.earned === 8.5, rp?.weighted);
    ok("Reports totals", rep.totals?.weighted?.percent === 56.67, rep.totals?.weighted);
    const rep2 = (await call("GET", `/reports?${range}&groupBy=person&userId=${E2.id}`, ADMIN.tok)).b;
    const rp2 = (rep2.people ?? []).find((p) => p.userId === E2.id);
    ok("an employee with no tasks reads N/A in Reports", rp2 && rp2.weighted.percent === null, rp2?.weighted);
    const prod = (await call("GET", `/team-attendance/productivity?${range}`, ADMIN.tok)).b;
    const pp = (prod.people ?? []).find((p) => p.userId === E.id);
    ok("Task productivity person row", pp?.weighted?.percent === 56.67, pp?.weighted);
    ok("Task productivity total", typeof prod.weightedTotal?.percent === "number", prod.weightedTotal);
    const tx = (await call("GET", `/team-attendance/productivity/tasks?${range}`, ADMIN.tok)).b;
    const trow = (n) => (tx.tasks ?? []).find((t) => t.title === n);
    ok("Excel task rows carry points: A 5/5, B 1/1, C 2.5 of 5, D 0 of 4", trow("WGT A critical done")?.earnedPoints === 5 && trow("WGT A critical done")?.weightPoints === 5 && trow("WGT B low done")?.earnedPoints === 1 && trow("WGT C high partial")?.earnedPoints === 2.5 && trow("WGT C high partial")?.weightPoints === 5 && trow("WGT D medium todo")?.earnedPoints === 0 && trow("WGT D medium todo")?.weightPoints === 4, (tx.tasks ?? []).map((t) => [t.title, t.earnedPoints, t.weightPoints]));
    ok("a pending task is not scored in the export (blank points)", trow("WGT pending")?.weightPoints === null && trow("WGT pending")?.earnedPoints === null, trow("WGT pending"));
    const tr = (await call("GET", `/team-attendance/team-report?${range}`, ADMIN.tok)).b;
    ok("the team report's task rows carry the points too", (tr.tasks ?? []).some((t) => t.title === "WGT C high partial" && t.earnedPoints === 2.5), (tr.tasks ?? []).length);
    const hist = (await call("GET", `/tracker/history?from=${today}&to=${today}`, E.tok)).b;
    ok("My History summary has the weighted figure", hist.summary?.weighted?.percent === 56.67, hist.summary?.weighted);

    console.log("\n## 7. Date filter changes the figure honestly");
    await q(`update daily_tasks set date = date - 3 where title='WGT B low done'`);
    const w1 = (await call("GET", `/tasks/range?${range}`, E.tok)).b.weighted;
    ok("moving the Low task 3 days back leaves 7.5 of 14 for today (53.57%)", w1.earned === 7.5 && w1.possible === 14 && w1.percent === 53.57, w1);
    const d3 = new Date(Date.parse(today) - 3 * 86400000).toISOString().slice(0, 10);
    const wOld = (await call("GET", `/tasks/range?from=${d3}&to=${d3}`, E.tok)).b.weighted;
    ok("and that earlier day alone is 1 of 1 = 100%", wOld.percent === 100 && wOld.possible === 1, wOld);
    const wEmpty = (await call("GET", `/tasks/range?from=2020-01-01&to=2020-01-02`, E.tok)).b.weighted;
    ok("a day with no tasks is N/A", wEmpty.percent === null, wEmpty);

    console.log("\n## 8. One weight table: the old star score uses the same weights");
    ok("daily tasks weightValue for Critical/High/Medium/Low = 5/5/4/1", (() => { const m = Object.fromEntries(mine.tasks.map((t) => [t.weight, t.weightValue])); return m.CRITICAL === 5 && m.HIGH === 5 && m.MEDIUM === 4 && m.LOW === 1; })(), mine.tasks.map((t) => [t.weight, t.weightValue]));

    console.log("\n## 9. Revert clears a partial mark (back to In Progress, no credit)");
    const rv = await call("POST", `/tasks/review/${await idOf("WGT A critical done")}/revert`, MGR.tok, { type: "NOT_FULL", remark: "needs more" });
    ok("manager reopens A", rv.s === 200, rv);
    w = (await call("GET", `/tasks/range?${range}`, E.tok)).b.weighted;
    ok("A earns nothing while reopened: 2.5 of 14", w.earned === 2.5 && w.possible === 14, w);
  } finally {
    await wipe().catch(() => {});
    await db.end();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
