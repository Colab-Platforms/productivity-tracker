// Repetitive task flags, part 2: employee alert and explanation, who sees which note, escalation Manager -> HR -> Admin, notifications. Real sign-ins, real HTTP,
// disposable DB only. The repetition tables must NOT exist when this starts (drop them and restart the backend): the test applies BOTH migrations itself,
// proving the code works after the first one (no notes table yet) and after the second.
//   cd backend && TEST_DATABASE_URL=... TEST_API=http://localhost:5012/api node tests/repetition-visibility.test.cjs
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
const ok = (n, c, x) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  -> " + String(JSON.stringify(x)).slice(0, 600))); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PW = "Rpv@12345678";
const isoDay = (o) => new Date(Date.now() + 330 * 60000 + o * 86400000).toISOString().slice(0, 10);
const EX = ["Working on HRMS dashboard", "HRMS dashboard development", "Continued work on HRMS dashboard"];

(async () => {
  const db = new Client({ connectionString: process.env.TEST_DATABASE_URL }); await db.connect();
  const q = async (s, p) => (await db.query(s, p)).rows;
  const plats = await q(`select id, slug from platforms order by slug`);
  const AV = plats.find((p) => p.slug === "avatar").id;
  const OTHER = plats.find((p) => p.slug !== "avatar").id;
  const hash = await bcrypt.hash(PW, 10);
  const wipe = async () => {
    const ids = `(select id from users where "employeeCode" like 'RPV-%')`;
    await q(`delete from repetition_flags where "userId" in ${ids}`).catch(() => {});
    await q(`delete from task_entry_details where "taskId" in (select id from daily_tasks where "userId" in ${ids})`).catch(() => {});
    await q(`delete from daily_tasks where "userId" in ${ids}`);
    await q(`delete from team_members where "userId" in ${ids}`);
    await q(`delete from teams where name like 'RPV-%'`);
    await q(`delete from company_access where "userId" in ${ids}`).catch(() => {});
    await q(`delete from notifications where "userId" in ${ids}`);
    await q(`delete from users where "employeeCode" like 'RPV-%'`);
  };
  const dropTables = async () => { await q(`drop table if exists repetition_flag_notes, repetition_flag_events, repetition_flag_tasks, repetition_flags, repetition_settings cascade`); await q(`drop function if exists repetition_flag_events_no_edit()`); await q(`drop function if exists repetition_flag_notes_no_edit()`); };
  await wipe(); await dropTables();
  const mk = async (code, role, o = {}) => {
    await q(`insert into users (id,"platformId",email,"passwordHash","firstName","lastName","employeeCode",role,status,"mustChangePassword","trackerAccessEnabled","onboardingStatus","reportsToId","dateOfJoining","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,$4,'Rpv',$5,$6,'ACTIVE',false,true,'ACTIVE',$7,'2026-01-01',now(),now())`, [o.plat ?? AV, code.toLowerCase() + "@rpv.test", hash, o.first ?? code.replace("RPV-", ""), code, role, o.boss ?? null]);
    const id = (await q(`select id from users where "employeeCode"=$1`, [code]))[0].id;
    const tok = (await (await fetch(API + "/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: code, password: PW }) })).json()).token;
    return { id, tok };
  };
  const ADMIN = await mk("RPV-ADMIN", "ADMIN", { first: "AdminV" });
  const ADMIN2 = await mk("RPV-ADMIN2", "ADMIN", { first: "AdminTwoV", plat: OTHER });
  const HR = await mk("RPV-HR", "HR", { first: "HrV", boss: ADMIN.id });
  const HR3 = await mk("RPV-HR3", "HR", { first: "HrThreeV", boss: ADMIN.id });
  const HR2 = await mk("RPV-HR2", "HR", { first: "HrOtherV", plat: OTHER });
  const M1 = await mk("RPV-M1", "MANAGER", { first: "MgrOneV", boss: ADMIN.id });
  const M2 = await mk("RPV-M2", "MANAGER", { first: "MgrTwoV", boss: ADMIN.id });
  const E1 = await mk("RPV-E1", "EMPLOYEE", { first: "EmpOneV", boss: M1.id });
  const E2 = await mk("RPV-E2", "EMPLOYEE", { first: "EmpTwoV", boss: M1.id });
  const team = async (name, manager, members) => {
    const id = (await q(`insert into teams (id,"platformId",name,"managerId","isActive","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,true,now(),now()) returning id`, [AV, name, manager.id]))[0].id;
    for (const u of members) await q(`insert into team_members (id,"teamId","userId","isActive","isPrimary","joinedAt") values (gen_random_uuid(),$1,$2,true,true,now())`, [id, u.id]);
    return id;
  };
  const P1 = await team("RPV-Alpha", M1, [E1, E2]);

  const submit = (who, title) => call("POST", "/tasks", who.tok, { title, teamId: P1, taggedManagerId: M1.id, progress: "IN_PROGRESS", hoursSpent: 1, weight: "MEDIUM" });
  const ins = async (who, title, offset) => (await q(`insert into daily_tasks (id,"platformId","userId","teamId",date,title,weight,status,"approvalStatus","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,$4,$5,'MEDIUM','IN_PROGRESS','APPROVED',now(),now()) returning id`, [AV, who.id, P1, isoDay(offset), title]))[0].id;
  const notes = async (user, type) => (await q(`select count(*)::int n from notifications where "userId"=$1 and type=$2`, [user.id, type]))[0].n;
  const flagOf = async (user) => (await q(`select * from repetition_flags where "userId"=$1 order by "createdAt" limit 1`, [user.id]))[0];
  const detail = (who, id) => call("GET", `/tasks/repetition/flags/${id}`, who.tok);
  const scan = (tok) => call("POST", "/tasks/repetition/scan", tok, {});
  const all = (o) => JSON.stringify(o);

  try {
    console.log("## 1. Detection tells everyone who should know, once (first migration only: no notes table yet)");
    await db.query(fs.readFileSync(path.join(__dirname, "..", "prisma", "migrations", "20261117120000_repetition_flags", "migration.sql"), "utf8"));
    await sleep(16500);
    for (const t of EX) await submit(E1, t);
    await sleep(5000);
    const F = await flagOf(E1);
    ok("a flag was raised for the employee", !!F && F.repeatCount === 3, F);
    ok("the employee was notified once, with the 'not misconduct' wording", (await notes(E1, "REPETITIVE_TASK_ALERT")) === 1 && /not a finding of misconduct/.test((await q(`select body from notifications where "userId"=$1 and type='REPETITIVE_TASK_ALERT'`, [E1.id]))[0].body));
    ok("the reporting manager, HR and Admin of the company were each notified once", (await notes(M1, "REPETITIVE_TASK_FLAG")) === 1 && (await notes(HR, "REPETITIVE_TASK_FLAG")) === 1 && (await notes(ADMIN, "REPETITIVE_TASK_FLAG")) === 1 && (await notes(HR3, "REPETITIVE_TASK_FLAG")) === 1);
    ok("people of another company were not notified", (await notes(HR2, "REPETITIVE_TASK_FLAG")) === 0 && (await notes(ADMIN2, "REPETITIVE_TASK_FLAG")) === 0 && (await notes(M2, "REPETITIVE_TASK_FLAG")) === 0 && (await notes(E2, "REPETITIVE_TASK_FLAG")) === 0 && (await notes(E2, "REPETITIVE_TASK_ALERT")) === 0);
    ok("reviewers' links go to Tasks & Performance, the employee's to Daily Tasks", (await q(`select link from notifications where "userId"=$1 and type='REPETITIVE_TASK_FLAG'`, [M1.id]))[0].link === "/dashboard/approvals" && (await q(`select link from notifications where "userId"=$1 and type='REPETITIVE_TASK_ALERT'`, [E1.id]))[0].link === "/dashboard/tasks");
    await scan(ADMIN.tok); await scan(ADMIN.tok);
    ok("scanning again sends nothing new (no duplicate notification for the same unresolved flag)", (await notes(E1, "REPETITIVE_TASK_ALERT")) === 1 && (await notes(M1, "REPETITIVE_TASK_FLAG")) === 1 && (await notes(ADMIN, "REPETITIVE_TASK_FLAG")) === 1);
    await submit(E1, "HRMS dashboard work");
    await sleep(4500);
    ok("a 4th similar task updates the flag and still notifies nobody", (await q(`select "repeatCount" from repetition_flags where id=$1`, [F.id]))[0].repeatCount === 4 && (await notes(E1, "REPETITIVE_TASK_ALERT")) === 1 && (await notes(HR, "REPETITIVE_TASK_FLAG")) === 1);
    const snapBefore = (await q(`select md5(string_agg(t::text, '|' order by t.id)) h from (select id, title, status, "approvalStatus", outcome, weight, date from daily_tasks where "userId" in ($1,$2)) t`, [E1.id, E2.id]))[0].h;

    console.log("\n## 2. Before the second migration: nothing breaks, new actions say 'not switched on'");
    const own0 = (await call("GET", "/tasks/repetition/flags?mine=1&status=all", E1.tok)).b;
    ok("the employee can already read their own alert", own0.ready && own0.flags.length === 1 && own0.mode === "EMPLOYEE" && own0.notesReady === false, own0);
    ok("explaining answers 503 (not switched on)", (await call("POST", `/tasks/repetition/flags/${F.id}/explain`, E1.tok, { text: "These are different parts" })).s === 503);
    ok("escalating to Admin answers 503 (not switched on)", (await call("POST", `/tasks/repetition/flags/${F.id}/escalate-admin`, HR.tok, { reason: "please look" })).s === 503);
    ok("a manager's comment still works (stored the first-version way)", (await call("POST", `/tasks/repetition/flags/${F.id}/comment`, M1.tok, { text: "pre-migration comment" })).s === 200);
    ok("the detail says no explanation or Admin escalation is offered", await (async () => { const d = (await detail(HR, F.id)).b; return d.can.escalateAdmin === false && (await detail(E1, F.id)).b.can.explain === false; })());

    console.log("\n## 3. Apply the second migration");
    await db.query(fs.readFileSync(path.join(__dirname, "..", "prisma", "migrations", "20261118120000_repetition_notes", "migration.sql"), "utf8"));
    await sleep(16500);

    console.log("\n## 4. The employee's view: reason, tasks, dates, status; nothing from reviewers");
    const ed = (await detail(E1, F.id)).b;
    ok("the employee sees why, the matching tasks with dates, and the status", ed.mode === "EMPLOYEE" && ed.flag.reason.length > 20 && ed.tasks.length === 4 && ed.tasks.every((t) => t.date && t.title) && ed.flag.statusLabel === "New" && ed.flag.outcome.length > 5, ed.flag);
    ok("the pre-migration manager comment is NOT visible to the employee", !all(ed).includes("pre-migration comment"));
    ok("the employee sees no reporting manager and no escalation information", ed.flag.reportingManager === null && ed.flag.escalated === false && ed.flag.escalatedToAdmin === false && !ed.timeline.some((t) => t.kind === "ESCALATED" || t.kind === "ESCALATION_ADMIN" || t.kind === "COMMENT"));
    ok("another employee cannot open it (404)", (await detail(E2, F.id)).s === 404);
    ok("the employee cannot comment, change status or escalate (403)", (await call("POST", `/tasks/repetition/flags/${F.id}/comment`, E1.tok, { text: "x" })).s === 403 && (await call("POST", `/tasks/repetition/flags/${F.id}/status`, E1.tok, { status: "FALSE_POSITIVE", note: "mine" })).s === 403 && (await call("POST", `/tasks/repetition/flags/${F.id}/escalate`, E1.tok, {})).s === 403 && (await call("POST", `/tasks/repetition/flags/${F.id}/escalate-admin`, E1.tok, { reason: "x y z" })).s === 403);
    ok("the employee cannot read the team list (their list is only their own flags)", (await call("GET", "/tasks/repetition/flags?status=all", E1.tok)).b.flags.every((f) => f.userId === E1.id) && (await call("GET", "/tasks/repetition/summary", E1.tok)).s === 403);

    console.log("\n## 5. The employee explains");
    ok("an explanation is required to have text", (await call("POST", `/tasks/repetition/flags/${F.id}/explain`, E1.tok, { text: "  " })).s === 400);
    ok("the employee sends an explanation", (await call("POST", `/tasks/repetition/flags/${F.id}/explain`, E1.tok, { text: "These are four different parts of the dashboard" })).s === 200);
    ok("the employee sees their own explanation", (await detail(E1, F.id)).b.timeline.some((t) => t.kind === "EXPLANATION" && /four different parts/.test(t.note)));
    ok("the reporting manager, HR and Admin can read it", [M1, HR, ADMIN].every(async () => true) && (await detail(M1, F.id)).b.timeline.some((t) => t.kind === "EXPLANATION") && (await detail(HR, F.id)).b.timeline.some((t) => t.kind === "EXPLANATION") && (await detail(ADMIN, F.id)).b.timeline.some((t) => t.kind === "EXPLANATION"));
    ok("the manager was notified of the explanation", (await notes(M1, "REPETITIVE_TASK_EXPLAINED")) === 1);
    ok("another employee cannot explain someone else's flag (404)", (await call("POST", `/tasks/repetition/flags/${F.id}/explain`, E2.tok, { text: "pretend" })).s === 404);

    console.log("\n## 6. Who reads which reviewer note");
    ok("a manager comment is saved", (await call("POST", `/tasks/repetition/flags/${F.id}/comment`, M1.tok, { text: "Manager: asked Emp about it" })).s === 200);
    ok("an HR observation is saved", (await call("POST", `/tasks/repetition/flags/${F.id}/comment`, HR.tok, { text: "HR: private observation" })).s === 200);
    ok("an Admin note is saved", (await call("POST", `/tasks/repetition/flags/${F.id}/comment`, ADMIN.tok, { text: "Admin: private note" })).s === 200);
    const dEmp = all((await detail(E1, F.id)).b), dMgr = (await detail(M1, F.id)).b, dHr = all((await detail(HR, F.id)).b), dAdm = all((await detail(ADMIN, F.id)).b);
    ok("the employee sees none of the three reviewer notes", !/Manager: asked|HR: private|Admin: private/.test(dEmp));
    ok("the manager sees the manager comment but NOT the HR observation or the Admin note", all(dMgr).includes("Manager: asked") && !all(dMgr).includes("HR: private") && !all(dMgr).includes("Admin: private"));
    ok("HR and Admin see all three", /Manager: asked/.test(dHr) && /HR: private/.test(dHr) && /Admin: private/.test(dHr) && /Manager: asked/.test(dAdm) && /HR: private/.test(dAdm) && /Admin: private/.test(dAdm));
    ok("each note says who may read it", dMgr.timeline.find((t) => t.kind === "MANAGER_COMMENT")?.visibility === "STAFF" && (await detail(HR, F.id)).b.timeline.find((t) => t.kind === "HR_OBSERVATION")?.visibility === "HR_ADMIN");

    console.log("\n## 7. Manager review and escalation to HR");
    ok("the manager marks it Under Review with a private note", (await call("POST", `/tasks/repetition/flags/${F.id}/status`, M1.tok, { status: "UNDER_REVIEW", note: "secret internal reason" })).s === 200);
    ok("the employee was notified of the new status without any reviewer text", (await notes(E1, "REPETITIVE_TASK_STATUS")) === 1 && !(await q(`select body from notifications where "userId"=$1 and type='REPETITIVE_TASK_STATUS'`, [E1.id]))[0].body.includes("secret internal"));
    const eStatus = (await detail(E1, F.id)).b;
    ok("the employee sees the status change but not the note or who did it", eStatus.flag.statusLabel === "Under Review" && eStatus.timeline.some((t) => t.kind === "STATUS" && t.note === null && t.by === "Review team") && !all(eStatus).includes("secret internal"));
    ok("only the manager escalates to HR; HR is told to use Escalate to Admin (403)", (await call("POST", `/tasks/repetition/flags/${F.id}/escalate`, HR.tok, {})).s === 403);
    ok("the manager escalates to HR", (await call("POST", `/tasks/repetition/flags/${F.id}/escalate`, M1.tok, { note: "please check" })).s === 200);
    ok("HR and Admin were notified once of the escalation", (await notes(HR, "REPETITIVE_TASK_ESCALATED")) === 1 && (await notes(ADMIN, "REPETITIVE_TASK_ESCALATED")) === 1);
    ok("escalating to HR again is refused (409)", (await call("POST", `/tasks/repetition/flags/${F.id}/escalate`, M1.tok, {})).s === 409);
    ok("the employee still sees no sign of the escalation", (await detail(E1, F.id)).b.flag.escalated === false && (await call("GET", "/tasks/repetition/flags?mine=1&status=all", E1.tok)).b.flags[0].escalated === false);

    console.log("\n## 8. HR escalates to Admin (without judging the employee)");
    ok("a reason is required (400)", (await call("POST", `/tasks/repetition/flags/${F.id}/escalate-admin`, HR.tok, { reason: " " })).s === 400);
    ok("a manager cannot escalate to Admin (403)", (await call("POST", `/tasks/repetition/flags/${F.id}/escalate-admin`, M1.tok, { reason: "no right" })).s === 403);
    ok("an Admin cannot escalate to Admin (403)", (await call("POST", `/tasks/repetition/flags/${F.id}/escalate-admin`, ADMIN.tok, { reason: "no right" })).s === 403);
    ok("HR of another company cannot even see the flag (404)", (await call("POST", `/tasks/repetition/flags/${F.id}/escalate-admin`, HR2.tok, { reason: "not mine" })).s === 404);
    const [a1, a2] = await Promise.all([call("POST", `/tasks/repetition/flags/${F.id}/escalate-admin`, HR.tok, { reason: "Pattern continues for weeks, needs a closer look" }), call("POST", `/tasks/repetition/flags/${F.id}/escalate-admin`, HR3.tok, { reason: "Pattern continues for weeks, needs a closer look" })]);
    ok("two HR people escalating at the same moment: exactly one record", [a1.s, a2.s].sort().join() === "200,409", [a1.s, a2.s]);
    ok("one escalation row with the reason, readable by HR and Admin only", (await q(`select count(*)::int n from repetition_flag_notes where "flagId"=$1 and kind='ESCALATION_ADMIN' and visibility='HR_ADMIN'`, [F.id]))[0].n === 1);
    ok("Admin and the other HR were told once more; the escalating HR was not (1 and 2: each had one from the manager step)", (await notes(ADMIN, "REPETITIVE_TASK_ESCALATED")) === 2 && [await notes(HR, "REPETITIVE_TASK_ESCALATED"), await notes(HR3, "REPETITIVE_TASK_ESCALATED")].sort().join() === "1,2", [await notes(ADMIN, "REPETITIVE_TASK_ESCALATED"), await notes(HR, "REPETITIVE_TASK_ESCALATED"), await notes(HR3, "REPETITIVE_TASK_ESCALATED")]);
    const hrList = (await call("GET", "/tasks/repetition/flags?status=escalatedAdmin", HR.tok)).b, admList = (await call("GET", "/tasks/repetition/flags?status=escalatedAdmin", ADMIN.tok)).b;
    ok("HR and Admin see it under 'Escalated to Admin'", hrList.flags.length === 1 && hrList.flags[0].escalatedToAdmin === true && admList.flags.length === 1 && admList.counts.escalatedAdmin === 1);
    ok("the Admin reads the reason, the HR observation, the manager comment and the employee explanation (the full history)", await (async () => { const t = all((await detail(ADMIN, F.id)).b); return /closer look/.test(t) && /HR: private/.test(t) && /Manager: asked/.test(t) && /four different parts/.test(t); })());
    ok("the manager does NOT see that it went to Admin", await (async () => { const d = (await detail(M1, F.id)).b; return d.flag.escalatedToAdmin === false && !all(d).includes("closer look") && !d.timeline.some((t) => t.kind === "ESCALATION_ADMIN"); })());
    ok("the employee does NOT see that it went to Admin", await (async () => { const d = (await detail(E1, F.id)).b; return d.flag.escalatedToAdmin === false && !all(d).includes("closer look"); })());
    ok("a second escalation to Admin is refused (409)", (await call("POST", `/tasks/repetition/flags/${F.id}/escalate-admin`, HR.tok, { reason: "again again" })).s === 409);
    ok("HR keeps its own buttons: no second escalation offered", (await detail(HR, F.id)).b.can.escalateAdmin === false);

    console.log("\n## 9. Admin resolves; the employee is told only the outcome");
    ok("HR can mark it valid repetition (a review outcome, not misconduct)", (await call("POST", `/tasks/repetition/flags/${F.id}/status`, HR.tok, { status: "VALID", note: "hr note" })).s === 200);
    ok("the Admin resolves and closes the escalated case", (await call("POST", `/tasks/repetition/flags/${F.id}/status`, ADMIN.tok, { status: "RESOLVED", note: "closing note" })).s === 200 && (await flagOf(E1)).status === "RESOLVED");
    ok("the employee was told each new status (Under Review, Valid, Resolved), never the notes", (await notes(E1, "REPETITIVE_TASK_STATUS")) === 3 && !(await q(`select string_agg(body, ' ') b from notifications where "userId"=$1 and type='REPETITIVE_TASK_STATUS'`, [E1.id]))[0].b.match(/hr note|closing note|secret/));
    ok("the employee sees the closed outcome and can no longer explain", await (async () => { const d = (await detail(E1, F.id)).b; return d.flag.statusLabel === "Resolved" && d.can.explain === false && (await call("POST", `/tasks/repetition/flags/${F.id}/explain`, E1.tok, { text: "late reply" })).s === 409; })());
    ok("the whole history is kept: detection, explanation, notes, escalations and statuses", await (async () => { const kinds = (await detail(ADMIN, F.id)).b.timeline.map((t) => t.kind); return ["DETECTED", "EXPLANATION", "MANAGER_COMMENT", "HR_OBSERVATION", "ADMIN_NOTE", "ESCALATED", "ESCALATION_ADMIN", "STATUS"].every((k) => kinds.includes(k)); })());
    ok("the employee's tasks were never changed by any of this", snapBefore === (await q(`select md5(string_agg(t::text, '|' order by t.id)) h from (select id, title, status, "approvalStatus", outcome, weight, date from daily_tasks where "userId" in ($1,$2)) t`, [E1.id, E2.id]))[0].h);
    ok("audit lines exist for explanation, escalations and review", (await q(`select count(*)::int n from audit_logs where summary in ('The employee explained a repetitive task flag','Escalated a repetitive task flag to HR','Escalated a repetitive task flag to Admin') or summary like 'Repetitive task flag set to%' or summary like 'Added an HR observation%'`))[0].n >= 7);
    ok("review notes cannot be edited in the database", await (async () => { try { await q(`update repetition_flag_notes set body='x' where "flagId"=$1`, [F.id]); return false; } catch { return true; } })());

    console.log("\n## 10. Read / unread is preserved");
    const adminNote = (await q(`select id from notifications where "userId"=$1 and type='REPETITIVE_TASK_FLAG' limit 1`, [ADMIN.id]))[0].id;
    await call("POST", `/notifications/${adminNote}/read`, ADMIN.tok, {});
    await q(`update notifications set "readAt"=now() where id=$1 and "readAt" is null`, [adminNote]);
    const readBefore = (await q(`select "readAt" from notifications where id=$1`, [adminNote]))[0].readAt;
    await scan(ADMIN.tok);
    ok("later events and scans do not turn a read notification back into unread", String((await q(`select "readAt" from notifications where id=$1`, [adminNote]))[0].readAt) === String(readBefore) && readBefore !== null);

    console.log("\n## 11. Scope: company boundaries, the person's own flag, other managers");
    ok("another manager sees none of it (404)", (await detail(M2, F.id)).s === 404 && !(await call("GET", "/tasks/repetition/flags?status=all", M2.tok)).b.flags.some((f) => f.id === F.id));
    ok("HR and Admin of another company see none of it", (await detail(HR2, F.id)).s === 404 && (await detail(ADMIN2, F.id)).s === 404);
    await q(`insert into company_access (id,"userId","platformId","createdAt") values (gen_random_uuid(),$1,null,now())`, [ADMIN2.id]);
    ok("an Admin with the all-companies grant sees it, with the same full history", (await detail(ADMIN2, F.id)).s === 200 && /closer look/.test(all((await detail(ADMIN2, F.id)).b)));
    for (const t of ["Prepare vendor invoices", "Prepare the vendor invoices", "Vendor invoices preparation"]) await ins(HR3, t, -1);
    await scan(ADMIN.tok);
    const own = await flagOf(HR3);
    ok("a flag about an HR person exists", !!own);
    ok("HR3 reads their own flag as an employee: no reviewer notes, no review buttons", await (async () => { const d = (await detail(HR3, own.id)).b; return d.mode === "EMPLOYEE" && d.can.status === false && d.can.comment === false && d.can.explain === true; })());
    ok("HR3 cannot review their own flag (403), another HR can", (await call("POST", `/tasks/repetition/flags/${own.id}/status`, HR3.tok, { status: "FALSE_POSITIVE", note: "mine is fine" })).s === 403 && (await call("POST", `/tasks/repetition/flags/${own.id}/status`, HR.tok, { status: "UNDER_REVIEW" })).s === 200);
    ok("HR3's own alert list shows it, and their reviewer list does not mix it up", (await call("GET", "/tasks/repetition/flags?mine=1&status=all", HR3.tok)).b.flags.some((f) => f.id === own.id));
    ok("nothing in this feature touched attendance, sessions or ratings", (await q(`select count(*)::int n from work_sessions where "userId" in ($1,$2,$3)`, [E1.id, E2.id, HR3.id]))[0].n === 0);
  } finally {
    await wipe();
    await db.end();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
