// Automatic task timer: the pure rules. No database.
import { computeTimer, mergeIntervals, intersectIntervals, subtractIntervals, unionSeconds, formatDuration, type Interval } from "../src/modules/tasks/tasks.timer.logic.js";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, x?: unknown) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (!c && x !== undefined ? "  -> " + JSON.stringify(x) : "")); };
const T = (h: number, m = 0, s = 0) => Date.UTC(2026, 10, 24, h, m, s); // 24 Nov 2026, UTC
const day: Interval[] = [[T(9), T(18)]]; // clocked in 09:00-18:00
const run = (sessions: [number, number | null][], o: { clockedIn?: Interval[]; away?: Interval[]; now?: number; completedAt?: number | null; status?: string } = {}) =>
  computeTimer({ sessions: sessions.map(([startedAt, endedAt]) => ({ startedAt, endedAt })), clockedIn: o.clockedIn ?? day, away: o.away ?? [], now: o.now ?? T(17), completedAt: o.completedAt ?? null, status: o.status ?? "IN_PROGRESS" });

console.log("## interval maths");
ok("overlapping and touching intervals merge into one", JSON.stringify(mergeIntervals([[5, 9], [1, 3], [3, 4], [8, 12]])) === "[[1,4],[5,12]]");
ok("intersection keeps only the common parts", JSON.stringify(intersectIntervals([[0, 10], [20, 30]], [[5, 25]])) === "[[5,10],[20,25]]");
ok("subtraction removes the removed parts", JSON.stringify(subtractIntervals([[0, 10]], [[2, 3], [5, 7]])) === "[[0,2],[3,5],[7,10]]");
ok("two tasks running at the same time are counted ONCE for the person", unionSeconds([[[T(10), T(12)]], [[T(11), T(13)]]]) === 3 * 3600);
ok("duration wording: 02h 14m 35s", formatDuration(2 * 3600 + 14 * 60 + 35) === "02h 14m 35s" && formatDuration(0) === "00h 00m 00s");

console.log("\n## status-driven sessions");
const one = run([[T(10), null]], { now: T(10, 0, 3) });
ok("In Progress for 3 seconds shows 00:00:03 and is running", one.activeSeconds === 3 && one.running && one.tracked && one.firstStartedAt === T(10), one);
const paused = run([[T(10), T(11)]], { now: T(14) });
ok("after a pause (session closed) the time stops: 1h, not running, 'not paused by a break'", paused.activeSeconds === 3600 && !paused.running && paused.pausedReason === null, paused);
const resumed = run([[T(10), T(11)], [T(13), null]], { now: T(13, 30) });
ok("resuming continues from what was accumulated: 1h + 30m = 1h30m (never reset to zero)", resumed.activeSeconds === 5400 && resumed.running && resumed.sessionCount === 2, resumed);
ok("elapsed counts from the FIRST start, paused time is the gap between the sessions", resumed.elapsedSeconds === 3.5 * 3600 && resumed.pausedSeconds === 2 * 3600, resumed);
const done = run([[T(10), T(11)], [T(13), T(14, 15)]], { now: T(17), status: "COMPLETED", completedAt: T(14, 15) });
ok("submitted: the timer is stopped and the totals are saved: active 2h15m, elapsed 4h15m, paused 2h, submitted at 14:15", done.activeSeconds === 8100 && done.elapsedSeconds === 15300 && done.pausedSeconds === 7200 && done.lastSubmittedAt === T(14, 15) && !done.running, done);
ok("a task never started is Not tracked (nothing is invented)", run([]).tracked === false && run([]).activeSeconds === 0);

console.log("\n## breaks and clock-out");
const lunch = run([[T(10), null]], { away: [[T(13), T(14)]], now: T(15) });
ok("a lunch hour inside the session is taken out: 10:00-15:00 minus 1h = 4h", lunch.activeSeconds === 4 * 3600, lunch);
const onBreak = run([[T(10), null]], { away: [[T(12), T(12, 30)], [T(14), T(15)]], now: T(14, 30) });
ok("while the person is ON a break the clock is not running, the reason says Break, and the time so far is 10:00-14:00 minus the 30 minutes earlier = 3h30m", !onBreak.running && onBreak.pausedReason === "BREAK" && onBreak.activeSeconds === 12600, onBreak);
const clockedOut = run([[T(10), null]], { clockedIn: [[T(9), T(16)]], now: T(17) });
ok("after clock-out the clock stops: 10:00-16:00 = 6h, the 16:00-17:00 is not counted, reason Clocked out", clockedOut.activeSeconds === 6 * 3600 && !clockedOut.running && clockedOut.pausedReason === "CLOCKED_OUT", clockedOut);
const overnight = run([[T(17), null]], { clockedIn: [[T(9), T(18)], [Date.UTC(2026, 10, 25, 9), Date.UTC(2026, 10, 25, 12)]], now: Date.UTC(2026, 10, 25, 11) });
ok("a task left In Progress overnight does not collect the night: 17:00-18:00 (1h) + 09:00-11:00 next day (2h) = 3h", overnight.activeSeconds === 3 * 3600 && overnight.running, overnight);
ok("returning from a break resumes the same task (it is still In Progress): the clock runs again", run([[T(10), null]], { away: [[T(12), T(12, 30)]], now: T(13) }).running);
const dbl = run([[T(10), T(12)], [T(11), T(13)]], { now: T(14) });
ok("overlapping sessions of one task are never double counted (10:00-13:00 = 3h)", dbl.activeSeconds === 3 * 3600, dbl);
ok("a break longer than the session leaves zero, never negative", run([[T(10), T(11)]], { away: [[T(9), T(12)]] }).activeSeconds === 0);
ok("elapsed is never less than the active time", (() => { const r = run([[T(10), T(11)]], { now: T(10, 30) }); return r.elapsedSeconds >= r.activeSeconds; })());

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
