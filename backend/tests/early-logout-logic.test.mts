// Early Logout Policy (2nd and 4th Saturday): the rules that need no database.
import assert from "node:assert/strict";
import {
  checkPolicyInput, earlyLogoutLabel, earlyLogoutSaturdaysOf, formatTime12, isEarlyLogoutDay, isSecondOrFourthSaturday, parseHHMM,
  saturdayNumber, scheduleRatio, scheduledEndMinutes, stayedUntil, earlyDayTargetSeconds, POLICY_OFF,
} from "../src/modules/attendance/earlyLogout.logic.js";

let pass = 0, fail = 0;
const t = (n: string, f: () => void) => { try { f(); pass++; console.log("PASS " + n); } catch (e) { fail++; console.log("FAIL " + n + " -> " + (e as Error).message); } };
// IST wall-clock time on a day, as the instant stored in the database
const ist = (day: string, hhmm: string) => new Date(Date.parse(`${day}T${hhmm}:00+05:30`));

t("known months: Nov 2026 -> 14 and 28; Aug 2026 (starts on a Saturday) -> 8 and 22; Feb 2028 (leap) -> 12 and 26", () => {
  assert.deepEqual(earlyLogoutSaturdaysOf(2026, 11), ["2026-11-14", "2026-11-28"]);
  assert.deepEqual(earlyLogoutSaturdaysOf(2026, 8), ["2026-08-08", "2026-08-22"]);
  assert.deepEqual(earlyLogoutSaturdaysOf(2028, 2), ["2028-02-12", "2028-02-26"]);
  assert.deepEqual(earlyLogoutSaturdaysOf(2026, 12), ["2026-12-12", "2026-12-26"]);
});
t("independent check over 20 years: always exactly two dates a month, both Saturdays, the 2nd and the 4th counted one by one", () => {
  for (let y = 2020; y <= 2040; y++) for (let m = 1; m <= 12; m++) {
    const got = earlyLogoutSaturdaysOf(y, m);
    assert.equal(got.length, 2, `${y}-${m}`);
    const sats: string[] = [];
    const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
    for (let d = 1; d <= days; d++) if (new Date(Date.UTC(y, m - 1, d)).getUTCDay() === 6) sats.push(`${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
    assert.deepEqual(got, [sats[1], sats[3]], `${y}-${m}`);
  }
});
t("a fifth Saturday, the 1st and the 3rd are NOT early-logout days; weekdays and Sundays never are", () => {
  assert.equal(isSecondOrFourthSaturday("2026-08-01"), false); // 1st
  assert.equal(isSecondOrFourthSaturday("2026-08-15"), false); // 3rd
  assert.equal(isSecondOrFourthSaturday("2026-08-29"), false); // 5th
  assert.equal(isSecondOrFourthSaturday("2026-11-13"), false); // Friday
  assert.equal(isSecondOrFourthSaturday("2026-11-15"), false); // Sunday
  assert.equal(saturdayNumber("2026-08-29"), 5);
  assert.equal(saturdayNumber("2026-11-14"), 2);
  assert.equal(saturdayNumber("not a date"), 0);
  assert.equal(saturdayNumber("2026-02-30"), 0);
});
t("the policy only applies when it is on, from its start date, and never before it", () => {
  const on = { enabled: true, logoutTime: "16:00", startDate: "2026-11-14", targetHours: null };
  assert.equal(isEarlyLogoutDay(on, "2026-11-14"), true);
  assert.equal(isEarlyLogoutDay(on, "2026-11-28"), true);
  assert.equal(isEarlyLogoutDay(on, "2026-10-24"), false, "an earlier 4th Saturday is history and is not touched");
  assert.equal(isEarlyLogoutDay(on, "2026-11-21"), false, "a 3rd Saturday");
  assert.equal(isEarlyLogoutDay({ ...on, enabled: false }, "2026-11-14"), false);
  assert.equal(isEarlyLogoutDay(POLICY_OFF, "2026-11-14"), false);
  assert.equal(isEarlyLogoutDay({ ...on, startDate: null }, "2026-11-14"), false);
  assert.equal(isEarlyLogoutDay({ ...on, logoutTime: "bad" }, "2026-11-14"), false);
});
t("logout exactly at 4:00 PM counts; 3:59 PM does not; after 4 PM counts", () => {
  assert.equal(stayedUntil(ist("2026-11-14", "16:00"), "2026-11-14", "16:00"), true);
  assert.equal(stayedUntil(ist("2026-11-14", "15:59"), "2026-11-14", "16:00"), false);
  assert.equal(stayedUntil(ist("2026-11-14", "16:01"), "2026-11-14", "16:00"), true);
  assert.equal(stayedUntil(ist("2026-11-14", "19:00"), "2026-11-14", "16:00"), true);
  assert.equal(stayedUntil(ist("2026-11-15", "00:30"), "2026-11-14", "16:00"), true, "worked past midnight");
  assert.equal(stayedUntil(ist("2026-11-13", "23:00"), "2026-11-14", "16:00"), false);
  assert.equal(stayedUntil(null, "2026-11-14", "16:00"), false, "no logout = not judged");
});
t("times are read in IST, not the machine's zone (4 PM IST is 10:30 UTC)", () => {
  assert.equal(stayedUntil(new Date("2026-11-14T10:30:00Z"), "2026-11-14", "16:00"), true);
  assert.equal(stayedUntil(new Date("2026-11-14T10:29:00Z"), "2026-11-14", "16:00"), false);
});
t("label and 12-hour format", () => {
  assert.equal(formatTime12("16:00"), "4:00 PM");
  assert.equal(formatTime12("12:00"), "12:00 PM");
  assert.equal(formatTime12("09:05"), "9:05 AM");
  assert.equal(earlyLogoutLabel("16:00"), "Early Logout – 4:00 PM");
  assert.equal(parseHHMM("24:00"), null);
  assert.equal(parseHHMM("16:60"), null);
});
t("the scheduled end on an early Saturday is the earlier of the shift end and the policy time", () => {
  assert.equal(scheduledEndMinutes("19:00", "16:00"), 16 * 60);
  assert.equal(scheduledEndMinutes("15:00", "16:00"), 15 * 60);
  assert.equal(scheduledEndMinutes(null, "16:00"), 16 * 60);
  assert.equal(scheduledEndMinutes("19:00", "nope"), null);
});
t("target scaling: 10-19 shift on a 16:00 day = 6/9; never scaled up, never guessed", () => {
  assert.ok(Math.abs(scheduleRatio({ startTime: "10:00", endTime: "19:00" }, "16:00") - 6 / 9) < 1e-9);
  assert.equal(scheduleRatio({ startTime: "10:00", endTime: "15:00" }, "16:00"), 1, "shift already ends before the policy time");
  assert.equal(scheduleRatio({ startTime: "10:00", endTime: "19:00", spansMidnight: true }, "16:00"), 1);
  assert.equal(scheduleRatio(null, "16:00"), 1);
  assert.equal(scheduleRatio({ startTime: "17:00", endTime: "22:00" }, "16:00"), 1, "policy time before the shift even starts");
  assert.equal(scheduleRatio({ startTime: "bad", endTime: "19:00" }, "16:00"), 1);
});
t("admin input: valid values pass; bad time, bad date, bad switch and 'on without a start date' are refused", () => {
  assert.deepEqual(checkPolicyInput({ enabled: true, logoutTime: "16:00", startDate: "2026-11-14" }), { ok: true, enabled: true, logoutTime: "16:00", startDate: "2026-11-14", targetHours: null });
  assert.deepEqual(checkPolicyInput({ enabled: false, logoutTime: " 4:00 ", startDate: "" }), { ok: false, error: "BAD_TIME" }, "4:00 is 4 AM, outside the allowed range");
  assert.deepEqual(checkPolicyInput({ enabled: false, logoutTime: "16:30", startDate: null }), { ok: true, enabled: false, logoutTime: "16:30", startDate: null, targetHours: null });
  assert.deepEqual(checkPolicyInput({ enabled: "yes", logoutTime: "16:00", startDate: "2026-11-14" }), { ok: false, error: "BAD_ENABLED" });
  assert.deepEqual(checkPolicyInput({ enabled: true, logoutTime: "19:00", startDate: "2026-11-14" }), { ok: false, error: "BAD_TIME" });
  assert.deepEqual(checkPolicyInput({ enabled: true, logoutTime: "11:59", startDate: "2026-11-14" }), { ok: false, error: "BAD_TIME" });
  assert.deepEqual(checkPolicyInput({ enabled: true, logoutTime: "16:00", startDate: "14-11-2026" }), { ok: false, error: "BAD_START_DATE" });
  assert.deepEqual(checkPolicyInput({ enabled: true, logoutTime: "16:00", startDate: "2026-02-30" }), { ok: false, error: "BAD_START_DATE" });
  assert.deepEqual(checkPolicyInput({ enabled: true, logoutTime: "16:00" }), { ok: false, error: "START_DATE_REQUIRED" });
});

t("a target set in the policy applies to everyone with no shift needed; without one the shift scales it; unknown shift stays unscaled", () => {
  const withTarget = { enabled: true, logoutTime: "16:00", startDate: "2026-11-14", targetHours: 5.25 };
  const noTarget = { ...withTarget, targetHours: null };
  assert.equal(earlyDayTargetSeconds(withTarget, 28800, null), 18900);
  assert.equal(earlyDayTargetSeconds(withTarget, 28800, { startTime: "10:00", endTime: "19:00" }), 18900, "the policy figure wins over the shift");
  assert.equal(earlyDayTargetSeconds(noTarget, 28800, { startTime: "10:00", endTime: "19:00" }), 19200);
  assert.equal(earlyDayTargetSeconds(noTarget, 28800, null), 28800, "no shift and no figure: nothing is guessed");
});
t("admin input: expected hours is optional, 1 to 12 in quarter hours", () => {
  const base = { enabled: true, logoutTime: "16:00", startDate: "2026-11-14" };
  assert.deepEqual(checkPolicyInput({ ...base, targetHours: 5.25 }), { ok: true, enabled: true, logoutTime: "16:00", startDate: "2026-11-14", targetHours: 5.25 });
  assert.deepEqual(checkPolicyInput({ ...base, targetHours: "6" }), { ok: true, enabled: true, logoutTime: "16:00", startDate: "2026-11-14", targetHours: 6 });
  for (const blank of [undefined, null, ""]) assert.equal((checkPolicyInput({ ...base, targetHours: blank }) as { targetHours: number | null }).targetHours, null);
  for (const bad of [0.5, 0, -2, 13, "abc", 5.1, NaN, true, {}]) assert.deepEqual(checkPolicyInput({ ...base, targetHours: bad as never }), { ok: false, error: "BAD_TARGET_HOURS" }, String(bad));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
