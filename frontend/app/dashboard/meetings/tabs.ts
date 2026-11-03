// Team Huddle (the unified Meetings page): which meeting belongs on which tab. Pure rules over the list the server already sends, so the
// tabs are filters, not new data. No server change: Upcoming, Ongoing and Invitations are cut from the "upcoming" scope list, History is the
// "past" or "cancelled" scope.
export type TabKey = "upcoming" | "ongoing" | "invitations" | "history" | "participation" | "overview";
export const TAB_KEYS: TabKey[] = ["upcoming", "ongoing", "invitations", "history", "participation", "overview"];

export type TabMeeting = {
  state: "upcoming" | "ongoing" | "past" | "cancelled";
  isOrganizer?: boolean;
  canRespond?: boolean;
  myResponse?: "ACCEPTED" | "DECLINED" | null;
  me?: { state?: string } | null;
};

/** A meeting that is happening now, or one whose scheduled end passed while the person is still marked in it (so End is always reachable). */
export const isOngoing = (m: TabMeeting) => m.state === "ongoing" || (m.state === "past" && m.me?.state === "IN_MEETING");

/** Not started yet. */
export const isUpcoming = (m: TabMeeting) => m.state === "upcoming";

/** An invitation still waiting for this person's Accept or Decline: they are invited (not the organizer), it is not over, and they have not answered. */
export const isInvitation = (m: TabMeeting) =>
  !m.isOrganizer && (m.state === "upcoming" || m.state === "ongoing") && m.canRespond === true && (m.myResponse === null || m.myResponse === undefined);

export function forTab<T extends TabMeeting>(meetings: T[], tab: TabKey): T[] {
  if (tab === "upcoming") return meetings.filter(isUpcoming);
  if (tab === "ongoing") return meetings.filter(isOngoing);
  if (tab === "invitations") return meetings.filter(isInvitation);
  return meetings;
}

export function tabCounts(meetings: TabMeeting[]) {
  return { upcoming: meetings.filter(isUpcoming).length, ongoing: meetings.filter(isOngoing).length, invitations: meetings.filter(isInvitation).length };
}

/** Which tabs this person gets. Participation is the manager's own huddles; Company overview is HR/Admin's counts-only view. */
export function tabsFor(role: string | undefined): TabKey[] {
  const base: TabKey[] = ["upcoming", "ongoing", "invitations", "history"];
  if (role === "MANAGER") return [...base, "participation"];
  if (role === "HR" || role === "ADMIN") return [...base, "overview"];
  return base;
}

/** The tab a ?tab= link asks for, if this person may have it (an unknown or not-allowed tab means the default). */
export function tabFromUrl(param: string | null | undefined, role: string | undefined): TabKey | null {
  const wanted = TAB_KEYS.find((k) => k === param);
  return wanted && tabsFor(role).includes(wanted) ? wanted : null;
}
