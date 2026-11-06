// Manager step for leave and attendance corrections: the manager answers first, HR decides afterwards.
// Disposable Neon branch only (see _guard.cjs). Needs migration 20261101150000_request_manager_approvals applied there.
//
//   cd backend && TEST_DATABASE_URL=... TEST_API=http://localhost:5012/api node tests/manager-step.test.cjs
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
const ok = (n, c, x) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  -> " + String(JSON.stringify(x)).slice(0, 300))); };
const PW = "Step@12345678";
const add = (s, n) => new Date(new Date(s + "T00:00:00Z").getTime() + n * 864e5).toISOString().slice(0, 10);
const weekday = (iso) => new Date(iso + "T00:00:00Z").getUTCDay() || 7;

(async () => {
  const db = new Client({ connectionString: process.env.TEST_DATABASE_URL }); await db.connect();
  const q = async (s, p) => (await db.query(s, p)).rows;
  const AV = (await q(`select id from platforms where slug='avatar'`))[0].id;
  const hash = await bcrypt.hash(PW, 10);
  const wipe = async () => {
    const ids = `(select id from users where "employeeCode" like 'STP-%')`;
    await q(`delete from request_approvals where "platformId" = $1 and "requestId" in (select id from leave_requests where "userId" in ${ids} union select id from attendance_correction_requests where "userId" in ${ids})`, [AV]);
    await q(`delete from attendance_correction_requests where "userId" in ${ids}`);
    await q(`delete from leave_days where "userId" in ${ids}`);
    await q(`delete from leave_requests where "userId" in ${ids}`);
    await q(`delete from notifications where "userId" in ${ids}`);
    await q(`delete from users where "employeeCode" like 'STP-%'`);
  };
  await wipe();
  const mk = async (code, role, reportsToId = null) => {
    await q(`insert into users (id,"platformId",email,"passwordHash","firstName","lastName","employeeCode",role,status,"mustChangePassword","trackerAccessEnabled","onboardingStatus","reportsToId","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,'Stp',$4,$5,$6,'ACTIVE',false,true,'ACTIVE',$7,now(),now())`, [AV, code.toLowerCase() + "@stp.test", hash, code.replace("STP-", "T"), code, role, reportsToId]);
    const id = (await q(`select id from users where "employeeCode"=$1`, [code]))[0].id;
    const tok = (await call("POST", "/auth/login", null, { email: code, password: PW })).b.token;
    return { id, tok };
  };
  const H = await mk("STP-H", "HR");
  const M = await mk("STP-M", "MANAGER", H.id);       // a manager who reports to HR (no manager step for him)
  const M2 = await mk("STP-M2", "MANAGER", H.id);     // another manager, not E's
  const E = await mk("STP-E", "EMPLOYEE", M.id);      // reports to M
  const E2 = await mk("STP-E2", "EMPLOYEE", H.id);    // reports to HR: no manager step
  const today = (await call("GET", "/tracker/timesheet", E.tok)).b.today;
  const nextWorkday = (n) => { let d = add(today, n); while (weekday(d) === 7) d = add(d, 1); return d; };
  const stepOf = async (id) => (await q(`select * from request_approvals where "requestId"=$1`, [id]))[0];
  const note = async (userId, type) => (await q(`select title from notifications where "userId"=$1 and type=$2 order by "createdAt" desc`, [userId, type]));
  const leaveRow = async (id) => (await q(`select * from leave_requests where id=$1`, [id]))[0];
  const askLeave = async (tok, day) => (await call("POST", "/leave/requests", tok, { from: day, to: day, leaveType: "CASUAL", reason: "Family function" })).b;

  console.log("\n## 1. A leave request goes to the manager first");
  const d1 = nextWorkday(2);
  const l1 = await askLeave(E.tok, d1);
  ok("the employee's request is created", !!l1.id, l1);
  const s1 = await stepOf(l1.id);
  ok("a manager step exists, waiting, asking exactly his manager", s1 && s1.status === "PENDING" && s1.approverIds.length === 1 && s1.approverIds[0] === M.id, s1);
  ok("the manager is notified", (await note(M.id, "LEAVE_REQUESTED")).length === 1);
  // organization flow (migration 20261103100000): HR sees a new request at once, but can only act after the first approver
  ok("HR is told at once that a request is waiting for the manager", (await note(H.id, "LEAVE_REQUESTED")).length === 1);
  const mine = await call("GET", "/leave/mine", E.tok);
  ok("the employee sees where it is (waiting for the manager)", mine.b.requests[0].managerStep?.status === "PENDING" && mine.b.requests[0].status === "PENDING", mine.b);
  const mlist = await call("GET", "/leave/manager/requests", M.tok);
  ok("the manager's list shows it", mlist.s === 200 && mlist.b.pending.some((r) => r.id === l1.id), mlist.b);
  ok("another manager does not see it", !(await call("GET", "/leave/manager/requests", M2.tok)).b.pending.some((r) => r.id === l1.id));
  ok("an employee cannot open the manager list -> 403", (await call("GET", "/leave/manager/requests", E.tok)).s === 403);

  console.log("\n## 2. HR cannot decide while the manager has not answered");
  ok("HR approving is refused (409 waiting for the manager)", (await call("POST", `/leave/requests/${l1.id}/decide`, H.tok, { decision: "APPROVE" })).s === 409);
  ok("HR skipping without a reason is refused (409)", (await call("POST", `/leave/requests/${l1.id}/decide`, H.tok, { decision: "APPROVE", skipManager: true })).s === 409);
  ok("HR skipping with a short reason is refused (409)", (await call("POST", `/leave/requests/${l1.id}/decide`, H.tok, { decision: "APPROVE", skipManager: true, skipReason: "ok" })).s === 409);
  ok("nothing changed so far", (await leaveRow(l1.id)).status === "PENDING" && (await stepOf(l1.id)).status === "PENDING");
  ok("another manager cannot answer it (404)", (await call("POST", `/leave/manager/requests/${l1.id}/decide`, M2.tok, { decision: "APPROVE" })).s === 404);
  ok("the employee cannot answer it (403)", (await call("POST", `/leave/manager/requests/${l1.id}/decide`, E.tok, { decision: "APPROVE" })).s === 403);
  ok("the manager's rejection without a reason is refused (400)", (await call("POST", `/leave/manager/requests/${l1.id}/decide`, M.tok, { decision: "REJECT" })).s === 400);

  console.log("\n## 3. The manager approves, then HR decides");
  const ap = await call("POST", `/leave/manager/requests/${l1.id}/decide`, M.tok, { decision: "APPROVE", note: "fine by me" });
  ok("the manager approves (200)", ap.s === 200 && ap.b.status === "WAITING_FOR_HR", ap);
  ok("the step is recorded with who and why", (await stepOf(l1.id)).status === "APPROVED" && (await stepOf(l1.id)).decidedById === M.id && (await stepOf(l1.id)).note === "fine by me");
  ok("the request is still pending and NO leave day exists yet", (await leaveRow(l1.id)).status === "PENDING" && (await q(`select 1 from leave_days where "userId"=$1`, [E.id])).length === 0);
  ok("HR is told it is ready", (await note(H.id, "LEAVE_REQUESTED")).length === 1);
  ok("the employee is told the manager approved", (await note(E.id, "LEAVE_DECIDED")).length === 1);
  ok("the manager cannot answer twice (409)", (await call("POST", `/leave/manager/requests/${l1.id}/decide`, M.tok, { decision: "REJECT", note: "changed my mind" })).s === 409);
  const hrOk = await call("POST", `/leave/requests/${l1.id}/decide`, H.tok, { decision: "APPROVE" });
  ok("HR approves (200) and the leave day is written", hrOk.s === 200 && (await q(`select 1 from leave_days where "userId"=$1`, [E.id])).length === 1, hrOk);
  ok("HR's list shows the manager's answer", (await call("GET", "/leave/requests?status=APPROVED", H.tok)).b.requests.find((r) => r.id === l1.id)?.managerStep?.status === "APPROVED");

  console.log("\n## 4. A manager's rejection is final");
  const l2 = await askLeave(E.tok, nextWorkday(4));
  const rj = await call("POST", `/leave/manager/requests/${l2.id}/decide`, M.tok, { decision: "REJECT", note: "Team is short that week" });
  ok("the manager rejects with a reason (200) and the request closes", rj.s === 200 && (await leaveRow(l2.id)).status === "REJECTED" && (await leaveRow(l2.id)).decidedById === M.id, rj);
  ok("the employee is told", (await note(E.id, "LEAVE_DECIDED")).some((n) => /not approved/i.test(n.title)));
  ok("HR cannot approve it afterwards (not pending any more)", (await call("POST", `/leave/requests/${l2.id}/decide`, H.tok, { decision: "APPROVE" })).s !== 200);
  ok("HR cannot skip past a rejection either", (await call("POST", `/leave/requests/${l2.id}/decide`, H.tok, { decision: "APPROVE", skipManager: true, skipReason: "I want it approved" })).s !== 200);
  ok("no leave day was created for it", (await q(`select 1 from leave_days where "userId"=$1 and "leaveRequestId"=$2`, [E.id, l2.id])).length === 0);

  console.log("\n## 5. HR cannot decide without the manager (the override was removed by the organization flow)");
  const l3 = await askLeave(E.tok, nextWorkday(6));
  const skip = await call("POST", `/leave/requests/${l3.id}/decide`, H.tok, { decision: "APPROVE", skipManager: true, skipReason: "Manager is on leave this week" });
  ok("HR is refused even with a written reason (409)", skip.s === 409, skip);
  ok("the step is still waiting and no leave day was written", (await stepOf(l3.id)).status === "PENDING" && (await q(`select 1 from leave_days where "leaveRequestId"=$1`, [l3.id])).length === 0);

  console.log("\n## 6. No manager step when there is no manager");
  const l4 = await askLeave(E2.tok, nextWorkday(8));
  ok("an employee who reports to HR has no manager step", !(await stepOf(l4.id)));
  ok("HR is notified straight away", (await note(H.id, "LEAVE_REQUESTED")).length >= 3);
  ok("HR can decide at once", (await call("POST", `/leave/requests/${l4.id}/decide`, H.tok, { decision: "APPROVE" })).s === 200);
  const l5 = await askLeave(M.tok, nextWorkday(10));
  ok("a manager's own request (his boss is HR) goes straight to HR", !(await stepOf(l5.id)));

  console.log("\n## 7. Cancelled requests drop out of the manager's list");
  const l6 = await askLeave(E.tok, nextWorkday(12));
  ok("it is waiting for the manager", (await call("GET", "/leave/manager/requests", M.tok)).b.pending.some((r) => r.id === l6.id));
  await call("POST", `/leave/requests/${l6.id}/cancel`, E.tok);
  ok("after the employee cancels it is gone from his waiting list", !(await call("GET", "/leave/manager/requests", M.tok)).b.pending.some((r) => r.id === l6.id));
  ok("the manager cannot answer a cancelled request", (await call("POST", `/leave/manager/requests/${l6.id}/decide`, M.tok, { decision: "APPROVE" })).s === 400);

  console.log("\n## 8. Attendance corrections follow the same steps");
  const cd = add(today, -3);
  const c1 = (await call("POST", "/attendance-corrections", E.tok, { date: cd, correctionType: "MISSING_CHECKIN", requestedLogin: "10:00", requestedLogout: "19:00", reason: "Biometric machine did not scan me in" })).b;
  ok("the correction is created", !!c1.id, c1);
  const cs1 = await stepOf(c1.id);
  ok("a manager step exists for it, asking his manager", cs1 && cs1.status === "PENDING" && cs1.approverIds[0] === M.id && cs1.kind === "CORRECTION", cs1);
  ok("the manager is told, HR is not", (await note(M.id, "CORRECTION_SUBMITTED")).length === 1 && (await note(H.id, "CORRECTION_SUBMITTED")).length === 0);
  ok("the manager's list shows it", (await call("GET", "/attendance-corrections/manager/requests", M.tok)).b.pending.some((r) => r.id === c1.id));
  ok("HR cannot decide yet (409)", (await call("POST", `/attendance-corrections/${c1.id}/decide`, H.tok, { decision: "APPROVE" })).s === 409);
  ok("a rejection without a reason is refused (400)", (await call("POST", `/attendance-corrections/manager/requests/${c1.id}/decide`, M.tok, { decision: "REJECT" })).s === 400);
  ok("another manager cannot answer it (404)", (await call("POST", `/attendance-corrections/manager/requests/${c1.id}/decide`, M2.tok, { decision: "APPROVE" })).s === 404);
  const cap = await call("POST", `/attendance-corrections/manager/requests/${c1.id}/decide`, M.tok, { decision: "APPROVE", comment: "I saw him" });
  ok("the manager approves (200) and attendance is still unchanged", cap.s === 200 && (await q(`select 1 from work_sessions where "userId"=$1`, [E.id])).length === 0, cap);
  ok("HR is told it is ready", (await note(H.id, "CORRECTION_SUBMITTED")).length === 1);
  const chr = await call("POST", `/attendance-corrections/${c1.id}/decide`, H.tok, { decision: "APPROVE" });
  ok("HR approves (200): the attendance record is created", chr.s === 200 && (await q(`select 1 from work_sessions where "userId"=$1`, [E.id])).length === 1, chr);

  const c2 = (await call("POST", "/attendance-corrections", E.tok, { date: add(today, -5), correctionType: "INCORRECT_TIME", requestedLogin: "10:20", reason: "Clocked in late by mistake, arrived 10:20" })).b;
  ok("a manager's rejection of a correction closes it", (await call("POST", `/attendance-corrections/manager/requests/${c2.id}/decide`, M.tok, { decision: "REJECT", comment: "No evidence" })).s === 200 && (await q(`select status from attendance_correction_requests where id=$1`, [c2.id]))[0].status === "REJECTED");
  ok("HR cannot approve it afterwards", (await call("POST", `/attendance-corrections/${c2.id}/decide`, H.tok, { decision: "APPROVE" })).s !== 200);
  const c3 = (await call("POST", "/attendance-corrections", E.tok, { date: add(today, -6), correctionType: "BIOMETRIC_FAILURE", requestedLogin: "10:10", reason: "Machine rejected my finger at 10:05" })).b;
  ok("HR can decide without the manager, with a reason", (await call("POST", `/attendance-corrections/${c3.id}/decide`, H.tok, { decision: "REJECT", comment: "Not enough detail", skipManager: true, skipReason: "Manager unreachable today" })).s === 200 && (await stepOf(c3.id)).status === "SKIPPED");
  const c4 = (await call("POST", "/attendance-corrections", E2.tok, { date: add(today, -4), correctionType: "OTHER", requestedLogin: "10:30", reason: "Forgot to clock in this morning" })).b;
  ok("an employee with no manager: no step, HR decides at once", !(await stepOf(c4.id)) && (await call("POST", `/attendance-corrections/${c4.id}/decide`, H.tok, { decision: "REJECT", comment: "Please attach proof" })).s === 200);

  await wipe();
  await db.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
