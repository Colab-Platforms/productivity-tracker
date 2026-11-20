// Full API test suite (272 checks). Writes data: run ONLY against a disposable Neon branch (TEST_DATABASE_URL) with the backend on :5002 pointed at that same branch.
import { createRequire } from "node:module";
import fs from "node:fs";
const require = createRequire(new URL("../package.json", import.meta.url));
const guard = createRequire(import.meta.url)("./_guard.cjs");
const pg = require("pg");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const BRANCH_URL = process.env.TEST_DATABASE_URL;
guard.assertTestDb(BRANCH_URL);
const OUT = process.argv[2] || "suite_results.json";
const B = (process.env.TEST_API ?? "http://localhost:5002/api");

const db = new pg.Client({ connectionString: BRANCH_URL });
await db.connect();
const q = async (sql, p) => (await db.query(sql, p)).rows;

// ---------- harness ----------
const results = []; let section = "";
const S = (n) => { section = n; console.log("\n## " + n); };
let LAST = null;
function T(name, ok, detail = "") { if (!ok && !detail && LAST) detail = "last call: " + LAST.m + " " + LAST.p + " -> " + LAST.s + " " + JSON.stringify(LAST.j).slice(0, 160); results.push({ section, name, ok: !!ok, detail: String(detail) }); console.log((ok ? "  PASS " : "  FAIL ") + name + (ok ? "" : "  -> " + detail)); }
async function call(method, path, token, body, extraHeaders = {}) {
  const r = await fetch(B + path, { method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}), ...extraHeaders }, body: body !== undefined ? JSON.stringify(body) : undefined });
  let j = null; const txt = await r.text(); try { j = JSON.parse(txt); } catch { j = txt; }
  LAST = { m: method, p: path, s: r.status, j };
  return { s: r.status, j };
}
const login = (e, p) => call("POST", "/auth/login", null, { email: e, password: p });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const todayIST = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
const no5xx = (r) => r.s < 500;

// ---------- SETUP (branch only) ----------
S("0. Setup (branch only)");
const hostCheck = (await q("select current_database() db, inet_server_addr()::text ip"))[0];
const avatar = (await q("select id from platforms where slug='avatar'"))[0];
const seed = await q("select id,email,role,\"platformId\" from users where email in ('admin@avatarindia.com','manager@avatarindia.com','priya@avatarindia.com','rahul@avatarindia.com')");
const id = Object.fromEntries(seed.map((u) => [u.email.split("@")[0], u.id]));
// clean slate: today's sessions for the test users (cascade removes breaks/meetings), and leftover test artefacts
await q("delete from work_sessions where \"userId\" = any($1) and date >= (current_date - 1)", [[id.manager, id.priya, id.rahul, id.admin]]);
await q("delete from daily_tasks where \"userId\" = any($1) and date >= (current_date - 1) and title like 'QA %'", [[id.priya, id.rahul]]);
// foreign-tenant actors with a password we know
const foreign = await q(`select u.id,u.email,u.role,u."platformId",u."employeeCode" from users u
  where u."platformId" <> $1 and u.status='ACTIVE' and coalesce(u."employeeCode",'') not in ('TCS-03','AVT-0001')
  order by u.role`, [avatar.id]);
const fMgr = foreign.find((u) => u.role === "MANAGER") ?? foreign.find((u) => u.role === "ADMIN");
const fEmp = foreign.find((u) => u.role === "EMPLOYEE" && u.platformId === fMgr?.platformId) ?? foreign.find((u) => u.role === "EMPLOYEE");
const ISO_PW = "Iso@12345678";
const hash = await bcrypt.hash(ISO_PW, 10);
for (const u of [fMgr, fEmp].filter(Boolean)) await q("update users set \"passwordHash\"=$1,\"mustChangePassword\"=false,\"trackerAccessEnabled\"=true where id=$2", [hash, u.id]);
await q("delete from team_members where \"teamId\" in (select id from teams where \"platformId\"=$1 and name like 'QA %')", [avatar.id]);
await q("delete from team_configs where \"teamId\" in (select id from teams where \"platformId\"=$1 and name like 'QA %')", [avatar.id]);
await q("delete from teams where \"platformId\"=$1 and name like 'QA %'", [avatar.id]);
await q("delete from shifts where \"platformId\"=$1 and name like 'QA %'", [avatar.id]);
await q("delete from ticket_messages where \"ticketId\" in (select id from tickets where subject like 'QA %')");
await q("delete from tickets where subject like 'QA %'");
await q("delete from holidays where name like 'QA %'");
await q("delete from leave_days where \"userId\" in (select id from users where email like 'qa.%@avatarindia.com')");
const fTask = (await q("select id,\"userId\" from daily_tasks where \"platformId\" <> $1 limit 1", [avatar.id]))[0];
const fTeam = (await q("select id from teams where \"platformId\" <> $1 limit 1", [avatar.id]))[0];
const fAlert = (await q("select id from alerts where \"platformId\" <> $1 limit 1", [avatar.id]))[0];
const fShift = (await q("select id from shifts where \"platformId\" <> $1 limit 1", [avatar.id]))[0];
T("connected to branch DB (not original)", true, JSON.stringify(hostCheck));
T("seed users found", Object.keys(id).length === 4, JSON.stringify(Object.keys(id)));
T("foreign-tenant actors available (manager+employee)", fMgr && fEmp, JSON.stringify({ fMgr: fMgr?.email, fEmp: fEmp?.email }));
T("foreign task/team/alert/shift fixtures available", fTask && fTeam, JSON.stringify({ fTask: !!fTask, fTeam: !!fTeam, fAlert: !!fAlert, fShift: !!fShift }));

// ---------- 1. AUTH ----------
S("1. Authentication");
const A = await login("admin@avatarindia.com", process.env.TEST_PW_ADMIN);
const M = await login("manager@avatarindia.com", process.env.TEST_PW_MANAGER);
const P = await login("priya@avatarindia.com", process.env.TEST_PW_EMPLOYEE);
const R = await login("rahul@avatarindia.com", process.env.TEST_PW_EMPLOYEE);
T("admin login 200 + role ADMIN", A.s === 200 && A.j.user?.role === "ADMIN");
T("manager login 200 + role MANAGER", M.s === 200 && M.j.user?.role === "MANAGER");
T("priya login 200 + role EMPLOYEE", P.s === 200 && P.j.user?.role === "EMPLOYEE");
T("rahul login 200 + role EMPLOYEE", R.s === 200 && R.j.user?.role === "EMPLOYEE");
const tA = A.j.token, tM = M.j.token, tP = P.j.token, tR = R.j.token;
T("login response never contains passwordHash", !JSON.stringify(A.j).toLowerCase().includes("passwordhash"));
const decoded = jwt.decode(tP);
T("JWT carries userId, platformId, role", decoded?.userId && decoded?.platformId && decoded?.role === "EMPLOYEE", JSON.stringify(decoded));
const bad1 = await login("priya@avatarindia.com", "WrongPass1!");
const bad2 = await login("nobody-here@avatarindia.com", "WrongPass1!");
T("wrong password -> 401", bad1.s === 401, bad1.s);
T("unknown email -> 401 with IDENTICAL message (no enumeration)", bad2.s === 401 && JSON.stringify(bad1.j) === JSON.stringify(bad2.j), JSON.stringify([bad1.j, bad2.j]));
T("login by employee code works (UI field says Employee ID)", (await login("AVT-0003", process.env.TEST_PW_EMPLOYEE)).s === 200);
T("login email is case-insensitive", (await login("PRIYA@AvatarIndia.com", process.env.TEST_PW_EMPLOYEE)).s === 200);
T("SQL-injection-style identifier -> 4xx not 5xx", (await login("' OR 1=1 --", "x")).s < 500);
T("empty login body -> 4xx not 5xx", (await call("POST", "/auth/login", null, {})).s < 500);
T("/auth/me with token -> 200, no passwordHash", await (async () => { const r = await call("GET", "/auth/me", tP); return r.s === 200 && !JSON.stringify(r.j).toLowerCase().includes("passwordhash"); })());
for (const p of ["/auth/me", "/tracker/session", "/tasks", "/reports", "/admin/users", "/tickets", "/holidays", "/projects", "/payroll", "/offers"])
  T(`no token -> 401 on ${p}`, (await call("GET", p, null)).s === 401);
T("garbage token -> 401", (await call("GET", "/tracker/session", "abc.def.ghi")).s === 401);
const forged = jwt.sign({ userId: id.priya, platformId: avatar.id, role: "ADMIN" }, "not-the-real-secret");
T("token forged with wrong secret (role=ADMIN) -> 401", (await call("GET", "/admin/users", forged)).s === 401);
const noneTok = Buffer.from('{"alg":"none","typ":"JWT"}').toString("base64url") + "." + Buffer.from(JSON.stringify({ userId: id.admin, platformId: avatar.id, role: "ADMIN" })).toString("base64url") + ".";
T("alg:none token -> 401", (await call("GET", "/admin/users", noneTok)).s === 401);
const expired = jwt.sign({ userId: id.priya, platformId: avatar.id, role: "EMPLOYEE" }, "x", { expiresIn: -10 });
T("expired/invalid token -> 401", (await call("GET", "/tracker/session", expired)).s === 401);
// rate limit (dummy identifier, only affects this branch server's memory)
let last; for (let i = 0; i < 12; i++) last = await login("ratelimit-probe@example.com", "nope");
T("brute force: 12 bad logins -> 429 lockout", last.s === 429, last.s);

// ---------- 2. RBAC MATRIX ----------
S("2. Role-based access (status codes per role)");
// create HR on the branch through the real admin API
const hrEmail = "qa.hr@avatarindia.com", hrPw = "QaHr@12345678";
await q("delete from users where email in ('qa.hr@avatarindia.com','qa.emp@avatarindia.com') and \"platformId\"=$1", [avatar.id]);
const cu = await call("POST", "/admin/users", tA, { email: hrEmail, firstName: "QA", lastName: "HR", password: hrPw, role: "HR", skipOnboarding: true, designation: "HR Executive" });
T("ADMIN can create an HR user (201)", cu.s === 201, JSON.stringify(cu.j));
T("[by design] admin-created user must change password first (gate active)", (await q("select \"mustChangePassword\" m from users where email=$1", [hrEmail]))[0]?.m === true);
await q("update users set \"mustChangePassword\"=false where email=$1", [hrEmail]);
const HRl = await login(hrEmail, hrPw);
T("new HR user can log in", HRl.s === 200 && HRl.j.user?.role === "HR", JSON.stringify(HRl.j).slice(0, 200));
const tH = HRl.j.token;
const roles = { ADMIN: tA, HR: tH, MANAGER: tM, EMPLOYEE: tP };
const matrix = [
  ["GET", "/admin/users", { ADMIN: 200, HR: 200, MANAGER: 403, EMPLOYEE: 403 }],
  ["GET", "/admin/teams", { ADMIN: 200, HR: 200, MANAGER: 403, EMPLOYEE: 403 }],
  ["GET", "/admin/shifts", { ADMIN: 200, HR: 200, MANAGER: 403, EMPLOYEE: 403 }],
  ["GET", "/admin/leave", { ADMIN: 200, HR: 200, MANAGER: 403, EMPLOYEE: 403 }],
  ["GET", "/tracker/team", { ADMIN: 200, HR: 200, MANAGER: 200, EMPLOYEE: 403 }],
  ["GET", "/tracker/alerts", { ADMIN: 200, HR: 200, MANAGER: 200, EMPLOYEE: 403 }],
  ["POST", "/tracker/meeting/end", { EMPLOYEE: 403 }],
  ["POST", "/tracker/meetings/invite", { EMPLOYEE: 403 }],
  ["GET", "/tracker/session", { ADMIN: 200, HR: 200, MANAGER: 200, EMPLOYEE: 200 }],
  ["GET", "/tracker/history", { ADMIN: 200, HR: 200, MANAGER: 200, EMPLOYEE: 200 }],
  ["GET", "/tasks", { ADMIN: 200, HR: 200, MANAGER: 200, EMPLOYEE: 200 }],
  ["GET", "/tasks/review/queue", { EMPLOYEE: 403 }],
  ["GET", "/reports", { ADMIN: 200, HR: 200, MANAGER: 200, EMPLOYEE: 200 }],
  ["GET", "/tickets", { ADMIN: 200, HR: 200, MANAGER: 200, EMPLOYEE: 200 }],
  ["GET", "/holidays", { EMPLOYEE: 403 }],
  ["GET", "/projects", { EMPLOYEE: 403 }],
  ["GET", "/payroll", { EMPLOYEE: 403 }],
  ["GET", "/offers", { EMPLOYEE: 403 }],
];
for (const [m, p, exp] of matrix) for (const [role, want] of Object.entries(exp)) {
  const r = await call(m, p, roles[role], m === "POST" ? {} : undefined);
  T(`${role} ${m} ${p} -> ${want}`, r.s === want, `got ${r.s} ${JSON.stringify(r.j).slice(0, 100)}`);
}
// privilege escalation attempts
T("EMPLOYEE cannot PATCH own role via /admin", (await call("PATCH", `/admin/users/${id.priya}`, tP, { role: "ADMIN" })).s === 403);
T("MANAGER cannot reset a password via /admin", (await call("POST", `/admin/users/${id.priya}/password`, tM, { password: "Hacked@12345" })).s === 403);
T("priya's password unchanged after the blocked attempt", (await login("priya@avatarindia.com", process.env.TEST_PW_EMPLOYEE)).s === 200);

// ---------- 3. ADMIN CRUD ----------
S("3. Admin CRUD (users, teams, shifts, config, leave)");
const emp = await call("POST", "/admin/users", tA, { email: "qa.emp@avatarindia.com", firstName: "QA", lastName: "Employee", password: "QaEmp@12345678", role: "EMPLOYEE", skipOnboarding: true });
T("create EMPLOYEE -> 201", emp.s === 201, JSON.stringify(emp.j));
const qaEmpId = emp.j?.user?.id;
await q("update users set \"mustChangePassword\"=false where id=$1", [qaEmpId]);
console.log("   team/create shapes -> user keys:", Object.keys(emp.j?.user ?? {}).join(","));
T("create response has no passwordHash", !JSON.stringify(emp.j).toLowerCase().includes("passwordhash"));
T("duplicate email -> 409", (await call("POST", "/admin/users", tA, { email: "qa.emp@avatarindia.com", firstName: "D", lastName: "D", password: "QaEmp@12345678" })).s === 409);
T("weak password (<8) -> 400", (await call("POST", "/admin/users", tA, { email: "qa.weak@avatarindia.com", firstName: "W", lastName: "W", password: "123" })).s === 400);
T("missing fields -> 400", (await call("POST", "/admin/users", tA, { email: "" })).s === 400);
T("list users with search filter finds QA user", (await call("GET", "/admin/users?search=qa.emp", tA)).j.users?.some((u) => u.id === qaEmpId));
T("list users filter role=HR returns only HR", await (async () => { const r = await call("GET", "/admin/users?role=HR", tA); return r.s === 200 && r.j.users.length > 0 && r.j.users.every((u) => u.role === "HR"); })());
T("PATCH user (designation) -> 200 and persisted", await (async () => { const r = await call("PATCH", `/admin/users/${qaEmpId}`, tA, { designation: "Tester" }); const row = (await q("select designation from users where id=$1", [qaEmpId]))[0]; return r.s === 200 && row.designation === "Tester"; })());
T("reset password then login with the new one", await (async () => { const r = await call("POST", `/admin/users/${qaEmpId}/password`, tA, { password: "NewPass@123456" }); return r.s === 200 && (await login("qa.emp@avatarindia.com", "NewPass@123456")).s === 200 && (await login("qa.emp@avatarindia.com", "QaEmp@12345678")).s === 401; })());
T("reset password too short -> 400", (await call("POST", `/admin/users/${qaEmpId}/password`, tA, { password: "short" })).s === 400);
const team = await call("POST", "/admin/teams", tA, { name: "QA Team", teamType: "OTHER" });
T("POST /admin/teams returns the created team in the body", !!(team.j?.team?.id ?? team.j?.id), JSON.stringify(team.j));
const teamId = team.j?.team?.id ?? team.j?.id ?? (await q("select id from teams where \"platformId\"=$1 and name='QA Team'", [avatar.id]))[0]?.id;
T("duplicate team name -> 409 (not 500)", (await call("POST", "/admin/teams", tA, { name: "QA Team" })).s === 409);
T("create team -> 2xx", team.s < 300, JSON.stringify(team.j).slice(0, 200));
T("new team has TeamConfig created with it (no hardcoded thresholds)", teamId && (await q("select count(*)::int n from team_configs where \"teamId\"=$1", [teamId]))[0].n === 1);
T("team without name -> 400", (await call("POST", "/admin/teams", tA, {})).s === 400);
T("add member to team", (await call("POST", `/admin/teams/${teamId}/members`, tA, { userId: qaEmpId })).s < 300);
T("member row exists", (await q("select count(*)::int n from team_members where \"teamId\"=$1 and \"userId\"=$2", [teamId, qaEmpId]))[0].n === 1);
T("remove member from team (soft: isActive=false, leftAt set)", (await call("DELETE", `/admin/teams/${teamId}/members/${qaEmpId}`, tA)).s < 300 && await (async () => { const m = (await q("select \"isActive\" a,\"leftAt\" l from team_members where \"teamId\"=$1 and \"userId\"=$2", [teamId, qaEmpId]))[0]; return m && m.a === false && m.l; })());
T("remove a user who is not a member -> 404 (not 500)", (await call("DELETE", `/admin/teams/${teamId}/members/${id.rahul}`, tA)).s === 404);
T("PATCH team name", (await call("PATCH", `/admin/teams/${teamId}`, tA, { name: "QA Team Renamed" })).s < 300 && (await q("select name from teams where id=$1", [teamId]))[0].name === "QA Team Renamed");
const cfg = await call("PATCH", `/admin/config/${teamId}`, tA, { breakBudgetMinutes: 45, lowProductivityThreshold: 0.6 });
T("PATCH TeamConfig -> 200 and persisted", cfg.s === 200 && (await q("select \"breakBudgetMinutes\" b from team_configs where \"teamId\"=$1", [teamId]))[0].b === 45, JSON.stringify(cfg.j).slice(0, 200));
T("TeamConfig invalid number -> 400 not 500", (await call("PATCH", `/admin/config/${teamId}`, tA, { breakBudgetMinutes: "abc" })).s === 400);
const sh = await call("POST", "/admin/shifts", tA, { name: "QA Shift", startTime: "09:30", endTime: "18:30", workingDays: [1, 2, 3, 4, 5] });
const shiftId = sh.j?.shift?.id ?? sh.j?.id ?? (await q("select id from shifts where \"platformId\"=$1 and name='QA Shift'", [avatar.id]))[0]?.id;
T("duplicate shift name -> 409 (not 500)", (await call("POST", "/admin/shifts", tA, { name: "QA Shift", startTime: "09:30", endTime: "18:30", workingDays: [1] })).s === 409);
T("create shift -> 201", sh.s === 201, JSON.stringify(sh.j).slice(0, 200));
T("shift bad time -> 400", (await call("POST", "/admin/shifts", tA, { name: "Bad", startTime: "25:99", endTime: "18:00", workingDays: [1] })).s === 400);
T("shift with no working days -> 400", (await call("POST", "/admin/shifts", tA, { name: "NoDays", startTime: "09:00", endTime: "18:00", workingDays: [] })).s === 400);
T("PATCH shift", (await call("PATCH", `/admin/shifts/${shiftId}`, tA, { endTime: "19:00" })).s === 200 && (await q("select \"endTime\" e from shifts where id=$1", [shiftId]))[0].e === "19:00");
const leaveDay = "2026-12-14";
const lv = await call("POST", "/admin/leave", tA, { userId: qaEmpId, from: leaveDay, leaveType: "PLANNED", note: "qa" });
T("mark leave -> 201", lv.s === 201, JSON.stringify(lv.j).slice(0, 200));
T("leave listed", (await call("GET", `/admin/leave?from=${leaveDay}&to=${leaveDay}`, tA)).j.leave?.some((l) => l.userId === qaEmpId));
T("leave bad date format (31-12-2026) -> 400", (await call("POST", "/admin/leave", tA, { userId: qaEmpId, from: "31-12-2026" })).s === 400);
T("leave impossible date (2026-02-31) -> 400", (await call("POST", "/admin/leave", tA, { userId: qaEmpId, from: "2026-02-31" })).s === 400);
await q("delete from leave_days where \"userId\"=$1 and date <> $2", [qaEmpId, leaveDay]);
T("leave end before start -> 400", (await call("POST", "/admin/leave", tA, { userId: qaEmpId, from: "2026-12-20", to: "2026-12-10" })).s === 400);
T("leave >120 days -> 400", (await call("POST", "/admin/leave", tA, { userId: qaEmpId, from: "2026-01-01", to: "2026-12-31" })).s === 400);
T("unmark leave", (await call("DELETE", `/admin/leave?userId=${qaEmpId}&date=${leaveDay}`, tA)).s === 200 && (await q("select count(*)::int n from leave_days where \"userId\"=$1", [qaEmpId]))[0].n === 0);
T("HR can also run admin ops (create team)", (await call("POST", "/admin/teams", tH, { name: "QA HR Team" })).s < 300);

// ---------- 4. TRACKER FLOW ----------
S("4. Tracker: clock-in, breaks, meetings, clock-out");
let r = await call("GET", "/tracker/session", tP);
T("priya starts the day not clocked in", r.s === 200 && r.j.session === null, JSON.stringify(r.j).slice(0, 150));
T("clock-out while not clocked in -> 400", (await call("POST", "/tracker/clock-out", tP)).s === 400);
T("break start while not clocked in -> 400", (await call("POST", "/tracker/break/start", tP, { breakType: "LUNCH" })).s === 400);
r = await call("POST", "/tracker/clock-in", tP);
T("priya clock-in -> 200", r.s === 200, JSON.stringify(r.j).slice(0, 200));
T("double clock-in does not create a 2nd session", await (async () => { await call("POST", "/tracker/clock-in", tP); return (await q("select count(*)::int n from work_sessions where \"userId\"=$1 and date=$2", [id.priya, todayIST]))[0].n === 1; })());
T("break with invalid type -> 400", (await call("POST", "/tracker/break/start", tP, { breakType: "NAP" })).s === 400);
T("break with no type -> 400", (await call("POST", "/tracker/break/start", tP, {})).s === 400);
T("end break when none running -> 400", (await call("POST", "/tracker/break/end", tP)).s === 400);
await call("POST", "/tracker/clock-in", tR); await call("POST", "/tracker/clock-in", tM);
// meetings
const inv = await call("POST", "/tracker/meetings/invite", tM, { employeeIds: [id.priya, id.rahul], meetingType: "TEAM", title: "QA standup" });
T("manager invites priya+rahul -> 200", inv.s === 200, JSON.stringify(inv.j).slice(0, 200));
T("invite with empty list -> 400", (await call("POST", "/tracker/meetings/invite", tM, { employeeIds: [], meetingType: "TEAM" })).s === 400);
T("invite with bad meetingType -> 400", (await call("POST", "/tracker/meetings/invite", tM, { employeeIds: [id.priya], meetingType: "PARTY" })).s === 400);
const invP = (await call("GET", "/tracker/invites", tP)).j, invR = (await call("GET", "/tracker/invites", tR)).j;
T("both employees see 1 pending invite", Array.isArray(invP) && invP.length === 1 && invR.length === 1, JSON.stringify([invP, invR]).slice(0, 300));
const invPid = invP[0]?.id, invRid = invR[0]?.id;
T("priya cannot answer rahul's invite (403)", (await call("POST", `/tracker/invites/${invRid}/respond`, tP, { accept: true })).s === 403);
T("respond without boolean -> 400", (await call("POST", `/tracker/invites/${invPid}/respond`, tP, { accept: "yes" })).s === 400);
T("respond to nonexistent invite -> 404", (await call("POST", `/tracker/invites/00000000-0000-0000-0000-000000000000/respond`, tP, { accept: true })).s === 404);
const rd = await call("POST", `/tracker/invites/${invRid}/respond`, tR, { accept: false, reason: "busy" });
T("rahul declines -> 200", rd.s === 200, JSON.stringify(rd.j).slice(0, 150));
T("rahul cannot answer twice (400)", (await call("POST", `/tracker/invites/${invRid}/respond`, tR, { accept: true })).s === 400);
const ra = await call("POST", `/tracker/invites/${invPid}/respond`, tP, { accept: true });
T("priya accepts -> 200 (meeting clock starts)", ra.s === 200, JSON.stringify(ra.j).slice(0, 150));
let mrow = (await q("select \"approvalStatus\" a, \"startedAt\" s from tracker_meetings tm join work_sessions ws on ws.id=tm.\"workSessionId\" where ws.\"userId\"=$1 and ws.date=$2", [id.priya, todayIST]))[0];
T("accepted meeting is APPROVED with startedAt set (clock starts on acceptance)", mrow?.a === "APPROVED" && mrow?.s, JSON.stringify(mrow));
let rrow = (await q("select \"approvalStatus\" a, \"startedAt\" s, \"durationSeconds\" d from tracker_meetings tm join work_sessions ws on ws.id=tm.\"workSessionId\" where ws.\"userId\"=$1 and ws.date=$2", [id.rahul, todayIST]))[0];
T("declined meeting is REJECTED, no start time, no duration", rrow?.a === "REJECTED" && !rrow?.s && !rrow?.d, JSON.stringify(rrow));
T("break during a running meeting -> 400", (await call("POST", "/tracker/break/start", tP, { breakType: "LUNCH" })).s === 400);
await sleep(4000);
T("employee cannot end meeting (403)", (await call("POST", "/tracker/meeting/end", tP)).s === 403);
const me = await call("POST", "/tracker/meeting/end", tM);
T("manager ends meeting -> 200", me.s === 200, JSON.stringify(me.j).slice(0, 150));
T("ending again -> 400 (no meeting running)", (await call("POST", "/tracker/meeting/end", tM)).s === 400);
const mDur = (await q("select tm.\"durationSeconds\" d from tracker_meetings tm join work_sessions ws on ws.id=tm.\"workSessionId\" where ws.\"userId\"=$1 and ws.date=$2", [id.priya, todayIST]))[0]?.d;
T("meeting duration recorded ~4s", mDur >= 3 && mDur <= 12, mDur);
// breaks
const bs = await call("POST", "/tracker/break/start", tP, { breakType: "LUNCH" });
T("priya starts LUNCH break -> 200", bs.s === 200, JSON.stringify(bs.j).slice(0, 150));
T("second break while on break -> 400", (await call("POST", "/tracker/break/start", tP, { breakType: "LUNCH" })).s === 400);
await sleep(3500);
const be = await call("POST", "/tracker/break/end", tP);
T("end break -> 200", be.s === 200, JSON.stringify(be.j).slice(0, 150));
const bdur = (await q("select tb.\"durationSeconds\" d from tracker_breaks tb join work_sessions ws on ws.id=tb.\"workSessionId\" where ws.\"userId\"=$1 and ws.date=$2", [id.priya, todayIST]))[0]?.d;
T("break duration recorded ~3-4s", bdur >= 3 && bdur <= 10, bdur);
await sleep(1500);
// live team view while priya is clocked in
const live = await call("GET", "/tracker/team", tM);
const livePriya = live.j.find?.((x) => x.userId === id.priya);
T("manager Live Team shows priya as clocked in/working", livePriya && livePriya.status !== "NOT_CLOCKED_IN", JSON.stringify(livePriya));
const co = await call("POST", "/tracker/clock-out", tP);
T("priya clock-out -> 200", co.s === 200, JSON.stringify(co.j).slice(0, 200));
T("second clock-out -> 400", (await call("POST", "/tracker/clock-out", tP)).s === 400);
const closed = (await q("select status,\"logoutAt\" l from work_sessions where \"userId\"=$1 and date=$2", [id.priya, todayIST]))[0];
T("after clock-out the session is closed in DB", closed?.l && closed.status !== "ACTIVE", JSON.stringify(closed));
// Observed design: clocking in again the same day RESUMES the session and logs the gap as an OTHER break.
const re = await call("POST", "/tracker/clock-in", tP);
const gap = (await q("select count(*)::int n from tracker_breaks tb join work_sessions ws on ws.id=tb.\"workSessionId\" where ws.\"userId\"=$1 and ws.date=$2 and tb.reason like 'Away between%'", [id.priya, todayIST]))[0].n;
T("[behaviour] re-clock-in same day resumes session and records the away-gap as a break", re.s === 200 && gap === 1, `${re.s} gap=${gap}`);
await sleep(1500);
T("clock-out again after resuming -> 200", (await call("POST", "/tracker/clock-out", tP)).s === 200);
await call("POST", "/tracker/clock-out", tR); await call("POST", "/tracker/clock-out", tM);

// ---------- 5. DASHBOARD / REPORT ACCURACY ----------
S("5. Dashboard & report accuracy (API vs raw DB)");
const ws = (await q("select * from work_sessions where \"userId\"=$1 and date=$2", [id.priya, todayIST]))[0];
T("work_sessions row closed (logoutAt set, status not ACTIVE)", ws && ws.logoutAt && ws.status !== "ACTIVE", JSON.stringify({ status: ws?.status, out: ws?.logoutAt }));
const elapsed = Math.round((new Date(ws.logoutAt) - new Date(ws.loginAt)) / 1000);
T("recompute-on-write: breakSeconds == sum of break durations", ws.breakSeconds === (await q("select coalesce(sum(\"durationSeconds\"),0)::int s from tracker_breaks where \"workSessionId\"=$1", [ws.id]))[0].s, ws.breakSeconds);
T("meetingSeconds == sum of APPROVED meeting durations", ws.meetingSeconds === (await q("select coalesce(sum(\"durationSeconds\"),0)::int s from tracker_meetings where \"workSessionId\"=$1 and \"approvalStatus\"='APPROVED'", [ws.id]))[0].s, ws.meetingSeconds);
T("recompute formula consistent: productive = elapsed - break (+/-2s); meetings stay inside it", Math.abs(ws.productiveSeconds - (elapsed - ws.breakSeconds)) <= 2, `productive=${ws.productiveSeconds} elapsed=${elapsed} break=${ws.breakSeconds} meeting=${ws.meetingSeconds}`);
T("[SPEC] approved meeting time counts TOWARD productive hours (productive >= elapsed - break)", ws.productiveSeconds >= elapsed - ws.breakSeconds - 2, `productive=${ws.productiveSeconds} but elapsed-break=${elapsed - ws.breakSeconds}; ${ws.meetingSeconds}s approved meeting was subtracted instead`);
const rws = (await q("select * from work_sessions where \"userId\"=$1 and date=$2", [id.rahul, todayIST]))[0];
T("rahul (declined) has meetingSeconds = 0", rws.meetingSeconds === 0, rws.meetingSeconds);
const hist = await call("GET", `/tracker/history?from=${todayIST}&to=${todayIST}`, tP);
const hrow = hist.j.rows?.[0];
T("History API returns today's row", hist.s === 200 && hist.j.rows?.length === 1, JSON.stringify(hist.j).slice(0, 300));
T("History numbers == DB columns (break/meeting/productive)", hrow && JSON.stringify([hrow.breakSeconds ?? hrow.break, hrow.meetingSeconds ?? hrow.meeting, hrow.productiveSeconds ?? hrow.productive]) === JSON.stringify([ws.breakSeconds, ws.meetingSeconds, ws.productiveSeconds]), JSON.stringify(hrow));
T("History summary totals == row", hist.j.summary?.totalProductive === ws.productiveSeconds && hist.j.summary?.totalBreak === ws.breakSeconds && hist.j.summary?.totalMeeting === ws.meetingSeconds, JSON.stringify(hist.j.summary));
const rep = await call("GET", `/reports?from=${todayIST}&to=${todayIST}&groupBy=person`, tM);
const pRow = rep.j.people?.find((x) => x.userId === id.priya);
T("Report (manager, today, person) lists priya", rep.s === 200 && pRow, JSON.stringify(rep.j).slice(0, 200));
T("Report priya numbers == DB columns", pRow && pRow.productiveSeconds === ws.productiveSeconds && pRow.breakSeconds === ws.breakSeconds && pRow.meetingSeconds === ws.meetingSeconds, JSON.stringify(pRow));
const sumP = rep.j.people.reduce((n, x) => n + x.productiveSeconds, 0);
T("Report totals == sum of people rows (productive)", rep.j.totals.productiveSeconds === sumP, `${rep.j.totals.productiveSeconds} vs ${sumP}`);
T("Report totals == sum of people rows (break, meeting)", rep.j.totals.breakSeconds === rep.j.people.reduce((n, x) => n + x.breakSeconds, 0) && rep.j.totals.meetingSeconds === rep.j.people.reduce((n, x) => n + x.meetingSeconds, 0));
const dbSum = (await q("select coalesce(sum(\"productiveSeconds\"),0)::int s from work_sessions where date=$1 and \"platformId\"=$2 and \"userId\" = any($3)", [todayIST, avatar.id, rep.j.people.map((x) => x.userId)]))[0].s;
T("Report total productive == DB sum for the same people/day", rep.j.totals.productiveSeconds === dbSum, `${rep.j.totals.productiveSeconds} vs ${dbSum}`);
for (const g of ["person", "day", "week", "month", "year"]) { const x = await call("GET", `/reports?from=2026-10-01&to=2026-10-28&groupBy=${g}`, tM); T(`Report groupBy=${g} -> 200 and totals reconcile`, x.s === 200 && x.j.totals && (x.j.rows ?? x.j.people ?? x.j.groups ?? []).length >= 0 && x.j.totals.productiveSeconds === (await call("GET", `/reports?from=2026-10-01&to=2026-10-28&groupBy=person`, tM)).j.totals.productiveSeconds, x.s); }
T("Report bad date -> 400", (await call("GET", "/reports?from=nope&to=2026-10-28", tM)).s === 400);
T("Report to<from -> 400", (await call("GET", "/reports?from=2026-10-28&to=2026-10-01", tM)).s === 400);
const monthA = await call("GET", "/reports?from=2026-10-01&to=2026-10-31&groupBy=person", tM), monthB = await call("GET", "/reports?from=2026-09-30&to=2026-11-01&groupBy=person", tM);
T("month-boundary range (Sep 30 - Nov 1) >= Oct-only range", monthB.j.totals.productiveSeconds >= monthA.j.totals.productiveSeconds);
T("employee report scope is 'self' with headcount 1", await (async () => { const x = await call("GET", "/reports", tP); return x.j.scope === "self" && x.j.totals.headcount === 1 && x.j.people.every((p) => p.userId === id.priya); })());
T("manager report scope is 'team'", rep.j.scope === "team");

// ---------- 6. TASKS ----------
S("6. Daily tasks: propose / approve / complete / grade / score");
let t1 = await call("POST", "/tasks", tP, { title: "QA high task", weight: "HIGH", description: "d" });
T("priya proposes HIGH task -> 200", t1.s === 200, JSON.stringify(t1.j).slice(0, 200));
let tk = t1.j.tasks?.find((x) => x.title === "QA high task");
T("task starts PENDING approval (priya reports to a manager)", tk?.approvalStatus === "PENDING", JSON.stringify(tk));
T("pending task not in score (0/0)", t1.j.score?.total === 0 || t1.j.scorePercent === 0, JSON.stringify(t1.j.score));
T("empty title -> 4xx not 500", no5xx(await call("POST", "/tasks", tP, { title: "   " })), "");
T("title >200 chars -> 4xx not 500", no5xx(await call("POST", "/tasks", tP, { title: "x".repeat(250) })), "");
const early = await call("PATCH", `/tasks/${tk.id}`, tP, { status: "COMPLETED" });
T("completing an UNAPPROVED task -> 4xx not 500", no5xx(early), `${early.s} ${JSON.stringify(early.j)}`);
const q1 = await call("GET", "/tasks/review/queue", tM);
T("manager review queue shows the proposal", q1.s === 200 && JSON.stringify(q1.j).includes(tk.id), JSON.stringify(q1.j).slice(0, 200));
const t0 = await call("POST", "/tasks", tP, { title: "QA reject-no-reason", weight: "LOW" });
const tk0 = t0.j.tasks.find((x) => x.title === "QA reject-no-reason");
T("reject without a reason -> 400 (REASON_REQUIRED exists in route map)", (await call("POST", `/tasks/review/${tk0.id}/approve`, tM, { approve: false })).s === 400);
T("employee cannot approve own task (403)", (await call("POST", `/tasks/review/${tk.id}/approve`, tP, { approve: true })).s === 403);
T("manager approves -> 200", (await call("POST", `/tasks/review/${tk.id}/approve`, tM, { approve: true })).s === 200);
T("approving twice -> 409", (await call("POST", `/tasks/review/${tk.id}/approve`, tM, { approve: true })).s === 409);
T("approved task cannot be edited by employee (4xx not 500)", no5xx(await call("PATCH", `/tasks/${tk.id}`, tP, { title: "changed" })));
const tD = await call("POST", "/tasks", tP, { title: "QA started-task", weight: "LOW" });
const tkD = tD.j.tasks.find((x) => x.title === "QA started-task");
await call("POST", `/tasks/review/${tkD.id}/approve`, tM, { approve: true });
await call("PATCH", `/tasks/${tkD.id}`, tP, { status: "IN_PROGRESS" });
const delStarted = await call("DELETE", `/tasks/${tkD.id}`, tP);
T("approved + started task cannot be deleted (4xx, not 500)", delStarted.s >= 400 && delStarted.s < 500 && (await q("select count(*)::int n from daily_tasks where id=$1", [tkD.id]))[0].n === 1, `${delStarted.s} ${JSON.stringify(delStarted.j).slice(0, 80)}`);
await q("delete from daily_tasks where id=$1", [tkD.id]);
const tE = await call("POST", "/tasks", tP, { title: "QA unstarted-approved", weight: "LOW" });
const tkE = tE.j.tasks.find((x) => x.title === "QA unstarted-approved");
await call("POST", `/tasks/review/${tkE.id}/approve`, tM, { approve: true });
T("[behaviour] approved-but-unstarted task CAN be deleted by its owner (200)", (await call("DELETE", `/tasks/${tkE.id}`, tP)).s === 200);
T("outcome before done -> 400", (await call("POST", `/tasks/review/${tk.id}/outcome`, tM, { outcome: "COMPLETED" })).s === 400);
T("invalid status -> 400", (await call("PATCH", `/tasks/${tk.id}`, tP, { status: "DONE!" })).s === 400);
let up = await call("PATCH", `/tasks/${tk.id}`, tP, { status: "COMPLETED", completionNote: "finished" });
T("priya marks task COMPLETED -> 200", up.s === 200);
let l = (await call("GET", "/tasks", tP)).j;
T("score after HIGH(3) completed, nothing else = 3/3, 100%", l.score?.doneWeight === 3 && l.score?.totalWeight === 3 && l.scorePercent === 100, JSON.stringify(l.score));
T("bad outcome value -> 400", (await call("POST", `/tasks/review/${tk.id}/outcome`, tM, { outcome: "MEH" })).s === 400);
T("manager grades COMPLETED -> 200", (await call("POST", `/tasks/review/${tk.id}/outcome`, tM, { outcome: "COMPLETED" })).s === 200);
T("[behaviour] manager may re-grade an already graded task (200)", (await call("POST", `/tasks/review/${tk.id}/outcome`, tM, { outcome: "COMPLETED" })).s === 200);
// second task: MEDIUM(2), approved but not done -> 3/5 = 60%
const t2 = await call("POST", "/tasks", tP, { title: "QA medium task", weight: "MEDIUM" });
const tk2 = t2.j.tasks.find((x) => x.title === "QA medium task");
await call("POST", `/tasks/review/${tk2.id}/approve`, tM, { approve: true });
l = (await call("GET", "/tasks", tP)).j;
T("score with extra approved MEDIUM(2) unfinished = 3/5 = 60%", l.score?.doneWeight === 3 && l.score?.totalWeight === 5 && Math.round(l.scorePercent) === 60, JSON.stringify(l.score) + " " + l.scorePercent);
await call("PATCH", `/tasks/${tk2.id}`, tP, { status: "COMPLETED" });
await call("POST", `/tasks/review/${tk2.id}/outcome`, tM, { outcome: "PARTIALLY_COMPLETED" });
l = (await call("GET", "/tasks", tP)).j;
T("PARTIAL outcome counts half: 3 + 1 = 4/5 = 80%", l.score?.doneWeight === 4 && l.score?.totalWeight === 5 && Math.round(l.scorePercent) === 80, JSON.stringify(l.score));
// rejected + delete
const t3 = await call("POST", "/tasks", tP, { title: "QA reject me", weight: "LOW" });
const tk3 = t3.j.tasks.find((x) => x.title === "QA reject me");
T("manager rejects with reason", (await call("POST", `/tasks/review/${tk3.id}/approve`, tM, { approve: false, rejectionNote: "not needed" })).s === 200);
T("rejected task not counted in score", (await call("GET", "/tasks", tP)).j.score.totalWeight === 5);
T("employee deletes own unapproved/rejected task", (await call("DELETE", `/tasks/${tk3.id}`, tP)).s === 200 && (await q("select count(*)::int n from daily_tasks where id=$1", [tk3.id]))[0].n === 0);
// manager assigns
const as = await call("POST", "/tasks/review/assign", tM, { userId: id.rahul, title: "QA assigned", weight: "LOW" });
T("manager assigns task to rahul -> 200", as.s === 200, JSON.stringify(as.j).slice(0, 150));
const asRow = (await q("select \"approvalStatus\" a, \"assignedById\" b, \"userId\" u from daily_tasks where title='QA assigned'"))[0];
T("assigned task is auto-APPROVED, on rahul's list, assignedBy = manager", asRow?.a === "APPROVED" && asRow?.u === id.rahul && asRow?.b === id.manager, JSON.stringify(asRow));
const asId = asRow && (await q("select id from daily_tasks where title='QA assigned'"))[0]?.id;
T("employee cannot delete a task a manager assigned (4xx, not 500)", await (async () => { const x = await call("DELETE", `/tasks/${asId}`, tR); return x.s >= 400 && x.s < 500; })());
T("employee cannot assign tasks (403)", (await call("POST", "/tasks/review/assign", tP, { userId: id.rahul, title: "x" })).s === 403);
// IDOR within tenant
const rt = await call("POST", "/tasks", tR, { title: "QA rahul private", weight: "LOW" });
const rtk = rt.j.tasks.find((x) => x.title === "QA rahul private");
T("IDOR: priya cannot PATCH rahul's task (404)", (await call("PATCH", `/tasks/${rtk.id}`, tP, { title: "pwned" })).s === 404);
T("IDOR: priya cannot DELETE rahul's task (404)", (await call("DELETE", `/tasks/${rtk.id}`, tP)).s === 404 && (await q("select count(*)::int n from daily_tasks where id=$1", [rtk.id]))[0].n === 1);
// tenant id injection
const inj = await call("POST", "/tasks", tP, { title: "QA inject", platformId: fEmp?.platformId, userId: fEmp?.id });
const injRow = (await q("select \"userId\" u, \"platformId\" p from daily_tasks where title='QA inject'"))[0];
T("body platformId/userId ignored: task lands on priya in Avatar", injRow?.u === id.priya && injRow?.p === avatar.id, JSON.stringify(injRow));

// ---------- 7. TENANT ISOLATION ----------
S("7. Multi-tenant isolation & ownership checks");
const FM = fMgr ? await login(fMgr.employeeCode ?? fMgr.email, ISO_PW) : { s: 0 }, FE = fEmp ? await login(fEmp.employeeCode ?? fEmp.email, ISO_PW) : { s: 0 };
T("foreign manager & employee can log in (fixtures work)", FM.s === 200 && FE.s === 200, `${FM.s}/${FE.s} ${JSON.stringify(FM.j).slice(0, 120)}`);
const tFM = FM.j?.token, tFE = FE.j?.token;
T("JWT platformId of foreign user != Avatar", jwt.decode(tFM)?.platformId !== avatar.id);
// HR in Avatar vs foreign tenant
const hrUsers = await call("GET", "/admin/users", tH);
T("Avatar HR user list contains no foreign-platform users", hrUsers.s === 200 && !hrUsers.j.users.some((u) => u.id === fEmp.id || u.id === fMgr.id), `${hrUsers.j.users?.length} users`);
T("Avatar HR PATCH foreign user -> 404", (await call("PATCH", `/admin/users/${fEmp.id}`, tH, { designation: "pwn" })).s === 404);
T("Avatar HR reset foreign user's password -> 404", (await call("POST", `/admin/users/${fEmp.id}/password`, tH, { password: "Hacked@12345" })).s === 404 && (await login(fEmp.employeeCode ?? fEmp.email, ISO_PW)).s === 200);
T("Avatar HR PATCH foreign team -> 404", (await call("PATCH", `/admin/teams/${fTeam.id}`, tH, { name: "pwn" })).s === 404);
T("Avatar HR PATCH foreign team config -> 404", (await call("PATCH", `/admin/config/${fTeam.id}`, tH, { breakBudgetMinutes: 1 })).s === 404);
T("Avatar HR add member to foreign team -> 404", (await call("POST", `/admin/teams/${fTeam.id}/members`, tH, { userId: id.priya })).s === 404);
if (fShift) T("Avatar HR PATCH foreign shift -> 404", (await call("PATCH", `/admin/shifts/${fShift.id}`, tH, { name: "pwn" })).s === 404);
T("Avatar HR mark leave for foreign user -> 404", (await call("POST", "/admin/leave", tH, { userId: fEmp.id, from: "2026-12-15" })).s === 404);
T("Avatar HR create user into foreign team: not allowed (4xx)", await (async () => { const x = await call("POST", "/admin/users", tH, { email: "qa.x@avatarindia.com", firstName: "x", lastName: "x", password: "Passw0rd!123", teamId: fTeam.id, skipOnboarding: true }); const row = (await q("select \"platformId\" p from users where email='qa.x@avatarindia.com'"))[0]; return x.s >= 400 || row?.p === avatar.id; })(), "created in foreign tenant?");
// manager across tenants
await q("delete from tracker_meetings where \"attendeeIds\" @> array[$1]::uuid[]", [fEmp.id]);
await call("POST", "/tracker/clock-in", tFE);
const fSess = (await q("select status from work_sessions where \"userId\"=$1 and date=$2", [fEmp.id, todayIST]))[0];
T("precondition: foreign employee is clocked in (so a leaked invite WOULD be created)", fSess?.status === "ACTIVE", JSON.stringify(fSess));
const xinv = await call("POST", "/tracker/meetings/invite", tM, { employeeIds: [fEmp.id], meetingType: "TEAM", title: "QA cross-tenant" });
const xrows = (await q("select count(*)::int n from tracker_meetings where title='QA cross-tenant'"))[0].n;
T("Neha (Avatar) cannot invite a foreign-tenant employee (no meeting row created)", xrows === 0 && !(xinv.j?.invited ?? []).includes(fEmp.id), `HTTP ${xinv.s} invited=${JSON.stringify(xinv.j?.invited)} rows=${xrows}`);
T("Neha cannot assign a task to a foreign user (4xx)", (await call("POST", "/tasks/review/assign", tM, { userId: fEmp.id, title: "QA x-tenant" })).s >= 400 && (await q("select count(*)::int n from daily_tasks where title='QA x-tenant'"))[0].n === 0);
if (fAlert) { const x = await call("POST", `/tracker/alerts/${fAlert.id}/ack`, tM); const row = (await q("select \"acknowledgedAt\" a from alerts where id=$1", [fAlert.id]))[0]; T("foreign alert ack blocked (4xx, still unacknowledged)", (x.s === 403 || x.s === 404) && row.a === null, `${x.s} ack=${row.a}`); }
const nehaAlerts = await call("GET", "/tracker/alerts", tM);
T("Neha's alert list has no foreign-tenant alerts", nehaAlerts.s === 200 && !(fAlert && JSON.stringify(nehaAlerts.j).includes(fAlert.id)));
const nehaTeam = await call("GET", "/tracker/team", tM);
T("Neha's live team has no foreign users", !JSON.stringify(nehaTeam.j).includes(fEmp.id) && !JSON.stringify(nehaTeam.j).includes(fMgr.id));
const repX = await call("GET", "/reports?from=2026-10-01&to=2026-10-28", tM);
T("Neha's report has no foreign users", !JSON.stringify(repX.j).includes(fEmp.id) && repX.j.platform === "Avatar");
// employee IDOR across tenant
if (fTask) {
  T("priya PATCH foreign task -> 404", (await call("PATCH", `/tasks/${fTask.id}`, tP, { status: "COMPLETED" })).s === 404);
  T("priya DELETE foreign task -> 404 and row survives", (await call("DELETE", `/tasks/${fTask.id}`, tP)).s === 404 && (await q("select count(*)::int n from daily_tasks where id=$1", [fTask.id]))[0].n === 1);
  T("Neha approve foreign task -> 4xx and unchanged", await (async () => { const before = (await q("select \"approvalStatus\" a from daily_tasks where id=$1", [fTask.id]))[0].a; const x = await call("POST", `/tasks/review/${fTask.id}/approve`, tM, { approve: true }); const after = (await q("select \"approvalStatus\" a from daily_tasks where id=$1", [fTask.id]))[0].a; return x.s >= 400 && x.s < 500 && before === after; })());
}
// foreign actors cannot see Avatar
const fTeamView = await call("GET", "/tracker/team", tFM);
T("foreign manager's live team has no Avatar users", fTeamView.s === 200 && !JSON.stringify(fTeamView.j).includes(id.priya) && !JSON.stringify(fTeamView.j).includes(id.rahul));
T("foreign employee cannot answer Avatar invite", (await call("POST", `/tracker/invites/${invPid}/respond`, tFE, { accept: true })).s >= 400);
T("foreign employee /admin -> 403", (await call("GET", "/admin/users", tFE)).s === 403);
T("foreign employee report is self-only, not Avatar", await (async () => { const x = await call("GET", "/reports?from=2026-10-01&to=2026-10-28", tFE); return x.j.platform !== "Avatar" && !JSON.stringify(x.j).includes(id.priya); })());
// owner by design
const adminOpts = await call("GET", "/admin/options", tA);
T("[by design] OWNER_CODES admin (AVT-0001) can see other companies' teams in /admin/options", adminOpts.s === 200 && adminOpts.j.teams?.length > 3, adminOpts.j.teams?.length);
const hrOpts = await call("GET", "/admin/options", tH);
T("non-owner HR /admin/options shows ONLY own platform's teams", hrOpts.s === 200 && hrOpts.j.teams?.every((t) => !/Aayush|Colab|Avance/.test(t.name) ) , JSON.stringify(hrOpts.j.teams?.map((t) => t.name)));

// ---------- 7b. TICKETS & HOLIDAYS ----------
S("7b. Tickets and holidays");
const tkc = await call("POST", "/tickets", tP, { category: "HR_QUERY", subject: "QA ticket", description: "need help", priority: "HIGH" });
const tkId = tkc.j?.id ?? tkc.j?.ticket?.id;
T("priya raises a ticket -> 2xx with id", tkc.s < 300 && tkId, `${tkc.s} ${JSON.stringify(tkc.j).slice(0, 200)}`);
T("ticket with bad category -> 400", (await call("POST", "/tickets", tP, { category: "NOPE", subject: "x", description: "y" })).s === 400);
T("ticket with missing subject -> 400", (await call("POST", "/tickets", tP, { category: "HR_QUERY", subject: "", description: "y" })).s === 400);
T("attendance-correction without date -> 4xx not 500", no5xx(await call("POST", "/tickets", tP, { category: "ATTENDANCE_CORRECTION", subject: "QA fix", description: "y" })));
T("priya's own ticket list contains it", JSON.stringify((await call("GET", "/tickets", tP)).j).includes(tkId));
T("IDOR: rahul cannot read priya's ticket (403/404)", [403, 404].includes((await call("GET", `/tickets/${tkId}`, tR)).s));
T("IDOR: foreign employee cannot read it (404)", (await call("GET", `/tickets/${tkId}`, tFE)).s === 404);
T("IDOR: rahul cannot reply on priya's ticket", (await call("POST", `/tickets/${tkId}/messages`, tR, { body: "hi" })).s >= 400);
T("priya replies on her ticket -> 2xx", (await call("POST", `/tickets/${tkId}/messages`, tP, { body: "more info" })).s < 300);
T("empty reply -> 400", (await call("POST", `/tickets/${tkId}/messages`, tP, { body: "  " })).s === 400);
T("HR posts an INTERNAL note -> 2xx", (await call("POST", `/tickets/${tkId}/messages`, tH, { body: "SECRET-INTERNAL-NOTE", isInternal: true })).s < 300);
T("internal note HIDDEN from the employee", !JSON.stringify((await call("GET", `/tickets/${tkId}`, tP)).j).includes("SECRET-INTERNAL-NOTE"));
T("internal note visible to staff (admin)", JSON.stringify((await call("GET", `/tickets/${tkId}`, tA)).j).includes("SECRET-INTERNAL-NOTE"));
T("employee cannot update ticket status (4xx, not 500)", await (async () => { const x = await call("PATCH", `/tickets/${tkId}`, tP, { status: "RESOLVED" }); return x.s >= 400 && x.s < 500; })());
T("admin resolves ticket -> 200 and DB status RESOLVED", (await call("PATCH", `/tickets/${tkId}`, tA, { status: "RESOLVED", resolutionNote: "done" })).s === 200 && (await q("select status from tickets where id=$1", [tkId]))[0].status === "RESOLVED");
T("ticket counts endpoint -> 200", (await call("GET", "/tickets/counts", tP)).s === 200);
const hd = "2027-03-05";
const h1 = await call("POST", "/holidays", tH, { name: "QA holiday", date: hd });
T("HR adds holiday -> 2xx", h1.s < 300, JSON.stringify(h1.j).slice(0, 200));
const holRow = (await q("select id from holidays where name='QA holiday'"))[0];
T("holiday row exists on Avatar platform", holRow && (await q("select \"platformId\" p from holidays where id=$1", [holRow.id]))[0].p === avatar.id);
T("holiday in the past -> 400", (await call("POST", "/holidays", tH, { name: "QA past", date: "2020-01-01" })).s === 400);
T("holiday with empty name -> 400", (await call("POST", "/holidays", tH, { name: "", date: hd })).s === 400);
T("holiday with bad date -> 400", (await call("POST", "/holidays", tH, { name: "QA bad", date: "garbage" })).s === 400);
T("MANAGER cannot add holiday (403)", (await call("POST", "/holidays", tM, { name: "QA m", date: hd })).s === 403);
T("foreign HR-less employee cannot delete Avatar holiday (403)", (await call("DELETE", `/holidays/${holRow?.id}`, tFE)).s === 403);
T("HR deletes holiday -> 2xx and row gone", (await call("DELETE", `/holidays/${holRow?.id}`, tH)).s < 300 && (await q("select count(*)::int n from holidays where name='QA holiday'"))[0].n === 0);

// ---------- 8. SESSION/ACCOUNT LIFECYCLE ----------
S("8. Account lifecycle");
const susp = await call("PATCH", `/admin/users/${qaEmpId}`, tA, { status: "SUSPENDED" });
T("admin suspends QA employee", susp.s === 200);
T("suspended user cannot log in", (await login("qa.emp@avatarindia.com", "NewPass@123456")).s !== 200);
await q("update users set \"mustChangePassword\"=false where id=$1", [qaEmpId]);
const oldTok = (await (async () => { await call("PATCH", `/admin/users/${qaEmpId}`, tA, { status: "ACTIVE" }); const x = await login("qa.emp@avatarindia.com", "NewPass@123456"); await call("PATCH", `/admin/users/${qaEmpId}`, tA, { status: "SUSPENDED" }); return x.j.token; })());
const stillWorks = await call("GET", "/tasks", oldTok);
T("token issued BEFORE suspension is rejected after suspension", stillWorks.s === 401 || stillWorks.s === 403, `got ${stillWorks.s} (JWT is stateless; role/status are read from the token)`);
await call("PATCH", `/admin/users/${qaEmpId}`, tA, { role: "EMPLOYEE", status: "ACTIVE" });
const demoteTok = (await login("qa.emp@avatarindia.com", "NewPass@123456")).j.token;
await call("PATCH", `/admin/users/${qaEmpId}`, tA, { role: "MANAGER" });
const mgrTok = (await login("qa.emp@avatarindia.com", "NewPass@123456")).j.token;
await call("PATCH", `/admin/users/${qaEmpId}`, tA, { role: "EMPLOYEE" });
T("token minted while MANAGER stops working as manager after demotion", (await call("GET", "/tracker/team", mgrTok)).s === 403, "stale role in JWT keeps manager access until expiry");
T("tracker gate: user with trackerAccessEnabled=false is blocked (403)", await (async () => { await q("update users set \"trackerAccessEnabled\"=false,\"mustChangePassword\"=false where id=$1", [qaEmpId]); await call("PATCH", `/admin/users/${qaEmpId}`, tA, { status: "ACTIVE" }); const tk = (await login("qa.emp@avatarindia.com", "NewPass@123456")).j.token; const x = await call("POST", "/tracker/clock-in", tk); return x.s === 403; })());
T("tracker gate: mustChangePassword=true blocked (403)", await (async () => { await q("update users set \"trackerAccessEnabled\"=true,\"mustChangePassword\"=true where id=$1", [qaEmpId]); const tk = (await login("qa.emp@avatarindia.com", "NewPass@123456")).j.token; const x = await call("GET", "/tasks", tk); return x.s === 403; })());

// ---------- summary ----------
const fails = results.filter((x) => !x.ok);
console.log(`\n==== ${results.length - fails.length}/${results.length} passed, ${fails.length} failed ====`);
for (const f of fails) console.log(`FAIL [${f.section}] ${f.name}\n     ${f.detail}`);
fs.writeFileSync(OUT, JSON.stringify(results, null, 1));
await db.end();





