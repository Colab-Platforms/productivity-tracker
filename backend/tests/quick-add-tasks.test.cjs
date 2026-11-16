// Quick Add (multiple tasks) + drafts. Each row becomes its own task, tagged to its own manager; one bad row never affects another; a
// row sent twice is refused; drafts are private to the employee and are never tasks. Disposable database only (see _guard.cjs).
//
//   cd backend && TEST_DATABASE_URL=... TEST_API=http://localhost:5012/api node tests/quick-add-tasks.test.cjs
// The script applies migration 20261116100000_task_drafts itself part-way through, to prove the behaviour BEFORE and AFTER it.
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
const PW = "Tqa@12345678";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const db = new Client({ connectionString: DB }); await db.connect();
  const q = async (s, p) => (await db.query(s, p)).rows;
  const A = (await q(`select id from platforms where slug='avatar'`))[0].id;
  const hash = await bcrypt.hash(PW, 10);
  const wipe = async () => {
    const ids = (await q(`select id from users where "employeeCode" like 'TQA-%'`)).map((r) => r.id);
    if (ids.length) {
      await q(`delete from task_drafts where "userId" = any($1)`, [ids]).catch(() => {});
      await q(`delete from task_entry_details where "taskId" in (select id from daily_tasks where "userId" = any($1))`, [ids]).catch(() => {});
      await q(`delete from task_events where "taskId" in (select id from daily_tasks where "userId" = any($1))`, [ids]).catch(() => {});
      await q(`delete from daily_tasks where "userId" = any($1)`, [ids]);
      await q(`delete from notifications where "userId" = any($1)`, [ids]);
    }
    await q(`delete from teams where name like 'TQA %'`);
    await q(`delete from users where "employeeCode" like 'TQA-%'`).catch(() => {});
  };
  await wipe();
  const mk = async (code, first, role, reportsTo) => (await q(`insert into users (id,"platformId",email,"passwordHash","firstName","lastName","employeeCode",role,status,"mustChangePassword","trackerAccessEnabled","onboardingStatus","dateOfJoining","reportsToId","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,$4,'Tqa',$5,$6,'ACTIVE',false,true,'ACTIVE','2026-01-01',$7,now(),now()) returning id`, [A, code.toLowerCase() + "@tqa.test", hash, first, code, role, reportsTo ?? null]))[0].id;
  const team = async (name, mgr) => (await q(`insert into teams (id,"platformId",name,"managerId","isActive","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,true,now(),now()) returning id`, [A, name, mgr]))[0].id;
  const login = async (code) => (await (await fetch(API + "/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: code, password: PW }) })).json()).token;

  const M1 = await mk("TQA-M1", "Manone", "MANAGER"), M2 = await mk("TQA-M2", "Mantwo", "MANAGER");
  const AD = await mk("TQA-AD", "Admin", "ADMIN"), HR = await mk("TQA-HR", "Hrp", "HR");
  const E = await mk("TQA-E", "Emp", "EMPLOYEE", M1), E2 = await mk("TQA-E2", "Emptwo", "EMPLOYEE", M1);
  const P1 = await team("TQA Alpha", M1), P2 = await team("TQA Beta", M2), P3 = await team("TQA Gamma", M1);
  const tE = await login("TQA-E"), tE2 = await login("TQA-E2"), tM1 = await login("TQA-M1"), tM2 = await login("TQA-M2"), tHR = await login("TQA-HR"), tAD = await login("TQA-AD");

  // everything that existed before (other people's tasks, ratings) must be exactly the same after
  const outsideTasks = async () => JSON.stringify(await q(`select id,title,status::text,"approvalStatus"::text,outcome::text,"reviewNote" from daily_tasks where "userId" not in (select id from users where "employeeCode" like 'TQA-%') order by id`));
  const ratingsTable = (await q(`select to_regclass('task_ratings') t`))[0].t;
  const outsideRatings = async () => (ratingsTable ? JSON.stringify(await q(`select * from task_ratings where "taskId" in (select id from daily_tasks where "userId" not in (select id from users where "employeeCode" like 'TQA-%')) order by "taskId"`)) : "");
  const beforeTasks = await outsideTasks(), beforeRatings = await outsideRatings();

  const form = (await call("GET", "/tasks", tE)).b.entryForm;
  const mgrs = form.managers.map((m) => m.id);
  ok("setup: the form offers both managers and the projects", mgrs.includes(M1) && mgrs.includes(M2) && [P1, P2, P3].every((p) => form.projects.some((x) => x.id === p)), form);
  const row = (n, project, mgr, extra = {}) => ({ key: "k" + n, title: `Quick task ${n}`, description: `detail ${n}`, teamId: project, taggedManagerId: mgr, hoursSpent: 0.5 + (n % 4), weight: ["LOW", "MEDIUM", "HIGH", "CRITICAL"][n % 4], progress: ["IN_PROGRESS", "COMPLETED", "BLOCKED"][n % 3], ...extra });

  console.log("\n## before the drafts table exists");
  const g0 = await call("GET", "/tasks/drafts", tE);
  ok("drafts say 'not ready' and nothing breaks", g0.s === 200 && g0.b.ready === false && g0.b.drafts.length === 0, g0);
  const p0 = await call("PUT", "/tasks/drafts", tE, { rows: [{ title: "x" }] });
  ok("saving a draft answers 503 FEATURES_NOT_READY", p0.s === 503, p0);
  const early = await call("POST", "/tasks/bulk", tE, { rows: [row(100, P1, M1)] });
  ok("Quick Add still sends tasks before the table exists", early.s === 200 && early.b.submitted === 1, early);
  await q(`delete from task_entry_details where "taskId" in (select id from daily_tasks where "userId" = $1)`, [E]);
  await q(`delete from daily_tasks where "userId" = $1`, [E]);
  await q(`delete from notifications where "userId" = any($1)`, [[M1, M2, HR, AD]]);

  console.log("\n## apply the migration (throwaway database only)");
  const sql = fs.readFileSync(path.join(__dirname, "..", "prisma", "migrations", "20261116100000_task_drafts", "migration.sql"), "utf8");
  await db.query(sql);
  console.log("migration applied; waiting for the server to notice");
  await sleep(16000);

  console.log("\n## single task, unchanged");
  const s1 = await call("POST", "/tasks", tE, { title: "Single task", description: "d", weight: "HIGH", progress: "IN_PROGRESS", hoursSpent: 2, teamId: P1, taggedManagerId: M1 });
  ok("single task is created (200)", s1.s === 200, s1);
  const sRow = (await q(`select t.id, t.title, t."teamId", t."approvalStatus"::text ap, d."taggedManagerId", d."hoursSpent" from daily_tasks t left join task_entry_details d on d."taskId"=t.id where t."userId"=$1 and t.title='Single task'`, [E]));
  ok("single task: one record, own project/manager/hours, waiting for approval", sRow.length === 1 && sRow[0].teamId === P1 && sRow[0].taggedManagerId === M1 && sRow[0].hoursSpent === 2 && sRow[0].ap === "PENDING", sRow);

  console.log("\n## Quick Add: 10 tasks, different projects and managers");
  const rows10 = [];
  for (let n = 1; n <= 10; n++) rows10.push(row(n, [P1, P2, P3][n % 3], n % 2 ? M1 : M2));
  const b1 = await call("POST", "/tasks/bulk", tE, { rows: rows10 });
  ok("all 10 submitted, none failed", b1.s === 200 && b1.b.submitted === 10 && b1.b.failed === 0 && b1.b.results.every((r) => r.ok), b1);
  const saved = await q(`select t.id, t.title, t.description, t."teamId", t.weight::text w, t.status::text st, t."approvalStatus"::text ap, d."taggedManagerId" mgr, d."hoursSpent" hrs, d.blocked from daily_tasks t left join task_entry_details d on d."taskId"=t.id where t."userId"=$1 and t.title like 'Quick task %' order by t.title`, [E]);
  ok("10 separate records (nothing combined)", saved.length === 10 && new Set(saved.map((r) => r.id)).size === 10, saved.length);
  let same = true; const why = [];
  for (const r of rows10) {
    const s = saved.find((x) => x.title === r.title);
    const prog = r.progress;
    const good = s && s.teamId === r.teamId && s.mgr === r.taggedManagerId && s.hrs === r.hoursSpent && s.w === r.weight && s.description === r.description && s.ap === "PENDING"
      && (prog === "COMPLETED" ? s.st === "COMPLETED" : s.st === "IN_PROGRESS") && s.blocked === (prog === "BLOCKED");
    if (!good) { same = false; why.push([r.title, s]); }
  }
  ok("every row kept its own project, manager, hours, priority, progress and details", same, why.slice(0, 2));
  ok("each result points at the record that was created", b1.b.results.every((r) => saved.some((s) => s.id === r.taskId)), b1.b.results);

  console.log("\n## each task reaches only its tagged manager");
  const m1Q = (await call("GET", "/tasks/review/queue", tM1)).b, m2Q = (await call("GET", "/tasks/review/queue", tM2)).b;
  const pend = (qq) => (qq.proposals ?? []).filter((t) => String(t.title).startsWith("Quick task ")).map((t) => t.title);
  const want = (mgr) => rows10.filter((r) => r.taggedManagerId === mgr).map((r) => r.title).sort();
  ok("manager 1 is asked about exactly his 5 tasks", JSON.stringify(pend(m1Q).sort()) === JSON.stringify(want(M1)), pend(m1Q));
  ok("manager 2 is asked about exactly his 5 tasks", JSON.stringify(pend(m2Q).sort()) === JSON.stringify(want(M2)), pend(m2Q));
  const hrQ = (await call("GET", "/tasks/review/queue", tHR)).b;
  ok("HR is asked about none and sees none while they are pending", pend(hrQ).length === 0 && !(hrQ.all ?? []).some((t) => String(t.title).startsWith("Quick task ") && t.approvalStatus === "PENDING"), pend(hrQ));
  const adQ = (await call("GET", "/tasks/review/queue", tAD)).b;
  ok("an Admin who is not tagged has nothing to decide (monitoring only)", pend(adQ).length === 0, pend(adQ));
  const noteCount = async (uid) => Number((await q(`select count(*)::int n from notifications where "userId"=$1 and type::text ilike '%TASK%'`, [uid]))[0].n);
  ok("notifications: M1 got 6 (5 quick + the single), M2 got 5, HR and Admin none", (await noteCount(M1)) === 6 && (await noteCount(M2)) === 5 && (await noteCount(HR)) === 0 && (await noteCount(AD)) === 0, [await noteCount(M1), await noteCount(M2), await noteCount(HR), await noteCount(AD)]);

  console.log("\n## individual approval and rejection");
  const t1 = saved.find((s) => s.mgr === M1 && s.title === "Quick task 1"), t2 = saved.find((s) => s.mgr === M2 && s.title === "Quick task 2"), t3 = saved.find((s) => s.mgr === M1 && s.title === "Quick task 3");
  const wrong = await call("POST", `/tasks/review/${t1.id}/approve`, tM2, { approve: true });
  ok("another manager cannot approve (403)", wrong.s === 403, wrong);
  const hrTry = await call("POST", `/tasks/review/${t1.id}/approve`, tHR, { approve: true });
  const adTry = await call("POST", `/tasks/review/${t1.id}/approve`, tAD, { approve: true });
  ok("HR and an untagged Admin cannot approve (403)", hrTry.s === 403 && adTry.s === 403, [hrTry.s, adTry.s]);
  const a1 = await call("POST", `/tasks/review/${t1.id}/approve`, tM1, { approve: true });
  const r2 = await call("POST", `/tasks/review/${t2.id}/approve`, tM2, { approve: false, rejectionNote: "Not needed today" });
  ok("the tagged managers approve one and reject another", a1.s === 200 && r2.s === 200, [a1.s, r2.s]);
  const st = Object.fromEntries((await q(`select title, "approvalStatus"::text ap from daily_tasks where "userId"=$1 and title like 'Quick task %'`, [E])).map((r) => [r.title, r.ap]));
  ok("only those two changed; the other 8 are still pending", st["Quick task 1"] === "APPROVED" && st["Quick task 2"] === "REJECTED" && Object.entries(st).filter(([, v]) => v === "PENDING").length === 8, st);
  void t3;

  console.log("\n## duplicates are refused");
  const dup = await call("POST", "/tasks/bulk", tE, { rows: [row(3, [P1, P2, P3][3 % 3], 3 % 2 ? M1 : M2, { key: "dupA" }), row(50, P1, M1, { key: "newB" })] });
  const dA = dup.b.results.find((r) => r.key === "dupA"), nB = dup.b.results.find((r) => r.key === "newB");
  ok("the same task again is refused, a new one in the same request still goes", dup.s === 200 && dA.ok === false && /already sent/i.test(dA.error) && nB.ok === true, dup);
  ok("no extra record for the duplicate", Number((await q(`select count(*)::int n from daily_tasks where "userId"=$1 and title='Quick task 3'`, [E]))[0].n) === 1, 0);
  const inReq = await call("POST", "/tasks/bulk", tE, { rows: [row(60, P2, M2, { key: "x1" }), row(60, P2, M2, { key: "x2", title: "  quick TASK 60 " })] });
  ok("two identical rows in one request: one is sent, one refused", inReq.b.submitted === 1 && inReq.b.failed === 1, inReq.b);
  const race = await Promise.all([1, 2, 3].map(() => call("POST", "/tasks/bulk", tE, { rows: [row(70, P3, M1)] })));
  ok("three identical requests at the same moment create only ONE record", race.filter((x) => x.b.submitted === 1).length === 1 && Number((await q(`select count(*)::int n from daily_tasks where "userId"=$1 and title='Quick task 70'`, [E]))[0].n) === 1, race.map((x) => x.b));
  const diffMgr = await call("POST", "/tasks/bulk", tE, { rows: [row(3, [P1, P2, P3][3 % 3], 3 % 2 ? M2 : M1, { key: "diff" })] });
  ok("same words but a different manager is a different task (allowed)", diffMgr.b.submitted === 1, diffMgr.b);
  const rej = await call("POST", "/tasks/bulk", tE, { rows: [row(2, [P1, P2, P3][2 % 3], M2, { key: "again" })] });
  ok("a REJECTED task can be sent again", rej.b.submitted === 1, rej.b);

  console.log("\n## validation: one bad row does not hurt the others");
  const before = Number((await q(`select count(*)::int n from daily_tasks where "userId"=$1`, [E]))[0].n);
  const mix = await call("POST", "/tasks/bulk", tE, { rows: [
    row(81, P1, M1, { key: "good1" }),
    row(82, P1, M1, { key: "hours", hoursSpent: 25 }),
    row(83, P1, M1, { key: "title", title: "   " }),
    row(84, null, M1, { key: "noproject", teamId: undefined }),
    row(85, P1, null, { key: "nomgr", taggedManagerId: undefined }),
    row(86, P1, HR, { key: "badmgr" }),
    row(87, P1, M1, { key: "badprog", progress: "DONE" }),
    row(88, P2, M2, { key: "good2" }),
  ] });
  const by = Object.fromEntries(mix.b.results.map((r) => [r.key, r]));
  ok("the two good rows are sent", by.good1.ok && by.good2.ok && mix.b.submitted === 2 && mix.b.failed === 6, mix.b);
  ok("each bad row says why", !by.hours.ok && /hours/i.test(by.hours.error) && !by.title.ok && !by.noproject.ok && /project/i.test(by.noproject.error) && !by.nomgr.ok && /manager/i.test(by.nomgr.error) && !by.badmgr.ok && !by.badprog.ok, mix.b.results);
  ok("only the 2 good rows became records (nothing half-saved)", Number((await q(`select count(*)::int n from daily_tasks where "userId"=$1`, [E]))[0].n) === before + 2, 0);
  const none = await call("POST", "/tasks/bulk", tE, { rows: [] });
  const many = await call("POST", "/tasks/bulk", tE, { rows: Array.from({ length: 21 }, (_, i) => row(200 + i, P1, M1)) });
  const junk = await call("POST", "/tasks/bulk", tE, { rows: "nope" });
  ok("no rows = 400, 21 rows = 400 with nothing created, junk = 400", none.s === 400 && many.s === 400 && junk.s === 400 && Number((await q(`select count(*)::int n from daily_tasks where "userId"=$1 and title like 'Quick task 2__'`, [E]))[0].n) === 0, [none.s, many.s, junk.s]);
  const anon = await call("POST", "/tasks/bulk", null, { rows: [row(1, P1, M1)] });
  ok("not signed in = 401", anon.s === 401, anon.s);
  const mgrTry = await call("POST", "/tasks/bulk", tM1, { rows: [row(300, P1, M2)] });
  ok("a manager's own self-managed tasks do not use Quick Add (403) where that mode is on", mgrTry.s === 403 || mgrTry.b.submitted === 1, mgrTry);

  console.log("\n## drafts");
  const notifBefore = [await noteCount(M1), await noteCount(M2)];
  const tasksBefore = Number((await q(`select count(*)::int n from daily_tasks where "userId"=$1`, [E]))[0].n);
  const d1 = await call("PUT", "/tasks/drafts", tE, { rows: [
    { title: "Draft one", teamId: P1, taggedManagerId: M1, hoursSpent: 1.5, weight: "HIGH", progress: "BLOCKED", description: "keep me" },
    { title: "", teamId: P2 },
    { title: "Draft three", teamId: "00000000-0000-4000-8000-000000000000", taggedManagerId: "not-a-uuid", hoursSpent: 99, weight: "WEIRD", progress: "WEIRD" },
    { title: "", description: "", hoursSpent: null },
  ] });
  ok("draft saved: empty rows skipped, 3 kept", d1.s === 200 && d1.b.ready && d1.b.drafts.length === 3, d1);
  const dr = d1.b.drafts;
  ok("draft keeps what was typed and drops what is not valid", dr[0].title === "Draft one" && dr[0].teamId === P1 && dr[0].taggedManagerId === M1 && dr[0].hoursSpent === 1.5 && dr[0].weight === "HIGH" && dr[0].progress === "BLOCKED" && dr[0].description === "keep me" && dr[2].teamId === null && dr[2].taggedManagerId === null && dr[2].hoursSpent === null && dr[2].weight === "MEDIUM" && dr[2].progress === "IN_PROGRESS", dr);
  ok("drafts are NOT tasks: no task record, no notification, nothing in a manager's queue", Number((await q(`select count(*)::int n from daily_tasks where "userId"=$1`, [E]))[0].n) === tasksBefore && (await noteCount(M1)) === notifBefore[0] && (await noteCount(M2)) === notifBefore[1] && !(JSON.stringify((await call("GET", "/tasks/review/queue", tM1)).b)).includes("Draft one") && !(JSON.stringify((await call("GET", "/tasks", tE)).b.awaitingApproval)).includes("Draft one"), 0);
  ok("drafts are private: another employee sees none, HR / manager / Admin cannot read them", (await call("GET", "/tasks/drafts", tE2)).b.drafts.length === 0 && (await call("GET", "/tasks/drafts", tHR)).b.drafts.length === 0 && (await call("GET", "/tasks/drafts", tM1)).b.drafts.length === 0, 0);
  await call("PUT", "/tasks/drafts", tE2, { rows: [{ title: "Other person draft" }] });
  const back = await call("GET", "/tasks/drafts", tE);
  ok("another person saving a draft does not touch mine", back.b.drafts.length === 3 && back.b.drafts[0].title === "Draft one" && (await call("GET", "/tasks/drafts", tE2)).b.drafts[0].title === "Other person draft", back.b);
  const edit = await call("PUT", "/tasks/drafts", tE, { rows: [{ ...dr[0], title: "Draft one (edited)" }] });
  ok("a draft stays editable (saving replaces it)", edit.b.drafts.length === 1 && edit.b.drafts[0].title === "Draft one (edited)", edit.b);
  const tooMany = await call("PUT", "/tasks/drafts", tE, { rows: Array.from({ length: 31 }, (_, i) => ({ title: "t" + i })) });
  ok("31 draft rows are refused, the saved draft is untouched", tooMany.s === 400 && (await call("GET", "/tasks/drafts", tE)).b.drafts.length === 1, tooMany);
  const sendDraft = await call("POST", "/tasks/bulk", tE, { rows: [{ ...edit.b.drafts[0], key: "fromDraft", hoursSpent: 1.5 }] });
  ok("a draft can be submitted later like any row (becomes a real, pending task)", sendDraft.b.submitted === 1 && Number((await q(`select count(*)::int n from daily_tasks where "userId"=$1 and title='Draft one (edited)'`, [E]))[0].n) === 1, sendDraft.b);
  await call("PUT", "/tasks/drafts", tE, { rows: [] });
  ok("clearing the draft leaves none", (await call("GET", "/tasks/drafts", tE)).b.drafts.length === 0 && Number((await q(`select count(*)::int n from task_drafts where "userId"=$1`, [E]))[0].n) === 0, 0);
  const bad = await call("PUT", "/tasks/drafts", tE, { rows: "x" });
  ok("a malformed draft body is a 400, not a crash", bad.s === 400, bad);

  console.log("\n## the employee's list and what was already there");
  const mine = (await call("GET", "/tasks", tE)).b;
  const listed = [...mine.awaitingApproval, ...mine.rejected, ...mine.active, ...mine.done].filter((t) => String(t.title).startsWith("Quick task "));
  ok("the employee's Daily Tasks list shows the Quick Add tasks one by one with progress and manager", listed.length >= 12 && listed.every((t) => t.taggedManager && t.progress) && new Set(listed.map((t) => t.id)).size === listed.length, listed.length);
  ok("a rejected one shows its reason; progress and approval are separate fields", (mine.rejected ?? []).some((t) => t.title === "Quick task 2" && /Not needed/.test(t.rejectionNote ?? "")) && listed.every((t) => "approvalStatus" in t && "progress" in t), mine.rejected);
  ok("other people's tasks and ratings are exactly as they were", (await outsideTasks()) === beforeTasks && (await outsideRatings()) === beforeRatings, 0);
  const aud = await q(`select summary from audit_logs where path = '/api/tasks/bulk' order by "createdAt" desc limit 1`);
  ok("the submission is in the audit log", aud.length === 1 && /Quick Add|several tasks/i.test(aud[0].summary ?? ""), aud);

  await wipe();
  await db.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
