// Break Management (Admin only): real HTTP on the THROWAWAY database. Seeds break rows directly (times as ISO UTC strings).
//   cd backend && TEST_DATABASE_URL=... TEST_API=http://localhost:5012/api node tests/break-monitor.test.cjs
require("dotenv").config({ path: require("node:path").join(__dirname, "..", ".env") });
const { Client } = require("pg");
const bcrypt = require("bcryptjs");
const API = process.env.TEST_API ?? "http://localhost:5012/api";
require("./_guard.cjs").assertTestDb(process.env.TEST_DATABASE_URL);
const call = async (m, p, t) => { const r = await fetch(API + p, { method: m, headers: t ? { authorization: "Bearer " + t } : {} }); const x = await r.text(); let j; try { j = JSON.parse(x); } catch { j = x; } return { s: r.status, b: j }; };
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  -> " + String(JSON.stringify(x)).slice(0, 400))); };
const PW = "Bkm@12345678";
const ist = (d) => new Date(d.getTime() + 5.5 * 3600e3).toISOString().slice(0, 10); // the company day (Asia/Kolkata)
(async () => {
  const db = new Client({ connectionString: process.env.TEST_DATABASE_URL }); await db.connect();
  const q = async (s, p) => (await db.query(s, p)).rows;
  const A = (await q(`select id, timezone from platforms where slug='avatar'`))[0];
  const B = (await q(`select id from platforms where slug='co-lab'`))[0].id;
  const hash = await bcrypt.hash(PW, 10);
  const wipe = async () => {
    const ids = `(select id from users where "employeeCode" like 'BKM-%')`;
    await q(`delete from tracker_breaks where "workSessionId" in (select id from work_sessions where "userId" in ${ids})`);
    await q(`delete from work_sessions where "userId" in ${ids}`);
    await q(`delete from team_configs where "teamId" in (select id from teams where name like 'BKM-%')`);
    await q(`delete from team_members where "userId" in ${ids}`); await q(`delete from teams where name like 'BKM-%'`);
    await q(`delete from company_access where "userId" in ${ids}`);
    await q(`update audit_logs set "actorId"=null where "actorId" in ${ids}`).catch(() => {});
    await q(`delete from login_events where "userId" in ${ids}`).catch(() => {});
    await q(`update users set "reportsToId"=null where "reportsToId" in ${ids}`);
    await q(`delete from users where "employeeCode" like 'BKM-%'`);
  };
  await wipe();
  const mk = async (code, role, plat, boss = null) => { await q(`insert into users (id,"platformId",email,"passwordHash","firstName","lastName","employeeCode",role,status,"mustChangePassword","trackerAccessEnabled","onboardingStatus","reportsToId","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,$4,'Bkm',$5,$6,'ACTIVE',false,true,'ACTIVE',$7,now(),now())`, [plat, code.toLowerCase() + "@bkm.test", hash, code.replace("BKM-", ""), code, role, boss]); const id = (await q(`select id from users where "employeeCode"=$1`, [code]))[0].id; return { id, code, tok: (await call("POST", "/auth/login", null).then(() => null)) }; };
  const login = async (code) => { const r = await fetch(API + "/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: code, password: PW }) }); return (await r.json()).token; };
  const AD = await mk("BKM-AD", "ADMIN", A.id); AD.tok = await login("BKM-AD");
  await q(`insert into company_access (id,"userId","platformId","createdAt") values (gen_random_uuid(),$1,null,now())`, [AD.id]);
  const AD2 = await mk("BKM-AD2", "ADMIN", B); AD2.tok = await login("BKM-AD2");
  await q(`insert into company_access (id,"userId","platformId","createdAt") values (gen_random_uuid(),$1,null,now())`, [AD2.id]);
  const HR = await mk("BKM-HR", "HR", A.id); HR.tok = await login("BKM-HR");
  const MGR = await mk("BKM-MGR", "MANAGER", A.id, AD.id); MGR.tok = await login("BKM-MGR");
  const E1 = await mk("BKM-E1", "EMPLOYEE", A.id, MGR.id); E1.tok = await login("BKM-E1");
  const E2 = await mk("BKM-E2", "EMPLOYEE", A.id, MGR.id);
  const E3 = await mk("BKM-E3", "EMPLOYEE", B, null);   // other company, company default allowance (60)
  // a team with Break Time 30 min for E1 and E2 (its 5 min "Break overage" alert setting must NOT change who is a defaulter)
  const team = (await q(`insert into teams (id,"platformId",name,"managerId","isActive","createdAt","updatedAt") values (gen_random_uuid(),$1,'BKM-Team',$2,true,now(),now()) returning id`, [A.id, MGR.id]))[0].id;
  await q(`insert into team_configs (id,"teamId","breakBudgetMinutes","breakOverageAlertMinutes","updatedAt") values (gen_random_uuid(),$1,30,5,now())`, [team]);
  for (const u of [E1, E2]) await q(`insert into team_members (id,"teamId","userId","isActive","isPrimary","joinedAt") values (gen_random_uuid(),$1,$2,true,true,now())`, [team, u.id]);

  const now = new Date();
  const today = ist(now);
  const dayAgo = (n) => new Date(Date.parse(today + "T00:00:00Z") - n * 864e5).toISOString().slice(0, 10);
  const session = async (u, day) => (await q(`insert into work_sessions (id,"platformId","userId",date,"loginAt",status,"createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,$4,'ACTIVE',now(),now()) returning id`, [u === E3 ? B : A.id, u.id, day, day + "T03:30:00.000Z"]))[0].id;
  const brk = async (sid, type, start, end, extra = {}) => (await q(`insert into tracker_breaks (id,"workSessionId","breakType","startedAt","endedAt","durationSeconds","autoClosed","createdAt",reason,"correctedDurationSeconds") values (gen_random_uuid(),$1,$2,$3,$4,$5,false,now(),$6,$7) returning id`, [sid, type, start, end, end ? Math.round((Date.parse(end) - Date.parse(start)) / 1000) : null, extra.reason ?? null, extra.corrected ?? null]))[0].id;
  // E1 today: 20 + 20 = 40 min > 30 => exceeded (excess 10); plus a washroom (not a break) and a discussion (not a break)
  const s1 = await session(E1, today);
  await brk(s1, "LUNCH", today + "T05:00:00.000Z", today + "T05:20:00.000Z");
  const late = await brk(s1, "PERSONAL", today + "T06:00:00.000Z", today + "T06:20:00.000Z");
  await brk(s1, "WASHROOM", today + "T07:00:00.000Z", today + "T07:30:00.000Z");
  await brk(s1, "OTHER", today + "T07:40:00.000Z", today + "T08:40:00.000Z", { reason: "Discussion: sprint" });
  // E2 today: 33 min (already 3 min over 30) and one OPEN break right now
  const s2 = await session(E2, today);
  await brk(s2, "LUNCH", today + "T04:00:00.000Z", today + "T04:33:00.000Z");
  const openId = await brk(s2, "PERSONAL", new Date(now.getTime() - 10 * 60e3).toISOString(), null);
  // E3 (other company) yesterday: 90 min > company default 60 => exceeded; a corrected break counts as corrected (10 min)
  const y = dayAgo(1);
  const s3 = await session(E3, y);
  await brk(s3, "LUNCH", y + "T05:00:00.000Z", y + "T06:30:00.000Z");
  await brk(s3, "PERSONAL", y + "T08:00:00.000Z", y + "T10:00:00.000Z", { corrected: 600 });
  // E1 present yesterday with no breaks
  await session(E1, y);

  const get = (tok, qs) => call("GET", `/break-monitor?${qs}`, tok);
  try {
    console.log("## Who may open it");
    ok("Admin: 200", (await get(AD.tok, "")).s === 200);
    ok("HR: 403", (await get(HR.tok, "")).s === 403);
    ok("Manager: 403", (await get(MGR.tok, "")).s === 403);
    ok("Employee: 403", (await get(E1.tok, "")).s === 403);
    ok("no sign-in: 401", (await get(null, "")).s === 401);

    console.log("\n## Today, as an Admin");
    const r = (await get(AD.tok, `from=${today}&to=${today}`)).b;
    const mine = (list) => list.filter((id) => [E1.id, E2.id, E3.id].includes(id));
    const e1Breaks = r.breaks.filter((b) => b.userId === E1.id);
    ok("E1's two breaks are listed; washroom and the discussion are not breaks", e1Breaks.length === 2 && !e1Breaks.some((b) => ["WASHROOM"].includes(b.breakType) || (b.reason ?? "").startsWith("Discussion")), e1Breaks.map((b) => b.breakType));
    const e1day = r.days.find((d) => d.userId === E1.id && d.day === today);
    ok("E1 today: 40 min total, allowance 30, exceeded, excess 10 min", e1day.seconds === 2400 && e1day.allowanceSeconds === 1800 && e1day.exceeded && e1day.excessSeconds === 600, e1day);
    ok("the 2nd break carries the excess (Exceeded), the 1st is within", r.breaks.find((b) => b.id === late).status === "EXCEEDED" && r.breaks.find((b) => b.id === late).excessSeconds === 600);
    const e2day = r.days.find((d) => d.userId === E2.id && d.day === today);
    ok("E2 today: the open break is listed as Currently on break, no end time", r.breaks.find((b) => b.id === openId).status === "ACTIVE" && r.breaks.find((b) => b.id === openId).endedAt === null);
    ok("E2 today: 33 + about 10 running = over 30, so exceeded (the alert tolerance plays no part)", e2day.exceeded, e2day);
    ok("card: Currently on break = E2 only (of our people)", JSON.stringify(mine(r.summary.currentlyOnBreak)) === JSON.stringify([E2.id]));
    ok("card: Total breaks today = rows dated today (ids listed)", r.summary.breaksToday === r.summary.breaksTodayIds.length && r.breaks.filter((b) => b.day === today).length === r.summary.breaksToday);
    ok("card: Employees exceeding = people with an exceeded day, both E1 and E2", mine(r.summary.exceeding).sort().join() === [E1.id, E2.id].sort().join());
    ok("card: Employees with break activity = distinct people in the rows", r.summary.employeesWithBreaks.length === new Set(r.breaks.map((b) => b.userId)).size);
    const done = r.breaks.filter((b) => !b.open);
    ok("card: Average break duration = average of completed breaks", r.summary.avgBreakSeconds === Math.round(done.reduce((n, b) => n + b.seconds, 0) / done.length));
    ok("the person details carry company, department (team), manager and the allowance source", r.people[E1.id].company && r.people[E1.id].department === "BKM-Team" && r.people[E1.id].manager === "MGR Bkm" && r.people[E1.id].allowanceMinutes === 30 && r.people[E1.id].allowanceSource === "TEAM", r.people[E1.id]);
    ok("Admin accounts are never in the list", !r.breaks.some((b) => [AD.id, AD2.id].includes(b.userId)) && !r.people[AD.id]);

    console.log("\n## Yesterday, the other company and corrections");
    const yy = (await get(AD.tok, `from=${y}&to=${y}`)).b;
    const e3day = yy.days.find((d) => d.userId === E3.id);
    ok("E3 (other company) is visible to the Admin, company default allowance 60 applies", yy.people[E3.id]?.allowanceMinutes === 60 && yy.people[E3.id].allowanceSource === "COMPANY");
    ok("E3: 90 + corrected 10 = 100 min, exceeded by 40 min (the correction wins over 2 hours)", e3day.seconds === 6000 && e3day.excessSeconds === 2400, e3day);
    const agg1 = yy.range.find((p) => p.userId === E1.id);
    ok("E1 was present yesterday with no breaks: listed with 0 breaks, not a defaulter", agg1 && agg1.breaks === 0 && !agg1.defaulter && agg1.daysPresent === 1, agg1);

    console.log("\n## Weekly and monthly defaulters");
    const wk = (await get(AD.tok, `from=${today}&to=${today}`)).b;
    const weekHasY = y >= wk.week.from;
    const expectWeek = [E1.id, E2.id, ...(weekHasY ? [E3.id] : [])].sort().join();
    ok("weekly defaulters = everyone with an exceeded day this week", mine(wk.summary.weeklyDefaulters).sort().join() === expectWeek, { got: mine(wk.summary.weeklyDefaulters), week: wk.week });
    ok("weekly card number = the weekly tab's defaulter rows", wk.summary.weeklyDefaulters.length === wk.weekly.filter((p) => p.defaulter).length);
    ok("monthly card number = the monthly tab's defaulter rows", wk.summary.monthlyDefaulters.length === wk.monthly.filter((p) => p.defaulter).length);
    const m1 = wk.monthly.find((p) => p.userId === E1.id);
    ok("monthly line for E1: 2 breaks, 40 min, days present 2, permitted 60 min, excess 10, 1 day exceeded, 1 incident", m1.breaks === 2 && m1.seconds === 2400 && m1.daysPresent >= 1 && m1.excessSeconds === 600 && m1.daysExceeded === 1 && m1.incidents === 1, m1);
    ok("E1's monthly violations name the exact date with allowed 30, actual 40 and excess 10 min", JSON.stringify(m1.violations) === JSON.stringify([{ day: today, allowanceSeconds: 1800, actualSeconds: 2400, excessSeconds: 600 }]), m1.violations);
    ok("the weekly line carries the same violation", JSON.stringify(wk.weekly.find((p) => p.userId === E1.id).violations) === JSON.stringify(m1.violations));
    const e3m = wk.monthly.find((p) => p.userId === E3.id);
    ok("a person with no break that day has no violation for it (E1 yesterday is not listed)", !m1.violations.some((v) => v.day === y));

    console.log("\n## Filters work together");
    const f1 = (await get(AD.tok, `from=${y}&to=${today}&company=${A.id}&manager=${MGR.id}&status=EXCEEDED`)).b;
    ok("company A + manager + status Exceeded: only E1's exceeding break(s) (and E2's if over)", f1.breaks.length > 0 && f1.breaks.every((b) => [E1.id, E2.id].includes(b.userId) && b.status === "EXCEEDED"), f1.breaks.map((b) => [b.userId === E1.id ? "E1" : "E2", b.status]));
    const f2 = (await get(AD.tok, `from=${y}&to=${today}&company=${B}`)).b;
    ok("company B: only E3", f2.breaks.length > 0 && f2.breaks.every((b) => b.userId === E3.id));
    const f3 = (await get(AD.tok, `from=${today}&to=${today}&breakType=LUNCH`)).b;
    ok("break type Lunch: only lunch rows", f3.breaks.length > 0 && f3.breaks.every((b) => b.breakType === "LUNCH"));
    const f4 = (await get(AD.tok, `from=${y}&to=${today}&defaulter=no`)).b;
    ok("defaulter = no: none of the defaulters appear", !f4.breaks.some((b) => [E1.id, E2.id, E3.id].includes(b.userId)));
    const f5 = (await get(AD.tok, `from=${today}&to=${today}&q=BKM-E1`)).b;
    ok("search by employee ID: only E1", f5.breaks.length === 2 && f5.breaks.every((b) => b.userId === E1.id));

    console.log("\n## Employee detail and limits");
    const one = (await get(AD.tok, `from=${y}&to=${today}&userId=${E1.id}`)).b;
    ok("employee view: only E1's records, with week and month summaries", one.breaks.every((b) => b.userId === E1.id) && one.weekly.length === 1 && one.monthly.length === 1);
    ok("an id outside the Admin's reach answers 404", (await get(AD.tok, `userId=00000000-0000-4000-8000-000000000000`)).s === 404);
    ok("a range over 93 days is refused (400)", (await get(AD.tok, `from=2026-01-01&to=2026-11-01`)).s === 400);
    ok("a second Admin sees the same records", (await get(AD2.tok, `from=${y}&to=${today}`)).b.breaks.filter((b) => [E1.id, E2.id, E3.id].includes(b.userId)).length === (await get(AD.tok, `from=${y}&to=${today}`)).b.breaks.filter((b) => [E1.id, E2.id, E3.id].includes(b.userId)).length);
    const before = (await q(`select count(*)::int n from tracker_breaks`))[0].n;
    await get(AD.tok, `from=${y}&to=${today}`);
    ok("reading writes nothing", (await q(`select count(*)::int n from tracker_breaks`))[0].n === before);
  } finally { await wipe().catch((e) => console.log("wipe note:", e.message)); await db.end(); }
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
