// Default project and reporting manager for a new task, worked out from the employee's own records (primary team / only team, reporting manager).
// The server sends them with the form; the employee can change them; the task saves what was actually selected. Disposable database only.
//
//   cd backend && TEST_DATABASE_URL=... TEST_API=http://localhost:5012/api node tests/task-defaults.test.cjs
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
const PW = "Tdf@12345678";

(async () => {
  const db = new Client({ connectionString: DB }); await db.connect();
  const q = async (s, p) => (await db.query(s, p)).rows;
  const A = (await q(`select id from platforms where slug='avatar'`))[0].id;
  const hash = await bcrypt.hash(PW, 10);
  const linksTable = (await q(`select to_regclass('reporting_manager_links') t`))[0].t;
  const wipe = async () => {
    const ids = (await q(`select id from users where "employeeCode" like 'TDF-%'`)).map((r) => r.id);
    if (ids.length) {
      if (linksTable) await q(`delete from reporting_manager_links where "userId" = any($1) or "managerId" = any($1)`, [ids]).catch(() => {});
      await q(`delete from task_entry_details where "taskId" in (select id from daily_tasks where "userId" = any($1))`, [ids]).catch(() => {});
      await q(`delete from task_events where "taskId" in (select id from daily_tasks where "userId" = any($1))`, [ids]).catch(() => {});
      await q(`delete from daily_tasks where "userId" = any($1)`, [ids]);
      await q(`delete from notifications where "userId" = any($1)`, [ids]);
      await q(`delete from team_members where "userId" = any($1)`, [ids]);
    }
    await q(`delete from teams where name like 'TDF %'`);
    await q(`delete from users where "employeeCode" like 'TDF-%'`).catch(() => {});
  };
  await wipe();
  const mk = async (code, first, role, reportsTo, status = "ACTIVE") => (await q(`insert into users (id,"platformId",email,"passwordHash","firstName","lastName","employeeCode",role,status,"mustChangePassword","trackerAccessEnabled","onboardingStatus","dateOfJoining","reportsToId","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,$4,'Tdf',$5,$6,$8,false,true,'ACTIVE','2026-01-01',$7,now(),now()) returning id`, [A, code.toLowerCase() + "@tdf.test", hash, first, code, role, reportsTo ?? null, status]))[0].id;
  const team = async (name, mgr, active = true) => (await q(`insert into teams (id,"platformId",name,"managerId","isActive","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,$4,now(),now()) returning id`, [A, name, mgr, active]))[0].id;
  const member = (t, u, primary, active = true) => q(`insert into team_members (id,"teamId","userId","isActive","isPrimary","joinedAt") values (gen_random_uuid(),$1,$2,$3,$4,now())`, [t, u, active, primary]);
  const login = async (code) => (await (await fetch(API + "/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: code, password: PW }) })).json()).token;

  const M1 = await mk("TDF-M1", "Manone", "MANAGER"), M2 = await mk("TDF-M2", "Mantwo", "MANAGER");
  const AD = await mk("TDF-AD", "Admin", "ADMIN"), HR = await mk("TDF-HR", "Hrp", "HR");
  const SUSP = await mk("TDF-SUSP", "Suspended", "MANAGER", null, "SUSPENDED");
  const P1 = await team("TDF Alpha", M1), P2 = await team("TDF Beta", M2), P3 = await team("TDF Gamma", M1, false); // P3 is inactive
  const E1 = await mk("TDF-E1", "Eone", "EMPLOYEE", M1); await member(P1, E1, true); await member(P2, E1, false);
  const E2 = await mk("TDF-E2", "Etwo", "EMPLOYEE", M1); await member(P1, E2, false); await member(P2, E2, false);
  const E3 = await mk("TDF-E3", "Ethree", "EMPLOYEE", HR); await member(P2, E3, false);
  const E4 = await mk("TDF-E4", "Efour", "EMPLOYEE", SUSP);
  const E5 = await mk("TDF-E5", "Efive", "EMPLOYEE", null);
  const E6 = await mk("TDF-E6", "Esix", "EMPLOYEE", AD); await member(P1, E6, true, false); await member(P3, E6, true);
  const E7 = await mk("TDF-E7", "Eseven", "EMPLOYEE", M1); await member(P1, E7, true); await member(P2, E7, true);
  const E8 = await mk("TDF-E8", "Eeight", "EMPLOYEE", null);
  if (linksTable) await q(`insert into reporting_manager_links (id,"userId","managerId","createdAt") values (gen_random_uuid(),$1,$2,now())`, [E5, M2]).catch(async () => { await q(`insert into reporting_manager_links (id,"userId","managerId","createdById","createdAt") values (gen_random_uuid(),$1,$2,$3,now())`, [E5, M2, AD]); });
  const tok = {};
  for (const [k, c] of Object.entries({ E1: "TDF-E1", E2: "TDF-E2", E3: "TDF-E3", E4: "TDF-E4", E5: "TDF-E5", E6: "TDF-E6", E7: "TDF-E7", E8: "TDF-E8", M1: "TDF-M1", HR: "TDF-HR" })) tok[k] = await login(c);
  const outside = async () => JSON.stringify(await q(`select id,title,status::text,"approvalStatus"::text,"teamId" from daily_tasks where "userId" not in (select id from users where "employeeCode" like 'TDF-%') order by id`));
  const beforeOutside = await outside();
  const form = async (k) => (await call("GET", "/tasks", tok[k])).b.entryForm;

  console.log("\n## the defaults come from the person's records");
  const f1 = await form("E1");
  ok("primary team + reporting manager: both are filled in", f1.defaults.projectId === P1 && f1.defaults.managerId === M1 && f1.defaults.projectSource === "PRIMARY_TEAM" && f1.defaults.managerSource === "REPORTING_MANAGER", f1.defaults);
  ok("the defaults are real choices on the form's own lists", f1.projects.some((p) => p.id === f1.defaults.projectId) && f1.managers.some((m) => m.id === f1.defaults.managerId));
  const f2 = await form("E2");
  ok("two teams and none primary: no project is guessed, the manager still defaults", f2.defaults.projectId === null && f2.defaults.managerId === M1, f2.defaults);
  const f3 = await form("E3");
  ok("only one team (not marked primary): that team; the reporting manager is HR, who may approve their own reporting employees (2026-11-17 rule), so HR is the default", f3.defaults.projectId === P2 && f3.defaults.projectSource === "ONLY_TEAM" && f3.defaults.managerId !== null && f3.defaults.managerSource === "REPORTING_MANAGER", f3.defaults);
  const f4 = await form("E4");
  ok("no team and a suspended reporting manager: nothing is pre-selected", f4.defaults.projectId === null && f4.defaults.managerId === null, f4.defaults);
  if (linksTable) {
    const f5 = await form("E5");
    ok("no reporting manager but exactly one additional reporting manager: that one", f5.defaults.managerId === M2 && f5.defaults.managerSource === "ADDITIONAL_MANAGER", f5.defaults);
  }
  const f6 = await form("E6");
  ok("an inactive membership and an inactive team are ignored; an Admin reporting manager can be the default", f6.defaults.projectId === null && f6.defaults.managerId === AD, f6.defaults);
  const f7 = await form("E7");
  ok("two primary teams is ambiguous: no project", f7.defaults.projectId === null && f7.defaults.managerId === M1, f7.defaults);
  const f8 = await form("E8");
  ok("no team and no reporting manager: both empty", f8.defaults.projectId === null && f8.defaults.managerId === null, f8.defaults);

  console.log("\n## not hardcoded: change the records and the defaults follow");
  await q(`update team_members set "isPrimary" = (case when "teamId" = $2 then true else false end) where "userId" = $1`, [E1, P2]);
  await q(`update users set "reportsToId" = $2 where id = $1`, [E1, M2]);
  const f1b = await form("E1");
  ok("a different primary team and a different reporting manager give different defaults", f1b.defaults.projectId === P2 && f1b.defaults.managerId === M2, f1b.defaults);
  await q(`update team_members set "isPrimary" = (case when "teamId" = $2 then true else false end) where "userId" = $1`, [E1, P1]);
  await q(`update users set "reportsToId" = $2 where id = $1`, [E1, M1]);

  console.log("\n## the task saves what was actually selected");
  const d = (await form("E1")).defaults;
  const tkDefault = await call("POST", "/tasks", tok.E1, { title: "Default task", weight: "MEDIUM", progress: "IN_PROGRESS", hoursSpent: 1, teamId: d.projectId, taggedManagerId: d.managerId });
  const saved1 = (await q(`select t."teamId", e."taggedManagerId" m from daily_tasks t join task_entry_details e on e."taskId"=t.id where t.title='Default task' and t."userId"=$1`, [E1]))[0];
  ok("sent with the pre-selected values: saved against that project and manager", tkDefault.s === 200 && saved1.teamId === P1 && saved1.m === M1, saved1);
  const tkChanged = await call("POST", "/tasks", tok.E1, { title: "Changed task", weight: "MEDIUM", progress: "IN_PROGRESS", hoursSpent: 1, teamId: P2, taggedManagerId: M2 });
  const saved2 = (await q(`select t."teamId", e."taggedManagerId" m from daily_tasks t join task_entry_details e on e."taskId"=t.id where t.title='Changed task' and t."userId"=$1`, [E1]))[0];
  ok("the employee changed both: the CHANGED project and manager are saved, not the defaults", tkChanged.s === 200 && saved2.teamId === P2 && saved2.m === M2, saved2);
  const bulk = await call("POST", "/tasks/bulk", tok.E1, { rows: [
    { key: "a", title: "Bulk default", teamId: d.projectId, taggedManagerId: d.managerId, progress: "TODO", weight: "LOW" },
    { key: "b", title: "Bulk changed", teamId: P2, taggedManagerId: M2, progress: "TODO", weight: "LOW" },
  ] });
  const bs = Object.fromEntries((await q(`select t.title, t."teamId", e."taggedManagerId" m from daily_tasks t join task_entry_details e on e."taskId"=t.id where t.title like 'Bulk %' and t."userId"=$1`, [E1])).map((r) => [r.title, r]));
  ok("Quick Add: each row saves its own selection (default or changed)", bulk.b.submitted === 2 && bs["Bulk default"].teamId === P1 && bs["Bulk default"].m === M1 && bs["Bulk changed"].teamId === P2 && bs["Bulk changed"].m === M2, bs);
  const noMgr = await call("POST", "/tasks", tok.E1, { title: "No manager sent", weight: "LOW", progress: "TODO", teamId: P1 });
  const noProj = await call("POST", "/tasks", tok.E1, { title: "No project sent", weight: "LOW", progress: "TODO", taggedManagerId: M1 });
  ok("the server does NOT fill anything in by itself: a request with no manager or no project is still refused", noMgr.s === 400 && noProj.s === 400 && (await q(`select count(*)::int n from daily_tasks where title in ('No manager sent','No project sent')`))[0].n === 0, [noMgr.s, noMgr.b, noProj.s, noProj.b]);
  const badMgr = await call("POST", "/tasks", tok.E1, { title: "HR as manager", weight: "LOW", progress: "TODO", teamId: P1, taggedManagerId: HR });
  ok("a manager who cannot be tagged is still refused whatever the default says", badMgr.s === 400, badMgr);

  console.log("\n## a task already sent keeps its manager when the reporting line changes later");
  await q(`update users set "reportsToId" = $2 where id = $1`, [E1, M2]);
  const keep = (await q(`select e."taggedManagerId" m from daily_tasks t join task_entry_details e on e."taskId"=t.id where t.title='Default task' and t."userId"=$1`, [E1]))[0];
  ok("the earlier task is still tagged to the manager it was sent to", keep.m === M1, keep);
  ok("and the NEXT task's default is the new reporting manager", (await form("E1")).defaults.managerId === M2);
  await q(`update users set "reportsToId" = $2 where id = $1`, [E1, M1]);

  console.log("\n## other roles and other people");
  const fm = (await call("GET", "/tasks", tok.M1)).b;
  ok("a manager (own self-managed tasks) gets no approval form, so no defaults are offered", fm.entryForm?.ready === false && fm.entryForm.defaults.projectId === null && fm.entryForm.defaults.managerId === null, fm.entryForm);
  const fh = await form("HR");
  ok("an HR user's form gets defaults from their own records too (none here)", fh.defaults && fh.defaults.managerId === null, fh.defaults);
  ok("one employee's defaults never show another's (E2's manager default is E2's own)", (await form("E2")).defaults.managerId === M1 && (await form("E3")).defaults.projectId === P2);
  ok("other people's tasks are exactly as they were", (await outside()) === beforeOutside, 0);

  await wipe();
  await db.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
