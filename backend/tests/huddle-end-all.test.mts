// Manager ends a Team Huddle for everyone: every joined person stopped at the same moment, live signal to each, exact end times, reconnect, authorisation,
// no duplicates, and the time reaches the reports. Throwaway DB + test backend (5012) only.
//   DATABASE_URL=postgresql://postgres:localtest@127.0.0.1:54329/dq_test TEST_API=http://localhost:5012/api npx tsx tests/huddle-end-all.test.mts
import "dotenv/config";
import { createRequire } from "node:module";
import path from "node:path";
if (!(process.env.DATABASE_URL ?? "").includes("127.0.0.1:54329")) throw new Error("refusing: not the throwaway database");
const reqFront = createRequire(path.resolve(import.meta.dirname, "../../frontend/package.json"));
const { io } = reqFront("socket.io-client");
const { prisma } = await import("../src/lib/prisma.js");
const bcrypt = (await import("bcryptjs")).default;
const HOST = "http://localhost:5012", API = process.env.TEST_API || HOST + "/api", PW = "Hud@12345678";
let pass = 0, fail = 0;
const ok = (n: string, c: boolean, x?: unknown) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  -> " + JSON.stringify(x)?.slice(0, 280))); };
const call = async (m: string, p: string, t?: string, b?: unknown) => { const r = await fetch(API + p, { method: m, headers: { "content-type": "application/json", ...(t ? { authorization: "Bearer " + t } : {}) }, body: b !== undefined ? JSON.stringify(b) : undefined }); return { s: r.status, b: await r.json().catch(() => ({})) as any }; };
const sql = (s: TemplateStringsArray, ...v: unknown[]) => prisma.$queryRaw<any[]>(s, ...v);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const A = (await prisma.platform.findUnique({ where: { slug: "avatar" } }))!.id;
const hash = await bcrypt.hash(PW, 10);
const wipe = async () => {
  const ids = (await sql`select id::text from users where "employeeCode" like 'HUD-%'`).map((r) => r.id);
  if (ids.length) {
    const ms = (await sql`select id::text from meetings where "organizerId" = any(${ids}::uuid[])`).map((r) => r.id);
    if (ms.length) { for (const t of ["meeting_participation_changes", "meeting_participation", "meeting_responses", "meeting_tracking", "meeting_attendees"]) await prisma.$executeRawUnsafe(`delete from ${t} where "meetingId" = any($1::uuid[])`, ms).catch(() => {}); await prisma.$executeRaw`delete from meetings where id = any(${ms}::uuid[])`; }
    await prisma.$executeRaw`delete from notifications where "userId" = any(${ids}::uuid[])`;
    await prisma.$executeRaw`update audit_logs set "actorId"=null where "actorId" = any(${ids}::uuid[])`.catch(() => {});
    await prisma.$executeRaw`delete from login_events where "userId" = any(${ids}::uuid[])`.catch(() => {});
    await prisma.$executeRaw`delete from work_sessions where "userId" = any(${ids}::uuid[])`.catch(() => {});
    await prisma.$executeRaw`delete from users where id = any(${ids}::uuid[])`;
  }
};
await wipe();
const mk = async (code: string, role: string, boss: string | null = null) => (await prisma.user.create({ data: { platformId: A, email: code.toLowerCase() + "@hud.test", passwordHash: hash, firstName: "Hud", lastName: code, employeeCode: code, role: role as never, status: "ACTIVE", mustChangePassword: false, trackerAccessEnabled: true, onboardingStatus: "ACTIVE" as never, reportsToId: boss } as never })).id;
const mgr = await mk("HUD-M", "MANAGER"), other = await mk("HUD-OM", "MANAGER"), hr = await mk("HUD-HR", "HR");
const e1 = await mk("HUD-E1", "EMPLOYEE", mgr), e2 = await mk("HUD-E2", "EMPLOYEE", mgr), e3 = await mk("HUD-E3", "EMPLOYEE", mgr), e4 = await mk("HUD-E4", "EMPLOYEE", mgr);
const login = async (c: string) => (await call("POST", "/auth/login", undefined, { email: c, password: PW })).b.token as string;
const T: Record<string, string> = {}; for (const c of ["M", "OM", "HR", "E1", "E2", "E3", "E4"]) T[c] = await login("HUD-" + c);

// a Team Huddle that started 20 minutes ago and runs another 40
const mid = (await sql`insert into meetings (id,"platformId","organizerId",title,"startsAt","endsAt","updatedAt") values (gen_random_uuid(),${A}::uuid,${mgr}::uuid,'Morning huddle', now() - interval '20 minutes', now() + interval '40 minutes', now()) returning id::text`)[0].id;
await sql`insert into meeting_tracking ("meetingId","platformId","lateAfterMinutes","createdById") values (${mid}::uuid,${A}::uuid,5,${mgr}::uuid)`;
for (const u of [e1, e2, e3, e4]) await sql`insert into meeting_attendees (id,"meetingId","userId") values (gen_random_uuid(),${mid}::uuid,${u}::uuid)`;
for (const u of [e1, e2, e3]) await sql`insert into meeting_responses (id,"meetingId","platformId","userId",response,"updatedAt") values (gen_random_uuid(),${mid}::uuid,${A}::uuid,${u}::uuid,'ACCEPTED',now())`;
// E1 and E2 joined and are still in; E3 joined and already left on their own; E4 never joined
await sql`insert into meeting_participation (id,"meetingId","platformId","userId","joinedAt","updatedAt") values (gen_random_uuid(),${mid}::uuid,${A}::uuid,${e1}::uuid, now() - interval '18 minutes', now()), (gen_random_uuid(),${mid}::uuid,${A}::uuid,${e2}::uuid, now() - interval '15 minutes', now())`;
await sql`insert into meeting_participation (id,"meetingId","platformId","userId","joinedAt","leftAt","durationSeconds","endedBy","updatedAt") values (gen_random_uuid(),${mid}::uuid,${A}::uuid,${e3}::uuid, now() - interval '18 minutes', now() - interval '8 minutes', 600, 'SELF', now())`;
const e3Before = (await sql`select to_char("leftAt",'HH24:MI:SS.US') l, "durationSeconds" d, "endedBy" b from meeting_participation where "meetingId"=${mid}::uuid and "userId"=${e3}::uuid`)[0];

// live connections for the joined employees
const sockets: Record<string, { got: any[]; s: any }> = {};
for (const c of ["E1", "E2", "E4", "OM"]) { const got: any[] = []; const s = io(HOST, { auth: { token: T[c] }, transports: ["websocket"], reconnection: false }); s.on("meetings:changed", (p: any) => got.push(p)); sockets[c] = { got, s }; }
await sleep(1500);

console.log("\n## who may end it");
ok("an employee cannot end it", (await call("POST", `/meetings/${mid}/end`, T.E1)).s >= 400);
ok("another manager cannot end it (404: it does not exist for them)", (await call("POST", `/meetings/${mid}/end`, T.OM)).s === 404);
ok("HR cannot end it", (await call("POST", `/meetings/${mid}/end`, T.HR)).s >= 400);
ok("nothing changed after those attempts: both are still in the meeting", (await sql`select count(*)::int n from meeting_participation where "meetingId"=${mid}::uuid and "leftAt" is null`)[0].n === 2);
const list = (await call("GET", "/meetings?scope=upcoming", T.M)).b.meetings.find((m: any) => m.id === mid);
ok("the organizer's list says he can end it, an employee's does not", list?.canEnd === true && !(await call("GET", "/meetings?scope=upcoming", T.E1)).b.meetings.find((m: any) => m.id === mid)?.canEnd);
ok("another manager's list does not even contain it", !(await call("GET", "/meetings?scope=upcoming", T.OM)).b.meetings.find((m: any) => m.id === mid));

console.log("\n## the manager ends it");
for (const k of Object.keys(sockets)) sockets[k].got.length = 0;
const t0 = Date.now();
const end = await call("POST", `/meetings/${mid}/end`, T.M);
const t1 = Date.now();
ok("it ends, reporting how many people were still in", end.s === 200 && end.b.endedParticipants === 2, end);
await sleep(1200);
const rows = await sql`select "userId"::text u, "joinedAt", "leftAt", "durationSeconds" d, "endedBy" b from meeting_participation where "meetingId"=${mid}::uuid order by "userId"`;
const row = (u: string) => rows.find((r) => r.u === u);
ok("both joined employees were ended, by the manager, with an end time", [e1, e2].every((u) => row(u).leftAt && row(u).b === "MANAGER"), rows);
ok("both have the SAME end moment (one server clock reading), at the time of the click", row(e1).leftAt.getTime() === row(e2).leftAt.getTime() && row(e1).leftAt.getTime() >= t0 - 3000 && row(e1).leftAt.getTime() <= t1 + 3000);
ok("each duration is their own join to that end (about 18 and 15 minutes), never beyond the end", Math.abs(row(e1).d - 18 * 60) < 15 && Math.abs(row(e2).d - 15 * 60) < 15 && Math.abs(row(e1).d - (row(e1).leftAt - row(e1).joinedAt) / 1000) <= 1, [row(e1).d, row(e2).d]);
const e3After = (await sql`select to_char("leftAt",'HH24:MI:SS.US') l, "durationSeconds" d, "endedBy" b from meeting_participation where "meetingId"=${mid}::uuid and "userId"=${e3}::uuid`)[0];
ok("the person who had already ended keeps their own time untouched", JSON.stringify(e3After) === JSON.stringify(e3Before), [e3Before, e3After]);
ok("the person who never joined got no participation record", !row(e4));
ok("exactly one record per person, no duplicates", rows.length === 3 && new Set(rows.map((r) => r.u)).size === 3);
const mt = (await sql`select "endsAt" from meetings where id=${mid}::uuid`)[0];
ok("the meeting now ends at that moment (it is Ended for everyone, no longer 'ongoing')", Math.abs(mt.endsAt.getTime() - row(e1).leftAt.getTime()) < 50);

console.log("\n## live signal and the message");
ok("both employees who were in it got the live 'meetings:changed' signal", sockets.E1.got.length >= 1 && sockets.E2.got.length >= 1, [sockets.E1.got.length, sockets.E2.got.length]);
ok("the signal carries no content (just the meeting id)", sockets.E1.got.every((g) => !JSON.stringify(g).match(/Manager|Huddle|name/i)));
ok("an invitee who never joined and another manager did not get a huddle-ended message", (await prisma.notification.count({ where: { userId: { in: [e4, other] }, type: "MEETING_ENDED" } })) === 0);
const n1 = await prisma.notification.findMany({ where: { userId: e1, type: "MEETING_ENDED" } }), n2 = await prisma.notification.findMany({ where: { userId: e2, type: "MEETING_ENDED" } }), n3 = await prisma.notification.findMany({ where: { userId: e3, type: "MEETING_ENDED" } });
ok("each participant has the message 'The Manager has ended the Team Huddle.' (once)", n1.length === 1 && n2.length === 1 && n1[0].body === "The Manager has ended the Team Huddle." && n3.length === 1, [n1.length, n2.length, n1[0]?.body]);
ok("the manager who ended it gets no such message", (await prisma.notification.count({ where: { userId: mgr, type: "MEETING_ENDED" } })) === 0);

console.log("\n## what each employee sees (and a reconnect)");
const mine = async (tok: string) => (await call("GET", "/meetings?scope=past", tok)).b.meetings.find((m: any) => m.id === mid);
const m1 = await mine(T.E1);
ok("a freshly signed-in employee (a reconnect) sees ENDED by the manager with their exact times", m1?.me?.state === "ENDED" && m1.me.endedBy === "MANAGER" && !!m1.me.leftAt && m1.me.durationSeconds > 0, m1?.me);
ok("and cannot join again: the join window is closed and the invite no longer offers it", m1?.canJoin === false);
const rej = await call("POST", `/meetings/${mid}/join`, T.E1);
ok("joining the ended huddle is refused", rej.s >= 400, rej);
const rej4 = await call("POST", `/meetings/${mid}/join`, T.E4);
ok("so is joining by someone who had not joined before the end", rej4.s >= 400, rej4);
const rej2 = await call("POST", `/meetings/${mid}/leave`, T.E1);
ok("pressing End/Leave again changes nothing (already ended)", rej2.s >= 400 && (await sql`select count(*)::int n from meeting_participation where "meetingId"=${mid}::uuid`)[0].n === 3);
ok("the self-ended person's record shows SELF, not the manager", (await mine(T.E3))?.me?.endedBy === "SELF");
ok("ending it twice (a double click) does not alter anything or fail loudly", await (async () => { const before = JSON.stringify(await sql`select "userId"::text, "leftAt" from meeting_participation where "meetingId"=${mid}::uuid order by 1`); const r = await call("POST", `/meetings/${mid}/end`, T.M); const after = JSON.stringify(await sql`select "userId"::text, "leftAt" from meeting_participation where "meetingId"=${mid}::uuid order by 1`); return r.s >= 400 && before === after; })());

console.log("\n## attendance / productivity: nothing counted after the end");
const { huddleSecondsByDay } = await import("../src/modules/meetings/participation.service.js");
const today = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()));
await call("POST", "/tracker/clock-in", T.E1, {});
await prisma.$executeRaw`update work_sessions set "loginAt" = now() - interval '2 hours' where "userId" = ${e1}::uuid and "logoutAt" is null`;
const byDay = await huddleSecondsByDay([e1], new Date(today.getTime() - 86400000), new Date(today.getTime() + 86400000));
const huddle = [...byDay.entries()].filter(([k]) => k.startsWith(e1)).reduce((s, [, v]) => s + v, 0);
ok("the report's huddle time for the employee is their own join-to-end (about 18 minutes), not longer", Math.abs(huddle - 18 * 60) < 30, huddle);
const tl = await call("GET", `/tracker/timesheet?from=${today.toISOString().slice(0, 10)}&to=${today.toISOString().slice(0, 10)}`, T.E1);
ok("the employee's timesheet carries the same huddle time and the work session was not duplicated", tl.s === 200 && (await sql`select count(*)::int n from work_sessions where "userId"=${e1}::uuid`)[0].n === 1, tl.s);
ok("no attendance/session record was created by ending the huddle", (await sql`select count(*)::int n from work_sessions where "userId" = any(${[e2, e3, e4]}::uuid[])`)[0].n === 0);
await sleep(60000 / 60);
const later = await sql`select "leftAt" from meeting_participation where "meetingId"=${mid}::uuid and "userId"=${e1}::uuid`;
ok("time passing later does not extend the ended participation", later[0].leftAt.getTime() === row(e1).leftAt.getTime());

for (const k of Object.keys(sockets)) sockets[k].s.close();
await wipe();
await prisma.$disconnect();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
