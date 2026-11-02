import { prisma } from "./prisma.js";

// ---------------------------------------------------------------------------
// WHO MANAGES A TEAM
// A team has one PRIMARY manager (teams.managerId) and any number of
// CO-MANAGERS (team_managers). Everything that asks "does this person run
// this team?" goes through here so the two can never disagree.
//
// Until migration 20261102100000_team_managers is applied, the table does not
// exist: every read below then behaves as "no co-managers" and nothing breaks.
// ---------------------------------------------------------------------------

async function coManagerTeamIds(userId: string): Promise<string[]> {
  try {
    const rows = await prisma.teamManager.findMany({
      where: { userId },
      select: { teamId: true },
    });
    return rows.map((r) => r.teamId);
  } catch {
    return [];
  }
}

/** Prisma `where` for teams this person manages (as primary OR co-manager). */
export async function managedByWhere(userId: string) {
  const co = await coManagerTeamIds(userId);
  return co.length
    ? { OR: [{ managerId: userId }, { id: { in: co } }] }
    : { managerId: userId };
}

/** Every manager of each given team: primary first, then co-managers. */
export async function managerIdsByTeam(teamIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const ids = [...new Set(teamIds)];
  if (ids.length === 0) return out;
  const teams = await prisma.team.findMany({
    where: { id: { in: ids } },
    select: { id: true, managerId: true },
  });
  for (const t of teams) out.set(t.id, t.managerId ? [t.managerId] : []);
  try {
    const co = await prisma.teamManager.findMany({
      where: { teamId: { in: ids } },
      select: { teamId: true, userId: true },
    });
    for (const c of co) {
      const list = out.get(c.teamId) ?? [];
      if (!list.includes(c.userId)) list.push(c.userId);
      out.set(c.teamId, list);
    }
  } catch {
    /* table not there yet: primary managers only */
  }
  return out;
}

/** True when this person is the primary or a co-manager of the team. */
export async function isTeamManager(userId: string, teamId: string): Promise<boolean> {
  const m = await managerIdsByTeam([teamId]);
  return (m.get(teamId) ?? []).includes(userId);
}

export type CoManager = { id: string; name: string; employeeCode: string | null; platformId: string };

/** Co-managers (names) of many teams in one query, for screens that list teams. */
export async function coManagersByTeam(teamIds: string[]): Promise<Map<string, CoManager[]>> {
  const out = new Map<string, CoManager[]>();
  if (teamIds.length === 0) return out;
  try {
    const rows = await prisma.teamManager.findMany({
      where: { teamId: { in: teamIds } },
      select: {
        teamId: true,
        user: { select: { id: true, firstName: true, lastName: true, employeeCode: true, platformId: true } },
      },
      orderBy: { createdAt: "asc" },
    });
    for (const r of rows) {
      const list = out.get(r.teamId) ?? [];
      list.push({
        id: r.user.id,
        name: `${r.user.firstName} ${r.user.lastName}`.trim(),
        employeeCode: r.user.employeeCode,
        platformId: r.user.platformId,
      });
      out.set(r.teamId, list);
    }
  } catch {
    /* table not there yet */
  }
  return out;
}
