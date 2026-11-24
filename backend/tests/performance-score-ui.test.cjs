// Overall Performance Score on screen (real Chrome, throwaway stack only).
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
  const { chromium } = require("C:/Users/hi/AppData/Local/Temp/claude/c--Users-hi-productivity-tracker/befcb5ad-6b0f-4801-a062-58ebce413840/scratchpad/e2e/node_modules/playwright-core");
  const BASE = "http://localhost:3100";
  try {
    const E3 = await mk("WGP-E3", "EMPLOYEE", { first: "EmpAwait", boss: MGR.id }), E4 = await mk("WGP-E4", "EMPLOYEE", { first: "EmpSingle", boss: MGR.id });
    for (const u of [E3, E4]) await q(`insert into team_members (id,"teamId","userId","isActive","isPrimary","joinedAt") values (gen_random_uuid(),$1,$2,true,true,now())`, [teamId, u.id]);
    const sendAs = (who, title, weight) => call("POST", "/tasks", who.tok, { title, teamId, taggedManagerId: MGR.id, weight, progress: "IN_PROGRESS", hoursSpent: 1 });
    const approveAs = async (title) => call("POST", `/tasks/review/${await idOf(title)}/approve`, MGR.tok, { approve: true });
    const completeAs = async (who, title) => call("PATCH", `/tasks/${await idOf(title)}`, who.tok, { progress: "COMPLETED" });
    const rate = async (title, rating) => call("POST", `/tasks/review/${await idOf(title)}/rating`, MGR.tok, { rating });
    const mkTasks = async (who, prefix, specs) => { for (const [i, [pr, done, stars]] of specs.entries()) { const t = `${prefix} ${i + 1}`; await sendAs(who, t, pr); await approveAs(t); if (done) await completeAs(who, t); if (stars) await rate(t, stars); } };
    await mkTasks(E, "UIA", [["CRITICAL", true, 5], ["LOW", true, 5], ["HIGH", true, 3], ["MEDIUM", false, 0]]);           // 3 of 4 done, ratings 5,5,3  -> 79.67 Final
    await mkTasks(E2, "UIB", [["HIGH", true, 5], ["HIGH", true, 0], ["HIGH", true, 0]]);                                   // provisional: 1 rated of 3 -> 100x0.6 + 100x0.4 = 100, 2 pending
    await mkTasks(E3, "UIC", [["MEDIUM", true, 0], ["MEDIUM", true, 0]]);                                                  // awaiting evaluation
    await mkTasks(E4, "UID", [["LOW", true, 5]]);                                                                           // one task, 5/5 -> 100% (1 task)

    const b = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true, args: ["--no-sandbox"] });
    const open = async (w = 1440) => { const p = await (await b.newContext({ viewport: { width: w, height: 900 } })).newPage(); await p.goto(BASE + "/login", { waitUntil: "domcontentloaded" }); await p.waitForTimeout(4000); await p.locator("input").nth(0).fill("WGP-ADMIN"); await p.locator('input[type="password"]').fill(PW); await p.locator('button[type="submit"]').click(); await p.waitForURL(/\/dashboard/, { timeout: 90000 }); await p.waitForTimeout(3000); return p; };
    const p = await open();
    await p.goto(BASE + "/dashboard/reports?tab=productivity", { waitUntil: "domcontentloaded" }); await p.waitForSelector('[data-testid="score-open"]', { timeout: 90000 }); await p.waitForTimeout(2500);
    const rowOf = async (name) => (await p.locator("tbody tr").filter({ hasText: name }).first().innerText()).replace(/\s+/g, " ");
    const heads = (await p.locator("thead th").allInnerTexts()).map((x) => x.trim().toLowerCase());
    ok("the table has Eligible, Completed, Pending / incomplete, Completion %, Avg rating, Overall Performance Score and Evaluation status", ["total eligible", "completed", "pending / incomplete", "completion %", "avg rating", "overall performance score", "evaluation status"].every((h) => heads.includes(h)), heads);
    ok("the old 'Weighted score' heading is gone", !heads.some((h) => /Weighted/i.test(h)), heads);
    const ra = await rowOf("EmpW");
    ok("EmpW (3 of 4 done, ratings 5/5/3): eligible 4, completed 3, incomplete 1, completion 75%, average 4.33 / 5, 79.67% (4 tasks), Final", /\b4 3 1 75% 4\.33 \/ 5 79\.67% \(4 tasks\) Final/.test(ra), ra);
    const rb = await rowOf("EmpNone");
    ok("EmpNone (3 done, 1 rated): Provisional with 2 pending evaluations and the sample size", /Provisional \(2 pending\)/.test(rb) && /\(3 tasks\)/.test(rb), rb);
    const rc = await rowOf("EmpAwait");
    ok("EmpAwait (completed, nothing rated): Awaiting evaluation, no percentage invented", /Awaiting evaluation/.test(rc) && !/100%\s*\(/.test(rc), rc);
    const rd = await rowOf("EmpSingle");
    ok("EmpSingle (one task, 5/5): 100% (1 task), clearly marked as one task", /100% \(1 task\)/.test(rd), rd);
    // the breakdown
    await p.locator("tbody tr").filter({ hasText: "EmpW" }).first().getByTestId("score-open").click(); await p.waitForSelector('[data-testid="score-breakdown"]', { timeout: 30000 }); await p.waitForTimeout(1500);
    const m = (await p.getByTestId("score-breakdown").innerText()).replace(/\s+/g, " ");
    ok("the breakdown shows the name, the period and the headline", /79\.67%/.test(m) && /\(4 tasks\)/.test(m) && /Final/.test(m), m.slice(0, 200));
    ok("it shows completion: eligible 4, completed 3, 75%, contribution 45", /Eligible tasks 4/.test(m) && /Completed tasks 3/.test(m) && /Completion % 75%/.test(m) && /Contribution \(× 0\.60\) 45/.test(m), m);
    ok("it shows the evaluation: 3 rated, average 4.33 / 5, rating 86.67%, contribution 34.67", /Rated tasks 3/.test(m) && /Average rating 4\.33 \/ 5/.test(m) && /Rating % 86\.67%/.test(m) && /Contribution \(× 0\.40\) 34\.67/.test(m), m);
    ok("it shows the formula and says priority is not used", /Completion % × 0\.60\) \+ \(Manager rating % × 0\.40\)/.test(m) && /priority is not used/i.test(m), m);
    const rowsTxt = (await p.getByTestId("score-breakdown").locator("tbody tr").allInnerTexts()).map((x) => x.replace(/\s+/g, " "));
    ok("each task is listed with its original date, status and manager rating (5, 5, 3 and the open one)", rowsTxt.length === 4 && rowsTxt.filter((r) => /5 \/ 5/.test(r)).length === 2 && rowsTxt.filter((r) => /3 \/ 5/.test(r)).length === 1 && rowsTxt.some((r) => /Not completed/.test(r)), rowsTxt);
    await p.keyboard.press("Escape"); await p.waitForTimeout(400);
    ok("the breakdown closes", (await p.getByTestId("score-breakdown").count()) === 0);
    await p.locator("tbody tr").filter({ hasText: "EmpNone" }).first().getByTestId("score-open").click(); await p.waitForSelector('[data-testid="score-breakdown"]', { timeout: 30000 }); await p.waitForTimeout(1200);
    const m2 = (await p.getByTestId("score-breakdown").innerText()).replace(/\s+/g, " ");
    ok("the provisional breakdown explains the outstanding evaluations", /Provisional/.test(m2) && /2 completed tasks are still waiting for a manager rating/.test(m2) && /Pending evaluation/.test(m2), m2.slice(0, 400));
    await p.keyboard.press("Escape");
    // the same figures after a refresh, and on a phone
    await p.reload({ waitUntil: "domcontentloaded" }); await p.waitForSelector('[data-testid="score-open"]', { timeout: 90000 }); await p.waitForTimeout(2000);
    ok("after a refresh the score is unchanged", /79\.67% \(4 tasks\)/.test(await rowOf("EmpW")));
    const pm = await open(390); await pm.goto(BASE + "/dashboard/reports?tab=productivity", { waitUntil: "domcontentloaded" }); await pm.waitForSelector('[data-testid="score-open"]', { timeout: 90000 }); await pm.waitForTimeout(1500);
    ok("phone: the page does not scroll sideways (the table scrolls inside its card)", await pm.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await p.screenshot({ path: "C:/Users/hi/AppData/Local/Temp/perf-table.png" });
    await b.close();
  } finally {
    await wipe().catch(() => {});
    await db.end();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
