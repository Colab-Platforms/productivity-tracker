// TASK_APPROVE_COMPANY: Saurabh Jadhav (CP-01) stays an Employee but can be TAGGED as the approving manager and then decides ONLY the tasks tagged to him.
// Real sign-ins, real HTTP, THROWAWAY database only. Runs the migrations and the grant script part-way to prove before/after.
//   cd backend && TEST_DATABASE_URL=postgresql://postgres:localtest@localhost:54329/dq_test TEST_API=http://localhost:5012/api node tests/task-approve-capability.test.cjs
const fs = require("node:fs"), path = require("node:path");
const { spawnSync } = require("node:child_process");
const { Client } = require("pg");
const bcrypt = require("bcryptjs");
const API = process.env.TEST_API ?? "http://localhost:5012/api";
const DBURL = process.env.TEST_DATABASE_URL;
require("./_guard.cjs").assertTestDb(DBURL);

const call = async (m, p, t, body) => {
  const r = await fetch(API + p, { method: m, headers: { ...(t ? { authorization: "Bearer " + t } : {}), ...(body !== undefined && m !== "GET" ? { "content-type": "application/json" } : {}) }, body: body !== undefined && m !== "GET" ? JSON.stringify(body) : undefined });
  const txt = await r.text(); let j; try { j = JSON.parse(txt); } catch { j = txt; }
  return { s: r.status, b: j };
};
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  -> " + String(JSON.stringify(x)).slice(0, 420))); };
const PW = "Cap@12345678";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const script = (args) => spawnSync(process.execPath, [path.join(__dirname, "..", "scripts", "provision-capabilities.cjs"), ...args], { env: { ...process.env, CAP_DB_URL: DBURL }, encoding: "utf8" });
const mig = (name) => fs.readFileSync(path.join(__dirname, "..", "prisma", "migrations", name, "migration.sql"), "utf8");

(async () => {
  const db = new Client({ connectionString: DBURL }); await db.connect();
  const q = async (s, p) => (await db.query(s, p)).rows;
  const A = (await q(`select id from platforms where slug='avatar'`))[0].id;
  const hash = await bcrypt.hash(PW, 10);
  const ids = `(select id from users where "employeeCode" in ('CP-01','AWL-06') or "employeeCode" like 'TAP-%')`;
  const wipe = async () => {
    await q(`delete from user_capabilities where "userId" in ${ids}`).catch(() => {});
    await q(`delete from productivity_supervisors where "userId" in ${ids}`).catch(() => {});
    await q(`delete from task_events where "taskId" in (select id from daily_tasks where "userId" in ${ids})`).catch(() => {});
    await q(`delete from task_ratings where "taskId" in (select id from daily_tasks where "userId" in ${ids})`).catch(() => {});
    await q(`delete from task_entry_details where "taskId" in (select id from daily_tasks where "userId" in ${ids})`).catch(() => {});
    await q(`delete from daily_tasks where "userId" in ${ids}`).catch(() => {});
    await q(`delete from team_members where "userId" in ${ids}`).catch(() => {});
    await q(`delete from teams where name like 'TAP-%'`).catch(() => {});
    await q(`delete from notifications where "userId" in ${ids}`).catch(() => {});
    await q(`update audit_logs set "actorId"=null where "actorId" in ${ids}`).catch(() => {});
    await q(`delete from audit_logs where "targetUserId" in ${ids}`).catch(() => {});
    await q(`delete from users where "employeeCode" in ('CP-01','AWL-06') or "employeeCode" like 'TAP-%'`).catch((e) => console.log("wipe note:", e.message.slice(0, 90)));
  };
  await wipe();
  await q(`drop table if exists user_capabilities`);
  const mk = async (code, first, last, role, boss = null) => {
    await q(`insert into users (id,"platformId",email,"passwordHash","firstName","lastName","employeeCode",role,status,"mustChangePassword","trackerAccessEnabled","onboardingStatus","reportsToId","dateOfJoining","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,'ACTIVE',false,true,'ACTIVE',$8,'2024-01-01',now(),now())`, [A, code.toLowerCase() + "@tap.test", hash, first, last, code, role, boss]);
    const id = (await q(`select id from users where "employeeCode"=$1`, [code]))[0].id;
    const login = async () => (await (await fetch(API + "/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: code, password: PW }) })).json()).token;
    return { id, code, login, tok: null };
  };
  const ADMIN = await mk("TAP-ADM", "Adm", "Tap", "ADMIN");
  const MGR = await mk("TAP-MGR", "Mgr", "Tap", "MANAGER", ADMIN.id);
  const HR = await mk("TAP-HR", "Hrp", "Tap", "HR");
  const SAU = await mk("CP-01", "Saurabh", "Jadhav", "EMPLOYEE", MGR.id);
  const E1 = await mk("TAP-E1", "Eone", "Tap", "EMPLOYEE", MGR.id);
  const REG = await mk("TAP-REG", "Plain", "Tap", "EMPLOYEE", MGR.id);
  for (const u of [ADMIN, MGR, HR, SAU, E1, REG]) u.tok = await u.login();
  const teamId = (await q(`insert into teams (id,"platformId",name,"managerId","isActive","createdAt","updatedAt") values (gen_random_uuid(),$1,'TAP-Proj',$2,true,now(),now()) returning id`, [A, MGR.id]))[0].id;
  await q(`insert into team_members (id,"teamId","userId","isActive","isPrimary","joinedAt") values (gen_random_uuid(),$1,$2,true,true,now())`, [teamId, E1.id]);
  const send = (title, mgr) => call("POST", "/tasks", E1.tok, { title, teamId, taggedManagerId: mgr, weight: "LOW", progress: "IN_PROGRESS", hoursSpent: 1 });
  const idOf = async (title) => (await q(`select id from daily_tasks where title=$1`, [title]))[0]?.id;
  const stat = async (title) => (await q(`select "approvalStatus" a, "approvedById" by from daily_tasks where title=$1`, [title]))[0];
  const tagList = async () => (await call("GET", "/tasks", E1.tok)).b.entryForm?.managers ?? [];

  try {
    console.log("## 0. Before the migrations: he is not offered and nothing breaks");
    ok("the capability table does not exist yet", !(await q(`select to_regclass('user_capabilities') t`))[0].t);
    ok("Saurabh is not on the Tag Reporting Manager list", !(await tagList()).some((m) => m.id === SAU.id));
    ok("the task form still loads with the real managers", (await tagList()).some((m) => m.id === MGR.id));
    ok("/tasks says he cannot approve", (await call("GET", "/tasks", SAU.tok)).b.canApproveCompany === false);
    ok("the approval queue refuses him (Employee, not a supervisor)", (await call("GET", "/tasks/review/queue", SAU.tok)).s === 403);

    console.log("\n## 1. Apply the migrations and the grant script");
    await db.query(mig("20261124100000_user_capabilities"));
    await db.query(mig("20261128110000_capability_task_approve"));
    await db.query(mig("20261119120000_productivity_supervisors").replace('CREATE TABLE "productivity_supervisors"', 'CREATE TABLE IF NOT EXISTS "productivity_supervisors"').replace(/CREATE UNIQUE INDEX/g, "CREATE UNIQUE INDEX IF NOT EXISTS")).catch(() => {});
    await q(`insert into productivity_supervisors (id,"userId",note,"createdAt") values (gen_random_uuid(),$1,'test',now()) on conflict do nothing`, [SAU.id]);
    await sleep(16000); // the server re-checks a missing table every 15 s
    const dry = script(["--capability=TASK_APPROVE_COMPANY"]);
    ok("preview names only Saurabh and writes nothing", dry.status === 0 && /CP-01/.test(dry.stdout) && !/AWL-06/.test(dry.stdout) && !(await q(`select 1 from user_capabilities`)).length, dry.stdout + dry.stderr);
    const wet = script(["--capability=TASK_APPROVE_COMPANY", "--apply"]);
    ok("apply grants exactly one row", wet.status === 0 && (await q(`select count(*)::int c from user_capabilities where capability='TASK_APPROVE_COMPANY'`))[0].c === 1, wet.stdout + wet.stderr);
    ok("it stays an Employee", (await q(`select role::text r from users where id=$1`, [SAU.id]))[0].r === "EMPLOYEE");

    console.log("\n## 2. He appears in the dropdown and approves only what is tagged to him");
    const list = await tagList();
    ok("Saurabh is on the Tag Reporting Manager list", list.some((m) => m.id === SAU.id && m.name === "Saurabh Jadhav" && m.code === "CP-01"), list);
    ok("the real managers are still there", list.some((m) => m.id === MGR.id));
    ok("he is not offered to himself", !((await call("GET", "/tasks", SAU.tok)).b.entryForm?.managers ?? []).some((m) => m.id === SAU.id));
    ok("/tasks says he can approve", (await call("GET", "/tasks", SAU.tok)).b.canApproveCompany === true);
    const t1 = await send("TAP to Saurabh", SAU.id), t2 = await send("TAP to manager", MGR.id);
    ok("an employee can tag him", t1.s === 200 || t1.s === 201, t1);
    ok("and another task to the manager", t2.s === 200 || t2.s === 201, t2);
    const id1 = await idOf("TAP to Saurabh"), id2 = await idOf("TAP to manager");
    ok("the tag is saved as him", (await q(`select "taggedManagerId" t from task_entry_details where "taskId"=$1`, [id1]))[0].t === SAU.id);
    ok("he is notified", Number((await q(`select count(*)::int c from notifications where "userId"=$1`, [SAU.id]))[0].c) >= 1);
    const queue = await call("GET", "/tasks/review/queue", SAU.tok);
    const row = (id) => (queue.b.proposals ?? []).concat(queue.b.all ?? []).concat(queue.b.tasks ?? []).find((t) => t.id === id);
    ok("his queue answers", queue.s === 200, queue);
    ok("his tagged task is in Needs Approval", (queue.b.proposals ?? []).some((t) => t.id === id1), Object.keys(queue.b));
    ok("the manager's task is NOT actionable for him", !(queue.b.proposals ?? []).some((t) => t.id === id2));
    const dec = await call("POST", `/tasks/review/${id2}/approve`, SAU.tok, { approve: true });
    ok("approving a task tagged to someone else is refused", dec.s === 403 || dec.s === 404, dec);
    ok("and it stays pending", (await stat("TAP to manager")).a === "PENDING");
    const ok1 = await call("POST", `/tasks/review/${id1}/approve`, SAU.tok, { approve: true });
    ok("approving his tagged task works", ok1.s === 200, ok1);
    const st = await stat("TAP to Saurabh");
    ok("it is approved and records him as the decider", st.a === "APPROVED" && st.by === SAU.id, st);
    ok("the other employee cannot approve (no capability)", (await call("POST", `/tasks/review/${id2}/approve`, REG.tok, { approve: true })).s === 403);

    console.log("\n## 3. Reject, rate, and the other review actions follow the same tag rule");
    const t3 = await send("TAP reject me", SAU.id), id3 = await idOf("TAP reject me");
    ok("he can reject with a reason", (await call("POST", `/tasks/review/${id3}/approve`, SAU.tok, { approve: false, rejectionNote: "Not clear enough" })).s === 200 && (await stat("TAP reject me")).a === "REJECTED", t3);
    await call("PATCH", `/tasks/${id1}`, E1.tok, { progress: "COMPLETED" });
    const rate = await call("POST", `/tasks/review/${id1}/rating`, SAU.tok, { rating: 4, comment: "Good", expectedMinutes: 30 });
    ok("he can rate the finished task tagged to him", rate.s === 200, rate);
    ok("he cannot rate the manager's task", [403, 404].includes((await call("POST", `/tasks/review/${id2}/rating`, SAU.tok, { rating: 5 })).s));
    { const a = await call("POST", `/tasks/review/${id2}/partial`, SAU.tok, { partial: true }), b = await call("POST", `/tasks/review/${id2}/delete`, SAU.tok, { reasonCode: "OTHER", note: "x y z" }), c = await call("POST", `/tasks/review/${id2}/revert`, SAU.tok, { type: "PARTIAL", remark: "abc", reason: "QUALITY" }); console.log("   partial/delete/revert:", a.s, b.s, c.s, JSON.stringify([a.b, b.b, c.b]).slice(0, 200)); }
    ok("he cannot mark partial, revert or delete a task tagged to someone else", [403, 404].includes((await call("POST", `/tasks/review/${id2}/partial`, SAU.tok, { partial: true })).s) && [403, 404].includes((await call("POST", `/tasks/review/${id2}/delete`, SAU.tok, { reasonCode: "OTHER", note: "x y z" })).s) && [403, 404].includes((await call("POST", `/tasks/review/${id2}/revert`, SAU.tok, { type: "PARTIAL", remark: "abc", reason: "QUALITY" })).s));
    ok("he still cannot ASSIGN tasks through the manager route", (await call("POST", "/tasks/review/assign", SAU.tok, { userId: E1.id, title: "x" })).s === 403);
    ok("the manager still decides their own task", (await call("POST", `/tasks/review/${id2}/approve`, MGR.tok, { approve: true })).s === 200);
    ok("HR is still view-only", (await send("TAP hr view", SAU.id)).s < 300 && (await call("POST", `/tasks/review/${await idOf("TAP hr view")}/approve`, HR.tok, { approve: true })).s === 403);

    console.log("\n## 4. Removing the right (or promoting him) takes it away at once");
    await q(`delete from user_capabilities where "userId"=$1 and capability='TASK_APPROVE_COMPANY'`, [SAU.id]);
    const idH = await idOf("TAP hr view");
    ok("without the row he can no longer approve", [403, 404].includes((await call("POST", `/tasks/review/${idH}/approve`, SAU.tok, { approve: true })).s));
    ok("and he drops off the dropdown", !(await tagList()).some((m) => m.id === SAU.id));
    await q(`insert into user_capabilities (id,"userId",capability,note,"createdAt") values (gen_random_uuid(),$1,'TASK_APPROVE_COMPANY','test',now())`, [SAU.id]);
    await q(`update users set role='MANAGER' where id=$1`, [SAU.id]);
    ok("promoted to Manager: the leftover capability row is ignored", !(await tagList()).some((m) => m.id === SAU.id && m.role === "EMPLOYEE"));
    await q(`update users set role='EMPLOYEE' where id=$1`, [SAU.id]);
  } finally {
    await wipe();
    await db.end();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
