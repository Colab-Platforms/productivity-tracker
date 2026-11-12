// Pure rules for "may this address clock in?". No database, no Express.

/** "::ffff:1.2.3.4" -> "1.2.3.4"; trims and lower-cases everything else. */
export function normalizeIp(raw: string): string {
  const ip = raw.trim().toLowerCase();
  return ip.startsWith("::ffff:") && ip.slice(7).includes(".") ? ip.slice(7) : ip;
}

function v4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

/** Valid entry for the list: an IPv4 address, an IPv4 CIDR (/8 to /32 only), or an IPv6 address. Returns the cleaned entry or null. */
export function parseEntry(raw: string): string | null {
  const text = normalizeIp(raw);
  if (!text) return null;
  const [addr, bits, extra] = text.split("/");
  if (extra !== undefined) return null;
  if (addr.includes(":")) {
    // IPv6: exact address only.
    return bits === undefined && /^[0-9a-f:]+$/.test(addr) && addr.includes(":") ? addr : null;
  }
  if (v4ToInt(addr) === null) return null;
  if (bits === undefined) return addr;
  if (!/^\d{1,2}$/.test(bits)) return null;
  const b = Number(bits);
  // /0../7 would allow a huge part of the internet; refuse so a typo cannot open clock-in to everyone.
  if (b < 8 || b > 32) return null;
  return `${addr}/${b}`;
}

/** Does `ip` match one list entry (exact or CIDR)? */
export function matchesEntry(ip: string, entry: string): boolean {
  const client = normalizeIp(ip);
  const [addr, bits] = normalizeIp(entry).split("/");
  if (bits === undefined) return client === addr;
  const c = v4ToInt(client);
  const a = v4ToInt(addr);
  if (c === null || a === null) return false;
  const b = Number(bits);
  const mask = b === 0 ? 0 : (0xffffffff << (32 - b)) >>> 0;
  return ((c & mask) >>> 0) === ((a & mask) >>> 0);
}

/** Empty list = no restriction. Otherwise the address must match at least one entry. */
export function isIpAllowed(ip: string | null | undefined, entries: string[]): boolean {
  if (entries.length === 0) return true;
  if (!ip) return false;
  return entries.some((e) => matchesEntry(ip, e));
}
