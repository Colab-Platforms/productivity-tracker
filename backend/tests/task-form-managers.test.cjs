// Daily Tasks form: "Tag Reporting Manager" + "Select Project" (both required when the person has any), checked on the server.
// Disposable database only (see _guard.cjs). The backend must run against the same database with the org-hierarchy migration applied.
//
//   cd backend && TEST_DATABASE_URL=... TEST_API=http://localhost:5012/api node tests/task-form-managers.test.cjs
const { Client } = require("pg");
const bcrypt = require("bcryptjs");
const API = process.env.TEST_API ?? "http://localhost:5012/api";
const DB = process.env.TEST_DATABASE_URL;
require("./_guard.cjs").assertTestDb(DB);

const call = async (m, p, t, body) => {
  const r = await fetch(API + p, { method: m, headers: { ...(t ? { authorization: "Bearer " + t } : {}), ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const txt = await r.text(); let j; try { j = JSON.parse(txt); } catch { j = txt; }
  return { s: r.status, b: j };
};
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  -> " + String(JSON.stringify(x)).slice(0, 400))); };
const PW = "Tfm@12345678";

(async () => {
  const db = new Client({ connectionString: DB }); await db.connect();
  const q = async (s, p) => (await db.query(s, p)).rows;
  const A = (await q(`select id from platforms where slug='avatar'`))[0].id;
  const B = (await q(`select id from platforms where slug='avance'`))[0].id;
  const hash = await bcrypt.hash(PW, 10);
  const wipe = async () => {
    const ids = (await q(`select id from users where "employeeCode" like 'TFM-%'`)).map((r) => r.id);
    if (ids.length) {
      await q(`delete from task_entry_details where "taskId" in (select id from daily_tasks where "userId" = any($1))`, [ids]).catch(() => {});
      await q(`delete from daily_tasks where "userId" = any($1)`, [ids]);
      await q(`delete from notifications where "userId" = any($1)`, [ids]);
      await q(`delete from team_managers where "userId" = any($1)`, [ids]).catch(() => {});
    }
    await q(`delete from teams where name like 'TFM %'`);
    await q(`delete from users where "employeeCode" like 'TFM-%'`).catch(() => {});
  };
  await wipe();
  const mk = async (code, first, role, plat, reportsTo) => (await q(`insert into users (id,"platformId",email,"passwordHash","firstName","lastName","employeeCode",role,status,"mustChangePassword","trackerAccessEnabled","onboardingStatus","dateOfJoining","reportsToId","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,$4,'Tfm',$5,$6,'ACTIVE',false,true,'ACTIVE','2026-01-01',$7,now(),now()) returning id`, [plat, code.toLowerCase() + "@tfm.test", hash, first, code, role, reportsTo ?? null]))[0].id;
  const team = async (name, plat, mgr) => (await q(`insert into teams (id,"platformId",name,"managerId","isActive","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,true,now(),now()) returning id`, [plat, name, mgr]))[0].id;
  const member = (t, u, primary) => q(`insert into team_members (id,"teamId","userId","isActive","isPrimary","joinedAt") values (gen_random_uuid(),$1,$2,true,$3,now())`, [t, u, !!primary]);
  const login = async (code) => (await (await fetch(API + "/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: code, password: PW }) })).json()).token;

  // company A: M1 = E's reporting manager, M2 = manager of project P1, M3 = unrelated manager (also manages P3, which E is NOT on)
  const M1 = await mk("TFM-M1", "Mone", "MANAGER", A), M2 = await mk("TFM-M2", "Mtwo", "MANAGER", A), M3 = await mk("TFM-M3", "Mthree", "MANAGER", A);
  const MB = await mk("TFM-MB", "Mbee", "MANAGER", B), MX = await mk("TFM-MX", "Mex", "MANAGER", B);
  const E = await mk("TFM-E", "Emp", "EMPLOYEE", A, M1);
  const E2 = await mk("TFM-E2", "Nobody", "EMPLOYEE", A, null);          // no manager, no project
  const EC = await mk("TFM-EC", "Cross", "EMPLOYEE", A, MX);             // reports to a manager of ANOTHER company
  const HR = await mk("TFM-HR", "Hrp", "HR", A), AD = await mk("TFM-AD", "Adm", "ADMIN", A);
  const P1 = await team("TFM P1", A, M2), P2 = await team("TFM P2", A, M1), P3 = await team("TFM P3", A, M3);
  await member(P1, E, true); await member(P2, E);                         // E is on P1 (under M2) and P2 (under M1); NOT on P3
  const tok = {};
  for (const [k, c] of Object.entries({ M1: "TFM-M1", M2: "TFM-M2", M3: "TFM-M3", MB: "TFM-MB", MX: "TFM-MX", E: "TFM-E", E2: "TFM-E2", EC: "TFM-EC", HR: "TFM-HR", AD: "TFM-AD" })) tok[k] = await login(c);
  const snap = async () => JSON.stringify([(await q(`select id,"reportsToId","platformId" from users where "employeeCode" like 'TFM-%' order by id`)), (await q(`select "teamId","userId","isActive","isPrimary" from team_members where "userId" in (select id from users where "employeeCode" like 'TFM-%') order by "teamId","userId"`))]);
  const before = await snap();

  console.log("\n## the form's dropdowns come from the database");
  const g = await call("GET", "/tasks", tok.E);
  const mgrNames = (g.b.entryForm?.options ?? []).map((o) => o.code).sort();
  ok("manager list = reporting manager + manager of E's projects only (M1, M2)", JSON.stringify(mgrNames) === JSON.stringify(["TFM-M1", "TFM-M2"]), g.b.entryForm);
  ok("unrelated manager M3 and other-company managers are NOT offered", !mgrNames.includes("TFM-M3") && !mgrNames.includes("TFM-MB") && !mgrNames.includes("TFM-MX"));
  ok("the reporting manager is preselected", g.b.entryForm?.defaultId === M1);
  ok("project list = E's own projects only (P1, P2), not P3", JSON.stringify((g.b.projects ?? []).map((p) => p.name).sort()) === JSON.stringify(["TFM P1", "TFM P2"]), g.b.projects);

  console.log("\n## the server enforces it (not just the form)");
  const post = (t, body) => call("POST", "/tasks", t, { title: "T " + Math.random().toString(36).slice(2, 7), weight: "MEDIUM", progress: "IN_PROGRESS", ...body });
  const r1 = await post(tok.E, { taggedManagerId: M2 });
  ok("no project chosen -> 400 PROJECT_REQUIRED", r1.s === 400 && /project/i.test(JSON.stringify(r1.b)), r1);
  const r2 = await post(tok.E, { teamId: P3, taggedManagerId: M2 });
  ok("a project E is not on -> 403", r2.s === 403, r2);
  const r3 = await post(tok.E, { teamId: P1, taggedManagerId: M3 });
  ok("an unrelated manager (same company) -> 400", r3.s === 400, r3);
  const r4 = await post(tok.E, { teamId: P1, taggedManagerId: MB });
  ok("a manager of another company -> 400", r4.s === 400, r4);
  const r5 = await post(tok.E, { teamId: P1, taggedManagerId: E2 });
  ok("a non-manager -> 400", r5.s === 400, r5);
  ok("nothing was saved by any refused attempt", (await q(`select count(*)::int n from daily_tasks where "userId"=$1`, [E]))[0].n === 0);

  console.log("\n## a valid submission");
  const title = "Plan the sprint " + Date.now();
  const okPost = await call("POST", "/tasks", tok.E, { title, description: "details", weight: "HIGH", progress: "IN_PROGRESS", teamId: P1, taggedManagerId: M2 });
  ok("submitted", okPost.s === 200, okPost);
  const row = (await q(`select t.id, t."userId", t."teamId", t.title, t.description, t.weight::text w, t."approvalStatus"::text ap, d."taggedManagerId" from daily_tasks t left join task_entry_details d on d."taskId"=t.id where t.title=$1`, [title]));
  ok("exactly one task saved (no duplicate)", row.length === 1, row);
  const t = row[0];
  ok("saved: employee, project, tagged manager, priority, description, status Pending", t && t.userId === E && t.teamId === P1 && t.taggedManagerId === M2 && t.w === "HIGH" && t.description === "details" && t.ap === "PENDING", t);
  await new Promise((z) => setTimeout(z, 800));
  const note = async (u) => (await q(`select count(*)::int n from notifications where "userId"=$1 and type='TASK_PROPOSED'`, [u]))[0].n;
  ok("the TAGGED manager (M2) is notified", (await note(M2)) === 1);
  ok("nobody else is: not M1 (reporting manager), not M3, not HR/Admin", (await note(M1)) === 0 && (await note(M3)) === 0 && (await note(HR)) === 0 && (await note(AD)) === 0);

  console.log("\n## who can approve");
  const qs = async (tk) => { const r = await call("GET", "/tasks/review/queue", tk); return (r.b.all ?? r.b.proposals ?? []).find((x) => x.id === t.id); };
  const q2 = await qs(tok.M2), q1 = await qs(tok.M1), qh = await qs(tok.HR), qa = await qs(tok.AD), q3 = await qs(tok.M3);
  ok("M2 sees it with the project name and can act", q2 && q2.canAct === true && (q2.projectName ?? q2.project ?? q2.team ?? q2.teamName ?? q2.projectId), q2);
  ok("M1 (the reporting manager, but NOT tagged) sees it but cannot act", q1 && q1.canAct === false, q1);
  ok("HR sees it, view only", qh && qh.canAct === false, qh);
  ok("Admin sees it, view only", qa && qa.canAct === false, qa);
  ok("an unrelated manager does not see it", !q3, q3);
  const ap = (tk) => call("POST", `/tasks/review/${t.id}/approve`, tk, { approve: true });
  ok("M1 approving -> refused", (await ap(tok.M1)).s === 403);
  ok("M3 approving -> refused", [403, 404].includes((await ap(tok.M3)).s));
  ok("HR approving -> refused", (await ap(tok.HR)).s === 403);
  ok("Admin approving -> refused", (await ap(tok.AD)).s === 403);
  ok("still Pending after every refusal", (await q(`select "approvalStatus"::text a from daily_tasks where id=$1`, [t.id]))[0].a === "PENDING");
  ok("the tagged manager M2 approves", (await ap(tok.M2)).s === 200 && (await q(`select "approvalStatus"::text a from daily_tasks where id=$1`, [t.id]))[0].a === "APPROVED");

  console.log("\n## default manager and the cross-company reporting manager");
  const t2 = await call("POST", "/tasks", tok.E, { title: "Default mgr " + Date.now(), weight: "LOW", progress: "IN_PROGRESS", teamId: P2 });
  const d2 = (await q(`select d."taggedManagerId" m from daily_tasks t join task_entry_details d on d."taskId"=t.id where t."userId"=$1 and t.title like 'Default mgr%'`, [E]))[0];
  ok("no tag sent -> the preselected reporting manager (M1) is used", t2.s === 200 && d2?.m === M1, [t2.s, d2]);
  const ec = await call("GET", "/tasks", tok.EC);
  ok("a person whose reporting manager is in another company still sees that manager (decision)", (ec.b.entryForm?.options ?? []).map((o) => o.code).join() === "TFM-MX" && ec.b.entryForm?.defaultId === MX, ec.b.entryForm);
  const tc = await call("POST", "/tasks", tok.EC, { title: "Cross " + Date.now(), weight: "LOW", progress: "IN_PROGRESS" });
  ok("EC (no project) submits tagged to MX without choosing a project", tc.s === 200, tc);
  const cid = (await q(`select id from daily_tasks where "userId"=$1`, [EC]))[0].id;
  ok("MX can approve EC's task", (await call("POST", `/tasks/review/${cid}/approve`, tok.MX, { approve: true })).s === 200);
  ok("another manager of MX's company (MB) cannot", [403, 404].includes((await call("POST", `/tasks/review/${cid}/approve`, tok.MB, { approve: true })).s));

  console.log("\n## nobody is locked out");
  const e2 = await call("GET", "/tasks", tok.E2);
  ok("a person with no manager and no project sees empty, labelled lists", (e2.b.entryForm?.options ?? []).length === 0 && (e2.b.projects ?? []).length === 0, e2.b.entryForm);
  const t3 = await call("POST", "/tasks", tok.E2, { title: "Lone " + Date.now(), weight: "LOW", progress: "IN_PROGRESS" });
  ok("...and can still submit (old routing)", t3.s === 200, t3);

  console.log("\n## nothing else changed");
  ok("no reporting line, company or project membership changed", (await snap()) === before);
  ok("no project was assigned just because a manager manages it (E not on P3)", (await q(`select count(*)::int n from team_members where "teamId"=$1 and "userId"=$2`, [P3, E]))[0].n === 0);

  await wipe();
  console.log(`\n${pass} passed, ${fail} failed`);
  await db.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("CRASH", e); process.exit(1); });
