"use client";

import { useMe } from "../layout";
import { teamHuddleLabel } from "@/lib/teamLabel";

/** "Team Meet" for an Admin, "Team Huddle" for everybody else, as plain text inside a heading, header or sentence. */
export default function HuddleWord() {
  const me = useMe();
  return <>{teamHuddleLabel(me?.role)}</>;
}
