// Seeds a manager's team with 15+ days of varied history for the team-report tests: several employees, missing attendance days, breaks of every kind,
// tasks in every state (with a rating), scheduled meetings and a Team Huddle, leave in every status, a correction, and one employee with NOTHING.
// Also a second manager with their own employee, who must never appear in the first manager's report. Throwaway local database ONLY.
const crypto = require("node:crypto");
const bcrypt = require("bcryptjs");

const PW = "E2e@12345678";
const isoDay = (n, base) => new Date(Date.parse(base + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
const todayIst = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
// an Asia/Kolkata wall-clock time as a UTC instant (IST is UTC+5:30, no daylight saving)
// Returned as an ISO string in UTC on purpose: the pg driver would otherwise send a Date in THIS machine's local zone and a "timestamp without time zone" column keeps the wall clock.
const ist = (day, hhmm) => new Date(Date.parse(`${day}T${hhmm}:00+05:30`)).toISOString();

async function seed(db) {
  if (Number(db.port ?? db.connectionParameters?.port) !== 54329) throw new Error("refusing: not the throwaway local database (port 54329)");
  const q = async (s, p) => (await db.query(s, p)).rows;
  const today = todayIst();
  const AV = (await q(`select id from platforms where slug='avatar'`))[0].id;
  const hash = await bcrypt.hash(PW, 10);
  const user = async (code, first, last, role, boss, designation) => {
    const ex = await q(`select id from users where "employeeCode"=$1`, [code]);
    if (ex[0]) { await q(`update users set "reportsToId"=$2, role=$3::"UserRole", status='ACTIVE', "platformId"=$4, designation=$5 where id=$1`, [ex[0].id, boss, role, AV, designation]); return ex[0].id; }
    return (await q(`insert into users (id,"platformId",email,"passwordHash","firstName","lastName","employeeCode",role,status,"mustChangePassword","trackerAccessEnabled","onboardingStatus","reportsToId","dateOfJoining","designation","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7::"UserRole",'ACTIVE',false,true,'ACTIVE',$8,'2026-01-01',$9,now(),now()) returning id`, [AV, code.toLowerCase() + "@e2e.test", hash, first, last, code, role, boss, designation]))[0].id;
  };
  const adm = await user("E2E-ADM", "Asha", "Admin", "ADMIN", null, "Administrator");
  const mgr = await user("E2E-MGR", "Meera", "Manager", "MANAGER", adm, "Team Lead");
  const ravi = await user("E2E-EMP1", "Ravi", "Kumar", "EMPLOYEE", mgr, "Analyst");
  const sana = await user("E2E-EMP2", "Sana", "Shaikh", "EMPLOYEE", mgr, "Analyst");
  const tina = await user("TR-E3", "Tina", "Nodata", "EMPLOYEE", mgr, "Associate");
  const mgr2 = await user("TR-M2", "Mark", "Other", "MANAGER", adm, "Team Lead");
  const olga = await user("TR-E4", "Olga", "Otherteam", "EMPLOYEE", mgr2, "Analyst");
  const team = (await q(`select id from teams where name='E2E Team'`))[0].id;
  for (const u of [ravi, sana]) if (!(await q(`select 1 from team_members where "teamId"=$1 and "userId"=$2 and "isActive"`, [team, u])).length) await q(`insert into team_members (id,"teamId","userId","isActive","isPrimary","joinedAt") values (gen_random_uuid(),$1,$2,true,true,now())`, [team, u]);

  // ---- a clean slate for exactly these people ----
  const people = [ravi, sana, tina, olga];
  await q(`delete from tracker_breaks where "workSessionId" in (select id from work_sessions where "userId" = any($1::uuid[]))`, [people]);
  await q(`delete from tracker_meetings where "workSessionId" in (select id from work_sessions where "userId" = any($1::uuid[]))`, [people]).catch(() => {});
  await q(`delete from late_remarks where "userId" = any($1::uuid[])`, [people]).catch(() => {});
  await q(`delete from work_sessions where "userId" = any($1::uuid[])`, [people]);
  await q(`delete from task_ratings where "taskId" in (select id from daily_tasks where "userId" = any($1::uuid[]))`, [people]).catch(() => {});
  await q(`delete from task_entry_details where "taskId" in (select id from daily_tasks where "userId" = any($1::uuid[]))`, [people]).catch(() => {});
  await q(`delete from daily_tasks where "userId" = any($1::uuid[])`, [people]);
  await q(`delete from request_approvals where "requestId" in (select id from leave_requests where "userId" = any($1::uuid[]))`, [people]).catch(() => {});
  await q(`delete from leave_approval_events where "requestId" in (select id from leave_requests where "userId" = any($1::uuid[]))`, [people]).catch(() => {});
  await q(`delete from leave_days where "userId" = any($1::uuid[])`, [people]);
  await q(`delete from leave_requests where "userId" = any($1::uuid[])`, [people]);
  await q(`delete from attendance_correction_requests where "userId" = any($1::uuid[])`, [people]);
  // leftovers from other test runs: everyone else under this manager, and every meeting this manager organized
  await q(`update users set "reportsToId"=null where "reportsToId"=$1 and id <> all($2::uuid[])`, [mgr, [ravi, sana, tina]]);
  await q(`update team_members set "isActive"=false where "teamId"=$1 and "userId" <> all($2::uuid[])`, [team, [ravi, sana]]);
  const old = await q(`select id from meetings where title like 'TR %' or "organizerId"=$1`, [mgr]);
  for (const m of old) {
    await q(`delete from meeting_participation where "meetingId"=$1`, [m.id]).catch(() => {});
    await q(`delete from meeting_tracking where "meetingId"=$1`, [m.id]).catch(() => {});
    await q(`delete from meeting_responses where "meetingId"=$1`, [m.id]).catch(() => {});
    await q(`delete from meeting_attendees where "meetingId"=$1`, [m.id]);
    await q(`delete from meetings where id=$1`, [m.id]);
  }

  // ---- attendance: days today-14 .. today-1 ----
  const days = Array.from({ length: 14 }, (_, i) => isoDay(i - 14, today));
  const expect = { sessions: { ravi: 0, sana: 0, tina: 0, olga: 0 }, breaks: { ravi: 0, sana: 0 }, lateDay: null };
  const session = async (uid, day, inH, outH, productive, brk) => {
    const sid = crypto.randomUUID();
    await q(`insert into work_sessions (id,"platformId","userId",date,"loginAt","logoutAt",status,"productiveSeconds","breakSeconds","meetingSeconds","createdAt","updatedAt") values ($1,$2,$3,$4,$5,$6,'COMPLETED',$7,$8,0,now(),now())`, [sid, AV, uid, day, ist(day, inH), ist(day, outH), productive, brk]);
    return sid;
  };
  const brk = async (sid, type, day, from, to) => {
    await q(`insert into tracker_breaks (id,"workSessionId","breakType","startedAt","endedAt","durationSeconds","createdAt") values (gen_random_uuid(),$1,$2::"BreakType",$3,$4,$5,now())`, [sid, type, ist(day, from), ist(day, to), Math.round((Date.parse(ist(day, to)) - Date.parse(ist(day, from))) / 1000)]);
  };
  for (const [i, day] of days.entries()) {
    const dow = new Date(day + "T00:00:00Z").getUTCDay();
    if (dow === 0 || dow === 6) continue; // weekends: no sessions
    if (i % 5 === 2) continue; // Ravi is missing on some working days (no attendance record)
    const late = i === 4;
    const sid = await session(ravi, day, late ? "10:20" : "09:30", "18:30", 27000, 3300);
    expect.sessions.ravi++;
    await brk(sid, "TEA", day, "11:00", "11:10"); await brk(sid, "LUNCH", day, "13:00", "13:45"); await brk(sid, "WASHROOM", day, "15:00", "15:05");
    expect.breaks.ravi += 3;
    if (late) {
      expect.lateDay = day;
      await q(`insert into late_remarks (id,"platformId","userId","sessionId",remark,"lateByMinutes") values (gen_random_uuid(),$1,$2,$3,$4,$5)`, [AV, ravi, sid, "Bus was late near the station", 35]).catch(() => {});
    }
  }
  for (const [i, day] of days.entries()) {
    const dow = new Date(day + "T00:00:00Z").getUTCDay();
    if (dow === 0 || dow === 6 || i % 3 !== 0) continue; // Sana worked only some days
    const sid = await session(sana, day, "09:40", "17:40", 25000, 1800);
    expect.sessions.sana++;
    await brk(sid, "PERSONAL", day, "12:30", "13:00");
    expect.breaks.sana += 1;
  }
  // Olga (another manager's employee) has history too: it must never reach Meera's report
  const od = days.find((x) => ![0, 6].includes(new Date(x + "T00:00:00Z").getUTCDay()));
  const osid = await session(olga, od, "09:30", "18:00", 26000, 1800); expect.sessions.olga++;
  await brk(osid, "TEA", od, "11:00", "11:20");

  // ---- tasks: backdated; one rated 5 stars ----
  const task = async (uid, day, title, over) => {
    const id = crypto.randomUUID();
    await q(`insert into daily_tasks (id,"platformId","userId","teamId",date,title,description,weight,status,"approvalStatus","completedAt","rejectionNote","completionNote","createdAt","updatedAt") values ($1,$2,$3,$4,$5,$6,$7,$8::"TaskWeight",$9::"TaskStatus",$10::"TaskApprovalStatus",$11,$12,$13,now(),now())`,
      [id, AV, uid, team, day, title, over.description ?? null, over.weight ?? "MEDIUM", over.status, over.approval, over.completedAt ?? null, over.rejectionNote ?? null, over.completionNote ?? null]);
    return id;
  };
  const d3 = days[3], d6 = days[6], d8 = days[8], d10 = days[10];
  const t1 = await task(ravi, d3, "Prepare monthly report", { description: "Collect and summarise figures", weight: "HIGH", status: "COMPLETED", approval: "APPROVED", completedAt: ist(d3, "16:00"), completionNote: "Done, sent to Meera" });
  await task(ravi, d6, "Update client deck", { description: "Slides 4 to 9", status: "IN_PROGRESS", approval: "APPROVED" });
  await task(ravi, d8, "Review pull requests", { description: "Waiting for the manager", status: "PENDING", approval: "PENDING" });
  await task(ravi, d10, "Archive old files", { description: "Not needed now", status: "PENDING", approval: "REJECTED", rejectionNote: "Please do this next quarter" });
  await task(sana, d6, "Reconcile vendor invoices", { description: "October invoices", weight: "LOW", status: "COMPLETED", approval: "APPROVED", completedAt: ist(d6, "15:30") });
  await q(`insert into task_ratings ("taskId","platformId",rating,comment,"ratedById","ratedAt","updatedAt") values ($1,$2,5,$3,$4,now(),now())`, [t1, AV, "Excellent and on time", mgr]).catch(async () => { await q(`insert into task_ratings (id,"taskId","platformId",rating,comment,"ratedById","ratedAt","updatedAt") values (gen_random_uuid(),$1,$2,5,$3,$4,now(),now())`, [t1, AV, "Excellent and on time", mgr]); });
  const expectTasks = { ravi: 4, sana: 1, tina: 0 };

  // ---- meetings: an ordinary meeting and a Team Huddle ----
  const meeting = async (title, day, from, to, attendees, huddle) => {
    const id = crypto.randomUUID();
    await q(`insert into meetings (id,"platformId","organizerId",title,"startsAt","endsAt",status,"createdAt","updatedAt") values ($1,$2,$3,$4,$5,$6,'SCHEDULED',now(),now())`, [id, AV, mgr, title, ist(day, from), ist(day, to)]);
    for (const a of attendees) await q(`insert into meeting_attendees (id,"meetingId","userId","addedAt") values (gen_random_uuid(),$1,$2,now())`, [id, a]);
    if (huddle) await q(`insert into meeting_tracking ("meetingId","platformId","lateAfterMinutes","createdAt") values ($1,$2,5,now())`, [id, AV]).catch(() => {});
    return id;
  };
  const m1 = await meeting("TR Daily stand-up", days[5], "09:45", "10:00", [ravi, sana, tina], true);
  await q(`insert into meeting_participation (id,"meetingId","platformId","userId","joinedAt","leftAt","durationSeconds",source,"endedBy","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,$4,$5,$6,'SELF','SELF',now(),now())`, [m1, AV, ravi, ist(days[5], "09:46"), ist(days[5], "09:58"), 720]).catch(() => {});
  await q(`insert into meeting_participation (id,"meetingId","platformId","userId","joinedAt","leftAt","durationSeconds",source,"endedBy","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,$4,$5,$6,'SELF','SELF',now(),now())`, [m1, AV, sana, ist(days[5], "09:50"), ist(days[5], "10:00"), 600]).catch(() => {});
  const m2 = await meeting("TR Quarterly planning", days[9], "14:00", "15:00", [ravi, tina], false);
  const expectMeetingRows = { ravi: 2, sana: 1, tina: 2 }; // Tina was invited to both and joined neither

  // ---- leave: approved (with its days), pending, rejected; Sana has none ----
  const leave = async (uid, from, to, type, status, count, reason) => {
    const id = crypto.randomUUID();
    await q(`insert into leave_requests (id,"platformId","userId","fromDate","toDate","leaveType","isHalfDay","isFirstHalf","dayCount",reason,status,"decidedAt","decidedById","createdAt","updatedAt") values ($1,$2,$3,$4,$5,$6::"LeaveDayType",false,true,$7,$8,$9::"LeaveRequestStatus",$10,$11,now(),now())`, [id, AV, uid, from, to, type, count, reason, status, status === "PENDING" ? null : new Date().toISOString(), status === "PENDING" ? null : adm]);
    return id;
  };
  const l1 = await leave(ravi, days[10], days[11], "CASUAL", "APPROVED", 2, "Family function");
  for (const dd of [days[10], days[11]]) await q(`insert into leave_days (id,"platformId","userId",date,"leaveType","isHalfDay","isFirstHalf","markedById","leaveRequestId","createdAt") values (gen_random_uuid(),$1,$2,$3,'CASUAL',false,true,$4,$5,now())`, [AV, ravi, dd, adm, l1]).catch(async () => { await q(`insert into leave_days (id,"platformId","userId",date,"leaveType","markedById","leaveRequestId") values (gen_random_uuid(),$1,$2,$3,'CASUAL',$4,$5)`, [AV, ravi, dd, adm, l1]); });
  await leave(ravi, days[12], days[12], "SICK", "PENDING", 1, "Fever, waiting for approval");
  await leave(ravi, days[7], days[7], "EARNED", "REJECTED", 1, "Short notice");

  // ---- an attendance correction for Sana ----
  await q(`insert into attendance_correction_requests (id,"platformId","userId",date,"correctionType","requestedLoginAt","requestedLogoutAt",reason,status,"reviewedById","reviewedAt","reviewComment","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,'MISSING_CHECKIN',$4,$5,$6,'APPROVED',$7,now(),'Checked with the gate log',now(),now())`, [AV, sana, days[3], ist(days[3], "09:30"), ist(days[3], "17:30"), "The biometric machine did not scan me in", adm]).catch(() => {});

  return { today, days, ids: { adm, mgr, mgr2, ravi, sana, tina, olga, team }, expect: { ...expect, tasks: expectTasks, meetingRows: expectMeetingRows }, pw: PW };
}
module.exports = { seed, ist, isoDay, todayIst, PW };
