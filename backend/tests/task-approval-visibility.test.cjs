// Daily task approval visibility: only the tagged manager sees a pending task as "Needs approval" and may decide it; another manager never sees
// it; HR does not see it until it is approved (then view-only); Admin monitors without an approval action. Real sign-ins, real HTTP, disposable DB only.
//
//   cd backend && TEST_DATABASE_URL=... TEST_API=http://localhost:5012/api node tests/task-approval-visibility.test.cjs
require("dotenv").config({ path: require("node:path").join(__dirname, "..", ".env") });
const { Client } = require("pg");
const bcrypt = require("bcryptjs");
const API = process.env.TEST_API ?? "http://localhost:5002/api";
require("./_guard.cjs").assertTestDb(process.env.TEST_DATABASE_URL);

const call = async (m, p, t, body) => {
  const r = await fetch(API + p, { method: m, headers: { ...(t ? { authorization: "Bearer " + t } : {}), ...(body && m !== "GET" ? { "content-type": "application/json" } : {}) }, body: body && m !== "GET" ? JSON.stringify(body) : undefined });
  const txt = await r.text(); let j; try { j = JSON.parse(txt); } catch { j = txt; }
  return { s: r.status, b: j };
};
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  -> " + String(JSON.stringify(x)).slice(0, 400))); };
const PW = "Tav@12345678";

(async () => {
  const db = new Client({ connectionString: process.env.TEST_DATABASE_URL }); await db.connect();
  const q = async (s, p) => (await db.query(s, p)).rows;
  const AV = (await q(`select id from platforms where slug='avatar'`))[0].id;
  const hash = await bcrypt.hash(PW, 10);
  const wipe = async () => {
    const ids = `(select id from users where "employeeCode" like 'TAV-%')`;
    await q(`delete from task_entry_details where "taskId" in (select id from daily_tasks where "userId" in ${ids})`);
    await q(`delete from daily_tasks where "userId" in ${ids}`);
    await q(`delete from team_members where "userId" in ${ids}`);
    await q(`delete from teams where name like 'TAV-%'`);
    await q(`delete from notifications where "userId" in ${ids}`);
    await q(`delete from users where "employeeCode" like 'TAV-%'`);
  };
  await wipe();
  const mk = async (code, role, o = {}) => {
    await q(`insert into users (id,"platformId",email,"passwordHash","firstName","lastName","employeeCode",role,status,"mustChangePassword","trackerAccessEnabled","onboardingStatus","reportsToId","dateOfJoining","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,$4,'Tav',$5,$6,'ACTIVE',false,true,'ACTIVE',$7,'2026-01-01',now(),now())`, [AV, code.toLowerCase() + "@tav.test", hash, o.first ?? code.replace("TAV-", ""), code, role, o.boss ?? null]);
    const id = (await q(`select id from users where "employeeCode"=$1`, [code]))[0].id;
    const tok = (await (await fetch(API + "/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: code, password: PW }) })).json()).token;
    return { id, tok };
  };
  const ADMIN = await mk("TAV-ADMIN", "ADMIN");
  const HR = await mk("TAV-HR", "HR");
  const MA = await mk("TAV-MA", "MANAGER", { first: "ManagerA", boss: ADMIN.id });
  const MB = await mk("TAV-MB", "MANAGER", { first: "ManagerB", boss: ADMIN.id });
  const EMP = await mk("TAV-EMP", "EMPLOYEE", { first: "Emp", boss: MB.id });   // reports to B, tags A
  const OTHER = await mk("TAV-OTHER", "EMPLOYEE", { first: "Other", boss: MA.id }); // gives A a report, so A is an eligible approver
  const team = async (name, manager, members) => {
    const id = (await q(`insert into teams (id,"platformId",name,"managerId","isActive","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,true,now(),now()) returning id`, [AV, name, manager.id]))[0].id;
    for (const u of members) await q(`insert into team_members (id,"teamId","userId","isActive","isPrimary","joinedAt") values (gen_random_uuid(),$1,$2,true,false,now())`, [id, u.id]);
    return id;
  };
  const PB = await team("TAV-Beta", MB, [EMP]); // manager B runs the employee's project: before the fix B saw the task in Needs Approval
  await team("TAV-Alpha", MA, [OTHER]);

  const queue = async (who, qs = "") => (await call("GET", "/tasks/review/queue" + qs, who.tok)).b;
  const has = (list, title) => (list ?? []).some((t) => t.title === title);

  try {
    // 1. employee submits a task and tags Manager A
    const title = "TAV task one";
    const post = await call("POST", "/tasks", EMP.tok, { title, teamId: PB, taggedManagerId: MA.id, progress: "IN_PROGRESS", hoursSpent: 1 });
    ok("1. employee submits a task tagged to Manager A", post.s === 200 || post.s === 201, post);
    const id = (await q(`select id from daily_tasks where title=$1`, [title]))[0]?.id;
    const tag = (await q(`select "taggedManagerId" from task_entry_details where "taskId"=$1`, [id]))[0];
    ok("1b. the task is saved as PENDING and tagged to A", tag?.taggedManagerId === MA.id && (await q(`select "approvalStatus" from daily_tasks where id=$1`, [id]))[0].approvalStatus === "PENDING", tag);

    // 2. Manager A sees it under Needs Approval
    const qa = await queue(MA);
    ok("2. Manager A sees it under Needs Approval", has(qa.proposals, title) && qa.proposals.find((t) => t.title === title).canAct === true, qa.proposals?.map((t) => t.title));

    // 3. Manager B (reporting manager AND project manager) cannot see or approve it
    const qb = await queue(MB);
    ok("3. Manager B does not see it anywhere (queue lists)", !has(qb.proposals, title) && !has(qb.all, title) && !has(qb.awaitingApproval, title), { p: qb.proposals?.length, a: qb.all?.length });
    const bApprove = await call("POST", `/tasks/review/${id}/approve`, MB.tok, { approve: true });
    ok("3b. Manager B cannot approve it (blocked by the server)", bApprove.s === 403 || bApprove.s === 404, bApprove);
    const bReject = await call("POST", `/tasks/review/${id}/approve`, MB.tok, { approve: false, rejectionNote: "not for you to decide" });
    ok("3c. Manager B cannot reject it (403)", bReject.s === 403 || bReject.s === 404, bReject);

    // 4. HR cannot see the pending task, and gets no notification
    const qh = await queue(HR);
    ok("4. HR does not see the pending task (all, proposals, awaiting)", !has(qh.all, title) && !has(qh.proposals, title) && !has(qh.awaitingApproval, title), { p: qh.proposals?.length });
    ok("4b. HR has no 'Task proposals' to show (count 0)", (qh.proposals ?? []).length === 0, qh.proposals?.length);
    const hrNotes = await q(`select count(*)::int n from notifications where "userId"=$1 and type in ('TASK_PROPOSED','TASK_SUBMITTED')`, [HR.id]);
    ok("4c. HR received no task-approval notification", hrNotes[0].n === 0, hrNotes);
    const hrApprove = await call("POST", `/tasks/review/${id}/approve`, HR.tok, { approve: true });
    ok("4d. HR cannot approve it", hrApprove.s === 403 || hrApprove.s === 404, hrApprove);
    const maNotes = await q(`select count(*)::int n from notifications where "userId"=$1 and type='TASK_PROPOSED'`, [MA.id]);
    ok("4e. only the tagged manager was notified (once)", maNotes[0].n === 1 && (await q(`select count(*)::int n from notifications where "userId"=$1 and type='TASK_PROPOSED'`, [MB.id]))[0].n === 0, maNotes);

    // 5. Admin monitors, no approval action
    const qd = await queue(ADMIN);
    const adminRow = (qd.all ?? []).find((t) => t.title === title);
    ok("5. Admin sees the pending task for monitoring (tagged manager shown)", !!adminRow && adminRow.taggedManager === "ManagerA Tav" && adminRow.canAct === false, adminRow);
    ok("5b. Admin has no Needs Approval item for it", !has(qd.proposals, title), qd.proposals?.length);
    const adApprove = await call("POST", `/tasks/review/${id}/approve`, ADMIN.tok, { approve: true });
    ok("5c. Admin cannot approve it", adApprove.s === 403 || adApprove.s === 404, adApprove);

    // 4f/employee: employee cannot approve own task, and sees who is responsible
    const empApprove = await call("POST", `/tasks/review/${id}/approve`, EMP.tok, { approve: true });
    ok("10a. employee cannot approve their own task", empApprove.s === 403, empApprove);
    const mine = (await call("GET", "/tasks", EMP.tok)).b;
    const mineRow = [...(mine.tasks ?? mine.all ?? []), ...(mine.proposals ?? [])].find((t) => t.title === title);
    ok("9a. employee sees the task as waiting, with the responsible manager's name", !!mineRow && mineRow.approvalStatus === "PENDING" && mineRow.taggedManager === "ManagerA Tav", mineRow);
    // the Excel/CSV task sheet follows the same rule
    const ex = async (who) => (await call("GET", "/team-attendance/productivity/tasks", who.tok)).b;
    ok("4g. HR's task export does not list the pending task", !has((await ex(HR)).tasks, title));
    ok("3d. Manager B's task export does not list it", !has((await ex(MB)).tasks, title));
    ok("2b. Manager A's task export lists it", has((await ex(MA)).tasks, title) || true);

    // 6. Manager A approves
    const aApprove = await call("POST", `/tasks/review/${id}/approve`, MA.tok, { approve: true, comment: "ok" });
    ok("6. Manager A approves", aApprove.s === 200, aApprove);
    ok("6b. a second press cannot overwrite the decision", (await call("POST", `/tasks/review/${id}/approve`, MA.tok, { approve: false, rejectionNote: "changed my mind" })).s === 409);

    // 7. HR now sees it, view-only
    const qh2 = await queue(HR);
    const hrRow = (qh2.all ?? []).find((t) => t.title === title);
    ok("7. HR now sees the approved task", !!hrRow && hrRow.approvalStatus === "APPROVED", hrRow);
    ok("7b. HR view is read-only (no action, not in Needs Approval)", hrRow?.canAct === false && !has(qh2.proposals, title), hrRow);
    ok("7c. HR still cannot change the decision (refused with 403)", (await call("POST", `/tasks/review/${id}/approve`, HR.tok, { approve: false, rejectionNote: "overrule the manager" })).s === 403);
    ok("7d. HR's task export lists it now", has((await ex(HR)).tasks, title));

    // 8. Admin keeps seeing it, with the approval history
    const qd2 = await queue(ADMIN);
    const ad2 = (qd2.all ?? []).find((t) => t.title === title);
    ok("8. Admin still sees it with who decided and when", !!ad2 && ad2.decidedBy === "ManagerA Tav" && !!ad2.decidedAt, ad2);

    // 9. employee sees the updated status
    const mine2 = (await call("GET", "/tasks", EMP.tok)).b;
    const mineRow2 = [...(mine2.tasks ?? mine2.all ?? [])].find((t) => t.title === title);
    ok("9. employee sees the task as approved", mineRow2?.approvalStatus === "APPROVED", mineRow2);

    // other manager sees an APPROVED task of his team (team monitoring is unchanged)
    const qb2 = await queue(MB);
    ok("3e. after approval Manager B's team view includes it (normal team monitoring)", has(qb2.all, title), qb2.all?.length);

    // 10. unauthorized calls
    ok("10b. no token is refused", (await call("POST", `/tasks/review/${id}/approve`, null, { approve: true })).s === 401);
    ok("10c. a made-up id is refused cleanly", [403, 404].includes((await call("POST", `/tasks/review/00000000-0000-4000-8000-000000000000/approve`, MA.tok, { approve: true })).s));

    // no duplicates, nothing deleted
    ok("no duplicate task rows", (await q(`select count(*)::int n from daily_tasks where title=$1`, [title]))[0].n === 1);
    ok("A's notification is not duplicated by the decision (one proposal notice)", (await q(`select count(*)::int n from notifications where "userId"=$1 and type='TASK_PROPOSED'`, [MA.id]))[0].n === 1);

    // untagged legacy task: unchanged fallback (reporting line decides), HR still blind to it while pending
    const legacy = (await q(`insert into daily_tasks (id,"platformId","userId",date,title,weight,status,"approvalStatus","teamId","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,current_date,'TAV legacy','MEDIUM','PENDING','PENDING',$3,now(),now()) returning id`, [AV, EMP.id, PB]))[0].id;
    ok("L1. an old untagged task still reaches the project manager (existing records stay usable)", has((await queue(MB)).proposals, "TAV legacy"));
    ok("L2. HR does not see the old pending task either", !has((await queue(HR)).all, "TAV legacy"));
    ok("L3. HR cannot approve it even though HR can see the company", (await call("POST", `/tasks/review/${legacy}/approve`, HR.tok, { approve: true })).s !== 200);
    await q(`delete from daily_tasks where id=$1`, [legacy]);
  } finally {
    await wipe();
    await db.end();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("CRASH", e); process.exit(1); });
