import { redirect } from "next/navigation";

// "Raise a Ticket" is now part of the Query Desk (Complaint Centre for employees). The old address still works.
export default function TicketsRedirect() {
  redirect("/dashboard/queries");
}
