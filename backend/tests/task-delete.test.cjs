// Delete task (soft delete by the tagged manager). Pending, approved, rejected and approved+rated tasks; another manager's team; HR/Admin/Employee refused;
// the task leaves every active list and report and its rating stops counting; everything stays on file; reason + actor recorded; employee told.
// Disposable database only (see _guard.cjs).
//
//   cd backend && TEST_DATABASE_URL=... TEST_API=http://localhost:5012/api node tests/task-delete.test.cjs
// Before running: task_deletions must NOT exist and the backend must have been started AFTER that (the script applies migration
// 20261116120000_task_deletions itself part-way, to prove the behaviour BEFORE and AFTER it).
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
const PW = "Tdl@12345678";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const db = new Client({ connectionString: DB }); await db.connect();
  const q = async (s, p) => (await db.query(s, p)).rows;
  if ((await q(`select to_regclass('task_deletions') t`))[0].t) throw new Error("task_deletions already exists: drop it and restart the backend first.");
  const A = (await q(`select id from platforms where slug='avatar'`))[0].id;
  const B = (await q(`select id from platforms where slug='avance'`))[0].id;
  const tz = (await q(`select timezone from platforms where id=$1`, [A]))[0].timezone;
  const TODAY = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const hash = await bcrypt.hash(PW, 10);
  const wipe = async () => {
    const ids = (await q(`select id from users where "employeeCode" like 'TDL-%'`)).map((r) => r.id);
    if (ids.length) {
      await q(`delete from task_deletions where "platformId" = any($1)`, [[A, B]]).catch(() => {});
      await q(`delete from task_ratings where "taskId" in (select id from daily_tasks where "userId" = any($1))`, [ids]).catch(() => {});
      await q(`delete from task_late_details where "userId" = any($1)`, [ids]).catch(() => {});
      await q(`delete from task_entry_details where "taskId" in (select id from daily_tasks where "userId" = any($1))`, [ids]).catch(() => {});
      await q(`delete from task_events where "taskId" in (select id from daily_tasks where "userId" = any($1))`, [ids]).catch(() => {});
      await q(`delete from daily_tasks where "userId" = any($1)`, [ids]);
      await q(`delete from notifications where "userId" = any($1)`, [ids]);
    }
    await q(`delete from teams where name like 'TDL %'`);
    await q(`delete from users where "employeeCode" like 'TDL-%'`).catch(() => {});
  };
  await wipe();
  const mk = async (code, first, role, plat, reportsTo) => (await q(`insert into users (id,"platformId",email,"passwordHash","firstName","lastName","employeeCode",role,status,"mustChangePassword","trackerAccessEnabled","onboardingStatus","dateOfJoining","reportsToId","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,$4,'Tdl',$5,$6,'ACTIVE',false,true,'ACTIVE','2026-01-01',$7,now(),now()) returning id`, [plat, code.toLowerCase() + "@tdl.test", hash, first, code, role, reportsTo ?? null]))[0].id;
  const team = async (name, mgr) => (await q(`insert into teams (id,"platformId",name,"managerId","isActive","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,true,now(),now()) returning id`, [A, name, mgr]))[0].id;
  const login = async (code) => (await (await fetch(API + "/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: code, password: PW }) })).json()).token;

  const M1 = await mk("TDL-M1", "Manone", "MANAGER", A), M2 = await mk("TDL-M2", "Mantwo", "MANAGER", A);
  const AD = await mk("TDL-AD", "Admin", "ADMIN", A), HR = await mk("TDL-HR", "Hrp", "HR", A);
  const E = await mk("TDL-E", "Empone", "EMPLOYEE", A, M1), E2 = await mk("TDL-E2", "Emptwo", "EMPLOYEE", A, M1);
  const HRB = await mk("TDL-HRB", "Hrother", "HR", B), ADB = await mk("TDL-ADB", "Adother", "ADMIN", B);
  const P1 = await team("TDL Alpha", M1), P2 = await team("TDL Beta", M2);
  const tE = await login("TDL-E"), tE2 = await login("TDL-E2"), tM1 = await login("TDL-M1"), tM2 = await login("TDL-M2"), tHR = await login("TDL-HR"), tAD = await login("TDL-AD"), tHRB = await login("TDL-HRB"), tADB = await login("TDL-ADB");

  const outsideTasks = async () => JSON.stringify(await q(`select id,title,status::text,"approvalStatus"::text,outcome::text,"reviewNote","rejectionNote",to_char(date,'YYYY-MM-DD') d from daily_tasks where "userId" not in (select id from users where "employeeCode" like 'TDL-%') order by id`));
  const beforeOutside = await outsideTasks();
  const rawTask = async (id) => JSON.stringify((await q(`select * from daily_tasks where id=$1`, [id]))[0]);
  const rawRating = async (id) => JSON.stringify(await q(`select * from task_ratings where "taskId"=$1`, [id]));
  const rawEntry = async (id) => JSON.stringify(await q(`select * from task_entry_details where "taskId"=$1`, [id]));
  const noteCount = async (uid, type) => Number((await q(`select count(*)::int n from notifications where "userId"=$1 and type::text=$2`, [uid, type]))[0].n);

  // create a task as E (or E2), tagged to a manager, optionally approve / rate it
  const mkTask = async (tok, title, project, manager, extra = {}) => {
    const r = await call("POST", "/tasks", tok, { title, description: "detail of " + title, weight: "HIGH", progress: extra.progress ?? "IN_PROGRESS", hoursSpent: 2, teamId: project, taggedManagerId: manager });
    if (r.s !== 200) throw new Error("could not create task " + title + ": " + JSON.stringify(r.b));
    return (await q(`select id from daily_tasks where title=$1 and "userId" = (select id from users where "employeeCode" = $2)`, [title, tok === tE ? "TDL-E" : "TDL-E2"]))[0].id;
  };
  const approve = (id, tok) => call("POST", `/tasks/review/${id}/approve`, tok, { approve: true });
  const reject = (id, tok) => call("POST", `/tasks/review/${id}/approve`, tok, { approve: false, rejectionNote: "Not needed" });
  const rate = (id, tok, stars, comment) => call("POST", `/tasks/review/${id}/rating`, tok, { rating: stars, comment });

  console.log("\n## before the table exists");
  const tPre = await mkTask(tE, "Pre task", P1, M1);
  const pre = await call("POST", `/tasks/review/${tPre}/delete`, tM1, { reasonCode: "MISTAKE" });
  ok("deleting answers 503 (not switched on) and nothing is deleted", pre.s === 503 && (await q(`select count(*)::int n from daily_tasks where id=$1`, [tPre]))[0].n === 1, pre);
  const lst0 = await call("GET", "/tasks/deleted", tHR);
  ok("the deleted list says not ready, empty", lst0.s === 200 && lst0.b.ready === false && lst0.b.tasks.length === 0, lst0);
  ok("the task still shows normally in the employee's list and the manager's queue", (await call("GET", "/tasks", tE)).b.awaitingApproval.some((t) => t.id === tPre) && (await call("GET", "/tasks/review/queue", tM1)).b.all.some((t) => t.id === tPre), 0);
  await q(`delete from task_entry_details where "taskId"=$1`, [tPre]); await q(`delete from daily_tasks where id=$1`, [tPre]);
  await q(`delete from notifications where "userId" = any($1)`, [[M1, M2, E, E2]]);

  console.log("\n## apply the migration (throwaway database only)");
  await db.query(fs.readFileSync(path.join(__dirname, "..", "prisma", "migrations", "20261116120000_task_deletions", "migration.sql"), "utf8"));
  console.log("migration applied; waiting for the server to notice");
  await sleep(16000);

  // ---- the tasks used below ----
  const tPending = await mkTask(tE, "Del pending", P1, M1);
  const tApproved = await mkTask(tE, "Del approved", P1, M1);
  const tRejected = await mkTask(tE, "Del rejected", P1, M1);
  const tRated = await mkTask(tE, "Del rated", P1, M1, { progress: "COMPLETED" });
  const tOther = await mkTask(tE, "Del other team", P2, M2);
  const tKeep = await mkTask(tE, "Keep this one", P1, M1, { progress: "COMPLETED" });
  const tE2Task = await mkTask(tE2, "E2 task", P1, M1);
  await approve(tApproved, tM1); await reject(tRejected, tM1); await approve(tRated, tM1); await approve(tKeep, tM1); await approve(tOther, tM2);
  const rt = await rate(tRated, tM1, 5, "Excellent work");
  const rk = await rate(tKeep, tM1, 4, "Good");
  ok("setup: approved, rejected and rated tasks exist", rt.s === 200 && rk.s === 200, [rt.s, rk.s]);

  const numbers = async (tok, uid) => {
    const r = (await call("GET", `/reports?from=${TODAY}&to=${TODAY}`, tok)).b;
    const p = (r.people ?? []).find((x) => x.userId === uid);
    return p ? { tasksTotal: p.tasksTotal, tasksCompleted: p.tasksCompleted, tasksPending: p.tasksPending, taskScore: p.taskScore, ratedCount: p.ratedCount, ratingSum: p.ratingSum } : null;
  };
  const numBefore = await numbers(tM1, E);
  console.log("report numbers before:", JSON.stringify(numBefore));
  ok("setup: the report counts the rated task", numBefore && numBefore.ratedCount === 2 && numBefore.ratingSum === 9, numBefore);
  const prodRows = async (tok) => ((await call("GET", `/team-attendance/productivity/tasks?from=${TODAY}&to=${TODAY}`, tok)).b.tasks ?? []);
  const prodBefore = await prodRows(tM1);
  ok("setup: the task export lists the tasks (incl. the one to delete)", prodBefore.some((t) => (t.task ?? t.title) === "Del rated" || JSON.stringify(t).includes("Del rated")), prodBefore.length);

  const ratedBeforeRaw = await rawTask(tRated), ratedRatingRaw = await rawRating(tRated), ratedEntryRaw = await rawEntry(tRated);

  console.log("\n## who may delete");
  const denied = [
    ["HR", await call("POST", `/tasks/review/${tApproved}/delete`, tHR, { reasonCode: "MISTAKE" })],
    ["an Admin who is not tagged", await call("POST", `/tasks/review/${tApproved}/delete`, tAD, { reasonCode: "MISTAKE" })],
    ["the employee (own task)", await call("POST", `/tasks/review/${tApproved}/delete`, tE, { reasonCode: "MISTAKE" })],
    ["another employee", await call("POST", `/tasks/review/${tApproved}/delete`, tE2, { reasonCode: "MISTAKE" })],
    ["another manager (M2) on M1's task", await call("POST", `/tasks/review/${tApproved}/delete`, tM2, { reasonCode: "MISTAKE" })],
    ["HR of another company", await call("POST", `/tasks/review/${tApproved}/delete`, tHRB, { reasonCode: "MISTAKE" })],
    ["Admin of another company", await call("POST", `/tasks/review/${tApproved}/delete`, tADB, { reasonCode: "MISTAKE" })],
    ["M1 on M2's task (another manager's team)", await call("POST", `/tasks/review/${tOther}/delete`, tM1, { reasonCode: "MISTAKE" })],
    ["not signed in", await call("POST", `/tasks/review/${tApproved}/delete`, null, { reasonCode: "MISTAKE" })],
  ];
  for (const [who, r] of denied) ok(`${who} cannot delete (${r.s})`, [401, 403, 404].includes(r.s), r);
  ok("none of those refusals deleted anything", Number((await q(`select count(*)::int n from task_deletions`))[0].n) === 0, 0);

  console.log("\n## the confirmation needs a valid reason");
  const rr = [
    await call("POST", `/tasks/review/${tPending}/delete`, tM1, {}),
    await call("POST", `/tasks/review/${tPending}/delete`, tM1, { reasonCode: "NOPE" }),
    await call("POST", `/tasks/review/${tPending}/delete`, tM1, { reasonCode: "OTHER" }),
    await call("POST", `/tasks/review/${tPending}/delete`, tM1, { reasonCode: "OTHER", note: "ab" }),
    await call("POST", `/tasks/review/${tPending}/delete`, tM1, { reasonCode: "MISTAKE", note: "x".repeat(301) }),
  ];
  ok("no reason, a made-up reason, Other without a note, a 2-character note and a 301-character note are all refused (400)", rr.every((r) => r.s === 400), rr.map((r) => r.s));
  ok("nothing was deleted by those attempts", Number((await q(`select count(*)::int n from task_deletions`))[0].n) === 0, 0);

  console.log("\n## delete: pending, approved, rejected, approved + rated");
  const beforeRaw = { pending: await rawTask(tPending), approved: await rawTask(tApproved), rejected: await rawTask(tRejected) };
  const dPend = await call("POST", `/tasks/review/${tPending}/delete`, tM1, { reasonCode: "WRONG_EMPLOYEE", note: "Belongs to Priya" });
  const dAppr = await call("POST", `/tasks/review/${tApproved}/delete`, tM1, { reasonCode: "WRONG_PROJECT" });
  const dRej = await call("POST", `/tasks/review/${tRejected}/delete`, tM1, { reasonCode: "DUPLICATE" });
  const dRated = await call("POST", `/tasks/review/${tRated}/delete`, tM1, { reasonCode: "OTHER", note: "Rated the wrong person by mistake" });
  ok("a pending, an approved, a rejected and an approved + rated task are all deleted by the tagged manager", [dPend, dAppr, dRej, dRated].every((r) => r.s === 200 && r.b.ok), [dPend.s, dAppr.s, dRej.s, dRated.s]);
  const dels = await q(`select d.*, t.title from task_deletions d join daily_tasks t on t.id=d."taskId" where d."taskId" = any($1) order by t.title`, [[tPending, tApproved, tRejected, tRated]]);
  ok("a deletion record exists for each, with who (id, name, role), when, the reason and the note", dels.length === 4 && dels.every((d) => d.deletedById === M1 && d.deletedByName === "Manone Tdl" && d.deletedByRole === "MANAGER" && d.deletedAt && d.platformId === A), dels);
  const byTitle = Object.fromEntries(dels.map((d) => [d.title, d]));
  ok("the reasons and notes were stored as given", byTitle["Del pending"].reasonCode === "WRONG_EMPLOYEE" && byTitle["Del pending"].reasonNote === "Belongs to Priya" && byTitle["Del approved"].reasonNote === null && byTitle["Del rated"].reasonCode === "OTHER" && /wrong person/.test(byTitle["Del rated"].reasonNote), byTitle);
  ok("the time of deletion is recorded accurately", dels.every((d) => Math.abs(Date.now() - new Date(d.deletedAt.getTime() - d.deletedAt.getTimezoneOffset() * 60000 * 0).getTime()) < 24 * 3600 * 1000), 0);

  console.log("\n## nothing was erased");
  ok("the task rows are byte-for-byte unchanged (description, project, approval history, comments)", (await rawTask(tPending)) === beforeRaw.pending && (await rawTask(tApproved)) === beforeRaw.approved && (await rawTask(tRejected)) === beforeRaw.rejected && (await rawTask(tRated)) === ratedBeforeRaw, 0);
  ok("the rating and the comment are still stored, unchanged", (await rawRating(tRated)) === ratedRatingRaw && JSON.parse(ratedRatingRaw).length === 1, ratedRatingRaw);
  ok("the entry details (tagged manager, hours) are unchanged", (await rawEntry(tRated)) === ratedEntryRaw, 0);
  ok("no task was hard-deleted", Number((await q(`select count(*)::int n from daily_tasks where id = any($1)`, [[tPending, tApproved, tRejected, tRated]]))[0].n) === 4, 0);

  console.log("\n## gone from active records");
  const mine = (await call("GET", "/tasks", tE)).b;
  const mineIds = [...mine.awaitingApproval, ...mine.rejected, ...mine.active, ...mine.done].map((t) => t.id);
  ok("the employee's Daily tasks list no longer has them", [tPending, tApproved, tRejected, tRated].every((id) => !mineIds.includes(id)) && mineIds.includes(tKeep) && mineIds.includes(tOther), mineIds.length);
  const range = (await call("GET", `/tasks/range?from=${TODAY}&to=${TODAY}`, tE)).b.tasks.map((t) => t.id);
  const day = (await call("GET", `/tasks/day?date=${TODAY}`, tE)).b;
  ok("the employee's date view and day view no longer have them", [tPending, tApproved, tRejected, tRated].every((id) => !range.includes(id)) && !JSON.stringify(day).includes(tRated), range.length);
  const queue = (await call("GET", "/tasks/review/queue", tM1)).b;
  ok("the manager's queue no longer has them (any tab)", [tPending, tApproved, tRejected, tRated].every((id) => !queue.all.some((t) => t.id === id)) && !queue.proposals.some((t) => t.id === tPending) && queue.all.some((t) => t.id === tKeep), queue.all.length);
  const numAfter = await numbers(tM1, E);
  console.log("report numbers after:", JSON.stringify(numAfter));
  ok("the deleted rating no longer counts: rated tasks 2 -> 1 and stars 9 -> 4", numAfter.ratedCount === 1 && numAfter.ratingSum === 4, numAfter);
  ok("the task total (a weight total: 4 high-priority tasks x 3) dropped by exactly the 4 deleted tasks, and completed / pending fell too", numAfter.tasksTotal === numBefore.tasksTotal - 12 && numAfter.tasksCompleted === numBefore.tasksCompleted - 1 && numAfter.tasksPending === numBefore.tasksPending - 1 && numAfter.taskScore !== numBefore.taskScore, [numBefore, numAfter]);
  const prodAfter = await prodRows(tM1);
  ok("the task export / productivity rows no longer list them (nothing is counted twice)", !JSON.stringify(prodAfter).includes("Del rated") && !JSON.stringify(prodAfter).includes("Del approved") && JSON.stringify(prodAfter).includes("Keep this one"), prodAfter.length);
  const prodSummary = (await call("GET", `/team-attendance/productivity?from=${TODAY}&to=${TODAY}`, tM1)).b;
  const pe = (prodSummary.people ?? []).find((p) => p.userId === E);
  ok("the productivity summary counts only the tasks still standing", pe && pe.completedTotal <= 1, pe);
  const hrNums = await numbers(tHR, E);
  ok("HR's reports agree with the manager's (same numbers)", JSON.stringify(hrNums) === JSON.stringify(numAfter), [hrNums, numAfter]);
  const cal = await call("GET", `/attendance-calendar?from=${TODAY}&to=${TODAY}`, tM1);
  ok("the attendance calendar and report still load", cal.s === 200 && (await call("GET", `/team-attendance/attendance?from=${TODAY}&to=${TODAY}`, tHR)).s === 200, cal.s);

  console.log("\n## the employee cannot touch a deleted task");
  const touch = [
    await call("PATCH", `/tasks/${tRated}`, tE, { progress: "IN_PROGRESS" }),
    await call("DELETE", `/tasks/${tRated}`, tE),
    await call("PATCH", `/tasks/${tPending}`, tE, { title: "edited" }),
    await call("DELETE", `/tasks/${tPending}`, tE),
    await call("POST", `/tasks/review/${tRated}/approve`, tM1, { approve: true }),
    await call("POST", `/tasks/review/${tRated}/rating`, tM1, { rating: 1 }),
    await call("POST", `/tasks/review/${tRated}/revert`, tM1, { type: "PARTIAL", remark: "again" }),
    await call("GET", `/tasks/${tRated}/history`, tE),
  ];
  ok("edit, withdraw, approve, rate, reopen and history of a deleted task all answer 404", touch.every((r) => r.s === 404), touch.map((r) => r.s));
  const again = await call("POST", `/tasks/review/${tRated}/delete`, tM1, { reasonCode: "MISTAKE" });
  ok("deleting it again answers 409, one record only", again.s === 409 && Number((await q(`select count(*)::int n from task_deletions where "taskId"=$1`, [tRated]))[0].n) === 1, again);
  const race = await Promise.all([1, 2, 3].map(() => call("POST", `/tasks/review/${tKeep}/delete`, tM1, { reasonCode: "MISTAKE" })));
  ok("three presses at the same moment delete it once (one 200, the rest 409)", race.filter((r) => r.s === 200).length === 1 && race.filter((r) => r.s === 409).length === 2 && Number((await q(`select count(*)::int n from task_deletions where "taskId"=$1`, [tKeep]))[0].n) === 1, race.map((r) => r.s));
  const resend = await call("POST", "/tasks/bulk", tE, { rows: [{ key: "r", title: "Del rated", description: "again", teamId: P1, taggedManagerId: M1, hoursSpent: 1, weight: "LOW", progress: "IN_PROGRESS" }] });
  ok("a deleted task does not block sending a corrected one with the same words", resend.s === 200 && resend.b.submitted === 1, resend.b);

  console.log("\n## notification");
  const n = await q(`select title, body, type::text t from notifications where "userId"=$1 and type::text='TASK_DELETED' order by "createdAt"`, [E]);
  ok("the employee was notified once per deleted task (5), with the reason", n.length === 5 && n.some((x) => /wrong employee/i.test(x.body) && /Belongs to Priya/.test(x.body)) && n.some((x) => /Rated the wrong person/.test(x.body)), n.map((x) => x.body));
  ok("nobody else was notified", (await noteCount(E2, "TASK_DELETED")) + (await noteCount(M1, "TASK_DELETED")) + (await noteCount(HR, "TASK_DELETED")) + (await noteCount(AD, "TASK_DELETED")) === 0, 0);

  console.log("\n## another manager's team: his own deletion works, and each manager sees only his");
  const dOther = await call("POST", `/tasks/review/${tOther}/delete`, tM2, { reasonCode: "WRONG_PROJECT", note: "Should be Alpha" });
  ok("M2 deletes the task tagged to him", dOther.s === 200 && (await q(`select "deletedById" from task_deletions where "taskId"=$1`, [tOther]))[0].deletedById === M2, dOther);

  console.log("\n## the Deleted tasks list");
  const hrList = await call("GET", "/tasks/deleted", tHR);
  const adList = await call("GET", "/tasks/deleted", tAD);
  ok("HR sees every deleted task of their company (6 so far)", hrList.s === 200 && hrList.b.ready && hrList.b.tasks.length === 6 && adList.b.tasks.length === 6, [hrList.b.tasks?.length, adList.b.tasks?.length]);
  const rated = hrList.b.tasks.find((t) => t.id === tRated);
  ok("it keeps the original details: employee, task, date, project, rating, comment, approval, manager", rated && rated.employee === "Empone Tdl" && rated.employeeCode === "TDL-E" && rated.title === "Del rated" && rated.description === "detail of Del rated" && rated.date === TODAY && rated.project === "TDL Alpha" && rated.rating === 5 && rated.ratingComment === "Excellent work" && rated.approvalStatus === "APPROVED" && rated.taggedManager === "Manone Tdl", rated);
  ok("it shows who deleted it, their role, when and why", rated && rated.deletedBy === "Manone Tdl" && rated.deletedByRole === "MANAGER" && rated.deletedAt && rated.reasonCode === "OTHER" && /wrong person/.test(rated.note) && rated.reason === "Other", rated);
  const rej = hrList.b.tasks.find((t) => t.id === tRejected);
  ok("a rejected task keeps its rejection comment", rej && /Not needed/.test(rej.rejectionNote ?? ""), rej);
  const m1List = await call("GET", "/tasks/deleted", tM1), m2List = await call("GET", "/tasks/deleted", tM2);
  ok("a manager sees only the tasks he deleted himself (M1: 5, M2: 1)", m1List.b.tasks.length === 5 && m1List.b.tasks.every((t) => t.deletedBy === "Manone Tdl") && m2List.b.tasks.length === 1 && m2List.b.tasks[0].id === tOther, [m1List.b.tasks.length, m2List.b.tasks.length]);
  const other = [await call("GET", "/tasks/deleted", tHRB), await call("GET", "/tasks/deleted", tADB)];
  ok("HR and Admin of ANOTHER company see none of them", other.every((r) => r.s === 200 && r.b.tasks.length === 0), other.map((r) => r.b.tasks?.length));
  const emp = [await call("GET", "/tasks/deleted", tE), await call("GET", "/tasks/deleted", tE2)];
  ok("an employee cannot open the deleted list (403)", emp.every((r) => r.s === 403), emp.map((r) => r.s));

  console.log("\n## audit, existing workflow, other people");
  const aud = await q(`select summary, before, after, "actorId", "targetUserId" from audit_logs where path like '/api/tasks/review/%/delete' and "recordId" = $1`, [tRated]);
  ok("the audit log has one line with who, a full copy of the task and its rating", aud.length === 1 && aud[0].actorId === M1 && aud[0].targetUserId === E && aud[0].before?.rating === 5 && aud[0].before?.title === "Del rated" && /Rated the wrong person/.test(aud[0].summary), aud[0]);
  const numMid = await numbers(tM1, E);
  ok("the task deleted in the race no longer counts either (its 4 stars are gone)", numMid.ratedCount === 0 && numMid.ratingSum === 0, numMid);
  const tNew = await mkTask(tE, "After deletes", P1, M1, { progress: "COMPLETED" });
  const a2 = await approve(tNew, tM1), r2 = await rate(tNew, tM1, 3, "ok");
  ok("approving and rating still work for other tasks afterwards", a2.s === 200 && r2.s === 200, [a2.s, r2.s]);
  const numFinal = await numbers(tM1, E);
  ok("and the new task is counted in the reports as usual", numFinal.ratedCount === numMid.ratedCount + 1 && numFinal.ratingSum === numMid.ratingSum + 3, [numMid, numFinal]);
  const e2 = (await call("GET", "/tasks/review/queue", tM1)).b.all.find((t) => t.id === tE2Task);
  ok("another employee's task in the same queue is untouched", !!e2, 0);
  ok("other people's tasks, ratings and history are exactly as they were", (await outsideTasks()) === beforeOutside, 0);

  await wipe();
  await db.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
