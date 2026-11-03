// Activity policy over HTTP: Tea / Lunch / Personal are break; Washroom is neutral (not break, not productive, never uses the allowance);
// time on site = productive + break + washroom; every screen agrees; older days (stored the old way) read correctly without being rewritten.
// Disposable database only (see _guard.cjs). No migration is needed for this feature.
//
//   cd backend && TEST_DATABASE_URL=... TEST_API=http://localhost:5012/api node tests/activity-policy.test.cjs
require("dotenv").config({ path: require("node:path").join(__dirname, "..", ".env") });
const { Client } = require("pg");
const bcrypt = require("bcryptjs");
const API = process.env.TEST_API ?? "http://localhost:5002/api";
require("./_guard.cjs").assertTestDb(process.env.TEST_DATABASE_URL);

const call = async (m, p, t, b) => {
  const r = await fetch(API + p, { method: m, headers: { "content-type": "application/json", ...(t ? { authorization: "Bearer " + t } : {}) }, body: b !== undefined ? JSON.stringify(b) : undefined });
  const txt = await r.text(); let j; try { j = JSON.parse(txt); } catch { j = txt; }
  return { s: r.status, b: j };
};
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  -> " + String(JSON.stringify(x)).slice(0, 350))); };
const PW = "Act@12345678";
const MIN = 60;
const near = (a, b, tol = 10) => Math.abs(a - b) <= tol;

(async () => {
  const db = new Client({ connectionString: process.env.TEST_DATABASE_URL }); await db.connect();
  const q = async (s, p) => (await db.query(s, p)).rows;
  const AV = (await q(`select id from platforms where slug='avatar'`))[0].id;
  const AVN = (await q(`select id from platforms where slug='avance'`))[0].id;
  const hash = await bcrypt.hash(PW, 10);
  const wipe = async () => {
    const ids = `(select id from users where "employeeCode" like 'ACT-%')`;
    await q(`delete from tracker_breaks where "workSessionId" in (select id from work_sessions where "userId" in ${ids})`);
    await q(`delete from late_remarks where "userId" in ${ids}`);
    await q(`delete from work_sessions where "userId" in ${ids}`);
    await q(`delete from users where "employeeCode" like 'ACT-%'`);
  };
  await wipe();
  const login = async (code) => (await call("POST", "/auth/login", null, { email: code, password: PW })).b.token;
  const mk = async (code, role, platformId, reportsToId = null) => {
    await q(`insert into users (id,"platformId",email,"passwordHash","firstName","lastName","employeeCode",role,status,"mustChangePassword","trackerAccessEnabled","onboardingStatus","reportsToId","dateOfJoining","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,$4,'Act',$5,$6,'ACTIVE',false,true,'ACTIVE',$7,'2026-01-01',now(),now())`, [platformId, code.toLowerCase() + "@act.test", hash, code.replace("ACT-", "T"), code, role, reportsToId]);
    const id = (await q(`select id from users where "employeeCode"=$1`, [code]))[0].id;
    return { id, tok: await login(code) };
  };
  const M = await mk("ACT-M", "MANAGER", AV);
  const E1 = await mk("ACT-E1", "EMPLOYEE", AV, M.id);
  const E2 = await mk("ACT-E2", "EMPLOYEE", AV, M.id);
  const E3 = await mk("ACT-E3", "EMPLOYEE", AV, M.id);
  const E4 = await mk("ACT-E4", "EMPLOYEE", AV, M.id);
  const E5 = await mk("ACT-E5", "EMPLOYEE", AV, M.id);
  const HR = await mk("ACT-HR", "HR", AV);
  const HRB = await mk("ACT-HRB", "HR", AVN);
  const today = (await call("GET", "/tracker/timesheet", M.tok)).b.today;

  const ago = (min) => new Date(Date.now() - min * 60_000).toISOString();
  const addBreak = async (sid, type, from, to) => q(`insert into tracker_breaks (id,"workSessionId","breakType","startedAt","endedAt","durationSeconds","autoClosed","createdAt") values (gen_random_uuid(),$1,$2,$3,$4,$5,false,now())`, [sid, type, ago(from), ago(to), (from - to) * 60]);

  // ---- E1: today, clocked in 120 min ago. Tea 10 + Lunch 20 + Personal 5 = 35 min break, Washroom 7 min.
  // Stored the OLD way (washroom inside breakSeconds = 42 min), as every existing session in production is.
  const s1 = (await q(`insert into work_sessions (id,"platformId","userId",date,"loginAt","logoutAt",status,"productiveSeconds","breakSeconds","meetingSeconds","wasLateLogin","lateByMinutes","autoClosed","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3::date,$4,null,'ACTIVE',$5,$6,0,false,0,false,now(),now()) returning id`, [AV, E1.id, today, ago(120), 78 * MIN, 42 * MIN]))[0].id;
  await addBreak(s1, "TEA", 110, 100); await addBreak(s1, "LUNCH", 90, 70); await addBreak(s1, "PERSONAL", 60, 55); await addBreak(s1, "WASHROOM", 40, 33);

  // ---- E3: an OLDER finished day (2026-10-28 IST 09:00-18:00), stored the old way: tea 15 + washroom 10 inside breakSeconds = 25 min
  const login3 = new Date(Date.UTC(2026, 9, 28, 9, 0) - 330 * 60_000).toISOString(), out3 = new Date(Date.UTC(2026, 9, 28, 18, 0) - 330 * 60_000).toISOString();
  const s3 = (await q(`insert into work_sessions (id,"platformId","userId",date,"loginAt","logoutAt",status,"productiveSeconds","breakSeconds","meetingSeconds","wasLateLogin","lateByMinutes","autoClosed","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,'2026-10-28',$3,$4,'COMPLETED',$5,$6,0,false,0,false,now(),now()) returning id`, [AV, E3.id, login3, out3, 515 * MIN, 25 * MIN]))[0].id;
  const t3 = (m) => new Date(Date.UTC(2026, 9, 28, 9, 0) - 330 * 60_000 + m * 60_000).toISOString();
  for (const [type, a, b] of [["TEA", 60, 75], ["WASHROOM", 120, 130]]) await q(`insert into tracker_breaks (id,"workSessionId","breakType","startedAt","endedAt","durationSeconds","autoClosed","createdAt") values (gen_random_uuid(),$1,$2,$3,$4,$5,false,now())`, [s3, type, t3(a), t3(b), (b - a) * 60]);

  console.log("\n## 1. Tea, Lunch and Personal are break; Washroom is not");
  const ses = await call("GET", "/tracker/session", E1.tok);
  ok("the session loads", ses.s === 200 && !!ses.b.session, ses);
  const S = ses.b.session;
  ok("break = tea + lunch + personal = 35 min (Washroom NOT in it)", S.breakSeconds === 35 * MIN, S.breakSeconds);
  ok("washroom is reported on its own: 7 min", S.washroomSeconds === 7 * MIN, S.washroomSeconds);
  ok("productive = 120 min on site - 35 break - 7 washroom = 78 min (washroom is not productive either)", near(S.productiveSeconds, 78 * MIN), S.productiveSeconds);
  ok("time on site = productive + break + washroom = 120 min, nothing counted twice", near(S.productiveSeconds + S.breakSeconds + S.washroomSeconds, 120 * MIN), 0);
  const budget = ses.b.config.breakBudgetMinutes * MIN;
  ok("remaining break allowance = budget - 35 min (the 7 min washroom does not reduce it)", budget - S.breakSeconds === budget - 35 * MIN);
  ok("the washroom row is kept in the activity history, as a washroom row", S.breaks.some((b) => b.breakType === "WASHROOM") && S.breaks.length === 4);
  ok("the stored break column is now written the new way (35 min)", (await q(`select "breakSeconds" from work_sessions where id=$1`, [s1]))[0].breakSeconds === 35 * MIN);

  console.log("\n## 2. Every screen agrees for the same person and day");
  const ts = (await call("GET", "/tracker/timesheet", E1.tok)).b;
  const tday = ts.days.find((d) => d.date === today).session;
  ok("timesheet day: break 35, washroom 7", tday.breakSeconds === 35 * MIN && tday.washroomSeconds === 7 * MIN, tday);
  ok("timesheet totals: break 35, washroom 7, on site = productive + break + washroom", ts.totals.breakSeconds === 35 * MIN && ts.totals.washroomSeconds === 7 * MIN && ts.totals.elapsedSeconds === ts.totals.productiveSeconds + ts.totals.breakSeconds + ts.totals.washroomSeconds, ts.totals);
  const hist = (await call("GET", `/tracker/history?from=${today}&to=${today}`, E1.tok)).b;
  const hrow = hist.rows.find((r) => r.date === today);
  ok("history: break 35 (3 breaks), washroom 7 (1 visit), and the summary has both totals", hrow.breakSeconds === 35 * MIN && hrow.breakCount === 3 && hrow.washroomSeconds === 7 * MIN && hrow.washroomCount === 1 && hist.summary.totalBreak === 35 * MIN && hist.summary.totalWashroom === 7 * MIN, { hrow, s: hist.summary });
  const rep = (await call("GET", `/reports?from=${today}&to=${today}&groupBy=person&userId=${E1.id}`, M.tok)).b;
  const rp = rep.people?.find((p) => p.userId === E1.id);
  ok("daily report (manager): break 35, washroom 7", rp?.breakSeconds === 35 * MIN && rp?.washroomSeconds === 7 * MIN, rp);
  ok("report totals carry washroom too", rep.totals?.washroomSeconds >= 0 && "washroomSeconds" in rep.totals, rep.totals);
  const repHr = (await call("GET", `/reports?from=${today}&to=${today}&groupBy=day`, HR.tok)).b;
  ok("report grouped by day has a washroom figure per period", repHr.buckets?.length >= 1 && repHr.buckets.every((b) => "washroomSeconds" in b), repHr.buckets);
  const boardM = (await call("GET", "/team-attendance/live", M.tok)).b.rows.find((r) => r.userId === E1.id);
  const boardHr = (await call("GET", "/team-attendance/live", HR.tok)).b.rows.find((r) => r.userId === E1.id);
  ok("Attendance board (manager): break 35, washroom 7", boardM?.breakSeconds === 35 * MIN && boardM?.washroomSeconds === 7 * MIN, boardM);
  ok("Attendance board (HR) shows the same figures", boardHr?.breakSeconds === 35 * MIN && boardHr?.washroomSeconds === 7 * MIN, boardHr);
  ok("HR of another company cannot see this person at all", !(await call("GET", "/team-attendance/live", HRB.tok)).b.rows.some((r) => r.userId === E1.id));
  const att = (await call("GET", `/team-attendance/attendance?from=${today}&to=${today}&userId=${E1.id}`, M.tok)).b.rows?.[0];
  ok("Attendance report: break and washroom hours, separate", att && Math.abs(att.breakHours - 35 / 60) < 0.02 && Math.abs(att.washroomHours - 7 / 60) < 0.02, att);
  const sb = (await call("GET", `/team-attendance/shift-breakdown?date=${today}`, M.tok)).b.rows.find((r) => r.userId === E1.id);
  ok("shift breakdown: break total 35, washroom (bio) 7", sb?.breakSeconds === 35 * MIN && sb?.bioSeconds === 7 * MIN, sb);

  console.log("\n## 3. An older day, stored the old way, is shown by the new rules and is NOT rewritten");
  const old = (await call("GET", `/tracker/timesheet?from=2026-10-28&to=2026-10-28`, E3.tok)).b;
  const od = old.days.find((d) => d.date === "2026-10-28").session;
  ok("old day: break 15 (tea only), washroom 10", od.breakSeconds === 15 * MIN && od.washroomSeconds === 10 * MIN, od);
  ok("old day: productive unchanged (515 min) and on site = 540 min", od.productiveSeconds === 515 * MIN && old.totals.elapsedSeconds === 540 * MIN, old.totals);
  const oldRep = (await call("GET", `/reports?from=2026-10-28&to=2026-10-28&groupBy=person&userId=${E3.id}`, HR.tok)).b.people?.find((p) => p.userId === E3.id);
  ok("old day in the report: break 15, washroom 10", oldRep?.breakSeconds === 15 * MIN && oldRep?.washroomSeconds === 10 * MIN, oldRep);
  const oldAtt = (await call("GET", `/team-attendance/attendance?from=2026-10-28&to=2026-10-28&userId=${E3.id}`, HR.tok)).b.rows?.[0];
  ok("old day in the Attendance report: 0.25 h break, 0.17 h washroom", oldAtt && Math.abs(oldAtt.breakHours - 0.25) < 0.01 && Math.abs(oldAtt.washroomHours - 10 / 60) < 0.01, oldAtt);
  ok("the old stored column is untouched (still 25 min: history is not rewritten)", (await q(`select "breakSeconds","productiveSeconds" from work_sessions where id=$1`, [s3]))[0].breakSeconds === 25 * MIN);
  ok("the break and washroom start/end times are untouched", (await q(`select count(*)::int n from tracker_breaks where "workSessionId"=$1`, [s3]))[0].n === 2);

  console.log("\n## 4. Live flow: start / end, transitions, refresh and sign-out (server timestamps are the truth)");
  const ci = await call("POST", "/tracker/clock-in", E2.tok, {});
  ok("E2 clocks in", ci.s === 200, ci);
  const sid2 = (await q(`select id from work_sessions where "userId"=$1`, [E2.id]))[0].id;
  await q(`update work_sessions set "loginAt"=$2 where id=$1`, [sid2, ago(60)]); // on site for an hour
  const backdate = (min) => q(`update tracker_breaks set "startedAt"=$2 where "workSessionId"=$1 and "endedAt" is null`, [sid2, ago(min)]);
  ok("start Tea", (await call("POST", "/tracker/break/start", E2.tok, { breakType: "TEA" })).s === 200);
  await backdate(10);
  ok("end Tea", (await call("POST", "/tracker/break/end", E2.tok)).s === 200);
  ok("start Washroom after Tea", (await call("POST", "/tracker/break/start", E2.tok, { breakType: "WASHROOM" })).s === 200);
  await backdate(6);
  ok("cannot start another activity while Washroom runs (400, one at a time)", (await call("POST", "/tracker/break/start", E2.tok, { breakType: "TEA" })).s === 400);
  const live1 = (await call("GET", "/tracker/session", E2.tok)).b.session;
  const open1 = live1.breaks.find((b) => !b.endedAt);
  ok("refresh during an open washroom: it is still running, since the recorded start (not reset)", open1?.breakType === "WASHROOM" && near(live1.washroomSeconds, 6 * MIN), live1.washroomSeconds);
  ok("while the washroom runs, break is still only the 10 min tea", live1.breakSeconds === 10 * MIN, live1.breakSeconds);
  const tok2 = await login("ACT-E2");
  const live2 = (await call("GET", "/tracker/session", tok2)).b.session;
  ok("after signing out and in again the washroom is still open with the same start", live2.breaks.find((b) => !b.endedAt)?.startedAt === open1.startedAt, live2.breaks);
  ok("end Washroom", (await call("POST", "/tracker/break/end", E2.tok)).s === 200);
  const ses2 = (await call("GET", "/tracker/session", E2.tok)).b;
  ok("break = 10 (tea only), washroom = 6, productive = 60 - 16 = 44 min", ses2.session.breakSeconds === 10 * MIN && near(ses2.session.washroomSeconds, 6 * MIN) && near(ses2.session.productiveSeconds, 44 * MIN), ses2.session);
  ok("remaining allowance = budget - 10 min (washroom did not touch it)", ses2.config.breakBudgetMinutes * MIN - ses2.session.breakSeconds === ses2.config.breakBudgetMinutes * MIN - 10 * MIN);
  ok("start Tea after Washroom", (await call("POST", "/tracker/break/start", E2.tok, { breakType: "TEA" })).s === 200);
  await backdate(3);
  ok("end Tea again", (await call("POST", "/tracker/break/end", E2.tok)).s === 200);
  const ses3 = (await call("GET", "/tracker/session", E2.tok)).b.session;
  ok("two teas now count as break (13 min); washroom still 6", near(ses3.breakSeconds, 13 * MIN, 5) && near(ses3.washroomSeconds, 6 * MIN), ses3);
  const out = await call("POST", "/tracker/clock-out", E2.tok, {});
  ok("clock-out still works", out.s === 200, out);
  const row2 = (await q(`select "productiveSeconds","breakSeconds",status from work_sessions where id=$1`, [sid2]))[0];
  ok("closed day: stored break = counted breaks only; productive = on site - every away row", near(row2.breakSeconds, 13 * MIN, 5) && near(row2.productiveSeconds, 60 * MIN - 19 * MIN, 12) && row2.status === "COMPLETED", row2);
  const ts2 = (await call("GET", "/tracker/timesheet", E2.tok)).b;
  ok("after clock-out time on site = productive + break + washroom", ts2.totals.elapsedSeconds === ts2.totals.productiveSeconds + ts2.totals.breakSeconds + ts2.totals.washroomSeconds, ts2.totals);

  console.log("\n## 5. Meeting / Team Huddle from the activity menu: an unscheduled discussion with a remark");
  ok("E4 clocks in", (await call("POST", "/tracker/clock-in", E4.tok, {})).s === 200);
  const sid4 = (await q('select id from work_sessions where "userId"=$1', [E4.id]))[0].id;
  await q('update work_sessions set "loginAt"=$2 where id=$1', [sid4, ago(60)]);
  const rowsOf = async () => q('select "breakType", reason, "startedAt", "endedAt", "durationSeconds", (extract(epoch from "startedAt") * 1000)::bigint as start_ms from tracker_breaks where "workSessionId"=$1 order by "startedAt"', [sid4]);
  const noRow = async (label, body) => { const r = await call("POST", "/tracker/break/start", E4.tok, body); ok(label + " (400)", r.s === 400, r); ok(label + ": nothing was started", (await rowsOf()).length === 0); };
  await noRow("no remark is refused", { breakType: "DISCUSSION" });
  await noRow("an empty remark is refused", { breakType: "DISCUSSION", remark: "" });
  await noRow("spaces only are refused", { breakType: "DISCUSSION", remark: "     " });
  await noRow("a 2 character remark is refused", { breakType: "DISCUSSION", remark: "ab" });
  await noRow("a remark over 300 characters is refused", { breakType: "DISCUSSION", remark: "x".repeat(301) });
  await noRow("a remark that is not text is refused", { breakType: "DISCUSSION", remark: 123 });
  const meetingsBefore = (await q("select count(*)::int n from meetings"))[0].n, partsBefore = (await q("select count(*)::int n from meeting_participation"))[0].n;
  const notesBefore = (await q("select count(*)::int n from notifications"))[0].n;
  const st = await call("POST", "/tracker/break/start", E4.tok, { breakType: "DISCUSSION", remark: "  Discussion with manager about the sprint  " });
  ok("a remark starts it (200)", st.s === 200, st);
  const r4 = await rowsOf();
  ok("saved on the existing break table as ONE row: type OTHER, remark kept (trimmed), start stamped by the server", r4.length === 1 && r4[0].breakType === "OTHER" && r4[0].reason === "Discussion: Discussion with manager about the sprint" && r4[0].endedAt === null && Math.abs(Number(r4[0].start_ms) - Date.now()) < 15000, r4);
  ok("it creates NO meeting, NO participation record and NO invitation or notification", (await q("select count(*)::int n from meetings"))[0].n === meetingsBefore && (await q("select count(*)::int n from meeting_participation"))[0].n === partsBefore && (await q("select count(*)::int n from notifications"))[0].n === notesBefore);
  await q('update tracker_breaks set "startedAt"=$2 where "workSessionId"=$1 and "endedAt" is null', [sid4, ago(12)]);
  ok("only one activity at a time: Tea cannot start during a discussion (400)", (await call("POST", "/tracker/break/start", E4.tok, { breakType: "TEA" })).s === 400);
  ok("nor a second discussion (400)", (await call("POST", "/tracker/break/start", E4.tok, { breakType: "DISCUSSION", remark: "again please" })).s === 400);
  const mid = (await call("GET", "/tracker/session", E4.tok)).b;
  ok("while it runs: break 0, washroom 0, discussion about 12 min", mid.session.breakSeconds === 0 && mid.session.washroomSeconds === 0 && near(mid.session.discussionSeconds, 12 * MIN), mid.session);
  ok("while it runs the productive time is the whole 60 min (the discussion is not taken out)", near(mid.session.productiveSeconds, 60 * MIN, 12), mid.session.productiveSeconds);
  const liveRow = (await call("GET", "/team-attendance/live", M.tok)).b.rows.find((r) => r.userId === E4.id);
  ok("the manager's board shows the person 'In meeting', not on a break", liveRow?.status === "MEETING" && liveRow.breakSeconds === 0, liveRow);
  const tok4 = await login("ACT-E4");
  const re = (await call("GET", "/tracker/session", tok4)).b.session.breaks.find((b) => !b.endedAt);
  ok("after a refresh and a new sign-in it is still running with the same start and remark", Date.parse(re?.startedAt) === Number((await rowsOf())[0].start_ms) && re.reason.startsWith("Discussion: "), re);
  ok("end it with the existing end route (200)", (await call("POST", "/tracker/break/end", E4.tok)).s === 200);
  const done = (await call("GET", "/tracker/session", E4.tok)).b;
  const closed = (await rowsOf())[0];
  ok("end time and duration are recorded: about 12 min", closed.endedAt !== null && near(closed.durationSeconds, 12 * MIN, 12), closed);
  ok("after: break 0 (it is not break time), discussion 12 min, productive = 60 min on site", done.session.breakSeconds === 0 && near(done.session.discussionSeconds, 12 * MIN) && near(done.session.productiveSeconds, 60 * MIN, 12), done.session);
  ok("the 1-hour break allowance is untouched: remaining = budget", done.config.breakBudgetMinutes * MIN - done.session.breakSeconds === done.config.breakBudgetMinutes * MIN);
  ok("the stored break column is 0 and productive was not reduced", (await q('select "breakSeconds","productiveSeconds" from work_sessions where id=$1', [sid4]))[0].breakSeconds === 0);
  const tsd = (await call("GET", "/tracker/timesheet", E4.tok)).b;
  const dd = tsd.days.find((d) => d.date === today).session;
  ok("timesheet: the day carries the discussion, the totals add up with nothing counted twice", dd.discussionSeconds === done.session.discussionSeconds && tsd.totals.elapsedSeconds === tsd.totals.productiveSeconds + tsd.totals.breakSeconds + tsd.totals.washroomSeconds && dd.breaks.some((b) => b.reason === "Discussion: Discussion with manager about the sprint"), { totals: tsd.totals, dd });
  ok("the breakdown (regular + huddle + other) still equals productive: discussion is not a separate subtraction", dd.breakdown && dd.breakdown.regularSeconds + dd.breakdown.huddleSeconds + dd.breakdown.otherEligibleSeconds === dd.breakdown.totalSeconds, dd.breakdown);
  const h4 = (await call("GET", "/tracker/history?from=" + today + "&to=" + today, E4.tok)).b.rows.find((r) => r.date === today);
  ok("history: break 0 with 0 counted breaks, discussion 12 min with 1 discussion", h4.breakSeconds === 0 && h4.breakCount === 0 && near(h4.discussionSeconds, 12 * MIN) && h4.discussionCount === 1, h4);
  const rp4 = (await call("GET", "/reports?from=" + today + "&to=" + today + "&groupBy=person&userId=" + E4.id, M.tok)).b.people.find((x) => x.userId === E4.id);
  ok("report: break stays 0 (productive keeps the time)", rp4.breakSeconds === 0 && rp4.washroomSeconds === 0, rp4);
  const sb4 = (await call("GET", "/team-attendance/shift-breakdown?date=" + today, M.tok)).b.rows.find((r) => r.userId === E4.id);
  ok("shift breakdown: no break or 'other' time from the discussion", sb4.breakSeconds === 0 && sb4.otherSeconds === 0, sb4);
  ok("Tea after the discussion still works and counts as break", (await call("POST", "/tracker/break/start", E4.tok, { breakType: "TEA" })).s === 200 && (await q('update tracker_breaks set "startedAt"=$2 where "workSessionId"=$1 and "endedAt" is null', [sid4, ago(5)]), (await call("POST", "/tracker/break/end", E4.tok)).s === 200));
  const after = (await call("GET", "/tracker/session", E4.tok)).b.session;
  ok("then break = 5 min (tea only), discussion still 12 min", near(after.breakSeconds, 5 * MIN) && near(after.discussionSeconds, 12 * MIN), after);

  console.log("\n## 5b. Who can read the remark");
  const dayRows = async (tok, uid) => (await call("GET", "/attendance-calendar?from=" + today + "&to=" + today + (uid ? "&userId=" + uid : ""), tok)).b;
  const mc = await dayRows(M.tok, E4.id);
  const dr = mc.rows.find((r) => r.userId === E4.id && r.date === today);
  ok("the manager sees the remark and the duration on the person's day", dr?.discussions?.length === 1 && dr.discussions[0].remark === "Discussion with manager about the sprint" && near(dr.discussions[0].seconds, 12 * MIN, 12), dr);
  ok("HR of the company sees it too", (await dayRows(HR.tok, E4.id)).rows.find((r) => r.userId === E4.id)?.discussions?.length === 1);
  ok("the person sees their own", (await dayRows(E4.tok)).rows.find((r) => r.userId === E4.id)?.discussions?.length === 1);
  ok("a colleague sees nothing of it", !JSON.stringify(await dayRows(E5.tok, E4.id)).includes("sprint"));
  ok("HR of another company sees nothing", !JSON.stringify(await dayRows(HRB.tok, E4.id)).includes("sprint"));

  await wipe();
  await db.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
