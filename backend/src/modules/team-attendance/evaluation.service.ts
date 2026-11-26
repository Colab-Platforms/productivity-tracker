import { prisma } from "../../lib/prisma.js";
import { getProductivity } from "./productivity.service.js";
import { historyFor, saveAdjustment, type Adjustment } from "../tasks/evaluation.adjust.js";

// Manager Evaluation (the Task productivity table's Edit action). The person must be one the viewer already sees in that report, so a manager
// can only adjust people in his own reporting scope; HR, Admin and Productivity Supervisors can read the history but never change anything.

async function person(viewerId: string, userId: string, from: string, to: string) {
  const r = (await getProductivity(viewerId, { from, to, userId, raw: true })) as { from: string; to: string; people: { userId: string; name: string; weighted: { percent: number | null; status: never }; overallPercent: number | null }[] };
  const p = r.people.find((x) => x.userId === userId);
  if (!p) throw new Error("NOT_FOUND");
  return { r, p };
}

export async function saveEvaluation(viewerId: string, ip: string | null, body: Record<string, unknown>): Promise<Adjustment> {
  const viewer = await prisma.user.findUnique({ where: { id: viewerId }, select: { id: true, role: true, platformId: true } });
  if (!viewer) throw new Error("USER_NOT_FOUND");
  if (String(viewer.role) !== "MANAGER") throw new Error("EVAL_MANAGERS_ONLY"); // HR, Admin and supervisors can read, not change
  const userId = typeof body.userId === "string" ? body.userId : "";
  if (!/^[0-9a-f-]{36}$/i.test(userId)) throw new Error("NOT_FOUND");
  if (userId === viewerId) throw new Error("EVAL_SELF");
  const from = typeof body.from === "string" ? body.from : undefined, to = typeof body.to === "string" ? body.to : undefined;
  const { r, p } = await person(viewerId, userId, from ?? "", to ?? "");
  // the adjustment belongs to the exact period the report shows
  if (!from || !to || r.from !== from || r.to !== to) throw new Error("EVAL_BAD_PERIOD");
  const target = await prisma.user.findUnique({ where: { id: userId }, select: { platformId: true } });
  if (!target) throw new Error("NOT_FOUND");
  return saveAdjustment(
    { id: viewer.id, platformId: viewer.platformId, ip },
    { userId, platformId: target.platformId, name: p.name, from: r.from, to: r.to, current: { score: p.weighted.percent, status: p.weighted.status, productivity: p.overallPercent } },
    { userId, from, to, score: body.score, status: body.status, productivity: body.productivity, reason: body.reason }
  );
}

export async function evaluationHistory(viewerId: string, userId: string, from: string, to: string) {
  const { r } = await person(viewerId, userId, from, to); // proves the viewer may see this person
  return { from: r.from, to: r.to, entries: await historyFor(userId, r.from, r.to) };
}
