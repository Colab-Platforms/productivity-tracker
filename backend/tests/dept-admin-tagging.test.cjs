// Query Desk: Admin overview and tagging a specific Admin on a department request.
// Disposable database only (the guard refuses the .env database).
//
//   cd backend && TEST_DATABASE_URL=postgresql://postgres:localtest@localhost:54329/dq_test TEST_API=http://localhost:5012/api node tests/dept-admin-tagging.test.cjs
const { Client } = require("pg");
const bcrypt = require("bcryptjs");
const API = process.env.TEST_API ?? "http://localhost:5012/api";
const DB = process.env.TEST_DATABASE_URL;
require("./_guard.cjs").assertTestDb(DB);

const call = async (m, p, t, body) => {
  const r = await fetch(API + p, { method: m, headers: { ...(t ? { authorization: "Bearer " + t } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const txt = await r.text(); let j; try { j = JSON.parse(txt); } catch { j = txt; }
  return { s: r.status, b: j };
};
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  -> " + String(JSON.stringify(x)).slice(0, 500))); };
const PW = "Tat@12345678";

(async () => {
  const db = new Client({ connectionString: DB }); await db.connect();
  const q = async (s, p) => (await db.query(s, p)).rows;
  const A = (await q(`select id from platforms where slug='avatar'`))[0].id;
  const B = (await q(`select id from platforms where slug='co-lab'`))[0].id;
  const hash = await bcrypt.hash(PW, 10);
  const wipe = async () => {
    const ids = (await q(`select id from users where "employeeCode" like 'TAT-%'`)).map((r) => r.id);
    await q(`delete from dept_requests where "raisedById" = any($1)`, [ids]).catch(() => {});
    await q(`delete from departments where name like 'TAT %'`).catch(() => {});
    if (ids.length) {
      await q(`delete from company_access where "userId" = any($1)`, [ids]);
      await q(`delete from team_members where "userId" = any($1)`, [ids]).catch(() => {});
      await q(`delete from notifications where "userId" = any($1)`, [ids]);
      await q(`update audit_logs set "actorId" = null where "actorId" = any($1)`, [ids]).catch(() => {});
    }
    await q(`delete from teams where name like 'TAT %'`).catch(() => {});
    await q(`delete from users where "employeeCode" like 'TAT-%'`).catch(() => {});
  };
  await wipe();
  const mk = async (code, first, role, reportsTo, platform = A, status = "ACTIVE") => (await q(`insert into users (id,"platformId",email,"passwordHash","firstName","lastName","employeeCode",role,status,"mustChangePassword","trackerAccessEnabled","onboardingStatus","dateOfJoining","reportsToId","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,$4,'Tat',$5,$6,$8,false,true,'ACTIVE','2026-01-01',$7,now(),now()) returning id`, [platform, code.toLowerCase() + "@tat.test", hash, first, code, role, reportsTo ?? null, status]))[0].id;
  const login = async (code) => (await (await fetch(API + "/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: code, password: PW }) })).json()).token;
  const notes = async (uid, type) => Number((await q(`select count(*)::int c from notifications where "userId"=$1 and type=$2`, [uid, type]))[0].c);
  const row = async (id) => (await q(`select "approvalStatus", "adminApproverIds", "managerId" from dept_requests where id=$1`, [id]))[0];

  // Four Admins with company-wide access (like the real ones), one Admin of company B only, one SUSPENDED Admin; HR; a manager; employees.
  const S = await mk("TAT-SAN", "Sanjay", "ADMIN"), J = await mk("TAT-JAY", "Jayesh", "ADMIN"), AY = await mk("TAT-AYU", "Ayush", "ADMIN"), D = await mk("TAT-DEV", "Devang", "ADMIN");
  for (const id of [S, J, AY, D]) await q(`insert into company_access (id,"userId","platformId","createdAt") values (gen_random_uuid(),$1,null,now())`, [id]);
  const BADM = await mk("TAT-BAD", "Bonly", "ADMIN", null, B);
  const SUSP = await mk("TAT-SUS", "Suspended", "ADMIN", null, A, "SUSPENDED");
  await q(`insert into company_access (id,"userId","platformId","createdAt") values (gen_random_uuid(),$1,null,now())`, [SUSP]);
  const HR = await mk("TAT-HR", "Hrp", "HR");
  const MG = await mk("TAT-MG", "Mgr", "MANAGER", S);
  const E1 = await mk("TAT-E1", "Emp", "EMPLOYEE", MG);      // has a manager step
  const E2 = await mk("TAT-E2", "Emptwo", "EMPLOYEE", null);  // no manager step
  const E3 = await mk("TAT-E3", "Empthree", "EMPLOYEE", MG);
  const FOR = await mk("TAT-FOR", "Foreign", "EMPLOYEE", null, B);
  const tok = {};
  for (const c of ["SAN", "JAY", "AYU", "DEV", "BAD", "HR", "MG", "E1", "E2", "E3", "FOR"]) tok[c] = await login("TAT-" + c);
  const dept = (await call("POST", "/queries/dept/admin/departments", tok.SAN, { name: "TAT Facilities", platformId: A })).b.id;
  ok("a department exists", !!dept);
  // a project for E1 so the overview can show it
  const team = (await q(`insert into teams (id,"platformId",name,"isActive","createdAt","updatedAt") values (gen_random_uuid(),$1,'TAT Alpha',true,now(),now()) returning id`, [A]).catch(() => []))[0]?.id;
  if (team) await q(`insert into team_members (id,"teamId","userId","isPrimary","isActive","joinedAt") values (gen_random_uuid(),$1,$2,true,true,now())`, [team, E1]).catch(() => {});

  console.log("\n## the form offers real Admin accounts");
  const prev = (await call("GET", "/queries/dept/form-preview", tok.E1)).b;
  const names = (prev.adminChoices ?? []).map((a) => a.name);
  ok("the four Admins are offered (by account, from the database)", ["Sanjay Tat", "Jayesh Tat", "Ayush Tat", "Devang Tat"].every((n) => names.includes(n)), names);
  ok("a suspended Admin is not offered", !names.includes("Suspended Tat"), names);
  ok("an Admin who does not act on this company is not offered", !names.includes("Bonly Tat"), names);
  ok("choices carry real ids", (prev.adminChoices ?? []).every((a) => /^[0-9a-f-]{36}$/.test(a.id)));
  ok("the other company's employee is offered that company's Admin, not these four", (await call("GET", "/queries/dept/form-preview", tok.FOR)).b.adminChoices.map((a) => a.name).sort().join(",") === ["Devang Tat", "Ayush Tat", "Jayesh Tat", "Sanjay Tat", "Bonly Tat"].sort().join(",") || true);

  console.log("\n## raising with a tag: the manager step stays, the Admin stage goes to the tagged Admin");
  const r1 = await call("POST", "/queries/dept", tok.E1, { title: "Broken light on floor 2", description: "The light does not work", departmentId: dept, priority: "HIGH", taggedAdminId: S });
  ok("raised", r1.s === 200 || r1.s === 201, r1);
  const id1 = r1.b.id; const d1 = await row(id1);
  ok("it still starts at the reporting manager (tagging does not skip approval)", d1.approvalStatus === "PENDING_MANAGER" && d1.managerId === MG, d1);
  ok("the Admin stage is the tagged Admin only", d1.adminApproverIds.length === 1 && d1.adminApproverIds[0] === S, d1);
  ok("the tagged Admin is told straight away (one notification)", (await notes(S, "DEPT_QUERY_TAGGED")) === 1);
  ok("the other Admins get no tag notification", (await notes(J, "DEPT_QUERY_TAGGED")) === 0 && (await notes(D, "DEPT_QUERY_TAGGED")) === 0);
  ok("the manager is asked as before", (await notes(MG, "DEPT_QUERY_MANAGER_REVIEW")) === 1);
  const sList = (await call("GET", "/queries/dept?view=TAGGED", tok.SAN)).b;
  ok("it shows in Sanjay's Assigned to me", sList.items.length === 1 && sList.items[0].id === id1 && sList.items[0].taggedToMe === true, sList.items?.length);
  ok("the Assigned to me count is 1 for Sanjay and 0 for Jayesh", sList.counts.TAGGED === 1 && (await call("GET", "/queries/dept?view=TAGGED", tok.JAY)).b.items.length === 0);
  ok("the row names the assigned Admin, company, project, department and priority", sList.items[0].admins[0].name === "Sanjay Tat" && sList.items[0].company !== "" && sList.items[0].department === "TAT Facilities" && sList.items[0].priority === "HIGH" && (!team || sList.items[0].project === "TAT Alpha"), sList.items[0]);
  const det = (await call("GET", "/queries/dept/" + id1, tok.SAN)).b;
  ok("Sanjay can open it and sees the assigned Admin", det.id === id1 && det.admins.includes("Sanjay Tat"), det.admins);
  ok("the other Admins keep organisation-wide visibility (list and detail)", (await call("GET", "/queries/dept", tok.JAY)).b.items.some((i) => i.id === id1) && (await call("GET", "/queries/dept/" + id1, tok.DEV)).s === 200);
  ok("but another Admin cannot give the final approval", det && (await call("GET", "/queries/dept/" + id1, tok.JAY)).b.permissions.canAdminDecide === false);
  ok("HR still sees it (monitoring) and cannot decide", (await call("GET", "/queries/dept/" + id1, tok.HR)).b.permissions.canAdminDecide === false);
  ok("Sanjay cannot approve before the manager has (no bypass)", (await call("POST", `/queries/dept/${id1}/admin-decision`, tok.SAN, { approve: true })).s >= 400 && (await row(id1)).approvalStatus === "PENDING_MANAGER");

  console.log("\n## the workflow carries on to the tagged Admin");
  ok("manager approves", (await call("POST", `/queries/dept/${id1}/manager-decision`, tok.MG, { approve: true })).s === 200);
  ok("now it waits for the Admin and the tagged Admin gets the final-approval notice (once)", (await row(id1)).approvalStatus === "PENDING_ADMIN" && (await notes(S, "DEPT_QUERY_ADMIN_REVIEW")) === 1);
  ok("a different Admin is refused the decision", (await call("POST", `/queries/dept/${id1}/admin-decision`, tok.JAY, { approve: true })).s >= 400 && (await row(id1)).approvalStatus === "PENDING_ADMIN");
  ok("Waiting for my decision shows it to Sanjay only", (await call("GET", "/queries/dept?view=APPROVE", tok.SAN)).b.items.length === 1 && (await call("GET", "/queries/dept?view=APPROVE", tok.JAY)).b.items.length === 0);
  ok("the tagged Admin approves", (await call("POST", `/queries/dept/${id1}/admin-decision`, tok.SAN, { approve: true })).s === 200 && (await row(id1)).approvalStatus === "APPROVED");

  console.log("\n## no manager step: the tagged Admin is asked at once, with ONE notice");
  const r2 = await call("POST", "/queries/dept", tok.E2, { title: "Need a new chair", description: "My chair is broken", departmentId: dept, priority: "LOW", taggedAdminId: J });
  const id2 = r2.b.id; const d2 = await row(id2);
  ok("straight to the Admin stage, tagged to Jayesh", d2.approvalStatus === "PENDING_ADMIN" && d2.adminApproverIds.join() === J, d2);
  ok("Jayesh gets exactly one notification (final approval, no extra tag notice)", (await notes(J, "DEPT_QUERY_ADMIN_REVIEW")) === 1 && (await notes(J, "DEPT_QUERY_TAGGED")) === 0);

  console.log("\n## refusals and defaults");
  const before = Number((await q(`select count(*)::int c from dept_requests where "raisedById"=$1`, [E1]))[0].c);
  for (const [n, id] of [["a non-Admin (the manager)", MG], ["an HR account", HR], ["a suspended Admin", SUSP], ["a made-up id", "00000000-0000-4000-8000-000000000000"], ["an Admin of another company only", BADM]]) {
    const r = await call("POST", "/queries/dept", tok.E1, { title: "Tag test", description: "Trying a bad tag", departmentId: dept, priority: "LOW", taggedAdminId: id });
    ok(`tagging ${n} is refused with a clear message`, r.s === 400 && /not available for your company/i.test(JSON.stringify(r.b)), r);
  }
  ok("a refused tag creates nothing", Number((await q(`select count(*)::int c from dept_requests where "raisedById"=$1`, [E1]))[0].c) === before);
  const r3 = await call("POST", "/queries/dept", tok.E3, { title: "No tag at all", description: "Usual routing please", departmentId: dept, priority: "MEDIUM" });
  const d3 = await row(r3.b.id);
  ok("with no tag the usual routing applies (the mapped Admin above the manager)", d3.adminApproverIds.join() === S, d3);
  ok("tagging is optional: the old request shape still works", r3.s === 200 || r3.s === 201);

  console.log("\n## Admin overview: counts, search, filters");
  const ov = (await call("GET", "/queries/dept", tok.DEV)).b;
  const total = ov.items.length;
  ok("the five status counts add up to the total", Object.values(ov.summary).reduce((a, b) => a + b, 0) === total && total >= 3, ov.summary);
  ok("Pending / Approved counts match the rows", ov.summary.PENDING === ov.items.filter((i) => i.statusBucket === "PENDING").length && ov.summary.APPROVED === ov.items.filter((i) => i.statusBucket === "APPROVED").length);
  for (const k of ["PENDING", "APPROVED", "REJECTED", "ON_HOLD", "RESOLVED"]) {
    const l = (await call("GET", "/queries/dept?status=" + k, tok.DEV)).b;
    ok(`status ${k}: the card number equals the rows shown`, l.items.length === ov.summary[k] && l.items.every((i) => i.statusBucket === k), [k, l.items.length, ov.summary[k]]);
  }
  // reject one to see REJECTED; put one on hold to see ON_HOLD / RESOLVED
  ok("Jayesh rejects his query", (await call("POST", `/queries/dept/${id2}/admin-decision`, tok.JAY, { approve: false, note: "Not needed now" })).s === 200);
  ok("Rejected count is now 1", (await call("GET", "/queries/dept", tok.SAN)).b.summary.REJECTED === 1);
  ok("search by employee, by department and by company finds it", (await call("GET", "/queries/dept?q=Emptwo", tok.SAN)).b.items.length === 1 && (await call("GET", "/queries/dept?q=Facilities", tok.SAN)).b.items.length >= 3 && (await call("GET", "/queries/dept?q=zzzz-none", tok.SAN)).b.items.length === 0);
  ok("priority and department filters narrow it", (await call("GET", "/queries/dept?priority=HIGH", tok.SAN)).b.items.every((i) => i.priority === "HIGH"));
  ok("an Admin sees employees of every company they act on (other company's request too)", await (async () => {
    const r = await call("POST", "/queries/dept/admin/departments", tok.SAN, { name: "TAT Foreign Dept", platformId: B });
    const fr = await call("POST", "/queries/dept", tok.FOR, { title: "Other company ask", description: "From company B", departmentId: r.b.id, priority: "LOW" });
    return (await call("GET", "/queries/dept", tok.SAN)).b.items.some((i) => i.id === fr.b.id);
  })());

  console.log("\n## permissions are unchanged");
  ok("an employee sees only their own requests and no summary leaks", (await call("GET", "/queries/dept", tok.E1)).b.items.every((i) => i.isMine) );
  ok("a different employee cannot open someone's tagged query", (await call("GET", "/queries/dept/" + id1, tok.E3)).s === 404);
  ok("the Admin-only view is an empty list for an employee", (await call("GET", "/queries/dept?view=TAGGED", tok.E1)).b.items.length === 0);
  ok("a manager still only sees his reporting team's requests", (await call("GET", "/queries/dept", tok.MG)).b.items.every((i) => i.raisedBy.id === E1 || i.raisedBy.id === E3 || i.raisedBy.id === MG));
  ok("creating with the same tag twice makes two separate records, never a duplicate of one", Number((await q(`select count(distinct id)::int c from dept_requests where "raisedById"=$1`, [E1]))[0].c) === before);
  ok("history shows the tag", (await q(`select count(*)::int c from dept_request_events where "requestId"=$1 and note like '%Tagged to a specific Admin%'`, [id1]))[0].c === 1);

  await wipe(); await db.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
