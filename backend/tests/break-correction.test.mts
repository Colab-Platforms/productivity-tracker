// Admin break correction: how a corrected duration flows into the totals. No database.
//   DATABASE_URL=dummy npx tsx tests/break-correction.test.mts
import { awayOf, breakRowSeconds, recordedRowSeconds, splitAwayTime } from "../src/modules/tracker/activityClass.js";
let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n); };

const t0 = new Date("2026-11-11T05:00:00Z");
const at = (min: number) => new Date(t0.getTime() + min * 60_000);
const row = (breakType: string, from: number, to: number | null, corrected: number | null = null) => ({
  breakType, startedAt: at(from), endedAt: to === null ? null : at(to), correctedDurationSeconds: corrected === null ? null : corrected * 60,
});

console.log("\n## the Nov 11 case: a lunch the timer ran for 2h00m, corrected to 55m");
const lunchRaw = row("LUNCH", 0, 120);
const lunchFixed = row("LUNCH", 0, 120, 55);
ok("uncorrected: the row counts 120 min", breakRowSeconds(lunchRaw, at(300)) === 120 * 60);
ok("corrected: the row counts 55 min", breakRowSeconds(lunchFixed, at(300)) === 55 * 60);
ok("the recorded value is still 120 min after a correction (timestamps are never edited)", recordedRowSeconds(lunchFixed, at(300)) === 120 * 60);
ok("the timestamps are untouched", lunchFixed.startedAt.getTime() === at(0).getTime() && lunchFixed.endedAt!.getTime() === at(120).getTime());

console.log("\n## totals follow the corrected value");
const s = splitAwayTime([lunchFixed], at(562));
ok("break total is 55 min", s.breakSeconds === 55 * 60);
const onSite = 562 * 60; // 9h22m clocked in
ok("productive = on site - corrected break = 8h27m", onSite - s.breakSeconds === (8 * 60 + 27) * 60);
ok("uncorrected productive would have been 7h22m", onSite - splitAwayTime([lunchRaw], at(562)).breakSeconds === (7 * 60 + 22) * 60);

console.log("\n## other rows on the day are unaffected");
const mixed = splitAwayTime([row("TEA", 200, 210), lunchFixed, row("WASHROOM", 300, 306)], at(562));
ok("tea 10 + corrected lunch 55 = 65 min of break", mixed.breakSeconds === 65 * 60);
ok("washroom is still 6 min, separate", mixed.washroomSeconds === 6 * 60);

console.log("\n## revert: clearing the correction brings the recorded value back");
const reverted = { ...lunchFixed, correctedDurationSeconds: null };
ok("after revert the row counts 120 min again", breakRowSeconds(reverted, at(300)) === 120 * 60);
ok("a correction of 0 is a real value (not 'no correction')", breakRowSeconds(row("LUNCH", 0, 120, 0), at(300)) === 0);

console.log("\n## safety");
ok("a running break ignores any correction value (only closed breaks can be corrected)", breakRowSeconds(row("LUNCH", 0, null, 10), at(30)) === 30 * 60);
ok("a negative corrected value can never reduce a total below zero", breakRowSeconds({ ...lunchFixed, correctedDurationSeconds: -60 }, at(300)) === 0);
ok("awayOf reads the corrected value from loaded rows", awayOf({ breakSeconds: 120 * 60, breaks: [lunchFixed] }, at(300)).breakSeconds === 55 * 60);
ok("without rows loaded the stored column is used (it is rewritten by recompute on every correction)", awayOf({ breakSeconds: 55 * 60 }, at(300)).breakSeconds === 55 * 60);

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
