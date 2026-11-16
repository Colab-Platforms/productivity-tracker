// Progress To Do / In Progress / Completed / Blocked, and the required Blocked reason. Progress stays separate from approval; existing tasks keep
// their stored status; the reason is visible to the tagged manager and kept in history, the audit log and the exports.
// Disposable database only (see _guard.cjs).
//
//   cd backend && TEST_DATABASE_URL=... TEST_API=http://localhost:5012/api node tests/task-progress.test.cjs
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
const PW = "Tpg@12345678";

(async () => {
  const db = new Client({ connectionString: DB }); await db.connect();
  const q = async (s, p) => (await db.query(s, p)).rows;
  const A = (await q(`select id from platforms where slug='avatar'`))[0].id;
  const TODAY_ISO = new Intl.DateTimeFormat("en-CA", { timeZone: (await q(`select timezone from platforms where id=$1`, [A]))[0].timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const hash = await bcrypt.hash(PW, 10);
  // the drafts table exists, with the ORIGINAL three-value rule (as it is on production today)
  if (!(await q(`select to_regclass('task_drafts') t`))[0].t) await db.query(fs.readFileSync(path.join(__dirname, "..", "prisma", "migrations", "20261116100000_task_drafts", "migration.sql"), "utf8"));
  await db.query(`ALTER TABLE task_drafts DROP CONSTRAINT IF EXISTS task_drafts_progress_check`);
  await db.query(`ALTER TABLE task_drafts ADD CONSTRAINT task_drafts_progress_check CHECK ("progress" IN ('COMPLETED', 'IN_PROGRESS', 'BLOCKED'))`);

  const wipe = async () => {
    const ids = (await q(`select id from users where "employeeCode" like 'TPG-%'`)).map((r) => r.id);
    if (ids.length) {
      await q(`delete from task_drafts where "userId" = any($1)`, [ids]).catch(() => {});
      await q(`delete from task_deletions where "taskId" in (select id from daily_tasks where "userId" = any($1))`, [ids]).catch(() => {});
      await q(`delete from task_ratings where "taskId" in (select id from daily_tasks where "userId" = any($1))`, [ids]).catch(() => {});
      await q(`delete from task_entry_details where "taskId" in (select id from daily_tasks where "userId" = any($1))`, [ids]).catch(() => {});
      await q(`delete from task_events where "taskId" in (select id from daily_tasks where "userId" = any($1))`, [ids]).catch(() => {});
      await q(`delete from daily_tasks where "userId" = any($1)`, [ids]);
      await q(`delete from notifications where "userId" = any($1)`, [ids]);
    }
    await q(`delete from teams where name like 'TPG %'`);
    await q(`delete from users where "employeeCode" like 'TPG-%'`).catch(() => {});
  };
  await wipe();
  const mk = async (code, first, role, reportsTo) => (await q(`insert into users (id,"platformId",email,"passwordHash","firstName","lastName","employeeCode",role,status,"mustChangePassword","trackerAccessEnabled","onboardingStatus","dateOfJoining","reportsToId","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,$4,'Tpg',$5,$6,'ACTIVE',false,true,'ACTIVE','2026-01-01',$7,now(),now()) returning id`, [A, code.toLowerCase() + "@tpg.test", hash, first, code, role, reportsTo ?? null]))[0].id;
  const team = async (name, mgr) => (await q(`insert into teams (id,"platformId",name,"managerId","isActive","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,true,now(),now()) returning id`, [A, name, mgr]))[0].id;
  const login = async (code) => (await (await fetch(API + "/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: code, password: PW }) })).json()).token;
  const M1 = await mk("TPG-M1", "Manone", "MANAGER"), M2 = await mk("TPG-M2", "Mantwo", "MANAGER");
  const AD = await mk("TPG-AD", "Admin", "ADMIN"), HR = await mk("TPG-HR", "Hrp", "HR");
  const E = await mk("TPG-E", "Empone", "EMPLOYEE", M1), E2 = await mk("TPG-E2", "Emptwo", "EMPLOYEE", M1);
  const P1 = await team("TPG Alpha", M1), P2 = await team("TPG Beta", M2);
  const tE = await login("TPG-E"), tE2 = await login("TPG-E2"), tM1 = await login("TPG-M1"), tM2 = await login("TPG-M2"), tHR = await login("TPG-HR"), tAD = await login("TPG-AD");

  const outside = async () => JSON.stringify(await q(`select t.id, t.title, t.status::text st, t."approvalStatus"::text ap, t."completedAt", d.blocked, d."blockedNote" from daily_tasks t left join task_entry_details d on d."taskId"=t.id where t."userId" not in (select id from users where "employeeCode" like 'TPG-%') order by t.id`));
  const beforeOutside = await outside();
  const row = async (id) => (await q(`select t.status::text st, t."approvalStatus"::text ap, t."completedAt" ca, d.blocked, d."blockedNote" note, t.title from daily_tasks t left join task_entry_details d on d."taskId"=t.id where t.id=$1`, [id]))[0];
  const post = async (title, progress, extra = {}) => {
    const r = await call("POST", "/tasks", tE, { title, weight: "MEDIUM", progress, hoursSpent: 1, teamId: P1, taggedManagerId: M1, ...extra });
    const id = r.s === 200 ? (await q(`select id from daily_tasks where title=$1 and "userId"=$2`, [title, E]))[0]?.id : null;
    return { r, id };
  };
  const events = async (id) => await q(`select kind, note from task_events where "taskId"=$1 order by "createdAt", id`, [id]);

  console.log("\n## To Do exists, is stored as not-started, and is separate from approval");
  const todo = await post("Plan the sprint", "TODO");
  ok("a task can be sent as To Do (no reason needed)", todo.r.s === 200 && todo.id, todo.r);
  const t1 = await row(todo.id);
  ok("it is stored as the existing not-started status (PENDING), not blocked; approval is separately Pending", t1.st === "PENDING" && t1.blocked === false && t1.ap === "PENDING" && t1.ca === null, t1);
  const emp1 = (await call("GET", "/tasks", tE)).b;
  const mine = [...emp1.awaitingApproval, ...emp1.active, ...emp1.rejected, ...emp1.done].find((t) => t.id === todo.id);
  ok("the employee's list says progress To Do and approval Pending (two separate fields)", mine && mine.progress === "TODO" && mine.approvalStatus === "PENDING", mine);
  const pTodo = await post("Plain default", undefined);
  ok("a task sent with no progress is still accepted (unchanged behaviour)", pTodo.r.s === 200, pTodo.r);
  const bad = await call("POST", "/tasks", tE, { title: "Old name", progress: "NOT_STARTED", teamId: P1, taggedManagerId: M1 });
  ok("the old name NOT_STARTED is not an accepted value", bad.s === 400, bad);

  console.log("\n## Blocked needs a reason");
  const b0 = await call("POST", "/tasks", tE, { title: "Blocked no reason", progress: "BLOCKED", teamId: P1, taggedManagerId: M1, hoursSpent: 1 });
  const b1 = await call("POST", "/tasks", tE, { title: "Blocked short", progress: "BLOCKED", blockedNote: "ab", teamId: P1, taggedManagerId: M1 });
  const b2 = await call("POST", "/tasks", tE, { title: "Blocked blanks", progress: "BLOCKED", blockedNote: "     ", teamId: P1, taggedManagerId: M1 });
  const b3 = await call("POST", "/tasks", tE, { title: "Blocked long", progress: "BLOCKED", blockedNote: "x".repeat(501), teamId: P1, taggedManagerId: M1 });
  ok("Blocked without a reason, with 2 characters, with blanks, or over 500 characters is refused (400) and nothing is saved", [b0, b1, b2, b3].every((r) => r.s === 400) && (await q(`select count(*)::int n from daily_tasks where title like 'Blocked %' and "userId"=$1`, [E]))[0].n === 0, [b0.s, b1.s, b2.s, b3.s]);
  ok("the message says what to do", /blocking/i.test(b0.b.error ?? ""), b0.b);
  const blk = await post("Wait for CRM access", "BLOCKED", { blockedNote: "  No access to the client CRM yet  " });
  const rb = await row(blk.id);
  ok("with a reason it is saved: unfinished (In Progress) + blocked flag + the trimmed reason", rb.st === "IN_PROGRESS" && rb.blocked === true && rb.note === "No access to the client CRM yet", rb);
  const other = await post("Reason ignored", "IN_PROGRESS", { blockedNote: "should not be kept" });
  ok("a reason sent with another progress is not kept", (await row(other.id)).note === null && (await row(other.id)).blocked === false);

  console.log("\n## changing progress later");
  const noReason = await call("PATCH", `/tasks/${todo.id}`, tE, { progress: "BLOCKED" });
  ok("switching To Do to Blocked without a reason is refused and the task is unchanged", noReason.s === 400 && (await row(todo.id)).st === "PENDING" && (await row(todo.id)).blocked === false, noReason);
  const toBlock = await call("PATCH", `/tasks/${todo.id}`, tE, { progress: "BLOCKED", blockedNote: "Waiting for the design team" });
  ok("with a reason it becomes Blocked", toBlock.s === 200 && (await row(todo.id)).blocked === true && (await row(todo.id)).note === "Waiting for the design team", toBlock);
  const edit1 = await call("PATCH", `/tasks/${todo.id}`, tE, { blockedNote: "Waiting for the final design" });
  const edit2 = await call("PATCH", `/tasks/${todo.id}`, tE, { blockedNote: "" });
  ok("the reason of a blocked task can be reworded but never emptied", edit1.s === 200 && edit2.s === 400 && (await row(todo.id)).note === "Waiting for the final design", [edit1.s, edit2.s]);
  const hrs = await call("PATCH", `/tasks/${todo.id}`, tE, { hoursSpent: 3 });
  ok("changing only the hours keeps the reason", hrs.s === 200 && (await row(todo.id)).note === "Waiting for the final design", hrs);
  const toProg = await call("PATCH", `/tasks/${todo.id}`, tE, { progress: "IN_PROGRESS" });
  ok("Blocked to In Progress clears the reason and the flag", toProg.s === 200 && (await row(todo.id)).blocked === false && (await row(todo.id)).note === null && (await row(todo.id)).st === "IN_PROGRESS", await row(todo.id));
  const toDone = await call("PATCH", `/tasks/${todo.id}`, tE, { progress: "COMPLETED" });
  ok("In Progress to Completed sets the completion time", toDone.s === 200 && (await row(todo.id)).st === "COMPLETED" && (await row(todo.id)).ca !== null, await row(todo.id));
  const back = await call("PATCH", `/tasks/${todo.id}`, tE, { progress: "TODO" });
  ok("Completed back to To Do clears the completion time (stored not-started again)", back.s === 200 && (await row(todo.id)).st === "PENDING" && (await row(todo.id)).ca === null && (await row(todo.id)).ap === "PENDING", await row(todo.id));
  ok("none of those progress changes touched the approval status", (await row(todo.id)).ap === "PENDING");

  console.log("\n## history and audit");
  const ev = await events(todo.id);
  ok("the task history starts with how it was submitted and lists every progress change", ev.length >= 6 && ev[0].kind === "CREATED" && /Submitted as To Do/.test(ev[0].note) && ev.some((e) => /To Do -> Blocked\. Blocked reason: Waiting for the design team/.test(e.note ?? "")) && ev.some((e) => /Blocked -> In Progress/.test(e.note ?? "")) && ev.some((e) => /In Progress -> Completed/.test(e.note ?? "")) && ev.some((e) => /Completed -> To Do/.test(e.note ?? "")), ev);
  ok("a reworded reason is also in the history", ev.some((e) => /Blocked reason: Waiting for the final design/.test(e.note ?? "")), ev.map((e) => e.note));
  const evBlk = await events(blk.id);
  ok("a task sent as Blocked records the reason from the start", evBlk.length === 1 && /Submitted as Blocked\. Blocked reason: No access to the client CRM yet/.test(evBlk[0].note), evBlk);
  const hist = await call("GET", `/tasks/${todo.id}/history`, tE);
  ok("the employee can read the history of their own task", hist.s === 200 && hist.b.events.length === ev.length, hist.s);
  ok("another employee cannot (404)", (await call("GET", `/tasks/${todo.id}/history`, tE2)).s === 404);
  const aud = await q(`select summary, before, after from audit_logs where path = $1 and summary like 'Changed the progress%' order by "createdAt"`, [`/api/tasks/${todo.id}`]);
  ok("the audit log has a line per progress change with before and after (reason included)", aud.length >= 5 && aud.some((a) => a.after?.progress === "BLOCKED" && a.after?.blockedReason === "Waiting for the design team" && a.before?.progress === "TODO"), aud.map((a) => a.summary));

  console.log("\n## the manager sees it");
  const queue = (await call("GET", "/tasks/review/queue", tM1)).b;
  const qb = (queue.all ?? []).find((t) => t.id === blk.id);
  ok("the tagged manager's row says Blocked, with the employee's reason, and approval is its own field", qb && qb.progress === "BLOCKED" && qb.blockedNote === "No access to the client CRM yet" && qb.approvalStatus === "PENDING" && qb.canAct === true, qb);
  const q2 = (await call("GET", "/tasks/review/queue", tM2)).b;
  ok("another manager does not see that pending task or its reason", !(q2.all ?? []).some((t) => t.id === blk.id), 0);
  ok("HR does not see it while it waits for the manager (unchanged rule)", !((await call("GET", "/tasks/review/queue", tHR)).b.all ?? []).some((t) => t.id === blk.id));
  const qt = await post("Planned item", "TODO");
  const qrow = ((await call("GET", "/tasks/review/queue", tM1)).b.all ?? []).find((t) => t.id === qt.id);
  ok("a To Do task shows as To Do in the manager's queue", qrow && qrow.progress === "TODO", qrow);
  const ap = await call("POST", `/tasks/review/${qt.id}/approve`, tM1, { approve: true });
  const qrow2 = ((await call("GET", "/tasks/review/queue", tM1)).b.all ?? []).find((t) => t.id === qt.id);
  ok("approving it leaves the progress as To Do (the approval workflow is unchanged)", ap.s === 200 && qrow2.progress === "TODO" && qrow2.approvalStatus === "APPROVED" && (await row(qt.id)).st === "PENDING", qrow2);
  const hrQ = ((await call("GET", "/tasks/review/queue", tHR)).b.all ?? []).find((t) => t.id === qt.id);
  ok("after approval HR and the team see To Do too", hrQ && hrQ.progress === "TODO", hrQ);

  console.log("\n## Quick Add");
  const bulk = await call("POST", "/tasks/bulk", tE, { rows: [
    { key: "a", title: "Q todo", teamId: P1, taggedManagerId: M1, progress: "TODO", hoursSpent: 1, weight: "LOW" },
    { key: "b", title: "Q prog", teamId: P1, taggedManagerId: M1, progress: "IN_PROGRESS", hoursSpent: 1, weight: "LOW" },
    { key: "c", title: "Q done", teamId: P2, taggedManagerId: M2, progress: "COMPLETED", hoursSpent: 1, weight: "LOW" },
    { key: "d", title: "Q blocked", teamId: P1, taggedManagerId: M1, progress: "BLOCKED", blockedNote: "Needs the API key", hoursSpent: 1, weight: "LOW" },
    { key: "e", title: "Q blocked no reason", teamId: P1, taggedManagerId: M1, progress: "BLOCKED", hoursSpent: 1, weight: "LOW" },
  ] });
  const br = Object.fromEntries(bulk.b.results.map((r) => [r.key, r]));
  ok("four progress values go through; the Blocked row without a reason fails alone with a clear message", bulk.b.submitted === 4 && br.a.ok && br.b.ok && br.c.ok && br.d.ok && !br.e.ok && /blocking/i.test(br.e.error), bulk.b);
  const bq = await q(`select t.title, t.status::text st, d.blocked, d."blockedNote" note from daily_tasks t join task_entry_details d on d."taskId"=t.id where t.title like 'Q %' and t."userId"=$1 order by t.title`, [E]);
  ok("each row saved with its own progress and reason", bq.length === 4 && bq.find((x) => x.title === "Q todo").st === "PENDING" && bq.find((x) => x.title === "Q blocked").note === "Needs the API key" && bq.find((x) => x.title === "Q blocked").blocked === true && bq.find((x) => x.title === "Q prog").note === null, bq);

  console.log("\n## existing tasks keep their stored status");
  const legacyId = async (title, status, blocked, note) => {
    const id = (await q(`insert into daily_tasks (id,"platformId","userId",date,title,weight,status,"approvalStatus","approvedById","approvedAt","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,current_date,$3,'MEDIUM',$4,'APPROVED',$5,now(),now(),now()) returning id`, [A, E2, title, status, M1]))[0].id;
    if (blocked !== null) await q(`insert into task_entry_details (id,"platformId","taskId","taggedManagerId",blocked,"blockedNote","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,$4,$5,now(),now())`, [A, id, M1, blocked, note]);
    return id;
  };
  const L1 = await legacyId("Legacy never started", "PENDING", null, null);
  const L2 = await legacyId("Legacy in progress", "IN_PROGRESS", false, null);
  const L3 = await legacyId("Legacy blocked no reason", "IN_PROGRESS", true, null);
  const snap = async () => JSON.stringify(await q(`select t.id, t.status::text st, t."approvalStatus"::text ap, d.blocked, d."blockedNote" from daily_tasks t left join task_entry_details d on d."taskId"=t.id where t.id = any($1) order by t.id`, [[L1, L2, L3]]));
  const s0 = await snap();
  const list = (await call("GET", "/tasks", tE2)).b;
  const lv = Object.fromEntries([...list.awaitingApproval, ...list.active, ...list.rejected, ...list.done].map((t) => [t.id, t]));
  ok("a legacy not-started task reads To Do, a legacy in-progress reads In Progress, a legacy blocked one reads Blocked (reason empty)", lv[L1].progress === "TODO" && lv[L2].progress === "IN_PROGRESS" && lv[L3].progress === "BLOCKED" && lv[L3].blockedNote === null, [lv[L1]?.progress, lv[L2]?.progress, lv[L3]?.progress]);
  const mq = ((await call("GET", "/tasks/review/queue", tM1)).b.all ?? []);
  ok("the manager sees the same, and the legacy blocked task has no invented reason", mq.find((t) => t.id === L1).progress === "TODO" && mq.find((t) => t.id === L3).progress === "BLOCKED" && mq.find((t) => t.id === L3).blockedNote === null);
  ok("reading everything did not change a single stored value", (await snap()) === s0, 0);
  const hrsLegacy = await call("PATCH", `/tasks/${L3}`, tE2, { hoursSpent: 2 });
  ok("editing only the hours of a legacy blocked task is still allowed (no reason is forced onto it)", hrsLegacy.s === 200 && (await row(L3)).blocked === true, hrsLegacy);
  const reBlock = await call("PATCH", `/tasks/${L2}`, tE2, { progress: "BLOCKED" });
  ok("but switching a task to Blocked always asks for a reason", reBlock.s === 400, reBlock);

  console.log("\n## reports and exports");
  const prod = (await call("GET", `/team-attendance/productivity/tasks?from=${TODAY_ISO}&to=${TODAY_ISO}`, tM1)).b.tasks ?? [];
  const pby = (title) => prod.find((t) => t.title === title);
  // "Q done" is tagged to the OTHER manager: while it waits for approval it is in that manager's queue, not in this manager's export.
  const q2done = ((await call("GET", "/tasks/review/queue", tM2)).b.all ?? []).find((t) => t.title === "Q done");
  ok("the task export rows say To Do / In Progress / Blocked (and Completed in the other manager's queue)", pby("Q todo")?.progress === "TODO" && pby("Q prog")?.progress === "IN_PROGRESS" && q2done?.progress === "COMPLETED" && !pby("Q done") && pby("Q blocked")?.progress === "BLOCKED" && pby("Legacy never started")?.progress === "TODO", prod.map((t) => [t.title, t.progress]));
  ok("only Blocked rows carry the reason (as written); a legacy blocked row has none", pby("Q blocked")?.blockedReason === "Needs the API key" && pby("Q todo")?.blockedReason === null && pby("Q prog")?.blockedReason === null && pby("Legacy blocked no reason")?.blockedReason === null, [pby("Q blocked")?.blockedReason, pby("Q todo")?.blockedReason]);
  const range = (await call("GET", `/tasks/range?from=${TODAY_ISO}&to=${TODAY_ISO}`, tE)).b.tasks;
  const rg = Object.fromEntries(range.map((t) => [t.title, t]));
  ok("the employee's date view carries progress and the reason", rg["Q blocked"]?.progress === "BLOCKED" && rg["Q blocked"]?.blockedNote === "Needs the API key" && rg["Q todo"]?.progress === "TODO", [rg["Q blocked"]?.progress]);
  ok("reports that read tasks still load", (await call("GET", `/reports?from=${TODAY_ISO}&to=${TODAY_ISO}`, tM1)).s === 200 && (await call("GET", `/team-attendance/team-report?from=${TODAY_ISO}&to=${TODAY_ISO}`, tM1)).s === 200);

  console.log("\n## a rated task cannot change progress (unchanged rule)");
  const done = await post("Rated one", "COMPLETED");
  await call("POST", `/tasks/review/${done.id}/approve`, tM1, { approve: true });
  const rate = await call("POST", `/tasks/review/${done.id}/rating`, tM1, { rating: 5, comment: "great" });
  const tryChange = await call("PATCH", `/tasks/${done.id}`, tE, { progress: "TODO" });
  ok("a rated task is protected and keeps its status, rating and comment", rate.s === 200 && tryChange.s === 409 && (await row(done.id)).st === "COMPLETED", [rate.s, tryChange.s]);

  console.log("\n## drafts and the To Do value");
  const keep = await call("PUT", "/tasks/drafts", tE, { rows: [{ title: "Draft kept", progress: "IN_PROGRESS" }] });
  ok("a draft with the three old values saves", keep.s === 200 && keep.b.drafts.length === 1, keep);
  const dTodo = await call("PUT", "/tasks/drafts", tE, { rows: [{ title: "Draft a", progress: "TODO" }, { title: "Draft b", progress: "BLOCKED" }] });
  ok("BEFORE the drafts migration: a draft holding To Do answers a clear message (409) and the saved draft is untouched", dTodo.s === 409 && /database update/i.test(dTodo.b.error ?? "") && (await call("GET", "/tasks/drafts", tE)).b.drafts.map((d) => d.title).join() === "Draft kept", dTodo);
  const dBlocked = await call("PUT", "/tasks/drafts", tE, { rows: [{ title: "Draft b", progress: "BLOCKED" }] });
  ok("a Blocked draft saves (the reason is not stored in a draft)", dBlocked.s === 200 && dBlocked.b.drafts[0].progress === "BLOCKED", dBlocked);
  await db.query(fs.readFileSync(path.join(__dirname, "..", "prisma", "migrations", "20261117100000_task_drafts_allow_todo", "migration.sql"), "utf8"));
  const dTodo2 = await call("PUT", "/tasks/drafts", tE, { rows: [{ title: "Draft a", progress: "TODO" }, { title: "Draft b", progress: "BLOCKED" }, { title: "Draft c", progress: "COMPLETED" }] });
  ok("AFTER the migration: a draft with To Do saves and reopens with To Do", dTodo2.s === 200 && dTodo2.b.drafts.map((d) => d.progress).join() === "TODO,BLOCKED,COMPLETED" && (await call("GET", "/tasks/drafts", tE)).b.drafts[0].progress === "TODO", dTodo2);
  await db.query(fs.readFileSync(path.join(__dirname, "..", "prisma", "migrations", "20261117100000_task_drafts_allow_todo", "down.sql"), "utf8"));
  ok("the down script restores the old rule (and turns any To Do draft into In Progress first)", (await q(`select count(*)::int n from task_drafts where progress='TODO'`))[0].n === 0, 0);
  await db.query(fs.readFileSync(path.join(__dirname, "..", "prisma", "migrations", "20261117100000_task_drafts_allow_todo", "migration.sql"), "utf8"));

  console.log("\n## nothing else changed");
  ok("other people's tasks (status, approval, blocked flag and reason) are exactly as they were", (await outside()) === beforeOutside, 0);
  await wipe();
  await db.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
