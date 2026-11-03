import { redirect } from "next/navigation";

// Team Huddle used to be its own page. It is now part of the unified Team Huddle section (the Meetings page), under the Participation tab,
// so an old link or bookmark to this address lands there. Nothing was removed: the same records and screens are used.
export default function HuddlesRedirect() {
  redirect("/dashboard/meetings?tab=participation");
}
