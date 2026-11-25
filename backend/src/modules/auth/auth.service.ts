import bcrypt from "bcryptjs";
import { isBlockedStatus } from "../../lib/userStatus.js";
import { isOwnerAdmin } from "../../lib/owner.js";
import { isSupervisor } from "../../lib/supervisor.js";
import { signSession } from "../../lib/session.js";
import { findLooseUserId } from "../../lib/employeeIdMatch.js";
import { prisma } from "../../lib/prisma.js";
import { photoStamps } from "../photos/photos.service.js";
import { getPinnedCompany } from "../../lib/deployment.js";
import { auditNote } from "../../lib/auditContext.js";

// ---------------------------------------------------------------------------
// LOGIN BY EMAIL **OR** EMPLOYEE ID
//
// None of the 51 people HR sent us have a work email address. Telecallers
// will not remember an invented one, so the employee ID they already know
// from payroll — AWL-01, Avance-07 — is the identifier they type.
//
// No migration needed: employeeCode already exists on User. What it lacks is
// a unique index, so this resolves defensively and refuses to guess when two
// people share a code rather than letting one sign in as the other.
// ---------------------------------------------------------------------------
async function findByIdentifier(identifier: string) {
  const id = identifier.trim();
  if (!id) return [];

  // An "@" means they typed an email. Anything else is treated as a code.
  // The same email may legitimately exist on more than one platform (one
  // person, two companies), so this returns every candidate. login() decides
  // which one by checking the password against each.
  if (id.includes("@")) {
    return prisma.user.findMany({
      where: { email: id.toLowerCase() },
      include: { platform: true },
      orderBy: { createdAt: "asc" },
      take: 10,
    });
  }

  const matches = await prisma.user.findMany({
    where: { employeeCode: { equals: id, mode: "insensitive" } },
    include: { platform: true },
    take: 2,
  });

  if (matches.length > 1) throw new Error("DUPLICATE_EMPLOYEE_ID");
  if (matches.length === 1) return matches;

  // Not an employee ID: it may be a username such as "ankit_avatar". Only tried when no ID matched, so signing
  // in with an ID or an email behaves exactly as before. If the usernames table does not exist yet (migration
  // not applied) this simply finds nothing — it can never break the existing sign-in.
  try {
    const row = await prisma.loginUsername.findUnique({ where: { username: id.toLowerCase() } });
    if (row) {
      const byName = await prisma.user.findUnique({ where: { id: row.userId }, include: { platform: true } });
      return byName ? [byName] : [];
    }
  } catch {
    /* table not there yet */
  }

  // Last resort, after an exact ID, an email and a username found nothing. Typing slips ("AWL -03", "Avance07"): accepted only when exactly one person matches (lib/employeeIdMatch.ts); the password is still required.
  const looseId = await findLooseUserId(id);
  if (looseId) {
    const one = await prisma.user.findUnique({ where: { id: looseId }, include: { platform: true } });
    if (one) return [one];
  }

  return matches;
}

export async function login(identifier: string, password: string, sessionId?: string) {
  // A pinned deployment only signs in people of that company. Others get the same
  // error as an unknown account, so nothing reveals who exists elsewhere.
  const pinned = await getPinnedCompany();
  const candidates = (await findByIdentifier(identifier)).filter((c) => !pinned || c.platformId === pinned.id);

  // First candidate whose password matches. An unknown identifier and a wrong
  // password end in the same error, so nothing here reveals which emails exist.
  let user: (typeof candidates)[number] | null = null;
  for (const c of candidates) {
    if (c.passwordHash && (await bcrypt.compare(password, c.passwordHash))) {
      user = c;
      break;
    }
  }
  if (!user) throw new Error("INVALID_CREDENTIALS");

  if (isBlockedStatus(user.status)) {
    throw new Error("ACCOUNT_INACTIVE");
  }

  // sid: this sign-in's own id (login history follows it to the last activity and logout). sst: when the sign-in happened, kept through refreshes.
  const token = signSession({ userId: user.id, platformId: user.platformId, role: user.role, ...(sessionId ? { sid: sessionId } : {}) });

  await prisma.user.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date() },
  });

  // The sign-in is attributed to the person who signed in, in their company.
  auditNote({ actorId: user.id, platformId: user.platformId, targetUserId: user.id, summary: "Signed in" });

  return { token, user: { ...publicUser(user), supervisor: await isSupervisor(user.id).catch(() => false) } };
}

export async function getMe(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { platform: true },
  });

  if (!user) return null;
  const photoAt = (await photoStamps([user.id])).get(user.id) ?? null;
  const documentsExempt = await isOwnerAdmin(user.id).catch(() => false);
  // A Productivity Supervisor keeps role EMPLOYEE; this flag only tells the app to show the monitoring home and menu (the server re-checks on every request).
  const supervisor = await isSupervisor(user.id).catch(() => false);
  return { ...publicUser(user), photoAt, documentsExempt, supervisor };
}

function publicUser(user: any) {
  return {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    employeeCode: user.employeeCode,
    role: user.role,
    status: user.status,
    designation: user.designation,
    onboardingStatus: user.onboardingStatus,
    trackerAccessEnabled: user.trackerAccessEnabled,
        // The frontend can't route someone to the change-password screen if it
    // doesn't know they need it.
    mustChangePassword: user.mustChangePassword,
    platform: {
      id: user.platform.id,
      name: user.platform.name,
      slug: user.platform.slug,
      // The frontend reads every date and time in this zone.
      timezone: user.platform.timezone,
    },
  };
}