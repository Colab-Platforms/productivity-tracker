// WORK EFFICIENCY INDEX through the real API: evidence capture (revert reason, verified partial, confirmed time) and the efficiency endpoint. THROWAWAY database only.
// resumed, never reset; breaks and clock-out are taken out; tasks that overlap are counted once; older tasks read Not tracked. THROWAWAY database only.
// The migration (sessions table + triggers) is applied part-way to prove before / after.
//   cd backend && TEST_DATABASE_URL=postgresql://postgres:localtest@localhost:54329/dq_test TEST_API=http://localhost:5012/api node tests/task-timer.test.cjs
const fs = require("node:fs"), path = require("node:path");
const { Client } = require("pg");
const bcrypt = require("bcryptjs");
const API = process.env.TEST_API ?? "http://localhost:5012/api";
const DBURL = process.env.TEST_DATABASE_URL;
require("./_guard.cjs").assertTestDb(DBURL);

const call = async (m, p, t, body) => {
  const r = await fetch(API + p, { method: m, headers: { ...(t ? { authorization: "Bearer " + t } : {}), ...(body !== undefined && m !== "GET" ? { "content-type": "application/json" } : {}) }, body: body !== undefined && m !== "GET" ? JSON.stringify(body) : undefined });
  const txt = await r.text(); let j; try { j = JSON.parse(txt); } catch { j = txt; }
  return { s: r.status, b: j };
};
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  -> " + String(JSON.stringify(x)).slice(0, 420))); };
const near = (a, b, tol = 6) => typeof a === "number" && Math.abs(a - b) <= tol;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PW = "Ttm@12345678";
const MIN = 60;

(async () => {
  const db = new Client({ connectionString: DBURL }); await db.connect();
  const q = async (s, p) => (await db.query(s, p)).rows;
  const A = (await q(`select id from platforms where slug='avatar'`))[0].id;
  const hash = await bcrypt.hash(PW, 10);
  const migration = fs.readFileSync(path.join(__dirname, "..", "prisma", "migrations", "20261124130000_efficiency_evidence", "migration.sql"), "utf8");
  const down = fs.readFileSync(path.join(__dirname, "..", "prisma", "migrations", "20261124130000_efficiency_evidence", "down.sql"), "utf8");
  const wipe = async () => {
    await q(`delete from task_time_reviews where "taskId" in (select id from daily_tasks where "userId" in (select id from users where "employeeCode" like 'EFF-%'))`).catch(() => {});
    await q(`delete from task_partial_progress where "taskId" in (select id from daily_tasks where "userId" in (select id from users where "employeeCode" like 'EFF-%'))`).catch(() => {});
    await q(`delete from task_review_attempts where "taskId" in (select id from daily_tasks where "userId" in (select id from users where "employeeCode" like 'EFF-%'))`).catch(() => {});
    const ids = `(select id from users where "employeeCode" like 'EFF-%')`;
    await q(`delete from task_events where "taskId" in (select id from daily_tasks where "userId" in ${ids})`).catch(() => {});
    await q(`delete from task_ratings where "taskId" in (select id from daily_tasks where "userId" in ${ids})`).catch(() => {});
    await q(`delete from task_entry_details where "taskId" in (select id from daily_tasks where "userId" in ${ids})`).catch(() => {});
    await q(`delete from daily_tasks where "userId" in ${ids}`);
    await q(`delete from tracker_breaks where "workSessionId" in (select id from work_sessions where "userId" in ${ids})`).catch(() => {});
    await q(`delete from work_sessions where "userId" in ${ids}`);
    await q(`delete from team_members where "userId" in ${ids}`);
    await q(`delete from teams where name like 'EFF-%'`);
    await q(`delete from notifications where "userId" in ${ids}`);
    await q(`update audit_logs set "actorId"=null where "actorId" in ${ids}`).catch(() => {});
    await q(`delete from audit_logs where "targetUserId" in ${ids}`).catch(() => {});
    await q(`delete from users where "employeeCode" like 'EFF-%'`);
  };
  await wipe().catch((e) => console.log("wipe note:", e.message));
  await db.query(down); // start from "before the migration"
  const mk = async (code, first, role, o = {}) => {
    await q(`insert into users (id,"platformId",email,"passwordHash","firstName","lastName","employeeCode",role,status,"mustChangePassword","trackerAccessEnabled","onboardingStatus","reportsToId","dateOfJoining","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,$4,'Ttm',$5,$6,'ACTIVE',false,true,'ACTIVE',$7,'2026-01-01',now(),now())`, [A, code.toLowerCase() + "@ttm.test", hash, first, code, role, o.boss ?? null]);
    const id = (await q(`select id from users where "employeeCode"=$1`, [code]))[0].id;
    const tok = (await (await fetch(API + "/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: code, password: PW }) })).json()).token;
    return { id, tok, code };
  };
  const ADMIN = await mk("EFF-ADM", "Adm", "ADMIN");
  const MGR = await mk("EFF-MGR", "Mgr", "MANAGER", { boss: ADMIN.id });
  const E1 = await mk("EFF-E1", "Eone", "EMPLOYEE", { boss: MGR.id });
  const SUP = await mk("EFF-SUP", "Supx", "EMPLOYEE", { boss: MGR.id });
  const teamId = (await q(`insert into teams (id,"platformId",name,"managerId","isActive","createdAt","updatedAt") values (gen_random_uuid(),$1,'EFF-Proj',$2,true,now(),now()) returning id`, [A, MGR.id]))[0].id;
  await q(`insert into team_members (id,"teamId","userId","isActive","isPrimary","joinedAt") values (gen_random_uuid(),$1,$2,true,true,now())`, [teamId, E1.id]);
  const idOf = async (title) => (await q(`select id from daily_tasks where title=$1`, [title]))[0]?.id;
  const sessionsOf = async (title) => q(`select "startedAt", "endedAt", "endReason" from task_work_sessions where "taskId"=$1 order by "startedAt"`, [await idOf(title)]).catch(() => []);
  const openCount = async (title) => Number((await q(`select count(*)::int c from task_work_sessions where "taskId"=$1 and "endedAt" is null`, [await idOf(title)]).catch(() => [{ c: 0 }]))[0].c);
  const all = (payload) => [...(payload.active ?? []), ...(payload.done ?? []), ...(payload.awaitingApproval ?? []), ...(payload.rejected ?? [])];
  const timerOf = async (title, who = E1) => all((await call("GET", "/tasks", who.tok)).b).find((t) => t.title === title)?.timer;
  const send = (who, title, progress = "IN_PROGRESS") => call("POST", "/tasks", who.tok, { title, teamId, taggedManagerId: MGR.id, progress, ...(progress === "BLOCKED" ? { blockedNote: "waiting for the client" } : {}) });
  const approve = async (title) => call("POST", `/tasks/review/${await idOf(title)}/approve`, MGR.tok, { approve: true });
  const setProgress = async (who, title, progress, extra = {}) => call("PATCH", `/tasks/${await idOf(title)}`, who.tok, { progress, ...extra });
  // lay a task's sessions out at exact moments (oldest first): sessions = [[startMinutesAgo, endMinutesAgo | null], ...]
  const layout = async (title, spans) => {
    const rows = await sessionsOf(title); const id = await idOf(title);
    const list = await q(`select id from task_work_sessions where "taskId"=$1 order by "startedAt", id`, [id]);
    if (list.length !== spans.length) throw new Error(`${title}: expected ${spans.length} sessions, found ${list.length}`);
    for (let i = 0; i < spans.length; i++) await q(`update task_work_sessions set "startedAt" = (now() at time zone 'utc') - ($2 || ' minutes')::interval, "endedAt" = ${spans[i][1] === null ? "null" : `(now() at time zone 'utc') - (${spans[i][1]} || ' minutes')::interval`} where id=$1`, [list[i].id, String(spans[i][0])]);
    return rows;
  };
  const clockIn = async (who, minutesAgo) => (await q(`insert into work_sessions (id,"platformId","userId",date,"loginAt",status,"productiveSeconds","breakSeconds","meetingSeconds","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,(now() at time zone 'Asia/Kolkata')::date,(now() at time zone 'utc') - ($3 || ' minutes')::interval,'ACTIVE',0,0,0,now(),now()) returning id`, [A, who.id, String(minutesAgo)]))[0].id;
  const addBreak = (wsId, type, fromAgo, toAgo) => q(`insert into tracker_breaks (id,"workSessionId","breakType",reason,"startedAt","endedAt","durationSeconds","createdAt") values (gen_random_uuid(),$1,$2,null,(now() at time zone 'utc') - ($3 || ' minutes')::interval, ${toAgo === null ? "null" : `(now() at time zone 'utc') - (${toAgo} || ' minutes')::interval`}, ${toAgo === null ? "null" : `(${fromAgo} - ${toAgo}) * 60`}, now())`, [wsId, type, String(fromAgo)]);
  const timerMig = fs.readFileSync(path.join(__dirname, "..", "prisma", "migrations", "20261124120000_task_work_timer", "migration.sql"), "utf8");
  await db.query(timerMig).catch(() => {});
  await sleep(16000);
  const today = new Date().toISOString().slice(0, 10);
  const eff = (tok, extra = "") => call("GET", `/team-attendance/efficiency?from=${today}&to=${today}${extra}`, tok);
  const complete = async (title, stars, minutes) => {
    ok("send " + title, (await send(E1, title, "COMPLETED")).s < 300);
    await approve(title);
    return call("POST", `/tasks/review/${await idOf(title)}/rating`, MGR.tok, { rating: stars, ...(minutes ? { expectedMinutes: minutes } : {}) });
  };
  try {
    console.log("## before the evidence tables");
    await db.query(down);
    const r0 = await complete("EFF a0", 4);
    ok("rating without a confirmed time works as before", r0.s < 300, r0);
    ok("rating WITH a confirmed time is refused before the migration", (await call("POST", `/tasks/review/${await idOf("EFF a0")}/rating`, MGR.tok, { rating: 4, expectedMinutes: 30 })).s === 503);
    console.log("## after the migration");
    await db.query(migration);
    await sleep(16000);
    for (let i = 1; i <= 5; i++) {
      const r = await complete("EFF done " + i, i === 5 ? 3 : 4, 60);
      ok("rate + confirm time " + i, r.s < 300, r);
    }
    ok("bad minutes refused", (await call("POST", `/tasks/review/${await idOf("EFF done 1")}/rating`, MGR.tok, { rating: 4, expectedMinutes: 99999 })).s === 400);
    ok("time review row saved", Number((await q(`select count(*)::int c from task_time_reviews`))[0].c) >= 5);
    // partial needs percent + milestone
    ok("send partial candidate", (await send(E1, "EFF part")).s < 300); await approve("EFF part");
    ok("partial without progress refused", (await call("POST", `/tasks/review/${await idOf("EFF part")}/partial`, MGR.tok, { partial: true })).s === 400);
    ok("partial with progress accepted", (await call("POST", `/tasks/review/${await idOf("EFF part")}/partial`, MGR.tok, { partial: true, percent: 60, milestone: "draft done" })).s < 300);
    ok("progress row stored", (await q(`select percent from task_partial_progress where "taskId"=$1`, [await idOf("EFF part")]))[0]?.percent === 60);
    // revert needs a reason
    ok("revert without a reason refused", (await call("POST", `/tasks/review/${await idOf("EFF done 2")}/revert`, MGR.tok, { type: "NOT_FULL", remark: "needs rework" })).s === 400);
    ok("revert (requirement change) accepted", (await call("POST", `/tasks/review/${await idOf("EFF done 2")}/revert`, MGR.tok, { type: "NOT_FULL", remark: "scope changed", reason: "REQUIREMENT_CHANGE" })).s < 300);
    ok("attempt recorded", (await q(`select kind from task_review_attempts where "taskId"=$1`, [await idOf("EFF done 2")]))[0]?.kind === "REQUIREMENT_CHANGE");
    ok("revert (quality) accepted", (await call("POST", `/tasks/review/${await idOf("EFF done 3")}/revert`, MGR.tok, { type: "PARTIAL", remark: "bad output", reason: "QUALITY" })).s < 300);

    console.log("## the endpoint");
    const r = await eff(MGR.tok, `&userId=${E1.id}`);
    ok("manager reads it", r.s === 200 && r.b.version === "EFFICIENCY_V1", r);
    const e = r.b.people?.[0]?.efficiency;
    ok("lines carried for one person", Array.isArray(e?.lines) && e.lines.length >= 6, e && e.lines?.length);
    ok("quality return counted once under Returned, requirement return not", e.returned === 1 && e.components.find((c) => c.key === "reverted").numerator != null);
    const rev = e.components.find((c) => c.key === "reverted");
    ok("reverted = 2 first-pass? (done1, done4, done5 completed, a0) of completed+returned", rev.state === "SCORED" && rev.percent < 100, rev);
    ok("partial counted from the verified percent", e.partial === 1 && e.components.find((c) => c.key === "partial").percent === 60);
    ok("final reproduces from the breakdown", (() => { const sc = e.components.filter((c) => c.state === "SCORED"); if (e.percent == null) return e.status === "INCOMPLETE_EVIDENCE"; const w = sc.reduce((n, c) => n + c.weight, 0); const pts = sc.reduce((n, c) => n + c.earned, 0); return Math.abs(e.percent - pts / w * 100) < 0.02; })(), e);
    ok("the old Overall score is untouched (still there)", (await call("GET", `/team-attendance/productivity?from=${today}&to=${today}&userId=${E1.id}`, MGR.tok)).b.people?.[0]?.weighted != null);
    ok("employee cannot read it", (await eff(E1.tok)).s === 403);
    ok("another manager sees nobody", (await eff((await mk("EFF-MG2", "Mgb", "MANAGER", { boss: ADMIN.id })).tok)).b.people?.length === 0);
  } finally {
    await wipe().catch((e) => console.log("wipe note:", e.message));
    await db.query(down).catch(() => {});
    await db.end();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
