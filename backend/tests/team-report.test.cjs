// GET /api/team-attendance/team-report: completeness, accuracy against the database, scope, permissions and range rules.
// Writes data: run ONLY against a throwaway database (the seed refuses anything but the local one on port 54329) with the backend on :5012.
const { Client } = require("pg");
const { seed } = require("./_team-report-seed.cjs");
const API = process.env.API ?? "http://localhost:5012/api";
const DB = "postgresql://postgres:localtest@127.0.0.1:54329/hrms_test";
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (!c && x !== undefined ? "  -> " + JSON.stringify(x).slice(0, 400) : "")); };
const call = async (p, t) => { const r = await fetch(API + p, { headers: t ? { authorization: "Bearer " + t } : {} }); const txt = await r.text(); let j; try { j = JSON.parse(txt); } catch { j = txt; } return { s: r.status, b: j }; };
const login = async (code, pw) => (await (await fetch(API + "/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: code, password: pw }) })).json()).token;
const addDays = (iso, n) => new Date(Date.parse(iso + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);

(async () => {
  const db = new Client({ connectionString: DB }); await db.connect();
  const S = await seed(db);
  const { ravi, sana, tina, olga, mgr, mgr2 } = S.ids;
  const tM = await login("E2E-MGR", S.pw), tM2 = await login("TR-M2", S.pw), tE = await login("E2E-EMP1", S.pw), tHr = await login("E2E-HR", S.pw), tA = await login("E2E-ADM", S.pw);
  const from = S.days[0], to = S.today;
  const rep = await call(`/team-attendance/team-report?from=${from}&to=${to}`, tM);
  ok("a manager gets the report (200)", rep.s === 200, rep);
  const r = rep.b;

  // ---- who ----
  const ids = r.people.map((p) => p.id);
  ok("the people are exactly the manager's team (Ravi, Sana, Tina), nobody else", ids.length === 3 && [ravi, sana, tina].every((x) => ids.includes(x)), r.people.map((p) => p.name));
  ok("another manager's employee (Olga) and the manager themselves are not included", !ids.includes(olga) && !ids.includes(mgr));
  ok("each person carries name, ID, designation, reporting manager", r.people.every((p) => p.name && p.employeeCode && p.designation && p.reportingManager === "Meera Manager"), r.people);
  ok("the period and day count are echoed", r.from === from && r.to === to && r.days === 15, [r.from, r.to, r.days]);
  const inScope = (rows) => rows.every((x) => ids.includes(x.userId));
  ok("every section holds only people of the team", [r.attendance, r.tasks, r.breaks, r.meetings, r.leave, r.leaveDays, r.corrections, r.liveMeetings].every(inScope));
  ok("nothing mentions Olga anywhere in the answer", !JSON.stringify(r).includes("Otherteam") && !JSON.stringify(r).includes(olga));

  // ---- attendance ----
  const key = (x) => `${x.userId}|${x.date}`;
  ok("no duplicate attendance rows", new Set(r.attendance.map(key)).size === r.attendance.length);
  const worked = (id) => r.attendance.filter((x) => x.userId === id && x.loginAt);
  ok("Ravi: one attendance row with a login per stored session", worked(ravi).length === S.expect.sessions.ravi, worked(ravi).length);
  ok("Sana: only the days she worked have a login", worked(sana).length === S.expect.sessions.sana, worked(sana).length);
  ok("Tina has no attendance record and is still in the report", worked(tina).length === 0 && ids.includes(tina));
  ok("days without a record are still rows (every day of the period appears for each person up to today)", [ravi, sana, tina].every((id) => r.attendance.filter((x) => x.userId === id).length >= 13), [ravi, sana, tina].map((id) => r.attendance.filter((x) => x.userId === id).length));
  const rav = worked(ravi)[0];
  ok("a working day carries login, logout, working, productive and break hours", rav.loginAt && rav.logoutAt && rav.workedHours === 7.5 && rav.productiveHours === 7.5 && rav.breakHours > 0, rav);
  const lateRow = r.attendance.find((x) => x.userId === ravi && x.date === S.expect.lateDay);
  ok("the late day carries the late remark the employee typed", lateRow && /Bus was late/.test(lateRow.lateReason ?? ""), lateRow);
  // identical to the Attendance report the manager already uses
  const att = await call(`/team-attendance/attendance?from=${from}&to=${to}`, tM);
  ok("the attendance rows equal the existing Attendance report (same count, same hours)", att.s === 200 && att.b.rows.length === r.attendance.length && Math.abs(att.b.rows.reduce((n, x) => n + (x.workedHours ?? 0), 0) - r.attendance.reduce((n, x) => n + (x.workedHours ?? 0), 0)) < 1e-9, [att.b.rows?.length, r.attendance.length]);

  // ---- breaks, straight from the table ----
  const rawBreaks = (await db.query(`select s."userId", count(*)::int n from tracker_breaks b join work_sessions s on s.id=b."workSessionId" where s."userId" = any($1::uuid[]) and s.date between $2 and $3 group by 1`, [[ravi, sana, tina, olga], from, to])).rows;
  const rawN = (id) => rawBreaks.find((x) => x.userId === id)?.n ?? 0;
  ok("every break row of the team is present: Ravi, Sana, none for Tina (counts equal the table)", r.breaks.filter((b) => b.userId === ravi).length === rawN(ravi) && r.breaks.filter((b) => b.userId === sana).length === rawN(sana) && r.breaks.filter((b) => b.userId === tina).length === 0, [rawN(ravi), rawN(sana)]);
  const tea = r.breaks.find((b) => b.type === "TEA");
  const wash = r.breaks.find((b) => b.type === "WASHROOM");
  ok("tea is a Break (counts as break) with start, end and 10 minutes; washroom is not a break", tea.category === "Break" && tea.countsAsBreak && tea.seconds === 600 && tea.startedAt && tea.endedAt && wash.category.startsWith("Washroom") && wash.countsAsBreak === false, [tea, wash]);
  ok("break rows are unique", new Set(r.breaks.map((b) => `${b.userId}|${b.startedAt}|${b.type}`)).size === r.breaks.length);

  // ---- tasks ----
  const tk = (id) => r.tasks.filter((x) => x.userId === id);
  ok("every task is present: Ravi 4, Sana 1, Tina 0", tk(ravi).length === 4 && tk(sana).length === 1 && tk(tina).length === 0, [tk(ravi).length, tk(sana).length]);
  const rated = tk(ravi).find((x) => x.title === "Prepare monthly report");
  ok("a rated task carries the stars and the manager's feedback, project, progress and approval", rated.rating === 5 && rated.ratingComment === "Excellent and on time" && rated.project === "E2E Team" && rated.progress === "COMPLETED" && rated.approvalStatus === "APPROVED" && rated.completionNote === "Done, sent to Meera", rated);
  ok("pending and rejected tasks are there too (rejected keeps its reason)", tk(ravi).some((x) => x.approvalStatus === "PENDING") && tk(ravi).find((x) => x.approvalStatus === "REJECTED")?.rejectionNote === "Please do this next quarter");
  ok("an unrated task has no rating (never shown as five stars)", tk(sana)[0].rating === null);
  ok("no duplicate tasks", new Set(r.tasks.map((x) => x.id)).size === r.tasks.length);
  const pt = await call(`/team-attendance/productivity/tasks?from=${from}&to=${to}`, tM);
  ok("the task rows equal the existing Task productivity export (same tasks) and it now also carries ratings", pt.s === 200 && pt.b.tasks.length === r.tasks.length && pt.b.tasks.find((x) => x.title === "Prepare monthly report")?.rating === 5, [pt.b.tasks?.length, r.tasks.length]);

  // ---- meetings ----
  const mt = (id) => r.meetings.filter((x) => x.userId === id);
  ok("meeting rows: Ravi 2, Sana 1, Tina 2 (invited, joined nothing), one row per person per meeting", mt(ravi).length === S.expect.meetingRows.ravi && mt(sana).length === S.expect.meetingRows.sana && mt(tina).length === S.expect.meetingRows.tina && new Set(r.meetings.map((x) => `${x.meetingId}|${x.userId}`)).size === r.meetings.length, [mt(ravi).length, mt(sana).length, mt(tina).length]);
  const hud = mt(ravi).find((x) => x.title === "TR Daily stand-up");
  ok("a Team Huddle shows its type, schedule, actual join/leave and the duration (12 minutes)", hud.kind === "Team Huddle" && hud.scheduledSeconds === 900 && hud.status === "Joined" && hud.participationSeconds === 720 && hud.joinedAt && hud.leftAt, hud);
  ok("someone invited who never joined a Team Huddle is 'Not joined' with no duration", mt(tina).find((x) => x.title === "TR Daily stand-up").status === "Not joined" && mt(tina).find((x) => x.title === "TR Daily stand-up").participationSeconds === null);
  ok("an ordinary past meeting with no recorded join is not presumed attended", mt(ravi).find((x) => x.title === "TR Quarterly planning").status === "Did not record joining" && mt(ravi).find((x) => x.title === "TR Quarterly planning").kind === "Meeting");

  // ---- leave and corrections ----
  const lv = r.leave.filter((x) => x.userId === ravi);
  ok("Ravi's leave: approved, pending and rejected requests are all there with type, dates and days", lv.length === 3 && ["APPROVED", "PENDING", "REJECTED"].every((s) => lv.some((x) => x.status === s)) && lv.find((x) => x.status === "APPROVED").dayCount === 2 && lv.find((x) => x.status === "APPROVED").leaveType === "CASUAL", lv);
  ok("leave days taken (approved) are listed: 2 for Ravi, none for Sana or Tina", r.leaveDays.filter((x) => x.userId === ravi).length === 2 && !r.leaveDays.some((x) => x.userId !== ravi));
  ok("the correction request is there with its status and reviewer", r.corrections.length === 1 && r.corrections[0].userId === sana && r.corrections[0].status === "APPROVED" && r.corrections[0].reviewedBy === "Asha Admin", r.corrections);

  // ---- scope and permissions ----
  const other = await call(`/team-attendance/team-report?from=${from}&to=${to}`, tM2);
  ok("another manager receives only their own employee", other.s === 200 && other.b.people.length === 1 && other.b.people[0].id === olga && !JSON.stringify(other.b).includes("Ravi") && !JSON.stringify(other.b).includes("Sana"), other.b.people);
  ok("an employee is refused (403)", (await call(`/team-attendance/team-report?from=${from}&to=${to}`, tE)).s === 403);
  ok("no token is refused (401)", (await call(`/team-attendance/team-report?from=${from}&to=${to}`)).s === 401);
  const hr = await call(`/team-attendance/team-report?from=${from}&to=${to}`, tHr);
  const ad = await call(`/team-attendance/team-report?from=${from}&to=${to}`, tA);
  ok("HR and Admin keep their organization reach (they include the manager's team and the other team)", hr.s === 200 && ad.s === 200 && [ravi, olga].every((x) => hr.b.people.some((p) => p.id === x)) && [ravi, olga].every((x) => ad.b.people.some((p) => p.id === x)), [hr.b.people?.length, ad.b.people?.length]);
  const narrowed = await call(`/team-attendance/team-report?from=${from}&to=${to}&q=Ravi`, tM);
  ok("the shared filters narrow the report (search 'Ravi' gives only Ravi)", narrowed.b.people.length === 1 && narrowed.b.people[0].id === ravi && narrowed.b.attendance.every((x) => x.userId === ravi));
  const wide = await call(`/team-attendance/team-report?from=${from}&to=${to}&userId=${olga}`, tM);
  ok("asking for someone outside the team (even by id) gives nothing extra", wide.s !== 500 && !JSON.stringify(wide.b).includes(olga));

  // ---- the range ----
  ok("end before start is refused (400)", (await call(`/team-attendance/team-report?from=${to}&to=${from}`, tM)).s === 400);
  ok("more than 93 days is refused (400)", (await call(`/team-attendance/team-report?from=${addDays(to, -100)}&to=${to}`, tM)).s === 400);
  ok("a bad date is refused (400), never a 500", (await call(`/team-attendance/team-report?from=2026-13-45&to=${to}`, tM)).s === 400);
  const fut = await call(`/team-attendance/team-report?from=${from}&to=${addDays(to, 6)}`, tM);
  ok("an end date in the future is cut at today (nothing exists for days that have not happened)", fut.s === 200 && fut.b.attendance.every((x) => x.date <= to), fut.s);
  const one = await call(`/team-attendance/team-report?from=${S.days[5]}&to=${S.days[5]}`, tM);
  ok("a single day works and holds only that day", one.s === 200 && one.b.days === 1 && one.b.attendance.every((x) => x.date === S.days[5]) && one.b.meetings.every((m) => m.scheduledStart.slice(0, 10) >= addDays(S.days[5], -1)), one.s);
  const empty = await call(`/team-attendance/team-report?from=${to}&to=${to}&q=zzzzzz`, tM);
  ok("a selection with nobody gives an empty report, not an error", empty.s === 200 && empty.b.people.length === 0);

  await db.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
