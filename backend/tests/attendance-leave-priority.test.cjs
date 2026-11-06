// Attendance Calendar + Attendance report: approved leave, holiday, week-off, absent and half-day leave classification, over HTTP.
// Disposable database only (see _guard.cjs). NO migration is needed: it only reads leave_requests / leave_days / holidays / shifts / work_sessions.
//
//   cd backend && TEST_DATABASE_URL=... TEST_API=http://localhost:5012/api node tests/attendance-leave-priority.test.cjs
require("dotenv").config({ path: require("node:path").join(__dirname, "..", ".env") });
const { Client } = require("pg");
const bcrypt = require("bcryptjs");
const API = process.env.TEST_API ?? "http://localhost:5002/api";
require("./_guard.cjs").assertTestDb(process.env.TEST_DATABASE_URL);

const call = async (m, p, t) => {
  const r = await fetch(API + p, { method: m, headers: { ...(t ? { authorization: "Bearer " + t } : {}) } });
  const txt = await r.text(); let j; try { j = JSON.parse(txt); } catch { j = txt; }
  return { s: r.status, b: j };
};
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  -> " + String(JSON.stringify(x)).slice(0, 500))); };
const PW = "Lvp@12345678";

(async () => {
  const db = new Client({ connectionString: process.env.TEST_DATABASE_URL }); await db.connect();
  const q = async (s, p) => (await db.query(s, p)).rows;
  const AV = (await q(`select id from platforms where slug='avatar'`))[0].id;
  const AVN = (await q(`select id from platforms where slug='avance'`))[0].id;
  const hash = await bcrypt.hash(PW, 10);
  const wipe = async () => {
    const ids = `(select id from users where "employeeCode" like 'LVP-%')`;
    await q(`delete from leave_days where "userId" in ${ids}`);
    await q(`delete from leave_requests where "userId" in ${ids}`);
    await q(`delete from tracker_breaks where "workSessionId" in (select id from work_sessions where "userId" in ${ids})`);
    await q(`delete from work_sessions where "userId" in ${ids}`);
    await q(`delete from holidays where name like 'LVP-%'`);
    await q(`delete from users where "employeeCode" like 'LVP-%'`);
  };
  await wipe();
  const mk = async (code, role, platformId) => {
    await q(`insert into users (id,"platformId",email,"passwordHash","firstName","lastName","employeeCode",role,status,"mustChangePassword","trackerAccessEnabled","onboardingStatus","dateOfJoining","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,$4,'Lvp',$5,$6,'ACTIVE',false,true,'ACTIVE','2026-01-01',now(),now())`, [platformId, code.toLowerCase() + "@lvp.test", hash, code.replace("LVP-", "T"), code, role]);
    const id = (await q(`select id from users where "employeeCode"=$1`, [code]))[0].id;
    const tok = (await (await fetch(API + "/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: code, password: PW }) })).json()).token;
    return { id, tok };
  };
  const HR = await mk("LVP-HR", "HR", AV);
  const E = {
    working: await mk("LVP-WORK", "EMPLOYEE", AV), // checked in on D1 -> proves the company was tracking
    approved: await mk("LVP-APPR", "EMPLOYEE", AV), // approved leave on D1 (day row written, as approval does)
    pending: await mk("LVP-PEND", "EMPLOYEE", AV), // pending request on D1
    rejected: await mk("LVP-REJ", "EMPLOYEE", AV), // rejected request on D1
    cancelled: await mk("LVP-CAN", "EMPLOYEE", AV), // cancelled request on D1
    absent: await mk("LVP-ABS", "EMPLOYEE", AV), // nothing at all on D1
    noRow: await mk("LVP-NOROW", "EMPLOYEE", AV), // approved request but NO leave_days row (safety net)
    halfNoIn: await mk("LVP-HALF1", "EMPLOYEE", AV), // approved half-day leave, never clocked in
    halfIn: await mk("LVP-HALF2", "EMPLOYEE", AV), // approved half-day leave, clocked in for the other half
    leaveButIn: await mk("LVP-LIN", "EMPLOYEE", AV), // approved leave but clocked in anyway
    other: await mk("LVP-OTH", "EMPLOYEE", AVN), // another company
  };
  const D1 = "2026-10-27"; // Tuesday, a scheduled working day
  const HOL = "2026-10-26"; // Monday, declared a holiday for the first company only
  const SUN = "2026-10-25"; // Sunday, the default shift's weekly off
  const ist = (day, hhmm) => { const [y, mo, d] = day.split("-").map(Number); const [h, m] = hhmm.split(":").map(Number); return new Date(Date.UTC(y, mo - 1, d, h, m) - 330 * 60_000).toISOString(); };
  const session = async (u, day, inAt, outAt, productive, platformId = AV) =>
    q(`insert into work_sessions (id,"platformId","userId",date,"loginAt","logoutAt",status,"productiveSeconds","breakSeconds","meetingSeconds","wasLateLogin","lateByMinutes","autoClosed","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3::date,$4,$5,'COMPLETED',$6,0,0,false,0,false,now(),now())`, [platformId, u.id, day, ist(day, inAt), ist(day, outAt), productive]);
  const request = async (u, status, { half = false, first = true, from = D1, to = D1, reason = "Family function" } = {}) =>
    (await q(`insert into leave_requests (id,"platformId","userId","fromDate","toDate","leaveType","isHalfDay","isFirstHalf","dayCount",reason,status,"createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3::date,$4::date,'CASUAL',$5,$6,$7,$8,$9::"LeaveRequestStatus",now(),now()) returning id`, [AV, u.id, from, to, half, first, half ? 0.5 : 1, reason, status]))[0].id;
  const dayRow = async (u, reqId, { half = false, first = true, day = D1 } = {}) =>
    q(`insert into leave_days (id,"platformId","userId",date,"leaveType","isHalfDay","isFirstHalf","leaveRequestId","markedById","createdAt") values (gen_random_uuid(),$1,$2,$3::date,'CASUAL',$4,$5,$6,$7,now())`, [AV, u.id, day, half, first, reqId, HR.id]);

  // the company was tracking on D1 (someone clocked in)
  await session(E.working, D1, "09:30", "18:00", 8 * 3600);
  // the other company has someone tracking too, so their absence logic is independent
  await session(E.other, D1, "09:30", "18:00", 8 * 3600, AVN);

  const rApproved = await request(E.approved, "APPROVED"); await dayRow(E.approved, rApproved);
  await request(E.pending, "PENDING");
  await request(E.rejected, "REJECTED");
  await request(E.cancelled, "CANCELLED");
  await request(E.noRow, "APPROVED"); // no leave_days row written
  const rH1 = await request(E.halfNoIn, "APPROVED", { half: true, first: true }); await dayRow(E.halfNoIn, rH1, { half: true, first: true });
  const rH2 = await request(E.halfIn, "APPROVED", { half: true, first: false }); await dayRow(E.halfIn, rH2, { half: true, first: false });
  await session(E.halfIn, D1, "09:30", "14:00", 4 * 3600);
  const rL = await request(E.leaveButIn, "APPROVED"); await dayRow(E.leaveButIn, rL);
  await session(E.leaveButIn, D1, "09:30", "18:00", 8 * 3600);

  // a company holiday on HOL for the first company only; and a person who worked on it
  await q(`insert into holidays (id,"platformId",date,name,"dayType","createdAt") values (gen_random_uuid(),$1,$2::date,'LVP-Founders Day','PUBLIC_HOLIDAY',now())`, [AV, HOL]);
  await session(E.working, HOL, "09:30", "12:00", 2 * 3600); // makes the company "tracking" on the holiday too
  await session(E.other, HOL, "09:30", "18:00", 8 * 3600, AVN);

  const cal = (t, from, to, extra = "") => call("GET", `/attendance-calendar?from=${from}&to=${to}${extra}`, t);
  const day = (res, u, d) => res.b.rows?.find((r) => r.userId === u.id && r.date === d);
  const st = (res, u, d) => day(res, u, d)?.status;

  const h = await cal(HR.tok, SUN, D1);
  ok("HR calendar loads", h.s === 200, h);

  console.log("\n## 1. Approved leave");
  ok("approved leave on D1 shows Leave, not Absent", st(h, E.approved, D1) === "LEAVE", day(h, E.approved, D1));
  ok("the reason from the leave request is shown", day(h, E.approved, D1)?.leaveReason === "Family function");
  ok("approved leave with NO day row (shift/holiday changed after approval) still shows Leave", st(h, E.noRow, D1) === "LEAVE", day(h, E.noRow, D1));
  ok("approved leave wins even when the person clocked in that day", st(h, E.leaveButIn, D1) === "LEAVE", day(h, E.leaveButIn, D1));
  ok("...and the time they did work is still shown", day(h, E.leaveButIn, D1)?.workedSeconds === 8 * 3600 && /Worked/.test(day(h, E.leaveButIn, D1)?.remarks ?? ""), day(h, E.leaveButIn, D1));

  console.log("\n## 2. Pending, rejected and cancelled leave are NOT leave");
  ok("pending request = Absent (nothing approved)", st(h, E.pending, D1) === "ABSENT", day(h, E.pending, D1));
  ok("rejected request = Absent", st(h, E.rejected, D1) === "ABSENT", day(h, E.rejected, D1));
  ok("cancelled request = Absent", st(h, E.cancelled, D1) === "ABSENT", day(h, E.cancelled, D1));
  ok("a person with no leave and no check-in on a tracked working day = Absent", st(h, E.absent, D1) === "ABSENT", day(h, E.absent, D1));

  console.log("\n## 3. Half-day leave");
  ok("approved half-day leave, never clocked in = Half-day leave (was Absent)", st(h, E.halfNoIn, D1) === "HALF_DAY_LEAVE", day(h, E.halfNoIn, D1));
  ok("the half is named (first half)", day(h, E.halfNoIn, D1)?.leaveHalfDay === "first half", day(h, E.halfNoIn, D1));
  ok("approved half-day leave plus a check-in = Half-day leave, with the worked time kept", st(h, E.halfIn, D1) === "HALF_DAY_LEAVE" && day(h, E.halfIn, D1)?.workedSeconds === 4 * 3600 && day(h, E.halfIn, D1)?.leaveHalfDay === "second half", day(h, E.halfIn, D1));

  console.log("\n## 4. Company holiday");
  ok("a company holiday shows Holiday for the company's people", st(h, E.absent, HOL) === "HOLIDAY" && st(h, E.approved, HOL) === "HOLIDAY", day(h, E.absent, HOL));
  ok("the holiday name is shown", day(h, E.absent, HOL)?.holidayName === "LVP-Founders Day");
  ok("someone who worked on the holiday still shows Holiday (the work is kept)", st(h, E.working, HOL) === "HOLIDAY" && day(h, E.working, HOL)?.workedSeconds === 2 * 3600, day(h, E.working, HOL));
  const ob = await cal((await (async () => { const u = await mk("LVP-HRB", "HR", AVN); return u; })()).tok, HOL, HOL);
  ok("another company's holiday calendar is separate: their people are NOT on this holiday", ob.b.rows?.find((r) => r.userId === E.other.id)?.status !== "HOLIDAY", ob.b.rows);

  console.log("\n## 5. Weekly off");
  ok("Sunday (not in the default shift's working days) shows Week-off, not Absent", st(h, E.absent, SUN) === "WEEK_OFF" && st(h, E.pending, SUN) === "WEEK_OFF", day(h, E.absent, SUN));

  console.log("\n## 6. Priority: leave > holiday > week-off > attendance > absent");
  // an approved leave day written on the holiday itself (HR marked it by hand) wins over the holiday
  const rLH = await request(E.pending, "APPROVED", { from: HOL, to: HOL }); await dayRow(E.pending, rLH, { day: HOL });
  const h2 = await cal(HR.tok, HOL, HOL);
  ok("approved leave on a holiday = Leave (leave comes first)", st(h2, E.pending, HOL) === "LEAVE", day(h2, E.pending, HOL));
  const rSpan = await request(E.noRow, "APPROVED", { from: "2026-10-23", to: SUN }); // Fri..Sun, no rows
  const h3 = await cal(HR.tok, "2026-10-23", SUN);
  ok("...Friday (a working day) = Leave and Sunday (week-off) = Week-off", st(h3, E.noRow, "2026-10-23") === "LEAVE" && st(h3, E.noRow, SUN) === "WEEK_OFF", [day(h3, E.noRow, "2026-10-23"), day(h3, E.noRow, SUN)]);

  console.log("\n## 7. Summary counts use the same classification");
  const c1 = (await cal(HR.tok, D1, D1)).b.counts;
  const ofCode = (res, status) => res.b.rows.filter((r) => r.status === status).length;
  const hd = await cal(HR.tok, D1, D1);
  ok("the Leave count equals the Leave rows (approved, no-row, clocked-in-on-leave = 3)", c1.LEAVE === ofCode(hd, "LEAVE") && c1.LEAVE >= 3, c1);
  ok("the Half-day leave count equals its rows (2)", c1.HALF_DAY_LEAVE === 2 && ofCode(hd, "HALF_DAY_LEAVE") === 2, c1);
  ok("Absent counts only the non-approved ones (pending, rejected, cancelled, nothing)", ["pending", "rejected", "cancelled", "absent"].every((k) => st(hd, E[k], D1) === "ABSENT"), c1);
  ok("every counter equals the number of rows with that status", Object.entries(c1).every(([k, v]) => v === ofCode(hd, k)), c1);
  const range = await cal(HR.tok, SUN, D1);
  ok("a date range uses the same classification as a single day", st(range, E.approved, D1) === "LEAVE" && st(range, E.absent, SUN) === "WEEK_OFF" && st(range, E.absent, HOL) === "HOLIDAY", range.b.counts);

  console.log("\n## 8. The employee's own My Calendar");
  const mine = await cal(E.approved.tok, SUN, D1);
  ok("the employee sees their approved leave as Leave", st(mine, E.approved, D1) === "LEAVE", mine.b.rows);
  const minePending = await cal(E.pending.tok, D1, D1);
  ok("the employee with only a pending request sees Absent", st(minePending, E.pending, D1) === "ABSENT");
  const mineHalf = await cal(E.halfNoIn.tok, D1, D1);
  ok("the employee on half-day leave sees Half-day leave", st(mineHalf, E.halfNoIn, D1) === "HALF_DAY_LEAVE");

  console.log("\n## 9. The Attendance report (HR) agrees with the calendar");
  const rep = await call("GET", `/team-attendance/attendance?from=${D1}&to=${D1}`, HR.tok);
  const rrow = (u) => rep.b.rows?.find((r) => r.userId === u.id && r.date === D1);
  ok("the report loads", rep.s === 200, rep);
  ok("approved leave = Leave in the report", rrow(E.approved)?.status === "LEAVE", rrow(E.approved));
  ok("approved leave with no day row = Leave in the report", rrow(E.noRow)?.status === "LEAVE", rrow(E.noRow));
  ok("leave while clocked in = Leave in the report", rrow(E.leaveButIn)?.status === "LEAVE", rrow(E.leaveButIn));
  ok("pending / rejected = Absent in the report", rrow(E.rejected)?.status === "ABSENT" && rrow(E.pending)?.status === "ABSENT", [rrow(E.rejected), rrow(E.pending)]);
  ok("the report's arrival column for a half-day leave is Half-day leave, not Absent", rrow(E.halfNoIn)?.arrival === "HALF_DAY_LEAVE", rrow(E.halfNoIn));

  console.log("\n## 10. History is untouched");
  ok("no leave day was added or removed by reading", (await q(`select count(*)::int n from leave_days where "userId" in (select id from users where "employeeCode" like 'LVP-%')`))[0].n === 5, await q(`select count(*)::int n from leave_days where "userId" in (select id from users where "employeeCode" like 'LVP-%')`));
  ok("the requests keep their status", (await q(`select status from leave_requests where "userId"=$1`, [E.pending.id])).some((r) => r.status === "PENDING"));

  await wipe();
  await db.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
