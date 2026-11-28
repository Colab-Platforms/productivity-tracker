// Late streak through the real calendar and attendance report: 3 late WORKING days in a row make the 3rd a half day; the count restarts; an on-time day breaks it;
// Sundays are skipped; a run that began BEFORE the window still counts. Synthetic people in their own throwaway company.
//   TEST_DATABASE_URL=postgresql://postgres:localtest@localhost:54329/dq_test TEST_API=http://localhost:5012/api node tests/late-streak-api.test.cjs
const { Client } = require("pg");
const bcrypt = require("bcryptjs");
require("./_guard.cjs");
const API = process.env.TEST_API || "http://localhost:5012/api";
const get = async (p, t) => { const r = await fetch(API + p, { headers: { authorization: "Bearer " + t } }); let j = null; try { j = await r.json(); } catch {} return { s: r.status, b: j }; };
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  -> " + String(JSON.stringify(x)).slice(0, 500))); };
const PW = "Lst@12345678";
const ist = (day, hh, mm) => new Date(Date.parse(`${day}T00:00:00Z`) + (hh * 60 + mm) * 60000 - 330 * 60000).toISOString();
(async () => {
  const db = new Client({ connectionString: process.env.TEST_DATABASE_URL }); await db.connect();
  const q = async (s, p) => (await db.query(s, p)).rows;
  const wipe = async () => {
    const co = `(select id from platforms where slug='lst-co')`;
    await q(`delete from work_sessions where "platformId" in ${co}`).catch(() => {});
    await q(`update audit_logs set "actorId"=null where "actorId" in (select id from users where "platformId" in ${co})`).catch(() => {});
    await q(`delete from login_events where "employeeCode" like 'LST-%'`).catch(() => {});
    await q(`delete from users where "platformId" in ${co}`).catch((e) => console.log("wipe:", e.message.slice(0, 80)));
    await q(`delete from platforms where slug='lst-co'`).catch(() => {});
  };
  await wipe();
  const P = (await q(`insert into platforms (id,name,slug,"updatedAt") values (gen_random_uuid(),'Lst Co','lst-co',now()) returning id`))[0].id;
  const hash = await bcrypt.hash(PW, 10);
  const mk = async (code, role) => (await q(`insert into users (id,"platformId",email,"passwordHash","firstName","lastName","employeeCode",role,status,"mustChangePassword","dateOfJoining","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,$4,'Test',$5,$6,'ACTIVE',false,'2025-01-01',now(),now()) returning id`, [P, code.toLowerCase() + "@lst.test", hash, "P" + code.slice(4), code, role]))[0].id;
  const HR = await mk("LST-HR", "HR");
  const L = await mk("LST-L", "EMPLOYEE"), M = await mk("LST-M", "EMPLOYEE"), K = await mk("LST-K", "EMPLOYEE"), O = await mk("LST-O", "EMPLOYEE");
  const tok = (await (await fetch(API + "/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "LST-HR", password: PW }) })).json()).token;
  const sess = (uid, day, hh, mm) => q(`insert into work_sessions (id,"platformId","userId",date,"loginAt","logoutAt",status,"productiveSeconds","breakSeconds","meetingSeconds","wasLateLogin","lateByMinutes","autoClosed","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3::date,$4,$5,'COMPLETED',28800,0,0,false,0,false,now(),now())`, [P, uid, day, ist(day, hh, mm), ist(day, 18, 30)]);
  // Mon 2 Nov .. Sat 14 Nov 2026 (Sunday 8 Nov)
  const D = (n) => `2026-11-${String(n).padStart(2, "0")}`;
  const lateDays = { L: [2, 3, 4, 5, 6, 7], M: [2, 3, 5, 6, 7], K: [6, 7, 9] };
  for (let n = 2; n <= 14; n++) {
    if (n === 8) continue;
    await sess(HR, D(n), 9, 30);
    await sess(O, D(n), 9, 30);
    for (const [who, uid] of [["L", L], ["M", M], ["K", K]]) await sess(uid, D(n), lateDays[who].includes(n) ? 9 : 9, lateDays[who].includes(n) ? 50 : 30);
  }
  const cal = async (from, to) => (await get(`/attendance-calendar?from=${from}&to=${to}`, tok)).b;
  const rep = async (from, to) => (await get(`/team-attendance/attendance?from=${from}&to=${to}`, tok)).b;
  const calStatus = (c, uid, day) => c.rows.find((r) => r.userId === uid && r.date === day)?.status;
  const repArr = (r, code, day) => r.rows.find((x) => x.employeeCode === code && x.date === day);

  console.log("## the new limits");
  let c = await cal(D(2), D(14));
  ok("the calendar reports the new rules", c.rules.presentUntil === "09:45" && c.rules.lateUntil === "10:00", c.rules);

  console.log("\n## L: six late working days in a row");
  ok("1st and 2nd late stay Late", calStatus(c, L, D(2)) === "LATE" && calStatus(c, L, D(3)) === "LATE");
  ok("3rd late (Wed) is a Half Day", calStatus(c, L, D(4)) === "HALF_DAY" && c.rows.find((r) => r.userId === L && r.date === D(4)).lateStreakHalfDay === true);
  ok("the count restarted: 4th and 5th are Late again", calStatus(c, L, D(5)) === "LATE" && calStatus(c, L, D(6)) === "LATE");
  ok("6th late (Sat) is the next Half Day", calStatus(c, L, D(7)) === "HALF_DAY");
  ok("the day panel says why", /3rd late working day in a row/.test(c.rows.find((r) => r.userId === L && r.date === D(4)).remarks));
  ok("later on-time days are Present", calStatus(c, L, D(9)) === "PRESENT");

  console.log("\n## M: late, late, ON TIME, late, late, late");
  ok("an on-time day breaks the run: 1st, 2nd late stay Late", calStatus(c, M, D(2)) === "LATE" && calStatus(c, M, D(3)) === "LATE" && calStatus(c, M, D(4)) === "PRESENT");
  ok("the new run: Thu, Fri Late and Sat (3rd) Half Day", calStatus(c, M, D(5)) === "LATE" && calStatus(c, M, D(6)) === "LATE" && calStatus(c, M, D(7)) === "HALF_DAY");

  console.log("\n## K: late Fri, Sat, (Sunday off), Mon: the 3rd is Monday; the window starts on Monday (lookback)");
  const cm = await cal(D(9), D(9));
  ok("only Monday in the window, yet it is a Half Day because the run began before it (Sunday skipped)", calStatus(cm, K, D(9)) === "HALF_DAY", cm.rows.filter((r) => r.userId === K));
  ok("Friday alone is Late", calStatus(await cal(D(6), D(6)), K, D(6)) === "LATE");

  console.log("\n## the attendance report (Late remark column) says the same");
  const r = await rep(D(2), D(14));
  ok("L 4 Nov: arrival Half Day with arrivalStreak true", repArr(r, "LST-L", D(4))?.arrival === "HALF_DAY" && repArr(r, "LST-L", D(4)).arrivalStreak === true, repArr(r, "LST-L", D(4)));
  ok("L 2 Nov: still Late, no streak flag", repArr(r, "LST-L", D(2))?.arrival === "LATE" && repArr(r, "LST-L", D(2)).arrivalStreak === false);
  ok("L 7 Nov: the 6th late is a Half Day", repArr(r, "LST-L", D(7))?.arrival === "HALF_DAY");
  ok("M 7 Nov: Half Day (3rd after the on-time day)", repArr(r, "LST-M", D(7))?.arrival === "HALF_DAY");
  ok("the on-time person is never touched", r.rows.filter((x) => x.employeeCode === "LST-O").every((x) => x.arrival === "ON_TIME" || x.arrival === "WEEK_OFF"));
  const r1 = await rep(D(9), D(9));
  ok("report for Monday alone: K is a Half Day through the lookback", repArr(r1, "LST-K", D(9))?.arrival === "HALF_DAY" && repArr(r1, "LST-K", D(9)).arrivalStreak === true, repArr(r1, "LST-K", D(9)));
  const filt = await get(`/team-attendance/attendance?from=${D(2)}&to=${D(14)}&arrival=HALF_DAY`, tok);
  ok("the Half Day filter finds the streak half days too", filt.b.rows.some((x) => x.employeeCode === "LST-L" && x.date === D(4)), filt.b.rows.length);
  ok("payroll's own status for that day is unchanged (hours-based, 8h worked = Present)", repArr(r, "LST-L", D(4)).status === "PRESENT", repArr(r, "LST-L", D(4)).status);

  await wipe(); await db.end();
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
