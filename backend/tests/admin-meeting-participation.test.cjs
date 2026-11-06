// Admin reads who joined a huddle and when (names and times), read-only; HR keeps counts only; the organizer is unchanged.
// Disposable database only (see _guard.cjs).
//
//   cd backend && TEST_DATABASE_URL=... TEST_API=http://localhost:5012/api node tests/admin-meeting-participation.test.cjs
require("dotenv").config({ path: require("node:path").join(__dirname, "..", ".env") });
const { Client } = require("pg");
const bcrypt = require("bcryptjs");
const API = process.env.TEST_API ?? "http://localhost:5002/api";
require("./_guard.cjs").assertTestDb(process.env.TEST_DATABASE_URL);

const call = async (m, p, t, body) => {
  const r = await fetch(API + p, { method: m, headers: { ...(t ? { authorization: "Bearer " + t } : {}), ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const txt = await r.text(); let j; try { j = JSON.parse(txt); } catch { j = txt; }
  return { s: r.status, b: j };
};
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  -> " + String(JSON.stringify(x)).slice(0, 400))); };
const PW = "Amp@12345678";
const add = (s, n) => new Date(new Date(s + "T00:00:00Z").getTime() + n * 864e5).toISOString().slice(0, 10);

(async () => {
  const db = new Client({ connectionString: process.env.TEST_DATABASE_URL }); await db.connect();
  const q = async (s, p) => (await db.query(s, p)).rows;
  const AV = (await q(`select id from platforms where slug='avatar'`))[0].id;
  const AVN = (await q(`select id from platforms where slug='avance'`))[0].id;
  const hash = await bcrypt.hash(PW, 10);
  const wipe = async () => {
    const ids = `(select id from users where "employeeCode" like 'AMP-%')`;
    await q(`delete from meeting_participation_changes where "meetingId" in (select id from meetings where "organizerId" in ${ids})`);
    await q(`delete from meeting_participation where "meetingId" in (select id from meetings where "organizerId" in ${ids})`);
    await q(`delete from meeting_responses where "meetingId" in (select id from meetings where "organizerId" in ${ids})`).catch(() => {});
    await q(`delete from meeting_tracking where "meetingId" in (select id from meetings where "organizerId" in ${ids})`);
    await q(`delete from meeting_attendees where "meetingId" in (select id from meetings where "organizerId" in ${ids})`);
    await q(`delete from meetings where "organizerId" in ${ids}`);
    await q(`delete from notifications where "userId" in ${ids}`);
    await q(`delete from audit_logs where "userId" in ${ids}`).catch(() => {});
    await q(`delete from users where "employeeCode" like 'AMP-%'`);
  };
  await wipe();
  const mk = async (code, role, platformId, reportsToId = null) => {
    await q(`insert into users (id,"platformId",email,"passwordHash","firstName","lastName","employeeCode",role,status,"mustChangePassword","trackerAccessEnabled","onboardingStatus","reportsToId","dateOfJoining","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,$4,'Amp',$5,$6,'ACTIVE',false,true,'ACTIVE',$7,'2026-01-01',now(),now())`, [platformId, code.toLowerCase() + "@amp.test", hash, code.replace("AMP-", "P"), code, role, reportsToId]);
    const id = (await q(`select id from users where "employeeCode"=$1`, [code]))[0].id;
    const tok = (await (await fetch(API + "/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: code, password: PW }) })).json()).token;
    return { id, tok };
  };
  const AD = await mk("AMP-AD", "ADMIN", AV), ADB = await mk("AMP-ADB", "ADMIN", AVN), HR = await mk("AMP-HR", "HR", AV);
  const M = await mk("AMP-M", "MANAGER", AV, AD.id), M2 = await mk("AMP-M2", "MANAGER", AV, AD.id);
  const A = await mk("AMP-A", "EMPLOYEE", AV, M.id), B = await mk("AMP-B", "EMPLOYEE", AV, M.id);
  const today = (await call("GET", "/tracker/timesheet", A.tok)).b.today;

  const created = await call("POST", "/meetings", M.tok, { title: "Admin-visible huddle", date: add(today, 1), startTime: "09:30", endTime: "09:45", attendeeIds: [A.id, B.id], inPerson: true, lateAfterMinutes: 5 });
  const mid = created.b.id;
  ok("the manager schedules a tracked huddle", created.s === 200 && !!mid, created);
  // put the meeting around "now" so people can join
  await q(`update meetings set "startsAt" = now() - interval '6 minutes', "endsAt" = now() + interval '20 minutes' where id=$1`, [mid]);
  for (const u of [A, B]) ok("the invited person accepts", (await call("POST", `/meetings/${mid}/respond`, u.tok, { response: "ACCEPTED" })).s === 200);
  ok("A joins", (await call("POST", `/meetings/${mid}/join`, A.tok)).s === 200);
  ok("A ends", (await call("POST", `/meetings/${mid}/leave`, A.tok)).s === 200);
  ok("B joins", (await call("POST", `/meetings/${mid}/join`, B.tok)).s === 200);

  console.log("\n## Admin: names and times, read-only");
  const adm = await call("GET", `/meetings/${mid}/participation`, AD.tok);
  ok("the Admin can open the participant list", adm.s === 200 && adm.b.readOnly === true, adm);
  const rowA = adm.b.rows?.find((r) => r.userId === A.id), rowB = adm.b.rows?.find((r) => r.userId === B.id);
  ok("it shows names, join and leave times and duration", rowA?.name === "PA Amp" && !!rowA.joinedAt && !!rowA.leftAt && typeof rowA.durationSeconds === "number" && rowA.state === "ENDED", rowA);
  ok("it shows who is still in the meeting", rowB?.state === "IN_MEETING" && !!rowB.joinedAt && rowB.leftAt === null, rowB);
  ok("the organizer is named, apart from the people invited", adm.b.organizer?.userId === M.id && /PM/.test(adm.b.organizer.name) && adm.b.summary.invited === 2, adm.b.organizer);
  ok("the Admin cannot correct anyone's record (404)", (await call("PATCH", `/meetings/${mid}/participation/${A.id}`, AD.tok, { leftAt: "10:00", reason: "Admin trying to edit" })).s === 404);
  ok("nothing was changed by looking", (await q(`select count(*)::int n from meeting_participation_changes where "meetingId"=$1`, [mid]))[0].n === 0);

  console.log("\n## everyone else is as before");
  const own = await call("GET", `/meetings/${mid}/participation`, M.tok);
  ok("the organizer still sees and corrects (not read-only)", own.s === 200 && own.b.readOnly === false);
  ok("HR still cannot open the participant list (counts only)", (await call("GET", `/meetings/${mid}/participation`, HR.tok)).s === 404);
  const cnt = await call("GET", `/meetings/${mid}/participation-counts`, HR.tok);
  ok("HR still gets the counts", cnt.s === 200 && cnt.b.invited === 2 && cnt.b.joined === 2 && !JSON.stringify(cnt.b).includes("PA Amp"), cnt);
  ok("another manager cannot open it (404)", (await call("GET", `/meetings/${mid}/participation`, M2.tok)).s === 404);
  ok("an invited employee cannot open the list (404)", (await call("GET", `/meetings/${mid}/participation`, A.tok)).s === 404);
  ok("an Admin of another company cannot open it (404)", (await call("GET", `/meetings/${mid}/participation`, ADB.tok)).s === 404);
  ok("no sign-in = 401", (await call("GET", `/meetings/${mid}/participation`)).s === 401);

  console.log("\n## one person's participation history");
  const h = await call("GET", `/meetings/participation/history?userId=${A.id}`, AD.tok);
  ok("the Admin can read a person's history across the company", h.s === 200 && h.b.rows.some((r) => r.meetingId === mid && !!r.joinedAt && !!r.leftAt), h);
  const hHr = await call("GET", `/meetings/participation/history?userId=${A.id}`, HR.tok);
  ok("HR still only sees meetings HR organized (none here)", hHr.s === 200 && hHr.b.rows.length === 0, hHr);
  const hOther = await call("GET", `/meetings/participation/history?userId=${A.id}`, ADB.tok);
  ok("an Admin of another company sees nothing of this person", hOther.s === 200 && hOther.b.rows.length === 0, hOther);
  ok("an employee cannot read a colleague's history (403)", (await call("GET", `/meetings/participation/history?userId=${B.id}`, A.tok)).s === 403);

  await wipe();
  await db.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
