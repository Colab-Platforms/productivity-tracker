// Which tabs of the Employees / Admin page each role gets. Pure, so it can be tested on its own. The server enforces the same split on the settings
// it changes (shifts and thresholds are Admin-only writes), so hiding a tab is never the only protection.
//
//   Admin: People, Teams, Shifts, Thresholds, Leave   (the whole page)
//   HR:    People, Leave                              (employee records and leave records; teams/projects, shifts and rules are Admin-only)
//   others: none (the page is not theirs; the server refuses them too)

export const ALL_TABS = ["People", "Teams", "Shifts", "Thresholds", "Leave"] as const;
export type Tab = (typeof ALL_TABS)[number];

export function tabsFor(role: string | null | undefined): Tab[] {
  if (role === "ADMIN") return [...ALL_TABS];
  if (role === "HR") return ["People", "Leave"];
  return [];
}

/** The tab to show: the one asked for if this role may have it, else the first it may have, else null. */
export function tabFor(role: string | null | undefined, wanted: string | null | undefined): Tab | null {
  const allowed = tabsFor(role);
  return allowed.find((t) => t === wanted) ?? allowed[0] ?? null;
}
