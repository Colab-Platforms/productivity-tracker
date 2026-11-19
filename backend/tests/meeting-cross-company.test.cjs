// A manager's team can include people of ANOTHER company. They must (1) be offered in the invite list, (2) receive the invitation and be able to
// see, accept, join and end the huddle, (3) appear in the manager's participation list, history and corrections, (4) never be reachable by a
// manager who does not manage them, and (5) leave HR / ordinary employees exactly as before.
// Disposable database only (see _guard.cjs).
//
//   cd backend && TEST_DATABASE_URL=... TEST_API=http://localhost:5012/api node tests/meeting-cross-company.test.cjs
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
const PW = "Xco@12345678";

(async () => {
  const db = new Client({ connectionString: process.env.TEST_DATABASE_URL }); await db.connect();
  const q = async (s, p) => (await db.query(s, p)).rows;
  const AV = (await q(`select id from platforms where slug='avatar'`))[0].id;
  const AVN = (await q(`select id from platforms where slug='take-health'`))[0].id;
  const hash = await bcrypt.hash(PW, 10);

  const wipe = async () => {
    const ids = `(select id from users where "employeeCode" like 'XCO-%')`;
    await q(`delete from meetings where "organizerId" in ${ids}`);
    await q(`delete from notifications where "userId" in ${ids}`);
    await q(`delete from users where "employeeCode" like 'XCO-%'`);
  };
  await wipe();
  const mk = async (code, role, platformId, reportsToId = null) => {
    await q(`insert into users (id,"platformId",email,"passwordHash","firstName","lastName","employeeCode",role,status,"mustChangePassword","trackerAccessEnabled","onboardingStatus","reportsToId","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,$4,'Xco',$5,$6,'ACTIVE',false,true,'ACTIVE',$7,now(),now())`, [platformId, code.toLowerCase() + "@xco.test", hash, code.replace("XCO-", "T"), code, role, reportsToId]);
    const id = (await q(`select id from users where "employeeCode"=$1`, [code]))[0].id;
    const tok = (await call("POST", "/auth/login", null, { email: code, password: PW })).b.token;
    return { id, tok };
  };
  const M = await mk("XCO-M", "MANAGER", AV);           // the manager (company A)
  const Y = await mk("XCO-Y", "EMPLOYEE", AV, M.id);    // same company, reports to M
  const X = await mk("XCO-X", "EMPLOYEE", AVN, M.id);   // OTHER company, reports to M
  const Z = await mk("XCO-Z", "EMPLOYEE", AV);          // same company, does NOT report to M
  const W = await mk("XCO-W", "EMPLOYEE", AVN);         // other company, does NOT report to M
  const MB = await mk("XCO-MB", "MANAGER", AVN);        // another manager (company B)
  const HR = await mk("XCO-HR", "HR", AV);

  // --- the invite list ---------------------------------------------------------------------------------------------------
  const ppl = await call("GET", "/meetings/people", M.tok);
  const codes = (ppl.b.people ?? []).map((p) => p.employeeCode);
  ok("the list holds the person who reports to him in ANOTHER company", codes.includes("XCO-X"), codes);
  ok("the list holds the person of his own company who reports to him", codes.includes("XCO-Y"), codes);
  ok("a person who does not report to him is not listed (own company)", !codes.includes("XCO-Z"), codes);
  ok("a person who does not report to him is not listed (other company)", !codes.includes("XCO-W"), codes);
  const pplB = await call("GET", "/meetings/people", MB.tok);
  const codesB = (pplB.b.people ?? []).map((p) => p.employeeCode);
  ok("another manager does not get X offered", !codesB.includes("XCO-X") && !codesB.includes("XCO-Y"), codesB);
  ok("an employee cannot open the invite list", (await call("GET", "/meetings/people", X.tok)).s === 403);

  // --- inviting ----------------------------------------------------------------------------------------------------------
  const day = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const mkMeeting = (ids, extra = {}) => call("POST", "/meetings", M.tok, { title: "Cross-company huddle", date: day, startTime: "10:00", endTime: "11:00", attendeeIds: ids, ...extra });
  const bad = await mkMeeting([Z.id]);
  ok("inviting a person he does not manage is refused", bad.s >= 400, bad);
  const bad2 = await mkMeeting([W.id]);
  ok("inviting another company's person he does not manage is refused", bad2.s >= 400, bad2);
  const made = await mkMeeting([X.id, Y.id]);
  ok("a group meeting with a person of another company is created", made.s === 201 || made.s === 200, made);
  const id = made.b.meeting?.id ?? made.b.id;
  ok("tracking is on (Team Huddle) without ticking anything", !!(await q(`select 1 from meeting_tracking where "meetingId"=$1`, [id])).length);
  const one = await mkMeeting([X.id]);
  ok("a one-to-one with a person of another company is created", one.s === 201 || one.s === 200, one);

  // --- the invited person of the other company receives and sees it ---------------------------------------------------
  const notes = await q(`select type from notifications where "userId"=$1`, [X.id]);
  ok("X got the invitation notification", notes.some((n) => n.type === "MEETING_INVITED"), notes);
  const xList = await call("GET", "/meetings?scope=upcoming", X.tok);
  ok("X sees the meeting in his list", (xList.b.meetings ?? []).some((m) => m.id === id), xList.b);
  ok("X's count includes it", xList.b.counts?.upcoming >= 1, xList.b.counts);
  ok("X can open the meeting", (await call("GET", "/meetings/" + id, X.tok)).s === 200);
  ok("a person not invited cannot open it (404)", (await call("GET", "/meetings/" + id, W.tok)).s === 404);
  ok("another manager cannot open it (404)", (await call("GET", "/meetings/" + id, MB.tok)).s === 404);
  ok("Z (not invited, same company as the organizer) cannot open it", (await call("GET", "/meetings/" + id, Z.tok)).s === 404);

  // make it live: started 3 minutes ago, ends in 30
  await q(`update meetings set "startsAt"=now() - interval '3 minutes', "endsAt"=now() + interval '30 minutes' where id=$1`, [id]);
  const r1 = await call("POST", `/meetings/${id}/respond`, X.tok, { response: "ACCEPTED" });
  ok("X accepts, which joins the live huddle", r1.s === 200 && r1.b.joinedAt, r1);
  const row = (await q(`select "platformId" from meeting_participation where "meetingId"=$1 and "userId"=$2`, [id, X.id]))[0];
  ok("X's participation record belongs to X's own company", row?.platformId === AVN, row);
  ok("Y accepts and joins", (await call("POST", `/meetings/${id}/respond`, Y.tok, { response: "ACCEPTED" })).s === 200);

  // --- the manager's list and corrections ---------------------------------------------------------------------------------
  const lst = await call("GET", `/meetings/${id}/participation`, M.tok);
  const rows = lst.b.rows ?? [];
  const xr = rows.find((r) => r.employeeCode === "XCO-X");
  ok("the manager's participation list includes X (other company), joined", xr && xr.state === "IN_MEETING", lst.b);
  ok("it counts both invitees", lst.b.summary?.invited === 2 && lst.b.summary?.joined === 2, lst.b.summary);
  ok("MB sees nothing of it", (await call("GET", `/meetings/${id}/participation`, MB.tok)).s >= 400);

  const end = await call("POST", `/meetings/${id}/leave`, X.tok);
  ok("X can end the huddle (not blocked by company)", end.s === 200, end);
  const hist = await call("GET", "/meetings/participation/history", X.tok);
  ok("X's own history shows the huddle", (hist.b.rows ?? []).some((r) => r.meetingId === id && r.state === "ENDED"), hist.b);
  const histM = await call("GET", `/meetings/participation/history?userId=${X.id}`, M.tok);
  ok("the manager reads X's history in his meetings", (histM.b.rows ?? []).some((r) => r.meetingId === id), histM.b);
  ok("another manager cannot read X's history", (await call("GET", `/meetings/participation/history?userId=${X.id}`, MB.tok)).b.rows?.length === 0 || (await call("GET", `/meetings/participation/history?userId=${X.id}`, MB.tok)).s >= 400);

  // correction of someone who never joined: a second one-to-one meeting (X invited, never pressed anything)
  const oneId = one.b.meeting?.id ?? one.b.id;
  await q(`update meetings set "startsAt"=now() - interval '40 minutes', "endsAt"=now() - interval '10 minutes' where id=$1`, [oneId]);
  const t = (mins) => new Date(Date.now() - mins * 60_000);
  const hhmm = (d) => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
  const cor = await call("PATCH", `/meetings/${oneId}/participation/${X.id}`, M.tok, { joinedAt: hhmm(t(35)), leftAt: hhmm(t(15)), reason: "Was in the room, forgot to press Join" });
  ok("the manager can record X (other company) with a reason", cor.s === 200, cor);
  const rec = (await q(`select "platformId", source from meeting_participation where "meetingId"=$1 and "userId"=$2`, [oneId, X.id]))[0];
  ok("the added record belongs to X's company", rec && rec.platformId === AVN && rec.source === "MANAGER_ADDED", rec);
  const noted = await q(`select 1 from notifications where "userId"=$1 and type='MEETING_PARTICIPATION_CORRECTED'`, [X.id]);
  ok("X is told about the correction", noted.length === 1);
  const xAfter = await call("GET", "/meetings/participation/history", X.tok);
  ok("the corrected record is in X's history", (xAfter.b.rows ?? []).some((r) => r.meetingId === oneId && r.state === "ENDED"), xAfter.b);

  // --- the manager's overview and the HR counts --------------------------------------------------------------------------
  const ov = await call("GET", "/meetings/huddles/overview", M.tok);
  const names = (ov.b.people ?? []).map((p) => p.employeeCode);
  ok("the huddle overview lists X", names.includes("XCO-X"), names);
  const cnt = await call("GET", `/meetings/${id}/participation-counts`, HR.tok);
  ok("HR still gets counts only for a meeting of her own company", cnt.s === 200 && cnt.b.invited === 2 && cnt.b.rows === undefined, cnt);
  ok("HR cannot read names/times", (await call("GET", `/meetings/${id}/participation`, HR.tok)).s >= 400);
  ok("HR's invite list is her own company, as before", (await call("GET", "/meetings/people", HR.tok)).b.people?.every((p) => p.employeeCode !== "XCO-X"));

  await wipe();
  await db.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
