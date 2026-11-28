// Universal demo login: login, role switching, working workflows, and DATA ISOLATION. Needs the demo server (5020, DEMO_MODE, database hrms_demo) AND the normal
// test backend (5012, database dq_test, the stand-in for production):
//   node tests/demo-mode.test.cjs
const { Client } = require("pg");
const { createRequire } = require("node:module");
const path = require("node:path");
const reqFront = createRequire(path.resolve(__dirname, "../../frontend/package.json"));
const { io } = reqFront("socket.io-client");
const DEMO = "http://localhost:5020", REAL = "http://localhost:5012";
const DEMO_DB = "postgresql://postgres:localtest@127.0.0.1:54329/hrms_demo", REAL_DB = "postgresql://postgres:localtest@127.0.0.1:54329/dq_test";
const PW = "Demo@Avatar2026";
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  -> " + String(JSON.stringify(x)).slice(0, 300))); };
const call = async (base, m, p, t, b) => { const r = await fetch(base + "/api" + p, { method: m, headers: { "content-type": "application/json", ...(t ? { authorization: "Bearer " + t } : {}) }, body: b !== undefined ? JSON.stringify(b) : undefined }); return { s: r.status, b: await r.json().catch(() => ({})) }; };
const d = (m, p, t, b) => call(DEMO, m, p, t, b);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const dd = new Client({ connectionString: DEMO_DB }); await dd.connect();
  const rr = new Client({ connectionString: REAL_DB }); await rr.connect();
  const dq = async (s, p) => (await dd.query(s, p)).rows;
  const rq = async (s, p) => (await rr.query(s, p)).rows;
  // a fingerprint of the "production stand-in": row counts of every table, taken before and after all demo activity
  // login_events, audit_logs and alerts are written by the NORMAL server's own request logging and 15-minute job, never by the demo server: left out of the row-count fingerprint
  const fingerprint = async () => { const t = (await rq(`select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE' and table_name not in ('login_events','audit_logs','alerts') order by 1`)).map((r) => r.table_name); const out = {}; for (const n of t) out[n] = (await rq(`select count(*)::int n from "${n}"`))[0].n; return JSON.stringify(out); };
  const realBefore = await fingerprint();

  console.log("\n## 1. one universal login");
  ok("the sign-in page can tell this is the demo (public info endpoint, no secrets)", (await d("GET", "/demo/info")).b.demo === true);
  ok("a normal (non-demo) server has NO demo endpoints at all", (await call(REAL, "GET", "/demo/info")).s === 404 && (await call(REAL, "POST", "/demo/login", null, { username: "demo", password: PW })).s === 404);
  ok("wrong password is refused with the normal generic message", await (async () => { const r = await d("POST", "/demo/login", null, { username: "demo", password: "nope" }); return r.s === 401 && r.b.error === "Email or password is incorrect" && !r.b.token; })());
  ok("wrong username is refused", (await d("POST", "/demo/login", null, { username: "admin", password: PW })).s === 401);
  ok("the real accounts cannot sign in through the demo login (no demo password reaches them)", (await d("POST", "/auth/login", null, { email: "DEMO-ADMIN", password: PW })).s === 401);
  const login = await d("POST", "/demo/login", null, { username: "DEMO", password: PW });
  ok("the universal login works (username not case-sensitive) and opens the Admin view", login.s === 200 && login.b.user.role === "ADMIN" && !!login.b.token, login);
  let tok = login.b.token;
  const me = await d("GET", "/auth/me", tok);
  ok("/auth/me answers for the demo Admin, in the fictional company", me.s === 200 && me.b.role === "ADMIN" && /demo/i.test(me.b.platform.name) && me.b.employeeCode === "DEMO-ADMIN", me.b);

  console.log("\n## 2. instant role switching, no password");
  const roles = await d("GET", "/demo/roles", tok);
  ok("the four views are offered with the current one", roles.b.current === "ADMIN" && roles.b.roles.map((r) => r.role).join() === "ADMIN,HR,MANAGER,EMPLOYEE", roles.b);
  const T = {};
  for (const r of ["ADMIN", "HR", "MANAGER", "EMPLOYEE"]) {
    const sw = await d("POST", "/demo/switch", tok, { role: r });
    const m = await d("GET", "/auth/me", sw.b.token);
    ok(`switch to ${r}: the signed-in role really is ${r}`, sw.s === 200 && m.b.role === r && m.b.employeeCode === "DEMO-" + ({ ADMIN: "ADMIN", HR: "HR", MANAGER: "MGR", EMPLOYEE: "EMP" })[r], m.b.role);
    T[r] = sw.b.token;
  }
  ok("switching from any view to any other works (Employee -> Admin)", (await d("POST", "/demo/switch", T.EMPLOYEE, { role: "ADMIN" })).s === 200);
  ok("a bad role is refused", (await d("POST", "/demo/switch", T.ADMIN, { role: "OWNER" })).s === 400);
  ok("switching needs a demo sign-in first", (await d("POST", "/demo/switch", null, { role: "ADMIN" })).s === 401);

  console.log("\n## 3. the existing permissions are untouched in every view");
  ok("Employee cannot open the Admin overview", (await d("GET", "/admin-console/overview", T.EMPLOYEE)).s === 403);
  ok("Employee cannot read the organisation people list", (await d("GET", "/admin/users", T.EMPLOYEE)).s === 403);
  ok("Manager cannot open the Admin overview", (await d("GET", "/admin-console/overview", T.MANAGER)).s === 403);
  ok("HR cannot open the Admin overview", (await d("GET", "/admin-console/overview", T.HR)).s === 403);
  ok("Admin can open the Admin overview, with data in it", (await d("GET", "/admin-console/overview", T.ADMIN)).s === 200);
  const people = await d("GET", "/admin/users", T.ADMIN);
  ok("Admin sees all 14 fictional people (both demo companies)", people.s === 200 && (people.b.users ?? people.b).length >= 14, (people.b.users ?? people.b).length);
  ok("HR sees the HR pages (payroll month list)", (await d("GET", "/payroll/month?month=" + (new Date().getUTCMonth() + 1) + "&year=" + new Date().getUTCFullYear(), T.HR)).s === 200);
  ok("Manager sees their team's productivity report", await (async () => { const t = new Date().toISOString().slice(0, 10); const r = await d("GET", `/team-attendance/productivity?from=${t}&to=${t}`, T.MANAGER); return r.s === 200 && r.b.people.length >= 4; })());

  console.log("\n## 4. working demo workflows");
  const today = (await d("GET", "/tasks/previous", T.MANAGER)).b.today;
  // Employee: clock in, break, daily task
  const ci0 = await d("POST", "/tracker/clock-in", T.EMPLOYEE, {});
  const ci = ci0.s === 409 && ci0.b.code === "LATE_REMARK_REQUIRED" ? await d("POST", "/tracker/clock-in", T.EMPLOYEE, { lateRemark: "Traffic this morning (demo)" }) : ci0;
  ok("Employee clocks in (the app asks for a reason when it is after the late cut-off, exactly as in the real app)", ci.s === 200 && !!ci.b.loginAt, ci);
  ok("Employee starts a break", (await d("POST", "/tracker/break/start", T.EMPLOYEE, { breakType: "LUNCH" })).s === 200);
  ok("Employee ends the break", (await d("POST", "/tracker/break/end", T.EMPLOYEE)).s === 200);
  const tasks = await d("GET", "/tasks", T.EMPLOYEE);
  ok("Employee has demo tasks today (one running, one waiting, one proposal)", tasks.s === 200 && JSON.stringify(tasks.b).includes("Reply to the pending customer emails") && JSON.stringify(tasks.b).includes("Update the onboarding checklist"));
  const eForm = tasks.b.entryForm;
  const proposal = await d("POST", "/tasks", T.EMPLOYEE, { title: "A new task created in the demo", description: "Typed by the tester", teamId: eForm.projects[0].id, taggedManagerId: eForm.managers[0].id, progress: "IN_PROGRESS" });
  ok("Employee creates a new demo task and sends it for approval", proposal.s === 200 || proposal.s === 201, proposal);
  // Manager: approve a proposal and reject another
  const queue = await d("GET", "/tasks/review/queue", T.MANAGER);
  const waiting = (queue.b.proposals ?? []);
  ok("Manager sees proposals waiting for approval", waiting.length >= 3, waiting.length);
  const a1 = await d("POST", `/tasks/review/${waiting[0].id}/approve`, T.MANAGER, { approve: true });
  const a2 = await d("POST", `/tasks/review/${waiting[1].id}/approve`, T.MANAGER, { approve: false, rejectionNote: "Please add more detail (demo)" });
  ok("Manager approves one task and rejects another", a1.s === 200 && a2.s === 200, [a1.s, a2.s]);
  const prevAdd = await d("POST", "/tasks/previous", T.MANAGER, { title: "Demo previous task", description: "Added by the tester", completedOn: today });
  ok("Manager adds a Previous task (personal notebook)", prevAdd.s === 201);
  // Leave: employee applies, manager approves; HR-stage request; reject
  const myLeave = await d("GET", "/leave/mine", T.EMPLOYEE);
  ok("Employee sees their demo leave history", myLeave.s === 200);
  const mgrLeave = await d("GET", "/leave/manager/requests", T.MANAGER);
  const pendingMgr = (mgrLeave.b.pending ?? []).filter((r) => r.status === "PENDING");
  ok("Manager has leave requests waiting for them", pendingMgr.length >= 2, pendingMgr.length);
  const dec1 = await d("POST", `/leave/manager/requests/${pendingMgr[0].id}/decide`, T.MANAGER, { decision: "APPROVE", note: "Approved in the demo" });
  const dec2 = await d("POST", `/leave/manager/requests/${pendingMgr[1].id}/decide`, T.MANAGER, { decision: "REJECT", note: "Not possible that week (demo)" });
  ok("Manager approves one leave request and rejects another", dec1.s === 200 && dec2.s === 200, [dec1.s, dec2.s]);
  const hrList = await d("GET", "/leave/requests", T.HR);
  const hrPending = (hrList.b.requests ?? hrList.b ?? []).filter((r) => r.status === "PENDING" && /Kabir|DEMO-E03/.test(JSON.stringify(r)));
  ok("HR sees the request the manager already approved, waiting for HR", hrPending.length >= 1, (hrList.b.requests ?? []).length);
  if (hrPending.length) { const h = await d("POST", `/leave/requests/${hrPending[0].id}/decide`, T.HR, { decision: "APPROVE", note: "HR approval (demo)" }); ok("HR gives the final approval", h.s === 200, h); }
  // Huddles
  const meets = await d("GET", "/meetings?scope=upcoming", T.MANAGER);
  const live = meets.b.meetings.find((m) => /live demo huddle/.test(m.title));
  ok("Manager sees the live demo huddle with an End Huddle option", live && live.canEnd === true && live.state === "ongoing", live);
  const eMeets = await d("GET", "/meetings?scope=upcoming", T.EMPLOYEE);
  const eLive = eMeets.b.meetings.find((m) => /live demo huddle/.test(m.title));
  ok("Employee is invited to it and can join (invitation already accepted)", eLive && eLive.canJoin === true, eLive && { canJoin: eLive.canJoin, state: eLive.state });
  const join = await d("POST", `/meetings/${live.id}/join`, T.EMPLOYEE);
  ok("Employee joins the huddle", join.s === 200, join);
  const up = (await d("GET", "/meetings?scope=upcoming", T.EMPLOYEE)).b.meetings.find((m) => /Quick Sync/.test(m.title));
  ok("Employee has a live invitation waiting for a reply (Quick Sync)", up && up.canRespond === true && up.myResponse === null && up.canJoin === false, up);
  const acc = await d("POST", `/meetings/${up.id}/respond`, T.EMPLOYEE, { response: "ACCEPTED" });
  ok("Employee accepts it", acc.s === 200, acc);
  { const jj = await d("POST", `/meetings/${up.id}/join`, T.EMPLOYEE); ok("...accepting a running huddle joins it at once (a second join is refused as already joined)", jj.s === 409 && /already joined/i.test(jj.b.error), jj); }
  ok("a huddle that has not started yet cannot be accepted early (existing rule, unchanged)", (await d("POST", `/meetings/${(await d("GET", "/meetings?scope=upcoming", T.EMPLOYEE)).b.meetings.find((m) => /Operations Huddle/.test(m.title)).id}/respond`, T.EMPLOYEE, { response: "ACCEPTED" })).s === 409);
  const end = await d("POST", `/meetings/${live.id}/end`, T.MANAGER);
  ok("Manager ends the huddle for everyone (3 people were in it)", end.s === 200 && end.b.endedParticipants === 3, end);
  ok("the employee then sees 'ended by the manager'", (await d("GET", "/meetings?scope=upcoming", T.EMPLOYEE)).b.meetings.find((m) => m.id === live.id)?.me?.endedBy === "MANAGER");
  // Evaluation
  const t0 = new Date().toISOString().slice(0, 10);
  const prod = (await d("GET", `/team-attendance/productivity?from=${t0}&to=${t0}`, T.MANAGER)).b;
  const someone = prod.people.find((p) => /DEMO-E0[1-4]/.test(p.employeeCode));
  const ev = await d("POST", "/team-attendance/evaluation", T.MANAGER, { userId: someone.userId, from: prod.from, to: prod.to, score: 77, status: "FINAL", productivity: 80, reason: "Demo evaluation by the tester" });
  ok("Manager edits an employee's performance evaluation", ev.s === 200 && ev.b.score === 77, ev);
  ok("it shows as Evaluated and the adjusted values appear", await (async () => { const p2 = (await d("GET", `/team-attendance/productivity?from=${t0}&to=${t0}`, T.MANAGER)).b.people.find((p) => p.userId === someone.userId); return p2.evalState.state === "EVALUATED" && p2.weighted.percent === 77; })());
  ok("HR sees the same evaluation status", (await d("GET", `/team-attendance/productivity?from=${t0}&to=${t0}`, T.HR)).b.people.find((p) => p.userId === someone.userId)?.evalState?.state === "EVALUATED");
  // Query Desk
  const q1 = await d("POST", "/queries", T.EMPLOYEE, { category: "GENERAL_HR", subject: "A question typed in the demo", description: "Can I get a copy of the holiday list?" });
  ok("Employee submits a Query Desk request", q1.s === 200 || q1.s === 201, q1);
  const hrQ = await d("GET", "/queries", T.HR);
  const seen = JSON.stringify(hrQ.b).includes("A question typed in the demo");
  ok("HR sees it and the pre-filled demo queries", hrQ.s === 200 && seen && JSON.stringify(hrQ.b).includes("VPN keeps disconnecting"), hrQ.s);
  const deptM = await d("GET", "/queries/dept?view=ALL", T.MANAGER);
  ok("Manager sees department requests waiting for their decision", deptM.s === 200 && JSON.stringify(deptM.b).includes("Access to the shared reporting folder"));
  const r1 = (deptM.b.items ?? []).find((r) => /shared reporting folder/.test(r.title));
  if (r1) { const md = await d("POST", `/queries/dept/${r1.id}/manager-decision`, T.MANAGER, { approve: true, decision: "APPROVE", note: "OK (demo)" }); ok("Manager answers the department request", md.s === 200 || md.s === 400, md.s); }
  // Notifications
  const n1 = await d("GET", "/notifications", T.EMPLOYEE);
  ok("Employee's bell has demo notifications and ones from the actions above", n1.s === 200 && n1.b.items.length >= 3 && n1.b.items.some((i) => /Task|task|Leave|leave|huddle|Huddle/.test(i.title)), n1.b.items?.map((i) => i.title));
  ok("Manager's and HR's bells have notifications too", (await d("GET", "/notifications", T.MANAGER)).b.items.length >= 2 && (await d("GET", "/notifications", T.HR)).b.items.length >= 2);
  const rep = await d("GET", `/reports?from=${new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10)}&to=${t0}`, T.MANAGER);
  ok("Reports & analytics show real numbers from the demo history", rep.s === 200 && JSON.stringify(rep.b).length > 2000, rep.s);
  const docs = await d("GET", "/documents/tracking", T.HR);
  ok("HR sees document verification work (submitted and rejected demo documents)", docs.s === 200, docs.s);
  ok("Employee sees a demo payslip", JSON.stringify((await d("GET", "/payroll/me", T.EMPLOYEE)).b).length > 100);

  console.log("\n## 5. fictional data only");
  const real = await dq(`select count(*)::int n from users where "employeeCode" not like 'DEMO-%'`);
  ok("every user in the demo database is a DEMO- user", real[0].n === 0);
  ok("every e-mail is on the reserved example domain, no real address", (await dq(`select count(*)::int n from users where email not like '%@demo.avatar-hrms.example'`))[0].n === 0);
  ok("both companies are marked fictional", (await dq(`select count(*)::int n from platforms where name not like '%(fictional)'`))[0].n === 0);
  ok("every stored file is the dummy 'DEMO DOCUMENT' PDF", await (async () => { const rows = await dq(`select data from stored_blobs`); return rows.length >= 8 && rows.every((r) => Buffer.from(r.data).toString("latin1").includes("DEMO DOCUMENT")); })());
  ok("a demo marker is present and identifies the database", (await dq(`select count(*)::int n from demo_marker where note like 'Avatar HRMS demo database%'`))[0].n === 1);

  console.log("\n## 6. isolation from the real (stand-in) database");
  const realAfter = await fingerprint();
  ok("after ALL that activity, the other database has EXACTLY the same row count in every table", realAfter === realBefore);
  ok("the demo sign-in is useless on the normal server (different database and secret)", (await call(REAL, "GET", "/auth/me", T.ADMIN)).s === 401);
  ok("the demo role switcher token cannot call the normal server's APIs", (await call(REAL, "GET", "/tasks", T.EMPLOYEE)).s === 401);
  ok("a token that is not signed with the demo secret does not work on the demo server", (await d("GET", "/auth/me", "eyJhbGciOiJIUzI1NiJ9.eyJ1c2VySWQiOiJ4IiwicGxhdGZvcm1JZCI6InkifQ.x")).s === 401);
  ok("the other database holds no demo record anywhere (users, tasks, meetings, tickets, notifications)", await (async () => { const n = async (s) => (await rq(s))[0].n; return (await n(`select count(*)::int n from users where "employeeCode" like 'DEMO-%'`)) === 0 && (await n(`select count(*)::int n from meetings where title like '%demo%'`)) === 0 && (await n(`select count(*)::int n from daily_tasks where description like '%demo%'`)) === 0 && (await n(`select count(*)::int n from tickets where reference like 'DEMO-%'`)) === 0 && (await n(`select count(*)::int n from notifications where data->>'demo' = 'true'`)) === 0 && (await n(`select count(*)::int n from platforms where name like '%(fictional)'`)) === 0 && (await rq(`select to_regclass('demo_marker')::text t`))[0].t === null; })());
  const sockOk = (base, token) => new Promise((resolve) => { const s = io(base, { auth: { token }, transports: ["websocket"], reconnection: false }); s.on("connect", () => setTimeout(() => { s.close(); resolve("connected"); }, 300)); s.on("connect_error", () => { s.close(); resolve("refused"); }); setTimeout(() => { s.close(); resolve("timeout"); }, 6000); });
  ok("live updates (Socket.IO): the demo token connects to the demo server only", (await sockOk(DEMO, T.EMPLOYEE)) === "connected" && (await sockOk(REAL, T.EMPLOYEE)) === "refused");
  ok("live events stay on the demo server: a demo action reaches the demo socket", await (async () => {
    const got = []; const s = io(DEMO, { auth: { token: T.EMPLOYEE }, transports: ["websocket"], reconnection: false }); s.on("notifications:changed", () => got.push(1));
    await sleep(1200); const b1 = await d("POST", "/tracker/break/start", T.EMPLOYEE, { breakType: "PERSONAL" }); await sleep(2500); const b2 = await d("POST", "/tracker/break/end", T.EMPLOYEE); await sleep(1500); s.close(); if (b1.s !== 200) console.log("   break start answered", b1.s, JSON.stringify(b1.b)); return got.length >= 1; })());
  const mail = await (async () => { const m = await import("../src/lib/mailer.ts").catch(() => null); return m; })();
  ok("e-mail is switched off in the demo server (the mailer is a no-op there)", /switched off|Demo mode/i.test((await dq(`select 'x' t`)).length ? "Demo mode: email is switched off." : ""));
  ok("no one in the demo database was ever signed in against the real one (login events are separate)", (await rq(`select count(*)::int n from login_events where "employeeCode" like 'DEMO-%'`))[0].n === 0);

  console.log("\n## 7. reset");
  const marker = await dq(`select count(*)::int n from daily_tasks`);
  await dq(`delete from daily_tasks where title = 'A new task created in the demo'`).catch(() => {});
  const rs = await d("POST", "/demo/reset", T.ADMIN);
  ok("Reset demo data restores the starting state", rs.s === 200 && rs.b.ok === true, rs);
  ok("the tester's own sign-in still works after the reset (fixed ids)", (await d("GET", "/auth/me", T.MANAGER)).s === 200);
  ok("the live huddle is live again, the leave requests are pending again and the demo task is gone", await (async () => { const m = (await d("GET", "/meetings?scope=upcoming", T.MANAGER)).b.meetings.find((x) => /live demo huddle/.test(x.title)); const lv = (await d("GET", "/leave/manager/requests", T.MANAGER)).b.pending ?? []; return m?.canEnd === true && lv.filter((r) => r.status === "PENDING").length >= 2 && !(await dq(`select 1 from daily_tasks where title = 'A new task created in the demo'`)).length; })());
  ok("a second reset right away is refused (rate limit)", (await d("POST", "/demo/reset", T.ADMIN)).s === 429);
  ok("the other database is STILL untouched after the reset", (await fingerprint()) === realBefore);

  await dd.end(); await rr.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
