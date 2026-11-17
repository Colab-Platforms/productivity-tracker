// HR as a reporting manager may approve that employee's tasks (and only those): real sign-ins, real HTTP, disposable DB only.
//   cd backend && TEST_DATABASE_URL=... TEST_API=http://localhost:5012/api node tests/hr-task-approval.test.cjs
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
const ok = (n, c, x) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  -> " + String(JSON.stringify(x)).slice(0, 400))); };
const PW = "Tha@12345678";

(async () => {
  const db = new Client({ connectionString: process.env.TEST_DATABASE_URL }); await db.connect();
  const q = async (s, p) => (await db.query(s, p)).rows;
  const AV = (await q(`select id from platforms where slug='avatar'`))[0].id;
  const hash = await bcrypt.hash(PW, 10);
  const wipe = async () => {
    const ids = `(select id from users where "employeeCode" like 'THA-%')`;
    await q(`delete from task_entry_details where "taskId" in (select id from daily_tasks where "userId" in ${ids})`);
    await q(`delete from daily_tasks where "userId" in ${ids}`);
    await q(`delete from team_members where "userId" in ${ids}`);
    await q(`delete from teams where name like 'THA-%'`);
    await q(`delete from notifications where "userId" in ${ids}`);
    await q(`delete from users where "employeeCode" like 'THA-%'`);
  };
  await wipe();
  const mk = async (code, role, o = {}) => {
    await q(`insert into users (id,"platformId",email,"passwordHash","firstName","lastName","employeeCode",role,status,"mustChangePassword","trackerAccessEnabled","onboardingStatus","reportsToId","dateOfJoining","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,$4,'Tha',$5,$6,'ACTIVE',false,true,'ACTIVE',$7,'2026-01-01',now(),now())`, [AV, code.toLowerCase() + "@tha.test", hash, o.first ?? code.replace("THA-", ""), code, role, o.boss ?? null]);
    const id = (await q(`select id from users where "employeeCode"=$1`, [code]))[0].id;
    const tok = (await (await fetch(API + "/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: code, password: PW }) })).json()).token;
    return { id, tok };
  };
  const ADMIN = await mk("THA-ADMIN", "ADMIN", { first: "AdminTha" });
  const HR = await mk("THA-HR", "HR", { first: "HrBoss", boss: ADMIN.id });
  const HR2 = await mk("THA-HR2", "HR", { first: "HrOther", boss: ADMIN.id });
  const MGR = await mk("THA-MGR", "MANAGER", { first: "Mgr", boss: ADMIN.id });
  const E1 = await mk("THA-E1", "EMPLOYEE", { first: "UnderHr", boss: HR.id }); // reports to HR
  const E2 = await mk("THA-E2", "EMPLOYEE", { first: "UnderMgr", boss: MGR.id }); // reports to the manager
  const teamId = (await q(`insert into teams (id,"platformId",name,"managerId","isActive","createdAt","updatedAt") values (gen_random_uuid(),$1,'THA-Proj',$2,true,now(),now()) returning id`, [AV, MGR.id]))[0].id;
  for (const u of [E1, E2]) await q(`insert into team_members (id,"teamId","userId","isActive","isPrimary","joinedAt") values (gen_random_uuid(),$1,$2,true,false,now())`, [teamId, u.id]);

  const queue = async (who) => (await call("GET", "/tasks/review/queue", who.tok)).b;
  const has = (list, title) => (list ?? []).some((t) => t.title === title);
  const row = (res, title) => (res.all ?? []).find((t) => t.title === title);
  const post = async (who, title, tagged) => call("POST", "/tasks", who.tok, { title, teamId, taggedManagerId: tagged, progress: "IN_PROGRESS", hoursSpent: 1 });
  const idOf = async (title) => (await q(`select id from daily_tasks where title=$1`, [title]))[0]?.id;

  try {
    console.log("## 1. The tag list and the default");
    const f1 = (await call("GET", "/tasks", E1.tok)).b.entryForm;
    const f2 = (await call("GET", "/tasks", E2.tok)).b.entryForm;
    ok("an employee whose reporting manager is HR is offered that HR person as an approver (role HR)", f1.managers.some((m) => m.id === HR.id && m.role === "HR"), f1.managers);
    ok("...and that HR person is pre-selected for them", f1.defaults.managerId === HR.id, f1.defaults);
    ok("a different HR person is NOT offered", !f1.managers.some((m) => m.id === HR2.id), f1.managers);
    ok("an employee under a Manager is not offered any HR person", !f2.managers.some((m) => m.role === "HR") && f2.defaults.managerId === MGR.id, f2);
    const bad = await post(E2, "THA bad tag", HR.id);
    ok("an employee NOT under HR cannot tag that HR person (400)", bad.s === 400, bad);
    const bad2 = await post(E1, "THA bad tag 2", HR2.id);
    ok("nor can the HR employee tag a different HR person (400)", bad2.s === 400, bad2);

    console.log("\n## 2. HR approves a task tagged to them");
    const t1 = "THA task to HR";
    const p1 = await post(E1, t1, HR.id);
    ok("employee submits a task tagged to their HR reporting manager", p1.s === 200 || p1.s === 201, p1);
    const id1 = await idOf(t1);
    const qh = await queue(HR);
    ok("HR sees it under Needs Approval with an action (canAct)", has(qh.proposals, t1) && row(qh, t1)?.canAct === true, qh.proposals?.map((t) => t.title));
    const notes = await q(`select count(*)::int n from notifications where "userId"=$1 and type='TASK_PROPOSED'`, [HR.id]);
    ok("HR was notified (once)", notes[0].n === 1, notes);
    const ap = await call("POST", `/tasks/review/${id1}/approve`, HR.tok, { approve: true });
    ok("HR approves it (200)", ap.s === 200, ap);
    const st = (await q(`select "approvalStatus", "approvedById" from daily_tasks where id=$1`, [id1]))[0];
    ok("it is APPROVED and the approver on record is the HR person", st.approvalStatus === "APPROVED" && st.approvedById === HR.id, st);
    const qh2 = await queue(HR);
    ok("the approval history shows who decided", row(qh2, t1)?.decidedBy === "HrBoss Tha", row(qh2, t1));

    console.log("\n## 3. Everyone else is unchanged");
    const t2 = "THA task to HR second";
    await post(E1, t2, HR.id);
    const id2 = await idOf(t2);
    const mApprove = await call("POST", `/tasks/review/${id2}/approve`, MGR.tok, { approve: true });
    ok("a Manager cannot approve a task tagged to HR (403)", mApprove.s === 403 || mApprove.s === 404, mApprove);
    ok("...and does not see it", !has((await queue(MGR)).all, t2));
    const h2q = await queue(HR2);
    ok("another HR person does not see the waiting task", !has(h2q.all, t2) && !has(h2q.proposals, t2), h2q.all?.length);
    const h2Approve = await call("POST", `/tasks/review/${id2}/approve`, HR2.tok, { approve: true });
    ok("another HR person cannot approve it (403)", h2Approve.s === 403 || h2Approve.s === 404, h2Approve);
    const adq = await queue(ADMIN);
    ok("an Admin sees it for monitoring only (canAct false)", row(adq, t2)?.canAct === false && !has(adq.proposals, t2), row(adq, t2));
    const adApprove = await call("POST", `/tasks/review/${id2}/approve`, ADMIN.tok, { approve: true });
    ok("an Admin who is not tagged cannot approve it (403)", adApprove.s === 403 || adApprove.s === 404, adApprove);

    console.log("\n## 4. HR can reject a task tagged to them, with a reason");
    const rj = await call("POST", `/tasks/review/${id2}/approve`, HR.tok, { approve: false, rejectionNote: "Please add detail" });
    ok("HR rejects it (200) and it is REJECTED", rj.s === 200 && (await q(`select "approvalStatus" from daily_tasks where id=$1`, [id2]))[0].approvalStatus === "REJECTED", rj);

    console.log("\n## 5. HR still cannot decide anything that is not tagged to them");
    const t3 = "THA task to manager";
    await post(E1, t3, MGR.id); // the HR employee tags a manager instead
    const id3 = await idOf(t3);
    ok("HR does not see a task the employee tagged to a Manager", !has((await queue(HR)).all, t3));
    const hApprove3 = await call("POST", `/tasks/review/${id3}/approve`, HR.tok, { approve: true });
    ok("HR cannot approve it, although they are the employee's reporting manager (403)", hApprove3.s === 403 || hApprove3.s === 404, hApprove3);
    ok("the tagged Manager can", (await call("POST", `/tasks/review/${id3}/approve`, MGR.tok, { approve: true })).s === 200);
    const t4 = "THA legacy untagged";
    await post(E1, t4, MGR.id);
    const id4 = await idOf(t4);
    await q(`delete from task_entry_details where "taskId"=$1`, [id4]); // an old task with no tag
    ok("an old untagged task is not shown to HR", !has((await queue(HR)).all, t4));
    const hApprove4 = await call("POST", `/tasks/review/${id4}/approve`, HR.tok, { approve: true });
    ok("HR cannot approve an untagged task even as reporting manager (403)", hApprove4.s === 403 || hApprove4.s === 404, hApprove4);
    const t5 = "THA task tagged to HR by other employee";
    const e2Tag = await post(E2, t5, MGR.id);
    ok("an employee under a Manager still submits to the Manager as before", e2Tag.s === 200 || e2Tag.s === 201, e2Tag);
    ok("HR never sees that employee's waiting task", !has((await queue(HR)).all, t5));
    ok("the Manager sees and can approve it", has((await queue(MGR)).proposals, t5) && (await call("POST", `/tasks/review/${await idOf(t5)}/approve`, MGR.tok, { approve: true })).s === 200);

    console.log("\n## 6. After the reporting line moves, a submitted task stays with the tagged person");
    const t6 = "THA moved line";
    await post(E1, t6, HR.id);
    await q(`update users set "reportsToId"=$1 where id=$2`, [MGR.id, E1.id]);
    ok("a task already tagged to HR is still HR's to decide", has((await queue(HR)).proposals, t6), (await queue(HR)).proposals?.length);
    const fMoved = (await call("GET", "/tasks", E1.tok)).b.entryForm;
    ok("but the employee is no longer offered HR for NEW tasks", !fMoved.managers.some((m) => m.id === HR.id), fMoved.managers);
    ok("HR can still approve the already-tagged task (200)", (await call("POST", `/tasks/review/${await idOf(t6)}/approve`, HR.tok, { approve: true })).s === 200);
  } finally {
    await wipe();
    await db.end();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
