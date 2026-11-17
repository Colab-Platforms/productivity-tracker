// Repetitive task detection: is the feature's table there, and the Admin's threshold. Every function tolerates "table does not exist" (before the
// migration nothing is detected and every screen behaves as before).
import { prisma } from "../../lib/prisma.js";
import { DEFAULT_SETTINGS, type Settings } from "./repetition.logic.js";

export const isMissingTable = (e: unknown) => {
  const code = (e as { code?: unknown })?.code;
  const msg = e instanceof Error ? e.message : "";
  return code === "P2021" || (/repetition_/.test(msg) && /does not exist|relation/.test(msg));
};

let readyValue = false;
let checkedAt = 0;
export async function repetitionReady(): Promise<boolean> {
  if (readyValue) return true;
  if (Date.now() - checkedAt < 15_000) return false;
  checkedAt = Date.now();
  try {
    await Promise.all([prisma.repetitionFlag.findFirst({ select: { id: true } }), prisma.repetitionFlagTask.findFirst({ select: { id: true } }), prisma.repetitionFlagEvent.findFirst({ select: { id: true } })]);
    readyValue = true;
  } catch (e) {
    if (!isMissingTable(e)) throw e;
    readyValue = false;
  }
  return readyValue;
}

/** The Admin's threshold (3 similar submissions within 7 days at 60% by default). No row = the defaults. */
export async function loadSettings(): Promise<Settings> {
  try {
    const r = await prisma.repetitionSettings.findUnique({ where: { id: "global" } });
    return r ? { enabled: r.enabled, minCount: r.minCount, windowDays: r.windowDays, similarityPct: r.similarityPct } : { ...DEFAULT_SETTINGS };
  } catch (e) {
    if (!isMissingTable(e)) throw e;
    return { ...DEFAULT_SETTINGS };
  }
}
