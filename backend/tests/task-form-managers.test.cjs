// Daily Tasks form: TWO INDEPENDENT dropdowns read from the existing records. Project = every ACTIVE project (any company, real ids,
// same-named projects told apart by company). Reporting Manager = every active Manager/Admin who is someone's reporting manager or runs an
// active project (each once). Picking one never changes the other, nothing is preselected, and only the tagged manager can approve.
// Disposable database only (see _guard.cjs).
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
  const mk = async (code, first, role, plat, reportsTo, status = "ACTIVE") => (await q(`insert into users (id,"platformId",email,"passwordHash","firstName","lastName","employeeCode",role,status,"mustChangePassword","trackerAccessEnabled","onboardingStatus","dateOfJoining","reportsToId","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,$4,'Tfm',$5,$6,$8,false,true,'ACTIVE','2026-01-01',$7,now(),now()) returning id`, [plat, code.toLowerCase() + "@tfm.test", hash, first, code, role, reportsTo ?? null, status]))[0].id;
  const team = async (name, plat, mgr, active = true) => (await q(`insert into teams (id,"platformId",name,"managerId","isActive","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,$4,now(),now()) returning id`, [plat, name, mgr, active]))[0].id;
  const member = (t, u) => q(`insert into team_members (id,"teamId","userId","isActive","isPrimary","joinedAt") values (gen_random_uuid(),$1,$2,true,false,now())`, [t, u]);
  const login = async (code) => (await (await fetch(API + "/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: code, password: PW }) })).json()).token;

  // company A: RM (E's reporting manager), M2, H (Managers), ADA (plain Admin, no project), SUSP (suspended Manager); company B: S (Admin, runs a project of A), F, F2 (Managers)
  const RM = await mk("TFM-RM", "Reportmgr", "MANAGER", A), M2 = await mk("TFM-M2", "Mtwo", "MANAGER", A), H = await mk("TFM-H", "Hidden", "MANAGER", A);
  const ADA = await mk("TFM-ADA", "Plainadmin", "ADMIN", A), SUSP = await mk("TFM-SUSP", "Suspended", "MANAGER", A, null, "SUSPENDED");
  const S = await mk("TFM-S", "Sanjayish", "ADMIN", B), F = await mk("TFM-F", "Faizanish", "MANAGER", B), F2 = await mk("TFM-F2", "Faizantwo", "MANAGER", B);
  const HR = await mk("TFM-HR", "Hrp", "HR", A), AD2 = await mk("TFM-AD2", "Otheradmin", "ADMIN", A);
  const E = await mk("TFM-E", "Emp", "EMPLOYEE", A, RM);
  const E2 = await mk("TFM-E2", "Emptwo", "EMPLOYEE", A, RM);        // also reports to RM (RM must still appear ONCE)
  const E3 = await mk("TFM-E3", "Empthree", "EMPLOYEE", A, ADA);      // makes the Admin ADA someone's reporting manager
  const PA = await team("TFM Avatar", A, S);            // company A project run by the Admin S (from company B)
  const PA2 = await team("TFM Delivery", A, M2);        // company A project, E is NOT assigned
  const PX = await team("TFM Closed", A, M2, false);    // inactive: must not be offered
  const PB = await team("TFM Other Co", B, F);          // company B project, E not assigned: must not be offered
  const PBM = await team("TFM Shared B", B, F2);        // company B project E IS assigned to: stays selectable
  await member(PBM, E);
  await team("TFM Twin", A, M2); await team("TFM Twin", B, F);        // same name in two companies: two real projects
  const tok = {};
  for (const [k, c] of Object.entries({ RM: "TFM-RM", M2: "TFM-M2", H: "TFM-H", ADA: "TFM-ADA", S: "TFM-S", F: "TFM-F", F2: "TFM-F2", HR: "TFM-HR", AD2: "TFM-AD2", E: "TFM-E" })) tok[k] = await login(c);
  const snap = async () => JSON.stringify([(await q(`select id,"reportsToId","platformId" from users where "employeeCode" like 'TFM-%' order by id`)), (await q(`select "teamId","userId","isActive" from team_members where "userId" in (select id from users where "employeeCode" like 'TFM-%') order by "teamId","userId"`))]);
  const before = await snap();

  console.log("\n## the two lists");
  const g = await call("GET", "/tasks", tok.E);
  const f = g.b.entryForm ?? {};
  const projects = f.projects ?? [];
  const realProjects = await q(`select t.id, t.name, p.name co from teams t join platforms p on p.id=t."platformId" where t."isActive"`);
  ok("projects = EVERY active project in the records (same ids, any company, whether or not E is on it)", realProjects.length === projects.length && realProjects.every((r) => projects.some((p) => p.id === r.id)), [realProjects.length, projects.length]);
  ok("the employee is on only one of them, yet all are offered", projects.some((p) => p.id === PB) && projects.some((p) => p.id === PA) && projects.some((p) => p.id === PA2));
  ok("an inactive project is not offered", !projects.some((p) => p.id === PX));
  const labels = projects.map((p) => p.label);
  ok("no duplicate entries: every label is unique and every id appears once", new Set(labels).size === labels.length && new Set(projects.map((p) => p.id)).size === projects.length, labels);
  const twins = projects.filter((p) => p.name === "TFM Twin");
  ok("two projects with the same name in different companies stay two real projects, told apart by company", twins.length === 2 && twins[0].id !== twins[1].id && twins.every((t) => t.label.includes("\u00b7")) && !projects.find((p) => p.id === PA).label.includes("\u00b7"), twins);
  const mcodes = (f.managers ?? []).map((m) => m.code);
  const expected = (await q(`select u."employeeCode" c from users u where u.status='ACTIVE' and u.role in ('MANAGER','ADMIN') and u.id <> $1 and (u.id in (select distinct "reportsToId" from users where "reportsToId" is not null and status in ('ACTIVE','INVITED')) or u.id in (select "managerId" from teams where "isActive" and "managerId" is not null) or u.id in (select tg."userId" from team_managers tg join teams t on t.id=tg."teamId" where t."isActive"))`, [E])).map((r) => r.c).sort();
  ok("managers = exactly the active Managers/Admins found in the records as a reporting manager or a project manager (independent SQL)", JSON.stringify([...mcodes].sort()) === JSON.stringify(expected), [mcodes.slice().sort(), expected]);
  ok("each manager appears once even when several people report to them (RM has two reports)", new Set(mcodes).size === mcodes.length && mcodes.filter((c) => c === "TFM-RM").length === 1);
  ok("the expected people are in: RM, M2, S (Admin), F, F2 (other companies), ADA (Admin with a report)", ["TFM-RM", "TFM-M2", "TFM-S", "TFM-F", "TFM-F2", "TFM-ADA"].every((c) => mcodes.includes(c)), mcodes);
  ok("not in: a Manager nobody reports to and who runs no project (H), HR, the suspended manager, an unrelated Admin, the employee", ["TFM-H", "TFM-HR", "TFM-SUSP", "TFM-AD2", "TFM-E"].every((c) => !mcodes.includes(c)), mcodes);
  ok("the list says who is an Admin", (f.managers ?? []).find((m) => m.code === "TFM-S")?.role === "ADMIN");
  ok("nothing is preselected and nothing ties a manager to a project", f.defaultId === undefined && f.byProject === undefined && (f.managers ?? []).every((m) => m.defaultId === undefined));

  console.log("\n## independent choices (any project with any eligible manager)");
  const post = (t, body) => call("POST", "/tasks", t, { weight: "HIGH", progress: "IN_PROGRESS", ...body });
  const row = async (title) => (await q(`select t.id, t."userId", t."teamId", t.weight::text w, t."approvalStatus"::text ap, t."createdAt" cr, d."taggedManagerId" from daily_tasks t left join task_entry_details d on d."taskId"=t.id where t.title=$1`, [title]));
  const t1 = "Avatar tagged M2 " + Date.now(), t2 = "Delivery tagged S " + Date.now(), t3 = "Shared tagged RM " + Date.now();
  const r1 = await post(tok.E, { title: t1, description: "d", teamId: PA, taggedManagerId: M2 });
  const r2 = await post(tok.E, { title: t2, teamId: PA2, taggedManagerId: S });
  const r3 = await post(tok.E, { title: t3, teamId: PBM, taggedManagerId: RM });
  ok("Avatar + a manager who does not run it (M2): accepted", r1.s === 200, r1);
  ok("Delivery + the Admin S: accepted", r2.s === 200, r2);
  ok("a cross-company assigned project + the reporting manager: accepted", r3.s === 200, r3);
  const [a] = await row(t1), [b] = await row(t2), [c] = await row(t3);
  ok("each task saved with ITS project and ITS manager, employee, priority, Pending and a timestamp", a && b && c && a.teamId === PA && a.taggedManagerId === M2 && b.teamId === PA2 && b.taggedManagerId === S && c.teamId === PBM && c.taggedManagerId === RM && [a, b, c].every((x) => x.userId === E && x.w === "HIGH" && x.ap === "PENDING" && x.cr), [a, b, c]);
  await new Promise((z) => setTimeout(z, 900));
  const note = async (u, id) => (await q(`select count(*)::int n from notifications where "userId"=$1 and type='TASK_PROPOSED' and data::text like $2`, [u, "%" + id + "%"]))[0].n;
  ok("each selected manager is notified of THEIR task only", (await note(M2, a.id)) === 1 && (await note(S, b.id)) === 1 && (await note(RM, c.id)) === 1 && (await note(S, a.id)) === 0 && (await note(M2, b.id)) === 0 && (await note(HR, a.id)) === 0 && (await note(AD2, a.id)) === 0);

  console.log("\n## the server validates both choices");
  const bad = async (body) => (await post(tok.E, { title: "x " + Math.random(), ...body })).s;
  ok("no manager chosen -> 400 (nothing is filled in for the employee)", (await bad({ teamId: PA })) === 400);
  ok("no project chosen -> 400", (await bad({ taggedManagerId: M2 })) === 400);
  ok("an inactive project -> 403", (await bad({ teamId: PX, taggedManagerId: M2 })) === 403);
  ok("a Manager nobody reports to who runs no project (H) -> 400", (await bad({ teamId: PA, taggedManagerId: H })) === 400);
  ok("an unrelated Admin, HR, a suspended manager, or the employee themselves -> 400", (await bad({ teamId: PA, taggedManagerId: AD2 })) === 400 && (await bad({ teamId: PA, taggedManagerId: HR })) === 400 && (await bad({ teamId: PA, taggedManagerId: SUSP })) === 400 && (await bad({ teamId: PA, taggedManagerId: E })) === 400);
  ok("nothing was saved by any refused attempt", (await q(`select count(*)::int n from daily_tasks where "userId"=$1`, [E]))[0].n === 3);
  const tx = "Other company project " + Date.now();
  const rx = await post(tok.E, { title: tx, teamId: PB, taggedManagerId: F });
  ok("a project of ANOTHER company the employee is not on, tagged to that company's manager: accepted and saved", rx.s === 200 && (await row(tx))[0]?.teamId === PB && (await row(tx))[0]?.taggedManagerId === F, rx);
  ok("any project with any eligible manager, e.g. a company-B project with a company-A Manager", (await post(tok.E, { title: "Cross pair " + Date.now(), teamId: PB, taggedManagerId: RM })).s === 200);
  await new Promise((z) => setTimeout(z, 600));
  ok("the tagged manager F is notified and can act; the other managers cannot", (await note(F, (await row(tx))[0].id)) === 1);
  ok("Pending: nobody has decided it", (await q(`select "approvalStatus"::text x from daily_tasks where id=$1`, [(await row(tx))[0].id]))[0].x === "PENDING");

  console.log("\n## only the tagged manager can approve or reject");
  const qs = async (tk, id) => { const r = await call("GET", "/tasks/review/queue", tk); return (r.b.all ?? []).find((x) => x.id === id); };
  ok("M2 can act on the Avatar task (tagged to him although he does not run it)", (await qs(tok.M2, a.id))?.canAct === true);
  ok("S (Admin, who runs Avatar) cannot act on the task tagged to M2", ((await qs(tok.S, a.id))?.canAct ?? false) === false);
  ok("the reporting manager (RM) cannot act on tasks tagged to others", ((await qs(tok.RM, a.id))?.canAct ?? false) === false && ((await qs(tok.RM, b.id))?.canAct ?? false) === false);
  ok("HR does not see them while pending; another Admin sees them view-only", (await qs(tok.HR, a.id)) === undefined && (await qs(tok.AD2, a.id))?.canAct === false);
  const act = (tk, id, approve) => call("POST", `/tasks/review/${id}/approve`, tk, approve ? { approve: true } : { approve: false, rejectionNote: "Needs more detail" });
  ok("S, RM, HR and another Admin approving M2's task -> refused", [tok.S, tok.RM, tok.HR, tok.AD2].every(async () => true) && (await act(tok.S, a.id, true)).s === 403 && (await act(tok.RM, a.id, true)).s === 403 && (await act(tok.HR, a.id, true)).s === 403 && (await act(tok.AD2, a.id, true)).s === 403);
  ok("...and rejecting it -> refused", (await act(tok.S, a.id, false)).s === 403 && (await act(tok.RM, a.id, false)).s === 403);
  ok("still Pending after every refusal", (await q(`select "approvalStatus"::text x from daily_tasks where id=$1`, [a.id]))[0].x === "PENDING");
  ok("M2 approves it", (await act(tok.M2, a.id, true)).s === 200 && (await q(`select "approvalStatus"::text x from daily_tasks where id=$1`, [a.id]))[0].x === "APPROVED");
  ok("S (Admin, tagged) rejects HIS task, with a reason", (await act(tok.S, b.id, false)).s === 200 && (await q(`select "approvalStatus"::text x from daily_tasks where id=$1`, [b.id]))[0].x === "REJECTED");
  ok("RM (tagged) approves the cross-company-project task", (await act(tok.RM, c.id, true)).s === 200);

  console.log("\n## later changes never move a submitted task");
  const t4 = "Stays with M2 " + Date.now();
  await post(tok.E, { title: t4, teamId: PA, taggedManagerId: M2 });
  const d = (await row(t4))[0];
  await q(`update teams set "managerId"=$1 where id=$2`, [F2, PA]);                       // the project gets a new manager
  await q(`update users set "reportsToId"=$1 where id=$2`, [M2, E]);                      // and the reporting line changes
  ok("the saved approver is unchanged after the project manager and the reporting line change", (await row(t4))[0].taggedManagerId === M2);
  await q(`update users set "reportsToId"=$1 where id=$2`, [RM, E]);
  const mv = await call("PATCH", `/tasks/${d.id}`, tok.E, { teamId: PA2 });
  ok("editing the project of a waiting task does not change the manager (independent)", mv.s === 200 && (await row(t4))[0].teamId === PA2 && (await row(t4))[0].taggedManagerId === M2, mv);
  ok("the form still shows no preselected manager", (await call("GET", "/tasks", tok.E)).b.entryForm.defaultId === undefined);

  console.log("\n## nothing else changed");
  ok("no reporting line, company or project membership changed", (await snap()) === before);
  ok("E was not assigned to any project by tagging or selecting one", (await q(`select count(*)::int n from team_members where "userId"=$1 and "teamId" = any($2)`, [E, [PA, PA2, PB]]))[0].n === 0);

  await wipe();
  console.log(`\n${pass} passed, ${fail} failed`);
  await db.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("CRASH", e); process.exit(1); });
