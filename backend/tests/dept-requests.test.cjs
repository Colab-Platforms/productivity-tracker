// Query Desk department requests: employee -> reporting manager -> Admin -> tagged department -> employee confirms or reopens.
// Disposable database only (the guard refuses the .env database).
//
//   cd backend && TEST_DATABASE_URL=postgresql://postgres:localtest@localhost:54329/dq_test TEST_API=http://localhost:5012/api node tests/dept-requests.test.cjs
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
const PW = "Tdq@12345678";

(async () => {
  const db = new Client({ connectionString: DB }); await db.connect();
  const q = async (s, p) => (await db.query(s, p)).rows;
  const A = (await q(`select id from platforms where slug='avatar'`))[0].id;
  const B = (await q(`select id from platforms where slug='co-lab'`))[0].id;
  const hash = await bcrypt.hash(PW, 10);

  const wipe = async () => {
    const ids = (await q(`select id from users where "employeeCode" like 'TDQ-%'`)).map((r) => r.id);
    await q(`delete from dept_requests where "raisedById" = any($1)`, [ids]).catch(() => {});
    await q(`delete from departments where name like 'TDQ %'`).catch(() => {});
    if (ids.length) {
      await q(`delete from notifications where "userId" = any($1)`, [ids]);
      await q(`update audit_logs set "actorId" = null where "actorId" = any($1)`, [ids]).catch(() => {});
    }
    await q(`delete from users where "employeeCode" like 'TDQ-%'`).catch(() => {});
  };
  await wipe();
  const mk = async (code, first, role, reportsTo, platform = A, status = "ACTIVE") => (await q(`insert into users (id,"platformId",email,"passwordHash","firstName","lastName","employeeCode",role,status,"mustChangePassword","trackerAccessEnabled","onboardingStatus","dateOfJoining","reportsToId","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,$4,'Tdq',$5,$6,$8,false,true,'ACTIVE','2026-01-01',$7,now(),now()) returning id`, [platform, code.toLowerCase() + "@tdq.test", hash, first, code, role, reportsTo ?? null, status]))[0].id;
  const login = async (code) => (await (await fetch(API + "/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: code, password: PW }) })).json()).token;
  const notes = async (uid, type) => Number((await q(`select count(*)::int c from notifications where "userId"=$1 and type=$2`, [uid, type]))[0].c);
  const dbReq = async (id) => (await q(`select "approvalStatus", "workStatus", "assigneeId", "confirmedAt", "reopenCount" from dept_requests where id=$1`, [id]))[0];

  // People: Admin1 is above Mgr1; Admin2 is another Admin; Ritika reports to Mgr1.
  const AD1 = await mk("TDQ-AD1", "Adminone", "ADMIN"), AD2 = await mk("TDQ-AD2", "Admintwo", "ADMIN");
  const MG1 = await mk("TDQ-MG1", "Mgrone", "MANAGER", AD1), MG2 = await mk("TDQ-MG2", "Mgrtwo", "MANAGER", AD1);
  const HR = await mk("TDQ-HR", "Hrp", "HR");
  const RIT = await mk("TDQ-RIT", "Ritika", "EMPLOYEE", MG1);
  const OTH = await mk("TDQ-OTH", "Other", "EMPLOYEE", MG2);
  const NOM = await mk("TDQ-NOM", "Nomanager", "EMPLOYEE", null);
  const UNDERAD = await mk("TDQ-UAD", "Underadmin", "EMPLOYEE", AD1);
  const IT1 = await mk("TDQ-IT1", "Itone", "EMPLOYEE", MG2), IT2 = await mk("TDQ-IT2", "Ittwo", "EMPLOYEE", MG2);
  const ACC = await mk("TDQ-ACC", "Acct", "EMPLOYEE", MG2);
  const FOREIGN = await mk("TDQ-FOR", "Foreign", "EMPLOYEE", null, B);
  const tok = {};
  for (const c of ["AD1", "AD2", "MG1", "MG2", "HR", "RIT", "OTH", "NOM", "UAD", "IT1", "IT2", "ACC", "FOR"]) tok[c] = await login("TDQ-" + c);

  console.log("\n## departments (Admin keeps them; the dropdown reads them)");
  ok("an employee cannot create a department", (await call("POST", "/queries/dept/admin/departments", tok.RIT, { name: "TDQ Sneaky" })).s === 403);
  ok("HR cannot create a department", (await call("POST", "/queries/dept/admin/departments", tok.HR, { name: "TDQ Sneaky" })).s === 403);
  const dIT = (await call("POST", "/queries/dept/admin/departments", tok.AD1, { name: "TDQ IT Department", platformId: A })).b.id;
  const dAcc = (await call("POST", "/queries/dept/admin/departments", tok.AD1, { name: "TDQ Accounts & Finance", platformId: A })).b.id;
  ok("departments created", !!dIT && !!dAcc);
  ok("a duplicate name (any capitals) is refused", (await call("POST", "/queries/dept/admin/departments", tok.AD1, { name: "tdq it department", platformId: A })).s === 409);
  ok("a one-letter name is refused", (await call("POST", "/queries/dept/admin/departments", tok.AD1, { name: "x", platformId: A })).s === 400);
  const dForeign = (await call("POST", "/queries/dept/admin/departments", tok.AD1, { name: "TDQ Other Company IT", platformId: B })).b.id;
  ok("Admin sets the members of a department", (await call("POST", `/queries/dept/admin/departments/${dIT}`, tok.AD1, { memberIds: [IT1, IT2] })).s === 200);
  ok("a person of another company cannot be a member", (await call("POST", `/queries/dept/admin/departments/${dAcc}`, tok.AD1, { memberIds: [FOREIGN] })).s === 400);
  ok("accounts has one member", (await call("POST", `/queries/dept/admin/departments/${dAcc}`, tok.AD1, { memberIds: [ACC] })).s === 200);
  const pick = (await call("GET", "/queries/dept/departments", tok.RIT)).b;
  ok("the dropdown lists the company's departments only", pick.ready && pick.departments.some((d) => d.id === dIT) && pick.departments.some((d) => d.id === dAcc) && !pick.departments.some((d) => d.id === dForeign), pick);

  console.log("\n## raising: required fields and tagging");
  const good = { title: "PC Cleaning Request", description: "My office PC requires cleaning and maintenance.", departmentId: dIT, priority: "MEDIUM" };
  ok("no title -> 400", (await call("POST", "/queries/dept", tok.RIT, { ...good, title: "" })).s === 400);
  ok("no department -> 400", (await call("POST", "/queries/dept", tok.RIT, { ...good, departmentId: "" })).s === 400);
  ok("not a department id -> 400", (await call("POST", "/queries/dept", tok.RIT, { ...good, departmentId: "11111111-1111-1111-1111-111111111111" })).s === 400);
  ok("another company's department -> 400 (incorrect tagging)", (await call("POST", "/queries/dept", tok.RIT, { ...good, departmentId: dForeign })).s === 400);
  ok("bad priority -> 400", (await call("POST", "/queries/dept", tok.RIT, { ...good, priority: "SOON" })).s === 400);
  ok("unsigned request -> 401", (await call("POST", "/queries/dept", null, good)).s === 401);

  console.log("\n## the whole example: Ritika -> manager -> Admin -> IT -> confirm");
  const c1 = await call("POST", "/queries/dept", tok.RIT, good);
  const R = c1.b.id;
  ok("raised, status Pending Manager Approval", c1.s === 200 && c1.b.stage === "PENDING_MANAGER" && /^DQ-\d{6}$/.test(c1.b.reference), c1.b);
  let row = await dbReq(R);
  ok("no department work status yet", row.approvalStatus === "PENDING_MANAGER" && row.workStatus === null, row);
  ok("ONLY her reporting manager was notified", (await notes(MG1, "DEPT_QUERY_MANAGER_REVIEW")) === 1 && (await notes(MG2, "DEPT_QUERY_MANAGER_REVIEW")) === 0 && (await notes(AD1, "DEPT_QUERY_ADMIN_REVIEW")) === 0 && (await notes(IT1, "DEPT_QUERY_FOR_DEPARTMENT")) === 0);
  ok("the department cannot see it yet (404)", (await call("GET", `/queries/dept/${R}`, tok.IT1)).s === 404);
  ok("an unrelated employee cannot see it (404)", (await call("GET", `/queries/dept/${R}`, tok.OTH)).s === 404);
  ok("another manager cannot see it (404)", (await call("GET", `/queries/dept/${R}`, tok.MG2)).s === 404);
  ok("her manager sees it", (await call("GET", `/queries/dept/${R}`, tok.MG1)).s === 200);
  ok("HR can monitor it", (await call("GET", `/queries/dept/${R}`, tok.HR)).s === 200);
  ok("HR cannot approve (not an approver)", (await call("POST", `/queries/dept/${R}/manager-decision`, tok.HR, { approve: true })).s === 404);
  ok("the Admin cannot skip the manager (409)", (await call("POST", `/queries/dept/${R}/admin-decision`, tok.AD1, { approve: true })).s === 409);
  ok("another manager cannot decide (404)", (await call("POST", `/queries/dept/${R}/manager-decision`, tok.MG2, { approve: true })).s === 404);
  ok("Ritika cannot approve her own query", (await call("POST", `/queries/dept/${R}/manager-decision`, tok.RIT, { approve: true })).s === 404);
  ok("the department cannot accept it before approval", (await call("POST", `/queries/dept/${R}/accept`, tok.IT1)).s === 404);
  const mlist = (await call("GET", "/queries/dept?view=APPROVE", tok.MG1)).b;
  ok("it is in the manager's 'to approve' view", mlist.items.some((i) => i.id === R && i.needsYou), mlist.counts);
  const cnt = (await call("GET", "/queries/counts", tok.MG1)).b;
  ok("the sidebar badge counts it", cnt.badge >= 1, cnt);

  // two clicks at the same moment: one decision, one notification
  const [d1, d2] = await Promise.all([1, 2].map(() => call("POST", `/queries/dept/${R}/manager-decision`, tok.MG1, { approve: true, note: "Fine, go ahead (internal)" })));
  ok("a double approval records ONE decision", [d1.s, d2.s].sort().join() === "200,409", [d1, d2]);
  row = await dbReq(R);
  ok("status is Pending Admin Approval", row.approvalStatus === "PENDING_ADMIN" && row.workStatus === null, row);
  ok("Admin1 (mapped) was notified exactly once", (await notes(AD1, "DEPT_QUERY_ADMIN_REVIEW")) === 1);
  ok("the other Admin was NOT asked (mapped Admin only)", (await notes(AD2, "DEPT_QUERY_ADMIN_REVIEW")) === 0);
  ok("a second manager answer is refused (409)", (await call("POST", `/queries/dept/${R}/manager-decision`, tok.MG1, { approve: false, note: "changed my mind" })).s === 409);
  ok("the department still cannot see it", (await call("GET", `/queries/dept/${R}`, tok.IT1)).s === 404);
  ok("the other Admin cannot decide (404)", (await call("POST", `/queries/dept/${R}/admin-decision`, tok.AD2, { approve: true })).s === 404);
  ok("the manager cannot give the final approval", (await call("POST", `/queries/dept/${R}/admin-decision`, tok.MG1, { approve: true })).s === 404);
  const forRit = (await call("GET", `/queries/dept/${R}`, tok.RIT)).b;
  ok("the employee does NOT see the manager's approval comment", !JSON.stringify(forRit.timeline).includes("internal"), forRit.timeline);
  const forAd = (await call("GET", `/queries/dept/${R}`, tok.AD1)).b;
  ok("the Admin sees it, with the manager's comment and who is responsible", JSON.stringify(forAd.timeline).includes("internal") && forAd.permissions.canAdminDecide && forAd.responsible.length === 1, forAd.responsible);

  ok("a rejection without a reason is refused", (await call("POST", `/queries/dept/${R}/admin-decision`, tok.AD1, { approve: false })).s === 400);
  const ad = await call("POST", `/queries/dept/${R}/admin-decision`, tok.AD1, { approve: true, note: "Approved by admin (confidential)" });
  ok("Admin approves", ad.s === 200 && ad.b.approvalStatus === "APPROVED", ad);
  row = await dbReq(R);
  ok("approval APPROVED and work status Awaiting Department Action (two separate fields)", row.approvalStatus === "APPROVED" && row.workStatus === "AWAITING_ACTION", row);
  ok("the tagged department was notified now (both members, once each)", (await notes(IT1, "DEPT_QUERY_FOR_DEPARTMENT")) === 1 && (await notes(IT2, "DEPT_QUERY_FOR_DEPARTMENT")) === 1);
  ok("another department was not notified", (await notes(ACC, "DEPT_QUERY_FOR_DEPARTMENT")) === 0);
  ok("Ritika was told it was approved", (await notes(RIT, "DEPT_QUERY_APPROVED")) === 1);
  ok("the Admin cannot decide twice (409)", (await call("POST", `/queries/dept/${R}/admin-decision`, tok.AD1, { approve: false, note: "nope nope" })).s === 409);
  ok("the accounts department cannot see it (404)", (await call("GET", `/queries/dept/${R}`, tok.ACC)).s === 404);
  const itView = (await call("GET", `/queries/dept/${R}`, tok.IT1)).b;
  ok("an IT member can open it", itView.title === "PC Cleaning Request" && itView.permissions.canAccept, itView);
  ok("the department does NOT see approval comments", !JSON.stringify(itView.timeline).includes("confidential") && !JSON.stringify(itView.timeline).includes("internal"), itView.timeline);
  ok("it is in the department's 'awaiting action' queue", (await call("GET", "/queries/dept?view=DEPT_AWAITING", tok.IT1)).b.items.some((i) => i.id === R));
  ok("not in the accounts queue", !(await call("GET", "/queries/dept?view=DEPT_AWAITING", tok.ACC)).b.items.some((i) => i.id === R));

  console.log("\n## department work");
  ok("an IT member cannot update progress before taking it", (await call("POST", `/queries/dept/${R}/progress`, tok.IT1, { status: "IN_PROGRESS" })).s === 403);
  const [a1, a2] = await Promise.all([call("POST", `/queries/dept/${R}/accept`, tok.IT1), call("POST", `/queries/dept/${R}/accept`, tok.IT2)]);
  ok("two members accept at once: exactly one wins", [a1.s, a2.s].filter((s) => s === 200).length === 1, [a1, a2]);
  const owner = a1.s === 200 ? IT1 : IT2, otherT = a1.s === 200 ? tok.IT2 : tok.IT1, ownerT = a1.s === 200 ? tok.IT1 : tok.IT2;
  row = await dbReq(R);
  ok("assignee recorded, status Not Started", row.assigneeId === owner && row.workStatus === "NOT_STARTED", row);
  ok("Ritika was told someone accepted (once)", (await notes(RIT, "DEPT_QUERY_ACCEPTED")) === 1);
  ok("the other IT member cannot update progress (403)", (await call("POST", `/queries/dept/${R}/progress`, otherT, { status: "IN_PROGRESS" })).s === 403);
  ok("Ritika cannot update progress", (await call("POST", `/queries/dept/${R}/progress`, tok.RIT, { status: "COMPLETED", note: "done by me" })).s === 403);
  ok("not an allowed status -> 400", (await call("POST", `/queries/dept/${R}/progress`, ownerT, { status: "REOPENED" })).s === 400);
  ok("starting from Not Started to Not Started is refused", (await call("POST", `/queries/dept/${R}/progress`, ownerT, { status: "NOT_STARTED" })).s === 400);
  ok("In Progress", (await call("POST", `/queries/dept/${R}/progress`, ownerT, { status: "IN_PROGRESS" })).s === 200);
  const started = (await q(`select "startedAt" from dept_requests where id=$1`, [R]))[0].startedAt;
  ok("start time recorded", !!started);
  ok("On Hold needs a reason", (await call("POST", `/queries/dept/${R}/progress`, ownerT, { status: "ON_HOLD" })).s === 400);
  ok("On Hold with a reason", (await call("POST", `/queries/dept/${R}/progress`, ownerT, { status: "ON_HOLD", note: "Waiting for a cleaning kit" })).s === 200);
  ok("back to In Progress", (await call("POST", `/queries/dept/${R}/progress`, ownerT, { status: "IN_PROGRESS", note: "Kit arrived" })).s === 200);
  ok("start time is not overwritten", String((await q(`select "startedAt" from dept_requests where id=$1`, [R]))[0].startedAt) === String(started));
  ok("Completed needs a note", (await call("POST", `/queries/dept/${R}/progress`, ownerT, { status: "COMPLETED" })).s === 400);
  const hold = (await call("POST", `/queries/dept/${R}/comments`, ownerT, { body: "Internal department chat", visibility: "DEPT" }));
  ok("an IT member writes a department-only note", hold.s === 200);
  ok("and a note for the requester", (await call("POST", `/queries/dept/${R}/comments`, ownerT, { body: "I will come to your desk at 3pm", visibility: "ALL" })).s === 200);
  const seenByRit = (await call("GET", `/queries/dept/${R}`, tok.RIT)).b;
  ok("Ritika sees the progress and the note meant for her, not the department-only one", JSON.stringify(seenByRit.timeline).includes("3pm") && !JSON.stringify(seenByRit.timeline).includes("Internal department chat") && !JSON.stringify(seenByRit.timeline).includes("confidential"), seenByRit.timeline.map((t) => t.note));
  ok("Ritika cannot confirm before completion", (await call("POST", `/queries/dept/${R}/confirm`, tok.RIT)).s === 409);
  ok("an Admin is not a department member, so cannot take the work", [403, 409].includes((await call("POST", `/queries/dept/${R}/accept`, tok.AD1)).s) && (await dbReq(R)).assigneeId === owner);
  const done = await call("POST", `/queries/dept/${R}/progress`, ownerT, { status: "COMPLETED", note: "PC cleaned and tested" });
  ok("Completed", done.s === 200);
  row = await dbReq(R);
  ok("completion time recorded", row.workStatus === "COMPLETED" && !!(await q(`select "completedAt" from dept_requests where id=$1`, [R]))[0].completedAt, row);
  ok("Ritika receives the completion notification", (await notes(RIT, "DEPT_QUERY_COMPLETED")) === 1);
  ok("progress updates were notified (in progress / on hold)", (await notes(RIT, "DEPT_QUERY_PROGRESS")) >= 2);
  ok("work cannot move after completion (403)", (await call("POST", `/queries/dept/${R}/progress`, ownerT, { status: "IN_PROGRESS" })).s === 403);
  ok("another employee cannot confirm", (await call("POST", `/queries/dept/${R}/confirm`, tok.OTH)).s === 404);
  ok("the owner cannot confirm for her", (await call("POST", `/queries/dept/${R}/confirm`, ownerT)).s === 403);
  const cf = await call("POST", `/queries/dept/${R}/confirm`, tok.RIT);
  ok("Ritika confirms resolved", cf.s === 200);
  ok("confirming twice is refused", (await call("POST", `/queries/dept/${R}/confirm`, tok.RIT)).s === 409);
  ok("reopening after confirmation is refused", (await call("POST", `/queries/dept/${R}/reopen`, tok.RIT, { note: "still dusty" })).s === 409);
  ok("the owner was told it was confirmed", (await notes(owner, "DEPT_QUERY_CONFIRMED")) === 1);
  const hist = (await call("GET", `/queries/dept/${R}`, tok.AD1)).b.timeline.map((t) => t.kind);
  ok("complete history kept: created, manager, admin, accepted, progress, comments, confirmed", ["CREATED", "MANAGER_APPROVED", "ADMIN_APPROVED", "ACCEPTED", "PROGRESS", "COMMENT", "CONFIRMED"].every((k) => hist.includes(k)), hist);
  ok("every event has an actor and time in the database", Number((await q(`select count(*)::int c from dept_request_events where "requestId"=$1 and "actorId" is null`, [R]))[0].c) === 0);
  ok("history rows cannot be edited", await q(`update dept_request_events set note='x' where "requestId"=$1`, [R]).then(() => false).catch(() => true));
  ok("work status without approval is impossible (database rule)", await q(`insert into dept_requests (id,"platformId",reference,"raisedById",title,description,priority,"departmentId","approvalStatus","workStatus","updatedAt") values (gen_random_uuid(),$1,'DQ-X',$2,'x','xxxxx','LOW',$3,'PENDING_MANAGER','IN_PROGRESS',now())`, [A, RIT, dIT]).then(() => false).catch(() => true));

  console.log("\n## rejection at the manager stage");
  const r2 = (await call("POST", "/queries/dept", tok.RIT, { ...good, title: "Second request" })).b.id;
  ok("the manager must give a reason", (await call("POST", `/queries/dept/${r2}/manager-decision`, tok.MG1, { approve: false })).s === 400);
  ok("manager rejects with a reason", (await call("POST", `/queries/dept/${r2}/manager-decision`, tok.MG1, { approve: false, note: "Not needed this month" })).s === 200);
  row = await dbReq(r2);
  ok("status Rejected, no work status", row.approvalStatus === "REJECTED" && row.workStatus === null, row);
  ok("employee told, with the reason; Admin and department are not told", (await notes(RIT, "DEPT_QUERY_REJECTED")) === 1 && (await notes(AD1, "DEPT_QUERY_ADMIN_REVIEW")) === 1 /* only the first request */ && (await notes(IT1, "DEPT_QUERY_FOR_DEPARTMENT")) === 1);
  ok("the Admin cannot approve a rejected one (409)", (await call("POST", `/queries/dept/${r2}/admin-decision`, tok.AD1, { approve: true })).s === 409);
  ok("the department cannot see it", (await call("GET", `/queries/dept/${r2}`, tok.IT1)).s === 404);
  const rejNote = (await call("GET", `/queries/dept/${r2}`, tok.RIT)).b.timeline.find((t) => t.kind === "MANAGER_REJECTED");
  ok("Ritika sees the rejection reason", rejNote && rejNote.note === "Not needed this month", rejNote);
  ok("no further comments on a rejected request", (await call("POST", `/queries/dept/${r2}/comments`, tok.RIT, { body: "please reconsider" })).s === 403);

  console.log("\n## rejection at the Admin stage");
  const r3 = (await call("POST", "/queries/dept", tok.RIT, { ...good, title: "Third request" })).b.id;
  await call("POST", `/queries/dept/${r3}/manager-decision`, tok.MG1, { approve: true });
  ok("Admin must give a reason", (await call("POST", `/queries/dept/${r3}/admin-decision`, tok.AD1, { approve: false })).s === 400);
  ok("Admin rejects with a reason", (await call("POST", `/queries/dept/${r3}/admin-decision`, tok.AD1, { approve: false, note: "Budget not available" })).s === 200);
  row = await dbReq(r3);
  ok("Rejected, department never involved", row.approvalStatus === "REJECTED" && row.workStatus === null);
  ok("employee AND manager were told", (await notes(RIT, "DEPT_QUERY_REJECTED")) === 2 && (await notes(MG1, "DEPT_QUERY_REJECTED")) === 1);
  ok("the department was not told about it", (await notes(IT1, "DEPT_QUERY_FOR_DEPARTMENT")) === 1);

  console.log("\n## reassignment and reopening");
  const r4 = (await call("POST", "/queries/dept", tok.RIT, { ...good, title: "Fourth request" })).b.id;
  await call("POST", `/queries/dept/${r4}/manager-decision`, tok.MG1, { approve: true });
  await call("POST", `/queries/dept/${r4}/admin-decision`, tok.AD1, { approve: true });
  await call("POST", `/queries/dept/${r4}/accept`, tok.IT1);
  ok("a non-owner cannot reassign", (await call("POST", `/queries/dept/${r4}/reassign`, tok.IT2, { assigneeId: IT2 })).s === 403);
  ok("cannot hand it to someone outside the department", (await call("POST", `/queries/dept/${r4}/reassign`, tok.IT1, { assigneeId: ACC })).s === 400);
  ok("cannot hand it to the person who raised it", (await call("POST", `/queries/dept/${r4}/reassign`, tok.IT1, { assigneeId: RIT })).s === 400);
  ok("the owner reassigns to a colleague", (await call("POST", `/queries/dept/${r4}/reassign`, tok.IT1, { assigneeId: IT2, note: "You know this one" })).s === 200);
  ok("new owner recorded and notified", (await dbReq(r4)).assigneeId === IT2 && (await notes(IT2, "DEPT_QUERY_ASSIGNED")) === 1);
  ok("the old owner can no longer update progress", (await call("POST", `/queries/dept/${r4}/progress`, tok.IT1, { status: "IN_PROGRESS" })).s === 403);
  ok("an Admin may reassign too", (await call("POST", `/queries/dept/${r4}/reassign`, tok.AD1, { assigneeId: IT1 })).s === 200);
  await call("POST", `/queries/dept/${r4}/progress`, tok.IT1, { status: "COMPLETED", note: "Done, please check" });
  ok("reopen needs a reason", (await call("POST", `/queries/dept/${r4}/reopen`, tok.RIT, { note: "" })).s === 400);
  ok("someone else cannot reopen", (await call("POST", `/queries/dept/${r4}/reopen`, tok.OTH, { note: "not mine to reopen" })).s === 404);
  const ro = await call("POST", `/queries/dept/${r4}/reopen`, tok.RIT, { note: "Still not working" });
  ok("Ritika reopens", ro.s === 200);
  row = await dbReq(r4);
  ok("status Reopened, count 1, same owner kept", row.workStatus === "REOPENED" && row.reopenCount === 1 && row.assigneeId === IT1, row);
  ok("department owner, manager and Admin were told", (await notes(IT1, "DEPT_QUERY_REOPENED")) === 1 && (await notes(MG1, "DEPT_QUERY_REOPENED")) === 1 && (await notes(AD1, "DEPT_QUERY_REOPENED")) === 1);
  ok("the owner carries on after a reopen", (await call("POST", `/queries/dept/${r4}/progress`, tok.IT1, { status: "IN_PROGRESS" })).s === 200);
  await call("POST", `/queries/dept/${r4}/progress`, tok.IT1, { status: "COMPLETED", note: "Fixed properly" });
  ok("she confirms the second time", (await call("POST", `/queries/dept/${r4}/confirm`, tok.RIT)).s === 200);
  ok("the earlier completion and reopen stay in the history", (await call("GET", `/queries/dept/${r4}`, tok.RIT)).b.timeline.filter((t) => t.kind === "REOPENED").length === 1);

  console.log("\n## people with no manager, or a different line");
  const n1 = await call("POST", "/queries/dept", tok.NOM, { ...good, title: "No manager request" });
  ok("no reporting manager: goes straight to Pending Admin Approval", n1.s === 200 && n1.b.stage === "PENDING_ADMIN", n1);
  ok("with no mapped Admin, the Admins of the company are asked (and it says so)", (await notes(AD1, "DEPT_QUERY_ADMIN_REVIEW")) >= 2 && (await notes(AD2, "DEPT_QUERY_ADMIN_REVIEW")) === 1);
  ok("no manager was asked for it (she has no manager step)", Number((await q(`select count(*)::int c from dept_requests where id=$1 and "managerId" is null and "approvalStatus"='PENDING_ADMIN'`, [n1.b.id]))[0].c) === 1);
  const u1 = await call("POST", "/queries/dept", tok.UAD, { ...good, title: "Boss is an Admin" });
  ok("an employee whose boss is an Admin: no manager step, that Admin approves", u1.b.stage === "PENDING_ADMIN");
  ok("an Admin asked can approve it", (await call("POST", `/queries/dept/${u1.b.id}/admin-decision`, tok.AD1, { approve: true })).s === 200);
  ok("the other Admin could not (mapped to the boss only)", (await call("POST", `/queries/dept/${u1.b.id}/admin-decision`, tok.AD2, { approve: true })).s === 409);

  console.log("\n## lists, filters, visibility");
  const rl = (await call("GET", "/queries/dept?view=MINE", tok.RIT)).b;
  ok("Ritika sees only her own", rl.items.length >= 4 && rl.items.every((i) => i.isMine));
  ok("another employee sees none of them", (await call("GET", "/queries/dept", tok.OTH)).b.items.length === 0);
  ok("filter by approval status", (await call("GET", "/queries/dept?approval=REJECTED", tok.RIT)).b.items.every((i) => i.approvalStatus === "REJECTED"));
  ok("filter by department", (await call("GET", `/queries/dept?departmentId=${dAcc}`, tok.AD1)).b.items.length === 0 && (await call("GET", `/queries/dept?departmentId=${dIT}`, tok.AD1)).b.items.length >= 4);
  ok("search by title", (await call("GET", "/queries/dept?q=cleaning", tok.AD1)).b.items.some((i) => i.id === R));
  ok("HR sees them for monitoring", (await call("GET", "/queries/dept", tok.HR)).b.items.length >= 4);
  ok("department 'completed' view", (await call("GET", "/queries/dept?view=DEPT_DONE", tok.IT1)).b.items.some((i) => i.id === R));
  ok("the foreign company's person sees nothing", (await call("GET", "/queries/dept", tok.FOR)).b.items.length === 0 && (await call("GET", `/queries/dept/${R}`, tok.FOR)).s === 404);
  ok("an id that is not a UUID answers 404", (await call("GET", "/queries/dept/not-an-id", tok.RIT)).s === 404);

  console.log("\n## the old Complaint Centre keeps working");
  const tk = await call("POST", "/queries", tok.RIT, { category: "GENERAL_HR", subject: "Old style query", description: "Still works as before" });
  ok("a normal query still creates a ticket", tk.s === 200 && /TKT|^[A-Z]/.test(tk.b.reference ?? "x"), tk);
  const ol = (await call("GET", "/queries", tok.RIT)).b;
  ok("the old list works and is called Query Desk for everyone", ol.label === "Query Desk" && ol.items.some((i) => i.subject === "Old style query"), ol.label);
  ok("an HR person still sees it as before", (await call("GET", "/queries", tok.HR)).b.items.some((i) => i.subject === "Old style query"));

  console.log("\n## history is never overwritten");
  ok("approval rows kept for the rejected requests", Number((await q(`select count(*)::int c from dept_request_events where "requestId" = any($1) and kind in ('MANAGER_REJECTED','ADMIN_REJECTED')`, [[r2, r3]]))[0].c) === 2);
  ok("audit log has lines for the workflow", Number((await q(`select count(*)::int c from audit_logs where module='Queries' and path like '/api/queries/dept%'`))[0].c) > 10);

  await wipe();
  console.log(`\n${pass} passed, ${fail} failed`);
  await db.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
