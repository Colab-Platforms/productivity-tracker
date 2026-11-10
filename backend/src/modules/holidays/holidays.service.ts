import { getPinnedCompany } from "../../lib/deployment.js";
import { prisma } from "../../lib/prisma.js";
import { platformToday } from "../../lib/dates.js";
import { accessFor } from "../../lib/companyAccess.js";

// ---------------------------------------------------------------------------
// HOLIDAYS
//
// A holiday is a day nobody is expected to work, so it must be removed from
// every person's attainment target. Reports computes expected working days as
// shift working days MINUS holidays MINUS approved leave, capped at today.
//
// HR owns this list and sets it before the month starts. Each company keeps
// its own, because Take Health may observe a day Co-Lab works through.
// ---------------------------------------------------------------------------

const MANAGING_ROLES = ["HR", "ADMIN"];
export const MAX_BACKDATE_DAYS = 90;

async function viewerContext(viewerId: string) {
  const user = await prisma.user.findUnique({
    where: { id: viewerId },
    include: { platform: true },
  });
  if (!user) throw new Error("USER_NOT_FOUND");
  const role = String(user.role);
  if (!MANAGING_ROLES.includes(role)) throw new Error("NOT_ALLOWED");
  return { user, role, userId: user.id, platformId: user.platformId, timezone: user.platform.timezone };
}

// Which companies this person may set holidays for.
//
// DECISION, flagged rather than buried: ADMIN manages every company, HR only
// their own. You run three companies from one admin login, so scoping Admin
// to a single platform would make the screen useless to you. If you'd rather
// HR also covered all three, it's a one-line change here.
async function allowedPlatforms(ctx: { role: string; platformId: string; userId?: string }) {
  if (ctx.role === "ADMIN") {
    return prisma.platform.findMany({
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    });
  }
  // HR: every company they act on (their own, assigned ones, or all for top management), the same rule as the rest of the app.
  const access = await accessFor(ctx.userId ?? "");
  return prisma.platform.findMany({
    where: access.all ? {} : { id: { in: access.ids.length ? access.ids : [ctx.platformId] } },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
}

// YYYY-MM-DD in, UTC midnight out. @db.Date stores UTC midnight, so building
// the date any other way shifts the holiday by a day in Asia/Kolkata.
function parseDay(input: unknown): Date {
  const s = String(input ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error("BAD_DATE");
  const [y, m, d] = s.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (Number.isNaN(date.getTime())) throw new Error("BAD_DATE");
  // Guard against 2026-02-31 silently rolling into March.
  if (
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() !== m - 1 ||
    date.getUTCDate() !== d
  ) {
    throw new Error("BAD_DATE");
  }
  return date;
}

const key = (d: Date) => d.toISOString().slice(0, 10);

export async function listHolidays(viewerId: string, yearIn?: unknown) {
  const ctx = await viewerContext(viewerId);
  const today = platformToday(ctx.timezone);

  const year = Number(yearIn) || today.getUTCFullYear();
  if (year < 2020 || year > 2100) throw new Error("BAD_YEAR");

  const platforms = await allowedPlatforms(ctx);
  const platformIds = platforms.map((p) => p.id);
  const nameOf = new Map(platforms.map((p) => [p.id, p.name]));

  const rows = await prisma.holiday.findMany({
    where: {
      platformId: { in: platformIds },
      date: {
        gte: new Date(Date.UTC(year, 0, 1)),
        lte: new Date(Date.UTC(year, 11, 31)),
      },
    },
    orderBy: { date: "asc" },
  });

  const holidays = rows.map((h) => ({
    id: h.id,
    platformId: h.platformId,
    company: nameOf.get(h.platformId) ?? null,
    date: key(h.date),
    name: h.name,
    dayType: String(h.dayType),
    // The UI greys these out: changing a past holiday rewrites attainment for
    // a month that has already been reported on.
    isPast: h.date.getTime() < today.getTime(),
    weekday: h.date.toLocaleDateString("en-IN", {
      weekday: "long",
      timeZone: "UTC",
    }),
  }));

  return {
    year,
    today: key(today),
    maxBackdateDays: MAX_BACKDATE_DAYS, // a past holiday can be ADDED (with confirmation) up to this many days back; removing one stays blocked
    years: [year - 1, year, year + 1],
    companies: platforms,
    holidays,
    countsByCompany: platforms.map((p) => ({
      id: p.id,
      name: p.name,
      count: holidays.filter((h) => h.platformId === p.id).length,
    })),
  };
}

export async function addHoliday(
  viewerId: string,
  body: Record<string, unknown>
) {
  const ctx = await viewerContext(viewerId);
  const today = platformToday(ctx.timezone);

  const name = String(body.name ?? "").trim();
  if (!name) throw new Error("NAME_REQUIRED");
  if (name.length > 120) throw new Error("NAME_TOO_LONG");

  const date = parseDay(body.date);

  // A holiday added for a day that has passed changes the reports for that day for everyone (the day stops counting as a working day).
  // HR forgets sometimes, so it is allowed, but only up to MAX_BACKDATE_DAYS back and only after HR confirms they understand.
  if (date.getTime() < today.getTime()) {
    const daysBack = Math.round((today.getTime() - date.getTime()) / 86_400_000);
    if (daysBack > MAX_BACKDATE_DAYS) throw new Error("DATE_TOO_OLD");
    if (body.confirmBackdate !== true) throw new Error("BACKDATE_CONFIRM_REQUIRED");
  }

  const platforms = await allowedPlatforms(ctx);
  const allowedIds = new Set(platforms.map((p) => p.id));

  // applyToAll lets HR declare Independence Day once for every company
  // instead of three times.
  const targets = body.applyToAll
    ? platforms.map((p) => p.id)
    : [String(body.platformId ?? ctx.platformId)];

  for (const platformId of targets) {
    if (!allowedIds.has(platformId)) throw new Error("NOT_YOUR_COMPANY");
  }

  for (const platformId of targets) {
    // Unique key is [platformId, date, name], so re-adding the same holiday
    // is a no-op rather than an error the user has to understand.
    const existing = await prisma.holiday.findFirst({
      where: { platformId, date, name: { equals: name, mode: "insensitive" } }, // "Diwali Holiday" and "diwali holiday" are the same holiday
      select: { id: true },
    });
    if (existing) continue;

    await prisma.holiday.create({ data: { platformId, date, name } });
  }

  return listHolidays(viewerId, date.getUTCFullYear());
}

export async function deleteHoliday(viewerId: string, holidayId: string) {
  const ctx = await viewerContext(viewerId);
  const today = platformToday(ctx.timezone);

  const holiday = await prisma.holiday.findUnique({
    where: { id: holidayId },
  });
  if (!holiday) throw new Error("NOT_FOUND");

  const platforms = await allowedPlatforms(ctx);
  if (!platforms.some((p) => p.id === holiday.platformId)) {
    throw new Error("NOT_YOUR_COMPANY");
  }

  // Same reasoning as adding: a past holiday has already been counted into
  // reports people have seen. Deleting it rewrites history.
  if (holiday.date.getTime() < today.getTime()) {
    throw new Error("DATE_IN_THE_PAST");
  }

  await prisma.holiday.delete({ where: { id: holidayId } });
  return listHolidays(viewerId, holiday.date.getUTCFullYear());
}