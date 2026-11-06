// Daily Tasks form, PROJECT-BASED approver: the manager a task goes to is the manager of the project chosen for THAT task
// (teams.managerId + team_managers), not the employee's reporting manager. Disposable database only (see _guard.cjs).
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
      await q(`delete from task_events where "taskId" in (select id from daily_tasks where "userId" = any($1))`, [ids]).catch(() => {});
      await q(`delete from daily_tasks where "userId" = any($1)`, [ids]);
      await q(`delete from notifications where "userId" = any($1)`, [ids]);
    }
    await q(`delete from teams where name like 'TFM %'`);
    await q(`delete from users where "employeeCode" like 'TFM-%'`).catch(() => {});
  };
  await wipe();
  const mk = async (code, first, role, plat, reportsTo) => (await q(`insert into users (id,"platformId",email,"passwordHash","firstName","lastName","employeeCode",role,status,"mustChangePassword","trackerAccessEnabled","onboardingStatus","dateOfJoining","reportsToId","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,$4,'Tfm',$5,$6,'ACTIVE',false,true,'ACTIVE','2026-01-01',$7,now(),now()) returning id`, [plat, code.toLowerCase() + "@tfm.test", hash, first, code, role, reportsTo ?? null]))[0].id;
  const team = async (name, plat, mgr) => (await q(`insert into teams (id,"platformId",name,"managerId","isActive","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,true,now(),now()) returning id`, [plat, name, mgr]))[0].id;
  const member = (t, u) => q(`insert into team_members (id,"teamId","userId","isActive","isPrimary","joinedAt") values (gen_random_uuid(),$1,$2,true,false,now())`, [t, u]);
  const login = async (code) => (await (await fetch(API + "/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: code, password: PW }) })).json()).token;

  // RM = the employee's permanent REPORTING manager (never a project manager here). S = an ADMIN who manages project "Avatar", in ANOTHER company.
  const RM = await mk("TFM-RM", "Reportmgr", "MANAGER", A);
  const S = await mk("TFM-S", "Sanjayish", "ADMIN", B);
  const F = await mk("TFM-F", "Faizanish", "MANAGER", B), F2 = await mk("TFM-F2", "Newboss", "MANAGER", B);
  const H = await mk("TFM-H", "Hidden", "MANAGER", A), AD2 = await mk("TFM-AD2", "Otheradmin", "ADMIN", A);
  const HR = await mk("TFM-HR", "Hrp", "HR", A);
  const E = await mk("TFM-E", "Emp", "EMPLOYEE", A, RM);
  const NOP = await mk("TFM-NOP", "Noproject", "EMPLOYEE", A, RM);
  const PA = await team("TFM Avatar", A, S);          // managed by the Admin S
  const PB = await team("TFM Delivery", B, F);        // managed by F
  const PN = await team("TFM NoManager", A, null);    // no manager
  const PH = await team("TFM Hidden", A, H);          // E is NOT on this one
  for (const t of [PA, PB, PN]) await member(t, E);
  const tok = {};
  for (const [k, c] of Object.entries({ RM: "TFM-RM", S: "TFM-S", F: "TFM-F", F2: "TFM-F2", H: "TFM-H", AD2: "TFM-AD2", HR: "TFM-HR", E: "TFM-E", NOP: "TFM-NOP" })) tok[k] = await login(c);
  const snap = async () => JSON.stringify([(await q(`select id,"reportsToId","platformId" from users where "employeeCode" like 'TFM-%' order by id`)), (await q(`select "teamId","userId","isActive" from team_members where "userId" in (select id from users where "employeeCode" like 'TFM-%') order by "teamId","userId"`))]);
  const before = await snap();
  const names = (c) => (c?.options ?? []).map((o) => o.code).sort().join();

  console.log("\n## the form: each project offers ITS manager");
  const g = await call("GET", "/tasks", tok.E);
  const bp = g.b.entryForm?.byProject ?? {};
  ok("project list = E's projects only (Avatar, Delivery, NoManager), not Hidden", JSON.stringify((g.b.projects ?? []).map((p) => p.name).sort()) === JSON.stringify(["TFM Avatar", "TFM Delivery", "TFM NoManager"]), g.b.projects);
  ok("Avatar -> its Admin manager, preselected", names(bp[PA]) === "TFM-S" && bp[PA].defaultId === S, bp[PA]);
  ok("Delivery -> its Manager, preselected", names(bp[PB]) === "TFM-F" && bp[PB].defaultId === F, bp[PB]);
  ok("a project with no manager offers nobody", bp[PN] && bp[PN].options.length === 0 && bp[PN].defaultId === null, bp[PN]);
  ok("the reporting manager is NOT a project manager just because of the reporting line", !JSON.stringify(bp).includes("TFM-RM"));
  const others = (g.b.entryForm?.others ?? []).map((o) => o.code);
  ok("'other managers' = active Managers/Admins of E's OWN company only (RM, H, the other Admin), never E or other companies", ["TFM-RM", "TFM-H", "TFM-AD2"].every((c) => others.includes(c)) && !others.includes("TFM-E") && !others.includes("TFM-S") && !others.includes("TFM-F") && !others.includes("TFM-HR"), others);
  ok("no entry for a project E is not on", bp[PH] === undefined);

  console.log("\n## two projects, two managers, two independent submissions");
  const post = (t, body) => call("POST", "/tasks", t, { weight: "MEDIUM", progress: "IN_PROGRESS", ...body });
  const t1 = "Monday on Avatar " + Date.now(), t2 = "Tuesday on Delivery " + Date.now();
  const r1 = await post(tok.E, { title: t1, teamId: PA, taggedManagerId: S });
  const r2 = await post(tok.E, { title: t2, teamId: PB, taggedManagerId: F });
  ok("both submissions work", r1.s === 200 && r2.s === 200, [r1, r2]);
  const row = async (title) => (await q(`select t.id, t."userId", t."teamId", t."approvalStatus"::text ap, d."taggedManagerId" from daily_tasks t left join task_entry_details d on d."taskId"=t.id where t.title=$1`, [title]));
  const [a] = await row(t1), [b] = await row(t2);
  ok("Avatar task saved with project Avatar and approver S (Admin)", a && a.teamId === PA && a.taggedManagerId === S && a.userId === E && a.ap === "PENDING", a);
  ok("Delivery task saved with project Delivery and approver F", b && b.teamId === PB && b.taggedManagerId === F && b.ap === "PENDING", b);
  ok("the permanent reporting manager did not change", (await q(`select "reportsToId" r from users where id=$1`, [E]))[0].r === RM);
  await new Promise((z) => setTimeout(z, 800));
  const note = async (u) => (await q(`select count(*)::int n from notifications where "userId"=$1 and type='TASK_PROPOSED'`, [u]))[0].n;
  ok("S and F are each notified once; the reporting manager, HR and the other Admin are not", (await note(S)) === 1 && (await note(F)) === 1 && (await note(RM)) === 0 && (await note(HR)) === 0 && (await note(AD2)) === 0);

  console.log("\n## the server enforces it");
  const bad = async (body, expect) => { const r = await post(tok.E, { title: "x " + Math.random(), ...body }); return [r.s, r.s === expect]; };
  ok("Avatar task tagged to Delivery's manager -> 400", (await bad({ teamId: PA, taggedManagerId: F }, 400))[1]);
  ok("tagged to a manager of ANOTHER company who is not on that project -> 400", (await bad({ teamId: PA, taggedManagerId: F2 }, 400))[1]);
  ok("tagged to HR or an employee (not Manager/Admin) -> 400", (await bad({ teamId: PA, taggedManagerId: HR }, 400))[1] && (await bad({ teamId: PA, taggedManagerId: NOP }, 400))[1]);
  ok("a project E is not on -> 403", (await bad({ teamId: PH, taggedManagerId: H }, 403))[1]);
  ok("a project with NO manager and no tag chosen -> 400, asks to choose", await (async () => { const r = await post(tok.E, { title: "nm " + Date.now(), teamId: PN }); return r.s === 400 && /choose/i.test(JSON.stringify(r.b)); })());
  ok("no project chosen -> 400", (await bad({ taggedManagerId: S }, 400))[1]);
  ok("nothing was saved by any refused attempt (still just the two real tasks)", (await q(`select count(*)::int n from daily_tasks where "userId"=$1`, [E]))[0].n === 2);

  console.log("\n## work for ANOTHER project: tag any manager of the company");
  const to = "Other project work " + Date.now();
  const ro = await post(tok.E, { title: to, teamId: PA, taggedManagerId: RM });
  const oo = (await row(to))[0];
  ok("Avatar task tagged to another manager of the company (RM) works and is saved", ro.s === 200 && oo && oo.taggedManagerId === RM && oo.teamId === PA, ro);
  const oh = await post(tok.E, { title: "Other H " + Date.now(), teamId: PA, taggedManagerId: H });
  ok("a manager of an unrelated project, same company, can be tagged too", oh.s === 200, oh);
  const pn = await post(tok.E, { title: "Orphan " + Date.now(), teamId: PN, taggedManagerId: RM });
  ok("a project with no manager is no longer a dead end: tag another manager", pn.s === 200, pn);
  await new Promise((z) => setTimeout(z, 800));
  ok("only the tagged manager (RM) is notified of the other-project task", (await q(`select count(*)::int n from notifications where "userId"=$1 and type='TASK_PROPOSED' and data::text like $2`, [RM, "%" + oo.id + "%"]))[0].n === 1 && (await q(`select count(*)::int n from notifications where "userId"=$1 and type='TASK_PROPOSED' and data::text like $2`, [S, "%" + oo.id + "%"]))[0].n === 0);
  ok("RM can act on it; the project's own manager S cannot", (await (async () => { const r = await call("GET", "/tasks/review/queue", tok.RM); return (r.b.all ?? []).find((x) => x.id === oo.id)?.canAct === true; })()) && (await call("POST", `/tasks/review/${oo.id}/approve`, tok.S, { approve: true })).s === 403);
  ok("RM approves it", (await call("POST", `/tasks/review/${oo.id}/approve`, tok.RM, { approve: true })).s === 200);
  await q(`delete from task_entry_details where "taskId" in (select id from daily_tasks where "userId"=$1 and title in ($2,$3,$4))`, [E, to, "x", "x"]).catch(() => {});
  const dflt = await post(tok.E, { title: "default mgr " + Date.now(), teamId: PB });
  ok("no tag sent -> the project's own manager is used", dflt.s === 200 && (await q(`select d."taggedManagerId" m from daily_tasks t join task_entry_details d on d."taskId"=t.id where t.title like 'default mgr%'`))[0].m === F, dflt);
  ok("a person with no project is not blocked (old routing, no tag)", (await post(tok.NOP, { title: "lone " + Date.now() })).s === 200);

  console.log("\n## who can approve (each task reaches only its own project manager)");
  const qs = async (tk, id) => { const r = await call("GET", "/tasks/review/queue", tk); return (r.b.all ?? []).find((x) => x.id === id); };
  ok("S (Admin, project manager) sees the Avatar task and can act", (await qs(tok.S, a.id))?.canAct === true);
  ok("S cannot act on the Delivery task (not his project)", !(await qs(tok.S, b.id)) || (await qs(tok.S, b.id)).canAct === false);
  ok("F sees the Delivery task and can act", (await qs(tok.F, b.id))?.canAct === true);
  ok("the reporting manager sees them but cannot act", ((await qs(tok.RM, a.id))?.canAct ?? false) === false && ((await qs(tok.RM, b.id))?.canAct ?? false) === false);
  ok("HR sees them view-only", (await qs(tok.HR, a.id))?.canAct === false);
  ok("another Admin sees them view-only (an Admin is not an approver by role)", (await qs(tok.AD2, a.id))?.canAct === false);
  const ap = (tk, id) => call("POST", `/tasks/review/${id}/approve`, tk, { approve: true });
  ok("reporting manager approving the Avatar task -> refused", (await ap(tok.RM, a.id)).s === 403);
  ok("F approving the Avatar task -> refused", (await ap(tok.F, a.id)).s === 403);
  ok("S approving the Delivery task -> refused", (await ap(tok.S, b.id)).s === 403);
  ok("HR and the other Admin approving -> refused", (await ap(tok.HR, a.id)).s === 403 && (await ap(tok.AD2, a.id)).s === 403);
  ok("still Pending after every refusal", (await q(`select count(*)::int n from daily_tasks where id = any($1) and "approvalStatus"='PENDING'`, [[a.id, b.id]]))[0].n === 2);
  ok("S (Admin assigned as project manager) approves the Avatar task", (await ap(tok.S, a.id)).s === 200 && (await q(`select "approvalStatus"::text x from daily_tasks where id=$1`, [a.id]))[0].x === "APPROVED");

  console.log("\n## the project manager changes later: history keeps the original approver");
  await q(`update teams set "managerId"=$1 where id=$2`, [F2, PB]);
  ok("the saved approver of the old Delivery task is still F", (await row(t2))[0].taggedManagerId === F);
  ok("new Delivery tasks now offer the NEW manager only", names((await call("GET", "/tasks", tok.E)).b.entryForm.byProject[PB]) === "TFM-F2");
  const t4 = "After the change " + Date.now();
  await post(tok.E, { title: t4, teamId: PB });
  const n4 = (await row(t4))[0];
  ok("a new task goes to the new manager F2", n4 && n4.taggedManagerId === F2, n4);
  ok("F2 cannot approve the OLD task", (await ap(tok.F2, b.id)).s === 403);
  ok("F (the original approver) can still decide the OLD task", (await ap(tok.F, b.id)).s === 200);

  console.log("\n## several managers on one project, and editing the project of a waiting task");
  await q(`insert into team_managers (id,"teamId","userId","createdAt") values (gen_random_uuid(),$1,$2,now())`, [PB, F]).catch(async () => q(`insert into team_managers (id,"teamId","userId") values (gen_random_uuid(),$1,$2)`, [PB, F]));
  ok("a co-manager is offered too, the main manager stays preselected", names((await call("GET", "/tasks", tok.E)).b.entryForm.byProject[PB]) === "TFM-F,TFM-F2" && (await call("GET", "/tasks", tok.E)).b.entryForm.byProject[PB].defaultId === F2);
  const t5 = "Move me " + Date.now();
  await post(tok.E, { title: t5, teamId: PA, taggedManagerId: S });
  const m5 = (await row(t5))[0];
  const mv = await call("PATCH", `/tasks/${m5.id}`, tok.E, { teamId: PB, taggedManagerId: F });
  ok("moving a waiting task to another project re-tags it to that project's manager", mv.s === 200 && (await row(t5))[0].taggedManagerId === F && (await row(t5))[0].teamId === PB, mv);
  const mv2 = await call("PATCH", `/tasks/${m5.id}`, tok.E, { teamId: PN });
  ok("...to a project with no manager it needs a chosen manager (400), and it stays where it was", mv2.s === 400 && (await row(t5))[0].teamId === PB, mv2);
  const mv3 = await call("PATCH", `/tasks/${m5.id}`, tok.E, { teamId: PN, taggedManagerId: RM });
  ok("...and with a manager chosen it moves", mv3.s === 200 && (await row(t5))[0].teamId === PN && (await row(t5))[0].taggedManagerId === RM, mv3);

  console.log("\n## nothing else changed");
  ok("no reporting line, company or project membership changed", (await snap()) === before);
  ok("E was not put on the Hidden project", (await q(`select count(*)::int n from team_members where "teamId"=$1 and "userId"=$2`, [PH, E]))[0].n === 0);

  await wipe();
  console.log(`\n${pass} passed, ${fail} failed`);
  await db.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("CRASH", e); process.exit(1); });
