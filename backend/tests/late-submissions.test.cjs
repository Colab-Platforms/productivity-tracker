// Add Previous Day's Tasks (late submissions) through Quick Add. Saved on the ORIGINAL date, flagged late, window + reason rules, company setting,
// tagged-manager-only approval, duplicates, attendance untouched. Disposable database only (see _guard.cjs).
//
//   cd backend && TEST_DATABASE_URL=... TEST_API=http://localhost:5012/api node tests/late-submissions.test.cjs
// Before running: the tables task_late_details / task_late_policies must NOT exist yet and the backend must have been started AFTER that
// (the script applies migration 20261116110000_task_late_submissions itself part-way, to prove the behaviour BEFORE and AFTER it).
const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("pg");
const bcrypt = require("bcryptjs");
const API = process.env.TEST_API ?? "http://localhost:5012/api";
const DB = process.env.TEST_DATABASE_URL;
require("./_guard.cjs").assertTestDb(DB);

const call = async (m, p, t, body) => {
  const r = await fetch(API + p, { method: m, headers: { ...(t ? { authorization: "Bearer " + t } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const txt = await r.text(); let j; try { j = JSON.parse(txt); } catch { j = txt; }
  return { s: r.status, b: j };
};
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  -> " + String(JSON.stringify(x)).slice(0, 500))); };
const PW = "Tls@12345678";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const addDays = (s, n) => new Date(Date.parse(s + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);

(async () => {
  const db = new Client({ connectionString: DB }); await db.connect();
  const q = async (s, p) => (await db.query(s, p)).rows;
  if ((await q(`select to_regclass('task_late_details') t`))[0].t) throw new Error("task_late_details already exists: drop both late tables and restart the backend first.");
  const A = (await q(`select id from platforms where slug='avatar'`))[0].id;
  const B = (await q(`select id from platforms where slug='avance'`))[0].id;
  const tz = (await q(`select timezone from platforms where id=$1`, [A]))[0].timezone;
  const TODAY = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const D = (n) => addDays(TODAY, -n); // n days ago
  const hash = await bcrypt.hash(PW, 10);
  const wipe = async () => {
    const ids = (await q(`select id from users where "employeeCode" like 'TLS-%'`)).map((r) => r.id);
    if (ids.length) {
      await q(`delete from task_late_details where "userId" = any($1)`, [ids]).catch(() => {});
      await q(`delete from task_drafts where "userId" = any($1)`, [ids]).catch(() => {});
      await q(`delete from task_entry_details where "taskId" in (select id from daily_tasks where "userId" = any($1))`, [ids]).catch(() => {});
      await q(`delete from task_events where "taskId" in (select id from daily_tasks where "userId" = any($1))`, [ids]).catch(() => {});
      await q(`delete from daily_tasks where "userId" = any($1)`, [ids]);
      await q(`delete from notifications where "userId" = any($1)`, [ids]);
    }
    await q(`delete from task_late_policies where "platformId" = $1`, [A]).catch(() => {});
    await q(`delete from teams where name like 'TLS %'`);
    await q(`delete from users where "employeeCode" like 'TLS-%'`).catch(() => {});
  };
  await wipe();
  const mk = async (code, first, role, reportsTo) => (await q(`insert into users (id,"platformId",email,"passwordHash","firstName","lastName","employeeCode",role,status,"mustChangePassword","trackerAccessEnabled","onboardingStatus","dateOfJoining","reportsToId","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,$4,'Tls',$5,$6,'ACTIVE',false,true,'ACTIVE','2026-01-01',$7,now(),now()) returning id`, [A, code.toLowerCase() + "@tls.test", hash, first, code, role, reportsTo ?? null]))[0].id;
  const team = async (name, mgr) => (await q(`insert into teams (id,"platformId",name,"managerId","isActive","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,true,now(),now()) returning id`, [A, name, mgr]))[0].id;
  const login = async (code) => (await (await fetch(API + "/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: code, password: PW }) })).json()).token;

  const M1 = await mk("TLS-M1", "Manone", "MANAGER"), M2 = await mk("TLS-M2", "Mantwo", "MANAGER");
  const AD = await mk("TLS-AD", "Admin", "ADMIN"), HR = await mk("TLS-HR", "Hrp", "HR");
  const E = await mk("TLS-E", "Emp", "EMPLOYEE", M1), E2 = await mk("TLS-E2", "Emptwo", "EMPLOYEE", M1);
  const P1 = await team("TLS Alpha", M1), P2 = await team("TLS Beta", M2);
  const tE = await login("TLS-E"), tE2 = await login("TLS-E2"), tM1 = await login("TLS-M1"), tM2 = await login("TLS-M2"), tHR = await login("TLS-HR"), tAD = await login("TLS-AD");

  const outsideTasks = async () => JSON.stringify(await q(`select id,title,status::text,"approvalStatus"::text,outcome::text,"reviewNote",to_char(date,'YYYY-MM-DD') d from daily_tasks where "userId" not in (select id from users where "employeeCode" like 'TLS-%') order by id`));
  const ratingsTable = (await q(`select to_regclass('task_ratings') t`))[0].t;
  const outsideRatings = async () => (ratingsTable ? JSON.stringify(await q(`select * from task_ratings where "taskId" in (select id from daily_tasks where "userId" not in (select id from users where "employeeCode" like 'TLS-%')) order by "taskId"`)) : "");
  const attendance = async () => JSON.stringify([await q(`select count(*)::int n from work_sessions where "userId" = any($1)`, [[E, E2]]), await q(`select count(*)::int n from tracker_breaks where "sessionId" in (select id from work_sessions where "userId" = any($1))`, [[E, E2]]).catch(() => []), await q(`select count(*)::int n from attendance_correction_requests where "userId" = any($1)`, [[E, E2]]).catch(() => [])]);
  const beforeTasks = await outsideTasks(), beforeRatings = await outsideRatings(), beforeAtt = await attendance();

  const row = (n, project, mgr, extra = {}) => ({ key: "k" + n, title: `Late task ${n}`, description: `detail ${n}`, teamId: project, taggedManagerId: mgr, hoursSpent: 1 + (n % 3), weight: ["LOW", "MEDIUM", "HIGH"][n % 3], progress: ["IN_PROGRESS", "COMPLETED", "BLOCKED"][n % 3], blockedNote: "Waiting for access", ...extra });
  const bulk = (tok, rows, forDate, lateReason) => call("POST", "/tasks/bulk", tok, { rows, ...(forDate !== undefined ? { forDate } : {}), ...(lateReason !== undefined ? { lateReason } : {}) });
  const count = async (like, uid = E) => Number((await q(`select count(*)::int n from daily_tasks where "userId"=$1 and title like $2`, [uid, like]))[0].n);
  const noteCount = async (uid) => Number((await q(`select count(*)::int n from notifications where "userId"=$1 and type::text ilike '%TASK%'`, [uid]))[0].n);

  console.log("\n## before the late-submission tables exist");
  const pol0 = await call("GET", "/tasks/late-policy", tE);
  ok("the screen is told 'not ready' with the default window (3 days) and limit (14)", pol0.s === 200 && pol0.b.ready === false && pol0.b.allowedDays === 3 && pol0.b.maxDays === 14, pol0);
  const prev0 = await bulk(tE, [row(1, P1, M1)], D(1));
  ok("a previous-day request is REFUSED, not silently saved today", prev0.s === 200 && prev0.b.submitted === 0 && prev0.b.failed === 1 && /not switched on/i.test(prev0.b.results[0].error) && (await count("Late task %")) === 0, prev0);
  const set0 = await call("PUT", "/tasks/late-policy", tAD, { allowedDays: 5 });
  ok("the Admin setting answers 503 FEATURES_NOT_READY", set0.s === 503, set0);
  const today0 = await bulk(tE, [row(2, P1, M1)]);
  ok("normal Quick Add for today still works", today0.b.submitted === 1, today0);
  await q(`delete from task_entry_details where "taskId" in (select id from daily_tasks where "userId"=$1)`, [E]);
  await q(`delete from daily_tasks where "userId"=$1`, [E]);
  await q(`delete from notifications where "userId" = any($1)`, [[M1, M2, HR, AD]]);

  console.log("\n## apply the migration (throwaway database only)");
  await db.query(fs.readFileSync(path.join(__dirname, "..", "prisma", "migrations", "20261116110000_task_late_submissions", "migration.sql"), "utf8"));
  console.log("migration applied; waiting for the server to notice");
  await sleep(16000);
  const pol1 = await call("GET", "/tasks/late-policy", tE);
  ok("the screen is told 'ready' (window 3, limit 14)", pol1.b.ready === true && pol1.b.allowedDays === 3 && pol1.b.maxDays === 14, pol1.b);

  console.log("\n## yesterday (inside the window)");
  const y = await bulk(tE, [row(1, P1, M1, { key: "y1" })], D(1));
  ok("yesterday's task is submitted", y.s === 200 && y.b.submitted === 1 && y.b.failed === 0, y);
  const yRow = (await q(`select t.id, to_char(t.date,'YYYY-MM-DD') d, (extract(epoch from t."createdAt")*1000)::float8 created_ms, t."approvalStatus"::text ap, t."teamId", d."taggedManagerId" mgr, l."lateByDays", l."outsideWindow", l."allowedDays", l.reason, l."userId" luid, (extract(epoch from l."createdAt")*1000)::float8 late_ms from daily_tasks t left join task_entry_details d on d."taskId"=t.id left join task_late_details l on l."taskId"=t.id where t."userId"=$1 and t.title='Late task 1'`, [E]))[0];
  ok("saved on the ORIGINAL date (yesterday), not today", yRow.d === D(1) && yRow.d !== TODAY, yRow);
  ok("late record: 1 day late, inside the window, window snapshot 3, no reason needed, owner = the employee", yRow.lateByDays === 1 && yRow.outsideWindow === false && yRow.allowedDays === 3 && yRow.reason === null && yRow.luid === E, yRow);
  ok("own project and tagged manager kept; still waiting for approval", yRow.teamId === P1 && yRow.mgr === M1 && yRow.ap === "PENDING", yRow);
  ok("the real submission time is stored accurately (within the last minute)", Math.abs(Date.now() - yRow.created_ms) < 60000 && Math.abs(yRow.late_ms - yRow.created_ms) < 3000, [yRow.created_ms, yRow.late_ms, Date.now()]);
  ok("nothing was saved for today", (await q(`select count(*)::int n from daily_tasks where "userId"=$1 and date = $2::date`, [E, TODAY]))[0].n === 0, 0);
  const m1Q = (await call("GET", "/tasks/review/queue", tM1)).b;
  const qrow = (m1Q.all ?? []).find((t) => t.title === "Late task 1");
  ok("the tagged manager sees it with the original date, the real submission time and the late details", qrow && qrow.date === D(1) && qrow.late && qrow.late.lateByDays === 1 && qrow.late.outsideWindow === false && qrow.createdAt && Math.abs(new Date(qrow.late.submittedAt) - new Date(qrow.createdAt)) < 3000, qrow);
  ok("it is in the manager's Needs approval list and the other manager, HR and Admin cannot decide it", (m1Q.proposals ?? []).some((t) => t.title === "Late task 1") && !((await call("GET", "/tasks/review/queue", tM2)).b.proposals ?? []).some((t) => t.title === "Late task 1") && !((await call("GET", "/tasks/review/queue", tHR)).b.all ?? []).some((t) => t.title === "Late task 1"), 0);
  const n1 = await q(`select title, body from notifications where "userId"=$1 and type::text ilike '%TASK_PROPOSED%' order by "createdAt" desc limit 1`, [M1]);
  ok("only the tagged manager is notified, and the message says it is late and for which date", n1.length === 1 && /Late task/i.test(n1[0].title) && n1[0].body.includes(D(1)) && (await noteCount(M2)) === 0 && (await noteCount(HR)) === 0 && (await noteCount(AD)) === 0, n1);

  console.log("\n## several previous-date tasks");
  const multi = await bulk(tE, [2, 3, 4, 5, 6].map((n) => row(n, n % 2 ? P1 : P2, n % 2 ? M1 : M2)), D(2));
  ok("5 tasks for 2 days ago: all saved, each its own record with its own late row", multi.b.submitted === 5 && Number((await q(`select count(*)::int n from task_late_details l join daily_tasks t on t.id=l."taskId" where t."userId"=$1 and t.date = $2::date`, [E, D(2)]))[0].n) === 5, multi.b);
  const mrows = await q(`select t.title, d."taggedManagerId" mgr, t."teamId" from daily_tasks t join task_entry_details d on d."taskId"=t.id where t."userId"=$1 and t.date=$2::date`, [E, D(2)]);
  ok("each kept its own project and manager", mrows.every((r) => { const n = Number(r.title.split(" ").pop()); return r.mgr === (n % 2 ? M1 : M2) && r.teamId === (n % 2 ? P1 : P2); }), mrows);
  const e1 = await bulk(tE, [row(7, P1, M1)], D(3));
  ok("exactly 3 days back (the edge of the window) is accepted without a reason", e1.b.submitted === 1, e1.b);

  console.log("\n## outside the window");
  const noReason = await bulk(tE, [row(10, P1, M1), row(11, P2, M2)], D(4));
  ok("4 days back WITHOUT a reason: nothing is saved, each row says a reason is needed", noReason.b.submitted === 0 && noReason.b.failed === 2 && noReason.b.results.every((r) => /reason/i.test(r.error)) && (await count("Late task 1_")) === 0, noReason.b);
  const shortReason = await bulk(tE, [row(10, P1, M1)], D(4), "ab");
  ok("a 2-character reason is not enough", shortReason.b.submitted === 0, shortReason.b);
  const withReason = await bulk(tE, [row(10, P1, M1), row(11, P2, M2)], D(4), "On leave, then the portal was down");
  const out = await q(`select t.title, l."outsideWindow", l.reason, l."lateByDays", t."approvalStatus"::text ap from daily_tasks t join task_late_details l on l."taskId"=t.id where t."userId"=$1 and t.date=$2::date order by t.title`, [E, D(4)]);
  ok("4 days back WITH a reason: saved, flagged outside the window, reason kept on each task", withReason.b.submitted === 2 && out.length === 2 && out.every((r) => r.outsideWindow === true && r.reason === "On leave, then the portal was down" && r.lateByDays === 4 && r.ap === "PENDING"), out);
  const q4 = (await call("GET", "/tasks/review/queue", tM1)).b.all.find((t) => t.title === "Late task 10");
  ok("the manager sees the reason and that it is outside the allowed window", q4 && q4.late.outsideWindow === true && q4.late.reason === "On leave, then the portal was down" && q4.late.allowedDays === 3, q4);
  const old14 = await bulk(tE, [row(12, P1, M1)], D(14), "Long leave, back now");
  ok("14 days back with a reason is the oldest accepted", old14.b.submitted === 1, old14.b);
  const old15 = await bulk(tE, [row(13, P1, M1)], D(15), "Long leave, back now");
  ok("15 days back is refused even with a reason", old15.b.submitted === 0 && /too old|14 days/i.test(old15.b.results[0].error) && (await count("Late task 13")) === 0, old15.b);
  const todayReq = await bulk(tE, [row(14, P1, M1)], TODAY, "reason here");
  const futureReq = await bulk(tE, [row(15, P1, M1)], addDays(TODAY, 1), "reason here");
  ok("today and tomorrow are not previous dates", todayReq.b.submitted === 0 && futureReq.b.submitted === 0 && (await count("Late task 14")) + (await count("Late task 15")) === 0, [todayReq.b, futureReq.b]);
  const badDate = await bulk(tE, [row(16, P1, M1)], "2026-13-45");
  const badType = await bulk(tE, [row(16, P1, M1)], { x: 1 });
  ok("a malformed date is a 400 and saves nothing", badDate.s === 400 && badType.s === 400 && (await count("Late task 16")) === 0, [badDate.s, badType.s]);
  const longReason = await bulk(tE, [row(17, P1, M1)], D(1), "x".repeat(301));
  ok("a reason over 300 characters is refused", longReason.b.submitted === 0, longReason.b);
  const optReason = await bulk(tE, [row(18, P1, M1)], D(1), "Forgot to add it");
  ok("an optional reason inside the window is stored too", optReason.b.submitted === 1 && (await q(`select l.reason from task_late_details l join daily_tasks t on t.id=l."taskId" where t.title='Late task 18' and t."userId"=$1`, [E]))[0].reason === "Forgot to add it", optReason.b);

  console.log("\n## the company setting (Admin only)");
  const lp = await call("GET", "/tasks/late-policy/all", tAD);
  ok("Admin sees the setting for the companies they act on", lp.s === 200 && lp.b.companies.some((c) => c.id === A && c.allowedDays === 3), lp);
  const denied = [await call("PUT", "/tasks/late-policy", tHR, { allowedDays: 9 }), await call("PUT", "/tasks/late-policy", tM1, { allowedDays: 9 }), await call("PUT", "/tasks/late-policy", tE, { allowedDays: 9 }), await call("GET", "/tasks/late-policy/all", tHR), await call("GET", "/tasks/late-policy/all", tE)];
  ok("HR, a Manager and an Employee cannot change or list it (403)", denied.every((r) => r.s === 403), denied.map((r) => r.s));
  const badVals = await Promise.all([15, -1, 2.5, "x", null].map((v) => call("PUT", "/tasks/late-policy", tAD, { allowedDays: v })));
  ok("0 to 14 whole days only (400 otherwise)", badVals.every((r) => r.s === 400), badVals.map((r) => r.s));
  const other = await call("PUT", "/tasks/late-policy", tAD, { companyId: B, allowedDays: 5 });
  ok("an Admin cannot change a company they do not act on (404)", other.s === 404, other);
  const set5 = await call("PUT", "/tasks/late-policy", tAD, { allowedDays: 5 });
  ok("Admin sets 5 days for their company", set5.s === 200 && set5.b.companies.find((c) => c.id === A).allowedDays === 5, set5.b);
  ok("the employee's screen now reads 5", (await call("GET", "/tasks/late-policy", tE)).b.allowedDays === 5, 0);
  const day5 = await bulk(tE, [row(20, P1, M1)], D(5));
  ok("5 days back is now inside the window (no reason needed)", day5.b.submitted === 1 && (await q(`select l."outsideWindow", l."allowedDays" from task_late_details l join daily_tasks t on t.id=l."taskId" where t.title='Late task 20'`))[0].outsideWindow === false, day5.b);
  const day6 = await bulk(tE, [row(21, P1, M1)], D(6));
  ok("6 days back still needs a reason", day6.b.submitted === 0, day6.b);
  await call("PUT", "/tasks/late-policy", tAD, { allowedDays: 0 });
  const day1z = await bulk(tE, [row(22, P1, M1)], D(1));
  ok("with 0 days, even yesterday needs a reason", day1z.b.submitted === 0, day1z.b);
  await call("PUT", "/tasks/late-policy", tAD, { allowedDays: 3 });
  ok("the old tasks keep the window they were submitted under (snapshot)", (await q(`select "allowedDays" from task_late_details l join daily_tasks t on t.id=l."taskId" where t.title='Late task 20'`))[0].allowedDays === 5, 0);
  const audP = await q(`select summary from audit_logs where path = '/api/tasks/late-policy' order by "createdAt" desc limit 1`);
  ok("the setting change is in the audit log", audP.length === 1 && /previous-day task window/i.test(audP[0].summary ?? ""), audP);

  console.log("\n## duplicates");
  const dup = await bulk(tE, [row(1, P1, M1, { key: "dupA" }), row(30, P1, M1, { key: "newB" })], D(1));
  const dA = dup.b.results.find((r) => r.key === "dupA"), nB = dup.b.results.find((r) => r.key === "newB");
  ok("the same task for the same previous day is refused, a new one still goes", dA.ok === false && /already sent/i.test(dA.error) && nB.ok === true && (await count("Late task 1")) === 1, dup.b);
  const sameOtherDay = await bulk(tE, [row(1, P1, M1)], D(2));
  ok("the same words on a DIFFERENT day are a different task (allowed)", sameOtherDay.b.submitted === 1, sameOtherDay.b);
  const todayAlso = await bulk(tE, [row(1, P1, M1)]);
  ok("and today is separate from the previous days", todayAlso.b.submitted === 1, todayAlso.b);
  const race = await Promise.all([1, 2, 3].map(() => bulk(tE, [row(40, P2, M2)], D(1))));
  ok("three identical previous-day requests at once create ONE task", race.filter((x) => x.b.submitted === 1).length === 1 && (await count("Late task 40")) === 1, race.map((x) => x.b));
  const mixed = await bulk(tE, [row(41, P1, M1, { key: "good" }), row(42, null, M1, { key: "noproject", teamId: undefined }), row(43, P1, M1, { key: "hours", hoursSpent: 30 })], D(1));
  ok("a bad row in a previous-day batch does not affect the others; each failure has a reason", mixed.b.submitted === 1 && mixed.b.results.find((r) => r.key === "good").ok && !mixed.b.results.find((r) => r.key === "noproject").ok && !mixed.b.results.find((r) => r.key === "hours").ok && (await count("Late task 42")) + (await count("Late task 43")) === 0, mixed.b);

  console.log("\n## manager approval, rejection, and restrictions");
  const tid = async (title, date) => (await q(`select id from daily_tasks where "userId"=$1 and title=$2 and date=$3::date order by "createdAt" desc limit 1`, [E, title, date]))[0].id;
  const t1 = await tid("Late task 1", D(1)), t10 = await tid("Late task 10", D(4));
  const wrong = [await call("POST", `/tasks/review/${t1}/approve`, tM2, { approve: true }), await call("POST", `/tasks/review/${t1}/approve`, tHR, { approve: true }), await call("POST", `/tasks/review/${t1}/approve`, tAD, { approve: true })];
  ok("another manager, HR and an untagged Admin cannot approve it (403)", wrong.every((r) => r.s === 403), wrong.map((r) => r.s));
  const ap = await call("POST", `/tasks/review/${t1}/approve`, tM1, { approve: true });
  const rj = await call("POST", `/tasks/review/${t10}/approve`, tM1, { approve: false, rejectionNote: "Please attach the proof first" });
  const sts = Object.fromEntries((await q(`select title, "approvalStatus"::text ap, to_char(date,'YYYY-MM-DD') d from daily_tasks where "userId"=$1 and title in ('Late task 1','Late task 10')`, [E])).map((r) => [r.title + "@" + r.d, r.ap]));
  ok("the tagged manager approves one and rejects another; each keeps its original date", ap.s === 200 && rj.s === 200 && sts["Late task 1@" + D(1)] === "APPROVED" && sts["Late task 10@" + D(4)] === "REJECTED", sts);
  const mine = (await call("GET", `/tasks/range?from=${D(14)}&to=${D(1)}`, tE)).b;
  const mt1 = mine.tasks.find((t) => t.title === "Late task 1" && t.date === D(1)), mt10 = mine.tasks.find((t) => t.title === "Late task 10");
  ok("the employee's own list shows them on their original dates, labelled late, with the manager's comment", mt1 && mt1.late && mt1.date === D(1) && mt10 && mt10.late.outsideWindow === true && /proof/.test(mt10.rejectionNote ?? ""), [mt1, mt10]);
  ok("the employee's list also carries the real submission time", mt1.createdAt && Math.abs(Date.now() - new Date(mt1.createdAt).getTime()) < 300000, mt1.createdAt);
  const patch = await call("PATCH", `/tasks/${t1}`, tE, { title: "Changed", date: D(9) });
  const edited = (await q(`select title, to_char(date,'YYYY-MM-DD') d from daily_tasks where id=$1`, [t1]))[0];
  ok("an approved task cannot be overwritten and its original date cannot change", patch.s === 400 && edited.title === "Late task 1" && edited.d === D(1), [patch.s, edited]);
  const pend = await tid("Late task 11", D(4));
  await call("PATCH", `/tasks/${pend}`, tE, { progress: "COMPLETED", date: D(9) });
  ok("even a still-pending task keeps its original date when edited", (await q(`select to_char(date,'YYYY-MM-DD') d from daily_tasks where id=$1`, [pend]))[0].d === D(4), 0);
  const resend = await bulk(tE, [row(10, P1, M1)], D(4), "Attached the proof now");
  ok("a REJECTED late task can be sent again (as a new task with its own late row)", resend.b.submitted === 1 && (await q(`select count(*)::int n from task_late_details l join daily_tasks t on t.id=l."taskId" where t.title='Late task 10' and t."userId"=$1`, [E]))[0].n === 2, resend.b);
  const wd = await call("DELETE", `/tasks/${pend}`, tE);
  ok("withdrawing a pending late task removes it and its late record (nothing orphaned)", wd.s === 200 && (await q(`select count(*)::int n from task_late_details where "taskId"=$1`, [pend]))[0].n === 0, wd.s);

  console.log("\n## manager filter data and privacy");
  const full = (await call("GET", "/tasks/review/queue", tM1)).b.all.filter((t) => String(t.title).startsWith("Late task "));
  ok("rows from late submissions carry `late`; none carry it wrongly", full.every((t) => (t.late !== null) === (t.date !== TODAY)) && full.some((t) => t.late) && full.some((t) => !t.late), full.map((t) => [t.title, t.date, !!t.late]));
  const e2view = (await call("GET", `/tasks/range?from=${D(14)}&to=${D(1)}`, tE2)).b.tasks;
  ok("another employee cannot see these tasks", e2view.length === 0, e2view.length);
  const stranger = await call("GET", "/tasks/review/queue", tE);
  ok("an employee cannot open the manager queue (403)", stranger.s === 403, stranger.s);

  console.log("\n## what must not change");
  ok("attendance records were not touched by any previous-day submission", (await attendance()) === beforeAtt, [beforeAtt, await attendance()]);
  ok("other people's tasks, history, ratings and comments are exactly as they were", (await outsideTasks()) === beforeTasks && (await outsideRatings()) === beforeRatings, 0);
  const aud = await q(`select summary from audit_logs where path = '/api/tasks/bulk' and summary ilike '%late submission%' order by "createdAt" desc limit 1`);
  ok("previous-day submissions are in the audit log with the date", aud.length === 1 && /\d{4}-\d{2}-\d{2}/.test(aud[0].summary), aud);
  const today = await bulk(tE, [row(50, P1, M1)]);
  ok("normal Quick Add for today is unchanged: today's date and no late record", today.b.submitted === 1 && (await q(`select to_char(t.date,'YYYY-MM-DD') d, (select count(*)::int from task_late_details l where l."taskId"=t.id) n from daily_tasks t where t.title='Late task 50' and t."userId"=$1`, [E]))[0].d === TODAY && (await q(`select count(*)::int n from task_late_details l join daily_tasks t on t.id=l."taskId" where t.title='Late task 50'`))[0].n === 0, today.b);
  const single = await call("POST", "/tasks", tE, { title: "Late task single", weight: "LOW", progress: "IN_PROGRESS", hoursSpent: 1, teamId: P1, taggedManagerId: M1 });
  ok("the single-task form still saves for today", single.s === 200 && (await q(`select to_char(date,'YYYY-MM-DD') d from daily_tasks where title='Late task single' and "userId"=$1`, [E]))[0].d === TODAY, single.s);

  await wipe();
  await db.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
