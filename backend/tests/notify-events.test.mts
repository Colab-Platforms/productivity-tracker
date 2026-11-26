// Notification events (attendance, break, reminders, meeting end) against the throwaway DB + test backend (5012):
//   DATABASE_URL=postgresql://postgres:localtest@127.0.0.1:54329/dq_test TEST_API=http://localhost:5012/api JWT_SECRET=... npx tsx tests/notify-events.test.mts
// Proves who receives what, that nobody else does (other team, other company, HR), that repeats are silent, and that history persists.
import "dotenv/config";
const DB = process.env.DATABASE_URL ?? "";
if (!DB.includes("127.0.0.1:54329")) throw new Error("refusing: not the throwaway database");
const { prisma } = await import("../src/lib/prisma.js");
const bcrypt = (await import("bcryptjs")).default;
const N = await import("../src/modules/tracker/tracker.notify.js");
const API = process.env.TEST_API || "http://localhost:5012/api";
const PW = "Ntf@12345678";
let pass = 0, fail = 0;
const ok = (n: string, c: boolean, x?: unknown) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  -> " + JSON.stringify(x)?.slice(0, 250))); };
const call = async (m: string, p: string, t?: string, b?: unknown) => { const r = await fetch(API + p, { method: m, headers: { "content-type": "application/json", ...(t ? { authorization: "Bearer " + t } : {}) }, body: b !== undefined ? JSON.stringify(b) : undefined }); return { s: r.status, b: await r.json().catch(() => ({})) as any }; };
const sql = (s: TemplateStringsArray, ...v: unknown[]) => prisma.$queryRaw<any[]>(s, ...v);

const A = (await prisma.platform.findUnique({ where: { slug: "avatar" } }))!.id;
const B = (await prisma.platform.findUnique({ where: { slug: "avance" } }))!.id;
const hash = await bcrypt.hash(PW, 10);
const wipe = async () => {
  const ids = (await sql`select id::text from users where "employeeCode" like 'NTF-%'`).map((r) => r.id);
  if (ids.length) {
    await prisma.$executeRaw`delete from notifications where "userId" = any(${ids}::uuid[])`;
    await prisma.$executeRaw`delete from meeting_attendees where "userId" = any(${ids}::uuid[])`;
    await prisma.$executeRaw`delete from meetings where "organizerId" = any(${ids}::uuid[])`;
    await prisma.$executeRaw`delete from daily_tasks where "userId" = any(${ids}::uuid[])`;
    await prisma.$executeRaw`delete from alerts where "userId" = any(${ids}::uuid[])`.catch(() => {});
    await prisma.$executeRaw`update audit_logs set "actorId"=null where "actorId" = any(${ids}::uuid[])`.catch(() => {});
    await prisma.$executeRaw`delete from login_events where "userId" = any(${ids}::uuid[])`.catch(() => {});
    await prisma.$executeRaw`delete from users where id = any(${ids}::uuid[])`;
  }
};
await wipe();
const mk = async (code: string, role: string, platformId: string, boss: string | null = null) =>
  (await prisma.user.create({ data: { platformId, email: code.toLowerCase() + "@ntf.test", passwordHash: hash, firstName: "Ntf", lastName: code, employeeCode: code, role: role as never, status: "ACTIVE", mustChangePassword: false, trackerAccessEnabled: true, onboardingStatus: "ACTIVE" as never, reportsToId: boss } as never })).id;
const mgrA = await mk("NTF-MA", "MANAGER", A), otherMgrA = await mk("NTF-OM", "MANAGER", A), hrA = await mk("NTF-HR", "HR", A);
const empA = await mk("NTF-EA", "EMPLOYEE", A, mgrA), empA2 = await mk("NTF-EA2", "EMPLOYEE", A, mgrA);
const mgrB = await mk("NTF-MB", "MANAGER", B), empB = await mk("NTF-EB", "EMPLOYEE", B, mgrB);
const all = [mgrA, otherMgrA, hrA, empA, empA2, mgrB, empB];
const notes = async (userId: string, type?: string) => (await prisma.notification.findMany({ where: { userId, ...(type ? { type } : {}) }, orderBy: { createdAt: "asc" } }));
const login = async (code: string) => (await call("POST", "/auth/login", undefined, { email: code, password: PW })).b.token as string;

console.log("\n## own actions: clock-in, break start/end, clock-out");
const tok = await login("NTF-EA");
await call("POST", "/tracker/clock-in", tok, {});
await new Promise((r) => setTimeout(r, 400));
let n = await notes(empA, "ATTENDANCE_CLOCK_IN");
ok("clock-in notifies the person (title, time in the body, link to Today)", n.length === 1 && n[0].title === "Clocked in" && /\d/.test(n[0].body) && n[0].link === "/dashboard/today", n);
const dbl = await Promise.all([call("POST", "/tracker/break/start", tok, { breakType: "LUNCH" }), call("POST", "/tracker/break/start", tok, { breakType: "LUNCH" })]);
await new Promise((r) => setTimeout(r, 400));
ok("a double-click on Break makes ONE 'Break started' notification", (await notes(empA, "BREAK_STARTED")).length === 1, dbl.map((d) => d.s));
await call("POST", "/tracker/break/end", tok);
await new Promise((r) => setTimeout(r, 400));
ok("ending the break notifies once", (await notes(empA, "BREAK_ENDED")).length === 1);
await call("POST", "/tracker/clock-out", tok);
await new Promise((r) => setTimeout(r, 400));
ok("clock-out notifies once", (await notes(empA, "ATTENDANCE_CLOCK_OUT")).length === 1);
ok("a refused action creates nothing: break/end with no break running", await (async () => { const before = (await notes(empA)).length; const r = await call("POST", "/tracker/break/end", tok); await new Promise((x) => setTimeout(x, 300)); return r.s >= 400 && (await notes(empA)).length === before; })());
let others = 0;
for (const u of [mgrA, otherMgrA, hrA, empA2, mgrB, empB]) others += (await notes(u)).length;
ok("nobody else (manager, other manager, HR, colleague, other company) got any of it", others === 0, others);
ok("a rejected sign-in token creates nothing", (await call("POST", "/tracker/clock-in", "bad.token.here", {})).s === 401);

console.log("\n## a discussion (Meeting / Team Huddle) is not a break");
await call("POST", "/tracker/clock-in", tok, {});
await new Promise((r) => setTimeout(r, 300));
const startedBefore = (await notes(empA, "BREAK_STARTED")).length, endedBefore = (await notes(empA, "BREAK_ENDED")).length;
await call("POST", "/tracker/break/start", tok, { breakType: "DISCUSSION", remark: "Quick chat with my manager" });
await call("POST", "/tracker/break/end", tok);
await new Promise((r) => setTimeout(r, 800));
ok("starting and ending a discussion creates NO 'Break started' / 'Break ended' notification", (await notes(empA, "BREAK_STARTED")).length === startedBefore && (await notes(empA, "BREAK_ENDED")).length === endedBefore, [startedBefore, endedBefore]);
await call("POST", "/tracker/break/start", tok, { breakType: "LUNCH" });
await call("POST", "/tracker/break/end", tok);
await new Promise((r) => setTimeout(r, 800));
ok("a real break after it still does", (await notes(empA, "BREAK_STARTED")).length === startedBefore + 1 && (await notes(empA, "BREAK_ENDED")).length === endedBefore + 1);
await call("POST", "/tracker/clock-out", tok);

console.log("\n## problems: manager + person only, once a day");
const day = "2026-11-20";
await N.problemNotice("BREAK_OVERAGE", empA2, day, "Break Time exceeded by 20 minutes");
const mine = await notes(empA2, "BREAK_EXCEEDED"), boss = await notes(mgrA, "BREAK_EXCEEDED");
ok("the person is told (own wording)", mine.length === 1 && mine[0].title === "Break Time exceeded", mine);
ok("their reporting manager is told, naming the person", boss.length === 1 && /Ntf NTF-EA2 exceeded Break Time/.test(boss[0].title), boss);
ok("the unrelated manager, HR, colleague and the other company hear nothing", (await Promise.all([otherMgrA, hrA, empA, mgrB, empB].map((u) => notes(u, "BREAK_EXCEEDED")))).every((x) => x.length === 0));
await N.problemNotice("BREAK_OVERAGE", empA2, day, "Break Time exceeded by 35 minutes");
ok("the scheduler running again that day sends nothing new", (await notes(empA2, "BREAK_EXCEEDED")).length === 1 && (await notes(mgrA, "BREAK_EXCEEDED")).length === 1);
await N.problemNotice("BREAK_OVERAGE", empA2, "2026-11-21", "Break Time exceeded by 5 minutes");
ok("the next day is a new event", (await notes(mgrA, "BREAK_EXCEEDED")).length === 2);
await N.problemNotice("LATE_LOGIN", empB, day, "Late login at 10:30 am");
await N.problemNotice("NO_LOGIN", empB, day, "Not clocked in");
ok("company B's late/not-clocked-in reach company B's manager and never company A", (await notes(mgrB, "ATTENDANCE_LATE")).length === 1 && (await notes(mgrB, "ATTENDANCE_NOT_CLOCKED_IN")).length === 1 && (await notes(mgrA)).filter((x) => /EB/.test(x.title)).length === 0);

console.log("\n## reminders");
await call("POST", "/tracker/clock-in", await login("NTF-EA2"), {});
await prisma.$executeRaw`update work_sessions set "loginAt" = now() - interval '11 hours' where "userId" = ${empA2}::uuid and "logoutAt" is null`;
await N.remindMissingClockOut();
ok("missing clock-out reminder goes to the person once", (await notes(empA2, "ATTENDANCE_MISSING_CLOCK_OUT")).length === 1);
await N.remindMissingClockOut();
ok("and not again on the next run", (await notes(empA2, "ATTENDANCE_MISSING_CLOCK_OUT")).length === 1);
ok("nobody else got that reminder", (await Promise.all([mgrA, hrA, empA, mgrB].map((u) => notes(u, "ATTENDANCE_MISSING_CLOCK_OUT")))).every((x) => x.length === 0));

const soon = new Date(Date.now() + 8 * 60_000), later = new Date(Date.now() + 90 * 60_000);
const m1 = (await sql`insert into meetings (id,"platformId","organizerId",title,"startsAt","endsAt","updatedAt") values (gen_random_uuid(),${A}::uuid,${mgrA}::uuid,'Daily huddle',${soon},${new Date(soon.getTime() + 1800000)},now()) returning id::text`)[0].id;
await sql`insert into meeting_attendees (id,"meetingId","userId") values (gen_random_uuid(),${m1}::uuid,${empA}::uuid),(gen_random_uuid(),${m1}::uuid,${empA2}::uuid)`;
const m2 = (await sql`insert into meetings (id,"platformId","organizerId",title,"startsAt","endsAt","updatedAt") values (gen_random_uuid(),${A}::uuid,${mgrA}::uuid,'Later meeting',${later},${new Date(later.getTime() + 1800000)},now()) returning id::text`)[0].id;
await sql`insert into meeting_attendees (id,"meetingId","userId") values (gen_random_uuid(),${m2}::uuid,${empA}::uuid)`;
await N.remindMeetingsSoon();
const ms = async (u: string) => (await notes(u, "MEETING_STARTING_SOON")).map((x) => x.title);
ok("organizer and invitees hear a meeting starting within 15 minutes", (await ms(mgrA)).length === 1 && (await ms(empA)).join() === "Starting soon: Daily huddle" && (await ms(empA2)).length === 1, [await ms(mgrA), await ms(empA)]);
ok("a meeting 90 minutes away does not remind, and non-invitees hear nothing", !(await ms(empA)).includes("Starting soon: Later meeting") && (await ms(hrA)).length === 0 && (await ms(mgrB)).length === 0 && (await ms(otherMgrA)).length === 0);
await N.remindMeetingsSoon();
ok("a second run does not repeat it", (await ms(empA)).length === 1 && (await ms(mgrA)).length === 1);

const todayA = (await call("GET", "/tasks/previous", await login("NTF-MA"))).b.today as string;
const y = new Date(Date.parse(todayA + "T00:00:00Z") - 2 * 86400000).toISOString().slice(0, 10);
await sql`insert into daily_tasks (id,"platformId","userId",date,title,weight,status,"approvalStatus","approvedById","approvedAt","createdAt","updatedAt") values (gen_random_uuid(),${A}::uuid,${empA}::uuid,${y}::date,'Old open task','MEDIUM','IN_PROGRESS','APPROVED',${mgrA}::uuid,now(),now(),now())`;
await sql`insert into daily_tasks (id,"platformId","userId",date,title,weight,status,"approvalStatus","approvedById","approvedAt","createdAt","updatedAt") values (gen_random_uuid(),${A}::uuid,${empA}::uuid,${y}::date,'Second old task','MEDIUM','PENDING','APPROVED',${mgrA}::uuid,now(),now(),now())`;
await N.remindOverdueTasks();
const ov = await notes(empA, "TASK_OVERDUE"), ovm = await notes(mgrA, "TASK_OVERDUE_TEAM");
ok("open tasks from earlier days: ONE roll-up for the employee (counts both)", ov.length === 1 && /2 tasks/.test(ov[0].body), ov);
ok("and ONE roll-up for the reporting manager", ovm.length === 1 && /1 team member/.test(ovm[0].body), ovm);
ok("other manager, HR, other company hear nothing about it", (await Promise.all([otherMgrA, hrA, mgrB, empB].map((u) => notes(u, "TASK_OVERDUE_TEAM")))).every((x) => x.length === 0));
await N.remindOverdueTasks();
ok("the second run is silent", (await notes(empA, "TASK_OVERDUE")).length === 1 && (await notes(mgrA, "TASK_OVERDUE_TEAM")).length === 1);

console.log("\n## manager ends a meeting");
await sql`update meetings set "startsAt" = now() - interval '5 minutes', "endsAt" = now() + interval '20 minutes' where id = ${m1}::uuid`;
// only people who actually JOINED are told it ended: empA joined and is still in; empA2 was invited but never joined
await sql`insert into meeting_participation (id,"meetingId","platformId","userId","joinedAt","updatedAt") values (gen_random_uuid(),${m1}::uuid,${A}::uuid,${empA}::uuid, now() - interval '3 minutes', now())`;
const endRes = await call("POST", `/meetings/${m1}/end`, await login("NTF-MA"));
ok("the organizer can end it", endRes.s === 200, endRes);
await new Promise((r) => setTimeout(r, 500));
const ended = await Promise.all([empA, empA2, mgrA, hrA, mgrB].map((u) => notes(u, "MEETING_ENDED")));
ok("the person who joined is told (exact wording); an invitee who never joined, the organizer, HR and the other company are not", ended[0].length === 1 && ended[0][0].body === "The Manager has ended the Team Huddle." && ended[1].length === 0 && ended[2].length === 0 && ended[3].length === 0 && ended[4].length === 0, ended.map((x) => x.length));

console.log("\n## history, read state, isolation through the real API");
const tEA = await login("NTF-EA");
const inbox = await call("GET", "/notifications", tEA);
ok("the inbox returns the person's notifications after a fresh sign-in (persisted, not lost)", inbox.s === 200 && inbox.b.items.length >= 5, inbox.b.items?.length);
ok("every item belongs to that person's own events (none mention another employee)", inbox.b.items.every((i: any) => !/NTF-EA2|NTF-EB/.test(i.title + i.body)), inbox.b.items.map((i: any) => i.title));
const first = inbox.b.items[0];
await call("POST", `/notifications/${first.id}/read`, tEA);
const after = await call("GET", "/notifications", tEA);
ok("marking one read removes it from unread and lowers the count", after.b.unread === inbox.b.unread - 1 && !after.b.items.some((i: any) => i.id === first.id), [inbox.b.unread, after.b.unread]);
const tOther = await login("NTF-EB");
ok("another person cannot read or mark someone else's notification", (await call("POST", `/notifications/${after.b.items[0]?.id ?? first.id}/read`, tOther)).s !== 500 && (await prisma.notification.count({ where: { userId: empA, readAt: null } })) === after.b.unread);
const pg = await call("GET", "/notifications/page?filter=all&limit=50", tEA);
ok("history keeps the read one under All", pg.b.items.some((i: any) => i.id === first.id), pg.b.items?.length);

await wipe();
await prisma.$disconnect();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
