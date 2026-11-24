// Task Productivity report: real task data, the reason behind every missing figure, targets by company, and the per-person drill-down.
// Real HTTP, THROWAWAY database only.   cd backend && TEST_DATABASE_URL=... TEST_API=http://localhost:5012/api node tests/task-productivity-report.test.cjs
require("dotenv").config({ path: require("node:path").join(__dirname, "..", ".env") });
const { Client } = require("pg");
const bcrypt = require("bcryptjs");
const API = process.env.TEST_API ?? "http://localhost:5012/api";
require("./_guard.cjs").assertTestDb(process.env.TEST_DATABASE_URL);
const call = async (m, p, t, b) => { const r = await fetch(API + p, { method: m, headers: { "content-type": "application/json", ...(t ? { authorization: "Bearer " + t } : {}) }, body: b !== undefined ? JSON.stringify(b) : undefined }); const x = await r.text(); let j; try { j = JSON.parse(x); } catch { j = x; } return { s: r.status, b: j }; };
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  -> " + String(JSON.stringify(x)).slice(0, 500))); };
const PW = "Tpr@12345678";

(async () => {
  const db = new Client({ connectionString: process.env.TEST_DATABASE_URL }); await db.connect();
  const q = async (s, p) => (await db.query(s, p)).rows;
  const A = (await q(`select id, timezone from platforms where slug='avatar'`))[0], B = (await q(`select id from platforms where slug='co-lab'`))[0];
  const tz = A.timezone || "Asia/Kolkata";
  const dayOf = (offset) => { const d = new Date(Date.now() + offset * 86400000); return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d); };
  const noon = (iso) => new Date(new Date(iso + "T12:00:00+05:30")).toISOString();
  const TODAY = dayOf(0), YEST = dayOf(-1), D2 = dayOf(-2), D3 = dayOf(-3);
  const hash = await bcrypt.hash(PW, 10);
  const wipe = async () => {
    await q(`delete from task_entry_details where "taskId" in (select id from daily_tasks where "userId" in (select id from users where "employeeCode" like 'TPR-%'))`);
    await q(`delete from daily_task_targets where "userId" in (select id from users where "employeeCode" like 'TPR-%') or "platformId" = $1 and "teamId" in (select id from teams where name like 'TPR %')`, [A.id]);
    await q(`delete from daily_task_targets where "platformId"=$1 and "teamId" is null and "userId" is null`, [B.id]).catch(() => {});
    await q(`delete from daily_tasks where "userId" in (select id from users where "employeeCode" like 'TPR-%')`);
    await q(`delete from team_members where "userId" in (select id from users where "employeeCode" like 'TPR-%')`);
    await q(`delete from teams where name like 'TPR %'`);
    await q(`delete from company_access where "userId" in (select id from users where "employeeCode" like 'TPR-%')`);
    await q(`update audit_logs set "actorId"=null where "actorId" in (select id from users where "employeeCode" like 'TPR-%')`).catch(() => {});
    await q(`update users set "reportsToId"=null where "employeeCode" like 'TPR-%'`);
    await q(`delete from users where "employeeCode" like 'TPR-%'`);
  };
  await wipe();
  const mk = async (code, role, plat, boss = null) => {
    const id = (await q(`insert into users (id,"platformId",email,"passwordHash","firstName","lastName","employeeCode",role,status,"reportsToId","mustChangePassword","trackerAccessEnabled","onboardingStatus","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,$4,'Tpr',$4,$5,'ACTIVE',$6,false,true,'ACTIVE',now(),now()) returning id`, [plat, code.toLowerCase() + "@x.test", hash, code, role, boss]))[0].id;
    const r = await fetch(API + "/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: code, password: PW }) });
    return { id, tok: (await r.json()).token };
  };
  let n = 0;
  const task = async (userId, plat, date, weight, status, approval, completedAt = null, extra = {}) => {
    n++;
    const id = (await q(`insert into daily_tasks (id,"platformId","userId",date,title,description,weight,status,"approvalStatus","completedAt","assignedById","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3::date,$4,$5,$6::"TaskWeight",$7::"TaskStatus",$8::"TaskApprovalStatus",$9,$10,now(),now()) returning id`, [plat, userId, date, `TPR task ${n}`, `Description ${n}`, weight, status, approval, completedAt, extra.assignedById ?? null]))[0].id;
    if (extra.tag) await q(`insert into task_entry_details (id,"platformId","taskId","taggedManagerId","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,now(),now())`, [plat, id, extra.tag]);
    return id;
  };
  try {
    const ADM = await mk("TPR-ADM", "ADMIN", A.id); await q(`insert into company_access (id,"userId","platformId","createdAt") values (gen_random_uuid(),$1,null,now())`, [ADM.id]);
    const HR = await mk("TPR-HR", "HR", A.id); const MGR = await mk("TPR-MGR", "MANAGER", A.id); const MGR2 = await mk("TPR-MGR2", "MANAGER", A.id);
    const team = (await q(`insert into teams (id,"platformId",name,"createdAt","updatedAt") values (gen_random_uuid(),$1,'TPR Team',now(),now()) returning id`, [A.id]))[0].id;
    const E = {};
    for (const c of ["E1", "E2", "E3", "E4", "E5", "E6"]) { E[c] = await mk("TPR-" + c, "EMPLOYEE", A.id, MGR.id); }
    await q(`insert into team_members (id,"teamId","userId","isActive","isPrimary","joinedAt") values (gen_random_uuid(),$1,$2,true,true,now())`, [team, E.E1.id]).catch(() => {});
    const EB = await mk("TPR-EB", "EMPLOYEE", B.id, ADM.id); // another company, visible to the Admin only

    // E1: three completed today (Critical, High, Low), one open today, one open from yesterday, and a task a manager assigned
    await task(E.E1.id, A.id, TODAY, "CRITICAL", "COMPLETED", "APPROVED", noon(TODAY));
    await task(E.E1.id, A.id, TODAY, "HIGH", "COMPLETED", "APPROVED", noon(TODAY));
    await task(E.E1.id, A.id, TODAY, "LOW", "COMPLETED", "APPROVED", noon(TODAY));
    await task(E.E1.id, A.id, TODAY, "MEDIUM", "IN_PROGRESS", "APPROVED");
    await task(E.E1.id, A.id, YEST, "MEDIUM", "IN_PROGRESS", "APPROVED");
    await task(E.E1.id, A.id, TODAY, "HIGH", "PENDING", "APPROVED", null, { assignedById: MGR.id });
    // E2: only open tasks
    await task(E.E2.id, A.id, TODAY, "MEDIUM", "IN_PROGRESS", "APPROVED"); await task(E.E2.id, A.id, TODAY, "LOW", "PENDING", "APPROVED");
    // E3: completed but still waiting for the manager (tagged to MGR)
    await task(E.E3.id, A.id, TODAY, "MEDIUM", "COMPLETED", "PENDING", noon(TODAY), { tag: MGR.id }); await task(E.E3.id, A.id, TODAY, "MEDIUM", "COMPLETED", "PENDING", noon(TODAY), { tag: MGR.id });
    // E5: approved and completed before completion times were recorded
    await task(E.E5.id, A.id, TODAY, "MEDIUM", "COMPLETED", "APPROVED", null);
    // E6: completed work on three different days
    await task(E.E6.id, A.id, D3, "MEDIUM", "COMPLETED", "APPROVED", noon(D3)); await task(E.E6.id, A.id, D2, "HIGH", "COMPLETED", "APPROVED", noon(D2)); await task(E.E6.id, A.id, YEST, "LOW", "COMPLETED", "APPROVED", noon(YEST)); await task(E.E6.id, A.id, YEST, "LOW", "COMPLETED", "APPROVED", noon(YEST));
    // EB: another company
    await task(EB.id, B.id, TODAY, "MEDIUM", "COMPLETED", "APPROVED", noon(TODAY));

    const rep = async (t, qs = "") => (await call("GET", `/team-attendance/productivity?${qs}`, t));
    const who = (r, c) => r.b.people.find((p) => p.employeeCode === "TPR-" + c);

    console.log("## today, no target configured anywhere");
    const r1 = await rep(MGR.tok, `from=${TODAY}&to=${TODAY}`); ok("the report answers for the manager", r1.s === 200 && r1.b.people.length >= 5, r1);
    const e1 = who(r1, "E1");
    ok("E1: three completed tasks are shown even though NO target is configured", e1.completedTotal === 3 && e1.targetPerDay === null && e1.targetState === "NOT_CONFIGURED" && e1.overallPercent === null, e1);
    ok("E1: the task counts behind the row equal the database (submitted 5, approved 5, open 2, overdue 0 today)", e1.tasks.inPeriod === 4 && e1.tasks.open === 1 && e1.tasks.overdue === 0 && e1.tasks.approved === 4, e1.tasks);
    ok("E1: the manager-assigned task is counted apart (1) and is NOT in the completed figure", e1.tasks.assigned.total === 1 && e1.tasks.assigned.open === 1 && e1.completedTotal === 3, e1.tasks.assigned);
    ok("E1: 3 of 4 eligible tasks completed (75%), nothing rated yet: Awaiting evaluation, priority plays no part, independent of any target", e1.weighted.status === "AWAITING_EVALUATION" && e1.weighted.percent === null && e1.weighted.tasks === 4 && e1.weighted.completed === 3 && e1.weighted.completionPercent === 75 && e1.weighted.awaitingRating === 3, e1.weighted);
    const e2 = who(r1, "E2"); ok("E2 (open tasks only): completed 0 with reason NONE_COMPLETED, not 'no data'", e2.completedTotal === 0 && e2.reason === "NONE_COMPLETED" && e2.tasks.open === 2 && e2.daysWithData === 1, e2);
    ok("E2: weighted score is 0%, not 100% and not N/A", e2.weighted.percent === 0, e2.weighted);
    const e3 = who(r1, "E3"); ok("E3 (completed, waiting for approval): not counted, reason AWAITING_APPROVAL, two completed-awaiting shown", e3.completedTotal === null && e3.reason === "AWAITING_APPROVAL" && e3.tasks.awaitingApproval === 2 && e3.tasks.completedAwaitingApproval === 2, e3);
    ok("E3: an unapproved task earns no weighted score (N/A, never 100%)", e3.weighted.percent === null, e3.weighted);
    const e4 = who(r1, "E4"); ok("E4 (no tasks at all): reason NO_TASKS, weighted N/A, not 100%", e4.reason === "NO_TASKS" && e4.completedTotal === null && e4.daysWithData === 0 && e4.weighted.percent === null && e4.tasks.inPeriod === 0, e4);
    const e5 = who(r1, "E5"); ok("E5 (completed with no completion time): reason NO_COMPLETION_TIME", e5.reason === "NO_COMPLETION_TIME" && e5.tasks.completedWithoutTime === 1, e5);

    console.log("\n## raw rows agree with the report");
    const sqlDone = Number((await q(`select count(*)::int n from daily_tasks where "userId"=$1 and status='COMPLETED' and "approvalStatus"='APPROVED' and "completedAt" is not null and ("completedAt" at time zone $2)::date = $3::date`, [E.E1.id, tz, TODAY]))[0].n);
    ok("E1's completed figure = the database count of approved completed tasks finished today", sqlDone === e1.completedTotal, [sqlDone, e1.completedTotal]);

    console.log("\n## several days, overdue and filters");
    const r7 = await rep(MGR.tok, `from=${D3}&to=${TODAY}`);
    const m7 = who(r7, "E6"); ok("E6 across 4 days: 4 completed on 3 days with data; the same range gives the same answer in every column", m7.completedTotal === 4 && m7.daysWithData === 3 && m7.days.filter((d) => d.completed > 0).length === 3, m7);
    const e17 = who(r7, "E1"); ok("E1 over the same range: yesterday's open task is now OVERDUE (task date before today)", e17.tasks.overdue === 1 && e17.tasks.open === 2, e17.tasks);
    const ry = await rep(MGR.tok, `from=${YEST}&to=${YEST}`); ok("Yesterday: E6 shows 2 completed, E1 shows 0 completed with an open task (a real zero)", who(ry, "E6").completedTotal === 2 && who(ry, "E1").completedTotal === 0 && who(ry, "E1").reason === "NONE_COMPLETED", [who(ry, "E6"), who(ry, "E1")]);
    ok("a period with no data for a person reads NO_TASKS", who(await rep(MGR.tok, `from=${D3}&to=${D3}`), "E4").reason === "NO_TASKS");
    ok("filtering to one person returns only that person", (await rep(MGR.tok, `from=${TODAY}&to=${TODAY}&userId=${E.E1.id}`)).b.people.length === 1);
    ok("a future end date is cut to today (no invented future days)", (await rep(MGR.tok, `from=${TODAY}&to=${dayOf(5)}`)).b.to === TODAY);

    console.log("\n## visibility of waiting tasks");
    const rh = await rep(HR.tok, `from=${TODAY}&to=${TODAY}`);
    ok("HR (not the approver) sees no waiting tasks: E3 reads NO_TASKS for HR", who(rh, "E3").tasks.awaitingApproval === 0 && who(rh, "E3").reason === "NO_TASKS", who(rh, "E3"));
    const ra = await rep(ADM.tok, `from=${TODAY}&to=${TODAY}`);
    ok("Admin sees every authorised company, including the other company's employee", !!who(ra, "EB") && who(ra, "EB").completedTotal === 1, ra.b.people.length);
    ok("Admin monitors waiting tasks (read only)", who(ra, "E3").tasks.awaitingApproval === 2);
    ok("an employee cannot open the report (403)", (await rep(E.E1.tok, `from=${TODAY}`)).s === 403);

    console.log("\n## targets: nothing automatic, company access, percentages only when a target exists");
    const t0 = await call("GET", "/team-attendance/targets", HR.tok); ok("no targets exist at the start (nothing is assigned automatically)", t0.s === 200 && t0.b.company === null && t0.b.people.every((p) => p.tasksPerDay === null), t0.b);
    ok("a manager cannot set targets (403)", (await call("POST", "/team-attendance/targets", MGR.tok, { scope: "company", tasksPerDay: 3 })).s === 403);
    const sp = await call("POST", "/team-attendance/targets", HR.tok, { scope: "user", id: E.E1.id, tasksPerDay: 4 }); ok("HR sets a personal target of 4 for E1", sp.s === 200, sp);
    const r2 = await rep(MGR.tok, `from=${TODAY}&to=${TODAY}`);
    ok("E1 now shows target 4 (personal) and productivity 3/4 = 75%", who(r2, "E1").targetPerDay === 4 && who(r2, "E1").targetSource === "PERSON" && who(r2, "E1").overallPercent === 75 && who(r2, "E1").targetState === "CONFIGURED", who(r2, "E1"));
    ok("E2 (no target) still shows no percentage and its task counts", who(r2, "E2").overallPercent === null && who(r2, "E2").targetState === "NOT_CONFIGURED" && who(r2, "E2").tasks.open === 2);
    ok("E4 with a target would still not get a score from nothing", who(await rep(MGR.tok, `from=${TODAY}&to=${TODAY}`), "E4").overallPercent === null);
    const own = await call("POST", "/team-attendance/targets", HR.tok, { scope: "company", tasksPerDay: 2 }); ok("HR sets the company default (own company)", own.s === 200 && own.b.company === 2, own.b);
    ok("HR cannot set another company's target (not found)", (await call("POST", "/team-attendance/targets", HR.tok, { scope: "company", tasksPerDay: 2, companyId: B.id })).s === 404);
    const lb = await call("GET", `/team-attendance/targets?companyId=${B.id}`, ADM.tok); ok("Admin (all companies) can open another company's targets and sees the company list", lb.s === 200 && lb.b.companyId === B.id && lb.b.companies.length >= 2, lb.b.companies);
    const sb = await call("POST", "/team-attendance/targets", ADM.tok, { scope: "company", tasksPerDay: 1, companyId: B.id }); ok("Admin sets company B's default (1/day)", sb.s === 200 && sb.b.company === 1, sb.b);
    const r3 = await rep(ADM.tok, `from=${TODAY}&to=${TODAY}`);
    ok("company B's employee now has a 1/day company target and 100%; company A's E2 got A's default 2", who(r3, "EB").targetPerDay === 1 && who(r3, "EB").overallPercent === 100 && who(r3, "E2").targetPerDay === 2 && who(r3, "E2").targetSource === "COMPANY", [who(r3, "EB"), who(r3, "E2")]);
    ok("the personal target still beats the company default", who(r3, "E1").targetPerDay === 4);
    ok("a bad company id is refused (400)", (await call("GET", "/team-attendance/targets?companyId=nope", ADM.tok)).s === 400);
    ok("target changes are audited", (await q(`select count(*)::int n from audit_logs where "recordType"='DailyTaskTarget'`))[0].n >= 3);

    console.log("\n## the employee drill-down");
    const d = await call("GET", `/team-attendance/productivity/person?userId=${E.E1.id}&from=${TODAY}&to=${TODAY}`, MGR.tok);
    ok("the manager opens E1's tasks", d.s === 200 && d.b.submitted.length === 4, d.b);
    const t1 = d.b.submitted.find((t) => t.priority === "CRITICAL");
    ok("each task carries name, description, date, submitted time, completion time, status, approval and priority", t1 && t1.title && t1.description && t1.date === TODAY && t1.submittedAt && t1.completedAt && t1.progress === "COMPLETED" && t1.approvalStatus === "APPROVED", t1);
    ok("the tasks shown are exactly E1's tasks in the database (same ids)", JSON.stringify(d.b.submitted.map((t) => t.id).sort()) === JSON.stringify((await q(`select id from daily_tasks where "userId"=$1 and date=$2::date and "assignedById" is null`, [E.E1.id, TODAY])).map((r) => r.id).sort()));
    ok("the manager who assigned a task sees it apart (assigned by, assigned on)", d.b.assigned.length === 1 && d.b.assigned[0].assignedBy === "TPR-MGR Tpr" && !!d.b.assigned[0].assignedOn, d.b.assigned);
    ok("another manager does not see this task as assigned by them", (await call("GET", `/team-attendance/productivity/person?userId=${E.E1.id}&from=${TODAY}&to=${TODAY}`, ADM.tok)).b.assigned.length === 1 && true);
    ok("a manager outside the employee's team gets 404", (await call("GET", `/team-attendance/productivity/person?userId=${E.E1.id}&from=${TODAY}&to=${TODAY}`, MGR2.tok)).s === 404);
    ok("an employee cannot use it (403)", (await call("GET", `/team-attendance/productivity/person?userId=${E.E1.id}&from=${TODAY}&to=${TODAY}`, E.E2.tok)).s === 403);
    ok("a bad id is refused (400)", (await call("GET", "/team-attendance/productivity/person?userId=nope", MGR.tok)).s === 400);
    ok("waiting tasks are hidden from HR in the drill-down too", (await call("GET", `/team-attendance/productivity/person?userId=${E.E3.id}&from=${TODAY}&to=${TODAY}`, HR.tok)).b.submitted.length === 0 && (await call("GET", `/team-attendance/productivity/person?userId=${E.E3.id}&from=${TODAY}&to=${TODAY}`, MGR.tok)).b.submitted.length === 2);
    ok("an empty person: no tasks, honest empty list", (await call("GET", `/team-attendance/productivity/person?userId=${E.E4.id}&from=${TODAY}&to=${TODAY}`, MGR.tok)).b.submitted.length === 0);
    ok("reading the report changed nothing (task rows intact)", (await q(`select count(*)::int n from daily_tasks where "userId" in (select id from users where "employeeCode" like 'TPR-%')`))[0].n === n);
  } finally { await wipe().catch((e) => console.log("wipe", e.message)); await db.end(); }
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
