// The name of the in-person meeting feature depends on who is looking (owner's request, 2026-11-22): Admin accounts see "Team Meet",
// everyone else (Employee, Manager, HR) keeps "Team Huddle". DISPLAY ONLY: the feature, its records, routes and exports are the same.
export const teamHuddleLabel = (role?: string | null): string => (role === "ADMIN" ? "Team Meet" : "Team Huddle");
