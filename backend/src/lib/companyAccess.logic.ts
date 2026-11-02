// Which companies may this person act on? Pure rules (no database), so they can be tested on their own.
//
//  - Only HR and Admin can ever reach beyond their own company. Everyone else: their own company only.
//  - Top management: an owner code (OWNER_CODES) or a grant with no company = ALL companies.
//  - HR (or an authorized Admin): their own company plus exactly the companies assigned to them.
//  - A deployment pinned to one company allows that company only, whatever the grants say.

export type Access = { all: boolean; ids: string[] };

/** The employee codes listed in OWNER_CODES (top management). Still honoured; company_access grants add to it. */
export const ownerCodes = (): string[] =>
  String(process.env.OWNER_CODES ?? "")
    .split(",")
    .map((c) => c.trim().toUpperCase())
    .filter(Boolean);

export function resolveAccess(opts: {
  role: string;
  ownPlatformId: string;
  grants: { platformId: string | null }[];
  isOwnerCode: boolean;
  pinnedPlatformId: string | null;
}): Access {
  const own = opts.ownPlatformId;
  if (opts.pinnedPlatformId) return { all: false, ids: [opts.pinnedPlatformId] };
  if (opts.role !== "HR" && opts.role !== "ADMIN") return { all: false, ids: [own] };
  if (opts.isOwnerCode || opts.grants.some((g) => g.platformId === null)) return { all: true, ids: [] };
  const ids = [own];
  for (const g of opts.grants) if (g.platformId && !ids.includes(g.platformId)) ids.push(g.platformId);
  return { all: false, ids };
}

export const canAccess = (a: Access, platformId: string) => a.all || a.ids.includes(platformId);

/** Companies to show in a picker, given every active company: all of them, or only the allowed ones. */
export const visibleCompanies = <T extends { id: string }>(a: Access, companies: T[]): T[] => (a.all ? companies : companies.filter((c) => a.ids.includes(c.id)));

// --- employee IDs ---------------------------------------------------------------------------------------------------------

export const PREFIX_RE = /^[A-Z][A-Z0-9]{1,7}$/;

/** A company prefix: 2 to 8 characters, letters and digits, starting with a letter, stored in capitals. Returns null if invalid. */
export function cleanPrefix(input: unknown): string | null {
  const p = String(input ?? "").trim().toUpperCase();
  return PREFIX_RE.test(p) ? p : null;
}

export const formatCode = (prefix: string, n: number, width: number) => `${prefix}-${String(n).padStart(width, "0")}`;

/** The highest number already used by IDs that look like PREFIX-<digits>, so a counter can start above every existing one. */
export function highestNumber(codes: (string | null)[], prefix: string): number {
  const re = new RegExp(`^${prefix.replace(/[^A-Z0-9]/gi, "")}-(\\d+)$`, "i");
  let highest = 0;
  for (const c of codes) {
    const m = c ? re.exec(c) : null;
    if (m) highest = Math.max(highest, Number(m[1]));
  }
  return highest;
}
