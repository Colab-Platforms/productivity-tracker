// ===========================================================================
// ONBOARDING SLA WATCHER
//
// Raises an ONBOARDING_OVERDUE alert when a candidate has finished their part
// and HR hasn't acted within the configured window. The clock starts at
// documentsSubmittedAt, so it only ever counts HR's own delay — never time
// the candidate spent gathering papers.
//
// Deliberately its own interval rather than a change to the tracker
// scheduler: two timers is a smaller price than editing a file that is
// already working. If a third watcher appears, merge them.
// ===========================================================================

import { prisma } from "../../lib/prisma.js";
import { ownerAdminIds } from "../../lib/owner.js";
import { getPinnedCompany } from "../../lib/deployment.js";
import { platformToday } from "../../lib/dates.js";
import { sendOnboardingReminders } from "./onboarding.reminders.js";

const EVERY_MINUTES = 15;
const DEFAULT_SLA_HOURS = 48;

export async function generateOnboardingAlerts(): Promise<number> {
  const platforms = await prisma.platform.findMany({
    where: { isActive: true },
    select: { id: true, timezone: true },
  });

  let raised = 0;

  for (const platform of platforms) {
    const config = await prisma.teamConfig.findFirst({
      where: { team: { platformId: platform.id } },
      select: { onboardingSlaHours: true },
    });
    const slaHours = config?.onboardingSlaHours ?? DEFAULT_SLA_HOURS;
    const cutoff = new Date(Date.now() - slaHours * 3600_000);

    const owners = await ownerAdminIds();
    const overdue = await prisma.user.findMany({
      where: {
        platformId: platform.id,
        ...(owners.length ? { id: { notIn: owners } } : {}),
        onboardingStatus: { in: ["DOCUMENTS_SUBMITTED", "AWAITING_RESUME"] },
        documentsSubmittedAt: { not: null, lt: cutoff },
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        employeeCode: true,
        documentsSubmittedAt: true,
        onboardingStatus: true,
      },
    });

    const date = platformToday(platform.timezone);

    for (const person of overdue) {
      const hours = Math.round(
        (Date.now() - person.documentsSubmittedAt!.getTime()) / 3600_000
      );

      // upsert on (userId, date, alertType) — idempotent, so running every
      // fifteen minutes produces one alert a day, not ninety-six.
      await prisma.alert.upsert({
        where: {
          userId_date_alertType: {
            userId: person.id,
            date,
            alertType: "ONBOARDING_OVERDUE",
          },
        },
        update: {
          message: `${person.firstName} ${person.lastName} has been waiting on HR for ${hours}h (target ${slaHours}h)`,
          severity: hours > slaHours * 2 ? "CRITICAL" : "WARNING",
          context: { hours, slaHours, stage: String(person.onboardingStatus) },
        },
        create: {
          platformId: platform.id,
          userId: person.id,
          alertType: "ONBOARDING_OVERDUE",
          severity: hours > slaHours * 2 ? "CRITICAL" : "WARNING",
          date,
          message: `${person.firstName} ${person.lastName} has been waiting on HR for ${hours}h (target ${slaHours}h)`,
          context: { hours, slaHours, stage: String(person.onboardingStatus) },
        },
      });

      raised += 1;
    }
  }

  return raised;
}

export function startOnboardingScheduler() {
  const tick = async () => {
    try {
           const raised = await generateOnboardingAlerts();
      await sendOnboardingReminders();
      if (raised > 0) console.log(`[onboarding] ${raised} candidate(s) past the HR target`);
    } catch (error) {
      console.error("[onboarding] scheduler failed:", error);
    }
  };

  void tick();
  setInterval(tick, EVERY_MINUTES * 60 * 1000);
  console.log(`Onboarding SLA watcher started (every ${EVERY_MINUTES} minutes)`);
}