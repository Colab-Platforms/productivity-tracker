// "From 10:45 AM" is only enough when that time is today. For a meeting on another day the note must say which day, otherwise a meeting weeks
// away reads as if the Join button opens this morning. Pure (the clock is a parameter) so it can be tested.
const dayKey = (d: Date, tz: string) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
const timeText = (d: Date, tz: string) => new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true }).format(d);
const dayText = (d: Date, tz: string) => new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", day: "numeric", month: "short" }).format(d);

/** "from 10:45 AM" when it opens today, "tomorrow from 10:45 AM", otherwise "on Tue, Dec 8 from 10:45 AM". Days are the company's calendar days. */
export function opensPhrase(opensAtIso: string, tz: string, now: Date = new Date()): string {
  const at = new Date(opensAtIso);
  const t = timeText(at, tz);
  if (dayKey(at, tz) === dayKey(now, tz)) return `from ${t}`;
  const tomorrow = new Date(now.getTime() + 86_400_000);
  if (dayKey(at, tz) === dayKey(tomorrow, tz)) return `tomorrow from ${t}`;
  return `on ${dayText(at, tz)} from ${t}`;
}
