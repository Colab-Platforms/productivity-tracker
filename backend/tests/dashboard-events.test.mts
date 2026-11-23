// "Events and Meetings" on the HR/Admin dashboards: the same holiday stored once per company must show ONCE; distinct events stay distinct. No database.
import { holidayEvents, upcomingEvents, uniqueById } from "../../frontend/app/dashboard/_dashboard/events.js";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, x?: unknown) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (!c && x !== undefined ? "  -> " + JSON.stringify(x) : "")); };
const today = "2026-11-23";
const companies = Array.from({ length: 12 }, (_, i) => ({ id: `c${i}`, name: `Company ${i}` }));
const H = (date: string, name: string, c: { id: string; name: string }, dayType = "PUBLIC_HOLIDAY") => ({ id: `${c.id}-${date}-${name}`, date, name, dayType, platformId: c.id, company: c.name });

// the live situation: Christmas once per company (12 companies), one of them optional
const rows = [...companies.map((c, i) => H("2026-12-25", "Christmas", c, i === 4 ? "OPTIONAL_HOLIDAY" : "PUBLIC_HOLIDAY")), ...companies.map((c) => H("2027-01-01", "New Year's Day", c))];
const ev = holidayEvents(rows, today);
ok("twelve company rows of one holiday become one event per observance (public, optional), not twelve", ev.filter((e) => e.title === "Christmas").length === 2, ev.map((e) => e.title + e.detail));
const pub = ev.find((e) => e.title === "Christmas" && !/Optional/.test(e.detail ?? ""));
ok("the public Christmas says it applies to 11 companies", pub?.detail === "11 companies", pub);
ok("the optional Christmas is its own entry, marked optional and naming its company", ev.some((e) => e.title === "Christmas" && /Optional/.test(e.detail ?? "") && /Company 4/.test(e.detail ?? "")));
const ny = ev.find((e) => e.title === "New Year's Day");
ok("a holiday every company has says 'All companies'", ny?.detail === "All companies", ny);
ok("chronological: Christmas before New Year", ev.findIndex((e) => e.title === "New Year's Day") > ev.findIndex((e) => e.title === "Christmas"));

// one company only: no company noise
const one = holidayEvents([H("2026-12-25", "Christmas", companies[0]), H("2027-01-01", "New Year's Day", companies[0])], today);
ok("a person in one company sees each holiday once with no company label", one.length === 2 && one.every((e) => !e.detail), one);

// names compared ignoring capitals and spacing; different names or dates are different events
const mixed = holidayEvents([H("2026-12-25", "Christmas", companies[0]), H("2026-12-25", "  christmas ", companies[1]), H("2026-12-25", "Boxing Day", companies[0]), H("2026-12-26", "Christmas", companies[0])], today);
ok("same date, same name (any capitals/spaces) merges; another name on the same date and the same name on another date stay separate", mixed.length === 3, mixed.map((e) => e.date + e.title));
ok("two different holidays on one date are both shown", mixed.filter((e) => e.date === "2026-12-25").length === 2);

// past holidays are dropped, today is kept
const past = holidayEvents([H("2026-11-22", "Yesterday", companies[0]), H("2026-11-23", "Today holiday", companies[0])], today);
ok("a holiday that has passed is not listed; today's is, flagged as today", past.length === 1 && past[0].today === true && past[0].title === "Today holiday", past);

// a duplicate row inside ONE company (same id arriving twice, or an exact twin) is one event
const twin = holidayEvents([H("2026-12-25", "Christmas", companies[0]), H("2026-12-25", "Christmas", companies[0])], today);
ok("an exact duplicate row from the same company is shown once", twin.length === 1 && !twin[0].detail, twin);
ok("no holidays at all gives an empty list (the screen shows its empty state)", holidayEvents([], today).length === 0 && upcomingEvents([], []).length === 0);

// meetings: never merged by name or date, only an identical id is collapsed
const m = (id: string, title: string, date: string, time: string) => ({ id: `m-${id}`, date, time, title, kind: "Meeting" as const, href: `/dashboard/meetings?id=${id}`, today: false });
const meet = [m("1", "Team Meeting", "2026-11-25", "10:00 AM"), m("2", "Team Meeting", "2026-11-25", "03:00 PM"), m("1", "Team Meeting", "2026-11-25", "10:00 AM")];
ok("only the identical meeting id is collapsed; two meetings with the same name and date both stay", uniqueById(meet).length === 2);
const all = upcomingEvents(ev, meet);
ok("holidays and meetings interleave by date, each event on its own row", all.map((e) => e.date).join() === [...all.map((e) => e.date)].sort().join() && all.filter((e) => e.kind === "Meeting").length === 2, all.map((e) => e.date + e.title));
ok("the list is capped at six rows", upcomingEvents(Array.from({ length: 10 }, (_, i) => ({ id: `x${i}`, date: `2026-12-${String(i + 1).padStart(2, "0")}`, title: `E${i}`, kind: "Holiday" as const, href: "/", today: false })), []).length === 6);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
