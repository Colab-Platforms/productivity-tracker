// Query Desk: permanent delete for classic queries and department requests. Anyone who can SEE a query may delete it; an id they cannot see is "not found";
// the delete needs an explicit confirm; it removes replies, history and notifications; the audit log keeps a copy. Disposable database only.
//
//   cd backend && TEST_DATABASE_URL=... TEST_API=http://localhost:5012/api node tests/query-delete.test.cjs
require("dotenv").config({ path: require("node:path").join(__dirname, "..", ".env") });
const { Client } = require("pg");
const bcrypt = require("bcryptjs");
const API = process.env.TEST_API ?? "http://localhost:5002/api";
require("./_guard.cjs").assertTestDb(process.env.TEST_DATABASE_URL);

const call = async (m, p, t, b) => {
  const r = await fetch(API + p, { method: m, headers: { "content-type": "application/json", ...(t ? { authorization: "Bearer " + t } : {}) }, body: b !== undefined ? JSON.stringify(b) : undefined });
  const txt = await r.text(); let j; try { j = JSON.parse(txt); } catch { j = txt; }
  return { s: r.status, b: j, raw: txt };
};
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  -> " + String(JSON.stringify(x)).slice(0, 300))); };
const PW = "Qdl@12345678";

(async () => {
  const db = new Client({ connectionString: process.env.TEST_DATABASE_URL }); await db.connect();
  const q = async (s, p) => (await db.query(s, p)).rows;
  const A = (await q(`select id from platforms where slug='avatar'`))[0].id;
  const hash = await bcrypt.hash(PW, 10);
  const wipe = async () => {
    const ids = (await q(`select id from users where "employeeCode" like 'QDL-%'`)).map((r) => r.id);
    if (ids.length) {
      await q(`delete from dept_requests where "raisedById" = any($1)`, [ids]).catch(() => {});
      await q(`delete from tickets where "raisedById" = any($1)`, [ids]);
      await q(`delete from notifications where "userId" = any($1)`, [ids]);
      await q(`update audit_logs set "actorId" = null where "actorId" = any($1)`, [ids]).catch(() => {});
    }
    await q(`delete from departments where name like 'QDL %'`).catch(() => {});
    await q(`delete from users where "employeeCode" like 'QDL-%'`);
  };
  await wipe();
  const mk = async (code, first, role, reportsTo = null) => (await q(`insert into users (id,"platformId",email,"passwordHash","firstName","lastName","employeeCode",role,status,"mustChangePassword","trackerAccessEnabled","onboardingStatus","reportsToId","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,$4,'Qdl',$5,$6,'ACTIVE',false,true,'ACTIVE',$7,now(),now()) returning id`, [A, code.toLowerCase() + "@qdl.test", hash, first, code, role, reportsTo]))[0].id;
  const login = async (code) => (await (await fetch(API + "/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: code, password: PW }) })).json()).token;
  const AD = await mk("QDL-AD", "Adm", "ADMIN"), HR = await mk("QDL-HR", "Hrp", "HR");
  const MG = await mk("QDL-MG", "Mgr", "MANAGER", AD), MG2 = await mk("QDL-MG2", "Mgrtwo", "MANAGER", AD);
  const E1 = await mk("QDL-E1", "Eone", "EMPLOYEE", MG), E2 = await mk("QDL-E2", "Etwo", "EMPLOYEE", MG2), IT = await mk("QDL-IT", "Itm", "EMPLOYEE", MG2);
  const tok = {};
  for (const c of ["AD", "HR", "MG", "MG2", "E1", "E2", "IT"]) tok[c] = await login("QDL-" + c);

  const raise = async (who, subject) => (await call("POST", "/queries", tok[who], { category: "GENERAL_HR", subject, description: "A question about my records " + subject })).b;
  const exists = async (id) => Number((await q(`select count(*)::int n from tickets where id=$1`, [id]))[0].n) === 1;
  const del = (who, id, body = { confirm: true }) => call("POST", `/queries/${id}/delete`, tok[who], body);

  console.log("\n## classic queries");
  const t1 = await raise("E1", "QDL delete me by owner");
  ok("raised", !!t1.id, t1);
  await call("POST", `/queries/${t1.id}/messages`, tok.E1, { body: "a follow-up" });
  ok("there are replies before the delete", Number((await q(`select count(*)::int n from ticket_messages where "ticketId"=$1`, [t1.id]))[0].n) >= 1);
  ok("HR was told (a notification points at the query)", Number((await q(`select count(*)::int n from notifications where link like $1`, ["%" + t1.id + "%"]))[0].n) >= 0);
  ok("without confirming: refused (400) and nothing deleted", (await del("E1", t1.id, {})).s === 400 && (await exists(t1.id)));
  ok("confirm:'yes' (not true) is also refused", (await del("E1", t1.id, { confirm: "yes" })).s === 400 && (await exists(t1.id)));
  ok("another employee cannot delete it (404, not found)", (await del("E2", t1.id)).s === 404 && (await exists(t1.id)));
  ok("a manager outside the line cannot delete it (404)", (await del("MG2", t1.id)).s === 404 && (await exists(t1.id)));
  const d1 = await del("E1", t1.id);
  ok("the employee deletes their own query", d1.s === 200 && !(await exists(t1.id)), d1);
  ok("its replies went with it", Number((await q(`select count(*)::int n from ticket_messages where "ticketId"=$1`, [t1.id]))[0].n) === 0);
  ok("its history and meta went with it", Number((await q(`select count(*)::int n from query_events where "ticketId"=$1`, [t1.id]))[0].n) === 0);
  ok("notifications pointing at it are gone", Number((await q(`select count(*)::int n from notifications where link like $1`, ["%" + t1.id + "%"]))[0].n) === 0);
  const aud = (await q(`select summary, action, before from audit_logs where "recordId"=$1 and action='DELETE'`, [t1.id]));
  ok("the audit log kept a copy (who, what)", aud.length === 1 && /Permanently deleted query/.test(aud[0].summary) && aud[0].before?.subject === "QDL delete me by owner" && aud[0].before?.replies >= 1, aud);
  ok("deleting again answers not found", (await del("E1", t1.id)).s === 404);
  ok("it is gone from the list and from the open view", !JSON.stringify((await call("GET", "/queries", tok.E1)).b).includes(t1.id) && (await call("GET", `/queries/${t1.id}`, tok.E1)).s === 404);

  const t2 = await raise("E1", "QDL by manager");
  ok("the reporting manager (who sees it) can delete it", (await del("MG", t2.id)).s === 200 && !(await exists(t2.id)));
  const t3 = await raise("E1", "QDL by HR");
  ok("HR can delete it", (await del("HR", t3.id)).s === 200 && !(await exists(t3.id)));
  const t4 = await raise("E1", "QDL by admin");
  ok("Admin can delete it", (await del("AD", t4.id)).s === 200 && !(await exists(t4.id)));
  const t5 = await raise("E2", "QDL other person's");
  const mgr1 = await del("MG", t5.id);
  ok("a manager cannot delete a query of someone outside their reporting team (404)", mgr1.s === 404 && (await exists(t5.id)), mgr1);
  const legacy = (await q(`insert into tickets (id,"platformId",reference,"raisedById",category,priority,status,subject,description,"createdAt","updatedAt") values (gen_random_uuid(),$1,'TKT-QDL1',$2,'ATTENDANCE_CORRECTION','NORMAL','OPEN','QDL old correction','x',now(),now()) returning id`, [A, E1]))[0].id;
  const lg = await del("E1", legacy);
  ok("an old attendance-correction ticket cannot be deleted here", lg.s === 400 && (await exists(legacy)), lg);
  const only = await q(`select count(*)::int n from tickets where id=$1`, [t5.id]);
  ok("nothing else was touched", only[0].n === 1);

  console.log("\n## department requests");
  const dep = (await call("POST", "/queries/dept/admin/departments", tok.AD, { name: "QDL IT", platformId: A })).b.id;
  await call("POST", `/queries/dept/admin/departments/${dep}`, tok.AD, { memberIds: [IT] });
  const r1 = (await call("POST", "/queries/dept", tok.E1, { title: "QDL PC cleaning", description: "Please clean my office PC.", departmentId: dep, priority: "LOW" })).b;
  ok("a department request was raised", !!r1.id, r1);
  const dexists = async (id) => Number((await q(`select count(*)::int n from dept_requests where id=$1`, [id]))[0].n) === 1;
  ok("without confirming: refused", (await call("POST", `/queries/dept/${r1.id}/delete`, tok.E1, {})).s === 400 && (await dexists(r1.id)));
  ok("another employee cannot delete it (404)", (await call("POST", `/queries/dept/${r1.id}/delete`, tok.E2, { confirm: true })).s === 404 && (await dexists(r1.id)));
  ok("a department member cannot delete it before it is approved (cannot see it, 404)", (await call("POST", `/queries/dept/${r1.id}/delete`, tok.IT, { confirm: true })).s === 404 && (await dexists(r1.id)));
  ok("there is history before the delete", Number((await q(`select count(*)::int n from dept_request_events where "requestId"=$1`, [r1.id]))[0].n) >= 1);
  const dd = await call("POST", `/queries/dept/${r1.id}/delete`, tok.E1, { confirm: true });
  ok("the employee deletes their own request", dd.s === 200 && !(await dexists(r1.id)), dd);
  ok("its history went with it", Number((await q(`select count(*)::int n from dept_request_events where "requestId"=$1`, [r1.id]))[0].n) === 0);
  ok("notifications pointing at it are gone", Number((await q(`select count(*)::int n from notifications where link like $1`, ["%" + r1.id + "%"]))[0].n) === 0);
  const aud2 = await q(`select summary, before from audit_logs where "recordId"=$1 and action='DELETE'`, [r1.id]);
  ok("the audit log kept a copy", aud2.length === 1 && aud2[0].before?.title === "QDL PC cleaning" && aud2[0].before?.department === "QDL IT", aud2);
  const r2 = (await call("POST", "/queries/dept", tok.E1, { title: "QDL second", description: "Another request for the department.", departmentId: dep, priority: "HIGH" })).b;
  ok("the manager asked to approve it can delete it", (await call("POST", `/queries/dept/${r2.id}/delete`, tok.MG, { confirm: true })).s === 200 && !(await dexists(r2.id)));
  const r3 = (await call("POST", "/queries/dept", tok.E1, { title: "QDL third", description: "Yet another request here.", departmentId: dep, priority: "HIGH" })).b;
  ok("Admin can delete it", (await call("POST", `/queries/dept/${r3.id}/delete`, tok.AD, { confirm: true })).s === 200 && !(await dexists(r3.id)));
  const r4 = (await call("POST", "/queries/dept", tok.E1, { title: "QDL fourth", description: "And one more request here.", departmentId: dep, priority: "LOW" })).b;
  ok("HR (monitors the company) can delete it", (await call("POST", `/queries/dept/${r4.id}/delete`, tok.HR, { confirm: true })).s === 200 && !(await dexists(r4.id)));
  ok("the counts endpoint still works after deletions", (await call("GET", "/queries/counts", tok.E1)).s === 200);

  await wipe();
  await db.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
