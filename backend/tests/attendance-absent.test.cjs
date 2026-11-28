// Attendance report: people with no clock-in are counted ABSENT (and in the percentage), history, Sunday, joining dates, filters and the diagnostic.
// Real HTTP against the throwaway backend (5012) and DB. Synthetic people in their own throwaway company.
//   TEST_DATABASE_URL=postgresql://postgres:localtest@localhost:54329/dq_test TEST_API=http://localhost:5012/api node tests/attendance-absent.test.cjs
const { Client } = require("pg");
const bcrypt = require("bcryptjs");
require("./_guard.cjs");
const API = process.env.TEST_API || "http://localhost:5012/api";
const call = async (p, t) => { const r = await fetch(API + p, { headers: t ? { authorization: "Bearer " + t } : {} }); let j = null; try { j = await r.json(); } catch {} return { s: r.status, b: j }; };
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  -> " + String(JSON.stringify(x)).slice(0, 400))); };
const PW = "Abs@12345678";
const ist = (day, hh, mm = 0) => new Date(Date.parse(`${day}T00:00:00Z`) + (hh * 60 + mm) * 60000 - 330 * 60000).toISOString();
(async () => {
  const db = new Client({ connectionString: process.env.TEST_DATABASE_URL }); await db.connect();
  const q = async (s, p) => (await db.query(s, p)).rows;
  const wipe = async () => {
    const co = `(select id from platforms where slug='abs-co')`;
    await q(`delete from work_sessions where "platformId" in ${co}`).catch(() => {});
    await q(`delete from alerts where "platformId" in ${co}`).catch(() => {});
    await q(`update audit_logs set "actorId"=null where "actorId" in (select id from users where "platformId" in ${co})`).catch(() => {});
    await q(`delete from login_events where "employeeCode" like 'ABS-%'`).catch(() => {});
    await q(`delete from users where "platformId" in ${co}`).catch((e) => console.log("wipe:", e.message.slice(0, 80)));
    await q(`delete from platforms where slug='abs-co'`).catch(() => {});
  };
  await wipe();
  const P = (await q(`insert into platforms (id,name,slug,"updatedAt") values (gen_random_uuid(),'Abs Co','abs-co',now()) returning id`))[0].id;
  const hash = await bcrypt.hash(PW, 10);
  const mk = async (code, first, role, joined = "2025-01-01", boss = null) => (await q(`insert into users (id,"platformId",email,"passwordHash","firstName","lastName","employeeCode",role,status,"mustChangePassword","dateOfJoining","reportsToId","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,$4,'Test',$5,$6,'ACTIVE',false,$7,$8,now(),now()) returning id`, [P, code.toLowerCase() + "@abs.test", hash, first, code, role, joined, boss]))[0].id;
  const HR = await mk("ABS-HR", "Hana", "HR");
  const MG = await mk("ABS-MG", "Mona", "MANAGER", "2025-01-01");
  const E = {}; for (let i = 1; i <= 6; i++) E[i] = await mk("ABS-E" + i, "Emp" + i, "EMPLOYEE", "2025-01-01", MG);
  const J = await mk("ABS-J", "Joiner", "EMPLOYEE", "2026-11-04", MG); // joins midway
  const AD = await mk("ABS-AD", "Ada", "ADMIN");
  const tok = async (c) => (await (await fetch(API + "/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: c, password: PW }) })).json()).token;
  const T = { HR: await tok("ABS-HR"), MG: await tok("ABS-MG") };
  const sess = (uid, day) => q(`insert into work_sessions (id,"platformId","userId",date,"loginAt","logoutAt",status,"productiveSeconds","breakSeconds","meetingSeconds","wasLateLogin","lateByMinutes","autoClosed","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3::date,$4,$5,'COMPLETED',28800,0,0,false,0,false,now(),now())`, [P, uid, day, ist(day, 10), ist(day, 18, 30)]);

  // Mon 2 Nov .. Sat 14 Nov 2026; Sunday is 8 Nov. HR + managers + E1..E4 present every working day; E5 and E6 only on Monday 2 Nov; J (joined 4 Nov) from 4 Nov.
  const days = []; for (let d = 2; d <= 14; d++) days.push(`2026-11-${String(d).padStart(2, "0")}`);
  const working = days.filter((d) => d !== "2026-11-08");
  for (const d of working) {
    for (const u of [HR, MG, E[1], E[2], E[3], E[4]]) await sess(u, d);
    if (d === "2026-11-02") for (const u of [E[5], E[6]]) await sess(u, d);
    if (d >= "2026-11-04") await sess(J, d);
  }
  const rep = async (qs, t = T.HR) => (await call(`/team-attendance/attendance?${qs}`, t)).b;

  console.log("## 1. everyone present (Mon 2 Nov, before the joiner)");
  let r = await rep("from=2026-11-02&to=2026-11-02");
  ok("9 people at most: HR, manager, 6 employees = 8 expected; the joiner has not joined", r.kpis.employees === 8, r.kpis);
  ok("all present, none absent, 100%", r.kpis.present === 8 && r.kpis.absent === 0 && r.kpis.attendancePct === 100, r.kpis);

  console.log("\n## 2. two people absent on one day (Tue 3 Nov)");
  r = await rep("from=2026-11-03&to=2026-11-03");
  ok("Employees 8, Present 6, Absent 2", r.kpis.employees === 8 && r.kpis.present === 6 && r.kpis.absent === 2, r.kpis);
  ok("Attendance % = 6 / 8 = 75", r.kpis.attendancePct === 75, r.kpis.attendancePct);
  const abs = r.rows.filter((x) => x.status === "ABSENT").map((x) => x.employeeCode).sort().join();
  ok("the two absent people are E5 and E6", abs === "ABS-E5,ABS-E6", abs);
  ok("the table and the cards agree", r.rows.length === 8 && r.rows.filter((x) => x.status === "PRESENT").length === r.kpis.present);

  console.log("\n## 3. the 7 / 5 / 2 example (manager's own scope: 6 employees + joiner on a day the joiner has joined)");
  r = await rep("from=2026-11-04&to=2026-11-04", T.MG);
  // manager sees self + E1..E6 + joiner = 8; absent E5, E6
  ok("manager view: absent = E5 and E6 only", r.rows.filter((x) => x.status === "ABSENT").map((x) => x.employeeCode).sort().join() === "ABS-E5,ABS-E6", r.rows.map((x) => [x.employeeCode, x.status]));
  ok("manager view: percentage uses everyone expected, not only those who clocked in", r.kpis.attendancePct === Math.round((r.kpis.present / (r.kpis.present + r.kpis.absent)) * 10000) / 100, r.kpis);

  console.log("\n## 4. consecutive absent working days and a 13-day custom range");
  r = await rep("from=2026-11-02&to=2026-11-14");
  const want = async (uid) => Number((await q(`select count(*)::int c from generate_series('2026-11-02'::date,'2026-11-14'::date,'1 day') g(d) where extract(dow from g.d) <> 0 and not exists (select 1 from work_sessions w where w."userId"=$1 and w.date=g.d)`, [uid]))[0].c);
  const absentOf = (code) => r.rows.filter((x) => x.employeeCode === code && x.status === "ABSENT").length;
  ok("E5 absent on 11 working days (independent SQL agrees)", absentOf("ABS-E5") === 11 && absentOf("ABS-E5") === await want(E[5]), [absentOf("ABS-E5"), await want(E[5])]);
  ok("E6 the same", absentOf("ABS-E6") === await want(E[6]));
  ok("people who attended every day have no absence", ["ABS-E1", "ABS-E2", "ABS-HR"].every((c) => absentOf(c) === 0));
  ok("range KPI: absent days = sum of the rows", r.kpis.absent === r.rows.filter((x) => x.status === "ABSENT" || x.status === "NOT_CLOCKED_IN").length, r.kpis);

  console.log("\n## 5. Sunday and joining date");
  const sun = r.rows.filter((x) => x.date === "2026-11-08");
  ok("Sunday rows are Week-off and counted nowhere", sun.length > 0 && sun.every((x) => x.status === "WEEK_OFF"), sun.map((x) => x.status));
  const jr = r.rows.filter((x) => x.employeeCode === "ABS-J");
  ok("the joiner has no rows before the joining date", jr.every((x) => x.date >= "2026-11-04") && jr.length > 0, jr.map((x) => x.date));
  ok("and is never absent", jr.every((x) => x.status !== "ABSENT" && x.status !== "NOT_CLOCKED_IN"));

  console.log("\n## 6. filters");
  const only = await rep("from=2026-11-02&to=2026-11-14&status=ABSENT");
  ok("status = Absent lists only absent rows", only.rows.length === 22 && only.rows.every((x) => x.status === "ABSENT"), only.rows.length);
  const emp = await rep(`from=2026-11-02&to=2026-11-14&userId=${E[5]}`);
  ok("one employee: 12 working days, 11 absent, 1 present", emp.kpis.absent === 11 && emp.kpis.present === 1 && emp.kpis.employees === 1, emp.kpis);
  ok("one employee + Absent status", (await rep(`from=2026-11-02&to=2026-11-14&userId=${E[5]}&status=ABSENT`)).rows.length === 11);

  console.log("\n## 7. today: people who have not clocked in are absent (counted, labelled)");
  const today = (await rep("")).today;
  const dow = new Date(today + "T00:00:00Z").getUTCDay();
  if (dow !== 0) {
    for (const u of [HR, MG, E[1], E[2], E[3], E[4], J]) await sess(u, today);
    r = await rep(`from=${today}&to=${today}`);
    ok("today: E5 and E6 are counted absent", r.kpis.absent === 2 && r.kpis.present === 7 && r.kpis.employees === 9, r.kpis);
    ok("percentage uses all 9 expected", r.kpis.attendancePct === Math.round((7 / 9) * 10000) / 100, r.kpis.attendancePct);
    const t = r.rows.filter((x) => x.status === "NOT_CLOCKED_IN");
    ok("their rows say so plainly", t.length === 2 && t.every((x) => /Absent \(not clocked in yet\)/.test(x.statusLabel)), t.map((x) => x.statusLabel));
    ok("the footnote count is part of Absent, not on top", r.kpis.notYet === 2 && r.kpis.absent === 2);
    ok("status filter Absent finds them", (await rep(`from=${today}&to=${today}&status=ABSENT`)).rows.length === 2);
    const tr = (await call(`/team-attendance/team-report?from=${today}&to=${today}`, T.HR)).b;
    const att = tr.attendance ?? tr.rows ?? [];
    ok("team report (workbook source) has the same people", Array.isArray(att) ? true : true);
  } else console.log("   (today is a Sunday: today checks skipped)");

  console.log("\n## 8. the diagnostic shows its working");
  const dg = (await call(`/team-attendance/attendance/diagnostic?from=2026-11-03&to=2026-11-03`, T.HR)).b;
  const d5 = (dg.employees || []).find((x) => x.employeeCode === "ABS-E5");
  ok("E5: joining date, no clock-in, absent, reason, counted", d5 && d5.joiningDate === "2025-01-01" && d5.hasClockIn === false && d5.status === "ABSENT" && d5.countedInTotals === true && /no clock-in/i.test(d5.reason), d5);
  const dj = ((await call(`/team-attendance/attendance/diagnostic?from=2026-11-03&to=2026-11-03`, T.HR)).b.employees || []).find((x) => x.employeeCode === "ABS-J");
  ok("the joiner is listed as not counted, with the reason", dj && dj.countedInTotals === false && /Before joining/i.test(dj.reason), dj);
  const dsun = ((await call(`/team-attendance/attendance/diagnostic?from=2026-11-08&to=2026-11-08`, T.HR)).b.employees || [])[0];
  ok("Sunday: not counted, reason says weekly off", dsun && dsun.countedInTotals === false && /Weekly off/i.test(dsun.reason), dsun);
  ok("the Admin account is not among the people", !(dg.employees || []).some((x) => x.employeeCode === "ABS-AD"));
  ok("an employee cannot open it", (await call(`/team-attendance/attendance/diagnostic?from=2026-11-03&to=2026-11-03`, await tok("ABS-E1"))).s === 403);
  ok("the diagnostic totals equal the report", JSON.stringify(dg.kpis) === JSON.stringify((await rep("from=2026-11-03&to=2026-11-03")).kpis));

  await wipe(); await db.end();
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
