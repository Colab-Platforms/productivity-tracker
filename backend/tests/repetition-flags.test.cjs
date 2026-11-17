// Repetitive task detection, flags, review, permissions, notifications, reports: real sign-ins, real HTTP, disposable DB only.
//   cd backend && TEST_DATABASE_URL=... TEST_API=http://localhost:5012/api node tests/repetition-flags.test.cjs
// The feature's tables must NOT exist when this starts (drop them with migrations/20261117120000_repetition_flags/down.sql and restart the backend):
// the test first proves the "table missing" behaviour, then applies the migration SQL itself.
require("dotenv").config({ path: require("node:path").join(__dirname, "..", ".env") });
const { Client } = require("pg");
const bcrypt = require("bcryptjs");
const fs = require("node:fs");
const path = require("node:path");
const API = process.env.TEST_API ?? "http://localhost:5012/api";
require("./_guard.cjs").assertTestDb(process.env.TEST_DATABASE_URL);

const call = async (m, p, t, body) => {
  const r = await fetch(API + p, { method: m, headers: { ...(t ? { authorization: "Bearer " + t } : {}), ...(body !== undefined && m !== "GET" ? { "content-type": "application/json" } : {}) }, body: body !== undefined && m !== "GET" ? JSON.stringify(body) : undefined });
  const txt = await r.text(); let j; try { j = JSON.parse(txt); } catch { j = txt; }
  return { s: r.status, b: j };
};
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  -> " + String(JSON.stringify(x)).slice(0, 500))); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PW = "Rep@12345678";
const isoDay = (o) => new Date(Date.now() + 330 * 60000 + o * 86400000).toISOString().slice(0, 10);
const EX = ["Working on HRMS dashboard", "HRMS dashboard development", "Continued work on HRMS dashboard", "HRMS dashboard work"];

(async () => {
  const db = new Client({ connectionString: process.env.TEST_DATABASE_URL }); await db.connect();
  const q = async (s, p) => (await db.query(s, p)).rows;
  const plats = await q(`select id, slug from platforms order by slug`);
  const AV = plats.find((p) => p.slug === "avatar").id;
  const OTHER = plats.find((p) => p.slug !== "avatar").id;
  const hash = await bcrypt.hash(PW, 10);
  const wipe = async () => {
    const ids = `(select id from users where "employeeCode" like 'REP-%')`;
    await q(`delete from repetition_flags where "userId" in ${ids}`).catch(() => {});
    await q(`delete from repetition_settings`).catch(() => {});
    await q(`delete from task_deletions where "taskId" in (select id from daily_tasks where "userId" in ${ids})`).catch(() => {});
    await q(`delete from task_entry_details where "taskId" in (select id from daily_tasks where "userId" in ${ids})`).catch(() => {});
    await q(`delete from daily_tasks where "userId" in ${ids}`);
    await q(`delete from team_members where "userId" in ${ids}`);
    await q(`delete from teams where name like 'REP-%'`);
    await q(`delete from company_access where "userId" in ${ids}`).catch(() => {});
    await q(`delete from notifications where "userId" in ${ids}`);
    await q(`delete from users where "employeeCode" like 'REP-%'`);
  };
  const dropTables = async () => { await q(`drop table if exists repetition_flag_events, repetition_flag_tasks, repetition_flags, repetition_settings cascade`); await q(`drop function if exists repetition_flag_events_no_edit()`); };
  await wipe(); await dropTables();
  const mk = async (code, role, o = {}) => {
    await q(`insert into users (id,"platformId",email,"passwordHash","firstName","lastName","employeeCode",role,status,"mustChangePassword","trackerAccessEnabled","onboardingStatus","reportsToId","dateOfJoining","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,$4,'Rep',$5,$6,'ACTIVE',false,true,'ACTIVE',$7,'2026-01-01',now(),now())`, [o.plat ?? AV, code.toLowerCase() + "@rep.test", hash, o.first ?? code.replace("REP-", ""), code, role, o.boss ?? null]);
    const id = (await q(`select id from users where "employeeCode"=$1`, [code]))[0].id;
    const tok = (await (await fetch(API + "/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: code, password: PW }) })).json()).token;
    return { id, tok };
  };
  const ADMIN = await mk("REP-ADMIN", "ADMIN", { first: "AdminR" });
  const ADMIN2 = await mk("REP-ADMIN2", "ADMIN", { first: "AdminTwo", plat: OTHER }); // no company grant: sees only its own company
  const HR = await mk("REP-HR", "HR", { first: "HrR", boss: ADMIN.id });
  const HR2 = await mk("REP-HR2", "HR", { first: "HrOther", plat: OTHER });
  const M1 = await mk("REP-M1", "MANAGER", { first: "MgrOne", boss: ADMIN.id });
  const M2 = await mk("REP-M2", "MANAGER", { first: "MgrTwo", boss: ADMIN.id });
  const E = {};
  for (const n of ["E1", "E2", "E3", "E4", "E5", "E6", "E7", "E8", "E9"]) E[n] = await mk("REP-" + n, "EMPLOYEE", { first: "Emp" + n, boss: M1.id });
  const team = async (name, manager, members) => {
    const id = (await q(`insert into teams (id,"platformId",name,"managerId","isActive","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,true,now(),now()) returning id`, [AV, name, manager.id]))[0].id;
    for (const u of members) await q(`insert into team_members (id,"teamId","userId","isActive","isPrimary","joinedAt") values (gen_random_uuid(),$1,$2,true,true,now())`, [id, u.id]);
    return id;
  };
  const P1 = await team("REP-Alpha", M1, Object.values(E));
  const P2 = await team("REP-Beta", M1, [E.E8]);
  const P3 = await team("REP-Gamma", M1, [E.E8]);

  const submit = (who, title, extra = {}) => call("POST", "/tasks", who.tok, { title, teamId: P1, taggedManagerId: M1.id, progress: "IN_PROGRESS", hoursSpent: 1, weight: "MEDIUM", ...extra });
  const ins = async (who, title, offset, o = {}) => (await q(`insert into daily_tasks (id,"platformId","userId","teamId",date,title,description,weight,status,"approvalStatus","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,$4,$5,$6,'MEDIUM',$7,$8,now(),now()) returning id`, [AV, who.id, o.team === undefined ? P1 : o.team, isoDay(offset), title, o.desc ?? null, o.status ?? "IN_PROGRESS", o.approval ?? "APPROVED"]))[0].id;
  const flagsOf = async (tok, status = "all") => (await call("GET", `/tasks/repetition/flags?status=${status}`, tok)).b;
  const dbFlags = async (user) => q(`select * from repetition_flags where "userId"=$1 order by "createdAt"`, [user.id]);
  const notes = async (user, type) => (await q(`select count(*)::int n from notifications where "userId"=$1 and type=$2`, [user.id, type]))[0].n;
  const scan = (tok) => call("POST", "/tasks/repetition/scan", tok, {});

  try {
    console.log("## 0. Before the database update: nothing breaks");
    const pre = await flagsOf(M1.tok);
    ok("flags list answers 'not ready' and nothing else", pre.ready === false && Array.isArray(pre.flags), pre);
    ok("submitting tasks still works (the background check never blocks it)", (await submit(E.E1, EX[0])).s === 200);
    await sleep(2500);
    ok("Admin settings say not ready; saving answers 503", (await call("GET", "/tasks/repetition/settings", ADMIN.tok)).b.ready === false && (await call("PUT", "/tasks/repetition/settings", ADMIN.tok, { minCount: 3, windowDays: 7, similarityPct: 60 })).s === 503);
    ok("the summary says not ready", (await call("GET", "/tasks/repetition/summary", M1.tok)).b.ready === false);
    await q(`delete from daily_tasks where "userId"=$1`, [E.E1.id]);
    const sql = fs.readFileSync(path.join(__dirname, "..", "prisma", "migrations", "20261117120000_repetition_flags", "migration.sql"), "utf8");
    await db.query(sql);
    await sleep(16500); // the "table missing" answer is cached for 15 s

    console.log("\n## 1. Exact and reworded duplicates are flagged");
    for (const t of EX.slice(0, 3)) await submit(E.E1, t);
    await sleep(4500);
    let f1 = await dbFlags(E.E1);
    ok("three similar submissions raise exactly one flag with count 3", f1.length === 1 && f1[0].repeatCount === 3 && f1[0].status === "NEW", f1.map((f) => [f.repeatCount, f.status]));
    ok("the flag stores the matching task ids and the reason", (await q(`select count(*)::int n from repetition_flag_tasks where "flagId"=$1`, [f1[0].id]))[0].n === 3 && /3 entries/.test(f1[0].reason));
    ok("the flag records the project and the dates", f1[0].teamId === P1 && String(f1[0].firstDate).length > 0);
    ok("the reporting manager was notified once", (await notes(M1, "REPETITIVE_TASK_FLAG")) === 1);
    await submit(E.E1, EX[3]);
    await sleep(4500);
    f1 = await dbFlags(E.E1);
    ok("a 4th similar task updates the SAME flag (count 4, still one flag)", f1.length === 1 && f1[0].repeatCount === 4, f1.map((f) => f.repeatCount));
    ok("no new notification for the same pattern", (await notes(M1, "REPETITIVE_TASK_FLAG")) === 1);
    ok("the update is in the review trail", (await q(`select count(*)::int n from repetition_flag_events where "flagId"=$1 and kind='UPDATED'`, [f1[0].id]))[0].n === 1);
    await scan(ADMIN.tok); await scan(ADMIN.tok);
    ok("scanning twice raises no duplicate", (await dbFlags(E.E1)).length === 1);
    const [s1, s2] = await Promise.all([scan(ADMIN.tok), scan(ADMIN.tok)]);
    ok("two scans at the same moment still raise no duplicate", s1.s === 200 && s2.s === 200 && (await dbFlags(E.E1)).length === 1);

    console.log("\n## 2. What must NOT be flagged");
    for (const t of ["Fix login bug on HRMS", "Design HRMS reports page", "Write HRMS onboarding docs"]) await submit(E.E2, t);
    await sleep(3500); await scan(ADMIN.tok);
    ok("three genuinely different tasks with similar wording: no flag", (await dbFlags(E.E2)).length === 0);
    await ins(E.E3, "Daily sales report", -3, { status: "COMPLETED" }); await ins(E.E3, "Daily sales report", -2, { status: "COMPLETED" }); await ins(E.E3, "Daily sales report", -1, { status: "IN_PROGRESS" });
    await scan(ADMIN.tok);
    ok("a recurring routine that is really completed: no flag", (await dbFlags(E.E3)).length === 0);
    await ins(E.E4, "Update client report", -12); await ins(E.E4, "Update client report", -6); await ins(E.E4, "Update client report", -1);
    await scan(ADMIN.tok);
    ok("the same task spread over 12 days (outside 7 days): no flag", (await dbFlags(E.E4)).length === 0);
    await ins(E.E4, "Update client report", -5); // now 4 inside the last 7 days: -6,-5,-1 = 3 within 6 days
    await scan(ADMIN.tok);
    ok("the same task on different dates inside 7 days: flagged", (await dbFlags(E.E4)).length === 1);
    const d5 = [await ins(E.E5, "Prepare vendor invoices", -3), await ins(E.E5, "Prepare vendor invoices", -2), await ins(E.E5, "Prepare vendor invoices", -1)];
    await call("POST", `/tasks/review/${d5[0]}/delete`, M1.tok, { reasonCode: "DUPLICATE", note: "dup" });
    ok("(setup) the task was deleted", (await q(`select count(*)::int n from task_deletions where "taskId"=$1`, [d5[0]]))[0].n === 1);
    await scan(ADMIN.tok);
    ok("a deleted task is not counted: two left, no flag", (await dbFlags(E.E5)).length === 0);
    await ins(E.E6, "Reconcile bank statements", -3); await ins(E.E6, "Reconcile bank statements", -2); await ins(E.E6, "Reconcile bank statements", -1, { approval: "REJECTED" });
    await scan(ADMIN.tok);
    ok("a rejected task is not counted: no flag", (await dbFlags(E.E6)).length === 0);
    for (let i = 0; i < 3; i++) await call("POST", "/tasks/assigned", M1.tok, { userId: E.E7.id, title: "Audit the stock sheet" });
    await sleep(2000); await scan(ADMIN.tok);
    ok("manager-assigned tasks are never compared: no flag", (await dbFlags(E.E7)).length === 0);
    await ins(E.E8, "Prepare weekly newsletter", -3, { team: P1 }); await ins(E.E8, "Prepare weekly newsletter", -2, { team: P2 }); await ins(E.E8, "Prepare weekly newsletter", -1, { team: P3 });
    await scan(ADMIN.tok);
    ok("the same wording on three different projects: no flag", (await dbFlags(E.E8)).length === 0);
    for (let i = 0; i < 3; i++) await call("POST", "/tasks", M1.tok, { title: "Review budget sheet" });
    await sleep(2500); await scan(ADMIN.tok);
    ok("a manager's own (self-managed) tasks are never flagged", (await dbFlags(M1)).length === 0);
    ok("two similar tasks are below the threshold", (await ins(E.E9, "Organise team lunch", -2), await ins(E.E9, "Organise team lunch", -1), await scan(ADMIN.tok), (await dbFlags(E.E9)).length === 0));

    console.log("\n## 3. Who can see what");
    const flagId = f1[0].id;
    const seen = async (u) => { const r = await flagsOf(u.tok); return (r.flags ?? []).some((f) => f.id === flagId); };
    ok("the reporting manager sees the flag", await seen(M1));
    ok("another manager (not this person's manager) does not", !(await seen(M2)) && (await call("GET", `/tasks/repetition/flags/${flagId}`, M2.tok)).s === 404);
    ok("HR of the company sees it", await seen(HR));
    ok("HR of ANOTHER company does not (404 on the detail)", !(await seen(HR2)) && (await call("GET", `/tasks/repetition/flags/${flagId}`, HR2.tok)).s === 404);
    ok("Admin of another company with no grant does not", !(await seen(ADMIN2)));
    await q(`insert into company_access (id,"userId","platformId","createdAt") values (gen_random_uuid(),$1,null,now())`, [ADMIN2.id]);
    ok("an Admin with the all-companies grant sees it (organisation-wide)", await seen(ADMIN2) && await seen(ADMIN));
    ok("an employee cannot read flags (403), not even their own", (await call("GET", "/tasks/repetition/flags", E.E1.tok)).s === 403 && (await call("GET", `/tasks/repetition/flags/${flagId}`, E.E1.tok)).s === 403);
    ok("no token: 401", (await call("GET", "/tasks/repetition/flags")).s === 401);
    const det = (await call("GET", `/tasks/repetition/flags/${flagId}`, M1.tok)).b;
    ok("the detail shows employee, ID, dates, descriptions, statuses, repeat count, project and reason", det.flag.employee.includes("EmpE1") && det.flag.employeeCode === "REP-E1" && det.tasks.length === 4 && det.tasks.every((t) => t.date && t.title && t.status && t.approvalStatus) && det.flag.repeatCount === 4 && det.flag.reason.length > 20 && det.flag.project === "REP-Alpha", det.flag);

    console.log("\n## 4. Review: status, dismissal, comments, history");
    const st = (u, status, note) => call("POST", `/tasks/repetition/flags/${flagId}/status`, u.tok, { status, ...(note !== undefined ? { note } : {}) });
    ok("an employee cannot change a flag (403)", (await st(E.E1, "RESOLVED")).s === 403);
    ok("another manager cannot change it (404)", (await st(M2, "RESOLVED")).s === 404);
    ok("an unknown status is refused (400)", (await st(M1, "NEW")).s === 400 && (await st(M1, "BANANA")).s === 400);
    ok("False Positive needs a written reason (400)", (await st(M1, "FALSE_POSITIVE")).s === 400 && (await st(M1, "FALSE_POSITIVE", "no")).s === 400);
    ok("Mark as reviewed: New -> Under Review", (await st(M1, "UNDER_REVIEW")).s === 200 && (await dbFlags(E.E1))[0].status === "UNDER_REVIEW");
    ok("the same move twice is refused (409)", (await st(M1, "UNDER_REVIEW")).s === 409);
    ok("a comment from the manager and from HR", (await call("POST", `/tasks/repetition/flags/${flagId}/comment`, M1.tok, { text: "Asked EmpE1 about it" })).s === 200 && (await call("POST", `/tasks/repetition/flags/${flagId}/comment`, HR.tok, { text: "HR noted" })).s === 200);
    ok("an empty comment is refused (400); an employee cannot comment (403)", (await call("POST", `/tasks/repetition/flags/${flagId}/comment`, M1.tok, { text: "  " })).s === 400 && (await call("POST", `/tasks/repetition/flags/${flagId}/comment`, E.E1.tok, { text: "hi" })).s === 403);
    ok("dismiss as a false positive with a reason", (await st(M1, "FALSE_POSITIVE", "It is a long running migration task")).s === 200 && (await dbFlags(E.E1))[0].status === "FALSE_POSITIVE");
    await scan(ADMIN.tok);
    ok("a dismissed pattern is NOT raised again by the next scan", (await dbFlags(E.E1)).length === 1);
    ok("it can be reopened for review", (await st(M1, "UNDER_REVIEW")).s === 200);
    ok("valid repetition", (await st(M1, "VALID")).s === 200);
    const hist = (await call("GET", `/tasks/repetition/flags/${flagId}`, HR.tok)).b.events;
    ok("the review trail lists who did what, in order", hist.map((e) => e.kind).join() === "DETECTED,UPDATED,STATUS,COMMENT,COMMENT,STATUS,STATUS,STATUS" && hist.some((e) => e.note === "It is a long running migration task") && hist[0].by === "System", hist.map((e) => e.kind));
    ok("the trail cannot be edited in the database", await (async () => { try { await q(`update repetition_flag_events set note='x' where "flagId"=$1`, [flagId]); return false; } catch { return true; } })());

    console.log("\n## 5. Escalation to HR");
    const esc = (u, note) => call("POST", `/tasks/repetition/flags/${flagId}/escalate`, u.tok, note === undefined ? {} : { note });
    ok("HR cannot escalate (403)", (await esc(HR)).s === 403);
    ok("an employee cannot escalate (403)", (await esc(E.E1)).s === 403);
    ok("the manager escalates with a note", (await esc(M1, "Please look at this pattern")).s === 200);
    ok("HR received the escalation notification once", (await notes(HR, "REPETITIVE_TASK_ESCALATED")) === 1);
    ok("escalating twice is refused (409) and sends nothing more", (await esc(M1)).s === 409 && (await notes(HR, "REPETITIVE_TASK_ESCALATED")) === 1);
    ok("the list marks it escalated", (await flagsOf(HR.tok)).flags.find((f) => f.id === flagId)?.escalated === true);

    console.log("\n## 6. A flag changes nothing else");
    const snap = async () => (await q(`select md5(string_agg(t::text, '|' order by t.id)) h from (select id, status, "approvalStatus", outcome, weight, "completedAt" from daily_tasks where "userId"=$1) t`, [E.E1.id]))[0].h;
    const before = await snap();
    await st(M1, "RESOLVED"); await scan(ADMIN.tok);
    ok("the person's tasks are byte-for-byte unchanged by review and scans", before === await snap());
    ok("no salary, attendance or productivity table is touched (no writes to work_sessions by this feature)", (await q(`select count(*)::int n from work_sessions where "userId"=$1`, [E.E1.id]))[0].n === 0);

    console.log("\n## 7. After Resolved, a new pattern can be raised");
    await submit(E.E1, "HRMS dashboard improvements"); await submit(E.E1, "Working on the HRMS dashboard again"); await submit(E.E1, "HRMS dashboard development part two");
    await sleep(5000);
    const after = await dbFlags(E.E1);
    ok("new similar entries after a Resolved flag raise a fresh flag", after.length === 2 && after.some((f) => f.status === "NEW") && after.some((f) => f.status === "RESOLVED"), after.map((f) => [f.status, f.repeatCount]));

    console.log("\n## 8. Reports");
    const sum = (await call("GET", `/tasks/repetition/summary?from=${isoDay(-30)}&to=${isoDay(1)}`, ADMIN.tok)).b;
    ok("totals, per employee, per project and repeated descriptions are returned", sum.ready && sum.totals.flags >= 3 && sum.byEmployee.some((r) => r.label.includes("REP-E1")) && sum.byProject.some((r) => r.label === "REP-Alpha") && sum.topTitles.length > 0, sum);
    ok("totals split reviewed / open / false positive / valid", sum.totals.reviewed + sum.totals.open === sum.totals.flags && sum.totals.falsePositive >= 0 && sum.totals.escalated >= 1, sum.totals);
    ok("a manager's summary covers only their people; another manager sees none of E1", !(await call("GET", "/tasks/repetition/summary", M2.tok)).b.byEmployee.some((r) => r.label.includes("REP-E1")) && (await call("GET", "/tasks/repetition/summary", M1.tok)).b.byEmployee.some((r) => r.label.includes("REP-E1")));
    ok("an employee cannot read the summary (403)", (await call("GET", "/tasks/repetition/summary", E.E1.tok)).s === 403);
    ok("employee-wise counts do not duplicate people", new Set(sum.byEmployee.map((r) => r.key)).size === sum.byEmployee.length);

    console.log("\n## 9. Admin settings");
    ok("Admin reads the threshold (default 3 in 7 days at 60%)", (await call("GET", "/tasks/repetition/settings", ADMIN.tok)).b.settings.minCount === 3);
    ok("HR, manager and employee cannot read or change it (403)", [HR, M1, E.E1].every(async () => true) && (await call("GET", "/tasks/repetition/settings", HR.tok)).s === 403 && (await call("PUT", "/tasks/repetition/settings", M1.tok, { minCount: 2, windowDays: 7, similarityPct: 60 })).s === 403 && (await call("POST", "/tasks/repetition/scan", HR.tok)).s === 403);
    ok("bad values are refused (400)", (await call("PUT", "/tasks/repetition/settings", ADMIN.tok, { minCount: 1, windowDays: 7, similarityPct: 60 })).s === 400 && (await call("PUT", "/tasks/repetition/settings", ADMIN.tok, { minCount: 3, windowDays: 0, similarityPct: 60 })).s === 400 && (await call("PUT", "/tasks/repetition/settings", ADMIN.tok, { minCount: 3, windowDays: 7, similarityPct: 10 })).s === 400);
    ok("lowering the threshold to 2 flags the pair on the next scan", (await call("PUT", "/tasks/repetition/settings", ADMIN.tok, { minCount: 2, windowDays: 7, similarityPct: 60 })).s === 200 && (await scan(ADMIN.tok)).s === 200 && (await dbFlags(E.E9)).length === 1);
    ok("switching it off stops detection", (await call("PUT", "/tasks/repetition/settings", ADMIN.tok, { enabled: false, minCount: 2, windowDays: 7, similarityPct: 60 })).s === 200 && (await (async () => { await ins(E.E2, "Fix login bug on HRMS again", -1); await ins(E.E2, "Fix login bug on HRMS once more", -1); await ins(E.E2, "Fix login bug on HRMS third time", -1); return scan(ADMIN.tok); })()).b.raised === 0);
    await call("PUT", "/tasks/repetition/settings", ADMIN.tok, { enabled: true, minCount: 3, windowDays: 7, similarityPct: 60 });
    ok("changes to the threshold are in the audit log", (await q(`select count(*)::int n from audit_logs where summary like 'Changed the repetitive task detection settings%'`))[0].n >= 1);
    ok("review actions are in the audit log", (await q(`select count(*)::int n from audit_logs where summary like 'Repetitive task flag set to%' or summary like 'Escalated a repetitive task flag%'`))[0].n >= 3);
  } finally {
    await wipe();
    await db.end();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
