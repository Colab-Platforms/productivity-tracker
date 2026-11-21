// Break Management rules (pure, no DB).
import { aggregate, computeDays, monthOf, weekOf, type BreakIn, type Policy } from "../src/modules/break-monitor/breakMonitor.logic.ts";
let pass = 0, fail = 0;
const ok = (n: string, c: boolean, x?: unknown) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (!c && x !== undefined ? " -> " + JSON.stringify(x) : "")); };
const T = (hhmm: string, day = "2026-11-20") => new Date(`${day}T${hhmm}:00Z`);
const br = (id: string, user: string, s: string, e: string | null, extra: Partial<BreakIn> = {}): BreakIn => ({ id, userId: user, day: "2026-11-20", breakType: "LUNCH", startedAt: T(s), endedAt: e ? T(e) : null, ...extra });
const pol = (a: number | null): Policy => ({ allowanceSeconds: a === null ? null : a * 60 });
const now = T("15:00");

let r = computeDays([br("1", "u", "10:00", "10:30"), br("2", "u", "13:00", "13:40")], () => pol(60), now);
ok("two breaks 30 + 40 min = 70 min that day", r.days[0].seconds === 70 * 60);
ok("the day is exceeded (70 > 60) with 10 min excess", r.days[0].exceeded && r.days[0].excessSeconds === 600);
const second = r.breaks.find((b) => b.id === "2")!, first = r.breaks.find((b) => b.id === "1")!;
ok("the first break is within the allowance (no excess, Completed)", first.excessSeconds === 0 && first.status === "COMPLETED");
ok("the second break carries the 10 min beyond the allowance (Exceeded)", second.excessSeconds === 600 && second.status === "EXCEEDED");
r = computeDays([br("1", "u", "10:00", "11:00")], () => pol(60), now);
ok("exactly the allowance is not exceeded", !r.days[0].exceeded && r.days[0].excessSeconds === 0);
r = computeDays([br("1", "u", "10:00", "11:01")], () => pol(60), now);
ok("one minute over is exceeded (no tolerance is added)", r.days[0].exceeded && r.days[0].excessSeconds === 60);

// the owner's example: Break Time 60; Mon 45, Tue 70, Wed 50, Thu 65 (one week)
{
  const day = (d: string, mins: number): BreakIn => ({ id: d, userId: "x", day: d, breakType: "LUNCH", startedAt: T("10:00", d), endedAt: new Date(T("10:00", d).getTime() + mins * 60e3) });
  const wk = computeDays([day("2026-11-16", 45), day("2026-11-17", 70), day("2026-11-18", 50), day("2026-11-19", 65)], () => pol(60), now);
  const res = aggregate(wk.days, wk.breaks, new Map([["x", new Set(["2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19"])]]), () => pol(60))[0];
  ok("example: Monday 45 and Wednesday 50 are within the limit", !wk.days.find((x) => x.day === "2026-11-16")!.exceeded && !wk.days.find((x) => x.day === "2026-11-18")!.exceeded);
  ok("example: Tuesday exceeded by 10 min, Thursday by 5 min", wk.days.find((x) => x.day === "2026-11-17")!.excessSeconds === 600 && wk.days.find((x) => x.day === "2026-11-19")!.excessSeconds === 300);
  ok("example: a defaulter, 2 violation days, 15 min total excess", res.defaulter && res.daysExceeded === 2 && res.excessSeconds === 900, res);
  ok("example: the violations list the exact dates, allowed, actual and excess", JSON.stringify(res.violations) === JSON.stringify([{ day: "2026-11-17", allowanceSeconds: 3600, actualSeconds: 4200, excessSeconds: 600 }, { day: "2026-11-19", allowanceSeconds: 3600, actualSeconds: 3900, excessSeconds: 300 }]), res.violations);
  ok("example: judged day by day, not against a weekly total (240 min = the weekly allowance, still a defaulter)", res.seconds === 230 * 60 && res.permittedSeconds === 240 * 60 && res.defaulter);
  const one = aggregate(computeDays([day("2026-11-17", 61)], () => pol(60), now).days, [], new Map(), () => pol(60))[0];
  ok("one day over in the period is enough (repeats are not required)", one.defaulter && one.daysExceeded === 1);
}
r = computeDays([br("1", "u", "14:30", null)], () => pol(60), now);
ok("an open break: Currently on break, counted to now (30 min), no end time invented", r.breaks[0].status === "ACTIVE" && r.breaks[0].seconds === 1800 && r.breaks[0].endedAt === null && r.days[0].open);
r = computeDays([br("1", "u", "10:00", "10:30"), br("2", "u", "10:20", "10:50")], () => pol(60), now);
ok("overlapping intervals are counted once (10:00-10:50 = 50 min)", r.days[0].seconds === 3000, r.days[0].seconds);
r = computeDays([br("1", "u", "10:00", "10:30"), br("1", "u", "10:00", "10:30")], () => pol(60), now);
ok("the same row twice is counted once", r.days[0].seconds === 1800 && r.breaks.length === 1);
r = computeDays([br("1", "u", "10:00", "12:00", { correctedDurationSeconds: 900 })], () => pol(60), now);
ok("an Admin correction wins over the timestamps (15 min, not 2 h)", r.days[0].seconds === 900 && !r.days[0].exceeded);
r = computeDays([br("1", "u", "10:00", "12:00")], () => pol(null), now);
ok("no allowance configured: never exceeded, excess blank (Not configured)", !r.days[0].exceeded && r.days[0].excessSeconds === null && r.breaks[0].excessSeconds === null && r.breaks[0].status === "COMPLETED");

const rows = [br("1", "a", "10:00", "11:30"), br("2", "b", "10:00", "10:20"), { ...br("3", "a", "10:00", "10:10"), day: "2026-11-19", startedAt: T("10:00", "2026-11-19"), endedAt: T("10:10", "2026-11-19") }];
const d = computeDays(rows, () => pol(60), now);
const present = new Map([["a", new Set(["2026-11-18", "2026-11-19", "2026-11-20"])], ["b", new Set(["2026-11-20"])], ["c", new Set(["2026-11-20"])]]);
const agg = aggregate(d.days, d.breaks, present, () => pol(60));
const A = agg.find((x) => x.userId === "a")!, B = agg.find((x) => x.userId === "b")!, C = agg.find((x) => x.userId === "c")!;
ok("person totals: a has 2 breaks, 100 min, 3 days present, permitted 180 min", A.breaks === 2 && A.seconds === 6000 && A.daysPresent === 3 && A.permittedSeconds === 180 * 60, A);
ok("a exceeded on 1 day, 30 min excess, 1 incident, is a defaulter", A.daysExceeded === 1 && A.excessSeconds === 1800 && A.incidents === 1 && A.defaulter);
ok("b stayed within: not a defaulter", !B.defaulter && B.excessSeconds === 0);
ok("c was present with no breaks: listed with 0 breaks, not a defaulter", C.breaks === 0 && !C.defaulter && C.daysPresent === 1);
ok("average daily break uses days present (100 min / 3 = 33.3 min)", A.avgDailySeconds === 2000);
ok("week of a Friday = Monday..Sunday", JSON.stringify(weekOf("2026-11-20")) === JSON.stringify({ from: "2026-11-16", to: "2026-11-22" }));
ok("week of a Monday starts that day; of a Sunday ends that day", weekOf("2026-11-16").from === "2026-11-16" && weekOf("2026-11-22").to === "2026-11-22");
ok("month bounds incl. February of a leap year", JSON.stringify(monthOf("2028-02-10")) === JSON.stringify({ from: "2028-02-01", to: "2028-02-29" }) && monthOf("2026-11-20").to === "2026-11-30");
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
