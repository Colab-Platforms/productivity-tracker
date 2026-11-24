// TASK_ASSIGN_COMPANY: Saurabh Jadhav (CP-01) and Chirag Parmar (AWL-06) assign tasks to employees of their own company through the existing assigned-task
// workflow. Real sign-ins, real HTTP, THROWAWAY database only. Runs the migration and the grant script part-way to prove before/after.
//   cd backend && TEST_DATABASE_URL=postgresql://postgres:localtest@localhost:54329/dq_test TEST_API=http://localhost:5012/api node tests/task-assign-company.test.cjs
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
const script = (args, url = DBURL) => spawnSync(process.execPath, [path.join(__dirname, "..", "scripts", "provision-capabilities.cjs"), ...args], { env: { ...process.env, CAP_DB_URL: url }, encoding: "utf8" });

(async () => {
  const db = new Client({ connectionString: DBURL }); await db.connect();
  const q = async (s, p) => (await db.query(s, p)).rows;
  const A = (await q(`select id from platforms where slug='avatar'`))[0].id, B = (await q(`select id from platforms where slug='co-lab'`))[0].id;
  const hash = await bcrypt.hash(PW, 10);
  const wipe = async () => {
    const ids = `(select id from users where "employeeCode" in ('CP-01','AWL-06') or "employeeCode" like 'TAC-%')`;
    await q(`delete from user_capabilities where "userId" in ${ids}`).catch(() => {});
    await q(`delete from task_events where "taskId" in (select id from daily_tasks where "userId" in ${ids})`).catch(() => {});
    await q(`delete from task_ratings where "taskId" in (select id from daily_tasks where "userId" in ${ids})`).catch(() => {});
    await q(`delete from task_entry_details where "taskId" in (select id from daily_tasks where "userId" in ${ids})`).catch(() => {});
    await q(`delete from daily_tasks where "userId" in ${ids}`);
    await q(`delete from team_members where "userId" in ${ids}`);
    await q(`delete from teams where name like 'TAC-%'`);
    await q(`delete from notifications where "userId" in ${ids}`);
    await q(`update audit_logs set "actorId"=null where "actorId" in ${ids}`).catch(() => {});
    await q(`delete from audit_logs where "targetUserId" in ${ids}`).catch(() => {});
    await q(`delete from users where "employeeCode" in ('CP-01','AWL-06') or "employeeCode" like 'TAC-%'`);
  };
  await wipe().catch((e) => console.log("wipe note:", e.message));
  await q(`drop table if exists user_capabilities`);
  const mk = async (code, first, last, role, o = {}) => {
    await q(`insert into users (id,"platformId",email,"passwordHash","firstName","lastName","employeeCode",role,status,"mustChangePassword","trackerAccessEnabled","onboardingStatus","reportsToId","dateOfJoining","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8,false,true,'ACTIVE',$9,'2026-01-01',now(),now())`, [o.platform ?? A, code.toLowerCase() + "@tac.test", hash, first, last, code, role, o.status ?? "ACTIVE", o.boss ?? null]);
    const id = (await q(`select id from users where "employeeCode"=$1`, [code]))[0].id;
    const login = async () => (await (await fetch(API + "/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: code, password: PW }) })).json()).token;
    return { id, code, get tok() { return this._t; }, set tok(v) { this._t = v; }, login };
  };
  const ADMIN = await mk("TAC-ADM", "Adm", "Tac", "ADMIN");
  const MGR = await mk("TAC-MGR", "Mgr", "Tac", "MANAGER", { boss: ADMIN.id });
  const HR = await mk("TAC-HR", "Hrp", "Tac", "HR");
  const SAU = await mk("CP-01", "Saurabh", "Jadhav", "EMPLOYEE", { boss: MGR.id });          // company A
  const CHI = await mk("AWL-06", "Chirag", "Parmar", "EMPLOYEE", { platform: B });            // company B
  const E1 = await mk("TAC-E1", "Eone", "Tac", "EMPLOYEE", { boss: MGR.id });                 // A, has a project
  const E2 = await mk("TAC-E2", "Etwo", "Tac", "EMPLOYEE", { boss: MGR.id });                 // A, no project
  const E3 = await mk("TAC-E3", "Ethree", "Tac", "EMPLOYEE", { platform: B });                // B
  const E4 = await mk("TAC-E4", "Efour", "Tac", "EMPLOYEE", { platform: B });                 // B
  const INACT = await mk("TAC-OFF", "Gone", "Tac", "EMPLOYEE", { status: "SUSPENDED" });      // A, suspended
  const REG = await mk("TAC-REG", "Plain", "Tac", "EMPLOYEE", { boss: MGR.id });              // A, no capability
  const MGRB = await mk("TAC-MGB", "MgrB", "Tac", "MANAGER", { platform: B });
  const all = [ADMIN, MGR, HR, SAU, CHI, E1, E2, E3, E4, INACT, REG, MGRB];
  for (const u of all) if (u !== INACT) u.tok = await u.login();
  const teamId = (await q(`insert into teams (id,"platformId",name,"managerId","isActive","createdAt","updatedAt") values (gen_random_uuid(),$1,'TAC-Proj',$2,true,now(),now()) returning id`, [A, MGR.id]))[0].id;
  await q(`insert into team_members (id,"teamId","userId","isActive","isPrimary","joinedAt") values (gen_random_uuid(),$1,$2,true,true,now()),(gen_random_uuid(),$1,$3,true,false,now())`, [teamId, E1.id, SAU.id]);
  const idOf = async (title) => (await q(`select id from daily_tasks where title=$1`, [title]))[0]?.id;
  const notes = async (uid, type) => Number((await q(`select count(*)::int c from notifications where "userId"=$1 and type=$2`, [uid, type]))[0].c);

  try {
    console.log("## 0. Before the migration: nobody holds the capability, nothing else changes");
    ok("the table does not exist yet", !(await q(`select to_regclass('user_capabilities') t`))[0].t);
    ok("Saurabh is just an Employee: /tasks says canAssignCompany false", (await call("GET", "/tasks", SAU.tok)).b.canAssignCompany === false);
    ok("and every assignment endpoint refuses him", (await call("GET", "/tasks/assigned/people", SAU.tok)).s === 403 && (await call("POST", "/tasks/assigned", SAU.tok, { userId: E1.id, title: "x" })).s === 403 && (await call("GET", "/tasks/assigned/by-me", SAU.tok)).s === 403);
    const pre = script([]);
    ok("the grant script stops, and says why, when the table is missing", pre.status === 1 && /user_capabilities does not exist/.test(pre.stdout), pre.stdout);

    console.log("\n## 1. Apply the migration, then the grant script (preview first)");
    await db.query(fs.readFileSync(path.join(__dirname, "..", "prisma", "migrations", "20261124100000_user_capabilities", "migration.sql"), "utf8"));
    ok("the table now exists and is empty", Number((await q(`select count(*)::int c from user_capabilities`))[0].c) === 0);
    const dry = script([]);
    ok("preview names exactly the two accounts and writes nothing", dry.status === 0 && /CP-01 Saurabh Jadhav/.test(dry.stdout) && /AWL-06 Chirag Parmar/.test(dry.stdout) && /DRY RUN: 2 row/.test(dry.stdout) && Number((await q(`select count(*)::int c from user_capabilities`))[0].c) === 0, dry.stdout);
    await q(`update users set "lastName"='Someoneelse' where id=$1`, [SAU.id]);
    const wrongName = script([]);
    ok("a wrong name stops the script (matched by ID AND name), nothing written", wrongName.status === 1 && /expected "Saurabh Jadhav"/.test(wrongName.stdout) && Number((await q(`select count(*)::int c from user_capabilities`))[0].c) === 0, wrongName.stdout);
    await q(`update users set "lastName"='Jadhav' where id=$1`, [SAU.id]);
    await q(`update users set role='MANAGER' where id=$1`, [CHI.id]);
    const wrongRole = script([]);
    ok("a person who is not an Employee stops the script", wrongRole.status === 1 && /expected EMPLOYEE/.test(wrongRole.stdout), wrongRole.stdout);
    await q(`update users set role='EMPLOYEE' where id=$1`, [CHI.id]);
    await q(`update users set status='SUSPENDED' where id=$1`, [CHI.id]);
    ok("an inactive account stops the script", script([]).status === 1 && /expected ACTIVE/.test(script([]).stdout));
    await q(`update users set status='ACTIVE' where id=$1`, [CHI.id]);
    const env = fs.readFileSync(path.join(__dirname, "..", ".env"), "utf8").split(/\r?\n/).find((l) => l.startsWith("DATABASE_URL="));
    if (env) { const live = script([], env.slice(env.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "")); ok("the script refuses the live database without --allow-live (it never connects)", live.status === 1 && /REFUSING/.test(live.stderr + live.stdout), live.stderr); }
    const apply = script(["--apply"]);
    ok("apply grants exactly two rows", apply.status === 0 && /DONE: 2 account/.test(apply.stdout) && Number((await q(`select count(*)::int c from user_capabilities`))[0].c) === 2, apply.stdout);
    ok("the rows belong to the two accounts' own ids", (await q(`select "userId" from user_capabilities`)).map((r) => r.userId).sort().join() === [SAU.id, CHI.id].sort().join());
    const again = script(["--apply"]);
    ok("running it again adds nothing", again.status === 0 && /already holds/.test(again.stdout) && Number((await q(`select count(*)::int c from user_capabilities`))[0].c) === 2, again.stdout);
    ok("their roles are still EMPLOYEE and nobody else got a row", (await q(`select role::text r from users where id in ($1,$2)`, [SAU.id, CHI.id])).every((r) => r.r === "EMPLOYEE") && Number((await q(`select count(*)::int c from user_capabilities where "userId" not in ($1,$2)`, [SAU.id, CHI.id]))[0].c) === 0);
    ok("a grant is audited", Number((await q(`select count(*)::int c from audit_logs where "targetUserId" in ($1,$2) and path='/scripts/provision-capabilities'`, [SAU.id, CHI.id]))[0].c) === 2);

    console.log("\n## 2. Saurabh (company A) assigns to employees of company A");
    await sleep(16000); // the server re-checks a missing table every 15 seconds
    ok("his Daily Tasks says he can assign (canAssignCompany)", (await call("GET", "/tasks", SAU.tok)).b.canAssignCompany === true);
    const pplRaw = (await call("GET", "/tasks/assigned/people", SAU.tok)).b.people;
    const ppl = pplRaw.map((p) => p.code);
    const dbRows = await q(`select "employeeCode" c, "platformId" p, role::text r, status::text s from users where "employeeCode" = any($1)`, [ppl]);
    ok("the list holds our company's active employees (E1, E2 and Plain) and nobody who must not be there", ["TAC-E1", "TAC-E2", "TAC-REG"].every((c) => ppl.includes(c)) && !["TAC-OFF", "TAC-MGR", "TAC-HR", "TAC-ADM", "TAC-E3", "TAC-E4", "CP-01", "AWL-06"].some((c) => ppl.includes(c)), ppl.filter((c) => c.startsWith("TAC") || c.includes("-0")));
    ok("EVERY person listed is an active EMPLOYEE of Saurabh's own company (the rest of the company is searchable, nothing else)", dbRows.length === ppl.length && dbRows.every((r) => r.p === A && r.r === "EMPLOYEE" && r.s === "ACTIVE"), dbRows.filter((r) => r.p !== A || r.r !== "EMPLOYEE" || r.s !== "ACTIVE"));
    ok("a person's own projects are offered with them", (await call("GET", "/tasks/assigned/people", SAU.tok)).b.people.find((p) => p.code === "TAC-E1").projects.some((p) => p.id === teamId));
    const a1 = await call("POST", "/tasks/assigned", SAU.tok, { userId: E1.id, title: "TAC from Saurabh to E1", description: "details", priority: "HIGH", due: new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10), projectId: teamId });
    ok("he assigns a task to Eone", a1.s === 200, a1);
    const row = (await q(`select "assignedById","userId","teamId",status::text s,"approvalStatus"::text ap, weight::text w from daily_tasks where title='TAC from Saurabh to E1'`))[0];
    ok("stored in the existing task table: assigned by Saurabh, owned by Eone, the project, To do, priority recorded", row && row.assignedById === SAU.id && row.userId === E1.id && row.teamId === teamId && row.s === "PENDING" && row.w === "HIGH", row);
    ok("Eone is notified once, naming Saurabh", (await notes(E1.id, "TASK_ASSIGNED")) === 1 && /Saurabh Jadhav assigned you/.test((await q(`select body from notifications where "userId"=$1 and type='TASK_ASSIGNED'`, [E1.id]))[0].body));
    ok("Eone sees it in the existing Assigned tasks view", (await call("GET", "/tasks/assigned/mine", E1.tok)).b.tasks.some((t) => t.title === "TAC from Saurabh to E1" && t.assignedBy === "Saurabh Jadhav"));
    ok("a second task, to Etwo (no project)", (await call("POST", "/tasks/assigned", SAU.tok, { userId: E2.id, title: "TAC from Saurabh to E2" })).s === 200);
    await sleep(500);
    const aud = await q(`select summary, path from audit_logs where "actorId"=$1 and path like '%/tasks/assigned%'`, [SAU.id]);
    ok("the assignments are audited with Saurabh as the actor", aud.length >= 2 && aud.every((r) => /assign/i.test(r.summary ?? "")), aud);

    console.log("\n## 3. The server refuses everything outside his rights");
    const bad = async (u, title) => (await call("POST", "/tasks/assigned", SAU.tok, { userId: u.id, title })).s;
    ok("another company's employee: refused", (await bad(E3, "x")) === 403 && !(await idOf("x")));
    ok("an inactive employee: refused", (await bad(INACT, "x2")) === 404 && !(await idOf("x2")));
    ok("a manager: refused (a manager's tasks are personal)", (await bad(MGR, "x3")) === 403);
    ok("HR and Admin: refused (employees only)", (await bad(HR, "x4")) === 403 && (await bad(ADMIN, "x5")) === 403);
    ok("himself: refused", (await bad(SAU, "x6")) === 400);
    ok("nothing was created by the refused attempts", Number((await q(`select count(*)::int c from daily_tasks where title in ('x','x2','x3','x4','x5','x6')`))[0].c) === 0);
    ok("he cannot edit or remove somebody else's assigned task", await (async () => { const mid = (await call("POST", "/tasks/assigned", MGR.tok, { userId: E1.id, title: "TAC from manager to E1" })).s; const id = await idOf("TAC from manager to E1"); return mid === 200 && (await call("POST", `/tasks/assigned/${id}/edit`, SAU.tok, { title: "hijack" })).s === 404 && (await call("POST", `/tasks/assigned/${id}/cancel`, SAU.tok, {})).s === 404; })());

    console.log("\n## 4. Monitoring: progress, completion, comments, edits");
    const tid = await idOf("TAC from Saurabh to E1");
    ok("Eone starts it", (await call("POST", `/tasks/assigned/${tid}/progress`, E1.tok, { to: "IN_PROGRESS" })).s === 200);
    ok("Eone completes it", (await call("POST", `/tasks/assigned/${tid}/progress`, E1.tok, { to: "COMPLETED", note: "all done" })).s === 200);
    ok("Saurabh is told it is done (and about the progress)", (await notes(SAU.id, "ASSIGNED_TASK_DONE")) === 1 && (await notes(SAU.id, "ASSIGNED_TASK_PROGRESS")) >= 1);
    const mine = (await call("GET", "/tasks/assigned/by-me", SAU.tok)).b;
    const t1 = mine.tasks.find((t) => t.title === "TAC from Saurabh to E1");
    ok("his list shows employee, task, project, assigned date, due date, status, completion date and (blank) rating", t1 && t1.employee === "Eone Tac" && t1.project === "TAC-Proj" && t1.assignedOn && t1.due && t1.stage === "AWAITING_CONFIRMATION" && t1.completedAt && "rating" in t1 && t1.rating === null, t1);
    ok("it lists only what HE assigned (not the manager's task)", mine.tasks.length === 2 && mine.tasks.every((t) => t.assignedById === SAU.id), mine.tasks.map((t) => t.title));
    ok("he can comment and the employee is told", (await call("POST", `/tasks/assigned/${tid}/comment`, SAU.tok, { text: "thanks" })).s === 200 && (await notes(E1.id, "ASSIGNED_TASK_COMMENT")) === 1);
    ok("he can read the history", (await call("GET", `/tasks/assigned/${tid}/history`, SAU.tok)).b.events.length >= 3);
    const t2 = await idOf("TAC from Saurabh to E2");
    ok("he edits a task of his own (title + due) and the employee is told by NAME", (await call("POST", `/tasks/assigned/${t2}/edit`, SAU.tok, { title: "TAC from Saurabh to E2 (edited)", due: new Date(Date.now() + 9 * 86400000).toISOString().slice(0, 10) })).s === 200 && /Saurabh Jadhav changed/.test((await q(`select body from notifications where "userId"=$1 and type='ASSIGNED_TASK_UPDATED' order by "createdAt" desc limit 1`, [E2.id]))[0].body));
    ok("he can remove one that has not started", (await call("POST", `/tasks/assigned/${t2}/cancel`, SAU.tok, {})).s === 200 && !(await call("GET", "/tasks/assigned/by-me", SAU.tok)).b.tasks.some((t) => t.id === t2));

    console.log("\n## 5. No approval, rating or confirmation rights");
    ok("he cannot confirm finished work (a manager does)", (await call("POST", `/tasks/assigned/${tid}/confirm`, SAU.tok, {})).s === 403);
    ok("he cannot send it back either", (await call("POST", `/tasks/assigned/${tid}/send-back`, SAU.tok, { reason: "no thanks" })).s === 403);
    ok("the task is still waiting, nothing changed", (await q(`select "reviewedAt" r from daily_tasks where id=$1`, [tid]))[0].r === null);
    ok("he cannot open the approval queue or approve/rate anyone's task", (await call("GET", "/tasks/review/queue", SAU.tok)).s === 403 && (await call("POST", `/tasks/review/${tid}/approve`, SAU.tok, { approve: true })).s >= 400 && (await call("POST", `/tasks/review/${tid}/rating`, SAU.tok, { rating: 5 })).s >= 400);
    ok("the MANAGER who assigned his own task still confirms it (existing flow untouched)", await (async () => { const mt = await idOf("TAC from manager to E1"); await call("POST", `/tasks/assigned/${mt}/progress`, E1.tok, { to: "COMPLETED" }); return (await call("POST", `/tasks/assigned/${mt}/confirm`, MGR.tok, {})).s === 200; })());

    console.log("\n## 6. Performance score: assigned tasks are never in it and never counted twice");
    const send = (title) => call("POST", "/tasks", E1.tok, { title, teamId, taggedManagerId: MGR.id, weight: "LOW", progress: "IN_PROGRESS", hoursSpent: 1 });
    ok("Eone has one ordinary submitted task: approved, completed, rated 5", (await send("TAC own task")).s < 300 && (await call("POST", `/tasks/review/${await idOf("TAC own task")}/approve`, MGR.tok, { approve: true })).s === 200 && (await call("PATCH", `/tasks/${await idOf("TAC own task")}`, E1.tok, { progress: "COMPLETED" })).s === 200 && (await call("POST", `/tasks/review/${await idOf("TAC own task")}/rating`, MGR.tok, { rating: 5 })).s === 200);
    const today = (await call("GET", "/tasks", E1.tok)).b.date;
    const w = (await call("GET", "/tasks", E1.tok)).b.weighted;
    ok("Eone's Overall Performance Score counts only his own task: 100% of 1 task (the two assigned tasks are not in it)", w.percent === 100 && w.tasks === 1 && w.completed === 1, w);
    const prod = (await call("GET", `/team-attendance/productivity?from=${today}&to=${today}`, ADMIN.tok)).b.people.find((p) => p.userId === E1.id);
    ok("the report counts them separately: 1 eligible task, and the assigned ones in their own counts (2 assigned: one by Saurabh, one by the manager)", prod.weighted.tasks === 1 && prod.tasks.assigned.total === 2, [prod.weighted.tasks, prod.tasks.assigned]);
    ok("the approval queue of the manager does not list the assigned tasks", !JSON.stringify((await call("GET", "/tasks/review/queue", MGR.tok)).b).includes("TAC from"));
    ok("Eone's own submitted-task list does not mix them in either", !(await call("GET", "/tasks", E1.tok)).b.active.concat((await call("GET", "/tasks", E1.tok)).b.done).some((t) => /^TAC from/.test(t.title)));

    console.log("\n## 7. Chirag (company B) separately");
    ok("Chirag can assign too", (await call("GET", "/tasks", CHI.tok)).b.canAssignCompany === true);
    const cp = (await call("GET", "/tasks/assigned/people", CHI.tok)).b.people.map((p) => p.code);
    const cpRows = await q(`select "employeeCode" c, "platformId" p, role::text r, status::text s from users where "employeeCode" = any($1)`, [cp]);
    ok("his list holds company B's employees (Ethree, Efour) and none of Saurabh's people", ["TAC-E3", "TAC-E4"].every((c) => cp.includes(c)) && !["TAC-E1", "TAC-E2", "TAC-REG"].some((c) => cp.includes(c)), cp);
    ok("EVERY person in his list is an active EMPLOYEE of Chirag's own company", cpRows.length === cp.length && cpRows.every((r) => r.p === B && r.r === "EMPLOYEE" && r.s === "ACTIVE"), cpRows.filter((r) => r.p !== B));
    ok("he assigns to Ethree", (await call("POST", "/tasks/assigned", CHI.tok, { userId: E3.id, title: "TAC from Chirag to E3", priority: "LOW" })).s === 200 && (await notes(E3.id, "TASK_ASSIGNED")) === 1);
    ok("Ethree sees it in Assigned tasks", (await call("GET", "/tasks/assigned/mine", E3.tok)).b.tasks.some((t) => t.title === "TAC from Chirag to E3" && t.assignedBy === "Chirag Parmar"));
    ok("Chirag cannot assign to company A's people", (await call("POST", "/tasks/assigned", CHI.tok, { userId: E1.id, title: "TAC cross company" })).s === 403 && !(await idOf("TAC cross company")));
    ok("Chirag's list shows only his own task, Saurabh's list only his own", (await call("GET", "/tasks/assigned/by-me", CHI.tok)).b.tasks.every((t) => t.assignedById === CHI.id) && (await call("GET", "/tasks/assigned/by-me", SAU.tok)).b.tasks.every((t) => t.assignedById === SAU.id));
    ok("Ethree completes it, Chirag is told, and Chirag cannot confirm", (await call("POST", `/tasks/assigned/${await idOf("TAC from Chirag to E3")}/progress`, E3.tok, { to: "COMPLETED" })).s === 200 && (await notes(CHI.id, "ASSIGNED_TASK_DONE")) === 1 && (await call("POST", `/tasks/assigned/${await idOf("TAC from Chirag to E3")}/confirm`, CHI.tok, {})).s === 403);

    console.log("\n## 8. Everyone else: no assignment rights");
    for (const [n, u] of [["a regular employee (Plain)", REG], ["another employee of company A", E1], ["HR", HR]]) {
      ok(`${n}: canAssignCompany is false, and the endpoints refuse`, (await call("GET", "/tasks", u.tok)).b.canAssignCompany !== true && (await call("GET", "/tasks/assigned/people", u.tok)).s === 403 && (await call("POST", "/tasks/assigned", u.tok, { userId: E2.id, title: "TAC sneaky" })).s === 403 && (await call("GET", "/tasks/assigned/by-me", u.tok)).s === 403);
    }
    ok("no sneaky task exists", !(await idOf("TAC sneaky")));
    ok("a manager and an Admin keep their own assignment rights (unchanged)", (await call("GET", "/tasks/assigned/people", MGR.tok)).s === 200 && (await call("GET", "/tasks/assigned/people", ADMIN.tok)).s === 200);

    console.log("\n## 9. The capability follows the account, immediately");
    await q(`delete from user_capabilities where "userId"=$1`, [SAU.id]);
    ok("remove the row and Saurabh's rights stop at once", (await call("POST", "/tasks/assigned", SAU.tok, { userId: E2.id, title: "TAC after removal" })).s === 403 && (await call("GET", "/tasks", SAU.tok)).b.canAssignCompany === false);
    ok("the tasks he assigned earlier stay with their employees (history kept)", (await call("GET", "/tasks/assigned/mine", E1.tok)).b.tasks.some((t) => t.title === "TAC from Saurabh to E1"));
    await q(`insert into user_capabilities ("userId", capability) values ($1,'TASK_ASSIGN_COMPANY')`, [SAU.id]);
    await q(`update users set role='HR' where id=$1`, [SAU.id]);
    ok("a leftover capability row is ignored once the person is no longer an Employee (their new role's rules apply)", (await call("GET", "/tasks/assigned/people", SAU.tok)).s === 403);
    await q(`update users set role='EMPLOYEE' where id=$1`, [SAU.id]);
    await q(`update users set status='SUSPENDED' where id=$1`, [SAU.id]);
    ok("and for a suspended account", (await call("GET", "/tasks/assigned/people", SAU.tok)).s === 401 || (await call("GET", "/tasks/assigned/people", SAU.tok)).s === 403);
    await q(`update users set status='ACTIVE' where id=$1`, [SAU.id]);
  } finally {
    await wipe().catch((e) => console.log("wipe note:", e.message));
    await q(`drop table if exists user_capabilities`);
    await db.end();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
