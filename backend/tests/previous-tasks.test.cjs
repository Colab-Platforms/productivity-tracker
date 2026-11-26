// A manager's "Previous tasks" notebook over real HTTP against the throwaway test backend (5012) and DB:
//   TEST_DATABASE_URL=postgresql://postgres:localtest@localhost:54329/dq_test TEST_API=http://localhost:5012/api node tests/previous-tasks.test.cjs
// Proves: add / edit / delete rules, owner-only, role limits, and above all SEPARATION: the entries live in daily_tasks (marked carryCount = -1) yet change
// nothing anywhere else (employee lists, approval queue, Reports, productivity, efficiency, history, assigned tasks), and no task action can reach them.
const { Client } = require("pg");
const bcrypt = require("bcryptjs");
require("./_guard.cjs");
const API = process.env.TEST_API || "http://localhost:5012/api";
const call = async (m, p, t, b) => {
  const r = await fetch(API + p, { method: m, headers: { "content-type": "application/json", ...(t ? { authorization: "Bearer " + t } : {}) }, body: b !== undefined ? JSON.stringify(b) : undefined });
  const txt = await r.text(); let j; try { j = JSON.parse(txt); } catch { j = txt; }
  return { s: r.status, b: j };
};
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  -> " + String(JSON.stringify(x)).slice(0, 300))); };
const PW = "Prv@12345678";
const VOLATILE = /^(generatedAt|serverTime|serverNow|now|today|updatedAt|time|at)$/;
const clean = (v) => Array.isArray(v) ? v.map(clean) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).filter(([k]) => !VOLATILE.test(k)).map(([k, x]) => [k, clean(x)])) : v;
const same = (a, b) => JSON.stringify(clean(a)) === JSON.stringify(clean(b));
const firstDiff = (a, b, path = "") => { a = clean(a); b = clean(b); if (JSON.stringify(a) === JSON.stringify(b)) return null; if (a && b && typeof a === "object" && typeof b === "object") { for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) { const d = firstDiff(a[k], b[k], path + "." + k); if (d) return d; } } return path + ": " + JSON.stringify(a)?.slice(0, 60) + " vs " + JSON.stringify(b)?.slice(0, 60); };

(async () => {
  const db = new Client({ connectionString: process.env.TEST_DATABASE_URL }); await db.connect();
  const q = async (s, p) => (await db.query(s, p)).rows;
  const A = (await q(`select id from platforms where slug='avatar'`))[0].id;
  const hash = await bcrypt.hash(PW, 10);
  const wipe = async () => {
    await q(`delete from daily_tasks where "userId" in (select id from users where "employeeCode" like 'PRV-%')`).catch(() => {});
    await q(`update audit_logs set "actorId"=null where "actorId" in (select id from users where "employeeCode" like 'PRV-%')`).catch(() => {});
    await q(`delete from notifications where "userId" in (select id from users where "employeeCode" like 'PRV-%')`).catch(() => {});
    await q(`delete from login_events where "employeeCode" like 'PRV-%'`).catch(() => {});
    await q(`delete from company_access where "userId" in (select id from users where "employeeCode" like 'PRV-%')`).catch(() => {});
    await q(`delete from users where "employeeCode" like 'PRV-%'`).catch((e) => console.log("cleanup:", e.message.slice(0, 90)));
  };
  await wipe();
  const mk = async (code, role, boss = null) => (await q(`insert into users (id,"platformId",email,"passwordHash","firstName","lastName","employeeCode",role,status,"mustChangePassword","trackerAccessEnabled","onboardingStatus","reportsToId","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,'Prv',$4,$4,$5,'ACTIVE',false,true,'ACTIVE',$6,now(),now()) returning id`, [A, code.toLowerCase() + "@prv.test", hash, code, role, boss]))[0].id;
  const adm = await mk("PRV-ADM", "ADMIN"); await q(`insert into company_access (id,"userId","platformId","createdAt") values (gen_random_uuid(),$1,null,now())`, [adm]);
  const m1 = await mk("PRV-M1", "MANAGER", adm), m2 = await mk("PRV-M2", "MANAGER", adm), hr = await mk("PRV-HR", "HR"), emp = await mk("PRV-E", "EMPLOYEE", m1);
  const tok = {};
  for (const c of ["ADM", "M1", "M2", "HR", "E"]) tok[c] = (await call("POST", "/auth/login", null, { email: "PRV-" + c, password: PW })).b.token;
  // an ordinary, already-existing task record: the employee's approved + completed task, dated the company's real TODAY so the default lists show it
  const today0 = (await call("GET", "/tasks/previous", tok.M1)).b.today;
  await q(`insert into daily_tasks (id,"platformId","userId",date,title,weight,status,"approvalStatus","approvedById","approvedAt","completedAt","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$4::date,'Employee regular task','MEDIUM','COMPLETED','APPROVED',$3,now(),now(),now(),now())`, [A, emp, m1, today0]);
  const DAY = "2026-01-01", TO = "2026-12-31";
  const snap = async () => ({
    mTasks: (await call("GET", "/tasks", tok.M1)).b,
    empTasks: (await call("GET", "/tasks", tok.E)).b,
    queueM1: (await call("GET", "/tasks/review/queue", tok.M1)).b,
    queueHR: (await call("GET", "/tasks/review/queue", tok.HR)).b,
    queueADM: (await call("GET", "/tasks/review/queue", tok.ADM)).b,
    selfSummary: (await call("GET", `/tasks/self/summary?from=${DAY}&to=${TO}`, tok.M1)).b,
    reportsM1: (await call("GET", `/reports?from=${DAY}&to=${TO}`, tok.M1)).b,
    reportsHR: (await call("GET", `/reports?from=${DAY}&to=${TO}`, tok.HR)).b,
    reportsADM: (await call("GET", `/reports?from=${DAY}&to=${TO}`, tok.ADM)).b,
    prodHR: (await call("GET", `/team-attendance/productivity?from=${DAY}&to=${TO}`, tok.HR)).b,
    prodTasksHR: (await call("GET", `/team-attendance/productivity/tasks?from=${DAY}&to=${TO}`, tok.HR)).b,
    effHR: (await call("GET", `/team-attendance/efficiency?from=${DAY}&to=${TO}`, tok.HR)).b,
    histM1: (await call("GET", `/tracker/history?from=${DAY}&to=${TO}`, tok.M1)).b,
    asgMine: (await call("GET", "/tasks/assigned/mine", tok.M1)).b,
    asgBy: (await call("GET", "/tasks/assigned/by-me", tok.M1)).b,
    empRange: (await call("GET", `/tasks/range?from=${DAY}&to=${TO}`, tok.E)).b,
  });
  const regularRows = async () => q(`select id, title, status, "approvalStatus", "assignedById", "carryCount", to_char("updatedAt",'YYYY-MM-DD HH24:MI:SS.US') u from daily_tasks where "carryCount" >= 0 order by id`);

  console.log("\n## before adding anything");
  const empty = await call("GET", "/tasks/previous", tok.M1);
  ok("a manager's list starts empty and returns the company's today", empty.s === 200 && empty.b.entries.length === 0 && /^\d{4}-\d{2}-\d{2}$/.test(empty.b.today), empty);
  const today = empty.b.today;
  const before = await snap(); const rowsBefore = await regularRows();
  ok("baseline captured (queue, reports, productivity, efficiency, history, assigned)", Object.values(before).every((x) => x !== undefined), Object.keys(before).filter((k) => before[k] === undefined));

  console.log("\n## adding");
  const a1 = await call("POST", "/tasks/previous", tok.M1, { title: "  Launched vendor portal  ", description: "Led the rollout.\nTwo vendors onboarded.", completedOn: "2026-03-10" });
  ok("a manager adds a previous task (title trimmed, description kept)", a1.s === 201 && a1.b.title === "Launched vendor portal" && a1.b.description.includes("Two vendors") && a1.b.completedOn === "2026-03-10", a1);
  const a2 = await call("POST", "/tasks/previous", tok.M1, { title: "Closed audit findings", completedOn: today });
  ok("today is allowed; description is optional", a2.s === 201 && a2.b.description === "" && a2.b.completedOn === today, a2);
  const a3 = await call("POST", "/tasks/previous", tok.M1, { title: "Migrated old reports", description: "", completedOn: "2025-11-30" });
  ok("an old date is allowed (no age limit)", a3.s === 201, a3);
  const list = await call("GET", "/tasks/previous", tok.M1);
  ok("the list shows all three, newest completion date first", list.b.entries.map((e) => e.completedOn).join() === [today, "2026-03-10", "2025-11-30"].join(), list.b.entries.map((e) => e.completedOn));
  const stolen = await call("POST", "/tasks/previous", tok.M1, { title: "Owner comes from the sign-in", completedOn: "2026-02-02", userId: m2, platformId: "00000000-0000-0000-0000-000000000000" });
  const owner = (await q(`select "userId" from daily_tasks where id=$1`, [stolen.b.id]))[0];
  ok("a userId / platformId in the body is ignored: it is saved under the signed-in manager", stolen.s === 201 && owner.userId === m1, owner);
  const dbRow = (await q(`select status, "approvalStatus", "assignedById", "carryCount", weight, outcome, "teamId" from daily_tasks where id=$1`, [a1.b.id]))[0];
  ok("stored as one completed, self-approved record marked carryCount -1, not assigned, no project, no rating/outcome", dbRow.status === "COMPLETED" && dbRow.approvalStatus === "APPROVED" && dbRow.assignedById === null && dbRow.carryCount === -1 && dbRow.outcome === null && dbRow.teamId === null, dbRow);
  ok("another manager sees none of it", (await call("GET", "/tasks/previous", tok.M2)).b.entries.length === 0);

  console.log("\n## validation");
  const bad = async (body, code, label) => { const r = await call("POST", "/tasks/previous", tok.M1, body); ok(label, r.s === 400 && typeof r.b.error === "string" && !/Something went wrong/.test(r.b.error), r); };
  await bad({ completedOn: "2026-03-10" }, 400, "missing title is refused with a readable message");
  await bad({ title: "ab", completedOn: "2026-03-10" }, 400, "a 2-character title is refused");
  await bad({ title: "x".repeat(121), completedOn: "2026-03-10" }, 400, "a 121-character title is refused");
  await bad({ title: "Fine title", description: "y".repeat(1001), completedOn: "2026-03-10" }, 400, "a 1001-character description is refused");
  await bad({ title: "Fine title" }, 400, "a missing completion date is refused");
  await bad({ title: "Fine title", completedOn: "2999-01-01" }, 400, "a future date is refused");
  const tomorrow = new Date(Date.parse(today + "T00:00:00Z") + 86400000).toISOString().slice(0, 10);
  await bad({ title: "Fine title", completedOn: tomorrow }, 400, "tomorrow is refused");
  await bad({ title: "Fine title", completedOn: "2026-02-30" }, 400, "an impossible calendar day is refused");
  await bad({ title: "Fine title", completedOn: "10/03/2026" }, 400, "a non-ISO date is refused");
  await bad({ title: ["a", "b"], completedOn: "2026-03-10" }, 400, "a non-text title is refused");
  await bad({ title: "Fine title", description: 5, completedOn: "2026-03-10" }, 400, "a non-text description is refused");
  ok("nothing was saved by the refused requests", (await call("GET", "/tasks/previous", tok.M1)).b.entries.length === 4);

  console.log("\n## editing");
  const e1 = await call("PATCH", `/tasks/previous/${a1.b.id}`, tok.M1, { title: "Launched vendor portal v2", description: "Updated note", completedOn: "2026-03-12" });
  ok("title, description and date can all be edited", e1.s === 200 && e1.b.title === "Launched vendor portal v2" && e1.b.description === "Updated note" && e1.b.completedOn === "2026-03-12", e1);
  const e2 = await call("PATCH", `/tasks/previous/${a1.b.id}`, tok.M1, { description: "" });
  ok("a single field can be changed (description cleared), the rest stays", e2.s === 200 && e2.b.description === "" && e2.b.title === "Launched vendor portal v2" && e2.b.completedOn === "2026-03-12", e2);
  ok("an empty edit is refused", (await call("PATCH", `/tasks/previous/${a1.b.id}`, tok.M1, {})).s === 400);
  ok("editing to a future date is refused", (await call("PATCH", `/tasks/previous/${a1.b.id}`, tok.M1, { completedOn: tomorrow })).s === 400);
  ok("editing to a bad title is refused", (await call("PATCH", `/tasks/previous/${a1.b.id}`, tok.M1, { title: " a " })).s === 400);
  const afterBad = (await call("GET", "/tasks/previous", tok.M1)).b.entries.find((e) => e.id === a1.b.id);
  ok("the refused edits changed nothing", afterBad.title === "Launched vendor portal v2" && afterBad.completedOn === "2026-03-12", afterBad);
  ok("another manager cannot edit it (404)", (await call("PATCH", `/tasks/previous/${a1.b.id}`, tok.M2, { title: "Hijacked" })).s === 404);
  ok("an unknown id is 404", (await call("PATCH", `/tasks/previous/00000000-0000-0000-0000-000000000000`, tok.M1, { title: "Whatever" })).s === 404);
  ok("a bad id is 404, not a 500", (await call("PATCH", `/tasks/previous/not-a-uuid`, tok.M1, { title: "Whatever" })).s === 404);

  console.log("\n## who may use it");
  for (const [who, t] of [["employee", tok.E], ["HR", tok.HR], ["Admin", tok.ADM]]) {
    const r = [await call("GET", "/tasks/previous", t), await call("POST", "/tasks/previous", t, { title: "Nope nope", completedOn: "2026-03-10" }), await call("PATCH", `/tasks/previous/${a2.b.id}`, t, { title: "Nope nope" }), await call("DELETE", `/tasks/previous/${a2.b.id}`, t)];
    ok(`${who} is refused on all four routes (403)`, r.every((x) => x.s === 403), r.map((x) => x.s));
  }
  ok("no token = 401", (await call("GET", "/tasks/previous", null)).s === 401);
  ok("the previous tasks are untouched by those refusals", (await call("GET", "/tasks/previous", tok.M1)).b.entries.length === 4);

  console.log("\n## SEPARATION: nothing else changed");
  const after = await snap();
  for (const k of Object.keys(before)) ok(`${k} is identical before and after adding four previous tasks`, same(before[k], after[k]), firstDiff(before[k], after[k]));
  const rowsAfter = await regularRows();
  ok("every ordinary task record is byte-for-byte unchanged (same rows, same updatedAt)", JSON.stringify(rowsBefore) === JSON.stringify(rowsAfter), { b: rowsBefore.length, a: rowsAfter.length });
  ok("the employee's task records are untouched", (await q(`select count(*)::int n from daily_tasks where "userId"=$1`, [emp]))[0].n === 1);
  const sessions = await q(`select count(*)::int n from task_work_sessions where "taskId" = any($1::uuid[])`, [[a1.b.id, a2.b.id, a3.b.id]]).catch(() => [{ n: 0 }]);
  ok("no task timer session was started for them", sessions[0].n === 0, sessions);
  ok("no notification was created", (await q(`select count(*)::int n from notifications where "userId" in ($1,$2,$3,$4,$5)`, [m1, m2, hr, adm, emp]))[0].n === 0);

  console.log("\n## no task action can reach a previous task");
  const id = a2.b.id;
  const snapRow = async () => (await q(`select title, status, "approvalStatus", outcome, "reviewedAt", "completedAt", description, date::text d from daily_tasks where id=$1`, [id]))[0];
  const row0 = JSON.stringify(await snapRow());
  const attempts = [];
  for (const [who, t] of [["M1", tok.M1], ["M2", tok.M2], ["HR", tok.HR], ["ADM", tok.ADM], ["E", tok.E]]) {
    attempts.push([`${who} PATCH /tasks/:id`, await call("PATCH", `/tasks/${id}`, t, { progress: "IN_PROGRESS" })]);
    attempts.push([`${who} DELETE /tasks/:id`, await call("DELETE", `/tasks/${id}`, t)]);
    attempts.push([`${who} POST /tasks/:id/edit`, await call("POST", `/tasks/${id}/edit`, t, { title: "Edited elsewhere" })]);
    attempts.push([`${who} approve`, await call("POST", `/tasks/review/${id}/approve`, t, { approve: true })]);
    attempts.push([`${who} rating`, await call("POST", `/tasks/review/${id}/rating`, t, { rating: 5 })]);
    attempts.push([`${who} revert`, await call("POST", `/tasks/review/${id}/revert`, t, { type: "PARTIAL", remark: "no", reason: "QUALITY" })]);
    attempts.push([`${who} delete (review)`, await call("POST", `/tasks/review/${id}/delete`, t, { reasonCode: "OTHER", note: "no reason" })]);
    attempts.push([`${who} history`, await call("GET", `/tasks/${id}/history`, t)]);
  }
  const reached = attempts.filter(([, r]) => r.s === 200 || r.s === 201 || r.s >= 500);
  ok(`none of the ${attempts.length} task actions (edit, progress, delete, approve, rate, revert, review-delete, history) by five different people succeeded`, reached.length === 0, reached.map(([n, r]) => [n, r.s, r.b]));
  ok("the previous task is exactly as it was after all those attempts", JSON.stringify(await snapRow()) === row0);
  const dels = await q(`select count(*)::int n from task_deletions where "taskId"=$1`, [id]).catch(() => [{ n: 0 }]);
  ok("task_deletions has no row for it", dels[0].n === 0, dels);
  ok("and nobody was notified about it", (await q(`select count(*)::int n from notifications where "userId" in ($1,$2,$3,$4,$5)`, [m1, m2, hr, adm, emp]))[0].n === 0);

  console.log("\n## deleting");
  ok("another manager cannot delete it (404)", (await call("DELETE", `/tasks/previous/${a3.b.id}`, tok.M2)).s === 404);
  const del = await call("DELETE", `/tasks/previous/${a3.b.id}`, tok.M1);
  ok("the owner deletes it", del.s === 200 && del.b.ok === true, del);
  ok("it is really gone from the list and the database", (await call("GET", "/tasks/previous", tok.M1)).b.entries.every((e) => e.id !== a3.b.id) && (await q(`select 1 from daily_tasks where id=$1`, [a3.b.id])).length === 0);
  ok("deleting it again is 404", (await call("DELETE", `/tasks/previous/${a3.b.id}`, tok.M1)).s === 404);
  ok("a regular task cannot be deleted through the previous-tasks route", await (async () => { const rid = (await q(`select id from daily_tasks where "userId"=$1 and "carryCount" >= 0 limit 1`, [emp]))[0].id; const r = await call("DELETE", `/tasks/previous/${rid}`, tok.M1); const still = (await q(`select 1 from daily_tasks where id=$1`, [rid])).length === 1; return r.s === 404 && still; })());
  ok("nor edited through it", await (async () => { const rid = (await q(`select id from daily_tasks where "userId"=$1 and "carryCount" >= 0 limit 1`, [emp]))[0].id; const r = await call("PATCH", `/tasks/previous/${rid}`, tok.M1, { title: "Overwritten" }); return r.s === 404 && (await q(`select title from daily_tasks where id=$1`, [rid]))[0].title === "Employee regular task"; })());
  ok("the ordinary records are still unchanged after add, edit and delete", JSON.stringify(rowsBefore) === JSON.stringify(await regularRows()));

  console.log("\n## history is kept in the audit log");
  await new Promise((r) => setTimeout(r, 800));
  const au = await q(`select action, summary, before, after from audit_logs where "recordType"='PreviousTask' and "platformId"=$1 order by "createdAt"`, [A]);
  const acts = au.map((r) => r.action).join();
  ok("add, edit and delete are each audited", /CREATE/.test(acts) && /UPDATE/.test(acts) && /DELETE/.test(acts), au.map((r) => [r.action, r.summary]));
  const delRow = au.find((r) => r.action === "DELETE");
  ok("the delete line keeps a readable copy of what was removed", delRow && /Migrated old reports/.test(JSON.stringify(delRow.before) + delRow.summary), delRow);

  console.log("\n## live-style regression: normal task flow still works");
  const mgr2 = await call("GET", "/tasks", tok.E);
  ok("an employee's own task list still loads and still shows their regular task", mgr2.s === 200 && JSON.stringify(mgr2.b).includes("Employee regular task"), mgr2.s);
  ok("the manager's approval queue still shows the employee's regular work", JSON.stringify((await call("GET", "/tasks/review/queue", tok.M1)).b).includes("Employee regular task"));

  await wipe(); await db.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
