// Leave "Hold": real sign-ins, real HTTP, THROWAWAY database only (it applies the hold migration part-way to prove the before/after).
//   cd backend && TEST_DATABASE_URL=... TEST_API=http://localhost:5012/api node tests/leave-hold.test.cjs
// Start with the migration NOT applied (a fresh throwaway database, or:  ALTER TABLE leave_approval_events DROP CONSTRAINT leave_approval_events_action_check; re-add it without 'HELD').
require("dotenv").config({ path: require("node:path").join(__dirname, "..", ".env") });
const { Client } = require("pg");
const bcrypt = require("bcryptjs");
const fs = require("node:fs");
const path = require("node:path");
const API = process.env.TEST_API ?? "http://localhost:5012/api";
require("./_guard.cjs").assertTestDb(process.env.TEST_DATABASE_URL);

const call = async (m, p, t, b) => {
  const r = await fetch(API + p, { method: m, headers: { "content-type": "application/json", ...(t ? { authorization: "Bearer " + t } : {}) }, body: b !== undefined ? JSON.stringify(b) : undefined });
  const txt = await r.text(); let j; try { j = JSON.parse(txt); } catch { j = txt; }
  return { s: r.status, b: j };
};
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  -> " + String(JSON.stringify(x)).slice(0, 400))); };
const PW = "Hld@12345678";
const add = (s, n) => new Date(new Date(s + "T00:00:00Z").getTime() + n * 864e5).toISOString().slice(0, 10);
const weekday = (iso) => new Date(iso + "T00:00:00Z").getUTCDay() || 7;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const db = new Client({ connectionString: process.env.TEST_DATABASE_URL }); await db.connect();
  const q = async (s, p) => (await db.query(s, p)).rows;
  const AV = (await q(`select id from platforms where slug='avatar'`))[0].id;
  const hash = await bcrypt.hash(PW, 10);
  const wipe = async () => {
    const ids = `(select id from users where "employeeCode" like 'HLD-%')`;
    await q(`delete from request_approvals where kind='LEAVE' and "requestId" in (select id from leave_requests where "userId" in ${ids})`);
    await q(`delete from leave_days where "userId" in ${ids}`);
    await q(`delete from leave_requests where "userId" in ${ids}`);
    await q(`delete from notifications where "userId" in ${ids}`);
    await q(`delete from users where "employeeCode" like 'HLD-%'`);
  };
  await wipe();
  const mk = async (code, role, reportsToId = null) => {
    await q(`insert into users (id,"platformId",email,"passwordHash","firstName","lastName","employeeCode",role,status,"mustChangePassword","trackerAccessEnabled","onboardingStatus","reportsToId","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,$4,'Hld',$5,$6,'ACTIVE',false,true,'ACTIVE',$7,now(),now())`, [AV, code.toLowerCase() + "@hld.test", hash, code.replace("HLD-", ""), code, role, reportsToId]);
    const id = (await q(`select id from users where "employeeCode"=$1`, [code]))[0].id;
    const tok = (await call("POST", "/auth/login", null, { email: code, password: PW })).b.token;
    return { id, tok };
  };
  const ADM = await mk("HLD-ADM", "ADMIN");
  const HR1 = await mk("HLD-HR1", "HR", ADM.id);
  const HR2 = await mk("HLD-HR2", "HR", ADM.id);
  const MGR = await mk("HLD-MGR", "MANAGER", ADM.id);
  const MGR2 = await mk("HLD-MGR2", "MANAGER", ADM.id);
  const EMP = await mk("HLD-EMP", "EMPLOYEE", MGR.id);

  // a Monday well inside the allowed window, then one working day per request, a week apart
  let monday = add(new Date().toISOString().slice(0, 10), 7);
  while (weekday(monday) !== 1) monday = add(monday, 1);
  let week = 0;
  const nextDay = () => add(monday, 7 * week++);
  const request = async (who, extra = {}) => { const d = nextDay(); const r = await call("POST", "/leave/requests", who.tok, { leaveType: "CASUAL", from: d, to: d, reason: "hold test", ...extra }); return { ...r, date: d, id: r.b?.id ?? r.b?.request?.id }; };
  const mgrDecide = (who, id, decision, note) => call("POST", `/leave/manager/requests/${id}/decide`, who.tok, { decision, note });
  const hrDecide = (who, id, decision, note) => call("POST", `/leave/requests/${id}/decide`, who.tok, { decision, note });
  const row = async (id) => (await q(`select status, "decisionNote", "decidedById" from leave_requests where id=$1`, [id]))[0];
  const events = async (id) => await q(`select step, action, comment, "actorName", "actorRole" from leave_approval_events where "requestId"=$1 order by "createdAt"`, [id]);
  const daysOf = async (id) => (await q(`select count(*)::int n from leave_days where "leaveRequestId"=$1`, [id]))[0].n;
  const heldRows = async () => (await q(`select count(*)::int n from leave_requests r join users u on u.id = r."userId" where u."employeeCode" like 'HLD-%' and r.status::text = 'ON_HOLD'`).catch(() => [{ n: -1 }]))[0].n;

  try {
    console.log("## 0. BEFORE the migration: Hold says 'not ready', Approve and Reject still work");
    const r1 = await request(EMP);
    ok("employee submits a request", r1.s === 200 || r1.s === 201, r1);
    const pre = await mgrDecide(MGR, r1.id, "HOLD", "waiting for the roster");
    ok("hold answers 503 'not switched on'", pre.s === 503, pre);
    ok("the request is untouched (still PENDING)", (await row(r1.id)).status === "PENDING");
    ok("manager approves as before", (await mgrDecide(MGR, r1.id, "APPROVE", "ok")).s === 200);
    const preHr = await hrDecide(HR1, r1.id, "APPROVE", "fine");
    ok("HR approves as before and the day is written", preHr.s === 200 && (await row(r1.id)).status === "APPROVED" && (await daysOf(r1.id)) === 1, preHr);

    console.log("\n## apply the migration to the throwaway database");
    const sql = fs.readFileSync(path.join(__dirname, "..", "prisma", "migrations", "20261121100000_leave_on_hold", "migration.sql"), "utf8");
    const enumHas = (await q(`select count(*)::int n from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname='LeaveRequestStatus' and e.enumlabel='ON_HOLD'`))[0].n;
    if (!enumHas) await db.query(sql);
    else await q(`ALTER TABLE "leave_approval_events" DROP CONSTRAINT IF EXISTS "leave_approval_events_action_check"`).then(() => q(`ALTER TABLE "leave_approval_events" ADD CONSTRAINT "leave_approval_events_action_check" CHECK ("action" IN ('SUBMITTED','APPROVED','REJECTED','CANCELLED','AUTO_APPROVED','HELD'))`));
    await sleep(17000); // the server re-checks a missing feature every 15 s

    console.log("\n## 1. A manager puts an employee's leave on hold");
    const r2 = await request(EMP);
    const noReason = await mgrDecide(MGR, r2.id, "HOLD", "");
    ok("hold without a reason is refused (400)", noReason.s === 400, noReason);
    ok("a 2-character reason is refused too", (await mgrDecide(MGR, r2.id, "HOLD", "ab")).s === 400);
    ok("the request is still PENDING after the refusals", (await row(r2.id)).status === "PENDING");
    const h = await mgrDecide(MGR, r2.id, "HOLD", "Roster not final, will review Friday");
    ok("manager puts it on hold (200, ON_HOLD)", h.s === 200 && h.b.status === "ON_HOLD", h);
    ok("stored status is ON_HOLD", (await row(r2.id)).status === "ON_HOLD");
    const ev = await events(r2.id);
    const held = ev.find((e) => e.action === "HELD");
    ok("history has a HELD line with who, role, step and the reason", !!held && held.actorName.includes("MGR") && held.actorRole === "MANAGER" && held.step === "MANAGER" && held.comment === "Roster not final, will review Friday", ev);
    ok("it is neither approved nor decided (no decidedBy, no days)", (await row(r2.id)).decidedById === null && (await daysOf(r2.id)) === 0);
    const note = await q(`select title, body from notifications where "userId"=$1 and title='Your leave request is on hold'`, [EMP.id]);
    ok("the employee was notified with the reason", note.length === 1 && note[0].body.includes("Roster not final"), note);
    const mine = (await call("GET", "/leave/mine", EMP.tok)).b;
    const mineRow = (mine.requests ?? []).find((x) => x.id === r2.id);
    ok("the employee sees On Hold with the hold details", mineRow?.status === "ON_HOLD" && mineRow.stage === "ON_HOLD" && mineRow.stageLabel === "On Hold" && mineRow.hold?.reason === "Roster not final, will review Friday", mineRow);
    ok("the audit log has the hold line", (await q(`select count(*)::int n from audit_logs where summary like 'Put leave % on hold:%'`))[0].n >= 1);

    console.log("\n## 2. While it is on hold");
    ok("holding again answers 409", (await mgrDecide(MGR, r2.id, "HOLD", "again please")).s === 409);
    ok("another manager cannot hold it (404)", (await mgrDecide(MGR2, r2.id, "HOLD", "not mine to hold")).s === 404);
    ok("an Admin who is not tagged cannot answer it (404)", (await mgrDecide(ADM, r2.id, "APPROVE", "x")).s === 404);
    ok("the employee cannot decide or hold it (403)", (await mgrDecide(EMP, r2.id, "HOLD", "sneaky")).s === 403 && (await hrDecide(EMP, r2.id, "APPROVE")).s === 403);
    ok("HR cannot approve it while the first approver has it on hold (409)", (await hrDecide(HR1, r2.id, "APPROVE", "no")).s === 409);
    ok("HR cannot hold it either (409)", (await hrDecide(HR1, r2.id, "HOLD", "me too")).s === 409);
    const clash = await call("POST", "/leave/requests", EMP.tok, { leaveType: "CASUAL", from: r2.date, to: r2.date, reason: "same day again" });
    ok("the employee cannot file the same day again (a held request still blocks the dates)", clash.s === 400, clash);
    const team = (await call("GET", "/leave/manager/requests", MGR.tok)).b;
    ok("it stays visible in the manager's list, marked On Hold", (team.pending ?? []).some((x) => x.id === r2.id && x.status === "ON_HOLD"), (team.pending ?? []).map((x) => [x.id, x.status]));
    const hrList = (await call("GET", "/leave/requests?status=ON_HOLD", HR1.tok)).b;
    ok("HR can filter On Hold and sees it with the reason", (hrList.requests ?? []).some((x) => x.id === r2.id && x.stage === "ON_HOLD" && x.hold?.reason), (hrList.requests ?? []).length);
    const byStage = (await call("GET", "/leave/requests?stage=ON_HOLD", HR1.tok)).b;
    ok("the On Hold stage filter works", (byStage.requests ?? []).some((x) => x.id === r2.id));
    const ov = (await call("GET", "/leave/overview", HR1.tok)).b;
    ok("the HR overview counts it as on hold and not as waiting for HR", ov.onHold >= 1, ov);
    const taken = (await call("GET", `/leave/person/${EMP.id}`, HR1.tok)).b;
    ok("no leave is counted for the held request (nothing deducted)", JSON.stringify(taken).indexOf(r2.date) === -1 || !(taken.days ?? []).some((d) => (d.date ?? d) === r2.date), taken);

    console.log("\n## 3. The same approver resumes it: approve");
    const ap = await mgrDecide(MGR, r2.id, "APPROVE", "roster is final");
    ok("approve works on a held request and moves it to HR", ap.s === 200 && ap.b.status === "WAITING_FOR_HR", ap);
    ok("it is back to PENDING (no longer on hold)", (await row(r2.id)).status === "PENDING");
    const mine2 = ((await call("GET", "/leave/mine", EMP.tok)).b.requests ?? []).find((x) => x.id === r2.id);
    ok("the employee now sees Pending HR Approval", mine2?.stage === "PENDING_HR", mine2);

    console.log("\n## 4. HR puts it on hold at the final stage, then approves");
    ok("HR hold needs a reason (400)", (await hrDecide(HR1, r2.id, "HOLD", "")).s === 400);
    const hh = await hrDecide(HR1, r2.id, "HOLD", "Checking the leave policy for this month");
    ok("HR puts it on hold (200)", hh.s === 200 && hh.b.status === "ON_HOLD", hh);
    const ev2 = await events(r2.id);
    ok("history shows both holds, by manager and by HR, in order", ev2.map((e) => e.action + ":" + e.step).join() === "SUBMITTED:REQUEST,HELD:MANAGER,APPROVED:MANAGER,HELD:HR", ev2.map((e) => e.action + ":" + e.step));
    ok("the manager can no longer answer it (the first level is done)", (await mgrDecide(MGR, r2.id, "APPROVE", "x")).s === 404 || (await mgrDecide(MGR, r2.id, "APPROVE", "x")).s === 409);
    const fin = await hrDecide(HR2, r2.id, "APPROVE", "all good now");
    ok("HR approves the held request (200) and the day is written", fin.s === 200 && (await row(r2.id)).status === "APPROVED" && (await daysOf(r2.id)) === 1, fin);
    const ev3 = await events(r2.id);
    ok("complete history: submitted, held, approved (manager), held (HR), approved (HR)", ev3.map((e) => e.action).join() === "SUBMITTED,HELD,APPROVED,HELD,APPROVED", ev3.map((e) => e.action));

    console.log("\n## 5. Reject from hold");
    const r3 = await request(EMP);
    await mgrDecide(MGR, r3.id, "HOLD", "need to ask the client");
    const rj = await mgrDecide(MGR, r3.id, "REJECT", "client deadline that week");
    ok("reject works on a held request and ends the workflow", rj.s === 200 && (await row(r3.id)).status === "REJECTED" && (await daysOf(r3.id)) === 0, rj);
    ok("history: submitted, held, rejected", (await events(r3.id)).map((e) => e.action).join() === "SUBMITTED,HELD,REJECTED");
    ok("a rejected request cannot be held or approved any more", (await mgrDecide(MGR, r3.id, "HOLD", "too late")).s >= 400 && (await hrDecide(HR1, r3.id, "APPROVE")).s >= 400);

    console.log("\n## 6. The employee withdraws a held request");
    const r4 = await request(EMP);
    await mgrDecide(MGR, r4.id, "HOLD", "later this week");
    const cn = await call("POST", `/leave/requests/${r4.id}/cancel`, EMP.tok);
    ok("cancel works on a held request", cn.s === 200 && (await row(r4.id)).status === "CANCELLED", cn);

    console.log("\n## 7. A manager's leave: the mapped Admin holds, then approves; HR finishes");
    const r5 = await request(MGR);
    const ah = await mgrDecide(ADM, r5.id, "HOLD", "waiting for the quarter plan");
    ok("the Admin puts a manager's leave on hold", ah.s === 200 && (await row(r5.id)).status === "ON_HOLD", ah);
    ok("the history names the Admin step", (await events(r5.id)).some((e) => e.action === "HELD" && e.step === "ADMIN" && e.actorRole === "ADMIN"));
    ok("HR cannot approve it while the Admin holds it (409)", (await hrDecide(HR1, r5.id, "APPROVE")).s === 409);
    ok("the Admin approves it afterwards, moving it to HR", (await mgrDecide(ADM, r5.id, "APPROVE", "ok")).b.status === "WAITING_FOR_HR" && (await row(r5.id)).status === "PENDING");
    ok("HR gives the final approval", (await hrDecide(HR1, r5.id, "APPROVE", "approved")).s === 200 && (await daysOf(r5.id)) === 1);

    console.log("\n## 8. HR's own leave: the Admin holds, then approves (final)");
    const r6 = await request(HR2, { approverId: ADM.id });
    ok("HR submits tagged to the Admin", r6.s === 200 || r6.s === 201, r6);
    ok("the Admin holds it", (await mgrDecide(ADM, r6.id, "HOLD", "check the handover")).s === 200 && (await row(r6.id)).status === "ON_HOLD");
    const fin6 = await mgrDecide(ADM, r6.id, "APPROVE", "handover done");
    ok("the Admin's approval of HR's leave is final and writes the day", fin6.s === 200 && (await row(r6.id)).status === "APPROVED" && (await daysOf(r6.id)) === 1, fin6);

    console.log("\n## 9. Nothing else changed");
    ok("only the requests still on hold are ON_HOLD (none left here)", (await heldRows()) === 0);
    const bad = await mgrDecide(MGR, "00000000-0000-4000-8000-000000000000", "HOLD", "nothing here");
    ok("an unknown request answers 404", bad.s === 404);
    ok("an invalid decision word is refused", (await mgrDecide(MGR, r2.id, "PAUSE", "x")).s === 400);
  } finally {
    await wipe().catch((e) => console.log("wipe note:", e.message));
    await db.end();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
