import { getPinnedCompany } from "../../lib/deployment.js";
import { prisma } from "../../lib/prisma.js";
import { isUuid } from "../../lib/params.js";
import { managedByWhere, coManagersByTeam, managerIdsByTeam } from "../../lib/teamManagers.js";
import { accessFor } from "../../lib/companyAccess.js";

// ---------------------------------------------------------------------------
// PROJECTS
//
// A company holds many projects; each has exactly one manager. A person can
// be on several, with one marked primary — that one owns their shift and
// their default manager.
//
// Moving somebody between projects moves their manager with them, which is
// the whole reason managers attach to projects and not to companies.
// ---------------------------------------------------------------------------

const STAFF = ["HR", "ADMIN"];

async function actor(viewerId: string) {
  const user = await prisma.user.findUnique({
    where: { id: viewerId },
    include: { platform: true },
  });
  if (!user) throw new Error("USER_NOT_FOUND");
  return { user, role: String(user.role), platformId: user.platformId };
}

function assertStaff(role: string) {
  if (!STAFF.includes(role)) throw new Error("NOT_ALLOWED");
}

// Admin covers every company, HR their own. A manager may read the projects
// they run but not create or re-staff them.
async function visiblePlatformIds(a: { role: string; platformId: string }) {
  if (a.role === "ADMIN") {
    const all = await prisma.platform.findMany({ select: { id: true } });
    return all.map((p) => p.id);
  }
  return [a.platformId];
}

export async function listProjects(viewerId: string) {
  const a = await actor(viewerId);
  const isStaff = STAFF.includes(a.role);
  if (!isStaff && a.role !== "MANAGER") throw new Error("NOT_ALLOWED");

  const platformIds = await visiblePlatformIds(a);
  const pinned = await getPinnedCompany();

  const teams = await prisma.team.findMany({
    where: isStaff
      ? { platformId: { in: platformIds } }
      : { ...(await managedByWhere(viewerId)), ...(pinned ? { platformId: pinned.id } : {}) },
    select: {
      id: true,
      name: true,
      isActive: true,
      platformId: true,
      platform: { select: { id: true, name: true } },
      manager: {
        select: { id: true, firstName: true, lastName: true, employeeCode: true, platformId: true },
      },
      members: {
        where: { isActive: true, ...(pinned ? { user: { platformId: pinned.id } } : {}) },
        select: {
          isPrimary: true,
          user: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              employeeCode: true,
              designation: true,
              status: true,
            },
          },
        },
      },
    },
    orderBy: [{ isActive: "desc" }, { name: "asc" }],
  });

  const coByTeam = await coManagersByTeam(teams.map((t) => t.id));

  // People who REPORT DIRECTLY to a project's manager (or a co-manager) but are not members of the project. They are the
  // manager's people too (they see and approve their work), but the member list alone does not show them. Read only:
  // nothing is changed; limited to people of companies the viewer may act on.
  const managersOfTeam = await managerIdsByTeam(teams.map((t) => t.id));
  const allManagerIds = [...new Set([...managersOfTeam.values()].flat())];
  const reach = await accessFor(viewerId);
  const directReports = allManagerIds.length
    ? await prisma.user.findMany({
        where: {
          reportsToId: { in: allManagerIds },
          status: { in: ["ACTIVE", "INVITED"] },
          ...(pinned ? { platformId: pinned.id } : reach.all ? {} : { platformId: { in: reach.ids } }),
        },
        select: { id: true, firstName: true, lastName: true, employeeCode: true, designation: true, status: true, reportsToId: true, platform: { select: { name: true } } },
        orderBy: [{ firstName: "asc" }],
      })
    : [];

  // Who can be picked as a manager: Managers AND Admins (Admins run teams too) who can sign in, in the companies this
  // person can act on. Not just people already listed as managers: a company may have none yet.
  const managerCandidates = isStaff
    ? await prisma.user.findMany({
        where: {
          platformId: { in: platformIds },
          role: { in: ["MANAGER", "ADMIN"] as never },
          status: { in: ["ACTIVE", "INVITED"] },
        },
        select: { id: true, firstName: true, lastName: true, employeeCode: true, role: true, platform: { select: { name: true } } },
        orderBy: [{ firstName: "asc" }],
      })
    : [];

  // Everyone the staff member could put on a project, grouped by company on
  // screen. Includes people from other companies for Admin, because the
  // reporting line deliberately crosses them.
  const assignable = isStaff
    ? await prisma.user.findMany({
        where: {
          platformId: { in: platformIds },
          status: { in: ["ACTIVE", "INVITED", "CANDIDATE"] },
        },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          employeeCode: true,
          designation: true,
          role: true,
          platform: { select: { name: true } },
        },
        orderBy: [{ firstName: "asc" }],
      })
    : [];

  const companies = await prisma.platform.findMany({
    where: { id: { in: platformIds } },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });

  return {
    canManage: isStaff,
    companies,
    managers: managerCandidates.map((u) => ({
      id: u.id,
      name: `${u.firstName} ${u.lastName}`.trim(),
      employeeCode: u.employeeCode,
      role: String(u.role),
      company: u.platform?.name ?? null,
    })),
    assignable: assignable.map((u) => ({
      id: u.id,
      name: `${u.firstName} ${u.lastName}`.trim(),
      employeeCode: u.employeeCode,
      designation: u.designation,
      role: String(u.role),
      company: u.platform?.name ?? null,
    })),
    projects: teams.map((t) => ({
      id: t.id,
      name: t.name,
      isActive: t.isActive,
      companyId: t.platform?.id ?? t.platformId,
      company: t.platform?.name ?? null,
      // A pinned deployment does not show a manager who belongs to another company.
      managerId: (pinned && t.manager?.platformId !== pinned.id ? null : t.manager?.id) ?? null,
      manager: t.manager && !(pinned && t.manager.platformId !== pinned.id)
        ? `${t.manager.firstName} ${t.manager.lastName}`.trim()
        : null,
      managerCode: pinned && t.manager?.platformId !== pinned.id ? null : (t.manager?.employeeCode ?? null),
      coManagers: (coByTeam.get(t.id) ?? []).filter((c) => !pinned || c.platformId === pinned.id),
      directReports: directReports
        .filter((r) => (managersOfTeam.get(t.id) ?? []).includes(r.reportsToId ?? "") && !t.members.some((m) => m.user.id === r.id))
        .map((r) => ({
          id: r.id,
          name: `${r.firstName} ${r.lastName}`.trim(),
          employeeCode: r.employeeCode,
          designation: r.designation,
          status: String(r.status),
          company: r.platform?.name ?? null,
        })),
      members: t.members.map((m) => ({
        id: m.user.id,
        name: `${m.user.firstName} ${m.user.lastName}`.trim(),
        employeeCode: m.user.employeeCode,
        designation: m.user.designation,
        status: String(m.user.status),
        isPrimary: m.isPrimary,
      })),
    })),
  };
}

export async function saveProject(
  viewerId: string,
  body: Record<string, unknown>
) {
  const a = await actor(viewerId);
  assertStaff(a.role);

  const name = String(body.name ?? "").trim();
  if (!name) throw new Error("NAME_REQUIRED");
  if (name.length > 120) throw new Error("NAME_TOO_LONG");

  const platformIds = await visiblePlatformIds(a);
  const id = body.id ? String(body.id) : null;
  const managerId = body.managerId ? String(body.managerId) : null;
  if (managerId && !isUuid(managerId)) throw new Error("MANAGER_NOT_FOUND");
  if (id && !isUuid(id)) throw new Error("NOT_FOUND");

  // The manager must be someone real and visible to this staff member.
  if (managerId) {
    const m = await prisma.user.findUnique({
      where: { id: managerId },
      select: { platformId: true, role: true },
    });
    if (!m) throw new Error("MANAGER_NOT_FOUND");
    if (a.role !== "ADMIN" && m.platformId !== a.platformId) {
      throw new Error("NOT_YOUR_COMPANY");
    }
    // Managers and Admins can run a team. A project's CURRENT manager may stay as they are.
    if (!["MANAGER", "ADMIN"].includes(String(m.role))) {
      const current = id
        ? (await prisma.team.findUnique({ where: { id }, select: { managerId: true } }))?.managerId
        : null;
      if (current !== managerId) throw new Error("NOT_A_MANAGER");
    }
  }

  if (id) {
    const existing = await prisma.team.findUnique({ where: { id } });
    if (!existing || !platformIds.includes(existing.platformId)) {
      throw new Error("NOT_FOUND");
    }

    await prisma.team.update({
      where: { id },
      data: {
        name,
        managerId,
        ...(body.isActive !== undefined
          ? { isActive: body.isActive === true }
          : {}),
      },
    });

    // Changing the project's manager re-points everyone on it, so the
    // approval queue follows the change immediately.
    if (managerId && managerId !== existing.managerId) {
      await repointReportingLine(id, managerId);
    }

    return listProjects(viewerId);
  }

  const companyId = String(body.companyId ?? a.platformId);
  if (!platformIds.includes(companyId)) throw new Error("NOT_YOUR_COMPANY");

  const clash = await prisma.team.findFirst({
    where: { platformId: companyId, name },
    select: { id: true },
  });
  if (clash) throw new Error("PROJECT_EXISTS");

  const created = await prisma.team.create({
    data: { platformId: companyId, name, managerId, isActive: true },
  });

  // A manager who runs a project should also carry the MANAGER role, or they
  // see no Approvals tab and the project is unmanageable in practice.
  if (managerId) await promoteToManager(managerId);

  return { ...(await listProjects(viewerId)), createdId: created.id };
}

// Anyone whose primary project is this one gets the new manager as their
// reporting line. Non-primary members keep theirs — their main project owns
// who they answer to day to day.
async function repointReportingLine(teamId: string, managerId: string) {
  const primaries = await prisma.teamMember.findMany({
    where: { teamId, isActive: true, isPrimary: true },
    select: { userId: true },
  });

  const ids = primaries.map((p) => p.userId).filter((id) => id !== managerId);
  if (ids.length === 0) return;

  await prisma.user.updateMany({
    where: { id: { in: ids } },
    data: { reportsToId: managerId },
  });
}

async function promoteToManager(userId: string) {
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true },
  });
  if (u && String(u.role) === "EMPLOYEE") {
    await prisma.user.update({
      where: { id: userId },
      data: { role: "MANAGER" as never },
    });
  }
}

// ---------------------------------------------------------------------------
// CO-MANAGERS
// Extra managers with the same authority as the primary one (see lib/teamManagers.ts).
// Only HR/Admin set them, within their own company (Admin: any), like the primary manager.
// ---------------------------------------------------------------------------
async function coManagerContext(viewerId: string, teamId: string, userId: string) {
  const a = await actor(viewerId);
  assertStaff(a.role);
  if (!isUuid(teamId) || !isUuid(userId)) throw new Error("NOT_FOUND");
  const platformIds = await visiblePlatformIds(a);
  const team = await prisma.team.findUnique({ where: { id: teamId } });
  if (!team || !platformIds.includes(team.platformId)) throw new Error("NOT_FOUND");
  const person = await prisma.user.findUnique({
    where: { id: userId },
    select: { platformId: true, role: true, status: true },
  });
  if (!person) throw new Error("MANAGER_NOT_FOUND");
  if (a.role !== "ADMIN" && person.platformId !== a.platformId) throw new Error("NOT_YOUR_COMPANY");
  return { a, team, person };
}

export async function addCoManager(viewerId: string, teamId: string, userId: string) {
  const { team, person } = await coManagerContext(viewerId, teamId, userId);
  if (!["ACTIVE", "INVITED"].includes(String(person.status))) throw new Error("MANAGER_NOT_FOUND");
  // Managers and Admins only. Employees are never promoted by this action.
  if (!["MANAGER", "ADMIN"].includes(String(person.role))) throw new Error("NOT_A_MANAGER");
  if (team.managerId === userId) throw new Error("ALREADY_PRIMARY_MANAGER");
  try {
    await prisma.teamManager.upsert({
      where: { teamId_userId: { teamId, userId } },
      create: { teamId, userId },
      update: {},
    });
  } catch {
    throw new Error("FEATURES_NOT_READY"); // migration not applied yet
  }
  return listProjects(viewerId);
}

export async function removeCoManager(viewerId: string, teamId: string, userId: string) {
  await coManagerContext(viewerId, teamId, userId);
  try {
    await prisma.teamManager.deleteMany({ where: { teamId, userId } });
  } catch {
    throw new Error("FEATURES_NOT_READY");
  }
  return listProjects(viewerId);
}

export async function addMember(
  viewerId: string,
  teamId: string,
  body: Record<string, unknown>
) {
  const a = await actor(viewerId);
  assertStaff(a.role);

  const userId = String(body.userId ?? "");
  if (!isUuid(userId)) throw new Error("USER_NOT_FOUND");
  if (!userId) throw new Error("USER_REQUIRED");

  const platformIds = await visiblePlatformIds(a);
  const team = await prisma.team.findUnique({ where: { id: teamId } });
  if (!team || !platformIds.includes(team.platformId)) throw new Error("NOT_FOUND");

  const person = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, platformId: true },
  });
  if (!person) throw new Error("USER_NOT_FOUND");
  if (a.role !== "ADMIN" && person.platformId !== a.platformId) {
    throw new Error("NOT_YOUR_COMPANY");
  }

  const existing = await prisma.teamMember.findFirst({
    where: { teamId, userId },
  });

  // First project somebody joins becomes their primary automatically.
  const otherCount = await prisma.teamMember.count({
    where: { userId, isActive: true, teamId: { not: teamId } },
  });
  const makePrimary = body.isPrimary === true || otherCount === 0;

  if (existing) {
    await prisma.teamMember.update({
      where: { id: existing.id },
      data: { isActive: true, isPrimary: makePrimary },
    });
  } else {
    await prisma.teamMember.create({
      data: { teamId, userId, isPrimary: makePrimary },
    });
  }

  if (makePrimary) await setPrimary(teamId, userId);

  return listProjects(viewerId);
}

// Exactly one primary per person, and their reporting line follows it.
async function setPrimary(teamId: string, userId: string) {
  await prisma.teamMember.updateMany({
    where: { userId, teamId: { not: teamId } },
    data: { isPrimary: false },
  });
  await prisma.teamMember.updateMany({
    where: { userId, teamId },
    data: { isPrimary: true },
  });

  const team = await prisma.team.findUnique({
    where: { id: teamId },
    select: { managerId: true },
  });

  if (team?.managerId && team.managerId !== userId) {
    await prisma.user.update({
      where: { id: userId },
      data: { reportsToId: team.managerId },
    });
  }
}

export async function makePrimary(
  viewerId: string,
  teamId: string,
  userId: string
) {
  const a = await actor(viewerId);
  assertStaff(a.role);

  const platformIds = await visiblePlatformIds(a);
  const team = await prisma.team.findUnique({ where: { id: teamId } });
  if (!team || !platformIds.includes(team.platformId)) throw new Error("NOT_FOUND");

  const member = await prisma.teamMember.findFirst({
    where: { teamId, userId, isActive: true },
  });
  if (!member) throw new Error("NOT_A_MEMBER");

  await setPrimary(teamId, userId);
  return listProjects(viewerId);
}

export async function removeMember(
  viewerId: string,
  teamId: string,
  userId: string
) {
  const a = await actor(viewerId);
  assertStaff(a.role);

  const platformIds = await visiblePlatformIds(a);
  const team = await prisma.team.findUnique({ where: { id: teamId } });
  if (!team || !platformIds.includes(team.platformId)) throw new Error("NOT_FOUND");

  const member = await prisma.teamMember.findFirst({ where: { teamId, userId } });
  if (!member) throw new Error("NOT_A_MEMBER");

  // Deactivated, not deleted — their past work on this project stays
  // attributable for reports and payroll.
  await prisma.teamMember.update({
    where: { id: member.id },
    data: { isActive: false, isPrimary: false, leftAt: new Date() },
  });

  // If that was their primary, promote another project so they aren't left
  // with no manager at all.
  if (member.isPrimary) {
    const next = await prisma.teamMember.findFirst({
      where: { userId, isActive: true },
      select: { teamId: true },
    });
    if (next) await setPrimary(next.teamId, userId);
  }

  return listProjects(viewerId);
}