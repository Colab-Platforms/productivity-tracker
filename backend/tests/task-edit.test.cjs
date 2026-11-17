// Editing a submitted task, correction requests, history and permissions: real sign-ins, real HTTP, disposable DB only.
//   cd backend && TEST_DATABASE_URL=... TEST_API=http://localhost:5012/api node tests/task-edit.test.cjs
require("dotenv").config({ path: require("node:path").join(__dirname, "..", ".env") });
const { Client } = require("pg");
const bcrypt = require("bcryptjs");
const API = process.env.TEST_API ?? "http://localhost:5012/api";
require("./_guard.cjs").assertTestDb(process.env.TEST_DATABASE_URL);

const call = async (m, p, t, body) => {
  const r = await fetch(API + p, { method: m, headers: { ...(t ? { authorization: "Bearer " + t } : {}), ...(body && m !== "GET" ? { "content-type": "application/json" } : {}) }, body: body && m !== "GET" ? JSON.stringify(body) : undefined });
  const txt = await r.text(); let j; try { j = JSON.parse(txt); } catch { j = txt; }
  return { s: r.status, b: j };
};
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  -> " + String(JSON.stringify(x)).slice(0, 500))); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PW = "Ted@12345678";
const isoDay = (offset) => new Date(Date.now() + 330 * 60000 + offset * 86400000).toISOString().slice(0, 10);

(async () => {
  const db = new Client({ connectionString: process.env.TEST_DATABASE_URL }); await db.connect();
  const q = async (s, p) => (await db.query(s, p)).rows;
  const AV = (await q(`select id from platforms where slug='avatar'`))[0].id;
  const hash = await bcrypt.hash(PW, 10);
  const wipe = async () => {
    const ids = `(select id from users where "employeeCode" like 'TED-%')`;
    await q(`delete from task_ratings where "taskId" in (select id from daily_tasks where "userId" in ${ids})`).catch(() => {});
    await q(`delete from task_late_details where "userId" in ${ids}`).catch(() => {});
    await q(`delete from task_entry_details where "taskId" in (select id from daily_tasks where "userId" in ${ids})`);
    await q(`delete from daily_tasks where "userId" in ${ids}`); // task_events go with their task (cascade)
    await q(`delete from team_members where "userId" in ${ids}`);
    await q(`delete from teams where name like 'TED-%'`);
    await q(`delete from notifications where "userId" in ${ids}`);
    await q(`delete from users where "employeeCode" like 'TED-%'`);
  };
  await wipe();
  const mk = async (code, role, o = {}) => {
    await q(`insert into users (id,"platformId",email,"passwordHash","firstName","lastName","employeeCode",role,status,"mustChangePassword","trackerAccessEnabled","onboardingStatus","reportsToId","dateOfJoining","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,$4,'Ted',$5,$6,'ACTIVE',false,true,'ACTIVE',$7,'2026-01-01',now(),now())`, [AV, code.toLowerCase() + "@ted.test", hash, o.first ?? code.replace("TED-", ""), code, role, o.boss ?? null]);
    const id = (await q(`select id from users where "employeeCode"=$1`, [code]))[0].id;
    const tok = (await (await fetch(API + "/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: code, password: PW }) })).json()).token;
    return { id, tok };
  };
  const ADMIN = await mk("TED-ADMIN", "ADMIN", { first: "AdminT" });
  const HR = await mk("TED-HR", "HR", { first: "HrT", boss: ADMIN.id });
  const M1 = await mk("TED-M1", "MANAGER", { first: "MgrOne", boss: ADMIN.id });
  const M2 = await mk("TED-M2", "MANAGER", { first: "MgrTwo", boss: ADMIN.id });
  const E1 = await mk("TED-E1", "EMPLOYEE", { first: "EmpOne", boss: M1.id });
  const E2 = await mk("TED-E2", "EMPLOYEE", { first: "EmpTwo", boss: M1.id });
  const team = async (name, manager, members) => {
    const id = (await q(`insert into teams (id,"platformId",name,"managerId","isActive","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,true,now(),now()) returning id`, [AV, name, manager.id]))[0].id;
    for (const u of members) await q(`insert into team_members (id,"teamId","userId","isActive","isPrimary","joinedAt") values (gen_random_uuid(),$1,$2,true,false,now())`, [id, u.id]);
    return id;
  };
  const P1 = await team("TED-Alpha", M1, [E1, E2]);
  const P2 = await team("TED-Beta", M2, [E1]);
  // M2 needs a report so the tag list offers them: they are a project manager already.

  const list = async (who) => (await call("GET", "/tasks", who.tok)).b;
  const rowOf = async (who, id) => (await call("GET", `/tasks/range?from=${isoDay(-30)}&to=${isoDay(0)}`, who.tok)).b.tasks.find((t) => t.id === id);
  const idOf = async (title) => (await q(`select id from daily_tasks where title=$1`, [title]))[0]?.id;
  const send = async (who, title, extra = {}) => {
    const r = await call("POST", "/tasks", who.tok, { title, teamId: P1, taggedManagerId: M1.id, progress: "IN_PROGRESS", hoursSpent: 1, weight: "MEDIUM", ...extra });
    return { r, id: await idOf(title) };
  };
  const edit = async (who, id, body, ver) => call("POST", `/tasks/${id}/edit`, who.tok, { version: ver ?? (await rowOf(who, id))?.version, ...body });
  const notes = async (user, type) => (await q(`select count(*)::int n from notifications where "userId"=$1 and type=$2`, [user.id, type]))[0].n;
  const changes = async (who, id) => call("GET", `/tasks/${id}/changes`, who.tok);
  const approve = (mgr, id, approve = true, note) => call("POST", `/tasks/review/${id}/approve`, mgr.tok, { approve, ...(note ? { note, rejectionNote: note } : {}) });

  try {
    console.log("## 1. Edit a PENDING task: every field, the manager and the project");
    const a = await send(E1, "TED task one");
    ok("employee submits a task (pending, tagged to MgrOne)", a.r.s === 200 && !!a.id, a.r);
    const r0 = await rowOf(E1, a.id);
    ok("the row says it can be edited directly and carries a version", r0.editRoute === "DIRECT" && !!r0.version && r0.edited === null && r0.pendingCorrection === false, r0);
    const y = isoDay(-1);
    const e1 = await edit(E1, a.id, { title: "TED task one (edited)", description: "more detail", teamId: P2, taggedManagerId: M2.id, date: y, hoursSpent: 3.5, weight: "HIGH", progress: "BLOCKED", blockedNote: "waiting for access" });
    ok("the edit is accepted", e1.s === 200, e1);
    const db1 = (await q(`select d.title, d.description, d."teamId", d.date::text date, d.weight::text weight, d."approvalStatus"::text ap, d.status::text st, e."hoursSpent", e."taggedManagerId", e.blocked, e."blockedNote" from daily_tasks d join task_entry_details e on e."taskId"=d.id where d.id=$1`, [a.id]))[0];
    ok("every edited field is saved (title, details, project, manager, date, hours, priority, progress, blocked reason)", db1.title === "TED task one (edited)" && db1.description === "more detail" && db1.teamId === P2 && db1.taggedManagerId === M2.id && db1.date === y && db1.hoursSpent === 3.5 && db1.weight === "HIGH" && db1.blocked === true && db1.blockedNote === "waiting for access", db1);
    ok("it is still PENDING for approval", db1.ap === "PENDING", db1);
    const late = (await q(`select "lateByDays" from task_late_details where "taskId"=$1`, [a.id]))[0];
    ok("moving it to yesterday follows the backdated-task policy (a late-submission record, 1 day)", late?.lateByDays === 1, late);
    const h1 = await changes(E1, a.id);
    const c1 = h1.b.changes[0];
    ok("the history has one row with old and new values, who, when, approval before/after", h1.s === 200 && h1.b.changes.length === 1 && c1.type === "EDIT" && c1.by === "EmpOne Ted" && !!c1.at && c1.approvalBefore === "PENDING" && c1.approvalAfter === "PENDING" && c1.before.title === "TED task one" && c1.after.title === "TED task one (edited)", h1.b);
    ok("the previous and the new manager and project are in the history", c1.before.manager === "MgrOne Ted" && c1.after.manager === "MgrTwo Ted" && c1.before.project === "TED-Alpha" && c1.after.project === "TED-Beta", c1);
    ok("the row now says Edited with a time", (await rowOf(E1, a.id)).edited?.count === 1, await rowOf(E1, a.id));
    ok("the NEW manager is told it needs approval", (await notes(M2, "TASK_PROPOSED")) === 1);
    ok("the OLD manager is told it moved to someone else", (await notes(M1, "TASK_MOVED")) === 1);
    const q2 = (await call("GET", "/tasks/review/queue", M2.tok)).b;
    const qrow = (q2.proposals ?? []).find((t) => t.id === a.id);
    ok("the new manager sees it under Needs Approval, marked as edited", !!qrow && qrow.canAct === true && qrow.edited?.count === 1, qrow);
    ok("the old manager no longer sees it", !((await call("GET", "/tasks/review/queue", M1.tok)).b.all ?? []).some((t) => t.id === a.id));
    const audit = (await q(`select summary, before, after from audit_logs where module='Tasks' and summary like 'Edited the task%' order by "createdAt" desc limit 1`))[0];
    ok("the audit log has the edit with before and after", !!audit && JSON.stringify(audit.after).includes("TED task one (edited)") && JSON.stringify(audit.before).includes("MgrOne"), audit);

    console.log("\n## 2. Validation and the backdated-task policy");
    const v2 = (await rowOf(E1, a.id)).version;
    ok("Blocked without a reason is refused (400)", (await edit(E1, a.id, { progress: "BLOCKED", blockedNote: "" }, v2)).s === 400);
    ok("a manager who is not on the tag list is refused (400)", (await edit(E1, a.id, { taggedManagerId: HR.id }, v2)).s === 400);
    ok("a project that is not available is refused (403)", (await edit(E1, a.id, { teamId: "00000000-0000-4000-8000-000000000000" }, v2)).s === 403);
    ok("a future date is refused (400)", (await edit(E1, a.id, { date: isoDay(1) }, v2)).s === 400);
    ok("a date older than 14 days is refused (400)", (await edit(E1, a.id, { date: isoDay(-20) }, v2)).s === 400);
    const noReason = await edit(E1, a.id, { date: isoDay(-8) }, v2);
    ok("a date outside the company window needs a written reason (400)", noReason.s === 400, noReason);
    const withReason = await edit(E1, a.id, { date: isoDay(-8), lateReason: "forgot to log it" }, v2);
    ok("...and is accepted with one", withReason.s === 200, withReason);
    ok("the late record now says it is outside the window with that reason", (await q(`select "outsideWindow", reason from task_late_details where "taskId"=$1`, [a.id]))[0]?.reason === "forgot to log it");
    const back = await edit(E1, a.id, { date: isoDay(0) });
    ok("moving it back to today removes the late-submission record", back.s === 200 && (await q(`select count(*)::int n from task_late_details where "taskId"=$1`, [a.id]))[0].n === 0, back);
    const same = await edit(E1, a.id, { title: (await rowOf(E1, a.id)).title });
    ok("sending the same values changes nothing (400 nothing to update)", same.s === 400, same);
    ok("no version sent is refused (400)", (await call("POST", `/tasks/${a.id}/edit`, E1.tok, { title: "x" })).s === 400);
    ok("a stale version is refused (409)", (await edit(E1, a.id, { title: "stale" }, 1)).s === 409);

    console.log("\n## 3. Nobody edits another person's task");
    const b = await send(E1, "TED task two");
    const v3 = (await rowOf(E1, b.id)).version;
    for (const [who, name] of [[E2, "another employee"], [M1, "the manager"], [HR, "HR"], [ADMIN, "an Admin"]]) {
      const x = await call("POST", `/tasks/${b.id}/edit`, who.tok, { version: v3, title: "hijack" });
      ok(`${name} cannot edit it (404)`, x.s === 404, x);
      const c = await call("POST", `/tasks/${b.id}/correction`, who.tok, { title: "hijack", reason: "no" + "pe" });
      ok(`${name} cannot request a correction on it (404)`, c.s === 404, c);
    }
    ok("the title is untouched", (await q(`select title from daily_tasks where id=$1`, [b.id]))[0].title === "TED task two");
    await q(`update daily_tasks set "assignedById"=$1 where id=$2`, [M1.id, b.id]);
    ok("a task a manager ASSIGNED cannot be edited by its owner (refused: it has its own workflow now)", [403, 404].includes((await call("POST", `/tasks/${b.id}/edit`, E1.tok, { version: v3, title: "mine now" })).s));
    await q(`update daily_tasks set "assignedById"=null where id=$1`, [b.id]);

    console.log("\n## 4. Concurrent edits");
    const c0 = await send(E1, "TED race edit");
    const vr = (await rowOf(E1, c0.id)).version;
    const [r1, r2] = await Promise.all([edit(E1, c0.id, { title: "race A" }, vr), edit(E1, c0.id, { hoursSpent: 5 }, vr)]);
    ok("two edits with the same version: exactly one wins, the other gets 409", [r1.s, r2.s].sort().join() === "200,409", [r1.s, r2.s]);
    ok("the history has exactly one edit row", (await changes(E1, c0.id)).b.changes.length === 1);
    let racesOk = true, detail = [];
    for (let i = 0; i < 4; i++) {
      const t = await send(E1, "TED approval race " + i);
      const ver = (await rowOf(E1, t.id)).version;
      const [ed, ap] = await Promise.all([edit(E1, t.id, { title: "TED approval race " + i + " edited" }, ver), approve(M1, t.id)]);
      const row = (await q(`select title, "approvalStatus"::text ap, "approvedById" from daily_tasks where id=$1`, [t.id]))[0];
      const edited = row.title.endsWith("edited");
      // an edit that lost the race is refused and leaves the approval alone; an edit that won leaves the title changed and the approval is whatever the manager did after
      const consistent = ed.s !== 500 && ap.s !== 500 && (ed.s === 200) === edited && (ap.s === 200 ? row.ap === "APPROVED" && row.approvedById === M1.id : true);
      if (!consistent) { racesOk = false; detail.push({ i, ed: ed.s, ap: ap.s, row }); }
    }
    ok("an edit racing the manager's approval never loses the approval or half-saves", racesOk, detail);

    console.log("\n## 5. A REJECTED task: edit and resubmit, the old reason is kept");
    const rj = await send(E1, "TED rejected");
    await approve(M1, rj.id, false, "needs more detail");
    const rrow = await rowOf(E1, rj.id);
    ok("it is REJECTED with the reason", rrow.approvalStatus === "REJECTED" && rrow.rejectionNote === "needs more detail" && rrow.editRoute === "DIRECT", rrow);
    const m1before = await notes(M1, "TASK_PROPOSED");
    const rEdit = await edit(E1, rj.id, { title: "TED rejected, fixed", description: "now with detail" });
    ok("the employee edits and resubmits it", rEdit.s === 200, rEdit);
    const rdb = (await q(`select "approvalStatus"::text ap, "rejectionNote", "approvedById" from daily_tasks where id=$1`, [rj.id]))[0];
    ok("it is PENDING again with the approval cleared", rdb.ap === "PENDING" && rdb.rejectionNote === null && rdb.approvedById === null, rdb);
    const rh = (await changes(E1, rj.id)).b.changes[0];
    ok("the history keeps the previous rejection reason and shows REJECTED -> PENDING", rh.previousRejection === "needs more detail" && rh.approvalBefore === "REJECTED" && rh.approvalAfter === "PENDING", rh);
    ok("the manager is told it was resubmitted", (await notes(M1, "TASK_PROPOSED")) === m1before + 1);
    ok("the manager can open the history and see the earlier reason", (await changes(M1, rj.id)).b.changes[0].previousRejection === "needs more detail");

    console.log("\n## 6. An APPROVED task: no direct edit, a correction request instead");
    const ap0 = await send(E1, "TED approved");
    await approve(M1, ap0.id);
    const apRow = await rowOf(E1, ap0.id);
    ok("it is approved and the row routes edits to a correction", apRow.approvalStatus === "APPROVED" && apRow.editRoute === "CORRECTION", apRow);
    const dEdit = await edit(E1, ap0.id, { title: "direct" });
    ok("a direct edit is refused (409 use a correction)", dEdit.s === 409, dEdit);
    const prog = await call("PATCH", `/tasks/${ap0.id}`, E1.tok, { progress: "COMPLETED" });
    ok("the normal progress update on an approved task still works", prog.s === 200, prog);
    const approvedBefore = (await q(`select "approvedById", "approvedAt"::text at from daily_tasks where id=$1`, [ap0.id]))[0];
    const corr = (extra = {}) => call("POST", `/tasks/${ap0.id}/correction`, E1.tok, { title: "TED approved (corrected)", hoursSpent: 4, reason: "typo in the title", ...extra });
    ok("a correction with no reason is refused (400)", (await corr({ reason: "" })).s === 400);
    ok("a correction that changes the date is refused (400)", (await corr({ date: isoDay(-1) })).s === 400);
    ok("a correction that changes the manager is refused (400)", (await corr({ taggedManagerId: M2.id })).s === 400);
    ok("a correction that changes nothing is refused (400)", (await call("POST", `/tasks/${ap0.id}/correction`, E1.tok, { title: "TED approved", reason: "nothing really" })).s === 400);
    const [c1r, c2r] = await Promise.all([corr(), corr()]);
    ok("two identical requests at once make exactly ONE request", [c1r.s, c2r.s].sort().join() === "200,409", [c1r.s, c2r.s]);
    ok("a second request while one waits is refused (409)", (await corr()).s === 409);
    const still = (await q(`select title from daily_tasks where id=$1`, [ap0.id]))[0];
    ok("nothing about the task changed yet (the original stays official)", still.title === "TED approved", still);
    ok("the row shows a correction is waiting", (await rowOf(E1, ap0.id)).pendingCorrection === true);
    ok("the tagged manager was notified of the request", (await notes(M1, "TASK_CORRECTION_REQUESTED")) === 1);
    const pend = (await call("GET", "/tasks/corrections/pending", M1.tok)).b;
    const pc = pend.corrections?.find((c) => c.taskId === ap0.id);
    ok("the manager's pending list shows it with the reason and before/after", !!pc && pc.reason === "typo in the title" && pc.before.title === "TED approved" && pc.after.title === "TED approved (corrected)" && pc.changed.includes("Task"), pend);
    for (const [who, name] of [[M2, "another manager"], [HR, "HR"], [ADMIN, "an Admin"]]) {
      ok(`${name} has nothing to decide`, !((await call("GET", "/tasks/corrections/pending", who.tok)).b.corrections ?? []).some((c) => c.taskId === ap0.id));
      const d = await call("POST", `/tasks/review/${ap0.id}/correction`, who.tok, { requestId: pc.requestId, approve: true });
      ok(`${name} cannot decide it (403)`, d.s === 403 || d.s === 404, d);
    }
    ok("the employee cannot decide their own request", [403, 404].includes((await call("POST", `/tasks/review/${ap0.id}/correction`, E1.tok, { requestId: pc.requestId, approve: true })).s));
    ok("HR and Admin can READ the history (company scope); another employee cannot", (await changes(HR, ap0.id)).s === 200 && (await changes(ADMIN, ap0.id)).s === 200 && (await changes(E2, ap0.id)).s === 404);
    ok("declining needs a note (400)", (await call("POST", `/tasks/review/${ap0.id}/correction`, M1.tok, { requestId: pc.requestId, approve: false })).s === 400);
    const [dA, dB] = await Promise.all([call("POST", `/tasks/review/${ap0.id}/correction`, M1.tok, { requestId: pc.requestId, approve: true }), call("POST", `/tasks/review/${ap0.id}/correction`, M1.tok, { requestId: pc.requestId, approve: false, note: "not now" })]);
    ok("an approval and a decline at once: exactly one decision is recorded", [dA.s, dB.s].sort().join() === "200,409", [dA.s, dB.s]);
    const after = (await q(`select title, "approvalStatus"::text ap, "approvedById", "approvedAt"::text at from daily_tasks where id=$1`, [ap0.id]))[0];
    const decided = (await changes(E1, ap0.id)).b.changes;
    const approvedWon = decided.some((c) => c.type === "CORRECTION_APPROVED");
    ok("either way the task and its history agree", approvedWon ? after.title === "TED approved (corrected)" : after.title === "TED approved", { after, types: decided.map((c) => c.type) });
    ok("the original approval (who and when) is preserved", after.ap === "APPROVED" && after.approvedById === approvedBefore.approvedById && after.at === approvedBefore.at, after);
    ok("a decision cannot be repeated (409)", (await call("POST", `/tasks/review/${ap0.id}/correction`, M1.tok, { requestId: pc.requestId, approve: true })).s === 409);
    ok("the employee was told the outcome", (await notes(E1, "TASK_CORRECTION_DECIDED")) === 1);

    console.log("\n## 7. A declined correction changes nothing and a new one can be sent");
    const dc = await send(E1, "TED decline");
    await approve(M1, dc.id);
    await call("POST", `/tasks/${dc.id}/correction`, E1.tok, { description: "better words", reason: "clearer" });
    const pid = (await call("GET", "/tasks/corrections/pending", M1.tok)).b.corrections.find((c) => c.taskId === dc.id).requestId;
    const dd = await call("POST", `/tasks/review/${dc.id}/correction`, M1.tok, { requestId: pid, approve: false, note: "keep the original" });
    ok("the manager declines with a note", dd.s === 200, dd);
    ok("the task is unchanged and the decline is in the history with the note", (await q(`select description from daily_tasks where id=$1`, [dc.id]))[0].description === null && (await changes(E1, dc.id)).b.changes.some((c) => c.type === "CORRECTION_REJECTED" && c.decisionNote === "keep the original"));
    ok("the Edited label does not appear for a declined correction", (await rowOf(E1, dc.id)).edited === null);
    ok("the employee can send a new correction afterwards", (await call("POST", `/tasks/${dc.id}/correction`, E1.tok, { description: "second try", reason: "clearer words" })).s === 200);

    console.log("\n## 8. A RATED task: no direct edit, approval clears the rating (copied into the history)");
    const rt = await send(E1, "TED rated");
    await approve(M1, rt.id);
    await call("PATCH", `/tasks/${rt.id}`, E1.tok, { progress: "COMPLETED" });
    const rate = await call("POST", `/tasks/review/${rt.id}/rating`, M1.tok, { rating: 4, comment: "good work" });
    ok("the manager rates it 4 stars", rate.s === 200, rate);
    ok("the row is rated and routes edits to a correction", (await rowOf(E1, rt.id)).rating === 4 && (await rowOf(E1, rt.id)).editRoute === "CORRECTION");
    ok("a direct edit of a rated task is refused (409)", (await edit(E1, rt.id, { title: "no" })).s === 409);
    const ratedIn = async () => { const x = await call("GET", `/reports?from=${isoDay(0)}&to=${isoDay(0)}`, ADMIN.tok); return (x.b.people ?? x.b.rows ?? []).find((p) => p.userId === E1.id)?.ratedCount; };
    ok("Reports count the rating before the correction (rated tasks = 1)", (await ratedIn()) === 1, await ratedIn());
    await call("POST", `/tasks/${rt.id}/correction`, E1.tok, { title: "TED rated (corrected)", reason: "wrong name" });
    const rpid = (await call("GET", "/tasks/corrections/pending", M1.tok)).b.corrections.find((c) => c.taskId === rt.id);
    ok("the manager sees the existing rating next to the request", rpid.rated === true && rpid.rating === 4 && rpid.ratingComment === "good work", rpid);
    const rApprove = await call("POST", `/tasks/review/${rt.id}/correction`, M1.tok, { requestId: rpid.requestId, approve: true, note: "ok" });
    ok("the manager approves it", rApprove.s === 200, rApprove);
    ok("Reports no longer count it after the correction (rated tasks = 0)", (await ratedIn()) === 0, await ratedIn());
    ok("the rating is gone from the task", (await q(`select count(*)::int n from task_ratings where "taskId"=$1`, [rt.id]))[0].n === 0 && (await rowOf(E1, rt.id)).rating == null);
    const rh2 = (await changes(M1, rt.id)).b.changes.find((c) => c.type === "CORRECTION_APPROVED");
    ok("the original rating and feedback are kept in the history", rh2.ratingCleared === true && rh2.rating?.rating === 4 && rh2.rating?.comment === "good work", rh2);
    ok("the history shows the original and the new title", rh2.before.title === "TED rated" && rh2.after.title === "TED rated (corrected)", rh2);
    const queue = (await call("GET", "/tasks/review/queue", M1.tok)).b;
    ok("the task is back in the manager's to-rate list, still approved", (queue.toReview ?? []).some((t) => t.id === rt.id) && (await q(`select "approvalStatus"::text ap from daily_tasks where id=$1`, [rt.id]))[0].ap === "APPROVED");
    ok("the Edited label shows after the approved correction", (await rowOf(E1, rt.id)).edited?.count === 1);

    console.log("\n## 9. HR and Admin keep their rules");
    const hrT = await send(E1, "TED hr check");
    ok("HR cannot approve a task (unchanged)", [403, 404].includes((await approve(HR, hrT.id)).s));
    ok("an Admin who is not tagged cannot approve it (unchanged)", [403, 404].includes((await approve(ADMIN, hrT.id)).s));
    ok("the audit log recorded the correction request and its decision", (await q(`select count(*)::int n from audit_logs where module='Tasks' and (summary like 'Asked for a correction%' or summary like 'Approved a correction%' or summary like 'Declined a correction%')`))[0].n >= 3);
  } finally {
    await wipe();
    await db.end();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
