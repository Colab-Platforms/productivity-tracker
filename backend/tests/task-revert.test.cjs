// Task revert / reopen over HTTP: a manager sends a Completed task back to In Progress with a required remark.
// Disposable database only (see _guard.cjs). No migration is needed: the history goes to the immutable audit log and the latest revert is
// kept on the task itself.
//
//   cd backend && TEST_DATABASE_URL=... TEST_API=http://localhost:5012/api node tests/task-revert.test.cjs
require("dotenv").config({ path: require("node:path").join(__dirname, "..", ".env") });
const { Client } = require("pg");
const bcrypt = require("bcryptjs");
const API = process.env.TEST_API ?? "http://localhost:5002/api";
require("./_guard.cjs").assertTestDb(process.env.TEST_DATABASE_URL);

const call = async (m, p, t, b) => {
  const r = await fetch(API + p, { method: m, headers: { "content-type": "application/json", ...(t ? { authorization: "Bearer " + t } : {}) }, body: b !== undefined ? JSON.stringify(b) : undefined });
  const txt = await r.text(); let j; try { j = JSON.parse(txt); } catch { j = txt; }
  return { s: r.status, b: j };
};
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  -> " + String(JSON.stringify(x)).slice(0, 350))); };
const PW = "Rev@12345678";

(async () => {
  const db = new Client({ connectionString: process.env.TEST_DATABASE_URL }); await db.connect();
  const q = async (s, p) => (await db.query(s, p)).rows;
  const AV = (await q(`select id from platforms where slug='avatar'`))[0].id;
  const AVN = (await q(`select id from platforms where slug='avance'`))[0].id;
  const hash = await bcrypt.hash(PW, 10);
  const wipe = async () => {
    const ids = `(select id from users where "employeeCode" like 'REV-%')`;
    await q(`delete from task_events where "taskId" in (select id from daily_tasks where "userId" in ${ids})`).catch(() => {});
    await q(`delete from daily_tasks where "userId" in ${ids}`);
    await q(`delete from notifications where "userId" in ${ids}`);
    await q(`delete from users where "employeeCode" like 'REV-%'`);
  };
  await wipe();
  const login = async (code) => (await call("POST", "/auth/login", null, { email: code, password: PW })).b.token;
  const mk = async (code, role, platformId, reportsToId = null) => {
    await q(`insert into users (id,"platformId",email,"passwordHash","firstName","lastName","employeeCode",role,status,"mustChangePassword","trackerAccessEnabled","onboardingStatus","reportsToId","dateOfJoining","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,$4,'Rev',$5,$6,'ACTIVE',false,true,'ACTIVE',$7,'2026-01-01',now(),now())`, [platformId, code.toLowerCase() + "@rev.test", hash, code.replace("REV-", "T"), code, role, reportsToId]);
    const id = (await q(`select id from users where "employeeCode"=$1`, [code]))[0].id;
    return { id, tok: await login(code) };
  };
  const M = await mk("REV-M", "MANAGER", AV);
  const M2 = await mk("REV-M2", "MANAGER", AV); // a manager who does NOT manage this employee
  const E = await mk("REV-E", "EMPLOYEE", AV, M.id);
  const E2 = await mk("REV-E2", "EMPLOYEE", AV, M.id);
  const HR = await mk("REV-HR", "HR", AV);
  const HRB = await mk("REV-HRB", "HR", AVN);

  const assign = async (user, title) => (await call("POST", "/tasks/review/assign", M.tok, { userId: user.id, title, weight: "MEDIUM" })).s;
  const taskRow = async (title) => (await q(`select * from daily_tasks where title=$1 and "userId" in (select id from users where "employeeCode" like 'REV-%')`, [title]))[0];
  // a task through the real flow: assigned (auto-approved) -> employee marks it done -> manager grades Completed
  const completeAndGrade = async (user, title, outcome = "COMPLETED") => {
    ok(`manager assigns "${title}"`, (await assign(user, title)) === 200);
    const id = (await taskRow(title)).id;
    const done = await call("PATCH", `/tasks/${id}`, user.tok, { status: "COMPLETED", completionNote: "Finished the first draft" });
    ok(`employee marks "${title}" done`, done.s === 200, done);
    ok(`manager grades "${title}" ${outcome}`, (await call("POST", `/tasks/review/${id}/outcome`, M.tok, { outcome, reviewNote: "Looks good" })).s === 200);
    return id;
  };

  console.log("\n## 1. Setup: a task completed and graded");
  const t1 = await completeAndGrade(E, "Quarterly report");
  const before = await taskRow("Quarterly report");
  ok("it is Completed with outcome COMPLETED", before.status === "COMPLETED" && before.outcome === "COMPLETED" && before.completedAt !== null, before);
  const asEmpBefore = (await call("GET", "/tasks", E.tok)).b;
  ok("the employee sees it in Done", asEmpBefore.done.some((t) => t.id === t1));

  console.log("\n## 2. Who may revert, and what is checked");
  const rv = (tok, id, type, remark) => call("POST", `/tasks/review/${id}/revert`, tok, { type, remark });
  ok("an employee cannot revert (their own task) (403)", (await rv(E.tok, t1, "PARTIAL", "I want it back")).s === 403);
  ok("another employee cannot (403)", (await rv(E2.tok, t1, "PARTIAL", "not mine to revert")).s === 403);
  ok("a manager who does not manage this person cannot (403)", (await rv(M2.tok, t1, "PARTIAL", "not my team")).s === 403);
  ok("HR of another company cannot (403)", (await rv(HRB.tok, t1, "PARTIAL", "other company")).s === 403);
  ok("no sign-in = 401", (await call("POST", `/tasks/review/${t1}/revert`, null, { type: "PARTIAL", remark: "abc" })).s === 401);
  ok("nothing changed after the refused attempts", (await taskRow("Quarterly report")).status === "COMPLETED");
  ok("a missing remark is refused (400)", (await rv(M.tok, t1, "PARTIAL", undefined)).s === 400);
  ok("a 2-character remark is refused (400)", (await rv(M.tok, t1, "PARTIAL", "ab")).s === 400);
  ok("spaces only are refused (400)", (await rv(M.tok, t1, "NOT_FULL", "     ")).s === 400);
  ok("a remark over 300 characters is refused (400)", (await rv(M.tok, t1, "NOT_FULL", "x".repeat(301))).s === 400);
  ok("a bad type is refused (400)", (await rv(M.tok, t1, "SOMETHING", "valid remark")).s === 400);
  ok("a bad id is a 404, not a server error", (await rv(M.tok, "not-a-uuid", "PARTIAL", "valid remark")).s === 404);
  ok("still Completed after every refusal", (await taskRow("Quarterly report")).status === "COMPLETED");

  console.log("\n## 3. Option A: Partially completed");
  const noteBefore = (await taskRow("Quarterly report")).completionNote;
  const a = await rv(M.tok, t1, "PARTIAL", "  Sections 1 and 2 are done, section 3 is missing  ");
  ok("the manager reverts it (200)", a.s === 200, a);
  const r1 = await taskRow("Quarterly report");
  ok("status is back to In Progress", r1.status === "IN_PROGRESS", r1.status);
  ok("the grade and the completion time are cleared (no longer counted completed)", r1.outcome === null && r1.completedAt === null, r1);
  ok("the employee's own submission note is preserved", r1.completionNote === noteBefore && noteBefore === "Finished the first draft", r1.completionNote);
  ok("the original details are untouched (title, weight, approval, assigner)", r1.title === "Quarterly report" && r1.weight === "MEDIUM" && r1.approvalStatus === "APPROVED" && r1.assignedById === M.id);
  ok("the latest revert is on the task: who, when, kind and the trimmed remark", r1.reviewedById === M.id && r1.reviewedAt !== null && r1.reviewNote === "[Reopened: partial] Sections 1 and 2 are done, section 3 is missing", r1.reviewNote);
  ok("the task row was not deleted or duplicated", (await q(`select count(*)::int n from daily_tasks where title='Quarterly report'`))[0].n === 1);

  console.log("\n## 4. The employee");
  const emp = (await call("GET", "/tasks", E.tok)).b;
  const mine = emp.working.find((t) => t.id === t1);
  ok("it is back in the employee's working list, not in Done", !!mine && !emp.done.some((t) => t.id === t1), emp.working.map((t) => t.title));
  ok("it says Partially completed and carries the manager's remark", mine.reopened?.type === "PARTIAL" && mine.reopened.label === "Partially completed" && mine.reopened.remark === "Sections 1 and 2 are done, section 3 is missing" && mine.reopened.resubmitted === false, mine.reopened);
  const note = (await q(`select type, title, body from notifications where "userId"=$1 and type='TASK_REVERTED'`, [E.id]))[0];
  ok("the employee was notified, with the kind and the remark", !!note && /Partially completed/.test(note.body) && /section 3 is missing/.test(note.body), note);
  ok("the manager who did it is not notified of their own action", (await q(`select 1 from notifications where "userId"=$1 and type='TASK_REVERTED'`, [M.id])).length === 0);
  ok("a colleague is not notified", (await q(`select 1 from notifications where "userId"=$1 and type='TASK_REVERTED'`, [E2.id])).length === 0);

  console.log("\n## 5. No duplicate reverts");
  const again = await rv(M.tok, t1, "PARTIAL", "pressing it twice");
  ok("a second revert on an already reopened task is refused (409)", again.s === 409, again);
  const race = await Promise.all([1, 2, 3].map(() => rv(M.tok, t1, "NOT_FULL", "three at once")));
  ok("three simultaneous presses on a reopened task all refuse", race.every((r) => r.s === 409), race.map((r) => r.s));
  ok("still exactly one notification", (await q(`select count(*)::int n from notifications where "userId"=$1 and type='TASK_REVERTED'`, [E.id]))[0].n === 1);

  console.log("\n## 6. Counts and reports follow");
  const today = (await call("GET", "/tracker/timesheet", M.tok)).b.today;
  const rep = (await call("GET", `/reports?from=${today}&to=${today}&groupBy=person&userId=${E.id}`, M.tok)).b.people.find((p) => p.userId === E.id);
  ok("the reverted task is NOT counted completed; it is pending", rep.tasksCompleted === 0 && rep.tasksPending === 1, rep);
  const queue = (await call("GET", "/tasks/review/queue", M.tok)).b;
  ok("the manager queue no longer lists it as completed or to review", !queue.toReview.some((t) => t.id === t1) && !queue.recent.some((t) => t.id === t1), 0);

  console.log("\n## 7. The employee finishes it again (resubmit)");
  const res = await call("PATCH", `/tasks/${t1}`, E.tok, { status: "COMPLETED", completionNote: "Section 3 added" });
  ok("the employee marks it done again (200)", res.s === 200, res);
  const r2 = await taskRow("Quarterly report");
  ok("completed again with a NEW completion time, and the manager can review it", r2.status === "COMPLETED" && r2.completedAt !== null && r2.outcome === null, r2);
  const q2 = (await call("GET", "/tasks/review/queue", M.tok)).b;
  ok("it is back in the manager's review list, flagged as resubmitted", q2.toReview.find((t) => t.id === t1)?.reopened?.resubmitted === true, q2.toReview.find((t) => t.id === t1));
  const rep2 = (await call("GET", `/reports?from=${today}&to=${today}&groupBy=person&userId=${E.id}`, M.tok)).b.people.find((p) => p.userId === E.id);
  ok("counted completed (once) after the manager grades it again", (await call("POST", `/tasks/review/${t1}/outcome`, M.tok, { outcome: "COMPLETED" })).s === 200 && (await call("GET", `/reports?from=${today}&to=${today}&groupBy=person&userId=${E.id}`, M.tok)).b.people.find((p) => p.userId === E.id).tasksCompleted === 1, rep2);
  ok("after the new grade the reopen marker is gone", (await taskRow("Quarterly report")).reviewNote === null && (await call("GET", "/tasks", E.tok)).b.done.find((t) => t.id === t1).reopened === null);

  console.log("\n## 8. Option B: Not fully completed (a Failed or wrongly completed task), HR may revert too");
  const t2 = await completeAndGrade(E2, "Client deck", "FAILED");
  ok("HR of the company can revert a graded task (200)", (await rv(HR.tok, t2, "NOT_FULL", "It was marked completed by mistake")).s === 200);
  const r3 = await taskRow("Client deck");
  ok("back In Progress, grade cleared, remark kept with its kind", r3.status === "IN_PROGRESS" && r3.outcome === null && r3.reviewNote === "[Reopened: not full] It was marked completed by mistake" && r3.reviewedById === HR.id, r3);
  const e2 = (await call("GET", "/tasks", E2.tok)).b.working.find((t) => t.id === t2);
  ok("the employee sees 'Not fully completed' with the remark", e2?.reopened?.label === "Not fully completed" && e2.reopened.remark === "It was marked completed by mistake", e2?.reopened);

  console.log("\n## 9. A reopened task from an earlier day still reaches the employee");
  const t3 = await completeAndGrade(E, "Old job");
  await q(`update daily_tasks set date = (current_date - 3) where id=$1`, [t3]);
  ok("revert the old task (200)", (await rv(M.tok, t3, "PARTIAL", "A part is still open")).s === 200);
  const w = (await call("GET", "/tasks", E.tok)).b;
  const old = w.working.find((t) => t.id === t3);
  ok("it appears in today's working list, flagged as from an earlier day", !!old && old.fromEarlierDay === true && old.reopened?.type === "PARTIAL", old);
  ok("it does not change today's score or today's task list", !w.tasks.some((t) => t.id === t3));

  console.log("\n## 10. Permanent history: nothing is lost");
  const audit = await q(`select module, action, summary, "targetUserId", before, after from audit_logs where "recordId"=$1 and summary like 'Reopened task%' order by "createdAt"`, [t1]);
  ok("the revert is in the immutable audit log", audit.length === 1, audit);
  const au = audit[0];
  ok("it records the previous and the new status", au.before?.status === "COMPLETED" && au.after?.status === "IN_PROGRESS", au);
  ok("it records the original grade, who graded it and the original completion time", au.before?.outcome === "COMPLETED" && au.before.gradedById === M.id && !!au.before.completedAt && au.before.gradeNote === "Looks good", au.before);
  ok("it records the kind, the remark, the manager (id and name), the employee and the time", au.after?.revertType === "PARTIAL" && au.after.remark === "Sections 1 and 2 are done, section 3 is missing" && au.after.revertedById === M.id && /Rev/.test(au.after.revertedBy) && au.after.employeeId === E.id && !!au.after.revertedAt, au.after);
  ok("the audit row is attributed to the employee it is about", au.targetUserId === E.id, au);
  ok("the audit row cannot be changed (immutable)", await (async () => { try { await q(`update audit_logs set summary='x' where "recordId"=$1`, [t1]); return false; } catch { return true; } })());
  ok("the refused attempts left no audit row", (await q(`select count(*)::int n from audit_logs where "recordId"=$1 and summary like 'Reopened task%'`, [t1]))[0].n === 1);

  console.log("\n## 11. A manager's own task cannot be reverted by this route");
  const mt = (await q(`insert into daily_tasks (id,"platformId","userId",date,title,weight,status,"approvalStatus","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,current_date,'My own',\'MEDIUM\',\'COMPLETED\',\'APPROVED\',now(),now()) returning id`, [AV, M.id]))[0].id;
  ok("the owner of a task cannot revert it (403), even as a manager", (await rv(M.tok, mt, "PARTIAL", "reverting my own")).s === 403);

  await wipe();
  await db.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
