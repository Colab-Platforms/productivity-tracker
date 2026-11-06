// AUDIT (prints a table, makes no judgement by itself): for every module, does HR with an all-companies grant see the employees of BOTH companies,
// does HR without a grant see only their own, and what do an Admin and a manager see? Disposable database only (see _guard.cjs).
//
//   cd backend && TEST_DATABASE_URL=... TEST_API=http://localhost:5012/api node tests/hr-visibility-audit.cjs
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
const PW = "Aud@12345678";

(async () => {
  const db = new Client({ connectionString: process.env.TEST_DATABASE_URL }); await db.connect();
  const q = async (s, p) => (await db.query(s, p)).rows;
  const AV = (await q(`select id from platforms where slug='avatar'`))[0].id;
  const AVN = (await q(`select id from platforms where slug='avance'`))[0].id;
  const hash = await bcrypt.hash(PW, 10);
  const wipe = async () => {
    const ids = `(select id from users where "employeeCode" like 'AUD-%')`;
    for (const s of [
      `delete from meeting_tracking where "meetingId" in (select id from meetings where "organizerId" in ${ids})`,
      `delete from meeting_attendees where "meetingId" in (select id from meetings where "organizerId" in ${ids})`,
      `delete from meetings where "organizerId" in ${ids}`,
      `delete from task_entry_details where "taskId" in (select id from daily_tasks where "userId" in ${ids})`,
      `delete from daily_tasks where "userId" in ${ids}`,
      `delete from leave_approval_events where "requestId" in (select id from leave_requests where "userId" in ${ids})`,
      `delete from request_approvals where kind='LEAVE' and "requestId" in (select id from leave_requests where "userId" in ${ids})`,
      `delete from leave_requests where "userId" in ${ids}`,
      `delete from work_sessions where "userId" in ${ids}`,
      `delete from company_access where "userId" in ${ids}`,
      `delete from team_members where "userId" in ${ids}`,
      `delete from teams where name like 'AUD-%'`,
      `delete from notifications where "userId" in ${ids}`,
      `delete from audit_logs where "userId" in ${ids}`,
      `delete from users where "employeeCode" like 'AUD-%'`,
    ]) await q(s).catch(() => {});
  };
  await wipe();
  const mk = async (code, role, pid, o = {}) => {
    await q(`insert into users (id,"platformId",email,"passwordHash","firstName","lastName","employeeCode",role,status,"mustChangePassword","trackerAccessEnabled","onboardingStatus","reportsToId","dateOfJoining","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,'ACTIVE',false,true,'ACTIVE',$8,'2026-01-01',now(),now())`, [pid, code.toLowerCase() + "@aud.test", hash, o.first ?? code, o.last ?? "Aud", code, role, o.boss ?? null]);
    const id = (await q(`select id from users where "employeeCode"=$1`, [code]))[0].id;
    const tok = (await (await fetch(API + "/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: code, password: PW }) })).json()).token;
    return { id, tok };
  };
  const HRALL = await mk("AUD-HRALL", "HR", AV); await q(`insert into company_access (id,"userId","platformId","createdAt") values (gen_random_uuid(),$1,null,now())`, [HRALL.id]);
  const HROWN = await mk("AUD-HROWN", "HR", AV);
  const ADALL = await mk("AUD-ADALL", "ADMIN", AV); await q(`insert into company_access (id,"userId","platformId","createdAt") values (gen_random_uuid(),$1,null,now())`, [ADALL.id]);
  const MA = await mk("AUD-MA", "MANAGER", AV, { first: "Amy", last: "Mgra" });
  const MB = await mk("AUD-MB", "MANAGER", AVN, { first: "Ben", last: "Mgrb" });
  const A1 = await mk("AUD-A1", "EMPLOYEE", AV, { first: "Ana", last: "Auda", boss: MA.id });
  const B1 = await mk("AUD-B1", "EMPLOYEE", AVN, { first: "Bina", last: "Audb", boss: MB.id });
  const B2 = await mk("AUD-B2", "EMPLOYEE", AVN, { first: "Bela", last: "Audb", boss: MB.id });
  const today = (await call("GET", "/tracker/timesheet", A1.tok)).b.today;
  const at = (h) => new Date(`${today}T${h}:00+05:30`).toISOString();
  for (const [u, pid] of [[A1, AV], [B1, AVN], [B2, AVN]]) await q(`insert into work_sessions (id,"platformId","userId",date,"loginAt","logoutAt",status,"productiveSeconds","breakSeconds","meetingSeconds","wasLateLogin","lateByMinutes","autoClosed","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3::date,$4,$5,'COMPLETED',25200,1800,0,false,0,false,now(),now())`, [pid, u.id, today, at("09:30"), at("17:30")]);
  await q(`insert into daily_tasks (id,"platformId","userId",date,title,weight,status,"approvalStatus","completedAt","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3::date,'AUDB task','MEDIUM','COMPLETED','APPROVED',now(),now(),now())`, [AVN, B1.id, today]);
  await q(`insert into leave_requests (id,"platformId","userId","fromDate","toDate","leaveType","isHalfDay","isFirstHalf","dayCount",reason,status,"createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3::date,$3::date,'CASUAL',false,true,1,'audit','PENDING',now(),now())`, [AVN, B1.id, today]);
  const mt = (await q(`insert into meetings (id,"platformId",title,"organizerId","startsAt","endsAt",status,"createdAt","updatedAt") values (gen_random_uuid(),$1,'AUDB meeting',$2,now() + interval '1 day',now() + interval '1 day 30 minutes','SCHEDULED',now(),now()) returning id`, [AVN, MB.id]))[0].id;
  await q(`insert into meeting_attendees (id,"meetingId","userId","createdAt") values (gen_random_uuid(),$1,$2,now())`, [mt, B1.id]).catch(() => {});

  const endpoints = [
    ["Attendance (live board)", "/team-attendance/live"],
    ["Attendance report", `/team-attendance/attendance?from=${today}&to=${today}`],
    ["Shift breakdown", `/team-attendance/shift-breakdown?date=${today}`],
    ["Calendar", `/attendance-calendar?from=${today}&to=${today}`],
    ["Team tasks (queue)", `/tasks/review/queue?from=${today}&to=${today}`],
    ["Task productivity", `/team-attendance/productivity?from=${today}&to=${today}`],
    ["Reports & analytics", `/reports?from=${today}&to=${today}&groupBy=person`],
    ["Live team / alerts source", "/tracker/team"],
    ["Leave: requests", "/leave/requests"],
    ["Leave: summary", "/leave/summary"],
    ["Meetings: company overview", "/meetings/oversight?scope=upcoming"],
    ["Meetings: people to invite", "/meetings/people"],
    ["Employee documents (tracking)", "/documents/tracking"],
    ["Employees list", "/admin/users"],
  ];
  const who = [["HR (all companies)", HRALL], ["HR (own company)", HROWN], ["Admin (all companies)", ADALL], ["Manager (company A)", MA]];
  const rows = [];
  for (const [name, path] of endpoints) {
    const cells = [];
    for (const [, u] of who) {
      const r = await call("GET", path, u.tok);
      if (r.s !== 200) { cells.push(`HTTP ${r.s}`); continue; }
      const a = /AUD-A1|Auda/.test(r.raw), b = /AUD-B1|AUD-B2|Audb|AUDB/.test(r.raw);
      cells.push(`${a ? "A" : "-"}${b ? "B" : "-"}`);
    }
    rows.push([name, ...cells]);
  }
  const pad = (s, n) => String(s).padEnd(n);
  console.log(pad("MODULE", 34) + who.map(([n]) => pad(n, 24)).join(""));
  for (const r of rows) console.log(pad(r[0], 34) + r.slice(1).map((c) => pad(c, 24)).join(""));
  console.log("\nA = shows company A's employee, B = shows company B's employee, - = does not. HR (all companies) should show AB everywhere it can see people.");
  await wipe();
  await db.end();
})().catch((e) => { console.error(e); process.exit(1); });
