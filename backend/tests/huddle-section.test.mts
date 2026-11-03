// Team Huddle = the unified Meetings section: tab rules, the old /dashboard/huddles link, and the single sidebar entry. No database.
import { readFileSync } from "node:fs";
import { forTab, isInvitation, isOngoing, isUpcoming, tabCounts, tabFromUrl, tabsFor } from "../../frontend/app/dashboard/meetings/tabs.js";
import * as huddlesModule from "../../frontend/app/dashboard/huddles/page.js";
// the loader may wrap a default export once more, depending on the package type
const HuddlesRedirect = ((huddlesModule as unknown as { default: unknown }).default as { default?: () => void }).default ?? ((huddlesModule as unknown as { default: () => void }).default);
let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n); };

type M = { id: string; state: "upcoming" | "ongoing" | "past" | "cancelled"; isOrganizer?: boolean; canRespond?: boolean; myResponse?: "ACCEPTED" | "DECLINED" | null; me?: { state?: string } | null };
const meetings: M[] = [
  { id: "future-invited", state: "upcoming", canRespond: true, myResponse: null },
  { id: "future-accepted", state: "upcoming", canRespond: true, myResponse: "ACCEPTED" },
  { id: "future-declined", state: "upcoming", canRespond: true, myResponse: "DECLINED" },
  { id: "future-mine", state: "upcoming", isOrganizer: true },
  { id: "now-invited", state: "ongoing", canRespond: true, myResponse: null },
  { id: "now-joined", state: "ongoing", canRespond: true, myResponse: "ACCEPTED", me: { state: "IN_MEETING" } },
  { id: "over-but-still-in", state: "past", me: { state: "IN_MEETING" } },
  { id: "over-ended", state: "past", me: { state: "ENDED" } },
  { id: "cancelled", state: "cancelled" },
];
const ids = (tab: Parameters<typeof forTab>[1]) => forTab(meetings, tab).map((m) => m.id);

console.log("\n## tabs are filters over one list");
ok("Upcoming = not started yet (4), nothing else", JSON.stringify(ids("upcoming")) === JSON.stringify(["future-invited", "future-accepted", "future-declined", "future-mine"]));
ok("Ongoing = happening now, plus one that ran past its end while you are still in it (End stays reachable)", JSON.stringify(ids("ongoing")) === JSON.stringify(["now-invited", "now-joined", "over-but-still-in"]));
ok("Invitations = only unanswered invites that are not over and not yours", JSON.stringify(ids("invitations")) === JSON.stringify(["future-invited", "now-invited"]));
ok("an accepted or declined invitation leaves Invitations", !isInvitation(meetings[1]) && !isInvitation(meetings[2]));
ok("an organizer never has an invitation to their own meeting", !isInvitation(meetings[3]));
ok("a finished meeting is never an invitation", !isInvitation({ state: "past", canRespond: true, myResponse: null }));
ok("History shows the whole list the server sends for it (past or cancelled)", forTab(meetings, "history").length === meetings.length);
ok("counts match the tabs", JSON.stringify(tabCounts(meetings)) === JSON.stringify({ upcoming: 4, ongoing: 3, invitations: 2 }));
ok("every meeting is in at most one of Upcoming / Ongoing", meetings.every((m) => !(isUpcoming(m) && isOngoing(m))));

console.log("\n## who gets which tab");
ok("employee: Upcoming, Ongoing, Invitations, History", JSON.stringify(tabsFor("EMPLOYEE")) === JSON.stringify(["upcoming", "ongoing", "invitations", "history"]));
ok("manager: the same plus Participation", JSON.stringify(tabsFor("MANAGER")) === JSON.stringify(["upcoming", "ongoing", "invitations", "history", "participation"]));
ok("HR and Admin: the same plus Company overview (counts only)", JSON.stringify(tabsFor("HR")) === JSON.stringify(["upcoming", "ongoing", "invitations", "history", "overview"]) && JSON.stringify(tabsFor("ADMIN")) === JSON.stringify(tabsFor("HR")));
ok("Participation is never offered to HR or an employee", !tabsFor("HR").includes("participation") && !tabsFor("EMPLOYEE").includes("participation"));
ok("a ?tab= link opens its tab for someone who has it", tabFromUrl("participation", "MANAGER") === "participation" && tabFromUrl("overview", "ADMIN") === "overview");
ok("a ?tab= link to a tab you do not have falls back to the default", tabFromUrl("participation", "EMPLOYEE") === null && tabFromUrl("participation", "HR") === null && tabFromUrl("overview", "MANAGER") === null);
ok("an unknown or missing ?tab= is ignored", tabFromUrl("nonsense", "MANAGER") === null && tabFromUrl(null, "MANAGER") === null && tabFromUrl(undefined, undefined) === null);

console.log("\n## the old Team Huddle address");
let target = "";
try { HuddlesRedirect(); } catch (e) { target = String((e as { digest?: string }).digest ?? e); }
ok("/dashboard/huddles redirects to the Participation tab of the unified page", target.includes("NEXT_REDIRECT") && target.includes("/dashboard/meetings?tab=participation"), );

console.log("\n## the sidebar");
const layout = readFileSync(new URL("../../frontend/app/dashboard/layout.tsx", import.meta.url), "utf8");
const items = layout.split("\n").filter((l) => /href: "\/dashboard\/(huddles|meetings)"/.test(l));
ok("exactly one item points at the unified section", items.length === 1, );
ok("it is named Team Huddle", /label: "Team Huddle"/.test(items[0] ?? ""));
ok("it has no role restriction, so Employee, Manager, HR and Admin all get it", !/roles:/.test(items[0] ?? "") && !/notRoles:/.test(items[0] ?? ""));
ok("there is no separate Meetings item and no old huddles link", !/label: "Meetings"/.test(layout) && !layout.includes('"/dashboard/huddles"'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
