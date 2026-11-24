// Weighted score with manager star ratings (option A) through the real API: real sign-ins, real HTTP, THROWAWAY database only.
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
    const ids = `(select id from users where "employeeCode" like 'WGR-%')`;
    await q(`delete from task_deletions where "taskId" in (select id from daily_tasks where "userId" in ${ids})`).catch(() => {});
    await q(`delete from task_events where "taskId" in (select id from daily_tasks where "userId" in ${ids})`).catch(() => {});
    await q(`delete from task_entry_details where "taskId" in (select id from daily_tasks where "userId" in ${ids})`);
    await q(`delete from task_ratings where "taskId" in (select id from daily_tasks where "userId" in ${ids})`).catch(() => {});
    await q(`delete from daily_tasks where "userId" in ${ids}`);
    await q(`delete from work_sessions where "userId" in ${ids}`);
    await q(`delete from team_members where "userId" in ${ids}`);
    await q(`delete from teams where name like 'WGR-%'`);
    await q(`delete from notifications where "userId" in ${ids}`);
    await q(`delete from audit_logs where "userId" in ${ids}`).catch(() => {});
    await q(`delete from users where "employeeCode" like 'WGR-%'`);
  };
  await wipe().catch((e) => console.log("wipe note:", e.message));
  const mk = async (code, role, o = {}) => {
    await q(`insert into users (id,"platformId",email,"passwordHash","firstName","lastName","employeeCode",role,status,"mustChangePassword","trackerAccessEnabled","onboardingStatus","reportsToId","dateOfJoining","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,$4,'Wgt',$5,$6,'ACTIVE',false,true,'ACTIVE',$7,'2026-01-01',now(),now())`, [AV, code.toLowerCase() + "@wgr.test", hash, o.first ?? code.replace("WGR-", ""), code, role, o.boss ?? null]);
    const id = (await q(`select id from users where "employeeCode"=$1`, [code]))[0].id;
    const tok = (await (await fetch(API + "/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: code, password: PW }) })).json()).token;
    return { id, tok };
  };
  const ADMIN = await mk("WGR-ADMIN", "ADMIN", { first: "AdminW" });
  const HR = await mk("WGR-HR", "HR", { first: "HrW", boss: ADMIN.id });
  const MGR = await mk("WGR-MGR", "MANAGER", { first: "MgrW", boss: ADMIN.id });
  const MGR2 = await mk("WGR-MGR2", "MANAGER", { first: "MgrOther", boss: ADMIN.id });
  const E = await mk("WGR-E", "EMPLOYEE", { first: "EmpW", boss: MGR.id });
  const E2 = await mk("WGR-E2", "EMPLOYEE", { first: "EmpNone", boss: MGR.id }); // no tasks at all
  const teamId = (await q(`insert into teams (id,"platformId",name,"managerId","isActive","createdAt","updatedAt") values (gen_random_uuid(),$1,'WGR-Proj',$2,true,now(),now()) returning id`, [AV, MGR.id]))[0].id;
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
    console.log("## 1. Four tasks: High rated 3, Medium rated 5, Low not rated, High still in progress");
    for (const [t, w] of [["WGR High done", "HIGH"], ["WGR Medium done", "MEDIUM"], ["WGR Low done", "LOW"], ["WGR High open", "HIGH"]]) ok("send " + t, (await send(t, w)).s < 300);
    for (const t of ["WGR High done", "WGR Medium done", "WGR Low done", "WGR High open"]) ok("approve " + t, (await approve(t)).s === 200);
    for (const t of ["WGR High done", "WGR Medium done", "WGR Low done"]) ok("complete " + t, (await complete(t)).s === 200);
    let w = (await call("GET", "/tasks", E.tok)).b.weighted;
    ok("before any rating: 10 of 15 (completed tasks unrated = full credit) = 66.67%", w.earned === 10 && w.possible === 15 && w.percent === 66.67 && w.awaitingRating === 3 && w.lostToRatings === 0, w);
    ok("the manager rates the High 3 stars", (await rate("WGR High done", 3)).s === 200);
    ok("and the Medium 5 stars", (await rate("WGR Medium done", 5)).s === 200);
    w = (await call("GET", "/tasks", E.tok)).b.weighted;
    ok("now: High 3/5 + Medium 4/4 + Low 1/1 (unrated) + open High 0/5 = 8 / 15 = 53.33%", w.earned === 8 && w.possible === 15 && w.percent === 53.33, w);
    ok("the screen can say 2 points were lost to ratings and 1 completed task is awaiting a rating", w.lostToRatings === 2 && w.awaitingRating === 1 && w.rated === 2, w);

    console.log("\n## 2. Every screen shows the same figure (backend -> reports API -> screen)");
    const rng = (await call("GET", `/tasks/range?${range}`, E.tok)).b;
    ok("Daily Tasks date view", rng.weighted?.percent === 53.33, rng.weighted);
    const day = (await call("GET", `/tasks/day?date=${today}`, E.tok)).b;
    ok("My History day tasks", day.weighted?.percent === 53.33, day.weighted);
    const hist = (await call("GET", `/tracker/history?from=${today}&to=${today}`, E.tok)).b;
    ok("My History summary", hist.summary?.weighted?.percent === 53.33, hist.summary?.weighted);
    const queue = (await call("GET", "/tasks/review/queue", MGR.tok)).b;
    ok("manager's queue: overall and per employee", queue.weighted?.percent === 53.33 && queue.weightedByUser?.[E.id]?.percent === 53.33, [queue.weighted, queue.weightedByUser?.[E.id]]);
    const aq = (await call("GET", "/tasks/review/queue", ADMIN.tok)).b;
    ok("Admin sees the same", aq.weightedByUser?.[E.id]?.percent === 53.33, aq.weightedByUser?.[E.id]);
    const rep = (await call("GET", `/reports?${range}&groupBy=person&userId=${E.id}`, ADMIN.tok)).b;
    const rp = (rep.people ?? []).find((p) => p.userId === E.id);
    ok("Reports & Analytics person row and totals", rp?.weighted?.percent === 53.33 && rep.totals?.weighted?.percent === 53.33, [rp?.weighted, rep.totals?.weighted]);
    const prod = (await call("GET", `/team-attendance/productivity?${range}`, ADMIN.tok)).b;
    const pp = (prod.people ?? []).find((p) => p.userId === E.id);
    ok("Task productivity person row", pp?.weighted?.percent === 53.33 && pp.weighted.earned === 8, pp?.weighted);
    ok("Task productivity total (all people in the report, so it also carries the ratings)", typeof prod.weightedTotal?.percent === "number" && prod.weightedTotal.lostToRatings >= 2, prod.weightedTotal);
    const tx = (await call("GET", `/team-attendance/productivity/tasks?${range}`, ADMIN.tok)).b;
    const trow = (n) => (tx.tasks ?? []).find((t) => t.title === n);
    ok("Excel task rows carry the scaled points: High 3 of 5, Medium 4 of 4, Low 1 of 1, open High 0 of 5", trow("WGR High done")?.earnedPoints === 3 && trow("WGR High done")?.weightPoints === 5 && trow("WGR Medium done")?.earnedPoints === 4 && trow("WGR Low done")?.earnedPoints === 1 && trow("WGR High open")?.earnedPoints === 0, (tx.tasks ?? []).map((t) => [t.title, t.earnedPoints, t.weightPoints]));
    const tr = (await call("GET", `/team-attendance/team-report?${range}`, ADMIN.tok)).b;
    ok("the team report's task rows carry the same points", (tr.tasks ?? []).some((t) => t.title === "WGR High done" && t.earnedPoints === 3), (tr.tasks ?? []).length);

    console.log("\n## 3. Changing a rating moves the score; a new rating on the unrated task takes effect");
    ok("the manager rates the Low 4 stars", (await rate("WGR Low done", 4)).s === 200);
    w = (await call("GET", "/tasks", E.tok)).b.weighted;
    ok("Low now earns 0.8 of 1: 7.8 / 15 = 52%, nothing awaits a rating", w.earned === 7.8 && w.percent === 52 && w.awaitingRating === 0, w);
    ok("the manager raises the High to 5 stars", (await rate("WGR High done", 5)).s === 200);
    w = (await call("GET", "/tasks", E.tok)).b.weighted;
    ok("High now earns all 5: 9.8 / 15 = 65.33%", w.earned === 9.8 && w.percent === 65.33, w);
    ok("another employee's score is untouched (no tasks = N/A)", (await call("GET", `/reports?${range}&groupBy=person&userId=${E2.id}`, ADMIN.tok)).b.people?.find((p) => p.userId === E2.id)?.weighted?.percent === null);

    console.log("\n## 4. A partial mark is the manager's own judgement: stars are not applied on top");
    ok("send, approve and complete a Medium task", (await send("WGR Medium partial", "MEDIUM")).s < 300 && (await approve("WGR Medium partial")).s === 200 && (await complete("WGR Medium partial")).s === 200);
    ok("mark it partial", (await partial(MGR, "WGR Medium partial", true)).s === 200);
    w = (await call("GET", "/tasks", E.tok)).b.weighted;
    ok("it adds 2 of 4 (half), possible 19: 11.8 / 19 = 62.11%", w.earned === 11.8 && w.possible === 19 && w.percent === 62.11, w);
    ok("rating the partial task 3 stars does not change it again", (await rate("WGR Medium partial", 3)).s === 200 && (await call("GET", "/tasks", E.tok)).b.weighted.earned === 11.8);
  } finally {
    await wipe().catch(() => {});
    await db.end();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
