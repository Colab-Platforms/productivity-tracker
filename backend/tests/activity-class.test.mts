// Activity classification: break vs washroom (neutral). No database.
import { awayOf, classOfBreakType, isCountedBreak, isWashroom, splitAwayTime } from "../src/modules/tracker/activityClass.js";
let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n); };

const t0 = new Date("2026-11-03T04:00:00Z");
const at = (min: number) => new Date(t0.getTime() + min * 60_000);
const row = (breakType: string, from: number, to: number | null) => ({ breakType, startedAt: at(from), endedAt: to === null ? null : at(to) });

console.log("\n## classification");
ok("Tea is a break", classOfBreakType("TEA") === "BREAK" && isCountedBreak("TEA"));
ok("Lunch is a break", classOfBreakType("LUNCH") === "BREAK");
ok("Personal is a break", classOfBreakType("PERSONAL") === "BREAK");
ok("Other (e.g. the away-between-clock-out-and-in gap) stays a break", classOfBreakType("OTHER") === "BREAK");
ok("Washroom is NEUTRAL, not a break", classOfBreakType("WASHROOM") === "NEUTRAL" && isWashroom("WASHROOM") && !isCountedBreak("WASHROOM"));

console.log("\n## the split");
const day = [row("TEA", 0, 10), row("LUNCH", 20, 40), row("PERSONAL", 50, 55), row("WASHROOM", 60, 67)];
const s = splitAwayTime(day, at(120));
ok("break = tea + lunch + personal = 35 min", s.breakSeconds === 35 * 60);
ok("washroom = 7 min, on its own", s.washroomSeconds === 7 * 60);
ok("washroom is not inside break", s.breakSeconds !== 42 * 60);
const total = 120 * 60;
ok("productive = on site - break - washroom = 78 min (same as on site minus every away row)", total - s.breakSeconds - s.washroomSeconds === 78 * 60);
ok("time on site = productive + break + washroom (nothing counted twice)", 78 * 60 + s.breakSeconds + s.washroomSeconds === total);

console.log("\n## open rows run until now");
const open = splitAwayTime([row("WASHROOM", 100, null)], at(110));
ok("an open washroom is 10 min of washroom and 0 break", open.washroomSeconds === 600 && open.breakSeconds === 0);
const openTea = splitAwayTime([row("TEA", 100, null)], at(105));
ok("an open tea is 5 min of break and 0 washroom", openTea.breakSeconds === 300 && openTea.washroomSeconds === 0);
ok("no rows = nothing", splitAwayTime([], at(1)).breakSeconds === 0 && splitAwayTime([], at(1)).washroomSeconds === 0);

console.log("\n## older days: rows decide, the stored column is ignored when rows are loaded");
const old = { breakSeconds: 42 * 60 /* stored the old way, washroom inside break */, breaks: day };
ok("an old day with its rows reports break 35 min (not the stored 42)", awayOf(old, at(120)).breakSeconds === 35 * 60);
ok("and washroom 7 min", awayOf(old, at(120)).washroomSeconds === 7 * 60);
ok("without rows loaded it falls back to the stored column", awayOf({ breakSeconds: 600 }, at(1)).breakSeconds === 600 && awayOf({ breakSeconds: 600 }, at(1)).washroomSeconds === 0);
ok("rows loaded but empty: the stored column is the only record, so it is used", awayOf({ breakSeconds: 1800, breaks: [] }, at(1)).breakSeconds === 1800);
ok("a day that never had a washroom is unchanged by the new policy", awayOf({ breakSeconds: 1500, breaks: [row("TEA", 0, 25)] }, at(60)).breakSeconds === 1500);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
