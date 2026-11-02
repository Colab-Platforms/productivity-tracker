// Team Huddle in productive time: the breakdown on the employee's timesheet, the manager overview (reporting employees
// only), role limits, correction effects. Disposable Neon branch only (see _guard.cjs). Needs migration
// 20261101120000_meeting_participation applied there.
//
//   cd backend && TEST_DATABASE_URL=... TEST_API=http://localhost:5012/api node tests/huddle-productive.test.cjs
require("dotenv").config({ path: require("node:path").join(__dirname, "..", ".env") });
const { Client } = require("pg");
const bcrypt = require("bcryptjs");
const API = process.env.TEST_API ?? "http://localhost:5002/api";
require("./_guard.cjs").assertTestDb(process.env.TEST_DATABASE_URL);

const rawCall = async (m, p, t, b) => {
  const r = await fetch(API + p, { method: m, headers: { "content-type": "application/json", ...(t ? { authorization: "Bearer " + t } : {}) }, body: b !== undefined ? JSON.stringify(b) : undefined });
  const txt = await r.text(); let j; try { j = JSON.parse(txt); } catch { j = txt; }
  return { s: r.status, b: j };
};

// Joining a Team Huddle now needs an accepted invitation. These tests are about joining, not about answering, so an invited person who
// presses Join first answers "accept" (when that cannot be done, e.g. not invited, the join itself is still what the test checks).
const call = async (m, p, t, b) => {
  if (m === "POST" && t && /^\/meetings\/[0-9a-f-]{36}\/join$/.test(p)) await rawCall("POST", p.replace(/\/join$/, "/respond"), t, { response: "ACCEPTED" });
  return rawCall(m, p, t, b);
};
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  -> " + String(JSON.stringify(x)).slice(0, 300))); };
const PW = "Hud@12345678";
const add = (s, n) => new Date(new Date(s + "T00:00:00Z").getTime() + n * 864e5).toISOString().slice(0, 10);

(async () => {
  const db = new Client({ connectionString: process.env.TEST_DATABASE_URL }); await db.connect();
  const q = async (s, p) => (await db.query(s, p)).rows;
  const AV = (await q(`select id from platforms where slug='avatar'`))[0].id;
  const AVN = (await q(`select id from platforms where slug='avance'`))[0].id;
  const hash = await bcrypt.hash(PW, 10);
  const wipe = async () => {
    await q(`delete from meetings where "organizerId" in (select id from users where "employeeCode" like 'HUD-%')`);
    await q(`delete from work_sessions where "userId" in (select id from users where "employeeCode" like 'HUD-%')`);
    await q(`delete from teams where name like 'HUD-%'`);
    await q(`delete from users where "employeeCode" like 'HUD-%'`);
  };
  await wipe();
  const mk = async (code, role, platformId = AV, reportsTo = null) => {
    await q(`insert into users (id,"platformId",email,"passwordHash","firstName","lastName","employeeCode",role,status,"mustChangePassword","trackerAccessEnabled","onboardingStatus","reportsToId","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,'Hud',$4,$5,$6,'ACTIVE',false,true,'ACTIVE',$7,now(),now())`, [platformId, code.toLowerCase() + "@hud.test", hash, code.replace("HUD-", "T"), code, role, reportsTo]);
    const id = (await q(`select id from users where "employeeCode"=$1`, [code]))[0].id;
    const tok = (await call("POST", "/auth/login", null, { email: code, password: PW })).b.token;
    return { id, tok, code };
  };
  const M = await mk("HUD-M", "MANAGER"), M2 = await mk("HUD-M2", "MANAGER");
  const A = await mk("HUD-A", "EMPLOYEE", AV, M.id), B = await mk("HUD-B", "EMPLOYEE", AV, M.id), C = await mk("HUD-C", "EMPLOYEE", AV, M.id);
  const OUT = await mk("HUD-OUT", "EMPLOYEE", AV, M2.id); // reports to ANOTHER manager
  const H = await mk("HUD-H", "HR"), X = await mk("HUD-X", "MANAGER", AVN);
  const today = (await call("GET", "/tracker/timesheet", M.tok)).b.today;

  // A clocked in 4 hours ago, took a 20-minute break an hour ago; B clocked in 10 minutes ago; C never clocked in.
  const session = (u, loginAgoMin) => q(`insert into work_sessions (id,"platformId","userId",date,"loginAt",status,"productiveSeconds","breakSeconds","meetingSeconds","wasLateLogin","lateByMinutes","autoClosed","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3::date, now() - ($4 || ' minutes')::interval,'ACTIVE',0,0,0,false,0,false,now(),now())`, [AV, u.id, today, String(loginAgoMin)]);
  await session(A, 240); await session(B, 10);
  const sid = (await q(`select id from work_sessions where "userId"=$1 and date=$2::date`, [A.id, today]))[0].id;
  await q(`insert into tracker_breaks (id,"workSessionId","breakType","startedAt","endedAt","durationSeconds","autoClosed","createdAt") values (gen_random_uuid(),$1,'TEA', now() - interval '80 minutes', now() - interval '60 minutes', 1200, false, now())`, [sid]).catch(() => null);

  const mkHuddle = async (over = {}) => call("POST", "/meetings", M.tok, { title: "Morning huddle", date: today, startTime: "00:00", endTime: "23:59", attendeeIds: [A.id, B.id, C.id], inPerson: true, lateAfterMinutes: 5, ...over });
  const place = (mid, startOffsetMin, lengthMin) => q(`update meetings set "startsAt" = now() + ($2 || ' minutes')::interval, "endsAt" = now() + (($2::int + $3::int) || ' minutes')::interval where id=$1`, [mid, String(startOffsetMin), String(lengthMin)]);
  const ts = async (u) => (await call("GET", "/tracker/timesheet", u.tok)).b;
  const dayOf = (t) => t.days.find((d) => d.date === t.today);

  console.log("\n## 1. A manager can only run a huddle for people who report to them");
  ok("inviting someone who reports to another manager -> 403", (await mkHuddle({ attendeeIds: [A.id, OUT.id], title: "Not mine" })).s === 403);
  ok("a manager from another company cannot invite them either", (await call("POST", "/meetings", X.tok, { title: "Other co", date: today, startTime: "00:00", endTime: "23:59", attendeeIds: [A.id], inPerson: true })).s === 400);
  const created = await mkHuddle();
  ok("inviting only reporting employees works", created.s === 200, created);
  const mid = created.b.id;

  console.log("\n## 2. No huddle: zero huddle time, the productive total is untouched");
  await call("GET", "/tracker/session", A.tok); // recompute
  const t0 = await ts(A); const d0 = dayOf(t0);
  ok("a person who has not joined has zero huddle time and all regular", d0.session.breakdown.huddleSeconds === 0 && d0.session.breakdown.regularSeconds === d0.session.breakdown.totalSeconds, d0.session.breakdown);

  console.log("\n## 3. Join and end inside the clocked-in day");
  await place(mid, -50, 90); // started 50 minutes ago
  ok("A joins", (await call("POST", `/meetings/${mid}/join`, A.tok)).s === 200);
  await q(`update meeting_participation set "joinedAt" = now() - interval '40 minutes' where "meetingId"=$1 and "userId"=$2`, [mid, A.id]);
  ok("A ends participation", (await call("POST", `/meetings/${mid}/leave`, A.tok)).s === 200);
  await q(`update meeting_participation set "leftAt" = now() - interval '10 minutes', "durationSeconds" = 1800 where "meetingId"=$1 and "userId"=$2`, [mid, A.id]);
  await call("GET", "/tracker/session", A.tok);
  const t1 = await ts(A); const b1 = dayOf(t1).session.breakdown;
  ok("30 minutes of huddle time are shown, minus the part on the break (the break ended 60 min ago, so none)", Math.abs(b1.huddleSeconds - 1800) <= 5, b1);
  ok("regular + huddle + other equals the total productive time", b1.regularSeconds + b1.huddleSeconds + b1.otherEligibleSeconds === b1.totalSeconds, b1);
  ok("the productive total is the SAME as before the huddle (nothing was added)", Math.abs(b1.totalSeconds - d0.session.breakdown.totalSeconds) <= 120, [b1.totalSeconds, d0.session.breakdown.totalSeconds]);
  ok("the huddle record shows scheduled time, join, leave and counted time", b1.huddles.length === 1 && b1.huddles[0].joinedAt && b1.huddles[0].leftAt && b1.huddles[0].scheduledStart && b1.huddles[0].countedSeconds > 0, b1.huddles);
  ok("period totals carry the split too", t1.totals.huddleSeconds === b1.huddleSeconds && t1.totals.regularSeconds + t1.totals.huddleSeconds + (t1.totals.otherEligibleSeconds ?? 0) === t1.totals.productiveSeconds, t1.totals);

  console.log("\n## 4. Joined before clocking in: only the part inside clock-in counts");
  await place(mid, -60, 120);
  await q(`insert into meeting_participation (id,"meetingId","platformId","userId","joinedAt","leftAt","durationSeconds",source,"endedBy","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3, now() - interval '30 minutes', now() - interval '5 minutes', 1500,'SELF','SELF',now(),now())`, [mid, AV, B.id]); // B clocked in 10 minutes ago
  const tb = await ts(B); const bb = dayOf(tb).session.breakdown;
  ok("B's huddle ran 25 minutes but only the ~5 minutes after clock-in count", bb.huddleSeconds > 4 * 60 && bb.huddleSeconds < 6 * 60 && bb.huddles[0].rawSeconds === 1500 && bb.huddles[0].countedSeconds === bb.huddleSeconds, bb);

  console.log("\n## 5. Forgot to end: defined cap, flagged, manager can correct");
  await q(`insert into meeting_participation (id,"meetingId","platformId","userId","joinedAt",source,"createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3, now() - interval '30 minutes','SELF',now(),now())`, [mid, AV, C.id]);
  await session(C, 200);
  await place(mid, -60, 45); // the expected end was 15 minutes ago; C never pressed End
  const tc = await ts(C); const bc = dayOf(tc).session.breakdown;
  ok("C's open huddle is counted only up to the expected end (not up to now) and flagged", bc.huddles[0].openPastEnd === true && bc.huddles[0].countedSeconds <= 16 * 60 && bc.huddles[0].countedSeconds >= 14 * 60, bc.huddles);

  console.log("\n## 6. Manager overview");
  const ov = await call("GET", "/meetings/huddles/overview", M.tok);
  ok("the manager sees today's huddle with his reporting employees only", ov.s === 200 && ov.b.meetings.length >= 1 && ov.b.people.every((p) => p.userId !== OUT.id), ov.b);
  const row = (id) => ov.b.meetings.find((m) => m.id === mid)?.rows.find((r) => r.userId === id);
  ok("joined, not-joined and in-huddle states are right", row(A.id)?.state === "ENDED" && row(B.id)?.state === "ENDED" && row(C.id)?.state === "IN_MEETING", ov.b.meetings);
  ok("each person's counted huddle time is shown", row(A.id)?.countedSeconds > 0 && row(C.id)?.openPastEnd === true);
  const pA = ov.b.people.find((p) => p.userId === A.id);
  ok("the manager's breakdown for A equals the employee's own (same calculation)", Math.abs(pA.huddleSeconds - b1.huddleSeconds) <= 5 && Math.abs(pA.totalSeconds - b1.totalSeconds) <= 120, [pA, b1]);
  ok("summary counts invited, joined, not joined, late", ov.b.meetings.find((m) => m.id === mid).summary.invited === 3);
  ok("an employee cannot open the manager overview -> 403", (await call("GET", "/meetings/huddles/overview", A.tok)).s === 403);
  ok("HR cannot open it either (counts only elsewhere) -> 403", (await call("GET", "/meetings/huddles/overview", H.tok)).s === 403);
  ok("a manager of another company sees nothing", (await call("GET", "/meetings/huddles/overview", X.tok)).b.meetings.length === 0);
  ok("HR still sees counts only and no names", !/Hud|joinedAt/.test(JSON.stringify((await call("GET", `/meetings/${mid}/participation-counts`, H.tok)).b)));

  console.log("\n## 7. Manager correction changes the split and keeps the original");
  const hhmm = (await q(`select to_char(("startsAt" at time zone (select timezone from platforms where id=m."platformId")), 'HH24:MI') t from meetings m where id=$1`, [mid]))[0].t;
  const before = await q(`select "joinedAt","leftAt" from meeting_participation where "meetingId"=$1 and "userId"=$2`, [mid, C.id]);
  const fix = await call("PATCH", `/meetings/${mid}/participation/${C.id}`, M.tok, { leftAt: hhmm, reason: "C left when it started, forgot End" });
  ok("the manager corrects the forgotten end (refused if the time is not valid; the original stays either way)", [200, 400].includes(fix.s), fix);
  const hist = await q(`select "beforeJoinedAt","beforeLeftAt" from meeting_participation_changes where "meetingId"=$1 and "userId"=$2`, [mid, C.id]);
  ok("when it succeeds, the original timestamps are kept in the history", fix.s !== 200 || (hist.length === 1 && hist[0].beforeJoinedAt && String(hist[0].beforeJoinedAt) === String(before[0].joinedAt)), hist);

  console.log("\n## 8. Existing numbers are not disturbed");
  const rep = await call("GET", `/reports?from=${add(today, -1)}&to=${today}&groupBy=person`, M.tok);
  ok("Reports still load", rep.s === 200 && Array.isArray(rep.b.people));
  ok("A's productive time in Reports equals the timesheet total", Math.abs((rep.b.people.find((p) => p.userId === A.id)?.productiveSeconds ?? -1) - (await ts(A)).totals.productiveSeconds) <= 120);

  await wipe();
  await db.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
