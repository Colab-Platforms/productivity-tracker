import { prisma } from "../../lib/prisma.js";
import { isIpAllowed, parseEntry } from "./clockInNetwork.logic.js";

// Office network allow-list (table `office_ips`). Safe before the migration: if the table does not exist,
// clock-in stays unrestricted exactly as before.
//
// ONE list for the whole system: the companies here share the same offices, so an address added by an Admin or
// HR of any company applies to everyone. (Looking it up per company left every company without its own row
// unrestricted.) `platformId` on a row only records who added it.

/** Thrown at clock-in from an address that is not on the list. The route turns it into a 403. */
export class ClockInNotAllowed extends Error {
  constructor() {
    super("CLOCKIN_NETWORK_RESTRICTED");
  }
}

const isMissingTable = (e: unknown) => {
  const code = (e as { code?: unknown })?.code;
  const msg = e instanceof Error ? e.message : "";
  return code === "P2021" || (/office_ips/.test(msg) && /does not exist|relation/.test(msg));
};

async function entriesFor(): Promise<string[]> {
  try {
    const rows = await prisma.officeIp.findMany({ select: { cidr: true } });
    return rows.map((r) => r.cidr);
  } catch (e) {
    if (isMissingTable(e)) return [];
    throw e;
  }
}

/** Throws ClockInNotAllowed when this company has a list and `ip` is not on it. */
export async function assertClockInAllowed(_platformId: string, ip: string | null) {
  const entries = await entriesFor();
  if (!isIpAllowed(ip, entries)) throw new ClockInNotAllowed();
}

export async function listOfficeIps() {
  try {
    return await prisma.officeIp.findMany({ orderBy: { createdAt: "asc" } });
  } catch (e) {
    if (isMissingTable(e)) return [];
    throw e;
  }
}

export async function addOfficeIp(platformId: string, createdById: string, rawCidr: unknown, rawLabel: unknown) {
  const cidr = typeof rawCidr === "string" ? parseEntry(rawCidr) : null;
  if (!cidr) throw new Error("BAD_IP");
  const label = typeof rawLabel === "string" ? rawLabel.trim().slice(0, 80) : "";
  try {
    if (await prisma.officeIp.findFirst({ where: { cidr }, select: { id: true } })) throw new Error("IP_EXISTS");
    return await prisma.officeIp.create({ data: { platformId, cidr, label, createdById } });
  } catch (e) {
    if ((e as { code?: unknown })?.code === "P2002") throw new Error("IP_EXISTS");
    if (isMissingTable(e)) throw new Error("OFFICE_IPS_NOT_READY");
    throw e;
  }
}

export async function removeOfficeIp(id: string) {
  const out = await prisma.officeIp.deleteMany({ where: { id } });
  if (out.count === 0) throw new Error("IP_NOT_FOUND");
}
