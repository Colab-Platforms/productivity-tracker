// ===========================================================================
// JOINER REMINDERS
//
// The SLA watcher in onboarding.scheduler.ts measures HR's delay. This
// measures the candidate's: how long since we created their account while
// they still have documents outstanding.
//
// Stateless by design. The watcher ticks every 15 minutes (0.25h), so the
// 24h mail fires only inside [24, 24.25) and the 48h mail inside [48, 48.25).
// Each window can be hit exactly once, so no "reminded" column and no
// migration is needed. Cost: a reminder is missed if the backend is down
// during its window, and a restart inside a window can double-send. For a
// nudge that is an acceptable trade; for anything legal it would not be.
// ===========================================================================

import * as mailerModule from "../../lib/mailer.js";
import { prisma } from "../../lib/prisma.js";
import { ownerAdminIds } from "../../lib/owner.js";
import { getPinnedCompany } from "../../lib/deployment.js";

// Never mail more than this in one tick. The 53 imported employees all
// default to onboardingStatus = OFFER_SENT, so a query mistake could try to
// mail the entire company. This is the circuit breaker.
const MAX_PER_TICK = 10;

const PENDING_STAGES = [
  "OFFER_SENT",
  "OFFER_ACCEPTED",
  "DOCUMENTS_PENDING",
] as const;

type SendResult = { sent: boolean; reason?: string };
type SendFn = (args: {
  to: string;
  subject: string;
  html: string;
  text?: string;
}) => Promise<SendResult>;

// Resolved at runtime so a different export name in mailer.ts cannot break
// the build. If nothing matches, the email prints instead of sending.
function resolveSender(): SendFn {
  const mod = mailerModule as unknown as Record<string, unknown>;
  const found = mod.sendMail ?? mod.send ?? mod.sendEmail ?? mod.default;
  if (typeof found === "function") return found as SendFn;

  return async ({ to, subject, text, html }) => {
    console.log("--- REMINDER EMAIL (no sender found, printing) ---");
    console.log("To:      " + to);
    console.log("Subject: " + subject);
    console.log(text ?? html);
    console.log("--- end ---");
    return { sent: false, reason: "SENDER_NOT_FOUND" };
  };
}

function buildReminder(name: string, pending: number, hours: number) {
  const portal = process.env.APP_URL ?? "http://localhost:3000";
  const stage = hours >= 48 ? "second reminder" : "reminder";

  const text =
    "Hi " + name + ",\n\n" +
    "This is a " + stage + " that " + pending +
    " joining document(s) are still pending on your profile.\n\n" +
    "Please upload them here: " + portal + "/dashboard/onboarding\n\n" +
    "Your tracker stays locked until HR has approved them, so the sooner " +
    "these are in, the sooner you are set up.\n\n" +
    "- HR";

  const html =
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#111">' +
    "<p>Hi " + name + ",</p>" +
    "<p>This is a " + stage + " that <strong>" + pending +
    " joining document(s)</strong> are still pending on your profile.</p>" +
    '<p><a href="' + portal + '/dashboard/onboarding" ' +
    'style="background:#1d4ed8;color:#fff;padding:10px 16px;' +
    'text-decoration:none;border-radius:6px;display:inline-block">' +
    "Upload documents</a></p>" +
    "<p style=\"color:#555\">Your tracker stays locked until HR has approved " +
    "them, so the sooner these are in, the sooner you are set up.</p>" +
    "<p>- HR</p></div>";

  return {
    subject: "Reminder: " + pending + " joining document(s) pending",
    text,
    html,
  };
}

/**
 * force = true ignores the 24h/48h windows so the flow can be tested without
 * waiting a day. Every other guard still applies.
 */
export async function sendOnboardingReminders(
  opts: { force?: boolean } = {}
): Promise<number> {
  const send = resolveSender();
  const now = Date.now();

  const owners = await ownerAdminIds(); // company owners are never sent document reminders
  const candidates = await prisma.user.findMany({
    where: {
      onboardingStatus: { in: [...PENDING_STAGES] },
     documentsSubmittedAt: null,
      ...(owners.length ? { id: { notIn: owners } } : {}),
    },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      employeeCode: true,
      createdAt: true,
    },
  });

  const due: { to: string; name: string; pending: number; hours: number }[] = [];

  for (const person of candidates) {
    const email = String(person.email ?? "");
    // Synthetic addresses created by the bulk import. Never mail these.
    if (!email || email.toLowerCase().endsWith(".local")) continue;

    const hours = (now - person.createdAt.getTime()) / 3600_000;

    const inWindow =
      opts.force === true ||
      (hours >= 24 && hours < 24.25) ||
      (hours >= 48 && hours < 48.25);
    if (!inWindow) continue;

    // The real guard: imported employees have no document rows at all.
    const pending = await prisma.employeeDocument.count({
      where: { userId: person.id, status: { in: ["REQUESTED", "REJECTED"] } },
    });
    if (pending === 0) continue;

    due.push({
      to: email,
      name: String(person.firstName ?? person.employeeCode ?? "there"),
      pending,
      hours,
    });
  }

  if (due.length > MAX_PER_TICK) {
    console.warn(
      "[reminders] REFUSING TO SEND - " + due.length +
      " people qualified in one tick (cap " + MAX_PER_TICK +
      "). This usually means a query is too broad. Nothing was emailed."
    );
    return 0;
  }

  let sent = 0;
  for (const item of due) {
    const mail = buildReminder(item.name, item.pending, item.hours);
    try {
      await send({ to: item.to, subject: mail.subject, html: mail.html, text: mail.text });
      sent += 1;
    } catch (error) {
      // A dead mailbox must never stop the sweep for everyone else.
      console.error("[reminders] failed for " + item.to + ":", error);
    }
  }

  if (sent > 0) console.log("[reminders] " + sent + " reminder(s) processed");
  return sent;
}
