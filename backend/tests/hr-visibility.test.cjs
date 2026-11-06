// HR and Admin see the employees of EVERY company they act on, consistently across modules; HR without a grant and managers do not get more; the Reports
// numbers of a single company do not change, and each company is calculated with its own holidays. Disposable database only (see _guard.cjs).
//
//   cd backend && TEST_DATABASE_URL=... TEST_API=http://localhost:5012/api node tests/hr-visibility.test.cjs
require("dotenv").config({ path: require("node:path").join(__dirname, "..", ".env") });
const { Client } = require("pg");
const bcrypt = require("bcryptjs");
const API = process.env.TEST_API ?? "http://localhost:5002/api";
require("./_guard.cjs").assertTestDb(process.env.TEST_DATABASE_URL);

const call = async (m, p, t, body) => {
  const r = await fetch(API + p, { method: m, headers: { ...(t ? { authorization: "Bearer " + t } : {}), ...(body && m !== "GET" ? { "content-type": "application/json" } : {}) }, body: body && m !== "GET" ? JSON.stringify(body) : undefined });
  const txt = await r.text(); let j; try { j = JSON.parse(txt); } catch { j = txt; }
  return { s: r.status, b: j, raw: txt };
};
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  -> " + String(JSON.stringify(x)).slice(0, 400))); };
const PW = "Vis@12345678";

(async () => {
  const db = new Client({ connectionString: process.env.TEST_DATABASE_URL }); await db.connect();
  const q = async (s, p) => (await db.query(s, p)).rows;
  const AV = (await q(`select id from platforms where slug='avatar'`))[0].id;
  const AVN = (await q(`select id from platforms where slug='avance'`))[0].id;
  const hash = await bcrypt.hash(PW, 10);
  const wipe = async () => {
    const ids = `(select id from users where "employeeCode" like 'VIS-%')`;
    for (const s of [
      `delete from meeting_tracking where "meetingId" in (select id from meetings where "organizerId" in ${ids})`,
      `delete from meeting_attendees where "meetingId" in (select id from meetings where "organizerId" in ${ids})`,
      `delete from meetings where "organizerId" in ${ids}`,
      `delete from holidays where name like 'VIS-%'`,
      `delete from task_entry_details where "taskId" in (select id from daily_tasks where "userId" in ${ids})`,
      `delete from daily_tasks where "userId" in ${ids}`,
      `delete from leave_approval_events where "requestId" in (select id from leave_requests where "userId" in ${ids})`,
      `delete from request_approvals where kind='LEAVE' and "requestId" in (select id from leave_requests where "userId" in ${ids})`,
      `delete from leave_requests where "userId" in ${ids}`,
      `delete from work_sessions where "userId" in ${ids}`,
      `delete from company_access where "userId" in ${ids}`,
      `delete from team_members where "userId" in ${ids}`,
      `delete from teams where name like 'VIS-%'`,
      `delete from notifications where "userId" in ${ids}`,
      `delete from audit_logs where "userId" in ${ids}`,
      `delete from users where "employeeCode" like 'VIS-%'`,
    ]) await q(s).catch(() => {});
  };
  await wipe();
  const mk = async (code, role, pid, o = {}) => {
    await q(`insert into users (id,"platformId",email,"passwordHash","firstName","lastName","employeeCode",role,status,"mustChangePassword","trackerAccessEnabled","onboardingStatus","reportsToId","dateOfJoining","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,'ACTIVE',false,true,'ACTIVE',$8,'2026-01-01',now(),now())`, [pid, code.toLowerCase() + "@vis.test", hash, o.first ?? code, o.last ?? "Vis", code, role, o.boss ?? null]);
    const id = (await q(`select id from users where "employeeCode"=$1`, [code]))[0].id;
    const tok = (await (await fetch(API + "/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: code, password: PW }) })).json()).token;
    return { id, tok };
  };
  const HRALL = await mk("VIS-HRALL", "HR", AV); await q(`insert into company_access (id,"userId","platformId","createdAt") values (gen_random_uuid(),$1,null,now())`, [HRALL.id]);
  const HROWN = await mk("VIS-HROWN", "HR", AV);
  const ADALL = await mk("VIS-ADALL", "ADMIN", AV); await q(`insert into company_access (id,"userId","platformId","createdAt") values (gen_random_uuid(),$1,null,now())`, [ADALL.id]);
  const ADOWN = await mk("VIS-ADOWN", "ADMIN", AV);
  const MA = await mk("VIS-MA", "MANAGER", AV, { first: "Amy", last: "Mgra" });
  const MB = await mk("VIS-MB", "MANAGER", AVN, { first: "Ben", last: "Mgrb" });
  const A1 = await mk("VIS-A1", "EMPLOYEE", AV, { first: "Ana", last: "Visa", boss: MA.id });
  const B1 = await mk("VIS-B1", "EMPLOYEE", AVN, { first: "Bina", last: "Visb", boss: MB.id });
  const B2 = await mk("VIS-B2", "EMPLOYEE", AVN, { first: "Bela", last: "Visb", boss: MB.id });
  const today = (await call("GET", "/tracker/timesheet", A1.tok)).b.today;
  const at = (day, h) => new Date(`${day}T${h}:00+05:30`).toISOString();
  const session = (u, pid, day) => q(`insert into work_sessions (id,"platformId","userId",date,"loginAt","logoutAt",status,"productiveSeconds","breakSeconds","meetingSeconds","wasLateLogin","lateByMinutes","autoClosed","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3::date,$4,$5,'COMPLETED',25200,1800,0,false,0,false,now(),now())`, [pid, u.id, day, at(day, "09:30"), at(day, "17:30")]);
  for (const [u, pid] of [[A1, AV], [B1, AVN], [B2, AVN]]) await session(u, pid, today);
  await q(`insert into daily_tasks (id,"platformId","userId",date,title,weight,status,"approvalStatus","completedAt","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3::date,'VISB task','MEDIUM','COMPLETED','APPROVED',now(),now(),now())`, [AVN, B1.id, today]);
  await q(`insert into leave_requests (id,"platformId","userId","fromDate","toDate","leaveType","isHalfDay","isFirstHalf","dayCount",reason,status,"createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3::date,$3::date,'CASUAL',false,true,1,'vis','PENDING',now(),now())`, [AVN, B1.id, today]);
  const mt = (await q(`insert into meetings (id,"platformId",title,"organizerId","startsAt","endsAt",status,"createdAt","updatedAt") values (gen_random_uuid(),$1,'VISB meeting',$2,now() + interval '1 day',now() + interval '1 day 30 minutes','SCHEDULED',now(),now()) returning id`, [AVN, MB.id]))[0].id;
  await q(`insert into meeting_attendees (id,"meetingId","userId","createdAt") values (gen_random_uuid(),$1,$2,now())`, [mt, B1.id]).catch(() => {});

  const sees = async (path, u) => { const r = await call("GET", path, u.tok); return { s: r.s, a: /VIS-A1|Visa/.test(r.raw), b: /VIS-B1|VIS-B2|Visb|VISB/.test(r.raw) }; };
  const modules = [
    ["Attendance (live board)", "/team-attendance/live", true],
    ["Attendance report", `/team-attendance/attendance?from=${today}&to=${today}`, true],
    ["Shift breakdown", `/team-attendance/shift-breakdown?date=${today}`, true],
    ["Calendar", `/attendance-calendar?from=${today}&to=${today}`, true],
    ["Team tasks", `/tasks/review/queue?from=${today}&to=${today}`, true],
    ["Task productivity", `/team-attendance/productivity?from=${today}&to=${today}`, true],
    ["Reports & Analytics", `/reports?from=${today}&to=${today}&groupBy=person`, true],
    ["Live team", "/tracker/team", true],
    ["Leave summary", "/leave/summary", true],
    ["Employees list", "/admin/users", true],
    ["Meetings overview", "/meetings/oversight?scope=upcoming", false],
  ];
  console.log("\n## HR and Admin with access see every company; nobody sees more than they should");
  for (const [name, path, hasA] of modules) {
    const hr = await sees(path, HRALL), ad = await sees(path, ADALL), own = await sees(path, HROWN), adOwn = await sees(path, ADOWN), mgr = await sees(path, MA);
    ok(`${name}: HR with all-company access sees company B${hasA ? " and A" : ""}`, hr.s === 200 && hr.b && (!hasA || hr.a), hr);
    ok(`${name}: Admin with all-company access sees company B too`, ad.s === 200 && ad.b, ad);
    ok(`${name}: HR WITHOUT a grant sees no company-B employee`, own.s === 200 && !own.b, own);
    ok(`${name}: Admin without a grant sees no company-B employee`, adOwn.s === 200 && !adOwn.b, adOwn);
    if (name !== "Leave summary" && name !== "Employees list" && name !== "Meetings overview") ok(`${name}: a company-A manager sees no company-B employee`, mgr.s === 200 && !mgr.b, mgr);
  }

  console.log("\n## Reports: single-company numbers are unchanged, each company uses its own holidays");
  const WEEK = ["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30"]; // Mon-Fri, all in the past
  for (const d of WEEK) { await session(A1, AV, d); await session(B1, AVN, d); await session(B2, AVN, d); }
  await q(`insert into holidays (id,"platformId",date,name,"dayType","createdAt") values (gen_random_uuid(),$1,'2026-10-28'::date,'VIS-Company B holiday','PUBLIC_HOLIDAY',now())`, [AVN]);
  const rep = (u) => call("GET", `/reports?from=2026-10-26&to=2026-10-30&groupBy=person`, u.tok);
  const person = (r, code) => (r.b.people ?? []).find((p) => p.employeeCode === code);
  const own = await rep(HROWN), all = await rep(HRALL), mgr = await rep(MA);
  ok("a company-A person's numbers are identical whether HR sees one company or all", JSON.stringify(person(own, "VIS-A1")) === JSON.stringify(person(all, "VIS-A1")), [person(own, "VIS-A1"), person(all, "VIS-A1")]);
  ok("...and identical for the company-A manager's view", JSON.stringify(person(mgr, "VIS-A1")) === JSON.stringify(person(all, "VIS-A1")), person(mgr, "VIS-A1"));
  ok("company A has no holiday that week: 5 expected days", person(all, "VIS-A1")?.daysExpected === 5, person(all, "VIS-A1")?.daysExpected);
  ok("company B's holiday is counted for company B's people only: 4 expected days", person(all, "VIS-B1")?.daysExpected === 4 && person(all, "VIS-B2")?.daysExpected === 4, [person(all, "VIS-B1")?.daysExpected, person(all, "VIS-B2")?.daysExpected]);
  ok("HR without a grant still never sees company B in the report", !person(own, "VIS-B1"));

  console.log("\n## Meetings overview: counts only, and cancelling follows the same reach");
  const ov = await call("GET", "/meetings/oversight?scope=upcoming", HRALL.tok);
  const m = (ov.b.meetings ?? []).find((x) => x.title === "VISB meeting");
  ok("HR sees company B's meeting with title, organizer and head-count only", !!m && m.organizer === "Ben Mgrb" && typeof m.attendeeCount === "number" && !("description" in m) && !("attendees" in m), m);
  ok("HR without a grant cannot cancel it (404)", (await call("POST", `/meetings/${mt}/cancel`, HROWN.tok, { reason: "x" })).s === 404);
  ok("a company-A manager cannot cancel it (404)", (await call("POST", `/meetings/${mt}/cancel`, MA.tok, { reason: "x" })).s === 404);
  ok("HR with access can cancel it (200)", (await call("POST", `/meetings/${mt}/cancel`, HRALL.tok, { reason: "audit test" })).s === 200);

  await wipe();
  await db.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
