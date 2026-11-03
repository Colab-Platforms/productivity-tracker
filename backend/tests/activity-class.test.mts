// Activity classification: break vs washroom (neutral). No database.
import { awayOf, awayRows, classOfBreakType, classOfRow, discussionRemark, isCountedBreak, isDiscussion, isWashroom, splitAwayTime } from "../src/modules/tracker/activityClass.js";
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

console.log("\n## discussion (Meeting / Team Huddle from the activity menu): productive, not break, not washroom");
const disc = (from: number, to: number | null, reason = "Discussion: with my manager") => ({ breakType: "OTHER", reason, startedAt: at(from), endedAt: to === null ? null : at(to) });
ok("an OTHER row whose reason starts with 'Discussion: ' is a discussion", isDiscussion(disc(0, 5)) && classOfRow(disc(0, 5)) === "PRODUCTIVE");
ok("the remark is read back without the marker", discussionRemark(disc(0, 5)) === "with my manager");
ok("the system's own OTHER row (away between clock-out and clock-in) is still a break", !isDiscussion({ breakType: "OTHER", reason: "Away between clock-out and clock-in" }) && isCountedBreak({ breakType: "OTHER", reason: "Away between clock-out and clock-in" }));
ok("a plain OTHER row with no reason is a break", classOfRow({ breakType: "OTHER" }) === "BREAK");
ok("a Tea row can never be a discussion, whatever its reason says", !isDiscussion({ breakType: "TEA", reason: "Discussion: x" }));
ok("a discussion is not a counted break and not washroom", !isCountedBreak(disc(0, 5)) && !isWashroom(disc(0, 5)));
const mix = [row("TEA", 0, 10), row("WASHROOM", 20, 27), disc(30, 50), row("LUNCH", 60, 80)];
const sm = splitAwayTime(mix, at(120));
ok("break = tea + lunch = 30 min (the 20 min discussion is NOT in it)", sm.breakSeconds === 30 * 60);
ok("washroom = 7 min", sm.washroomSeconds === 7 * 60);
ok("discussion = 20 min, on its own", sm.discussionSeconds === 20 * 60);
ok("productive = on site - break - washroom = 83 min (the discussion stays inside productive)", 120 * 60 - sm.breakSeconds - sm.washroomSeconds === 83 * 60);
ok("time on site = productive + break + washroom (discussion not added again)", 83 * 60 + sm.breakSeconds + sm.washroomSeconds === 120 * 60);
ok("awayRows drops the discussion so a scheduled-huddle calculation never subtracts it", awayRows(mix).length === 3 && !awayRows(mix).some(isDiscussion));
ok("an open discussion runs to now and is still not break", splitAwayTime([disc(100, null)], at(110)).discussionSeconds === 600 && splitAwayTime([disc(100, null)], at(110)).breakSeconds === 0);
ok("awayOf carries the discussion figure", awayOf({ breakSeconds: 0, breaks: mix }, at(120)).discussionSeconds === 20 * 60);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
