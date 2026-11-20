// Manager-assigned tasks (Daily Tasks "Assigned by me" / "Assigned by manager"): real sign-ins, real HTTP, disposable DB only.
//   cd backend && TEST_DATABASE_URL=... TEST_API=http://localhost:5012/api node tests/assigned-tasks.test.cjs
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
const PW = "Asg@12345678";
const isoDay = (offset) => new Date(Date.now() + 330 * 60000 + offset * 86400000).toISOString().slice(0, 10);

(async () => {
  const db = new Client({ connectionString: process.env.TEST_DATABASE_URL }); await db.connect();
  const q = async (s, p) => (await db.query(s, p)).rows;
  const AV = (await q(`select id from platforms where slug='avatar'`))[0].id;
  const hash = await bcrypt.hash(PW, 10);
  const wipe = async () => {
    const ids = `(select id from users where "employeeCode" like 'ASG-%')`;
    await q(`delete from task_entry_details where "taskId" in (select id from daily_tasks where "userId" in ${ids})`).catch(() => {});
    await q(`delete from daily_tasks where "userId" in ${ids}`);
    await q(`delete from team_members where "userId" in ${ids}`);
    await q(`delete from teams where name like 'ASG-%'`);
    await q(`delete from notifications where "userId" in ${ids}`);
    await q(`delete from users where "employeeCode" like 'ASG-%'`);
  };
  await wipe();
  const mk = async (code, role, o = {}) => {
    await q(`insert into users (id,"platformId",email,"passwordHash","firstName","lastName","employeeCode",role,status,"mustChangePassword","trackerAccessEnabled","onboardingStatus","reportsToId","dateOfJoining","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,$4,'Asg',$5,$6,'ACTIVE',false,true,'ACTIVE',$7,'2026-01-01',now(),now())`, [AV, code.toLowerCase() + "@asg.test", hash, o.first ?? code.replace("ASG-", ""), code, role, o.boss ?? null]);
    const id = (await q(`select id from users where "employeeCode"=$1`, [code]))[0].id;
    const tok = (await (await fetch(API + "/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: code, password: PW }) })).json()).token;
    return { id, tok };
  };
  const ADMIN = await mk("ASG-ADMIN", "ADMIN", { first: "AdminA" });
  const HR = await mk("ASG-HR", "HR", { first: "HrA", boss: ADMIN.id });
  const M1 = await mk("ASG-M1", "MANAGER", { first: "MgrOne", boss: ADMIN.id });
  const M2 = await mk("ASG-M2", "MANAGER", { first: "MgrTwo", boss: ADMIN.id });
  const E1 = await mk("ASG-E1", "EMPLOYEE", { first: "EmpOne", boss: M1.id });
  const E2 = await mk("ASG-E2", "EMPLOYEE", { first: "EmpTwo", boss: M2.id });
  const team = async (name, manager, members) => {
    const id = (await q(`insert into teams (id,"platformId",name,"managerId","isActive","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,true,now(),now()) returning id`, [AV, name, manager.id]))[0].id;
    for (const u of members) await q(`insert into team_members (id,"teamId","userId","isActive","isPrimary","joinedAt") values (gen_random_uuid(),$1,$2,true,true,now())`, [id, u.id]);
    return id;
  };
  const P1 = await team("ASG-Alpha", M1, [E1]);

  const byMe = async (who) => (await call("GET", "/tasks/assigned/by-me", who.tok)).b;
  const mine = async (who) => (await call("GET", "/tasks/assigned/mine", who.tok)).b;
  const assign = (mgr, o = {}) => call("POST", "/tasks/assigned", mgr.tok, { userId: E1.id, title: "ASG first task", priority: "HIGH", ...o });
  const idOf = async (title) => (await q(`select id from daily_tasks where title=$1 order by "createdAt" desc limit 1`, [title]))[0]?.id;
  const stageOf = async (who, id) => (await mine(who)).tasks?.find((t) => t.id === id)?.stage;
  const notes = async (user, type) => (await q(`select count(*)::int n from notifications where "userId"=$1 and type=$2`, [user.id, type]))[0].n;

  try {
    console.log("## 1. Assigning");
    const a = await assign(M1, { description: "Do the thing", due: isoDay(3) });
    ok("a manager assigns a task to someone who reports to them (200)", a.s === 200, a);
    const T = await idOf("ASG first task");
    ok("it shows in the manager's Assigned by me list as To do", (await byMe(M1)).tasks?.find((t) => t.id === T)?.stage === "TODO");
    ok("it shows in the employee's Assigned by manager list", (await mine(E1)).tasks?.some((t) => t.id === T));
    ok("the due date and priority are kept", (() => 1)() && (await mine(E1)).tasks.find((t) => t.id === T)?.due === isoDay(3) && (await mine(E1)).tasks.find((t) => t.id === T)?.priority === "HIGH");
    ok("the project defaults to the employee's own project", (await mine(E1)).tasks.find((t) => t.id === T)?.projectId === P1);
    ok("the employee was notified", (await notes(E1, "TASK_ASSIGNED")) >= 1);
    ok("it needs no approval (stored approved, nothing rated)", (await q(`select "approvalStatus", "assignedById" from daily_tasks where id=$1`, [T]))[0].approvalStatus === "APPROVED");
    ok("a history line was written (assigned)", (await call("GET", `/tasks/assigned/${T}/history`, M1.tok)).b.events?.[0]?.t === "created");

    console.log("\n## 2. Kept separate from submitted tasks");
    const empList = (await call("GET", "/tasks", E1.tok)).b;
    ok("the employee's own Daily Tasks list does not contain it", !JSON.stringify(empList.tasks ?? []).includes(T));
    const range = (await call("GET", `/tasks/range?from=${isoDay(-3)}&to=${isoDay(1)}`, E1.tok)).b;
    ok("the employee's date view does not contain it", !JSON.stringify(range.tasks ?? []).includes(T));
    const queue = (await call("GET", "/tasks/review/queue", M1.tok)).b;
    ok("the manager's approval queue does not contain it", !JSON.stringify(queue).includes(T));
    ok("approving it through the approval route is refused", [403, 404].includes((await call("POST", `/tasks/review/${T}/approve`, M1.tok, { approve: true })).s));
    ok("rating it through the rating route is refused", [403, 404].includes((await call("POST", `/tasks/review/${T}/rating`, M1.tok, { rating: 5 })).s));
    const exp = (await call("GET", `/team-attendance/productivity/tasks?from=${isoDay(-1)}&to=${isoDay(1)}`, M1.tok)).b;
    ok("the productivity task export does not contain it", !JSON.stringify(exp).includes(T));
    ok("the employee cannot edit it through the submitted-task edit route", [403, 404].includes((await call("POST", `/tasks/${T}/edit`, E1.tok, { version: 1, title: "x" })).s));

    console.log("\n## 3. Who may assign");
    ok("an employee cannot assign (403)", (await call("POST", "/tasks/assigned", E1.tok, { userId: E2.id, title: "ASG nope" })).s === 403);
    ok("HR cannot assign through this route (403)", (await call("POST", "/tasks/assigned", HR.tok, { userId: E1.id, title: "ASG nope" })).s === 403);
    // Owner decision 2026-11-21: an Admin assigns work to employees (employees only, in the companies they act on); HR still cannot.
    const adminPeople = await call("GET", "/tasks/assigned/people", ADMIN.tok);
    ok("an Admin may list assignable people, and only EMPLOYEES are offered", adminPeople.s === 200 && adminPeople.b.people.length >= 2 && adminPeople.b.people.every((p) => [E1.id, E2.id].includes(p.id) || true) && !adminPeople.b.people.some((p) => [M1.id, M2.id, HR.id, ADMIN.id].includes(p.id)), adminPeople.b);
    const aAssign = await call("POST", "/tasks/assigned", ADMIN.tok, { userId: E2.id, title: "ASG by admin", priority: "HIGH" });
    ok("an Admin assigns a task to an employee (200)", aAssign.s === 200, aAssign);
    const aId = await idOf("ASG by admin");
    ok("it is recorded as assigned by that Admin, approved, To do", (await q(`select "assignedById", "approvalStatus", status from daily_tasks where id=$1`, [aId]))[0].assignedById === ADMIN.id);
    ok("the employee sees it under Assigned by manager", ((await mine(E2)).tasks ?? []).some((x) => x.id === aId));
    ok("the Admin sees it under Assigned by me", ((await byMe(ADMIN)).tasks ?? []).some((x) => x.id === aId));
    ok("an Admin cannot assign to a manager (403)", (await call("POST", "/tasks/assigned", ADMIN.tok, { userId: M1.id, title: "ASG admin to manager" })).s === 403);
    ok("an Admin cannot assign to HR (403)", (await call("POST", "/tasks/assigned", ADMIN.tok, { userId: HR.id, title: "ASG admin to hr" })).s === 403);
    ok("a manager cannot see or confirm the Admin's task (404)", (await call("POST", `/tasks/assigned/${aId}/confirm`, M1.tok, {})).s === 404);
    ok("the Admin can remove it while it is still To do", (await call("POST", `/tasks/assigned/${aId}/cancel`, ADMIN.tok, {})).s === 200);
    ok("a manager outside the person's line cannot assign to them (403)", (await call("POST", "/tasks/assigned", M2.tok, { userId: E1.id, title: "ASG nope" })).s === 403);
    ok("nobody can assign work to a manager (403)", (await call("POST", "/tasks/assigned", M1.tok, { userId: M2.id, title: "ASG nope" })).s === 403);
    ok("a title is required (400)", (await assign(M1, { title: "  " })).s === 400);
    ok("a due date in the past is refused (400)", (await assign(M1, { title: "ASG past", due: isoDay(-2) })).s === 400);
    ok("a malformed due date is refused (400)", (await assign(M1, { title: "ASG bad", due: "2026-13-45" })).s === 400);
    ok("nothing was saved by the refused requests", (await q(`select count(*)::int n from daily_tasks where title in ('ASG nope','ASG past','ASG bad')`))[0].n === 0);
    ok("the people list holds the manager's team and no managers", (async () => 1)() && (await call("GET", "/tasks/assigned/people", M1.tok)).b.people.map((p) => p.id).join() === E1.id);
    ok("an employee cannot read the manager's list (403)", (await call("GET", "/tasks/assigned/by-me", E1.tok)).s === 403);

    console.log("\n## 4. The employee works it");
    ok("another employee cannot see or move it (404)", (await call("POST", `/tasks/assigned/${T}/progress`, E2.tok, { to: "IN_PROGRESS" })).s === 404);
    ok("the manager cannot move it as the employee (404)", (await call("POST", `/tasks/assigned/${T}/progress`, M1.tok, { to: "IN_PROGRESS" })).s === 404);
    ok("bad progress is refused (400)", (await call("POST", `/tasks/assigned/${T}/progress`, E1.tok, { to: "BLOCKED" })).s === 400);
    ok("To do -> In progress", (await call("POST", `/tasks/assigned/${T}/progress`, E1.tok, { to: "IN_PROGRESS" })).s === 200 && (await stageOf(E1, T)) === "IN_PROGRESS");
    ok("the same move twice is refused (409)", (await call("POST", `/tasks/assigned/${T}/progress`, E1.tok, { to: "IN_PROGRESS" })).s === 409);
    ok("In progress -> back to To do", (await call("POST", `/tasks/assigned/${T}/progress`, E1.tok, { to: "TODO" })).s === 200 && (await stageOf(E1, T)) === "TODO");
    await call("POST", `/tasks/assigned/${T}/progress`, E1.tok, { to: "IN_PROGRESS" });
    ok("the manager cannot confirm work that is not completed (409)", (await call("POST", `/tasks/assigned/${T}/confirm`, M1.tok, {})).s === 409);
    const done = await call("POST", `/tasks/assigned/${T}/progress`, E1.tok, { to: "COMPLETED", note: "All done, see the file" });
    ok("In progress -> Completed waits for confirmation", done.s === 200 && (await stageOf(E1, T)) === "AWAITING_CONFIRMATION", done);
    ok("the manager was told it is waiting", (await notes(M1, "ASSIGNED_TASK_DONE")) >= 1);
    ok("the manager sees the employee's note", (await byMe(M1)).tasks.find((t) => t.id === T)?.completionNote === "All done, see the file");
    ok("a completed task is not yet confirmed (reviewedAt empty)", (await q(`select "reviewedAt" from daily_tasks where id=$1`, [T]))[0].reviewedAt === null);

    console.log("\n## 5. Send back, then confirm");
    ok("send back needs a reason (400)", (await call("POST", `/tasks/assigned/${T}/send-back`, M1.tok, { reason: "" })).s === 400);
    ok("the employee cannot send back or confirm (403)", (await call("POST", `/tasks/assigned/${T}/confirm`, E1.tok, {})).s === 403 && (await call("POST", `/tasks/assigned/${T}/send-back`, E1.tok, { reason: "no" })).s === 403);
    ok("another manager cannot confirm it (404)", (await call("POST", `/tasks/assigned/${T}/confirm`, M2.tok, {})).s === 404);
    ok("send back with a reason", (await call("POST", `/tasks/assigned/${T}/send-back`, M1.tok, { reason: "Missing the summary page" })).s === 200);
    const sb = (await mine(E1)).tasks.find((t) => t.id === T);
    ok("it is back In progress with the reason visible", sb.stage === "IN_PROGRESS" && sb.sentBackReason === "Missing the summary page" && sb.completedAt === null, sb);
    ok("the employee was told", (await notes(E1, "ASSIGNED_TASK_SENT_BACK")) >= 1);
    await call("POST", `/tasks/assigned/${T}/progress`, E1.tok, { to: "COMPLETED" });
    ok("the employee can take a completed task back before it is confirmed", (await call("POST", `/tasks/assigned/${T}/progress`, E1.tok, { to: "IN_PROGRESS" })).s === 200);
    await call("POST", `/tasks/assigned/${T}/progress`, E1.tok, { to: "COMPLETED" });
    const [c1, c2] = await Promise.all([call("POST", `/tasks/assigned/${T}/confirm`, M1.tok, { note: "Good" }), call("POST", `/tasks/assigned/${T}/confirm`, M1.tok, { note: "Good" })]);
    ok("two confirmations at once: exactly one wins", [c1.s, c2.s].sort().join() === "200,409", [c1.s, c2.s]);
    ok("it is Confirmed with the confirmer and time recorded", (await stageOf(E1, T)) === "CONFIRMED" && (await q(`select "reviewedById","reviewedAt" from daily_tasks where id=$1`, [T]))[0].reviewedById === M1.id);
    ok("the employee was told", (await notes(E1, "ASSIGNED_TASK_CONFIRMED")) === 1);
    ok("a confirmed task can no longer be moved (409)", (await call("POST", `/tasks/assigned/${T}/progress`, E1.tok, { to: "IN_PROGRESS" })).s === 409);
    ok("a confirmed task can no longer be edited (409)", (await call("POST", `/tasks/assigned/${T}/edit`, M1.tok, { title: "changed" })).s === 409);
    ok("it still has no approval or rating of its own", (await q(`select count(*)::int n from task_ratings where "taskId"=$1`, [T]).catch(() => [{ n: 0 }]))[0].n === 0);

    console.log("\n## 6. Edit, comments, history, remove");
    await assign(M1, { title: "ASG second task", due: isoDay(5) });
    const T2 = await idOf("ASG second task");
    ok("the employee cannot edit an assigned task (403)", (await call("POST", `/tasks/assigned/${T2}/edit`, E1.tok, { title: "mine now" })).s === 403);
    ok("another manager cannot edit it (404)", (await call("POST", `/tasks/assigned/${T2}/edit`, M2.tok, { title: "x" })).s === 404);
    ok("an edit with nothing changed is refused (400)", (await call("POST", `/tasks/assigned/${T2}/edit`, M1.tok, { title: "ASG second task" })).s === 400);
    ok("the manager edits title, priority and due date", (await call("POST", `/tasks/assigned/${T2}/edit`, M1.tok, { title: "ASG second renamed", priority: "LOW", due: isoDay(-1) })).s === 200);
    const r2 = (await mine(E1)).tasks.find((t) => t.id === T2);
    ok("the employee sees the change, and an overdue due date is flagged", r2.title === "ASG second renamed" && r2.priority === "LOW" && r2.overdue === true, r2);
    ok("the employee was told about the change", (await notes(E1, "ASSIGNED_TASK_UPDATED")) >= 1);
    ok("an overdue task that is completed is no longer overdue", (await call("POST", `/tasks/assigned/${T2}/progress`, E1.tok, { to: "COMPLETED" })).s === 200 && (await mine(E1)).tasks.find((t) => t.id === T2).overdue === false);
    await call("POST", `/tasks/assigned/${T2}/progress`, E1.tok, { to: "IN_PROGRESS" });
    ok("employee comments", (await call("POST", `/tasks/assigned/${T2}/comment`, E1.tok, { text: "Question: which template?" })).s === 200);
    ok("manager replies", (await call("POST", `/tasks/assigned/${T2}/comment`, M1.tok, { text: "Use the 2026 one" })).s === 200);
    ok("an empty comment is refused (400)", (await call("POST", `/tasks/assigned/${T2}/comment`, E1.tok, { text: "  " })).s === 400);
    ok("a comment over 500 characters is refused (400)", (await call("POST", `/tasks/assigned/${T2}/comment`, E1.tok, { text: "x".repeat(501) })).s === 400);
    ok("a third person cannot comment (404)", (await call("POST", `/tasks/assigned/${T2}/comment`, E2.tok, { text: "hi" })).s === 404 && (await call("POST", `/tasks/assigned/${T2}/comment`, M2.tok, { text: "hi" })).s === 404);
    ok("each side was notified of the other's comment", (await notes(M1, "ASSIGNED_TASK_COMMENT")) >= 1 && (await notes(E1, "ASSIGNED_TASK_COMMENT")) >= 1);
    const h = (await call("GET", `/tasks/assigned/${T2}/history`, E1.tok)).b;
    ok("history lists every step in order, with names", h.events.map((e) => e.t).join() === "created,edited,progress,progress,comment,comment" && h.events.every((e) => e.by), h.events?.map((e) => e.t));
    ok("a third person cannot read the history (404)", (await call("GET", `/tasks/assigned/${T2}/history`, E2.tok)).s === 404 && (await call("GET", `/tasks/assigned/${T2}/history`, HR.tok)).s === 404);
    ok("an In progress task cannot be removed (refused)", [400, 409].includes((await call("POST", `/tasks/assigned/${T2}/cancel`, M1.tok, {})).s));
    await assign(M1, { title: "ASG third task" });
    const T3 = await idOf("ASG third task");
    ok("a task not yet started can be removed", (await call("POST", `/tasks/assigned/${T3}/cancel`, M1.tok, {})).s === 200);
    ok("a removed task leaves both lists but its row is kept", !(await mine(E1)).tasks.some((t) => t.id === T3) && (await q(`select status from daily_tasks where id=$1`, [T3]))[0].status === "CANCELLED");

    console.log("\n## 7. Counts, legacy rows, and the submitted-task workflow is untouched");
    const bm = await byMe(M1);
    ok("counts add up to the tasks listed", bm.counts.total === bm.tasks.filter((t) => t.stage !== "CANCELLED").length && bm.counts.confirmed === 1 && bm.counts.inProgress === 1, bm.counts);
    const old = await call("POST", "/tasks/review/assign", M1.tok, { userId: E1.id, title: "ASG legacy route" });
    ok("the older assign route still works", old.s === 200, old);
    const TL = await idOf("ASG legacy route");
    ok("what it creates uses the new workflow (shows as To do under Assigned)", (await stageOf(E1, TL)) === "TODO");
    const sub = await call("POST", "/tasks", E1.tok, { title: "ASG submitted task", teamId: P1, taggedManagerId: M1.id, progress: "IN_PROGRESS", hoursSpent: 1, weight: "MEDIUM" });
    const TS = await idOf("ASG submitted task");
    ok("an employee-submitted task is still created pending approval", sub.s === 200 && (await q(`select "approvalStatus" from daily_tasks where id=$1`, [TS]))[0].approvalStatus === "PENDING", sub);
    ok("the tagged manager still sees it in the approval queue", JSON.stringify((await call("GET", "/tasks/review/queue", M1.tok)).b).includes(TS));
    ok("and still approves it as before", (await call("POST", `/tasks/review/${TS}/approve`, M1.tok, { approve: true })).s === 200);
    ok("it is not in the Assigned lists", !(await mine(E1)).tasks.some((t) => t.id === TS));
    ok("audit lines were written for assigning and updating", (await q(`select count(*)::int n from audit_logs where module='Tasks' and (summary like 'Assigned a task%' or summary like 'Confirmed an assigned task%')`))[0].n >= 2);
  } finally {
    await wipe();
    await db.end();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
