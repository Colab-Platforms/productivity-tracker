import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { DEMO_CODE, DEMO_EMAIL_DOMAIN, demoId, type DemoRole } from "../../lib/demo.js";

// ---------------------------------------------------------------------------
// THE FICTIONAL COMPANY. Every name, number, document and message below is invented. Nothing here is read from, or copied from, a real database: the seed
// only ever WRITES to the database it is connected to, and refuses to run anywhere that is not a marked (or empty, *demo*-named) demo database.
// ids are deterministic (demoId), so "Reset demo data" keeps a tester's sign-in valid. Times are relative to the moment of seeding (IST company day).
// ---------------------------------------------------------------------------

type V = string | number | boolean | null | Date | Buffer | { raw: string };
const q = (c: string) => '"' + c.replace(/"/g, "") + '"';

async function ins(table: string, row: Record<string, V>) {
  const cols = Object.keys(row);
  const params: unknown[] = [];
  const ph = cols.map((c) => {
    const v = row[c];
    if (v && typeof v === "object" && !(v instanceof Date) && !Buffer.isBuffer(v) && "raw" in v) return v.raw;
    params.push(v instanceof Date ? ts(v) : v);
    return "$" + params.length;
  });
  await prisma.$executeRawUnsafe(`insert into ${q(table)} (${cols.map(q).join(",")}) values (${ph.join(",")})`, ...params);
}
const ts = (d: Date) => d.toISOString().replace("T", " ").slice(0, 19); // UTC text: the driver would shift a Date by the machine's zone
const arr = (ids: string[]) => ({ raw: `ARRAY[${ids.map((i) => `'${i}'`).join(",")}]::uuid[]` });
const json = (o: unknown) => ({ raw: `'${JSON.stringify(o).replace(/'/g, "''")}'::jsonb` });

const IST = 5.5 * 3600_000;
const istDay = (offset: number) => new Date(Date.now() + IST - offset * 86400_000).toISOString().slice(0, 10); // company date, `offset` days ago
const at = (day: string, hhmm: string) => { const [h, m] = hhmm.split(":").map(Number); return new Date(Date.parse(day + "T00:00:00Z") + (h * 60 + m) * 60_000 - IST); };
const dow = (day: string) => new Date(day + "T00:00:00Z").getUTCDay(); // 0 = Sunday
const minsAgo = (m: number) => new Date(Date.now() - m * 60_000);
const hoursAhead = (h: number) => new Date(Date.now() + h * 3600_000);

const DEMO_DOMAIN = DEMO_EMAIL_DOMAIN;
const P1 = demoId("platform:avatar-demo"), P2 = demoId("platform:demo-labs");

type Person = { key: string; code: string; first: string; last: string; role: DemoRole; platform: string; boss?: string; designation: string; salary: number; team?: string };
const PEOPLE: Person[] = [
  { key: "admin", code: DEMO_CODE.ADMIN, first: "Aarav", last: "Admin (Demo)", role: "ADMIN", platform: P1, designation: "Business Head", salary: 0 },
  { key: "hr", code: DEMO_CODE.HR, first: "Hema", last: "HR (Demo)", role: "HR", platform: P1, designation: "HR Generalist", salary: 62000 },
  { key: "mgr", code: DEMO_CODE.MANAGER, first: "Manav", last: "Manager (Demo)", role: "MANAGER", platform: P1, boss: "admin", designation: "Team Lead", salary: 95000, team: "cs" },
  { key: "mgr2", code: "DEMO-MGR2", first: "Meera", last: "Manager (Demo)", role: "MANAGER", platform: P1, boss: "admin", designation: "Operations Manager", salary: 92000, team: "ops" },
  { key: "emp", code: DEMO_CODE.EMPLOYEE, first: "Esha", last: "Employee (Demo)", role: "EMPLOYEE", platform: P1, boss: "mgr", designation: "Customer Success Executive", salary: 38000, team: "cs" },
  { key: "e1", code: "DEMO-E01", first: "Rohan", last: "Sample", role: "EMPLOYEE", platform: P1, boss: "mgr", designation: "Support Executive", salary: 36000, team: "cs" },
  { key: "e2", code: "DEMO-E02", first: "Isha", last: "Sample", role: "EMPLOYEE", platform: P1, boss: "mgr", designation: "Support Executive", salary: 35000, team: "cs" },
  { key: "e3", code: "DEMO-E03", first: "Kabir", last: "Sample", role: "EMPLOYEE", platform: P1, boss: "mgr", designation: "Account Executive", salary: 41000, team: "cs" },
  { key: "e4", code: "DEMO-E04", first: "Tara", last: "Sample", role: "EMPLOYEE", platform: P1, boss: "mgr", designation: "Account Executive", salary: 40000, team: "cs" },
  { key: "e5", code: "DEMO-E05", first: "Vivaan", last: "Sample", role: "EMPLOYEE", platform: P1, boss: "mgr2", designation: "Operations Analyst", salary: 44000, team: "ops" },
  { key: "e6", code: "DEMO-E06", first: "Anaya", last: "Sample", role: "EMPLOYEE", platform: P1, boss: "mgr2", designation: "Operations Analyst", salary: 43000, team: "ops" },
  { key: "e7", code: "DEMO-E07", first: "Dev", last: "Sample", role: "EMPLOYEE", platform: P1, boss: "mgr2", designation: "Logistics Coordinator", salary: 39000, team: "ops" },
  { key: "lm", code: "DEMO-L01", first: "Leela", last: "Labs Manager (Demo)", role: "MANAGER", platform: P2, boss: "admin", designation: "Labs Manager", salary: 90000, team: "labs" },
  { key: "le", code: "DEMO-L02", first: "Neel", last: "Labs Sample", role: "EMPLOYEE", platform: P2, boss: "lm", designation: "Research Associate", salary: 42000, team: "labs" },
];
const U = (k: string) => demoId("user:" + (PEOPLE.find((p) => p.key === k)!.code));
const TEAM = { cs: demoId("team:cs"), ops: demoId("team:ops"), labs: demoId("team:labs") };
const SHIFT1 = demoId("shift:general"), SHIFT2 = demoId("shift:labs");

const TASKS = ["Follow up with onboarding customers", "Update the weekly status sheet", "Resolve open support tickets", "Prepare the monthly review deck", "Call back pending accounts", "Reconcile order exceptions", "Audit vendor delivery notes", "Draft the process document", "Review the shared inbox", "Test the new intake form", "Clean up the contact list", "Plan next week's schedule"];

// ---- safety --------------------------------------------------------------------------------------------------------------------------------
/** The seed may only write to a demo database. Throws (writes nothing) otherwise. */
export async function assertSeedAllowed(dbName: string): Promise<void> {
  // 1) A database holding ANY user that is not a demo user is never touched, marker or not: this is the rule that protects real data.
  const hasUsers = await prisma.$queryRaw<{ t: string | null }[]>`select to_regclass('users')::text t`;
  if (hasUsers[0]?.t) {
    const real = await prisma.$queryRaw<{ n: number }[]>`select count(*)::int n from users where "employeeCode" is null or "employeeCode" not like 'DEMO-%'`;
    if ((real[0]?.n ?? 0) > 0) throw new Error("REFUSED: this database holds users that are not demo users. The demo seed never touches a database with real data.");
  }
  // 2) It must be one we made before (our exact marker row), or a new database with "demo" in its name.
  const m = await prisma.$queryRaw<{ t: string | null }[]>`select to_regclass('demo_marker')::text t`;
  if (m[0]?.t) {
    const row = await prisma.$queryRaw<{ n: number }[]>`select count(*)::int n from demo_marker where note like 'Avatar HRMS demo database%'`;
    if ((row[0]?.n ?? 0) > 0) return;
  }
  if (!/demo/i.test(dbName)) throw new Error("REFUSED: this is not a marked demo database, and a new demo database must have 'demo' in its name.");
}

async function wipe() {
  const tables = (await prisma.$queryRaw<{ t: string }[]>`select table_name t from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' and table_name not in ('_prisma_migrations','demo_marker')`).map((r) => r.t);
  // the history tables have triggers that refuse deletes; they are switched off ONLY for this wipe of the demo database and switched back on
  for (const t of tables) await prisma.$executeRawUnsafe(`alter table ${q(t)} disable trigger user`);
  try {
    await prisma.$executeRawUnsafe(`truncate table ${tables.map(q).join(", ")} restart identity cascade`);
  } finally {
    for (const t of tables) await prisma.$executeRawUnsafe(`alter table ${q(t)} enable trigger user`);
  }
}

export async function seedDemo(dbName: string): Promise<{ users: number }> {
  // THE SAFETY CHECK COMES FIRST, before anything is created or written: a database that is not already marked as a demo database (or an empty one named
  // *demo*) is refused untouched. (The marker table is only created AFTER this passes; creating it first would make every database look like a demo one.)
  await assertSeedAllowed(dbName);
  await prisma.$executeRawUnsafe(`create table if not exists demo_marker (id int primary key default 1, "createdAt" timestamp not null default now(), note text)`);
  await prisma.$executeRawUnsafe(`alter table users add column if not exists "monthlySalary" numeric(10,2)`).catch(() => {});
  await wipe();
  await prisma.$executeRawUnsafe(`insert into demo_marker (id, note) values (1, 'Avatar HRMS demo database: every record is fictional') on conflict (id) do update set "createdAt" = now()`);

  // ---- companies, shifts -----------------------------------------------------------------------------------------------------------------
  await ins("platforms", { id: P1, name: "Avatar Demo Co (fictional)", slug: "demo-avatar", updatedAt: new Date() });
  await ins("platforms", { id: P2, name: "Demo Labs (fictional)", slug: "demo-labs", updatedAt: new Date() });
  await ins("shifts", { id: SHIFT1, platformId: P1, name: "General (9:30 - 18:30)", startTime: "09:30", endTime: "18:30", isDefault: true, updatedAt: new Date() });
  await ins("shifts", { id: SHIFT2, platformId: P2, name: "Labs (10:00 - 19:00)", startTime: "10:00", endTime: "19:00", isDefault: true, updatedAt: new Date() });

  // ---- people (their passwords are random and never shown: they are reached only through the demo login and the role switcher) ---------
  const nopass = await bcrypt.hash(randomBytes(24).toString("hex"), 10);
  for (const p of PEOPLE) {
    await ins("users", {
      id: U(p.key), platformId: p.platform, employeeCode: p.code, email: `${p.code.toLowerCase()}@${DEMO_DOMAIN}`, passwordHash: nopass,
      firstName: p.first, lastName: p.last, role: p.role, status: "ACTIVE", designation: p.designation, monthlySalary: p.salary || null,
      dateOfJoining: istDay(400 + PEOPLE.indexOf(p) * 20), mustChangePassword: false, trackerAccessEnabled: true, onboardingStatus: "ACTIVE",
      reportsToId: p.boss ? U(p.boss) : null, shiftId: p.platform === P1 ? SHIFT1 : SHIFT2, updatedAt: new Date(),
    });
  }
  await ins("company_access", { id: demoId("access:admin"), userId: U("admin"), platformId: null });
  await ins("company_access", { id: demoId("access:hr"), userId: U("hr"), platformId: P2 });
  for (const p of PEOPLE) if (p.role !== "ADMIN") await ins("employee_profiles", { userId: U(p.key), employmentType: p.key.startsWith("e") ? "PERMANENT" : "PERMANENT", updatedAt: new Date() });

  // ---- teams / projects ------------------------------------------------------------------------------------------------------------------
  const teams: [string, string, string, string][] = [[TEAM.cs, "Customer Success", "mgr", P1], [TEAM.ops, "Product Operations", "mgr2", P1], [TEAM.labs, "Demo Labs Research", "lm", P2]];
  for (const [id, name, mgr, plat] of teams) {
    await ins("teams", { id, platformId: plat, name, managerId: U(mgr), shiftId: plat === P1 ? SHIFT1 : SHIFT2, updatedAt: new Date() });
    await ins("team_configs", { id: demoId("cfg:" + id), teamId: id, dailyWorkHours: 9, productiveHours: 8, breakBudgetMinutes: 60, updatedAt: new Date() });
  }
  for (const p of PEOPLE.filter((x) => x.team)) await ins("team_members", { id: demoId("tm:" + p.code), teamId: TEAM[p.team as keyof typeof TEAM], userId: U(p.key), isPrimary: true });

  // ---- holidays ---------------------------------------------------------------------------------------------------------------------------
  for (const [i, [off, name]] of ([[-12, "Founders' Day (demo)"], [9, "Demo Festival of Lights"], [24, "Demo Republic Day"]] as [number, string][]).entries()) {
    for (const plat of [P1, P2]) await ins("holidays", { id: demoId(`hol:${plat}:${i}`), platformId: plat, date: istDay(off), name, dayType: "PUBLIC_HOLIDAY" });
  }

  // ---- attendance and breaks: 20 working days of history + a live "today" ---------------------------------------------------------------
  const trackedKeys = PEOPLE.filter((p) => p.role !== "ADMIN").map((p) => p.key);
  let n = 0;
  const rnd = (seed: string, lo: number, hi: number) => { let h = 0; for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0; return lo + (h % (hi - lo + 1)); };
  for (const key of trackedKeys) {
    const person = PEOPLE.find((p) => p.key === key)!;
    for (let d = 1; d <= 24; d++) {
      const day = istDay(d);
      if (dow(day) === 0 || dow(day) === 6) continue;
      if (d === 12) continue; // the demo public holiday
      if (key === "emp" && (d === 9 || d === 10)) continue; // the demo employee's approved leave
      const startMin = person.platform === P1 ? 9 * 60 + 30 : 10 * 60;
      const lateBy = key === "e4" && d % 4 === 0 ? 38 : rnd(key + day, -6, 14);
      const login = at(day, "00:00"); login.setTime(login.getTime() + (startMin + lateBy) * 60_000);
      const workMin = rnd(key + day + "w", 505, 555);
      const logout = new Date(login.getTime() + workMin * 60_000);
      const lunch = rnd(key + day + "l", 40, 58) + (key === "e2" && d % 5 === 0 ? 40 : 0); // a few days over the Break Time
      const extra = rnd(key + day + "p", 0, 10) > 6 ? rnd(key + day + "q", 8, 15) : 0;
      const breakSeconds = (lunch + extra) * 60;
      const wid = demoId(`ws:${key}:${day}`);
      const late = lateBy > 15;
      await ins("work_sessions", { id: wid, platformId: person.platform, userId: U(key), date: day, loginAt: login, logoutAt: logout, status: "COMPLETED", productiveSeconds: workMin * 60 - breakSeconds, breakSeconds, meetingSeconds: 0, shiftStartTime: person.platform === P1 ? "09:30" : "10:00", wasLateLogin: late, lateByMinutes: late ? lateBy - 15 : 0, teamId: person.team ? TEAM[person.team as keyof typeof TEAM] : null, updatedAt: new Date() });
      const ls = new Date(login.getTime() + 210 * 60_000);
      await ins("tracker_breaks", { id: demoId(`br:${wid}:l`), workSessionId: wid, breakType: "LUNCH", startedAt: ls, endedAt: new Date(ls.getTime() + lunch * 60_000), durationSeconds: lunch * 60 });
      if (extra) { const ps = new Date(login.getTime() + 380 * 60_000); await ins("tracker_breaks", { id: demoId(`br:${wid}:p`), workSessionId: wid, breakType: "PERSONAL", startedAt: ps, endedAt: new Date(ps.getTime() + extra * 60_000), durationSeconds: extra * 60 }); }
      n++;
    }
  }
  // today: the demo employee is NOT clocked in (so the tester can clock in and start/end breaks); others are mid-day
  const today = istDay(0);
  const todaySessions: [string, number, "none" | "break" | "late"][] = [["mgr", 40, "none"], ["e1", 25, "none"], ["e2", 30, "none"], ["e3", 85, "break"], ["e4", 60, "late"], ["e5", 20, "none"], ["hr", 35, "none"]];
  for (const [key, ago, mode] of todaySessions) {
    const person = PEOPLE.find((p) => p.key === key)!;
    const wid = demoId(`ws:${key}:${today}`);
    await ins("work_sessions", { id: wid, platformId: person.platform, userId: U(key), date: today, loginAt: minsAgo(ago + 120), status: "ACTIVE", productiveSeconds: 0, breakSeconds: mode === "break" ? 1200 : 0, meetingSeconds: 0, shiftStartTime: "09:30", wasLateLogin: mode === "late", lateByMinutes: mode === "late" ? 32 : 0, teamId: person.team ? TEAM[person.team as keyof typeof TEAM] : null, updatedAt: new Date() });
    if (mode === "break") await ins("tracker_breaks", { id: demoId(`br:${wid}:open`), workSessionId: wid, breakType: "LUNCH", startedAt: minsAgo(20) });
    if (mode === "late") await ins("alerts", { id: demoId(`al:${key}:late`), platformId: P1, userId: U(key), alertType: "LATE_LOGIN", severity: "WARNING", date: today, message: "Late login: 32 minutes after shift start" });
  }
  await ins("alerts", { id: demoId("al:e2:break"), platformId: P1, userId: U("e2"), alertType: "BREAK_OVERAGE", severity: "WARNING", date: istDay(5), message: "Break Time exceeded by 38 minutes" });

  // ---- tasks: history with manager ratings, plus today's work and proposals waiting for approval -----------------------------------------
  const empKeys = ["emp", "e1", "e2", "e3", "e4", "e5", "e6", "e7"];
  const bossOf = (k: string) => PEOPLE.find((p) => p.key === k)!.boss!;
  let tn = 0;
  for (const key of empKeys) {
    for (let d = 1; d <= 14; d++) {
      const day = istDay(d);
      if (dow(day) === 0 || dow(day) === 6 || d === 12) continue;
      for (let k = 0; k < 3; k++) {
        const id = demoId(`task:${key}:${day}:${k}`);
        const done = rnd(key + day + k, 0, 9) > 1; // most are finished, a few were left open
        await ins("daily_tasks", { id, platformId: P1, userId: U(key), teamId: TEAM[PEOPLE.find((p) => p.key === key)!.team as keyof typeof TEAM], date: day, title: TASKS[(tn++ + k) % TASKS.length], description: "Fictional demo task.", weight: ["LOW", "MEDIUM", "HIGH"][k % 3], status: done ? "COMPLETED" : "IN_PROGRESS", approvalStatus: "APPROVED", approvedById: U(bossOf(key)), approvedAt: at(day, "09:50"), outcome: done ? "COMPLETED" : null, completedAt: done ? at(day, "17:00") : null, updatedAt: new Date() });
        await ins("task_entry_details", { id: demoId("ted:" + id), platformId: P1, taskId: id, hoursSpent: 1 + (k % 3), taggedManagerId: U(bossOf(key)), blocked: false });
        if (done && rnd(key + day + k + "r", 0, 9) > 2) await ins("task_ratings", { taskId: id, platformId: P1, ratedById: U(bossOf(key)), rating: rnd(key + day + k + "s", 3, 5), comment: ["Good work", "Delivered on time", "Needs a little more detail", "Excellent follow-through"][rnd(key + day + k, 0, 3)], updatedAt: new Date() });
      }
    }
  }
  // today
  const todayTasks: [string, string, "APPROVED_PROGRESS" | "APPROVED_TODO" | "PROPOSED"][] = [
    ["emp", "Reply to the pending customer emails", "APPROVED_PROGRESS"], ["emp", "Prepare the weekly summary", "APPROVED_TODO"], ["emp", "Update the onboarding checklist", "PROPOSED"],
    ["e1", "Resolve the top five support tickets", "PROPOSED"], ["e2", "Call back the accounts on the list", "PROPOSED"], ["e3", "Draft the renewal proposal", "APPROVED_PROGRESS"], ["e4", "Review the invoice mismatches", "PROPOSED"],
    ["e5", "Reconcile yesterday's order exceptions", "APPROVED_PROGRESS"], ["e6", "Audit the vendor delivery notes", "PROPOSED"],
  ];
  for (const [i, [key, title, mode]] of todayTasks.entries()) {
    const id = demoId(`task:today:${key}:${i}`);
    const approved = mode !== "PROPOSED";
    await ins("daily_tasks", { id, platformId: P1, userId: U(key), teamId: TEAM[PEOPLE.find((p) => p.key === key)!.team as keyof typeof TEAM], date: today, title, description: "Fictional demo task.", weight: "MEDIUM", status: mode === "APPROVED_PROGRESS" ? "IN_PROGRESS" : "PENDING", approvalStatus: approved ? "APPROVED" : "PENDING", approvedById: approved ? U(bossOf(key)) : null, approvedAt: approved ? minsAgo(100) : null, updatedAt: new Date() });
    await ins("task_entry_details", { id: demoId("ted:" + id), platformId: P1, taskId: id, hoursSpent: 2, taggedManagerId: U(bossOf(key)), blocked: false });
  }
  await prisma.$executeRawUnsafe(`update task_work_sessions set "startedAt" = now() - interval '47 minutes' where "taskId" in (select id from daily_tasks where date = $1::date and status = 'IN_PROGRESS')`, today).catch(() => {});

  // ---- leave (pending, manager-approved awaiting HR, approved, rejected) ------------------------------------------------------------------
  type L = { key: string; from: number; to: number; type: string; days: number; status: string; stage: "MGR_PENDING" | "HR_PENDING" | "DONE"; reason: string; half?: boolean; note?: string };
  const LEAVES: L[] = [
    { key: "emp", from: 9, to: 10, type: "CASUAL", days: 2, status: "APPROVED", stage: "DONE", reason: "Family function (demo)" },
    { key: "emp", from: -7, to: -7, type: "SICK", days: 1, status: "PENDING", stage: "MGR_PENDING", reason: "Medical appointment (demo)" },
    { key: "e1", from: -5, to: -4, type: "CASUAL", days: 2, status: "PENDING", stage: "MGR_PENDING", reason: "Short trip (demo)" },
    { key: "e2", from: -3, to: -3, type: "CASUAL", days: 0.5, status: "PENDING", stage: "MGR_PENDING", reason: "Bank work (demo)", half: true },
    { key: "e3", from: -10, to: -11, type: "EARNED", days: 2, status: "PENDING", stage: "HR_PENDING", reason: "Wedding in the family (demo)" },
    { key: "e5", from: 6, to: 6, type: "CASUAL", days: 1, status: "REJECTED", stage: "DONE", reason: "Personal work (demo)", note: "Month-end closing: please pick another date." },
    { key: "mgr", from: -14, to: -15, type: "EARNED", days: 2, status: "PENDING", stage: "MGR_PENDING", reason: "Vacation (demo)" },
  ];
  for (const [i, l] of LEAVES.entries()) {
    const id = demoId("leave:" + i);
    const from = istDay(l.from), to = istDay(l.to);
    const [fd, td] = from <= to ? [from, to] : [to, from];
    await ins("leave_requests", { id, platformId: P1, userId: U(l.key), fromDate: fd, toDate: td, leaveType: l.type, isHalfDay: !!l.half, isFirstHalf: !!l.half, dayCount: l.days, reason: l.reason, status: l.status, decidedById: l.status === "APPROVED" || l.status === "REJECTED" ? U("hr") : null, decidedAt: l.status === "APPROVED" || l.status === "REJECTED" ? minsAgo(60 * 24 * 3) : null, decisionNote: l.note ?? null, updatedAt: new Date() });
    const approver = l.key === "mgr" ? U("admin") : U(bossOf(l.key));
    const person = PEOPLE.find((p) => p.key === l.key)!;
    await ins("leave_approval_events", { id: demoId("lae:" + i + ":s"), platformId: P1, requestId: id, actorName: `${person.first} ${person.last}`, actorRole: person.role, step: "REQUEST", action: "SUBMITTED" });
    if (l.stage !== "DONE" || l.status !== "PENDING") {
      await ins("request_approvals", { id: demoId("ra:" + i), platformId: P1, kind: "LEAVE", requestId: id, status: l.stage === "MGR_PENDING" ? "PENDING" : "APPROVED", approverIds: arr([approver]), decidedById: l.stage === "MGR_PENDING" ? null : approver, decidedAt: l.stage === "MGR_PENDING" ? null : minsAgo(60 * 20) });
      if (l.stage !== "MGR_PENDING") await ins("leave_approval_events", { id: demoId("lae:" + i + ":m"), platformId: P1, requestId: id, actorName: l.key === "mgr" ? "Aarav Admin (Demo)" : "Manager (Demo)", actorRole: l.key === "mgr" ? "ADMIN" : "MANAGER", step: "MANAGER", action: "APPROVED" });
    }
    if (l.status === "APPROVED") for (let d = Math.max(l.from, l.to); d >= Math.min(l.from, l.to); d--) { const day = istDay(d); if (dow(day) % 6 !== 0) await ins("leave_days", { id: demoId(`ld:${i}:${day}`), platformId: P1, userId: U(l.key), date: day, leaveType: l.type, note: "Approved leave (demo)", markedById: U("hr"), leaveRequestId: id }); }
  }

  // ---- meetings and Team Huddles ---------------------------------------------------------------------------------------------------------
  const huddle = async (key: string, title: string, org: string, starts: Date, ends: Date, invitees: string[], answers: Record<string, string>, joined: string[], tracked = true, url: string | null = null) => {
    const id = demoId("meeting:" + key);
    await ins("meetings", { id, platformId: P1, organizerId: U(org), title, description: "Fictional demo meeting.", startsAt: starts, endsAt: ends, meetingUrl: url, provider: url ? "Other" : null, updatedAt: new Date() });
    if (tracked) await ins("meeting_tracking", { meetingId: id, platformId: P1, lateAfterMinutes: 5, createdById: U(org) });
    for (const u of invitees) {
      await ins("meeting_attendees", { id: demoId(`ma:${key}:${u}`), meetingId: id, userId: U(u) });
      if (answers[u]) await ins("meeting_responses", { id: demoId(`mr:${key}:${u}`), meetingId: id, platformId: P1, userId: U(u), response: answers[u], updatedAt: new Date() });
    }
    for (const u of joined) await ins("meeting_participation", { id: demoId(`mp:${key}:${u}`), meetingId: id, platformId: P1, userId: U(u), joinedAt: new Date(starts.getTime() + 2 * 60_000), updatedAt: new Date(), ...(ends.getTime() < Date.now() ? { leftAt: ends, durationSeconds: Math.round((ends.getTime() - starts.getTime() - 120_000) / 1000), endedBy: "SELF" } : {}) });
    return id;
  };
  await huddle("live", "Daily Stand-up (live demo huddle)", "mgr", minsAgo(15), hoursAhead(3), ["emp", "e1", "e2", "e3"], { emp: "ACCEPTED", e1: "ACCEPTED", e2: "ACCEPTED", e3: "ACCEPTED" }, ["e1", "e2"]);
  // a huddle that has just started and has NOT been answered by the demo employee: Accept, then Join, can be tried from the Employee view
  await huddle("sync", "Quick Sync (live, awaiting your reply)", "mgr2", minsAgo(4), hoursAhead(3), ["emp", "e5", "e6"], { e5: "ACCEPTED", e6: "ACCEPTED" }, ["e5"]);
  await huddle("tomorrow", "Operations Huddle (tomorrow)", "mgr2", hoursAhead(20), hoursAhead(20.5), ["e5", "e6", "e7", "emp"], { e5: "ACCEPTED" }, []);
  await huddle("past", "Weekly Team Huddle (yesterday)", "mgr", at(istDay(1), "10:00"), at(istDay(1), "10:30"), ["emp", "e1", "e2", "e3", "e4"], { emp: "ACCEPTED", e1: "ACCEPTED", e2: "ACCEPTED", e3: "ACCEPTED", e4: "ACCEPTED" }, ["emp", "e1", "e2", "e3"]);
  await huddle("online", "Customer Review (online)", "mgr", hoursAhead(30), hoursAhead(31), ["e1", "e2"], {}, [], false, "https://meet.example.com/demo-review");

  // ---- Query Desk: classic queries (with replies) and department requests ----------------------------------------------------------------
  const tickets: [string, string, string, string, string, string, string][] = [
    ["T1", "emp", "HR_QUERY", "OPEN", "Salary slip for last month not visible", "I cannot see my salary slip in My Payslips (demo).", "PAYROLL"],
    ["T2", "e1", "TECH_ISSUE", "IN_PROGRESS", "VPN keeps disconnecting", "The VPN drops every ten minutes since Monday (demo).", "TECHNICAL"],
    ["T3", "e2", "HR_QUERY", "RESOLVED", "Question about the leave policy", "How many casual leaves can I take together? (demo)", "LEAVE"],
  ];
  for (const [i, [ref, key, cat, status, subject, desc, ck]] of tickets.entries()) {
    const id = demoId("ticket:" + ref);
    await ins("tickets", { id, platformId: P1, reference: `DEMO-${100 + i}`, raisedById: U(key), category: cat, priority: "NORMAL", status, subject, description: desc, assignedToId: U("hr"), resolvedAt: status === "RESOLVED" ? minsAgo(60 * 30) : null, resolutionNote: status === "RESOLVED" ? "Up to three casual leaves may be taken together (demo answer)." : null, updatedAt: new Date() });
    await ins("query_meta", { ticketId: id, platformId: P1, categoryKey: ck, updatedAt: new Date() });
    if (status !== "OPEN") { await ins("ticket_messages", { id: demoId("tm1:" + ref), ticketId: id, authorId: U("hr"), body: "Thanks for raising this. We are looking into it (demo reply)." }); }
  }
  const depts: [string, string, string[]][] = [["hr", "HR Department", ["hr"]], ["it", "IT Department", ["admin", "mgr2"]], ["fin", "Finance Department", ["hr"]]];
  for (const [k, name, members] of depts) {
    await ins("departments", { id: demoId("dept:" + k), platformId: P1, name });
    for (const m of members) await ins("department_members", { id: demoId(`dm:${k}:${m}`), departmentId: demoId("dept:" + k), userId: U(m) });
  }
  const reqs: [string, string, string, string, string, string, string | null][] = [
    ["R1", "emp", "Access to the shared reporting folder", "it", "PENDING_MANAGER", "MEDIUM", null],
    ["R2", "e1", "New headset for support calls", "it", "PENDING_ADMIN", "LOW", null],
    ["R3", "e2", "Employment certificate for a bank loan", "hr", "APPROVED", "HIGH", "AWAITING_ACTION"],
  ];
  for (const [i, [ref, key, title, dept, approval, prio, work]] of reqs.entries()) {
    const id = demoId("dreq:" + ref);
    await ins("dept_requests", { id, platformId: P1, reference: `DQ-${900 + i}`, raisedById: U(key), title, description: "Fictional department request.", priority: prio, departmentId: demoId("dept:" + dept), approvalStatus: approval, managerId: U(bossOf(key)), adminApproverIds: arr([U("admin")]), managerDecidedAt: approval === "PENDING_MANAGER" ? null : minsAgo(60 * 30), adminDecidedAt: approval === "APPROVED" ? minsAgo(60 * 20) : null, workStatus: work, updatedAt: new Date() });
    await ins("dept_request_events", { id: demoId("dre:" + ref), requestId: id, actorId: U(key), kind: "CREATED", toValue: dept === "hr" ? "HR Department" : "IT Department", note: "Raised from the demo", visibility: "ALL" });
  }

  // ---- documents (dummy files only) --------------------------------------------------------------------------------------------------------
  const pdf = Buffer.from("%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 120]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj 4 0 obj<</Length 66>>stream\nBT /F1 14 Tf 20 60 Td (DEMO DOCUMENT - fictional, not a real record) Tj ET\nendstream endobj 5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF");
  const reqDocs: [string, string, string][] = [["id", "IDENTITY", "Identity proof (demo)"], ["edu", "EDUCATION", "Highest qualification (demo)"], ["bank", "BANKING", "Bank passbook (demo)"]];
  for (const [i, [k, cat, label]] of reqDocs.entries()) await ins("document_requirements", { id: demoId("req:" + k), platformId: P1, category: cat, label, isMandatory: true, sortOrder: i, uploadedByEmployee: true, isActive: true, updatedAt: new Date() });
  const docStates: [string, string, string][] = [["emp", "id", "APPROVED"], ["emp", "edu", "SUBMITTED"], ["e1", "id", "SUBMITTED"], ["e2", "id", "REJECTED"], ["e3", "id", "APPROVED"]];
  for (const [i, [key, req, status]] of docStates.entries()) {
    const sk = `${P1}/documents/${demoId("blob:" + i)}.pdf`;
    await ins("stored_blobs", { storageKey: sk, platformId: P1, folder: "documents", mimeType: "application/pdf", fileSize: pdf.length, data: pdf });
    await ins("employee_documents", { id: demoId("doc:" + i), platformId: P1, userId: U(key), requirementId: demoId("req:" + req), category: reqDocs.find((r) => r[0] === req)![1], status, storageKey: sk, fileName: "demo-document.pdf", fileSize: pdf.length, mimeType: "application/pdf", uploadedAt: minsAgo(60 * 48), uploadedById: U(key), reviewedById: status === "APPROVED" || status === "REJECTED" ? U("hr") : null, reviewedAt: status === "APPROVED" || status === "REJECTED" ? minsAgo(60 * 24) : null, rejectionReason: status === "REJECTED" ? "The photo is not clear. Please upload a sharper copy (demo)." : null, updatedAt: new Date() });
  }

  // ---- payslips (last month, dummy PDF) -------------------------------------------------------------------------------------------------
  const lm = new Date(Date.now() + IST); lm.setUTCMonth(lm.getUTCMonth() - 1);
  for (const [i, key] of ["emp", "e1", "e2"].entries()) {
    const sk = `${P1}/payslips/${demoId("slip:" + i)}.pdf`;
    await ins("stored_blobs", { storageKey: sk, platformId: P1, folder: "payslips", mimeType: "application/pdf", fileSize: pdf.length, data: pdf });
    const gross = PEOPLE.find((p) => p.key === key)!.salary;
    await ins("salary_slips", { id: demoId("slip:" + key), platformId: P1, userId: U(key), month: lm.getUTCMonth() + 1, year: lm.getUTCFullYear(), grossAmount: gross, deductions: Math.round(gross * 0.08), netAmount: Math.round(gross * 0.92), storageKey: sk, fileName: "demo-payslip.pdf", fileSize: pdf.length, mimeType: "application/pdf", uploadedById: U("hr"), publishedAt: minsAgo(60 * 24 * 5), status: "PUBLISHED", updatedAt: new Date() });
  }

  // ---- notifications (a few unread for every role so the bell and pop-ups have something to show) ------------------------------------------
  const notes: [string, string, string, string, string][] = [
    ["emp", "LEAVE_DECIDED", "Leave approved", "Your leave request was approved (demo).", "/dashboard/leave"],
    ["emp", "TASK_PROPOSAL_APPROVED", "Task approved", "Your task was approved by your manager (demo).", "/dashboard/tasks"],
    ["mgr", "TASK_PROPOSED", "Needs approval", "Rohan sent a task for approval (demo).", "/dashboard/tasks?tab=submitted"],
    ["mgr", "LEAVE_REQUESTED", "Leave request", "Isha asked for half a day of leave (demo).", "/dashboard/leave"],
    ["hr", "LEAVE_REQUESTED", "Leave awaiting HR", "Kabir's leave was approved by the manager and now needs HR (demo).", "/dashboard/leave"],
    ["hr", "DOCUMENT_SUBMITTED", "Document submitted", "Rohan uploaded an identity proof (demo).", "/dashboard/documents"],
    ["admin", "DEPT_QUERY_ADMIN_REVIEW", "Query needs final approval", "A request is waiting for your final approval (demo).", "/dashboard/queries?tab=dept"],
  ];
  for (const [i, [key, type, title, body, link]] of notes.entries()) await ins("notifications", { id: demoId("note:" + i), platformId: P1, userId: U(key), type, title, body, link, data: json({ demo: true, dedupeKey: "demo-seed-" + i }) });

  return { users: PEOPLE.length };
}

/**
 * The demo data is relative to the day it was created ("today", "yesterday", the live huddle). When the demo server finds the data was created on an
 * EARLIER company day, it re-creates it, so a tester never opens an empty "today". Runs at start and then every 30 minutes; only ever on the marked demo database.
 */
export async function refreshIfStale(dbName: string): Promise<boolean> {
  const row = await prisma.$queryRaw<{ d: string; age: number }[]>`select to_char("createdAt" + interval '5 hours 30 minutes', 'YYYY-MM-DD') d, extract(epoch from (now() - "createdAt"))::int age from demo_marker where id = 1`;
  const seededDay = row[0]?.d;
  // Re-seed on a new day, and every 2.5 hours so the live huddles (3 h long) are always still running for whoever opens the demo.
  if (seededDay === istDay(0) && (row[0]?.age ?? 0) < 9000) return false;
  await seedDemo(dbName);
  console.log(`[demo] data was from ${seededDay ?? "unknown"}: refreshed for today (${istDay(0)})`);
  return true;
}
