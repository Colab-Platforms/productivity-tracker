// Early Logout Policy (2nd and 4th Saturday) over HTTP against a DISPOSABLE database only (see _guard.cjs).
// It proves the "before the migration" behaviour (policy off, nothing breaks), applies the migration SQL itself, then checks the rules,
// the attendance calendar, the attendance report, Reports targets, permissions, audit and that history is never rewritten.
//
//   cd backend && TEST_DATABASE_URL=... TEST_API=http://localhost:5012/api node tests/early-logout.test.cjs
//   (the backend under test must run against the same disposable database; drop table early_logout_policy first to re-run)
const fs = require("node:fs");
const path = require("node:path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const { Client } = require("pg");
const bcrypt = require("bcryptjs");
const API = process.env.TEST_API ?? "http://localhost:5012/api";
require("./_guard.cjs").assertTestDb(process.env.TEST_DATABASE_URL);

const call = async (m, p, t, body) => {
  const r = await fetch(API + p, { method: m, headers: { "content-type": "application/json", ...(t ? { authorization: "Bearer " + t } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const txt = await r.text(); let j; try { j = JSON.parse(txt); } catch { j = txt; }
  return { s: r.status, b: j };
};
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  -> " + String(JSON.stringify(x)).slice(0, 600))); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PW = "Elt@12345678";

(async () => {
  const db = new Client({ connectionString: process.env.TEST_DATABASE_URL }); await db.connect();
  const q = async (s, p) => (await db.query(s, p)).rows;
  const AV = (await q(`select id from platforms where slug='avatar'`))[0].id;
  const AVN = (await q(`select id from platforms where slug='avance'`))[0].id;
  const hash = await bcrypt.hash(PW, 10);

  const wipe = async () => {
    const ids = `(select id from users where "employeeCode" like 'ELT-%')`;
    await q(`delete from tracker_breaks where "workSessionId" in (select id from work_sessions where "userId" in ${ids})`);
    await q(`delete from work_sessions where "userId" in ${ids}`);
    await q(`update users set "shiftId" = null where "employeeCode" like 'ELT-%'`);
    await q(`delete from shifts where name like 'ELT-%'`);
    await q(`delete from users where "employeeCode" like 'ELT-%'`);
  };
  await wipe();
  const shiftId = (await q(`insert into shifts (id,"platformId",name,"startTime","endTime","spansMidnight","workingDays","isDefault","isActive","createdAt","updatedAt") values (gen_random_uuid(),$1,'ELT-General','10:00','19:00',false,'{1,2,3,4,5,6}',false,true,now(),now()) returning id`, [AV]))[0].id;
  const shiftIdN = (await q(`insert into shifts (id,"platformId",name,"startTime","endTime","spansMidnight","workingDays","isDefault","isActive","createdAt","updatedAt") values (gen_random_uuid(),$1,'ELT-General','10:00','19:00',false,'{1,2,3,4,5,6}',false,true,now(),now()) returning id`, [AVN]))[0].id;

  const mk = async (code, role, platformId, { boss = null, shift = null } = {}) => {
    await q(`insert into users (id,"platformId",email,"passwordHash","firstName","lastName","employeeCode",role,status,"mustChangePassword","trackerAccessEnabled","onboardingStatus","dateOfJoining","reportsToId","shiftId","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,$4,'Elt',$5,$6,'ACTIVE',false,true,'ACTIVE','2026-01-01',$7,$8,now(),now())`, [platformId, code.toLowerCase() + "@elt.test", hash, code.replace("ELT-", "T"), code, role, boss, shift]);
    const id = (await q(`select id from users where "employeeCode"=$1`, [code]))[0].id;
    const tok = (await (await fetch(API + "/auth/login", { method: "POST", headers: { "content-type": "application/json", }, body: JSON.stringify({ email: code, password: PW }) })).json()).token;
    return { id, tok, code };
  };
  const ADM = await mk("ELT-ADM", "ADMIN", AV);
  const HR = await mk("ELT-HR", "HR", AV);
  const MGR = await mk("ELT-MGR", "MANAGER", AV, { boss: ADM.id });
  const E = {
    exact: await mk("ELT-EXACT", "EMPLOYEE", AV, { boss: MGR.id, shift: shiftId }), // logs out exactly 16:00
    before: await mk("ELT-BEFORE", "EMPLOYEE", AV, { boss: MGR.id, shift: shiftId }), // 15:59
    after: await mk("ELT-AFTER", "EMPLOYEE", AV, { boss: MGR.id, shift: shiftId }), // 18:00
    third: await mk("ELT-THIRD", "EMPLOYEE", AV, { boss: MGR.id, shift: shiftId }), // 16:00 on a 3rd Saturday (not a policy day)
    other: await mk("ELT-OTHER", "EMPLOYEE", AVN, { shift: shiftIdN }), // another company, logs out 16:00
    late: await mk("ELT-LATE", "EMPLOYEE", AV, { boss: MGR.id, shift: shiftId }), // arrives 12:55, logs out 18:50
    noshift: await mk("ELT-NOSHIFT", "EMPLOYEE", AVN), // no shift at all
  };

  const SAT2_OLD = "2026-10-10"; // 2nd Saturday, BEFORE the policy start date
  const SAT3 = "2026-10-17"; // 3rd Saturday
  const FRI = "2026-10-23"; // an ordinary Friday
  const SAT4 = "2026-10-24"; // 4th Saturday, the policy start date
  const SAT5 = "2026-10-31"; // 5th Saturday
  const SAT2 = "2026-11-14"; // 2nd Saturday of November (already past)
  const ist = (day, hhmm) => { const [y, mo, d] = day.split("-").map(Number); const [h, m] = hhmm.split(":").map(Number); return new Date(Date.UTC(y, mo - 1, d, h, m) - 330 * 60_000).toISOString(); };
  const session = (u, day, inAt, outAt, productive, platformId = AV) =>
    q(`insert into work_sessions (id,"platformId","userId",date,"loginAt","logoutAt",status,"productiveSeconds","breakSeconds","meetingSeconds","wasLateLogin","lateByMinutes","autoClosed","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3::date,$4,$5,'COMPLETED',$6,0,0,false,0,false,now(),now())`, [platformId, u.id, day, ist(day, inAt), ist(day, outAt), productive]);
  const H = 3600;
  for (const d of [SAT4, SAT2]) {
    await session(E.exact, d, "10:00", "16:00", 5.5 * H);
    await session(E.before, d, "10:00", "15:59", 5.5 * H);
    await session(E.after, d, "10:00", "18:00", 7 * H);
    await session(E.other, d, "10:00", "16:00", 5.5 * H, AVN);
  }
  await session(E.late, SAT2, "12:55", "18:50", 5.9 * H); // very late arrival, stays until after 16:00
  await session(E.noshift, SAT4, "10:00", "16:00", 5.5 * H, AVN);
  await session(E.exact, SAT2_OLD, "10:00", "16:00", 5.5 * H); // history: before the start date
  await session(E.third, SAT3, "10:00", "16:00", 5.5 * H);
  await session(E.exact, FRI, "10:00", "16:00", 5.5 * H); // an ordinary day, same hours
  await session(E.after, SAT5, "10:00", "16:00", 5.5 * H); // 5th Saturday

  const snapshot = async () => JSON.stringify(await q(`select id,"loginAt","logoutAt","productiveSeconds","breakSeconds","meetingSeconds","wasLateLogin","lateByMinutes",status,"updatedAt" from work_sessions where "userId" in (select id from users where "employeeCode" like 'ELT-%') order by id`));
  const before = await snapshot();
  const startedAt = new Date(Date.now() - 5000).toISOString();

  const cal = (t, from, to, extra = "") => call("GET", `/attendance-calendar?from=${from}&to=${to}${extra}`, t);
  const rep = (t, from, to, extra = "") => call("GET", `/team-attendance/attendance?from=${from}&to=${to}${extra}`, t);
  const row = (res, u, d) => res.b.rows?.find((r) => (r.userId === u.id) && r.date === d);

  console.log("\n## 0. Before the migration: the policy is off and nothing breaks");
  let g = await call("GET", "/admin/early-logout-policy", ADM.tok);
  ok("GET policy answers, says not ready and off", g.s === 200 && g.b.ready === false && g.b.enabled === false, g);
  let p = await call("PUT", "/admin/early-logout-policy", ADM.tok, { enabled: true, logoutTime: "16:00", startDate: SAT4 });
  ok("saving before the migration answers 503, not 500", p.s === 503, p);
  let a = await rep(ADM.tok, SAT4, SAT4);
  ok("the attendance report still loads", a.s === 200 && a.b.rows.length >= 3, a.s);
  ok("a 4 PM logout on the 4th Saturday is a Half day exactly as before (policy off)", row(a, E.exact, SAT4)?.status === "HALF_DAY", row(a, E.exact, SAT4));
  ok("no early-logout marking and early departure is against the normal 19:00 end", row(a, E.exact, SAT4)?.earlyLogoutDay === false && row(a, E.exact, SAT4)?.earlyDepartureMinutes === 180 && row(a, E.exact, SAT4)?.shiftEnd === "19:00", row(a, E.exact, SAT4));
  let c0 = await cal(ADM.tok, SAT4, SAT4);
  ok("the calendar loads and lists no early-logout dates", c0.s === 200 && c0.b.earlyLogout?.enabled === false && c0.b.earlyLogout.dates.length === 0, c0.b.earlyLogout);

  console.log("\n## 1. Apply the migration (new table only) and check the defaults");
  const sql = fs.readFileSync(path.join(__dirname, "..", "prisma", "migrations", "20261118100000_early_logout_policy", "migration.sql"), "utf8");
  const existed = (await q(`select to_regclass('early_logout_policy') t`))[0].t;
  if (existed) throw new Error("early_logout_policy already exists: drop it and restart the backend before re-running this test");
  await db.query(sql);
  console.log("   (waiting 32 s for the backend to re-check the new table)");
  await sleep(32000);
  g = await call("GET", "/admin/early-logout-policy", ADM.tok);
  ok("after the migration: ready, still OFF, label and fixed Saturdays shown", g.s === 200 && g.b.ready === true && g.b.enabled === false && g.b.logoutTime === "16:00" && JSON.stringify(g.b.saturdays) === "[2,4]" && g.b.label === "Early Logout – 4:00 PM", g.b);
  a = await rep(ADM.tok, SAT4, SAT4);
  ok("applying the table changes nothing by itself: still Half day", row(a, E.exact, SAT4)?.status === "HALF_DAY", row(a, E.exact, SAT4));
  ok("HR can read the setting", (await call("GET", "/admin/early-logout-policy", HR.tok)).s === 200);

  console.log("\n## 2. Who may change it, and what is refused");
  ok("HR cannot change it (403)", (await call("PUT", "/admin/early-logout-policy", HR.tok, { enabled: true, logoutTime: "16:00", startDate: SAT4 })).s === 403);
  ok("a Manager cannot (403)", (await call("PUT", "/admin/early-logout-policy", MGR.tok, { enabled: true, logoutTime: "16:00", startDate: SAT4 })).s === 403);
  ok("an Employee cannot (403)", (await call("PUT", "/admin/early-logout-policy", E.exact.tok, { enabled: true, logoutTime: "16:00", startDate: SAT4 })).s === 403);
  ok("an Employee cannot even read the admin setting (403)", (await call("GET", "/admin/early-logout-policy", E.exact.tok)).s === 403);
  ok("nothing was saved by the refused calls", (await q(`select count(*)::int n from early_logout_policy`))[0].n === 0);
  const bad = async (body) => (await call("PUT", "/admin/early-logout-policy", ADM.tok, body)).s;
  ok("a time outside 12:00-18:59 is refused (400)", (await bad({ enabled: true, logoutTime: "08:00", startDate: SAT4 })) === 400 && (await bad({ enabled: true, logoutTime: "23:00", startDate: SAT4 })) === 400);
  let allBad = true;
  for (const v of [0.5, 13, "abc", 5.1]) if ((await bad({ enabled: true, logoutTime: "16:00", startDate: SAT4, targetHours: v })) !== 400) allBad = false;
  ok("expected hours outside 1-12, not in quarter hours, or not a number are refused (400)", allBad);
  ok("a bad switch, a bad date, and 'on without a start date' are refused (400)", (await bad({ enabled: "yes", logoutTime: "16:00", startDate: SAT4 })) === 400 && (await bad({ enabled: true, logoutTime: "16:00", startDate: "24/10/2026" })) === 400 && (await bad({ enabled: true, logoutTime: "16:00" })) === 400);

  console.log("\n## 3. Switch it on (Admin) from the 4th Saturday of October");
  p = await call("PUT", "/admin/early-logout-policy", ADM.tok, { enabled: true, logoutTime: "16:00", startDate: SAT4 });
  ok("Admin saves it", p.s === 200 && p.b.enabled === true && p.b.startDate === SAT4 && p.b.logoutTime === "16:00", p);
  await sleep(1500); // the audit row is written just after the response
  const logRow = (await q(`select summary, module, "actorId" from audit_logs where path = '/api/admin/early-logout-policy' and "createdAt" > $1 order by "createdAt" desc limit 1`, [startedAt]))[0];
  ok("the change is in the audit log with who did it", !!logRow && /early logout/i.test(logRow.summary) && logRow.actorId === ADM.id, logRow);

  console.log("\n## 4. Attendance report: 4 PM, before 4 PM, after 4 PM");
  a = await rep(ADM.tok, SAT4, SAT4);
  const ex = row(a, E.exact, SAT4), be = row(a, E.before, SAT4), af = row(a, E.after, SAT4), ot = row(a, E.other, SAT4);
  ok("exactly 4:00 PM on the 4th Saturday = Present", ex?.status === "PRESENT", ex);
  ok("no early-departure flag, scheduled end is 16:00, labelled Early Logout - 4:00 PM", ex?.earlyDepartureMinutes === 0 && ex?.shiftEnd === "16:00" && ex?.earlyLogoutDay === true && ex?.earlyLogoutLabel === "Early Logout – 4:00 PM", ex);
  ok("the actual login and logout are kept exactly as recorded", ex?.loginAt === ist(SAT4, "10:00") && ex?.logoutAt === ist(SAT4, "16:00"), ex);
  ok("working and productive hours are the recorded ones (5.5 h), not rewritten", ex?.workedHours === 5.5 && ex?.productiveHours === 5.5, ex);
  ok("the day's note explains why a short day counts as full", /Early Logout/.test(ex?.note ?? "") && /full day/.test(ex?.note ?? ""), ex?.note);
  ok("no late-arrival or half-day mark was made up", ex?.lateMinutes === 0 && ex?.status !== "HALF_DAY", ex);
  ok("BEFORE 4 PM (15:59) falls back to the normal hours rule: Half day", be?.status === "HALF_DAY", be);
  ok("...and is flagged 1 minute early against 16:00", be?.earlyDepartureMinutes === 1, be);
  ok("AFTER 4 PM (18:00) = Present, not early", af?.status === "PRESENT" && af?.earlyDepartureMinutes === 0, af);
  const otCal = await call('GET', `/attendance-calendar?from=${SAT4}&to=${SAT4}`, E.other.tok);
  ok("the policy is organisation-wide: another company's 4 PM logout is Present too", otCal.b.rows?.[0]?.payrollStatus === 'Present' && otCal.b.rows[0].earlyLogoutDay === true, otCal.b.rows?.[0]);
  const c1 = await cal(ADM.tok, SAT4, SAT4);
  ok("payroll's own label for the day follows the engine: Present", row(c1, E.exact, SAT4)?.payrollStatus === "Present" && row(c1, E.before, SAT4)?.payrollStatus === "Half day", [row(c1, E.exact, SAT4)?.payrollStatus, row(c1, E.before, SAT4)?.payrollStatus]);

  console.log("\n## 5. Days the policy must NOT touch");
  a = await rep(ADM.tok, SAT2_OLD, SAT2_OLD);
  ok("history: a 4 PM logout on a 2nd Saturday BEFORE the start date stays a Half day and is not marked", row(a, E.exact, SAT2_OLD)?.status === "HALF_DAY" && row(a, E.exact, SAT2_OLD)?.earlyLogoutDay === false && row(a, E.exact, SAT2_OLD)?.earlyDepartureMinutes === 180, row(a, E.exact, SAT2_OLD));
  a = await rep(ADM.tok, SAT3, SAT3);
  ok("a 3rd Saturday is a normal day: 4 PM is a Half day, early by 3 h", row(a, E.third, SAT3)?.status === "HALF_DAY" && row(a, E.third, SAT3)?.earlyLogoutDay === false && row(a, E.third, SAT3)?.earlyDepartureMinutes === 180, row(a, E.third, SAT3));
  a = await rep(ADM.tok, SAT5, SAT5);
  ok("a 5th Saturday is a normal day too", row(a, E.after, SAT5)?.status === "HALF_DAY" && row(a, E.after, SAT5)?.earlyLogoutDay === false, row(a, E.after, SAT5));
  a = await rep(ADM.tok, FRI, FRI);
  ok("an ordinary Friday is unchanged: Half day, early by 3 h, 19:00 end", row(a, E.exact, FRI)?.status === "HALF_DAY" && row(a, E.exact, FRI)?.earlyDepartureMinutes === 180 && row(a, E.exact, FRI)?.shiftEnd === "19:00", row(a, E.exact, FRI));
  const noRowSat = await rep(ADM.tok, "2026-10-24", "2026-10-24", `&userId=${E.third.id}`);
  ok("the person who did not work that Saturday is not turned Present by the policy", !row(noRowSat, E.third, SAT4) || row(noRowSat, E.third, SAT4).status !== "PRESENT", row(noRowSat, E.third, SAT4));

  console.log("\n## 6. November's 2nd Saturday (a different month)");
  a = await rep(ADM.tok, SAT2, SAT2);
  ok("14 Nov 2026 (2nd Saturday): 4 PM = Present, label shown", row(a, E.exact, SAT2)?.status === "PRESENT" && row(a, E.exact, SAT2)?.earlyLogoutDay === true, row(a, E.exact, SAT2));

  console.log("\n## 7. The calendar labels the dates, even future ones, and is not a week-off");
  const cNov = await cal(ADM.tok, "2026-11-01", "2026-11-30");
  ok("the calendar lists exactly the 2nd and 4th Saturday of November (14 and 28)", JSON.stringify(cNov.b.earlyLogout?.dates) === JSON.stringify(["2026-11-14", "2026-11-28"]), cNov.b.earlyLogout);
  ok("label text is 'Early Logout – 4:00 PM'", cNov.b.earlyLogout?.label === "Early Logout – 4:00 PM");
  const cOct = await cal(ADM.tok, "2026-10-01", "2026-10-31");
  ok("October lists only the 4th Saturday (24th); the 2nd (10th) is before the start date", JSON.stringify(cOct.b.earlyLogout?.dates) === JSON.stringify(["2026-10-24"]), cOct.b.earlyLogout);
  ok("the calendar day record carries the label, and the status is not Week-off", row(cOct, E.exact, SAT4)?.earlyLogoutDay === true && row(cOct, E.exact, SAT4)?.status !== "WEEK_OFF", row(cOct, E.exact, SAT4));
  const cDec = await cal(ADM.tok, "2026-12-01", "2026-12-31");
  ok("December 2026: 12th and 26th", JSON.stringify(cDec.b.earlyLogout?.dates) === JSON.stringify(["2026-12-12", "2026-12-26"]), cDec.b.earlyLogout);
  const cFeb = await cal(ADM.tok, "2027-02-01", "2027-02-28");
  ok("February 2027: 13th and 27th", JSON.stringify(cFeb.b.earlyLogout?.dates) === JSON.stringify(["2027-02-13", "2027-02-27"]), cFeb.b.earlyLogout);

  console.log("\n## 8. Holiday and week-off still win");
  await q(`insert into holidays (id,"platformId",date,name,"dayType","createdAt") values (gen_random_uuid(),$1,$2::date,'ELT-Holiday','PUBLIC_HOLIDAY',now())`, [AV, SAT2]);
  a = await rep(ADM.tok, SAT2, SAT2);
  ok("a company holiday on a policy Saturday is a Holiday, not an early-logout day", row(a, E.exact, SAT2)?.status === "HOLIDAY" && row(a, E.exact, SAT2)?.earlyLogoutDay === false, row(a, E.exact, SAT2));
  await q(`delete from holidays where name='ELT-Holiday'`);
  await q(`update shifts set "workingDays"='{1,2,3,4,5}' where id=$1`, [shiftId]);
  a = await rep(ADM.tok, SAT2, SAT2);
  ok("a shift whose week-off is Saturday: Week-off, not an early-logout day", row(a, E.exact, SAT2)?.status === "WEEK_OFF" && row(a, E.exact, SAT2)?.earlyLogoutDay === false, row(a, E.exact, SAT2));
  await q(`update shifts set "workingDays"='{1,2,3,4,5,6}' where id=$1`, [shiftId]);

  console.log("\n## 9. Reports: the expected hours follow the shorter day");
  const rp = async (t, from, to, extra = "") => call("GET", `/reports?from=${from}&to=${to}${extra}`, t);
  const personOf = (res, u) => (res.b.people ?? res.b.rows ?? []).find((x) => x.userId === u.id);
  const r4 = await rp(ADM.tok, SAT4, SAT4);
  ok("Reports loads", r4.s === 200, r4.s);
  const t4 = personOf(r4, E.exact)?.targetSeconds;
  ok("target on a policy Saturday = 8 h x 6/9 (shift 10:00-19:00 shortened to 16:00) = 5 h 20 min", t4 === 19200, t4);
  const r3 = await rp(ADM.tok, SAT3, SAT3);
  ok("target on an ordinary Saturday is unchanged: 8 h", personOf(r3, E.third)?.targetSeconds === 28800, personOf(r3, E.third)?.targetSeconds);
  const rOld = await rp(ADM.tok, SAT2_OLD, SAT2_OLD);
  ok("target on a Saturday before the start date is unchanged: 8 h (history)", personOf(rOld, E.exact)?.targetSeconds === 28800, personOf(rOld, E.exact)?.targetSeconds);
  ok("the person's productive time is the recorded 5.5 h (nothing recalculated)", personOf(r4, E.exact)?.productiveSeconds === 19800, personOf(r4, E.exact)?.productiveSeconds);


  a = await rep(ADM.tok, SAT2, SAT2);
  ok("rule as chosen: someone who arrived at 12:55 but stayed until 18:50 is Present on that Saturday (no arrival guard)", row(a, E.late, SAT2)?.status === "PRESENT" && row(a, E.late, SAT2)?.loginAt === ist(SAT2, "12:55"), row(a, E.late, SAT2));

  console.log("\n## 9b. Expected hours set in the policy (works with no shift)");
  const hasDefaultAVN = (await q(`select count(*)::int n from shifts where "platformId"=$1 and "isDefault"`, [AVN]))[0].n > 0;
  const nsOwn = async () => {
    const x = await call("GET", `/reports?from=${SAT4}&to=${SAT4}`, E.noshift.tok);
    return (x.b.people ?? x.b.rows ?? []).find((y) => y.userId === E.noshift.id)?.targetSeconds;
  };
  ok("before a figure is set, a person with no shift keeps the normal 8 h (nothing is guessed)" + (hasDefaultAVN ? " [skipped: this company has a default shift]" : ""), hasDefaultAVN || (await nsOwn()) === 28800, await nsOwn());
  p = await call("PUT", "/admin/early-logout-policy", ADM.tok, { enabled: true, logoutTime: "16:00", startDate: SAT4, targetHours: 5.25 });
  ok("Admin saves 5.25 expected hours; it is shown back", p.s === 200 && p.b.targetHours === 5.25, p);
  const r4b = await rp(ADM.tok, SAT4, SAT4);
  ok("the target on a policy Saturday is now 5 h 15 min for the shifted person", personOf(r4b, E.exact)?.targetSeconds === 18900, personOf(r4b, E.exact)?.targetSeconds);
  ok("...and for the person with NO shift too (their own report)", (await nsOwn()) === 18900, await nsOwn());
  ok("an ordinary Saturday and a Saturday before the start date keep the normal 8 h", personOf(await rp(ADM.tok, SAT3, SAT3), E.third)?.targetSeconds === 28800 && personOf(await rp(ADM.tok, SAT2_OLD, SAT2_OLD), E.exact)?.targetSeconds === 28800);
  const aStat = await rep(ADM.tok, SAT4, SAT4);
  ok("the figure never changes who is Present", row(aStat, E.before, SAT4)?.status === "HALF_DAY" && row(aStat, E.exact, SAT4)?.status === "PRESENT");
  await sleep(1500);
  const lg = (await q(`select after from audit_logs where path = '/api/admin/early-logout-policy' and "createdAt" > $1 order by "createdAt" desc limit 1`, [startedAt]))[0];
  ok("the audit line records the expected hours", JSON.stringify(lg?.after ?? {}).includes("5.25"), lg);
  p = await call("PUT", "/admin/early-logout-policy", ADM.tok, { enabled: true, logoutTime: "16:00", startDate: SAT4, targetHours: null });
  ok("clearing the figure goes back to scaling by shift", p.s === 200 && p.b.targetHours === null && personOf(await rp(ADM.tok, SAT4, SAT4), E.exact)?.targetSeconds === 19200);

  console.log("\n## 10. Manager dashboard, HR and the employee's own view");
  const m = await rep(MGR.tok, SAT4, SAT4);
  ok("a Manager's report shows the same Present and label for their own people", m.s === 200 && row(m, E.exact, SAT4)?.status === "PRESENT" && row(m, E.exact, SAT4)?.earlyLogoutLabel === "Early Logout – 4:00 PM" && !row(m, E.other, SAT4), m.s);
  const h = await rep(HR.tok, SAT4, SAT4);
  ok("HR sees the same", h.s === 200 && row(h, E.exact, SAT4)?.status === "PRESENT", h.s);
  const own = await call("GET", `/attendance-calendar?from=${SAT4}&to=${SAT4}`, E.exact.tok);
  ok("the employee's own calendar shows the label on that day", own.s === 200 && own.b.earlyLogout?.dates.includes(SAT4) && own.b.rows[0]?.earlyLogoutDay === true, own.b);
  const own2 = await call("GET", `/attendance-calendar?from=${SAT4}&to=${SAT4}`, E.before.tok);
  ok("the employee who left at 15:59 sees Half day in the payroll label (not hidden)", own2.b.rows[0]?.payrollStatus === "Half day", own2.b.rows?.[0]);

  console.log("\n## 11. Switch it off again, and history was never rewritten");
  p = await call("PUT", "/admin/early-logout-policy", ADM.tok, { enabled: false, logoutTime: "16:00", startDate: SAT4 });
  ok("Admin switches it off", p.s === 200 && p.b.enabled === false, p);
  a = await rep(ADM.tok, SAT4, SAT4);
  ok("off = the old behaviour returns: 4 PM is a Half day again, no label", row(a, E.exact, SAT4)?.status === "HALF_DAY" && row(a, E.exact, SAT4)?.earlyLogoutDay === false, row(a, E.exact, SAT4));
  const cOff = await cal(ADM.tok, "2026-11-01", "2026-11-30");
  ok("off = the calendar lists no early-logout dates", cOff.b.earlyLogout?.dates.length === 0, cOff.b.earlyLogout);
  ok("no work session was changed by any of this (login, logout, hours, updatedAt all identical)", (await snapshot()) === before);
  ok("the audit log has both changes", (await q(`select count(*)::int n from audit_logs where path='/api/admin/early-logout-policy' and status < 400 and "createdAt" > $1`, [startedAt]))[0].n >= 2);

  await wipe();
  await db.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
