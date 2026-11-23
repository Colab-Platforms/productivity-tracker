// The "Events and Meetings" list on the HR and Admin dashboards. Pure rules, no fetching, so they can be tested on their own.
//
// WHY THIS EXISTS: holidays are stored once PER COMPANY (the same Christmas is a separate row for each company, as it should be: each company
// owns its calendar and can make it public or optional). An HR or Admin who acts on several companies is sent all of those rows, and the widget
// listed every row, so one holiday filled the whole list. Here the rows are folded into ONE event per real holiday: same date, same name and
// same kind of observance (public / optional). A different date, a different name or a different observance is a different event and is kept.
// Meetings are never merged by name or date; only the very same meeting id arriving twice is collapsed.
import type { EventItem } from "./widgets";

export type HolidayRow = { id: string; date: string; name: string; dayType?: string; platformId?: string; company?: string | null };

const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

const OBSERVANCE: Record<string, string> = { PUBLIC_HOLIDAY: "Public holiday", OPTIONAL_HOLIDAY: "Optional holiday" };

/** One event per distinct upcoming holiday (today included), in date order. */
export function holidayEvents(rows: HolidayRow[], today: string): EventItem[] {
  const upcoming = rows.filter((h) => h.date >= today);
  // how many different companies this person's list covers (to know when naming the company is worth it)
  const everyCompany = new Set(rows.map((h) => h.platformId ?? h.company ?? "").filter(Boolean));
  const groups = new Map<string, { row: HolidayRow; companies: Map<string, string> }>();
  for (const h of upcoming) {
    const key = `${h.date}|${norm(h.name)}|${h.dayType ?? ""}`;
    const g = groups.get(key) ?? { row: h, companies: new Map<string, string>() };
    g.companies.set(h.platformId ?? h.id, h.company ?? "");
    groups.set(key, g);
  }
  return [...groups.entries()]
    .map(([key, g]): EventItem => {
      const n = g.companies.size;
      const parts: string[] = [];
      if (g.row.dayType && g.row.dayType !== "PUBLIC_HOLIDAY") parts.push((OBSERVANCE[g.row.dayType] ?? "Holiday").replace(/ holiday$/i, ""));
      if (n > 1) parts.push(n === everyCompany.size ? "All companies" : `${n} companies`);
      else if (everyCompany.size > 1) { const name = [...g.companies.values()][0]; if (name) parts.push(name); }
      return { id: `h-${key}`, date: g.row.date, title: g.row.name, kind: "Holiday", href: "/dashboard/holidays", today: g.row.date === today, detail: parts.join(" · ") || undefined };
    })
    .sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
}

/** Meetings keep their own identity: only the same id twice is collapsed. */
export function uniqueById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((i) => (seen.has(i.id) ? false : (seen.add(i.id), true)));
}

/** Holidays and meetings together: chronological, each distinct event on its own row, at most `limit`. */
export function upcomingEvents(holidays: EventItem[], meetings: EventItem[], limit = 6): EventItem[] {
  return [...holidays, ...uniqueById(meetings)]
    .sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? "") || a.title.localeCompare(b.title))
    .slice(0, limit);
}
