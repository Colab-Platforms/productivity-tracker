// Team Huddle: invitations (accept / decline), joining, actual participation time, and the Attendance "Meetings" column.
// The complete scenario: a manager invites three employees, all accept, two join (one late and leaving early), one never joins.
// Disposable Neon branch only (see _guard.cjs). Needs migration 20261102110000_meeting_responses (and the earlier participation
// migration) applied there.
//
//   cd backend && TEST_DATABASE_URL=... TEST_API=http://localhost:5012/api node tests/huddle-attendance.test.cjs
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
const ok = (n, c, x) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  -> " + String(JSON.stringify(x)).slice(0, 300))); };
const PW = "Hud@12345678";
const MIN = 60;

(async () => {
  const db = new Client({ connectionString: process.env.TEST_DATABASE_URL }); await db.connect();
  const q = async (s, p) => (await db.query(s, p)).rows;
  const AV = (await q(`select id from platforms where slug='avatar'`))[0].id;
  const AVN = (await q(`select id from platforms where slug='avance'`))[0].id;
  const hash = await bcrypt.hash(PW, 10);

  const wipe = async () => {
    const ids = `(select id from users where "employeeCode" like 'HUD-%')`;
    await q(`delete from meetings where "organizerId" in ${ids}`); // cascades attendees, responses, tracking, participation
    await q(`delete from work_sessions where "userId" in ${ids}`);
    await q(`delete from notifications where "userId" in ${ids}`);
    await q(`delete from users where "employeeCode" like 'HUD-%'`);
  };
  await wipe();
  const mk = async (code, role, platformId, reportsToId = null) => {
    await q(`insert into users (id,"platformId",email,"passwordHash","firstName","lastName","employeeCode",role,status,"mustChangePassword","trackerAccessEnabled","onboardingStatus","reportsToId","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,$4,'Hud',$5,$6,'ACTIVE',false,true,'ACTIVE',$7,now(),now())`, [platformId, code.toLowerCase() + "@hud.test", hash, code.replace("HUD-", "T"), code, role, reportsToId]);
    const id = (await q(`select id from users where "employeeCode"=$1`, [code]))[0].id;
    const tok = (await call("POST", "/auth/login", null, { email: code, password: PW })).b.token;
    return { id, tok };
  };
  const M = await mk("HUD-M", "MANAGER", AV);
  const A = await mk("HUD-A", "EMPLOYEE", AV, M.id);   // joins late, leaves early
  const B = await mk("HUD-B", "EMPLOYEE", AV, M.id);   // joins and stays
  const C = await mk("HUD-C", "EMPLOYEE", AV, M.id);   // accepts, never joins
  const D = await mk("HUD-D", "EMPLOYEE", AV, M.id);   // not invited
  const HR = await mk("HUD-HR", "HR", AV);
  const MB = await mk("HUD-MB", "MANAGER", AVN);       // a manager of ANOTHER company
  const today = (await call("GET", "/tracker/timesheet", M.tok)).b.today;

  // clocked in for two hours; A has a 5 minute break inside the huddle
  const NOW = Date.now();
  const at = (minAgo) => new Date(NOW - minAgo * 60_000).toISOString();
  const seed = async (user, breaks = []) => {
    // stored totals as the app would have written them: clocked in 120 minutes, minus the breaks
    const breakSecs = breaks.reduce((n, [from, to]) => n + (from - to) * 60, 0);
    const id = (await q(`insert into work_sessions (id,"platformId","userId",date,"loginAt","logoutAt",status,"productiveSeconds","breakSeconds","meetingSeconds","wasLateLogin","lateByMinutes","autoClosed","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3::date,$4,null,'ACTIVE',$5,$6,0,false,0,false,now(),now()) returning id`, [AV, user.id, today, at(120), 7200 - breakSecs, breakSecs]))[0].id;
    for (const [from, to] of breaks) await q(`insert into tracker_breaks (id,"workSessionId","breakType","startedAt","endedAt","durationSeconds","autoClosed","createdAt") values (gen_random_uuid(),$1,'LUNCH',$2,$3,$4,false,now())`, [id, at(from), at(to), (from - to) * 60]);
    return id;
  };
  await seed(A, [[30, 25]]);
  await seed(B);
  await seed(C);

  console.log("\n## 1. The manager schedules a meeting for three employees");
  const dayStr = today;
  const created = await call("POST", "/meetings", M.tok, { title: "Morning huddle", date: dayStr, startTime: "23:00", endTime: "23:30", attendeeIds: [A.id, B.id, C.id] });
  ok("it is created (no tick, no link)", created.s === 200 && created.b.id, created);
  const mid = created.b.id;
  ok("it is a Team Huddle automatically (everyone invited reports to the organizer)", (await q(`select 1 from meeting_tracking where "meetingId"=$1`, [mid])).length === 1);
  ok("three invitation rows exist", (await q(`select count(*)::int n from meeting_attendees where "meetingId"=$1`, [mid]))[0].n === 3);
  ok("all three were notified", (await Promise.all([A, B, C].map(async (u) => (await q(`select 1 from notifications where "userId"=$1 and type='MEETING_INVITED'`, [u.id])).length))).every((n) => n === 1));
  ok("a meeting with a link stays an online meeting, not a huddle", await (async () => { const r = await call("POST", "/meetings", M.tok, { title: "Online sync", date: dayStr, startTime: "23:00", endTime: "23:30", attendeeIds: [A.id], meetingUrl: "https://meet.google.com/abc-defg-hij" }); return r.s === 200 && (await q(`select 1 from meeting_tracking where "meetingId"=$1`, [r.b.id])).length === 0; })());
  ok("an explicit 'no tracking' choice is respected", await (async () => { const r = await call("POST", "/meetings", M.tok, { title: "No tracking", date: dayStr, startTime: "23:00", endTime: "23:30", attendeeIds: [A.id], inPerson: false }); return r.s === 200 && (await q(`select 1 from meeting_tracking where "meetingId"=$1`, [r.b.id])).length === 0; })());
  // put "now" inside the huddle: it started 50 minutes ago and ends in 10
  await q(`update meetings set "startsAt" = now() - interval '50 minutes', "endsAt" = now() + interval '10 minutes' where id=$1`, [mid]);

  console.log("\n## 2. Each employee sees the invitation and must accept");
  const seen = async (u) => (await call("GET", "/meetings?scope=upcoming", u.tok)).b.meetings.find((m) => m.id === mid);
  const a0 = await seen(A);
  ok("the invitation shows title, time and organizer", a0 && a0.title === "Morning huddle" && !!a0.startsAt && !!a0.endsAt && a0.organizer.length > 0, a0);
  ok("status is Invited, and A may accept or decline", a0.myStatus === "INVITED" && a0.canRespond === true && a0.myResponse === null, a0);
  ok("Join is not offered before accepting", a0.canJoin === false && a0.mustAccept === true);
  const early = await call("POST", `/meetings/${mid}/join`, A.tok);
  ok("joining without accepting is refused (409)", early.s === 409 && /Accept/i.test(JSON.stringify(early.b)), early);
  ok("nothing was recorded by that attempt", (await q(`select 1 from meeting_participation where "meetingId"=$1`, [mid])).length === 0);
  ok("a person who was not invited cannot see it", !(await call("GET", "/meetings?scope=upcoming", D.tok)).b.meetings.some((m) => m.id === mid));
  ok("nor answer it (404)", (await call("POST", `/meetings/${mid}/respond`, D.tok, { response: "ACCEPTED" })).s === 404);
  ok("nor join it (404)", (await call("POST", `/meetings/${mid}/join`, D.tok)).s === 404);
  ok("HR is not an invitee, so cannot answer either (404)", (await call("POST", `/meetings/${mid}/respond`, HR.tok, { response: "ACCEPTED" })).s === 404);
  ok("a manager of another company cannot (404)", (await call("POST", `/meetings/${mid}/respond`, MB.tok, { response: "ACCEPTED" })).s === 404 && (await call("POST", `/meetings/${mid}/join`, MB.tok)).s === 404);
  ok("a bad answer is refused (400)", (await call("POST", `/meetings/${mid}/respond`, A.tok, { response: "MAYBE" })).s === 400);

  console.log("\n## 3. All three accept (B first declines, then changes their mind)");
  ok("B declines", (await call("POST", `/meetings/${mid}/respond`, B.tok, { response: "DECLINED" })).s === 200 && (await seen(B)).myStatus === "DECLINED");
  ok("a declined person cannot join (409)", (await call("POST", `/meetings/${mid}/join`, B.tok)).s === 409);
  ok("B accepts after all", (await call("POST", `/meetings/${mid}/respond`, B.tok, { response: "ACCEPTED" })).s === 200);
  ok("A and C accept", (await call("POST", `/meetings/${mid}/respond`, A.tok, { response: "ACCEPTED" })).s === 200 && (await call("POST", `/meetings/${mid}/respond`, C.tok, { response: "ACCEPTED" })).s === 200);
  ok("one answer row per person, no duplicates", (await q(`select count(*)::int n, count(distinct "userId")::int d from meeting_responses where "meetingId"=$1`, [mid]))[0].n === 3);
  const a1 = await seen(A);
  ok("A's status is Accepted and the Join button is now offered", a1.myStatus === "ACCEPTED" && a1.canJoin === true, a1);
  ok("the organizer was told about the answers", (await q(`select 1 from notifications where "userId"=$1 and type='MEETING_RESPONDED'`, [M.id])).length >= 3);
  ok("every answer is in the audit log", (await q(`select 1 from audit_logs where summary like '%invitation to "Morning huddle"%'`)).length >= 4);

  console.log("\n## 4. A and B join; C does not");
  const ja = await call("POST", `/meetings/${mid}/join`, A.tok);
  ok("A joins (200)", ja.s === 200, ja);
  ok("B joins (200)", (await call("POST", `/meetings/${mid}/join`, B.tok)).s === 200);
  ok("A cannot join twice (409), still one record", (await call("POST", `/meetings/${mid}/join`, A.tok)).s === 409 && (await q(`select 1 from meeting_participation where "meetingId"=$1 and "userId"=$2`, [mid, A.id])).length === 1);
  ok("a joined person's status is Joined, with End Huddle available", (await seen(A)).myStatus === "JOINED" && (await seen(A)).me.state === "IN_MEETING");
  ok("a joined person can no longer change their answer (409)", (await call("POST", `/meetings/${mid}/respond`, A.tok, { response: "DECLINED" })).s === 409);
  ok("A ends participation (200)", (await call("POST", `/meetings/${mid}/leave`, A.tok)).s === 200);
  ok("B ends participation (200)", (await call("POST", `/meetings/${mid}/leave`, B.tok)).s === 200);
  ok("ending twice is refused (409)", (await call("POST", `/meetings/${mid}/leave`, A.tok)).s === 409);
  // The server stamped real instants (just now). Make the records match the story: A joined 10 minutes late and left 25 minutes before the end,
  // B joined at the start and left shortly before the end. (S = start = 50 minutes ago.)
  const set = (user, joinedMinAgo, leftMinAgo) => q(`update meeting_participation set "joinedAt"=$3, "leftAt"=$4, "durationSeconds"=$5 where "meetingId"=$1 and "userId"=$2`, [mid, user.id, at(joinedMinAgo), at(leftMinAgo), (joinedMinAgo - leftMinAgo) * 60]);
  await set(A, 40, 15); // 25 minutes
  await set(B, 48, 2);  // 46 minutes
  const AEXP = 25 * MIN, BEXP = 46 * MIN, ACOUNT = 20 * MIN; // A's 5 minute break is outside what counts

  console.log("\n## 5. The organizer sees each person's actual participation");
  const list = await call("GET", `/meetings/${mid}/participation`, M.tok);
  const row = (id) => list.b.rows.find((r) => r.userId === id);
  ok("the manager can open it (200)", list.s === 200, list);
  ok("A: completed, 25 minutes, late", row(A.id).status === "COMPLETED" && row(A.id).durationSeconds === AEXP && row(A.id).late === true, row(A.id));
  ok("B: completed, 46 minutes, not late", row(B.id).status === "COMPLETED" && row(B.id).durationSeconds === BEXP && row(B.id).late === false, row(B.id));
  ok("C: accepted, no record, no duration", row(C.id).response === "ACCEPTED" && row(C.id).joinedAt === null && row(C.id).durationSeconds === null, row(C.id));
  ok("the summary counts agree", list.b.summary.invited === 3 && list.b.summary.accepted === 3 && list.b.summary.declined === 0 && list.b.summary.joined === 2 && list.b.summary.notJoined === 1);
  const myHistory = await call("GET", "/meetings/participation/history", A.tok);
  ok("the employee sees their own participation history, with the real duration", myHistory.s === 200 && myHistory.b.rows.some((r) => r.meetingId === mid && r.durationSeconds === AEXP), myHistory.b);
  ok("an employee cannot read someone else's history (403/404)", [403, 404].includes((await call("GET", `/meetings/participation/history?userId=${B.id}`, A.tok)).s));
  ok("an employee cannot open the organizer's list (404)", (await call("GET", `/meetings/${mid}/participation`, A.tok)).s === 404);
  ok("another manager cannot (404)", (await call("GET", `/meetings/${mid}/participation`, MB.tok)).s === 404);
  ok("HR cannot see names or times (404), only counts", (await call("GET", `/meetings/${mid}/participation`, HR.tok)).s === 404);
  const counts = await call("GET", `/meetings/${mid}/participation-counts`, HR.tok);
  ok("HR gets the counts: invited 3, accepted 3, joined 2", counts.s === 200 && counts.b.invited === 3 && counts.b.accepted === 3 && counts.b.joined === 2 && !JSON.stringify(counts.b).includes("userId"), counts);
  // a correction by the manager keeps its history
  const tz = (await q(`select timezone from platforms where id=$1`, [AV]))[0].timezone;
  const hhmm = (d) => new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: tz }).format(d);
  const fix = await call("PATCH", `/meetings/${mid}/participation/${C.id}`, M.tok, { joinedAt: hhmm(new Date(NOW - 30 * 60_000)), reason: "Seen in the room, forgot to press the button" });
  ok("the manager records C as present, with a reason (200)", fix.s === 200, fix);
  ok("the correction is kept as history (who, why, before, after)", (await q(`select 1 from meeting_participation_changes where "meetingId"=$1 and "userId"=$2 and "actedById"=$3 and reason like 'Seen in the room%' and "afterJoinedAt" is not null`, [mid, C.id, M.id])).length === 1);
  ok("C's record is marked as added by the manager", (await q(`select source from meeting_participation where "meetingId"=$1 and "userId"=$2`, [mid, C.id]))[0].source === "MANAGER_ADDED");
  // C is meant to stay "not joined" for the rest of the scenario: remove the record (the history row stays)
  await q(`delete from meeting_participation where "meetingId"=$1 and "userId"=$2`, [mid, C.id]);

  console.log("\n## 6. The Manager's Attendance board shows the actual meeting time");
  const board = await call("GET", "/team-attendance/live", M.tok);
  const br = (id) => board.b.rows.find((r) => r.userId === id);
  ok("the board loads for the manager", board.s === 200 && board.b.rows.length >= 3, board.s);
  ok("A: meetings = 20 minutes (25 minutes in the huddle minus the 5 minute break)", Math.abs(br(A.id).meetingSeconds - ACOUNT) <= 2, br(A.id));
  ok("B: meetings = 46 minutes", Math.abs(br(B.id).meetingSeconds - BEXP) <= 2, br(B.id));
  ok("C (accepted, never joined): exactly 0", br(C.id).meetingSeconds === 0, br(C.id));
  ok("D (not invited): exactly 0", br(D.id).meetingSeconds === 0 || br(D.id).meetingSeconds === null);
  const elapsedA = (Date.now() - new Date(at(120)).getTime()) / 1000 - 5 * MIN;
  ok("A's productive time is clocked-in time minus the break: the meeting is NOT added on top", Math.abs(br(A.id).productiveSeconds - elapsedA) <= 8, { productive: br(A.id).productiveSeconds, expected: elapsedA });
  ok("B's productive time is unchanged by the meeting too", Math.abs(br(B.id).productiveSeconds - (Date.now() - new Date(at(120)).getTime()) / 1000) <= 8);
  const boardHr = await call("GET", "/team-attendance/live", HR.tok);
  const hrA = boardHr.b.rows?.find?.((r) => r.userId === A.id);
  ok("HR sees the same per-person huddle minutes (A: 20 min), durations only", boardHr.s === 200 && Math.abs(hrA?.meetingSeconds - 20 * MIN) <= 8 && !JSON.stringify(hrA).includes("joinedAt"), hrA);
  const boardHrC = boardHr.b.rows?.find?.((r) => r.userId === C.id);
  ok("HR sees exactly 0 for the person who never joined", boardHrC?.meetingSeconds === 0, boardHrC);
  ok("a manager of another company does not see these people", !(await call("GET", "/team-attendance/live", MB.tok)).b.rows.some((r) => r.userId === A.id));
  const sb = await call("GET", `/team-attendance/shift-breakdown?date=${today}`, M.tok);
  ok("the shift breakdown agrees (A's meeting figure = 20 minutes)", sb.s === 200 && Math.abs((sb.b.rows.find((r) => r.userId === A.id)?.huddleSeconds ?? -1) - ACOUNT) <= 2, sb.b.rows?.find?.((r) => r.userId === A.id));

  console.log("\n## 7. Productive time is split, never doubled");
  const ts = await call("GET", `/tracker/timesheet?from=${today}&to=${today}`, A.tok);
  const day = ts.b.days.find((d) => d.date === today);
  const bd = day?.session?.breakdown;
  ok("A's timesheet carries the breakdown", !!bd, day);
  ok("huddle time counted = 20 minutes", bd && Math.abs(bd.huddleSeconds - ACOUNT) <= 2, bd);
  ok("regular + huddle + other eligible = the productive total, exactly", bd && bd.regularSeconds + bd.huddleSeconds + bd.otherEligibleSeconds === bd.totalSeconds, bd);
  ok("the total is clocked-in minus the break (not inflated by the meeting)", bd && Math.abs(bd.totalSeconds - elapsedA) <= 8, { total: bd?.totalSeconds, expected: elapsedA });
  const tsC = await call("GET", `/tracker/timesheet?from=${today}&to=${today}`, C.tok);
  ok("C's timesheet shows 0 huddle time", tsC.b.days.find((d) => d.date === today)?.session?.breakdown?.huddleSeconds === 0);

  console.log("\n## 7b. The four totals add up: productive work + Team Huddle + break = time on site");
  const ov = await call("GET", "/meetings/huddles/overview", M.tok);
  const pa = ov.b.people?.find((x) => x.userId === A.id), pb = ov.b.people?.find((x) => x.userId === B.id), pc = ov.b.people?.find((x) => x.userId === C.id);
  ok("the manager overview loads", ov.s === 200 && !!pa, ov);
  ok("A: break is exactly the 5 minute break (the huddle is NOT added to it)", Math.abs(pa.breakSeconds - 5 * MIN) <= 8, pa);
  ok("A: time on site is the 2 hours clocked in", Math.abs(pa.onSiteSeconds - 120 * MIN) <= 8, pa);
  ok("A: total productive + break = time on site (nothing counted twice)", Math.abs(pa.totalSeconds + pa.breakSeconds - pa.onSiteSeconds) <= 1, pa);
  ok("A: regular + huddle + other = total productive", pa.regularSeconds + pa.huddleSeconds + pa.otherEligibleSeconds === pa.totalSeconds, pa);
  ok("B: no break at all, even with 46 minutes of huddle", pb.breakSeconds === 0 && pb.huddleSeconds > 0, pb);
  ok("C (never joined): huddle 0, break 0", pc.huddleSeconds === 0 && pc.breakSeconds === 0, pc);
  ok("the stored break columns were not changed by any huddle", (await q('select "breakSeconds" from work_sessions where "userId"=$1', [B.id]))[0].breakSeconds === 0 && (await q('select "breakSeconds" from work_sessions where "userId"=$1', [A.id]))[0].breakSeconds === 5 * MIN);

  console.log("\n## 8. After the meeting is over");
  ok("the organizer ends the meeting", (await call("POST", `/meetings/${mid}/end`, M.tok)).s === 200);
  ok("C's status is Not joined", (await call("GET", `/meetings/${mid}/participation`, M.tok)).b.rows.find((r) => r.userId === C.id).status === "NOT_JOINED");
  ok("answers can no longer be changed (409)", (await call("POST", `/meetings/${mid}/respond`, C.tok, { response: "DECLINED" })).s === 409);
  const stillZero = await call("GET", "/team-attendance/live", M.tok);
  ok("C is still exactly 0 in Attendance", stillZero.b.rows.find((r) => r.userId === C.id).meetingSeconds === 0);
  ok("history is preserved: all participation rows remain", (await q(`select count(*)::int n from meeting_participation where "meetingId"=$1`, [mid]))[0].n === 2);

  console.log("\n## 9. Two quick presses on Join create one record");
  const m2 = await call("POST", "/meetings", M.tok, { title: "Second huddle", date: dayStr, startTime: "23:00", endTime: "23:30", attendeeIds: [D.id] });
  await q(`update meetings set "startsAt" = now() - interval '5 minutes', "endsAt" = now() + interval '25 minutes' where id=$1`, [m2.b.id]);
  await call("POST", `/meetings/${m2.b.id}/respond`, D.tok, { response: "ACCEPTED" });
  const race = await Promise.all([1, 2, 3].map(() => call("POST", `/meetings/${m2.b.id}/join`, D.tok)));
  ok("exactly one of three simultaneous joins succeeds", race.filter((r) => r.s === 200).length === 1 && race.filter((r) => r.s === 409).length === 2, race.map((r) => r.s));
  ok("and the database holds one record", (await q(`select count(*)::int n from meeting_participation where "meetingId"=$1`, [m2.b.id]))[0].n === 1);

  await wipe();
  await db.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
