// Attendance Calendar over HTTP: arrival classification from stored check-ins, Absent / Not tracked rules, role scoping, and that the stored
// working/break figures are shown untouched. Disposable database only (see _guard.cjs). NO migration is needed for this feature.
//
//   cd backend && TEST_DATABASE_URL=... TEST_API=http://localhost:5012/api node tests/attendance-calendar.test.cjs
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
const ok = (n, c, x) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  -> " + String(JSON.stringify(x)).slice(0, 400))); };
const PW = "Cal@12345678";

(async () => {
  const db = new Client({ connectionString: process.env.TEST_DATABASE_URL }); await db.connect();
  const q = async (s, p) => (await db.query(s, p)).rows;
  const AV = (await q(`select id from platforms where slug='avatar'`))[0].id;
  const AVN = (await q(`select id from platforms where slug='avance'`))[0].id;
  const hash = await bcrypt.hash(PW, 10);
  const wipe = async () => {
    const ids = `(select id from users where "employeeCode" like 'CAL-%')`;
    await q(`delete from tracker_breaks where "workSessionId" in (select id from work_sessions where "userId" in ${ids})`);
    await q(`delete from work_sessions where "userId" in ${ids}`);
    await q(`delete from team_members where "userId" in ${ids}`);
    await q(`delete from teams where name like 'CAL-%'`);
    await q(`delete from users where "employeeCode" like 'CAL-%'`);
  };
  await wipe();
  const mk = async (code, role, platformId, reportsToId = null) => {
    await q(`insert into users (id,"platformId",email,"passwordHash","firstName","lastName","employeeCode",role,status,"mustChangePassword","trackerAccessEnabled","onboardingStatus","reportsToId","dateOfJoining","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,$4,'Cal',$5,$6,'ACTIVE',false,true,'ACTIVE',$7,'2026-01-01',now(),now())`, [platformId, code.toLowerCase() + "@cal.test", hash, code.replace("CAL-", "T"), code, role, reportsToId]);
    const id = (await q(`select id from users where "employeeCode"=$1`, [code]))[0].id;
    return { id, tok: null };
  };
  // login is POST with a body; re-implement just for this call
  const login = async (code) => (await (await fetch(API + "/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: code, password: PW }) })).json()).token;
  const mk2 = async (code, role, platformId, reportsToId = null) => { const u = await mk(code, role, platformId, reportsToId); u.tok = await login(code); return u; };

  const M = await mk2("CAL-M", "MANAGER", AV);
  const P1 = await mk2("CAL-P1", "EMPLOYEE", AV, M.id); // 9:45  -> Present
  const P2 = await mk2("CAL-P2", "EMPLOYEE", AV, M.id); // 9:46  -> Late
  const P3 = await mk2("CAL-P3", "EMPLOYEE", AV, M.id); // 10:15 -> Late
  const P4 = await mk2("CAL-P4", "EMPLOYEE", AV, M.id); // 10:16 -> Half Day
  const P5 = await mk2("CAL-P5", "EMPLOYEE", AV, M.id); // no check-in, others did -> Absent
  const X = await mk2("CAL-X", "EMPLOYEE", AV);         // not M's report
  const HR = await mk2("CAL-HR", "HR", AV);
  const HRB = await mk2("CAL-HRB", "HR", AVN);
  const EB = await mk2("CAL-EB", "EMPLOYEE", AVN);
  const DAY = "2026-10-28"; // a Wednesday in the past

  // team for the department filter
  const T = (await q(`insert into teams (id,"platformId",name,"managerId","isActive","createdAt","updatedAt") values (gen_random_uuid(),$1,'CAL-Sales',$2,true,now(),now()) returning id`, [AV, M.id]))[0].id;
  for (const u of [P1, P2]) await q(`insert into team_members (id,"teamId","userId","isActive","isPrimary","joinedAt") values (gen_random_uuid(),$1,$2,true,true,now())`, [T, u.id]);

  // IST wall clock -> UTC instant
  const ist = (hhmm) => { const [h, m] = hhmm.split(":").map(Number); return new Date(Date.UTC(2026, 9, 28, h, m) - 330 * 60_000).toISOString(); };
  const seed = async (u, inAt, outAt, productive, brk) => {
    const id = (await q(`insert into work_sessions (id,"platformId","userId",date,"loginAt","logoutAt",status,"productiveSeconds","breakSeconds","meetingSeconds","wasLateLogin","lateByMinutes","autoClosed","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3::date,$4,$5,'COMPLETED',$6,$7,0,false,0,false,now(),now()) returning id`, [AV, u.id, DAY, ist(inAt), ist(outAt), productive, brk]))[0].id;
    return id;
  };
  await seed(P1, "09:45", "18:45", 8 * 3600, 3600);
  await seed(P2, "09:46", "18:00", 7 * 3600, 1800);
  await seed(P3, "10:15", "18:00", 7 * 3600, 1800);
  await seed(P4, "10:16", "13:30", 3 * 3600, 600);

  const cal = (t, extra = "") => call("GET", `/attendance-calendar?from=${DAY}&to=${DAY}${extra}`, t);
  const status = (res, u) => res.b.rows?.find((r) => r.userId === u.id)?.status;

  console.log("\n## 1. The four boundary check-ins (company time)");
  const m = await cal(M.tok);
  ok("the manager's calendar loads (200)", m.s === 200, m);
  ok("9:45 AM = Present", status(m, P1) === "PRESENT", m.b.rows);
  ok("9:46 AM = Late", status(m, P2) === "LATE");
  ok("10:15 AM = Late", status(m, P3) === "LATE");
  ok("10:16 AM = Half Day", status(m, P4) === "HALF_DAY");
  ok("no check-in on a day the company was tracking = Absent", status(m, P5) === "ABSENT", m.b.rows?.find((r) => r.userId === P5.id));

  console.log("\n## 2. The record behind a day");
  const r2 = m.b.rows.find((r) => r.userId === P2.id);
  ok("first check-in is the original stored stamp", r2.firstCheckIn === ist("09:46").replace(/\.000Z$/, ".000Z") || new Date(r2.firstCheckIn).getTime() === new Date(ist("09:46")).getTime(), r2);
  ok("last check-out is the original stored stamp", new Date(r2.lastCheckOut).getTime() === new Date(ist("18:00")).getTime());
  ok("late indicator: 1 minute after 9:45", r2.lateByMinutes === 1);
  ok("on time has no late minutes", m.b.rows.find((r) => r.userId === P1.id).lateByMinutes === 0);
  ok("working time = the stored productive time (7h = 25200 s)", Math.abs(r2.workedSeconds - 25200) <= 1, r2);
  ok("break time = the stored break time (30 min)", r2.breakSeconds === 1800, r2);
  ok("the people list carries name, employee ID and department", (() => { const p = m.b.people.find((x) => x.id === P1.id); return p.name && p.code === "CAL-P1" && p.teamName === "CAL-Sales"; })(), m.b.people);
  ok("the counts add up (1 present, 2 late, 1 half day, 2 absent: P5 and the manager, who also did not check in)", m.b.counts.PRESENT === 1 && m.b.counts.LATE === 2 && m.b.counts.HALF_DAY === 1 && m.b.counts.ABSENT === 2, m.b.counts);
  ok("the stored session was not touched", (await q(`select "productiveSeconds","breakSeconds","wasLateLogin" from work_sessions where "userId"=$1`, [P2.id]))[0].productiveSeconds === 7 * 3600);

  console.log("\n## 3. Who sees whom");
  ok("the manager sees exactly their reports plus themselves, not others", ["CAL-P1", "CAL-P2", "CAL-P3", "CAL-P4", "CAL-P5", "CAL-M"].every((c) => m.b.people.some((p) => p.code === c)) && !m.b.people.some((p) => p.code === "CAL-X"), m.b.people.map((p) => p.code));
  const e = await cal(P2.tok);
  ok("an employee sees only themselves", e.s === 200 && e.b.people.length === 1 && e.b.people[0].id === P2.id && e.b.rows.every((r) => r.userId === P2.id), e.b.people);
  ok("an employee cannot ask for a colleague (filter only narrows, nothing leaks)", (await cal(P2.tok, `&userId=${P1.id}`)).b.people.length === 0);
  const h = await cal(HR.tok);
  ok("HR sees the whole company", ["CAL-P1", "CAL-P5", "CAL-X", "CAL-HR"].every((c) => h.b.people.some((p) => p.code === c)));
  ok("HR does not see another company", !h.b.people.some((p) => p.code === "CAL-EB" || p.code === "CAL-HRB"));
  const hb = await cal(HRB.tok);
  ok("HR of another company sees theirs and none of the first company", hb.b.people.some((p) => p.code === "CAL-EB") && !hb.b.people.some((p) => p.code.startsWith("CAL-") && ["CAL-P1", "CAL-P5", "CAL-X", "CAL-M", "CAL-HR"].includes(p.code)), hb.b.people.map((p) => p.code));
  await q(`insert into company_access (id,"userId","platformId","createdAt") values (gen_random_uuid(),$1,$2,now())`, [HRB.id, AV]);
  const hb2 = await cal(HRB.tok);
  ok("HR assigned a second company sees both", hb2.b.people.some((p) => p.code === "CAL-P1") && hb2.b.people.some((p) => p.code === "CAL-EB"));
  await q(`delete from company_access where "userId"=$1`, [HRB.id]);
  ok("no sign-in = 401", (await call("GET", `/attendance-calendar`)).s === 401);

  console.log("\n## 4. Filters");
  const f1 = await cal(HR.tok, `&teamId=${T}`);
  ok("department filter narrows to that department", f1.b.people.length === 2 && f1.b.people.every((p) => p.teamName === "CAL-Sales"), f1.b.people.map((p) => p.code));
  const f2 = await cal(HR.tok, `&userId=${P3.id}`);
  ok("employee filter narrows to one person", f2.b.people.length === 1 && f2.b.rows.length === 1 && f2.b.rows[0].status === "LATE");
  ok("a bad id is a 400, not a server error", (await cal(HR.tok, "&userId=nope")).s === 400 || (await cal(HR.tok, "&userId=nope")).s === 404);
  ok("a bad date is a 400", (await call("GET", `/attendance-calendar?from=2026-13-40`, HR.tok)).s === 400);
  ok("end before start is a 400", (await call("GET", `/attendance-calendar?from=2026-10-30&to=2026-10-01`, HR.tok)).s === 400);
  ok("more than 93 days is a 400", (await call("GET", `/attendance-calendar?from=2026-01-01&to=2026-12-31`, HR.tok)).s === 400);

  console.log("\n## 5. A whole month, and days that must not be called Absent");
  const mo = await call("GET", `/attendance-calendar?from=2026-10-01&to=2026-10-31&userId=${P1.id}`, HR.tok);
  ok("the month loads for one person", mo.s === 200 && mo.b.rows.length > 20, mo.b.rows?.length);
  const d27 = mo.b.rows.find((r) => r.date === "2026-10-27");
  ok("a working day on which nobody in the company clocked in is NOT Absent", d27 && d27.status !== "ABSENT", d27);
  const sat = mo.b.rows.find((r) => r.date === "2026-10-31");
  ok("a weekend is Week-off, not Absent", sat && (sat.status === "WEEK_OFF" || sat.status === "NOT_TRACKED"), sat);
  const cur = await call("GET", `/attendance-calendar`, HR.tok);
  ok("with no dates it shows the current month", cur.s === 200 && cur.b.from.endsWith("-01") && cur.b.to >= cur.b.today, { from: cur.b.from, to: cur.b.to, today: cur.b.today });
  const futureRows = cur.b.rows.filter((r) => r.date > cur.b.today);
  ok("future days show nothing", futureRows.length === 0, futureRows.length);
  const todayRows = cur.b.rows.filter((r) => r.date === cur.b.today && r.status === "ABSENT");
  ok("nobody is Absent today while the day is still in progress", todayRows.length === 0, todayRows.length);

  await wipe();
  await db.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
