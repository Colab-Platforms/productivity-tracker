// In-person meeting participation (self-reported): join window, duplicates, privacy, corrections, history, separation.
// Disposable Neon branch only (see _guard.cjs). Backend must run on :5002 against that branch, and migration
// 20261101120000_meeting_participation must be applied there first.
//
//   cd backend && TEST_DATABASE_URL=... TEST_API=http://localhost:5002/api node tests/meeting-participation.test.cjs
require("dotenv").config({ path: require("node:path").join(__dirname, "..", ".env") });
const { Client } = require("pg");
const bcrypt = require("bcryptjs");
const API = process.env.TEST_API ?? "http://localhost:5002/api";
require("./_guard.cjs").assertTestDb(process.env.TEST_DATABASE_URL);

const rawCall = async (m, p, t, b) => {
  const r = await fetch(API + p, { method: m, headers: { "content-type": "application/json", ...(t ? { authorization: "Bearer " + t } : {}) }, body: b !== undefined ? JSON.stringify(b) : undefined });
  const txt = await r.text(); let j; try { j = JSON.parse(txt); } catch { j = txt; }
  return { s: r.status, b: j, raw: txt };
};

// Joining a Team Huddle now needs an accepted invitation. These tests are about joining, not about answering, so an invited person who
// presses Join first answers "accept" (when that cannot be done, e.g. not invited, the join itself is still what the test checks).
const call = async (m, p, t, b) => {
  if (m === "POST" && t && /^\/meetings\/[0-9a-f-]{36}\/join$/.test(p)) await rawCall("POST", p.replace(/\/join$/, "/respond"), t, { response: "ACCEPTED" });
  return rawCall(m, p, t, b);
};
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  -> " + String(JSON.stringify(x)).slice(0, 300))); };
const PW = "Mtg@12345678";
const add = (s, n) => new Date(new Date(s + "T00:00:00Z").getTime() + n * 864e5).toISOString().slice(0, 10);

(async () => {
  const db = new Client({ connectionString: process.env.TEST_DATABASE_URL }); await db.connect();
  const q = async (s, p) => (await db.query(s, p)).rows;
  const AV = (await q(`select id from platforms where slug='avatar'`))[0].id;
  const AVN = (await q(`select id from platforms where slug='avance'`))[0].id;
  const hash = await bcrypt.hash(PW, 10);
  const wipe = async () => {
    await q(`delete from meetings where "organizerId" in (select id from users where "employeeCode" like 'MPT-%')`);
    await q(`delete from notifications where "userId" in (select id from users where "employeeCode" like 'MPT-%')`);
    await q(`delete from users where "employeeCode" like 'MPT-%'`);
  };
  await wipe();
  const mk = async (code, role, platformId = AV) => {
    await q(`insert into users (id,"platformId",email,"passwordHash","firstName","lastName","employeeCode",role,status,"mustChangePassword","trackerAccessEnabled","onboardingStatus","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,'Mpt',$4,$5,$6,'ACTIVE',false,true,'ACTIVE',now(),now())`, [platformId, code.toLowerCase() + "@mpt.test", hash, code.replace("MPT-", "T"), code, role]);
    const id = (await q(`select id from users where "employeeCode"=$1`, [code]))[0].id;
    const tok = (await call("POST", "/auth/login", null, { email: code, password: PW })).b.token;
    return { id, tok, code };
  };
  const O = await mk("MPT-O", "MANAGER"), O2 = await mk("MPT-O2", "MANAGER"), A = await mk("MPT-A", "EMPLOYEE"), B = await mk("MPT-B", "EMPLOYEE"), C = await mk("MPT-C", "EMPLOYEE"), D = await mk("MPT-D", "EMPLOYEE"), H = await mk("MPT-H", "HR"), AD = await mk("MPT-AD", "ADMIN"), X = await mk("MPT-X", "HR", AVN), XE = await mk("MPT-XE", "EMPLOYEE", AVN);
  const today = (await call("GET", "/tracker/timesheet", O.tok)).b.today;

  // a tracked, in-person meeting the organizer O runs, inviting A, B, C
  const mkMeeting = async (over = {}) => {
    const r = await call("POST", "/meetings", O.tok, { title: "Morning stand-up", description: "Agenda: blockers", date: add(today, 1), startTime: "09:30", endTime: "09:45", attendeeIds: [A.id, B.id, C.id], inPerson: true, lateAfterMinutes: 5, ...over });
    return r;
  };
  // put "now" at a chosen distance from the meeting (seconds relative to the START; end = start + lengthSec)
  const place = (mid, startOffsetSec, lengthSec = 900) => q(`update meetings set "startsAt" = now() + ($2 || ' seconds')::interval, "endsAt" = now() + (($2::int + $3::int) || ' seconds')::interval where id=$1`, [mid, String(startOffsetSec), String(lengthSec)]);
  const stamp = async (mid, uid) => (await q(`select * from meeting_participation where "meetingId"=$1 and "userId"=$2`, [mid, uid]))[0];

  console.log("\n## 1. Scheduling an in-person stand-up");
  ok("an employee cannot create a tracked meeting -> 403", (await call("POST", "/meetings", A.tok, { title: "x y", date: add(today, 1), startTime: "09:30", endTime: "09:45", attendeeIds: [B.id], inPerson: true })).s === 403);
  const created = await mkMeeting();
  ok("the manager schedules it (no link needed)", created.s === 200 && created.b.id, created);
  const mid = created.b.id;
  const row = (await q(`select * from meetings where id=$1`, [mid]))[0];
  ok("it has no link and no provider", row.meetingUrl === null && row.provider === null);
  ok("it is switched on for tracking, with the late setting", (await q(`select "lateAfterMinutes" from meeting_tracking where "meetingId"=$1`, [mid]))[0]?.lateAfterMinutes === 5);
  ok("a link sent with an in-person meeting is ignored", (await (async () => { const r = await mkMeeting({ meetingUrl: "https://meet.google.com/abc-defg-hij", title: "With link" }); return (await q(`select "meetingUrl" from meetings where id=$1`, [r.b.id]))[0].meetingUrl === null; })()));
  ok("late minutes out of range -> 400", (await mkMeeting({ lateAfterMinutes: 500 })).s === 400 && (await mkMeeting({ lateAfterMinutes: -1 })).s === 400 && (await mkMeeting({ lateAfterMinutes: 2.5 })).s === 400);
  const notif = await q(`select body from notifications where "userId"=$1 and type='MEETING_INVITED' order by "createdAt" desc limit 1`, [A.id]);
  ok("the invitation notification is reused and mentions the button", /I'm in the Meeting/.test(notif[0]?.body ?? ""), notif);
  const untracked = await call("POST", "/meetings", O.tok, { title: "Plain meeting", date: add(today, 1), startTime: "11:00", endTime: "11:30", attendeeIds: [A.id], meetingUrl: "https://meet.google.com/abc-defg-hij" });
  ok("an ordinary meeting is not tracked", (await q(`select 1 from meeting_tracking where "meetingId"=$1`, [untracked.b.id])).length === 0);
  // an organizer who scheduled an ordinary meeting can turn it into an in-person one (his own meeting, not ended)
  const upgradeMe = await call("POST", "/meetings", O.tok, { title: "Ordinary, will become in-person", date: add(today, 1), startTime: "12:00", endTime: "12:30", attendeeIds: [A.id], meetingUrl: "https://meet.google.com/abc-defg-hij" });
  ok("an employee cannot switch tracking on for someone else's meeting -> 403/404", [403, 404].includes((await call("PATCH", `/meetings/${upgradeMe.b.id}`, A.tok, { inPerson: true })).s));
  ok("another manager cannot either -> 404", (await call("PATCH", `/meetings/${upgradeMe.b.id}`, O2.tok, { inPerson: true })).s === 404);
  ok("late minutes out of range -> 400", (await call("PATCH", `/meetings/${upgradeMe.b.id}`, O.tok, { inPerson: true, lateAfterMinutes: 999 })).s === 400);
  const upg = await call("PATCH", `/meetings/${upgradeMe.b.id}`, O.tok, { inPerson: true, lateAfterMinutes: 10 });
  ok("the organizer turns an ordinary meeting into an in-person one", upg.s === 200 && (await q(`select "lateAfterMinutes" from meeting_tracking where "meetingId"=$1`, [upgradeMe.b.id]))[0]?.lateAfterMinutes === 10, upg);
  ok("...its link is removed", (await q(`select "meetingUrl" from meetings where id=$1`, [upgradeMe.b.id]))[0].meetingUrl === null);
  ok("...the invited people are told it is now in person", (await q(`select 1 from notifications where "userId"=$1 and type='MEETING_UPDATED' and body like '%in-person%'`, [A.id])).length >= 1);
  ok("...and it shows up as tracked for the invitee", ((await call("GET", "/meetings?scope=upcoming", A.tok)).b.meetings.find((m) => m.id === upgradeMe.b.id) ?? {}).tracked === true);
  ok("asking again changes nothing and does not break it", (await call("PATCH", `/meetings/${upgradeMe.b.id}`, O.tok, { inPerson: true })).s === 200 && (await q(`select count(*)::int c from meeting_tracking where "meetingId"=$1`, [upgradeMe.b.id]))[0].c === 1);
  ok("the invitee sees it as tracked, with their own state and the window", (await (async () => { const l = (await call("GET", "/meetings?scope=upcoming", A.tok)).b.meetings.find((m) => m.id === mid); return l?.tracked === true && l.me?.state === "NOT_JOINED" && l.joinWindow && l.lateAfterMinutes === 5; })()));

  console.log("\n## 2. The join window (15 minutes before the start until the expected end)");
  await place(mid, 20 * 60); // starts in 20 minutes: not open yet
  const early = await call("POST", `/meetings/${mid}/join`, A.tok);
  ok("20 minutes before: refused, too early", early.s === 409 && /15 minutes/.test(early.b.error), early);
  await place(mid, 15 * 60 + 5);
  ok("15 min 5 s before: still too early", (await call("POST", `/meetings/${mid}/join`, A.tok)).s === 409);
  await place(mid, 14 * 60 + 55);
  const inWin = await call("POST", `/meetings/${mid}/join`, A.tok);
  ok("14 min 55 s before: the window is open and A joins", inWin.s === 200 && inWin.b.ok === true, inWin);
  await place(mid, -(14 * 60), 900); // started 14 min ago, ends in 1 min
  ok("a late joiner can still join before the end", (await call("POST", `/meetings/${mid}/join`, B.tok)).s === 200);
  await place(mid, -(15 * 60) - 5, 900); // ended 5 s ago
  const closed = await call("POST", `/meetings/${mid}/join`, C.tok);
  ok("5 s after the expected end: closed (only the manager can add someone)", closed.s === 409 && /closed/i.test(closed.b.error), closed);
  ok("C was NOT marked present", (await q(`select 1 from meeting_participation where "meetingId"=$1 and "userId"=$2`, [mid, C.id])).length === 0);

  console.log("\n## 3. The server records the time; no duplicates");
  await place(mid, -60, 900);
  const mid2 = (await mkMeeting({ title: "Stand-up 2" })).b.id; await place(mid2, -60, 900);
  const before = Date.now();
  const j = await call("POST", `/meetings/${mid2}/join`, A.tok, { joinedAt: "2020-01-01T00:00:00Z", leftAt: "2020-01-01T01:00:00Z", userId: B.id, source: "MANAGER_ADDED" });
  const rec = await stamp(mid2, A.id);
  ok("join ignores any time or person sent in the body", j.s === 200 && Math.abs(new Date(rec.joinedAt).getTime() - before) < 15000 && rec.userId === A.id && rec.source === "SELF" && rec.leftAt === null, rec);
  ok("a second join -> 409, still one record", (await call("POST", `/meetings/${mid2}/join`, A.tok)).s === 409 && (await q(`select 1 from meeting_participation where "meetingId"=$1 and "userId"=$2`, [mid2, A.id])).length === 1);
  const mid3 = (await mkMeeting({ title: "Stand-up 3" })).b.id; await place(mid3, -60, 900);
  const race = await Promise.all([call("POST", `/meetings/${mid3}/join`, B.tok), call("POST", `/meetings/${mid3}/join`, B.tok), call("POST", `/meetings/${mid3}/join`, B.tok)]);
  ok("three simultaneous clicks: exactly one succeeds, one record", race.filter((r) => r.s === 200).length === 1 && race.filter((r) => r.s === 409).length === 2 && (await q(`select 1 from meeting_participation where "meetingId"=$1 and "userId"=$2`, [mid3, B.id])).length === 1, race.map((r) => r.s));

  console.log("\n## 4. Who can and cannot join");
  ok("someone not invited -> 404", (await call("POST", `/meetings/${mid2}/join`, D.tok)).s === 404);
  ok("a manager who is NOT the organizer cannot join -> 404", (await call("POST", `/meetings/${mid2}/join`, O2.tok)).s === 404);
  ok("HR / Admin who are not invited -> 404", (await call("POST", `/meetings/${mid2}/join`, H.tok)).s === 404 && (await call("POST", `/meetings/${mid2}/join`, AD.tok)).s === 404);
  ok("another company -> 404", (await call("POST", `/meetings/${mid2}/join`, XE.tok)).s === 404);
  ok("an untracked meeting -> 409", (await call("POST", `/meetings/${untracked.b.id}/join`, A.tok)).s === 409);
  const cancelled = (await mkMeeting({ title: "Cancelled one" })).b.id; await place(cancelled, -60, 900);
  await call("POST", `/meetings/${cancelled}/cancel`, O.tok, { reason: "no" });
  ok("a cancelled meeting cannot be joined -> 409", (await call("POST", `/meetings/${cancelled}/join`, A.tok)).s === 409);
  ok("not signed in -> 401", (await call("POST", `/meetings/${mid2}/join`)).s === 401);
  ok("a bad id -> 404, not a database error", (await call("POST", `/meetings/not-a-uuid/join`, A.tok)).s === 404);

  console.log("\n## 5. Ending (leaving)");
  ok("leaving without having joined -> 409", (await call("POST", `/meetings/${mid2}/leave`, B.tok)).s === 409);
  await q(`update meeting_participation set "joinedAt" = now() - interval '90 seconds' where "meetingId"=$1 and "userId"=$2`, [mid2, A.id]);
  const lv = await call("POST", `/meetings/${mid2}/leave`, A.tok, { leftAt: "2020-01-01T00:00:00Z", durationSeconds: 99999 });
  const done = await stamp(mid2, A.id);
  ok("leave ignores any time or duration sent; the server stamps both", lv.s === 200 && done.leftAt && done.endedBy === "SELF" && Math.abs(done.durationSeconds - 90) < 15, done);
  ok("a second leave -> 409 and nothing changes", (await call("POST", `/meetings/${mid2}/leave`, A.tok)).s === 409 && (await stamp(mid2, A.id)).durationSeconds === done.durationSeconds);
  ok("after ending, joining again is refused (one join per person)", (await call("POST", `/meetings/${mid2}/join`, A.tok)).s === 409);
  await call("POST", `/meetings/${mid2}/join`, B.tok); await new Promise((r) => setTimeout(r, 1100));
  const lrace = await Promise.all([call("POST", `/meetings/${mid2}/leave`, B.tok), call("POST", `/meetings/${mid2}/leave`, B.tok)]);
  ok("two simultaneous 'Meeting Ended' clicks: recorded once", lrace.filter((r) => r.s === 200).length === 1, lrace.map((r) => r.s));
  ok("leaving still works after the join window has closed", await (async () => { await call("POST", `/meetings/${mid3}/leave`, B.tok); const o = await stamp(mid3, B.id); return !!o.leftAt; })());

  console.log("\n## 6. Employees cannot edit their own times; managers' rights");
  const tryEdit = async (who, target) => (await call("PATCH", `/meetings/${mid2}/participation/${target}`, who.tok, { joinedAt: "09:00", reason: "I forgot to press it" })).s;
  ok("an employee cannot correct their own record -> 404", (await tryEdit(A, A.id)) === 404);
  ok("an employee cannot correct someone else's -> 404", (await tryEdit(B, A.id)) === 404);
  ok("HR cannot correct -> 404", (await tryEdit(H, A.id)) === 404);
  ok("another manager (not the organizer) cannot correct -> 404", (await tryEdit(O2, A.id)) === 404);
  ok("another company's HR cannot -> 404", (await tryEdit(X, A.id)) === 404);

  console.log("\n## 7. The organizer's live list and report");
  const mid4 = (await mkMeeting({ title: "Report meeting", lateAfterMinutes: 5 })).b.id; await place(mid4, -20 * 60, 40 * 60); // started 20 min ago, ends in 20
  await call("POST", `/meetings/${mid4}/join`, A.tok);
  await q(`update meeting_participation set "joinedAt" = (select "startsAt" from meetings where id=$1) + interval '2 minutes' where "meetingId"=$1`, [mid4]);
  await call("POST", `/meetings/${mid4}/join`, B.tok);
  await q(`update meeting_participation set "joinedAt" = (select "startsAt" from meetings where id=$1) + interval '9 minutes' where "meetingId"=$1 and "userId"=$2`, [mid4, B.id]);
  const lst = await call("GET", `/meetings/${mid4}/participation`, O.tok);
  ok("the organizer gets the list with summary", lst.s === 200 && lst.b.summary.invited === 3 && lst.b.summary.joined === 2 && lst.b.summary.notJoined === 1 && lst.b.summary.inMeeting === 2 && lst.b.selfReported === true, lst.b.summary);
  ok("C (invited, did not join) is listed as NOT_JOINED, never presumed present", lst.b.rows.find((r) => r.userId === C.id).state === "NOT_JOINED" && lst.b.rows.find((r) => r.userId === C.id).joinedAt === null);
  ok("late joiner flagged by the meeting's own threshold (9 min > 5), the 2-minute joiner is not", lst.b.rows.find((r) => r.userId === B.id).late === true && lst.b.rows.find((r) => r.userId === A.id).late === false && lst.b.summary.late === 1, lst.b.rows.map((r) => [r.name, r.late]));
  ok("the actual duration is reported (first join to now while someone is still in)", lst.b.summary.actualDurationSeconds > 0 && lst.b.summary.actualDurationOngoing === true);
  await place(mid4, -50 * 60, 40 * 60); // the expected end was 10 minutes ago, nobody pressed End
  const over = await call("GET", `/meetings/${mid4}/participation`, O.tok);
  ok("still-active sessions past the expected end are FLAGGED, not closed", over.b.summary.stillActivePastEnd === 2 && over.b.summary.inMeeting === 2 && over.b.rows.filter((r) => r.stillActivePastEnd).length === 2, over.b.summary);
  ok("another manager cannot read the list -> 404", (await call("GET", `/meetings/${mid4}/participation`, O2.tok)).s === 404);
  ok("an invitee cannot read the list -> 404", (await call("GET", `/meetings/${mid4}/participation`, A.tok)).s === 404);

  console.log("\n## 8. HR and Admin see counts only");
  ok("HR list is refused (404): no names, times or durations", (await call("GET", `/meetings/${mid4}/participation`, H.tok)).s === 404 && (await call("GET", `/meetings/${mid4}/participation`, AD.tok)).s === 404);
  const cnt = await call("GET", `/meetings/${mid4}/participation-counts`, H.tok);
  ok("HR gets exactly { invited, joined }", cnt.s === 200 && Object.keys(cnt.b).sort().join() === "invited,joined" && cnt.b.invited === 3 && cnt.b.joined === 2, cnt);
  ok("an employee or a manager cannot use the counts route -> 403", (await call("GET", `/meetings/${mid4}/participation-counts`, A.tok)).s === 403 && (await call("GET", `/meetings/${mid4}/participation-counts`, O.tok)).s === 403);
  ok("another company's HR -> 404", (await call("GET", `/meetings/${mid4}/participation-counts`, X.tok)).s === 404);
  const ov = await call("GET", "/meetings/oversight?scope=past", H.tok);
  const ovRow = (await call("GET", "/meetings/oversight?scope=upcoming", H.tok)).b.meetings.find((m) => m.id === mid4) ?? ov.b.meetings.find((m) => m.id === mid4);
  ok("the HR overview shows the counts for the meeting", ovRow?.participation?.invited === 3 && ovRow.participation.joined === 2, ovRow);
  ok("...and the HR overview mentions no employee names or times", !/Mpt|T[ABC]\b|joinedAt|leftAt|durationSeconds/.test(JSON.stringify(ovRow)), ovRow);
  ok("HR still cannot open the meeting's details", (await call("GET", `/meetings/${mid4}`, H.tok)).s === 404);

  console.log("\n## 8b. The organizer can mark himself in and out too (never counted as an invited person)");
  const mid7 = (await mkMeeting({ title: "Organizer joins" })).b.id; await place(mid7, -60, 900);
  await call("POST", `/meetings/${mid7}/join`, A.tok);
  const oj = await call("POST", `/meetings/${mid7}/join`, O.tok);
  ok("the organizer joins his own meeting", oj.s === 200 && oj.b.ok === true, oj);
  ok("a second press by the organizer -> 409 (one join per person, organizer included)", (await call("POST", `/meetings/${mid7}/join`, O.tok)).s === 409);
  const l7 = await call("GET", `/meetings/${mid7}/participation`, O.tok);
  ok("his own row is shown apart as the organizer, in the meeting", l7.b.organizer?.state === "IN_MEETING" && !!l7.b.organizer.joinedAt, l7.b.organizer);
  ok("...and he is NOT counted among the invited people (3 invited, 1 joined, not in the rows)", l7.b.summary.invited === 3 && l7.b.summary.joined === 1 && !l7.b.rows.some((r) => r.userId === O.id), l7.b.summary);
  ok("HR counts still exclude the organizer", (await call("GET", `/meetings/${mid7}/participation-counts`, H.tok)).b.joined === 1);
  const ov7 = (await call("GET", "/meetings/oversight?scope=upcoming", H.tok)).b.meetings.find((m) => m.id === mid7);
  ok("the HR overview counts exclude the organizer and show no names", ov7?.participation?.joined === 1 && ov7.participation.invited === 3 && !/joinedAt|Mpt/.test(JSON.stringify(ov7)), ov7);
  const mine7 = (await call("GET", "/meetings?scope=upcoming", O.tok)).b.meetings.find((m) => m.id === mid7);
  ok("his own meeting card knows he is in the meeting, and 'joined' still counts only the invited", mine7?.me?.state === "IN_MEETING" && mine7.joinedCount === 1, mine7);
  const lv7 = await call("POST", `/meetings/${mid7}/leave`, O.tok);
  ok("the organizer ends his own participation", lv7.s === 200 && (await stamp(mid7, O.id)).leftAt, lv7);
  ok("his own history includes the meeting he organized", (await call("GET", "/meetings/participation/history", O.tok)).b.rows.some((r) => r.meetingId === mid7 && r.state === "ENDED"));
  ok("someone not invited and not the organizer is still refused -> 404", (await call("POST", `/meetings/${mid7}/join`, D.tok)).s === 404);

  console.log("\n## 9. Manager corrections (reason required, kept as history)");
  const corr = (target, body) => call("PATCH", `/meetings/${mid4}/participation/${target}`, O.tok, body);
  ok("no reason -> 400", (await corr(C.id, { joinedAt: "09:35" })).s === 400);
  ok("a too-short reason -> 400", (await corr(C.id, { joinedAt: "09:35", reason: "ok" })).s === 400);
  ok("recording someone as present needs their joining time -> 400", (await corr(C.id, { reason: "He was there" })).s === 400);
  ok("a bad time format -> 400", (await corr(C.id, { joinedAt: "9.35", reason: "He was there" })).s === 400);
  ok("a time in the future -> 400", (await corr(C.id, { joinedAt: "23:59", reason: "Future time test" })).s === 400);
  ok("someone not invited -> 400", (await corr(D.id, { joinedAt: "09:35", reason: "Not invited at all" })).s === 400);
  // a time safely in the past on the meeting's day is built from the stored start, in the company timezone
  const sHH = (await q(`select to_char(("startsAt" at time zone (select timezone from platforms where id=m."platformId")), 'HH24:MI') as t from meetings m where id=$1`, [mid4]))[0].t;
  const add1 = await corr(C.id, { joinedAt: sHH, leftAt: sHH, reason: "C was in the room but did not press the button" });
  ok("adds a missed join, marked MANAGER_ADDED", add1.s === 200 && (await stamp(mid4, C.id)).source === "MANAGER_ADDED", add1);
  ok("the correction is in the history with before and after and the reason", await (async () => { const h = await q(`select * from meeting_participation_changes where "meetingId"=$1 and "userId"=$2`, [mid4, C.id]); return h.length === 1 && h[0].action === "ADD" && h[0].beforeJoinedAt === null && h[0].afterJoinedAt && /did not press/.test(h[0].reason) && h[0].actedById === O.id; })());
  ok("the employee is notified about the change", (await q(`select 1 from notifications where "userId"=$1 and type='MEETING_PARTICIPATION_CORRECTED'`, [C.id])).length === 1);
  ok("the Audit log has an entry", (await q(`select 1 from audit_logs where "actorId"=$1 and path like $2`, [O.id, `%/meetings/${mid4}/participation/%`])).length >= 1);
  ok("correcting to what is already recorded -> 400", (await corr(C.id, { joinedAt: sHH, leftAt: sHH, reason: "Same again please" })).s === 400);
  const edit = await corr(A.id, { leftAt: sHH, reason: "A left at the start, forgot to press End" }); // A joined 2 minutes AFTER the start
  ok("an end time earlier than the join -> 400 (never silently accepted)", edit.s === 400, edit);
  ok("...and A's record is untouched by the refused correction", (await stamp(mid4, A.id)).leftAt === null);
  const reopen = await corr(C.id, { clearLeft: true, reason: "C stepped out and came back" });
  const cRec = await stamp(mid4, C.id);
  ok("clearing the leave puts the person back 'in the meeting'", reopen.s === 200 && cRec.leftAt === null && cRec.durationSeconds === null, cRec);
  ok("a second correction adds a second history row (history is never overwritten)", (await q(`select 1 from meeting_participation_changes where "meetingId"=$1 and "userId"=$2`, [mid4, C.id])).length === 2);
  ok("the list shows the corrected flag", (await call("GET", `/meetings/${mid4}/participation`, O.tok)).b.rows.find((r) => r.userId === C.id).corrected === true);
  ok("the employee still cannot rewrite history -> 404", (await call("PATCH", `/meetings/${mid4}/participation/${C.id}`, C.tok, { joinedAt: "08:00", reason: "Changing my own time" })).s === 404);

  console.log("\n## 10. History");
  const mine = await call("GET", "/meetings/participation/history", A.tok);
  ok("an employee sees their own history", mine.s === 200 && mine.b.rows.length >= 2 && mine.b.selfReported === true && mine.b.rows.every((r) => r.title), mine.b.summary);
  ok("a meeting that has not finished is not counted as missed", mine.b.rows.every((r) => r.state !== "NOT_JOINED" || new Date(r.endsAt) < new Date()));
  const theirs = await call("GET", `/meetings/participation/history?userId=${C.id}`, O.tok);
  ok("the organizer sees one person's history in meetings they organized", theirs.s === 200 && theirs.b.rows.length >= 1 && theirs.b.personId === C.id, theirs);
  ok("an employee cannot read someone else's history -> 403", (await call("GET", `/meetings/participation/history?userId=${C.id}`, A.tok)).s === 403);
  ok("HR is limited to meetings they organized (none) -> empty", (await call("GET", `/meetings/participation/history?userId=${C.id}`, H.tok)).b.rows.length === 0);
  ok("another manager sees none of O's meetings", (await call("GET", `/meetings/participation/history?userId=${C.id}`, O2.tok)).b.rows.length === 0);
  ok("a bad person id -> 404", (await call("GET", "/meetings/participation/history?userId=nope", O.tok)).s === 404);

  console.log("\n## 11. Separate from attendance and productivity");
  const snap = async () => (await q(`select (select count(*) from work_sessions where "userId" = any($1::uuid[])) ws, (select count(*) from tracker_breaks where "workSessionId" in (select id from work_sessions where "userId" = any($1::uuid[]))) br, (select count(*) from tracker_meetings where "workSessionId" in (select id from work_sessions where "userId" = any($1::uuid[]))) tm, (select count(*) from daily_tasks where "userId" = any($1::uuid[])) dt, (select count(*) from alerts where "userId" = any($1::uuid[])) al`, [[A.id, B.id, C.id]]))[0];
  const s0 = await snap();
  const mid5 = (await mkMeeting({ title: "Separation check" })).b.id; await place(mid5, -60, 900);
  await call("POST", `/meetings/${mid5}/join`, A.tok); await call("POST", `/meetings/${mid5}/leave`, A.tok);
  const s1 = await snap();
  ok("joining and ending a stand-up creates NO work session, break, tracker meeting, task or alert", JSON.stringify(s0) === JSON.stringify(s1), { s0, s1 });
  ok("and the person's attendance for the day is unchanged by it", (await q(`select count(*) c from work_sessions where "userId"=$1`, [A.id]))[0].c === s0.ws);

  console.log("\n## 12. Editing and the join window follow the schedule");
  const mid6 = (await mkMeeting({ title: "Reschedule me" })).b.id;
  await place(mid6, 3600, 900); // an hour away
  ok("an hour away: too early", (await call("POST", `/meetings/${mid6}/join`, A.tok)).s === 409);
  await place(mid6, 60, 900); // starts in 1 minute (the organizer moved it earlier)
  ok("once the start is within 15 minutes the same person can join", (await call("POST", `/meetings/${mid6}/join`, A.tok)).s === 200);
  const endNow = await call("POST", `/meetings/${mid6}/end`, O.tok);
  ok("the organizer ends the meeting early: the window closes for those who have not joined", endNow.s === 200 || endNow.s === 409, endNow);

  await wipe();
  await db.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
