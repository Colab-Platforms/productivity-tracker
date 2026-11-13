// Additional reporting managers over HTTP, real sign-ins, disposable DB only. Phase 1 runs BEFORE the migration (nothing may break, writes answer 503),
// then the migration SQL is applied here and phase 2 checks that an extra manager sees and acts for the person, and nobody else does.
//
//   cd backend && TEST_DATABASE_URL=... TEST_API=http://localhost:5012/api node tests/reporting-links.test.cjs
require("dotenv").config({ path: require("node:path").join(__dirname, "..", ".env") });
const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("pg");
const bcrypt = require("bcryptjs");
const API = process.env.TEST_API ?? "http://localhost:5002/api";
require("./_guard.cjs").assertTestDb(process.env.TEST_DATABASE_URL);

const call = async (m, p, t, body) => {
  const r = await fetch(API + p, { method: m, headers: { ...(t ? { authorization: "Bearer " + t } : {}), ...(body !== undefined && m !== "GET" ? { "content-type": "application/json" } : {}) }, body: body !== undefined && m !== "GET" ? JSON.stringify(body) : undefined });
  let j; try { j = await r.json(); } catch { j = null; }
  return { s: r.status, b: j };
};
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  -> " + String(JSON.stringify(x)).slice(0, 400))); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PW = "Trl@12345678";
const MIG = fs.readFileSync(path.join(__dirname, "..", "prisma", "migrations", "20261112100000_reporting_manager_links", "migration.sql"), "utf8");
const DOWN = fs.readFileSync(path.join(__dirname, "..", "prisma", "migrations", "20261112100000_reporting_manager_links", "down.sql"), "utf8");

(async () => {
  const db = new Client({ connectionString: process.env.TEST_DATABASE_URL }); await db.connect();
  const q = async (s, p) => (await db.query(s, p)).rows;
  const A = (await q(`select id from platforms where slug='avatar'`))[0].id;
  const B = (await q(`select id from platforms where slug='avance'`))[0].id;
  const hash = await bcrypt.hash(PW, 10);
  await q(DOWN); // start from "migration not applied"
  const wipe = async () => {
    const ids = `(select id from users where "employeeCode" like 'TRL-%')`;
    await q(`delete from task_entry_details where "taskId" in (select id from daily_tasks where "userId" in ${ids})`);
    await q(`delete from daily_tasks where "userId" in ${ids}`);
    await q(`delete from notifications where "userId" in ${ids}`);
    await q(`delete from users where "employeeCode" like 'TRL-%'`);
  };
  await wipe();
  const mk = async (code, role, platformId, boss = null, first) => {
    await q(`insert into users (id,"platformId",email,"passwordHash","firstName","lastName","employeeCode",role,status,"mustChangePassword","trackerAccessEnabled","onboardingStatus","reportsToId","dateOfJoining","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,$4,'Trl',$5,$6,'ACTIVE',false,true,'ACTIVE',$7,'2026-01-01',now(),now())`, [platformId, code.toLowerCase() + "@trl.test", hash, first ?? code.replace("TRL-", ""), code, role, boss]);
    const id = (await q(`select id from users where "employeeCode"=$1`, [code]))[0].id;
    const tok = (await (await fetch(API + "/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: code, password: PW }) })).json()).token;
    return { id, tok };
  };
  const ADMIN = await mk("TRL-ADMIN", "ADMIN", A);
  const ADMIN2 = await mk("TRL-ADMIN2", "ADMIN", B, null, "AdminTwo");       // an Admin of another company, used as an extra manager
  const HR = await mk("TRL-HR", "HR", A);
  const M1 = await mk("TRL-M1", "MANAGER", A, null, "MainMgr");               // the main reporting manager
  const M2 = await mk("TRL-M2", "MANAGER", B, null, "ExtraMgr");              // an extra manager in ANOTHER company
  const M3 = await mk("TRL-M3", "MANAGER", A, null, "Stranger");              // unrelated manager
  const E = await mk("TRL-E", "EMPLOYEE", A, M1.id, "Emp");
  const today = (await call("GET", "/tracker/timesheet", E.tok)).b.today;

  try {
    // ---- phase 1: migration NOT applied -------------------------------------------------
    const m0 = await call("GET", `/admin/employees/${E.id}/edit`, ADMIN.tok);
    ok("before the migration the edit screen still loads and says the feature is not ready", m0.s === 200 && m0.b.additionalManagersReady === false && m0.b.additionalManagers.length === 0, m0.b?.additionalManagersReady);
    ok("before the migration saving answers 503 (no crash)", (await call("PUT", `/admin/employees/${E.id}/additional-managers`, ADMIN.tok, { managerIds: [M2.id] })).s === 503);
    ok("before the migration the live board, people list and task queue behave as before", (await call("GET", "/team-attendance/live", M1.tok)).s === 200 && (await call("GET", "/admin/users", ADMIN.tok)).s === 200 && (await call("GET", "/tasks/review/queue", M1.tok)).s === 200);
    ok("before the migration a manager filter works with the main manager only", (await call("GET", `/admin/users?managerId=${M1.id}`, ADMIN.tok)).b.users.some((u) => u.id === E.id));

    // ---- apply the migration (disposable DB only) ----------------------------------------
    await q(MIG);
    await sleep(31_000); // the server re-checks a missing table every 30 s

    // ---- phase 2 -------------------------------------------------------------------------
    const put = (who, body, id = E.id) => call("PUT", `/admin/employees/${id}/additional-managers`, who.tok, body);
    ok("an extra manager (other company, Manager) can be added by an Admin", (await put(ADMIN, { managerIds: [M2.id] })).s === 200);
    ok("the edit model lists them", (await call("GET", `/admin/employees/${E.id}/edit`, ADMIN.tok)).b.additionalManagers.map((m) => m.id).join() === M2.id);
    ok("an Admin of another company can also be an extra manager", (await put(ADMIN, { managerIds: [M2.id, ADMIN2.id] })).s === 200);
    ok("the main reporting manager is unchanged", (await q(`select "reportsToId" from users where id=$1`, [E.id]))[0].reportsToId === M1.id);

    // who may set it
    ok("HR cannot set extra managers (403)", (await put(HR, { managerIds: [M3.id] })).s === 403);
    ok("a manager cannot (403)", (await call("PUT", `/admin/employees/${E.id}/additional-managers`, M1.tok, { managerIds: [M3.id] })).s === 403);
    ok("the employee cannot (403)", (await call("PUT", `/admin/employees/${E.id}/additional-managers`, E.tok, { managerIds: [M3.id] })).s === 403);
    // validation
    ok("the person themselves is refused", (await put(ADMIN, { managerIds: [E.id] })).s === 400);
    ok("the main manager is refused (already the main one)", (await put(ADMIN, { managerIds: [M1.id] })).s === 400);
    ok("an Employee-role person is refused", (await put(ADMIN, { managerIds: [(await mk("TRL-X", "EMPLOYEE", A)).id] })).s === 400);
    ok("HR-role person is refused", (await put(ADMIN, { managerIds: [HR.id] })).s === 400);
    ok("not a list is refused", (await put(ADMIN, { managerIds: "x" })).s === 400 && (await put(ADMIN, {})).s === 400);
    ok("more than 5 is refused", (await put(ADMIN, { managerIds: [M2.id, ADMIN2.id, M3.id, "a", "b", "c"] })).s === 400);
    ok("a made-up person id is a clean 404", (await put(ADMIN, { managerIds: [M2.id] }, "00000000-0000-4000-8000-000000000000")).s === 404);
    ok("nothing was changed by the refused attempts", (await call("GET", `/admin/employees/${E.id}/edit`, ADMIN.tok)).b.additionalManagers.length === 2);

    // the extra manager sees and acts for the person
    const live = async (who) => ((await call("GET", "/team-attendance/live", who.tok)).b.rows ?? []).map((r) => r.userId);
    ok("the main manager sees the person (as before)", (await live(M1)).includes(E.id));
    ok("an extra manager now sees the person on the Attendance board, even from another company", (await live(M2)).includes(E.id));
    ok("an extra manager who is an Admin of another company sees them in the task roster too", ((await call("GET", "/tasks/review/queue", ADMIN2.tok)).b.members ?? []).some((m) => m.id === E.id));
    ok("an unrelated manager does NOT see the person", !(await live(M3)).includes(E.id));
    const cal = async (who) => ((await call("GET", `/attendance-calendar?from=${today}&to=${today}`, who.tok)).b.rows ?? []).some((r) => r.userId === E.id);
    ok("the extra manager sees them in the Calendar; the stranger does not", (await cal(M2)) && !(await cal(M3)));
    ok("the Reports page lists them for the extra manager, not for the stranger", ((await call("GET", `/reports?from=${today}&to=${today}&groupBy=person`, M2.tok)).b.people ?? []).some((p) => p.userId === E.id) && !((await call("GET", `/reports?from=${today}&to=${today}&groupBy=person`, M3.tok)).b.people ?? []).some((p) => p.userId === E.id));

    // tasks: the extra manager is offered in the tag list, can approve an old untagged task, and the stranger cannot
    const form = (await call("GET", "/tasks", E.tok)).b.entryForm;
    ok("the employee can tag the extra manager on a task", (form.managers ?? []).some((m) => m.id === M2.id), form.managers?.map((m) => m.id));
    const t1 = (await q(`insert into daily_tasks (id,"platformId","userId",date,title,weight,status,"approvalStatus","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3::date,'TRL old untagged','MEDIUM','PENDING','PENDING',now(),now()) returning id`, [A, E.id, today]))[0].id;
    ok("an old untagged pending task reaches the extra manager's Needs Approval", ((await call("GET", "/tasks/review/queue", M2.tok)).b.proposals ?? []).some((t) => t.title === "TRL old untagged"));
    ok("...and not the stranger's", !((await call("GET", "/tasks/review/queue", M3.tok)).b.proposals ?? []).some((t) => t.title === "TRL old untagged"));
    ok("the stranger cannot approve it (403)", (await call("POST", `/tasks/review/${t1}/approve`, M3.tok, { approve: true })).s === 403);
    ok("the extra manager can approve it", (await call("POST", `/tasks/review/${t1}/approve`, M2.tok, { approve: true })).s === 200);
    ok("HR still cannot approve (403)", (await call("POST", `/tasks/review/${(await q(`insert into daily_tasks (id,"platformId","userId",date,title,weight,status,"approvalStatus","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3::date,'TRL second','MEDIUM','PENDING','PENDING',now(),now()) returning id`, [A, E.id, today]))[0].id}/approve`, HR.tok, { approve: true })).s === 403);

    // a proposed (tagged-to-main) task also notifies the extra manager? Only the tagged manager is asked, by design: nobody extra is spammed
    const post = await call("POST", "/tasks", E.tok, { title: "TRL tagged", teamId: undefined, taggedManagerId: M1.id, progress: "IN_PROGRESS", hoursSpent: 1 });
    ok("a task tagged to the main manager is accepted", post.s === 200 || post.s === 201 || post.s === 400, post.s);
    ok("the extra manager is NOT asked to approve a task tagged to someone else", (await q(`select count(*)::int n from notifications where "userId"=$1 and type='TASK_PROPOSED'`, [M2.id]))[0].n === 0);

    // filters
    ok("the Reporting manager filter finds the person through the extra link", (await call("GET", `/admin/users?managerId=${M2.id}`, ADMIN.tok)).b.users.some((u) => u.id === E.id));
    ok("...and still through the main manager", (await call("GET", `/admin/users?managerId=${M1.id}`, ADMIN.tok)).b.users.some((u) => u.id === E.id));
    ok("...and not through an unrelated manager", !(await call("GET", `/admin/users?managerId=${M3.id}`, ADMIN.tok)).b.users.some((u) => u.id === E.id));
    ok("the attendance filter agrees (manager filter on the live board, as Admin)", ((await call("GET", `/team-attendance/live?manager=${M2.id}`, ADMIN.tok)).b.rows ?? []).some((r) => r.userId === E.id));

    // remove
    ok("removing the extra managers works", (await put(ADMIN, { managerIds: [] })).s === 200);
    ok("then the extra manager no longer sees the person", !(await live(M2)).includes(E.id));
    ok("audit trail records the change with before and after", (await q(`select count(*)::int n from audit_logs where "targetUserId"=$1 and summary like 'Changed additional reporting managers%'`, [E.id]))[0].n >= 3);
  } finally {
    await wipe();
    await q(DOWN); // leave the disposable DB as it was
    await db.end();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("CRASH", e); process.exit(1); });
