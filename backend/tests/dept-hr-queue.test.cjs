// HR (company-wide access, not a member of another company's HR Department) and the approved HR Department request. Disposable DB only.
//   cd backend && TEST_DATABASE_URL=postgresql://postgres:localtest@localhost:54329/dq_test TEST_API=http://localhost:5012/api node tests/dept-hr-queue.test.cjs
const { Client } = require("pg"); const bcrypt = require("bcryptjs");
const API = process.env.TEST_API ?? "http://localhost:5012/api"; const DB = process.env.TEST_DATABASE_URL; require("./_guard.cjs").assertTestDb(DB);
const call = async (m, p, t, body) => { const r = await fetch(API + p, { method: m, headers: { ...(t ? { authorization: "Bearer " + t } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined }); const txt = await r.text(); let j; try { j = JSON.parse(txt); } catch { j = txt; } return { s: r.status, b: j }; };
let pass = 0, fail = 0; const ok = (n, c, x) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  -> " + String(JSON.stringify(x)).slice(0, 400))); };
const PW = "Thq@12345678";
(async () => {
  const db = new Client({ connectionString: DB }); await db.connect(); const q = async (s, p) => (await db.query(s, p)).rows;
  const A = (await q(`select id from platforms where slug='avatar'`))[0].id, B = (await q(`select id from platforms where slug='co-lab'`))[0].id; const hash = await bcrypt.hash(PW, 10);
  const wipe = async () => { const ids = (await q(`select id from users where "employeeCode" like 'THQ-%'`)).map((r) => r.id); await q(`delete from dept_requests where "raisedById" = any($1)`, [ids]).catch(() => {}); await q(`delete from departments where name like 'THQ %'`).catch(() => {}); if (ids.length) { await q(`delete from company_access where "userId" = any($1)`, [ids]); await q(`delete from notifications where "userId" = any($1)`, [ids]); await q(`update audit_logs set "actorId"=null where "actorId" = any($1)`, [ids]).catch(() => {}); } await q(`delete from users where "employeeCode" like 'THQ-%'`).catch(() => {}); };
  await wipe();
  const mk = async (code, first, role, rt, platform = A) => (await q(`insert into users (id,"platformId",email,"passwordHash","firstName","lastName","employeeCode",role,status,"mustChangePassword","trackerAccessEnabled","onboardingStatus","dateOfJoining","reportsToId","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,$4,'Thq',$5,$6,'ACTIVE',false,true,'ACTIVE','2026-01-01',$7,now(),now()) returning id`, [platform, code.toLowerCase() + "@thq.test", hash, first, code, role, rt ?? null]))[0].id;
  const login = async (c) => (await (await fetch(API + "/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: c, password: PW }) })).json()).token;
  const AD = await mk("THQ-AD", "Admin", "ADMIN"); await q(`insert into company_access (id,"userId","platformId","createdAt") values (gen_random_uuid(),$1,null,now())`, [AD]);
  const MG = await mk("THQ-MG", "Ankit", "MANAGER", AD);                          // raises, company A (like Avatar India)
  const HRX = await mk("THQ-HRX", "Sonali", "HR", null, B);                        // HR of company B ...
  await q(`insert into company_access (id,"userId","platformId","createdAt") values (gen_random_uuid(),$1,null,now())`, [HRX]); // ... with all-company access
  const HRN = await mk("THQ-HRN", "Nogrant", "HR", null, B);                       // HR of company B with NO grant
  const EMP = await mk("THQ-EMP", "Plain", "EMPLOYEE", MG, B);
  const tok = {}; for (const c of ["AD", "MG", "HRX", "HRN", "EMP"]) tok[c] = await login("THQ-" + c);
  const hrDept = (await call("POST", "/queries/dept/admin/departments", tok.AD, { name: "THQ HR Department", platformId: A })).b.id;
  const itDept = (await call("POST", "/queries/dept/admin/departments", tok.AD, { name: "THQ IT Department", platformId: A })).b.id;
  // the exact case: a manager raises a request for the HR Department, the Admin approves it
  const id = (await call("POST", "/queries/dept", tok.MG, { title: "Need to purchase domains", description: "Domains for CRM and HRMS", departmentId: hrDept, priority: "HIGH" })).b.id;
  const idIt = (await call("POST", "/queries/dept", tok.MG, { title: "pc clean", description: "Clean the pcs please", departmentId: itDept, priority: "LOW" })).b.id;
  for (const r of [id, idIt]) ok("admin approves " + r.slice(0, 4), (await call("POST", `/queries/dept/${r}/admin-decision`, tok.AD, { approve: true })).s === 200);
  const st = (await q(`select "approvalStatus" a,"workStatus" w,"departmentId" d from dept_requests where id=$1`, [id]))[0];
  ok("saved as Approved / Awaiting department action with the HR Department id", st.a === "APPROVED" && st.w === "AWAITING_ACTION" && st.d === hrDept, st);

  console.log("\n## HR with company-wide access, not yet a member");
  const all = (await call("GET", "/queries/dept", tok.HRX)).b;
  ok("Department requests > All shows the approved HR request (title, reference, priority, employee, date, status)", all.items.some((i) => i.id === id && i.title && i.reference && i.priority === "HIGH" && i.raisedBy.name === "Ankit Thq" && i.createdAt && i.approvalLabel === "Approved" && i.workLabel === "Awaiting Department Action"), all.items);
  ok("filtering by the HR Department finds it", (await call("GET", "/queries/dept?departmentId=" + hrDept, tok.HRX)).b.items.map((i) => i.id).join() === id);
  ok("Raised by me stays separate: it is empty for her and does not shrink All", (await call("GET", "/queries/dept?view=MINE", tok.HRX)).b.items.length === 0 && all.items.length >= 2);
  ok("she can open it", (await call("GET", "/queries/dept/" + id, tok.HRX)).s === 200);
  ok("without membership she cannot accept it yet", (await call("POST", `/queries/dept/${id}/accept`, tok.HRX)).s >= 400);
  ok("HR with NO grant of that company cannot see it", (await call("GET", "/queries/dept/" + id, tok.HRN)).s === 404 && (await call("GET", "/queries/dept", tok.HRN)).b.items.length === 0);
  ok("a plain employee of another company cannot see it", (await call("GET", "/queries/dept/" + id, tok.EMP)).s === 404);

  console.log("\n## membership across companies (Admin decides who works for a department)");
  const mgr = (await call("GET", "/queries/dept/admin/departments", tok.AD)).b;
  const dd = mgr.departments.find((d) => d.id === hrDept);
  ok("the member picker offers HR/Admin from other companies who have access", dd.outsiders.some((o) => o.id === HRX) && !dd.outsiders.some((o) => o.id === HRN), dd.outsiders);
  ok("HR without a grant (company B only) is NOT eligible", (await call("POST", "/queries/dept/admin/departments/" + hrDept, tok.AD, { memberIds: [HRN] })).s === 400);
  ok("an employee of another company is NOT eligible", (await call("POST", "/queries/dept/admin/departments/" + hrDept, tok.AD, { memberIds: [EMP] })).s === 400);
  ok("an HR with company-wide access can be added", (await call("POST", "/queries/dept/admin/departments/" + hrDept, tok.AD, { memberIds: [HRX] })).s === 200);
  const mine = (await call("GET", "/queries/dept?view=DEPT_AWAITING", tok.HRX)).b;
  ok("the request is now in her department queue (Awaiting department action) and the IT one is not", mine.items.map((i) => i.id).join() === id, mine.items.map((i) => i.title));

  console.log("\n## she works the request");
  ok("accept ownership", (await call("POST", `/queries/dept/${id}/accept`, tok.HRX)).s === 200);
  ok("start work", (await call("POST", `/queries/dept/${id}/progress`, tok.HRX, { status: "IN_PROGRESS" })).s === 200);
  ok("add a comment", (await call("POST", `/queries/dept/${id}/comments`, tok.HRX, { body: "Ordering the domains today", visibility: "ALL" })).s === 200);
  ok("mark it Completed (with a note)", (await call("POST", `/queries/dept/${id}/progress`, tok.HRX, { status: "COMPLETED", note: "Domains purchased" })).s === 200);
  ok("approval history untouched: still approved by the Admin, one decision", (await q(`select count(*)::int c from dept_request_events where "requestId"=$1 and kind='ADMIN_APPROVED'`, [id]))[0].c === 1 && (await q(`select "approvalStatus" a from dept_requests where id=$1`, [id]))[0].a === "APPROVED");
  ok("no duplicate request was created", Number((await q(`select count(*)::int c from dept_requests where title='Need to purchase domains'`))[0].c) === 1);
  ok("the IT request is untouched (still awaiting, unassigned)", (await q(`select "workStatus" w,"assigneeId" a from dept_requests where id=$1`, [idIt]))[0].w === "AWAITING_ACTION");
  await wipe(); await db.end(); console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
