// Organization hierarchy + approval workflows over HTTP: reporting rules, the leave flow for every role, the Manager-only daily task approval.
// Disposable database only (see _guard.cjs). Needs migration 20261103100000_org_hierarchy_workflows applied to THAT database.
//
//   cd backend && TEST_DATABASE_URL=... TEST_API=http://localhost:5012/api node tests/org-hierarchy-workflows.test.cjs
require("dotenv").config({ path: require("node:path").join(__dirname, "..", ".env") });
const { Client } = require("pg");
const bcrypt = require("bcryptjs");
const API = process.env.TEST_API ?? "http://localhost:5002/api";
require("./_guard.cjs").assertTestDb(process.env.TEST_DATABASE_URL);

const call = async (m, p, t, body) => {
  const r = await fetch(API + p, { method: m, headers: { ...(t ? { authorization: "Bearer " + t } : {}), ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const txt = await r.text(); let j; try { j = JSON.parse(txt); } catch { j = txt; }
  return { s: r.status, b: j };
};
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  -> " + String(JSON.stringify(x)).slice(0, 500))); };
const PW = "Org@12345678";

(async () => {
  const db = new Client({ connectionString: process.env.TEST_DATABASE_URL }); await db.connect();
  const q = async (s, p) => (await db.query(s, p)).rows;
  const AV = (await q(`select id from platforms where slug='avatar'`))[0].id;
  const AVN = (await q(`select id from platforms where slug='avance'`))[0].id;
  const hash = await bcrypt.hash(PW, 10);
  const wipe = async () => {
    const ids = `(select id from users where "employeeCode" like 'ORG-%')`;
    await q(`delete from notifications where "userId" in ${ids}`);
    await q(`delete from task_entry_details where "taskId" in (select id from daily_tasks where "userId" in ${ids})`);
    await q(`delete from task_events where "taskId" in (select id from daily_tasks where "userId" in ${ids})`).catch(() => {});
    await q(`delete from task_self_details where "taskId" in (select id from daily_tasks where "userId" in ${ids})`).catch(() => {});
    await q(`delete from daily_tasks where "userId" in ${ids}`);
    await q(`delete from leave_approval_events where "requestId" in (select id from leave_requests where "userId" in ${ids})`);
    await q(`delete from leave_request_projects where "requestId" in (select id from leave_requests where "userId" in ${ids})`);
    await q(`delete from request_approvals where kind='LEAVE' and "requestId" in (select id from leave_requests where "userId" in ${ids})`);
    await q(`delete from leave_days where "userId" in ${ids}`);
    await q(`delete from leave_requests where "userId" in ${ids}`);
    await q(`delete from team_members where "userId" in ${ids}`);
    await q(`delete from teams where name like 'ORG-%'`);
    await q(`delete from audit_logs where "userId" in ${ids}`).catch(() => {});
    await q(`delete from users where "employeeCode" like 'ORG-%'`);
  };
  await wipe();
  const mk = async (code, role, platformId, reportsToId = null) => {
    await q(`insert into users (id,"platformId",email,"passwordHash","firstName","lastName","employeeCode",role,status,"mustChangePassword","trackerAccessEnabled","onboardingStatus","reportsToId","dateOfJoining","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,$4,'Org',$5,$6,'ACTIVE',false,true,'ACTIVE',$7,'2026-01-01',now(),now())`, [platformId, code.toLowerCase() + "@org.test", hash, code.replace("ORG-", "N"), code, role, reportsToId]);
    const id = (await q(`select id from users where "employeeCode"=$1`, [code]))[0].id;
    const tok = (await (await fetch(API + "/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: code, password: PW }) })).json()).token;
    return { id, tok, code };
  };

  // the organization from the brief (names are only labels; everything below is driven by who reports to whom)
  const A1 = await mk("ORG-A1", "ADMIN", AV), A2 = await mk("ORG-A2", "ADMIN", AV), A3 = await mk("ORG-A3", "ADMIN", AV), A4 = await mk("ORG-A4", "ADMIN", AV);
  const HR = await mk("ORG-HR", "HR", AV);
  const M1 = await mk("ORG-M1", "MANAGER", AV, A1.id), M2 = await mk("ORG-M2", "MANAGER", AV, A2.id), M3 = await mk("ORG-M3", "MANAGER", AV, A3.id);
  const E1 = await mk("ORG-E1", "EMPLOYEE", AV, M1.id), E2 = await mk("ORG-E2", "EMPLOYEE", AV, M1.id), E3 = await mk("ORG-E3", "EMPLOYEE", AV, M2.id);
  const OM = await mk("ORG-OM", "MANAGER", AVN); // a manager of ANOTHER company
  const NB = await mk("ORG-NB", "EMPLOYEE", AV); // an employee with NO reporting line (needs manual configuration)

  // projects: a project is a team
  const team = async (name, mgr, members) => {
    const id = (await q(`insert into teams (id,"platformId",name,"managerId","isActive","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,true,now(),now()) returning id`, [AV, name, mgr.id]))[0].id;
    for (const u of members) await q(`insert into team_members (id,"teamId","userId","isActive","isPrimary","joinedAt") values (gen_random_uuid(),$1,$2,true,false,now())`, [id, u.id]);
    return id;
  };
  const P1 = await team("ORG-Alpha", M1, [E1, E2]);
  const P2 = await team("ORG-Beta", M2, [E1, E3]);
  const P3 = await team("ORG-Gamma", M3, [E3]); // E1 is NOT on Gamma

  const days = (n) => { const d = new Date(Date.now() + n * 86400000); return d.toISOString().slice(0, 10); };
  // pick weekdays in the next weeks so they are working days under the default shift (Mon-Sat)
  const weekday = (start) => { for (let i = start; i < start + 14; i++) { const d = new Date(Date.now() + i * 86400000); if (d.getUTCDay() >= 1 && d.getUTCDay() <= 5) return d.toISOString().slice(0, 10); } };
  let cursor = 3;
  const nextDay = () => { const d = weekday(cursor); cursor += 2; return d; };
  const leaveBody = (extra = {}) => { const d = nextDay(); return { from: d, to: d, leaveType: "CASUAL", reason: "Family function", ...extra }; };
  const mine = async (u) => (await call("GET", "/leave/mine", u.tok)).b.requests ?? [];
  const find = async (u, id) => (await mine(u)).find((r) => r.id === id);
  const notifsFor = async (u, type) => (await q(`select title, data from notifications where "userId"=$1 and type=$2 order by "createdAt"`, [u.id, type]));

  console.log("\n## 1. Reporting hierarchy rules (Admin/HR configure them; invalid lines are refused)");
  const edit = (actor, target, body) => call("PATCH", `/admin/users/${target.id}`, actor.tok, body);
  ok("an employee cannot be made to report to an Admin", (await edit(HR, E1, { reportsToId: A1.id })).s === 400);
  ok("an employee cannot report to another employee", (await edit(HR, E1, { reportsToId: E2.id })).s === 400);
  ok("an employee cannot report to HR", (await edit(A1, E1, { reportsToId: HR.id })).s === 400);
  ok("an employee cannot report to a manager of another company", (await edit(A1, E1, { reportsToId: OM.id })).s === 400);
  const mv = await edit(A1, NB, { reportsToId: M3.id });
  ok("an employee can be given a Manager (the manual-mapping case)", mv.s === 200, mv);
  ok("...and it is saved", (await q(`select "reportsToId" from users where id=$1`, [NB.id]))[0].reportsToId === M3.id);
  await q(`update users set "reportsToId"=null where id=$1`, [NB.id]); // back to unmapped for the later checks
  ok("a manager cannot report to another manager", (await edit(A1, M1, { reportsToId: M2.id })).s === 400);
  ok("a manager can be mapped to an Admin", (await edit(A1, M1, { reportsToId: A2.id })).s === 200 && (await edit(A1, M1, { reportsToId: A1.id })).s === 200);
  ok("nobody reports to themselves", (await edit(A1, E1, { reportsToId: E1.id })).s === 400);
  ok("an employee manager cannot use this (employees have no admin access)", (await edit(E1, E2, { reportsToId: M1.id })).s === 403);

  console.log("\n## 2. Leave form options");
  const fo1 = await call("GET", "/leave/form-options", E1.tok);
  ok("employee: mode Manager, the profile's manager is preselected, every active Manager of the company can be chosen", fo1.b.mode === "MANAGER" && fo1.b.defaultId === M1.id && fo1.b.editable === true && [M1, M2, M3].every((m) => fo1.b.options.some((o) => o.id === m.id)) && !fo1.b.options.some((o) => o.id === OM.id), fo1.b);
  ok("employee: only their own projects are offered (Alpha, Beta; never Gamma)", fo1.b.projects.length === 2 && fo1.b.projects.some((p) => p.id === P1) && fo1.b.projects.some((p) => p.id === P2) && !fo1.b.projects.some((p) => p.id === P3), fo1.b.projects);
  const fom = await call("GET", "/leave/form-options", M1.tok);
  ok("manager: mode Admin, fixed to the Admin they report to (not editable)", fom.b.mode === "ADMIN" && fom.b.defaultId === A1.id && fom.b.editable === false && fom.b.options.length === 1, fom.b);
  const foh = await call("GET", "/leave/form-options", HR.tok);
  ok("HR: mode Admin, must pick one of the Admins", foh.b.mode === "ADMIN" && foh.b.editable === true && foh.b.defaultId === null && [A1, A2, A3, A4].every((a) => foh.b.options.some((o) => o.id === a.id)) && !foh.b.options.some((o) => o.id === HR.id), foh.b);
  const foa = await call("GET", "/leave/form-options", A1.tok);
  ok("Admin: no approver (automatic)", foa.b.mode === "NONE", foa.b);
  ok("an unmapped employee gets no preselection", (await call("GET", "/leave/form-options", NB.tok)).b.defaultId === null);

  console.log("\n## 3. Employee leave: Manager first, HR second");
  const r1 = await call("POST", "/leave/requests", E1.tok, leaveBody({ projectIds: [P1, P2] }));
  ok("employee submits with two projects -> Pending Manager Approval", r1.s === 200 && r1.b.stage === "PENDING_MANAGER" && r1.b.stageLabel === "Pending Manager Approval" && r1.b.projects.length === 2, r1);
  const R1 = r1.b.id;
  ok("the tagged manager defaults to the profile's manager", (await q(`select "approverIds" from request_approvals where kind='LEAVE' and "requestId"=$1`, [R1]))[0].approverIds.join() === M1.id);
  ok("the request carries the history entry 'submitted'", (await find(E1, R1)).history.length === 1 && (await find(E1, R1)).history[0].action === "SUBMITTED");
  ok("projects the employee is not on are refused (server side)", (await call("POST", "/leave/requests", E1.tok, leaveBody({ projectIds: [P3] }))).s === 400);
  const hrList = await call("GET", "/leave/requests", HR.tok);
  const hrRow = hrList.b.requests.find((r) => r.id === R1);
  ok("HR sees the request immediately, marked Pending Manager Approval", !!hrRow && hrRow.stage === "PENDING_MANAGER", hrList.b.requests?.map((r) => r.stage));
  const hrEarly = await call("POST", `/leave/requests/${R1}/decide`, HR.tok, { decision: "APPROVE" });
  ok("HR cannot approve before the manager (409)", hrEarly.s === 409, hrEarly);
  ok("HR cannot skip the manager with a reason any more (still 409)", (await call("POST", `/leave/requests/${R1}/decide`, HR.tok, { decision: "APPROVE", skipManager: true, skipReason: "I want to approve it myself" })).s === 409);
  ok("HR cannot reject before the manager either", (await call("POST", `/leave/requests/${R1}/decide`, HR.tok, { decision: "REJECT", note: "no" })).s === 409);
  ok("an unrelated manager (same role) cannot approve (404)", (await call("POST", `/leave/manager/requests/${R1}/decide`, M2.tok, { decision: "APPROVE" })).s === 404);
  ok("an Admin cannot approve an employee's first level (404)", (await call("POST", `/leave/manager/requests/${R1}/decide`, A1.tok, { decision: "APPROVE" })).s === 404);
  ok("the employee cannot approve their own", (await call("POST", `/leave/manager/requests/${R1}/decide`, E1.tok, { decision: "APPROVE" })).s === 403);
  ok("no leave day exists yet", (await q(`select count(*)::int n from leave_days where "userId"=$1`, [E1.id]))[0].n === 0);
  const m1q = await call("GET", "/leave/manager/requests", M1.tok);
  ok("the tagged manager sees it in their queue", m1q.b.pending.some((r) => r.id === R1), m1q.b);
  const mApprove = await call("POST", `/leave/manager/requests/${R1}/decide`, M1.tok, { decision: "APPROVE", note: "Fine by me" });
  ok("the tagged manager approves -> waiting for HR", mApprove.s === 200 && mApprove.b.status === "WAITING_FOR_HR", mApprove);
  ok("status is now Pending HR Approval", (await find(E1, R1)).stage === "PENDING_HR" && (await find(E1, R1)).stageLabel === "Pending HR Approval");
  ok("a second answer on the first level is refused", (await call("POST", `/leave/manager/requests/${R1}/decide`, M1.tok, { decision: "APPROVE" })).s === 409);
  ok("still no leave days (HR has not approved)", (await q(`select count(*)::int n from leave_days where "userId"=$1`, [E1.id]))[0].n === 0);
  ok("the manager (not HR) cannot give the final answer", (await call("POST", `/leave/requests/${R1}/decide`, M1.tok, { decision: "APPROVE" })).s === 403);
  ok("an Admin does not give HR's final answer on a normal request (403)", (await call("POST", `/leave/requests/${R1}/decide`, A1.tok, { decision: "APPROVE" })).s === 403);
  const hrOk = await call("POST", `/leave/requests/${R1}/decide`, HR.tok, { decision: "APPROVE", note: "Approved" });
  ok("HR approves after the manager -> Approved", hrOk.s === 200 && hrOk.b.status === "APPROVED", hrOk);
  const done1 = await find(E1, R1);
  ok("status Approved and the leave days are written", done1.stage === "APPROVED" && (await q(`select count(*)::int n from leave_days where "userId"=$1`, [E1.id]))[0].n === 1, done1);
  ok("history: submitted, manager approved, HR approved (names, roles, comments, times)", done1.history.map((h) => `${h.step}:${h.action}`).join() === "REQUEST:SUBMITTED,MANAGER:APPROVED,HR:APPROVED" && done1.history[1].role === "MANAGER" && done1.history[1].comment === "Fine by me" && done1.history[2].role === "HR" && done1.history.every((h) => h.actor && h.at), done1.history);

  console.log("\n## 4. Manager rejects (final) / HR rejects / tagging another manager");
  const r2 = await call("POST", "/leave/requests", E1.tok, leaveBody({ approverId: M2.id }));
  ok("the employee may tag a different Manager", r2.s === 200 && (await q(`select "approverIds" from request_approvals where kind='LEAVE' and "requestId"=$1`, [r2.b.id]))[0].approverIds.join() === M2.id, r2);
  ok("the profile's manager can no longer act (only the tagged one can)", (await call("POST", `/leave/manager/requests/${r2.b.id}/decide`, M1.tok, { decision: "APPROVE" })).s === 404);
  ok("rejecting needs a comment", (await call("POST", `/leave/manager/requests/${r2.b.id}/decide`, M2.tok, { decision: "REJECT" })).s === 400);
  const rej = await call("POST", `/leave/manager/requests/${r2.b.id}/decide`, M2.tok, { decision: "REJECT", note: "Team is short that week" });
  ok("the tagged manager rejects -> Rejected (final)", rej.s === 200 && rej.b.status === "REJECTED" && (await find(E1, r2.b.id)).stage === "REJECTED", rej);
  const hrAfterRej = await call("POST", `/leave/requests/${r2.b.id}/decide`, HR.tok, { decision: "APPROVE" });
  ok("HR cannot approve or reject what the manager rejected", hrAfterRej.s === 400 && (await call("POST", `/leave/requests/${r2.b.id}/decide`, HR.tok, { decision: "REJECT", note: "x" })).s === 400, hrAfterRej);
  ok("a rejected request writes no leave days", (await q(`select count(*)::int n from leave_days where "leaveRequestId"=$1`, [r2.b.id]))[0].n === 0);
  ok("an Admin cannot be tagged on an employee's request", (await call("POST", "/leave/requests", E2.tok, leaveBody({ approverId: A1.id }))).s === 400);
  ok("a manager of another company cannot be tagged", (await call("POST", "/leave/requests", E2.tok, leaveBody({ approverId: OM.id }))).s === 400);
  const r3 = await call("POST", "/leave/requests", E2.tok, leaveBody());
  await call("POST", `/leave/manager/requests/${r3.b.id}/decide`, M1.tok, { decision: "APPROVE" });
  const hrRej = await call("POST", `/leave/requests/${r3.b.id}/decide`, HR.tok, { decision: "REJECT", note: "Peak period" });
  ok("HR can reject after the manager approved -> Rejected", hrRej.s === 200 && (await find(E2, r3.b.id)).stage === "REJECTED" && (await find(E2, r3.b.id)).history.at(-1).action === "REJECTED", hrRej);
  ok("the employee can cancel a pending request, and it is in the history", await (async () => { const c = await call("POST", "/leave/requests", E2.tok, leaveBody()); const x = await call("POST", `/leave/requests/${c.b.id}/cancel`, E2.tok); const f = await find(E2, c.b.id); return x.s === 200 && f.stage === "CANCELLED" && f.history.at(-1).action === "CANCELLED"; })());

  console.log("\n## 5. Manager's leave: mapped Admin first, HR final");
  const rm = await call("POST", "/leave/requests", M1.tok, leaveBody());
  ok("manager submits -> Pending Admin Approval, tagged to the Admin they report to", rm.s === 200 && rm.b.stage === "PENDING_ADMIN" && (await q(`select "approverIds" from request_approvals where kind='LEAVE' and "requestId"=$1`, [rm.b.id]))[0].approverIds.join() === A1.id, rm);
  ok("a manager cannot choose a different Admin", (await call("POST", "/leave/requests", M1.tok, leaveBody({ approverId: A2.id }))).s === 400);
  ok("HR sees it at once", (await call("GET", "/leave/requests", HR.tok)).b.requests.some((r) => r.id === rm.b.id && r.stage === "PENDING_ADMIN"));
  ok("HR cannot act yet", (await call("POST", `/leave/requests/${rm.b.id}/decide`, HR.tok, { decision: "APPROVE" })).s === 409);
  ok("another Admin cannot approve (only the mapped Admin) (404)", (await call("POST", `/leave/manager/requests/${rm.b.id}/decide`, A2.tok, { decision: "APPROVE" })).s === 404);
  ok("another manager cannot approve (404)", (await call("POST", `/leave/manager/requests/${rm.b.id}/decide`, M2.tok, { decision: "APPROVE" })).s === 404);
  const aq = await call("GET", "/leave/manager/requests", A1.tok);
  ok("the mapped Admin sees it in their queue", aq.s === 200 && aq.b.pending.some((r) => r.id === rm.b.id), aq);
  ok("the mapped Admin approves -> Pending HR Approval", (await call("POST", `/leave/manager/requests/${rm.b.id}/decide`, A1.tok, { decision: "APPROVE" })).b.status === "WAITING_FOR_HR" && (await find(M1, rm.b.id)).stage === "PENDING_HR");
  ok("HR approves -> Approved, days written", (await call("POST", `/leave/requests/${rm.b.id}/decide`, HR.tok, { decision: "APPROVE" })).b.status === "APPROVED" && (await q(`select count(*)::int n from leave_days where "userId"=$1`, [M1.id]))[0].n === 1);
  const rm2 = await call("POST", "/leave/requests", M2.tok, leaveBody());
  const adminRej = await call("POST", `/leave/manager/requests/${rm2.b.id}/decide`, A2.tok, { decision: "REJECT", note: "Release week" });
  ok("the Admin rejects a manager's leave -> Rejected, and HR cannot reopen it", adminRej.b.status === "REJECTED" && (await call("POST", `/leave/requests/${rm2.b.id}/decide`, HR.tok, { decision: "APPROVE" })).s === 400);
  const rm3 = await call("POST", "/leave/requests", M3.tok, leaveBody());
  await call("POST", `/leave/manager/requests/${rm3.b.id}/decide`, A3.tok, { decision: "APPROVE" });
  ok("HR can reject a manager's leave the Admin approved", (await call("POST", `/leave/requests/${rm3.b.id}/decide`, HR.tok, { decision: "REJECT", note: "No" })).b.status === "REJECTED");

  console.log("\n## 6. HR's leave: a tagged Admin decides, nobody else");
  ok("HR must tag an Admin (400 without one)", (await call("POST", "/leave/requests", HR.tok, leaveBody())).s === 400);
  ok("HR cannot tag a manager", (await call("POST", "/leave/requests", HR.tok, leaveBody({ approverId: M1.id }))).s === 400);
  const rh = await call("POST", "/leave/requests", HR.tok, leaveBody({ approverId: A3.id }));
  ok("HR tags an Admin -> Pending Admin Approval", rh.s === 200 && rh.b.stage === "PENDING_ADMIN", rh);
  ok("HR cannot decide their own leave", [403, 409].includes((await call("POST", `/leave/requests/${rh.b.id}/decide`, HR.tok, { decision: "APPROVE" })).s));
  ok("an Admin who is not tagged cannot decide (404)", (await call("POST", `/leave/manager/requests/${rh.b.id}/decide`, A1.tok, { decision: "APPROVE" })).s === 404);
  ok("an Admin cannot give HR's final answer through the HR route either", (await call("POST", `/leave/requests/${rh.b.id}/decide`, A1.tok, { decision: "APPROVE" })).s !== 200);
  const hrApproved = await call("POST", `/leave/manager/requests/${rh.b.id}/decide`, A3.tok, { decision: "APPROVE" });
  ok("the tagged Admin approves -> Approved (final, no extra HR step)", hrApproved.b.status === "APPROVED" && (await find(HR, rh.b.id)).stage === "APPROVED" && (await q(`select count(*)::int n from leave_days where "userId"=$1`, [HR.id]))[0].n === 1, hrApproved);
  const rh2 = await call("POST", "/leave/requests", HR.tok, leaveBody({ approverId: A2.id }));
  const rjA = await call("POST", `/leave/manager/requests/${rh2.b.id}/decide`, A2.tok, { decision: "REJECT", note: "Not now" }); ok("the tagged Admin can reject HR's leave -> Rejected", rjA.b.status === "REJECTED", [rh2.s, rh2.b, rjA]);

  console.log("\n## 7. Admin's own leave: approved automatically and visible to everyone");
  const ra = await call("POST", "/leave/requests", A4.tok, leaveBody());
  ok("Admin leave is Approved at once, with no approver", ra.s === 200 && ra.b.stage === "APPROVED" && (await q(`select count(*)::int n from request_approvals where kind='LEAVE' and "requestId"=$1`, [ra.b.id]))[0].n === 0, ra);
  ok("the leave days are written", (await q(`select count(*)::int n from leave_days where "userId"=$1`, [A4.id]))[0].n === 1);
  ok("history shows it was approved automatically", (await find(A4, ra.b.id)).history.some((h) => h.action === "AUTO_APPROVED"));
  const away = await call("GET", `/leave/away?from=${days(0)}&to=${days(90)}`, E3.tok);
  ok("an employee sees the Admin on the away list (names, dates, type; never the reason)", away.s === 200 && away.b.away.some((a) => a.userId === A4.id) && !JSON.stringify(away.b).includes("Family function"), away);
  ok("another company does not see this company's away list", !((await call("GET", `/leave/away?from=${days(0)}&to=${days(90)}`, OM.tok)).b.away ?? []).some((a) => a.userId === A4.id));

  console.log("\n## 8. Notifications (once each, to the right people)");
  const firstTo = async (u, id) => (await q(`select count(*)::int n from notifications where "userId"=$1 and data->>'requestId'=$2`, [u.id, id]))[0].n;
  ok("employee submits -> the tagged manager is told once", (await firstTo(M1, R1)) >= 1 && (await q(`select count(*)::int n from notifications where "userId"=$1 and data->>'dedupeKey'=$2`, [M1.id, `leave-first:${R1}`]))[0].n === 1);
  ok("...and HR is told at once, once", (await q(`select count(*)::int n from notifications where "userId"=$1 and data->>'dedupeKey'=$2`, [HR.id, `leave-hr-seen:${R1}`]))[0].n === 1);
  ok("the untagged manager and other Admins were not told", (await firstTo(M2, R1)) === 0 && (await firstTo(A1, R1)) === 0);
  ok("manager approves -> HR is told it is ready, once", (await q(`select count(*)::int n from notifications where "userId"=$1 and data->>'dedupeKey'=$2`, [HR.id, `leave-ready-hr:${R1}`]))[0].n === 1);
  ok("manager rejects -> the employee is told", (await notifsFor(E1, "LEAVE_DECIDED")).some((n) => /not approved/i.test(n.title)));
  ok("manager submits -> the mapped Admin and HR are told", (await firstTo(A1, rm.b.id)) >= 1 && (await firstTo(HR, rm.b.id)) >= 1);
  ok("Admin approves a manager's leave -> HR is told", (await q(`select count(*)::int n from notifications where "userId"=$1 and data->>'dedupeKey'=$2`, [HR.id, `leave-ready-hr:${rm.b.id}`]))[0].n === 1);
  ok("Admin rejects a manager's leave -> the manager is told", (await notifsFor(M2, "LEAVE_DECIDED")).some((n) => /not approved/i.test(n.title)));
  ok("HR submits -> only the tagged Admin is told", (await firstTo(A3, rh.b.id)) >= 1 && (await firstTo(A1, rh.b.id)) === 0 && (await q(`select count(*)::int n from notifications where "userId"=$1 and type='LEAVE_REQUESTED' and data->>'requestId'=$2`, [HR.id, rh.b.id]))[0].n === 0);
  ok("the tagged Admin decides HR's leave -> HR is told", (await notifsFor(HR, "LEAVE_DECIDED")).some((n) => /approved/i.test(n.title)));

  console.log("\n## 9. Daily tasks: Manager-only approval");
  const tl = await call("GET", "/tasks", E1.tok);
  ok("the task form: ready, the profile's manager preselected, only the authorised Managers to choose from (reporting manager + project managers), own projects", tl.b.entryForm?.ready === true && tl.b.entryForm.defaultId === M1.id && tl.b.entryForm.options.length >= 1 && tl.b.entryForm.options.some((o) => o.id === M1.id) && tl.b.projects.length === 2, tl.b.entryForm);
  const t1 = await call("POST", "/tasks", E1.tok, { title: "Build login page", description: "Alpha work", teamId: P1, hoursSpent: 2.5, progress: "COMPLETED" });
  const T1 = t1.b.awaitingApproval?.find((t) => t.title === "Build login page");
  ok("a task can be submitted as Completed while its approval is Pending (two separate fields)", t1.s === 200 && T1?.progress === "COMPLETED" && T1.approvalStatus === "PENDING" && T1.status === "COMPLETED" && T1.hoursSpent === 2.5, T1);
  ok("the task is tagged to the profile's manager and shows it", T1?.taggedManagerId === M1.id && !!T1.taggedManager);
  ok("a bad progress is refused", (await call("POST", "/tasks", E1.tok, { title: "x", progress: "DONE" })).s === 400);
  ok("hours above 24 / negative / text are refused", (await call("POST", "/tasks", E1.tok, { title: "x", hoursSpent: 25 })).s === 400 && (await call("POST", "/tasks", E1.tok, { title: "x", hoursSpent: -1 })).s === 400 && (await call("POST", "/tasks", E1.tok, { title: "x", hoursSpent: "abc" })).s === 400);
  ok("an Admin cannot be tagged as the task's manager", (await call("POST", "/tasks", E1.tok, { title: "x", taggedManagerId: A1.id })).s === 400);
  const t2 = await call("POST", "/tasks", E1.tok, { title: "Review designs", teamId: P2, hoursSpent: 1, progress: "IN_PROGRESS", taggedManagerId: M2.id });
  const t3 = await call("POST", "/tasks", E1.tok, { title: "Fix blocker", teamId: P1, hoursSpent: 0.5, progress: "BLOCKED", blockedNote: "Waiting on API keys" });
  const all = await call("GET", "/tasks", E1.tok);
  ok("several entries on the same day for different projects", all.b.tasks.length === 3 && new Set(all.b.tasks.map((t) => t.projectId)).size === 2, all.b.tasks.map((t) => [t.title, t.projectId]));
  const T3 = all.b.tasks.find((t) => t.title === "Fix blocker"), T2 = all.b.tasks.find((t) => t.title === "Review designs");
  ok("Blocked is its own progress (an unfinished task), separate from approval", T3.progress === "BLOCKED" && T3.status === "IN_PROGRESS" && T3.approvalStatus === "PENDING" && T3.blockedNote === "Waiting on API keys", T3);
  ok("a task tagged to another manager says so", T2.taggedManagerId === M2.id && T2.progress === "IN_PROGRESS");

  const qHR = await call("GET", "/tasks/review/queue", HR.tok);
  const qrow = (res, id) => res.b.all?.find((t) => t.id === id);
  ok("HR can SEE every task (read-only)", qHR.s === 200 && !!qrow(qHR, T1.id) && !!qrow(qHR, T2.id), qHR.s);
  ok("...and the queue marks them as not actionable for HR", qrow(qHR, T1.id)?.canAct === false && qrow(qHR, T2.id)?.canAct === false);
  const qA = await call("GET", "/tasks/review/queue", A1.tok);
  ok("an Admin sees them too, read-only", !!qrow(qA, T1.id) && qrow(qA, T1.id).canAct === false);
  const qM1 = await call("GET", "/tasks/review/queue", M1.tok);
  ok("the tagged manager sees theirs as actionable, and not the one tagged to the other manager as theirs", qrow(qM1, T1.id)?.canAct === true && (qrow(qM1, T2.id) ? qrow(qM1, T2.id).canAct === false : true), qrow(qM1, T2.id));
  ok("HR cannot approve a task (403)", (await call("POST", `/tasks/review/${T1.id}/approve`, HR.tok, { approve: true })).s === 403);
  ok("HR cannot reject a task (403)", (await call("POST", `/tasks/review/${T1.id}/approve`, HR.tok, { approve: false, rejectionNote: "no" })).s === 403);
  ok("an Admin cannot approve a task (403)", (await call("POST", `/tasks/review/${T1.id}/approve`, A1.tok, { approve: true })).s === 403);
  ok("a manager the task is NOT tagged to cannot approve it (403), even if they run the project", (await call("POST", `/tasks/review/${T2.id}/approve`, M1.tok, { approve: true })).s === 403);
  ok("nothing changed so far", (await q(`select "approvalStatus" from daily_tasks where id=$1`, [T1.id]))[0].approvalStatus === "PENDING");
  ok("rejecting needs a reason", (await call("POST", `/tasks/review/${T1.id}/approve`, M1.tok, { approve: false })).s === 400);
  const ap = await call("POST", `/tasks/review/${T1.id}/approve`, M1.tok, { approve: true, comment: "Looks good" });
  const rowT1 = (await q(`select "approvalStatus","approvedById","approvedAt",status from daily_tasks where id=$1`, [T1.id]))[0];
  ok("the tagged manager approves: reviewer and time recorded, progress untouched", ap.s === 200 && rowT1.approvalStatus === "APPROVED" && rowT1.approvedById === M1.id && !!rowT1.approvedAt && rowT1.status === "COMPLETED", rowT1);
  ok("the manager's optional comment is kept", (await q(`select "approvalNote" from task_entry_details where "taskId"=$1`, [T1.id]))[0].approvalNote === "Looks good");
  ok("a second answer cannot overwrite the decision (409)", (await call("POST", `/tasks/review/${T1.id}/approve`, M1.tok, { approve: false, rejectionNote: "changed my mind" })).s === 409);
  const rj = await call("POST", `/tasks/review/${T2.id}/approve`, M2.tok, { approve: false, rejectionNote: "Needs more detail" });
  const rowT2 = (await q(`select "approvalStatus","approvedById","rejectionNote" from daily_tasks where id=$1`, [T2.id]))[0];
  ok("the other tagged manager rejects theirs with a reason: reviewer, action and comment recorded", rj.s === 200 && rowT2.approvalStatus === "REJECTED" && rowT2.approvedById === M2.id && rowT2.rejectionNote === "Needs more detail", rowT2);
  ok("the employee sees both approval statuses", await (async () => { const l = await call("GET", "/tasks", E1.tok); const a = l.b.tasks.find((t) => t.id === T1.id), b = l.b.tasks.find((t) => t.id === T2.id); return a.approvalStatus === "APPROVED" && b.approvalStatus === "REJECTED" && b.rejectionNote === "Needs more detail"; })());
  const upd = await call("PATCH", `/tasks/${T3.id}`, E1.tok, { progress: "IN_PROGRESS", hoursSpent: 1.5 });
  ok("progress and hours can change while approval is pending, without touching approval", upd.s === 200 && (await q(`select status,"approvalStatus" from daily_tasks where id=$1`, [T3.id]))[0].approvalStatus === "PENDING" && (await q(`select blocked,"hoursSpent" from task_entry_details where "taskId"=$1`, [T3.id]))[0].hoursSpent === 1.5);
  ok("task notifications: the tagged manager was told once, the other manager and HR were not", (await q(`select count(*)::int n from notifications where "userId"=$1 and type='TASK_PROPOSED' and data->>'taskId'=$2`, [M1.id, T1.id]))[0].n === 1 && (await q(`select count(*)::int n from notifications where "userId"=$1 and data->>'taskId'=$2`, [M2.id, T1.id]))[0].n === 0 && (await q(`select count(*)::int n from notifications where "userId"=$1 and data->>'taskId'=$2`, [HR.id, T1.id]))[0].n === 0);
  ok("the employee was told of each decision", (await q(`select count(*)::int n from notifications where "userId"=$1 and type in ('TASK_PROPOSAL_APPROVED','TASK_PROPOSAL_RETURNED')`, [E1.id]))[0].n === 2);

  console.log("\n## 10. A manager's own tasks are untouched");
  const mt = await call("POST", "/tasks", M1.tok, { title: "Plan the sprint" });
  const MT = mt.b.tasks?.find((t) => t.title === "Plan the sprint");
  ok("a manager's own task is approved on creation (no approval step)", mt.s === 200 && MT?.approvalStatus === "APPROVED", MT);
  ok("...and it carries no employee-entry details", (await q(`select count(*)::int n from task_entry_details where "taskId"=$1`, [MT.id]))[0].n === 0);
  ok("...and it never enters the employee review queue", !qrow(await call("GET", "/tasks/review/queue", M1.tok), MT.id));

  console.log("\n## 11. Old records are untouched (no tag, no details)");
  const oldTask = (await q(`insert into daily_tasks (id,"platformId","userId",date,title,weight,status,"approvalStatus","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,current_date,'Legacy task','MEDIUM','PENDING','PENDING',now(),now()) returning id`, [AV, E2.id]))[0].id;
  ok("a legacy task (no tag) can still be approved by the manager the old rule names (project manager)", (await call("POST", `/tasks/review/${oldTask}/approve`, M1.tok, { approve: true })).s === 200);
  const oldTask2 = (await q(`insert into daily_tasks (id,"platformId","userId",date,title,weight,status,"approvalStatus","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,current_date,'Legacy task 2','MEDIUM','PENDING','PENDING',now(),now()) returning id`, [AV, E2.id]))[0].id;
  ok("...but HR and Admin still cannot approve it", (await call("POST", `/tasks/review/${oldTask2}/approve`, HR.tok, { approve: true })).s === 403 && (await call("POST", `/tasks/review/${oldTask2}/approve`, A1.tok, { approve: true })).s === 403);
  const legacyReq = (await q(`insert into leave_requests (id,"platformId","userId","fromDate","toDate","leaveType","isHalfDay","isFirstHalf","dayCount",reason,status,"createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3::date,$3::date,'SICK',false,true,1,'Old request','PENDING',now(),now()) returning id`, [AV, NB.id, weekday(20)]))[0].id;
  const lr = (await call("GET", "/leave/requests", HR.tok)).b.requests.find((r) => r.id === legacyReq);
  ok("an old leave request with no step still shows (waits for HR, as before)", lr?.stage === "PENDING_HR" && lr.history.length === 0, lr);
  ok("...and HR can still decide it", (await call("POST", `/leave/requests/${legacyReq}/decide`, HR.tok, { decision: "APPROVE" })).s === 200);
  const nb = await call("POST", "/leave/requests", NB.tok, leaveBody());
  ok("an employee with no manager mapped still gets to submit; it goes straight to HR (flagged for configuration)", nb.s === 200 && nb.b.stage === "PENDING_HR", nb);

  console.log("\n## 12. Total days, dashboards and the manual-mapping list");
  const dMon = weekday(30);
  const pv = await call("GET", `/leave/preview?from=${dMon}&to=${dMon}&half=true`, E1.tok);
  ok("total days is calculated by the server (a half day = 0.5)", pv.s === 200 && pv.b.days === 0.5, pv);
  const pv2 = await call("GET", `/leave/preview?from=${dMon}&to=${dMon}`, E1.tok);
  ok("a single working day = 1", pv2.b.days === 1, pv2);
  const ovHr = await call("GET", "/leave/overview", HR.tok);
  ok("HR overview: counts of requests by turn", ovHr.s === 200 && typeof ovHr.b.awaitingHr === "number" && typeof ovHr.b.awaitingFirstLevel === "number", ovHr.b);
  ok("HR overview: employees by manager (M1 has E1 and E2)", ovHr.b.managers.find((m) => m.id === M1.id)?.employees === 2, ovHr.b.managers);
  ok("HR overview: the employee with no reporting line is flagged for manual configuration", ovHr.b.unmapped.people.some((x) => x.id === NB.id), ovHr.b.unmapped);
  const ovM = await call("GET", "/leave/overview", M2.tok);
  ok("manager overview: leave and task approvals waiting, team size", ovM.s === 200 && typeof ovM.b.pendingTaskApprovals === "number" && ovM.b.teamSize === 1, ovM.b);
  const ovE = await call("GET", "/leave/overview", E1.tok);
  ok("employee overview: today's task approvals by state", ovE.s === 200 && ovE.b.myTasksToday.APPROVED === 1 && ovE.b.myTasksToday.REJECTED === 1, ovE.b);
  const ovA = await call("GET", "/leave/overview", A1.tok);
  ok("Admin overview works and counts what is waiting for them", ovA.s === 200 && typeof ovA.b.awaitingMyLeaveApproval === "number", ovA.b);
  ok("an overview needs a sign-in", (await call("GET", "/leave/overview")).s === 401);

  await wipe();
  await db.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
