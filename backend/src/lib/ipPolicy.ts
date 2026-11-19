// ---------------------------------------------------------------------------
// NETWORK ACCESS POLICY (pure rules, no database): may a caller on this IP address sign in to Avatar HRMS and use it?
//
// Two server settings (read from the environment on every check, never from the browser):
//   LOGIN_IP_MODE     off | monitor | enforce
//       off      (or unset)  nothing changes; nothing is checked or logged.
//       monitor              nobody is blocked; every sign-in and request from an address that is NOT allowed is logged as "would be blocked".
//                            This is the controlled-rollout step: watch the log, confirm the server sees the real office address, then switch.
//       enforce              an address that is not allowed cannot sign in and cannot use an existing session.
//       any other value      treated as monitor (never silently off, never an accidental lock-out) and reported loudly.
//   LOGIN_ALLOWED_IPS  comma-separated list: single addresses (206.84.235.169) or IPv4 ranges (203.0.113.0/24).
//       monitor / enforce with NO valid entry does NOT enforce (it would lock everybody out, Admins included): it behaves as monitor and says so.
//
// The caller's address is the one Express works out with `trust proxy` (src/lib/clientIp.ts): counted from the proxy side, so a header the
// client invents cannot choose its own address. Nothing here reads X-Forwarded-For directly except socketIp(), which applies the same hop rule.
// ---------------------------------------------------------------------------

export type Mode = "off" | "monitor" | "enforce";

export const ACCESS_DENIED_MESSAGE =
  "Access Denied. You are not authorized to access Avatar HRMS from this network. Please connect using the authorized office network or contact the HR/Admin team.";

export type Rule = { kind: "exact"; ip: string } | { kind: "cidr4"; base: number; mask: number; text: string };

const V4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function v4ToInt(ip: string): number | null {
  const m = V4.exec(ip);
  if (!m) return null;
  const parts = [m[1], m[2], m[3], m[4]].map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

/** One canonical spelling of an address: lower case, no brackets, and an IPv4 address carried inside IPv6 ("::ffff:1.2.3.4") is plain IPv4. */
export function normalizeIp(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let s = raw.trim().toLowerCase();
  if (!s) return null;
  if (s.startsWith("[") && s.includes("]")) s = s.slice(1, s.indexOf("]"));
  if (s.startsWith("::ffff:") && V4.test(s.slice(7))) s = s.slice(7);
  // an IPv4 address with a port (some proxies add one)
  if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(s)) s = s.slice(0, s.lastIndexOf(":"));
  return s.length > 64 ? null : s;
}

/** Reads the allowed list. Entries that are not a valid address or range are returned in `invalid` (and ignored), never guessed at. */
export function parseAllowList(raw: unknown): { rules: Rule[]; invalid: string[] } {
  const rules: Rule[] = [];
  const invalid: string[] = [];
  for (const piece of String(raw ?? "").split(",")) {
    const t = piece.trim();
    if (!t) continue;
    const slash = t.indexOf("/");
    if (slash === -1) {
      const ip = normalizeIp(t);
      if (ip && (V4.test(ip) ? v4ToInt(ip) !== null : /^[0-9a-f:]+$/.test(ip) && ip.includes(":"))) rules.push({ kind: "exact", ip });
      else invalid.push(t);
      continue;
    }
    const base = v4ToInt(t.slice(0, slash).trim());
    const bits = /^\d{1,2}$/.test(t.slice(slash + 1).trim()) ? Number(t.slice(slash + 1).trim()) : NaN;
    // /0 would allow the whole internet: refused on purpose
    if (base === null || !Number.isInteger(bits) || bits < 8 || bits > 32) {
      invalid.push(t);
      continue;
    }
    const mask = bits === 32 ? 0xffffffff : (~((1 << (32 - bits)) - 1)) >>> 0;
    rules.push({ kind: "cidr4", base: (base & mask) >>> 0, mask, text: t });
  }
  return { rules, invalid };
}

export function ipAllowed(ip: string | null, rules: Rule[]): boolean {
  const n = normalizeIp(ip);
  if (!n) return false; // an unknown address is never allowed
  const asInt = v4ToInt(n);
  for (const r of rules) {
    if (r.kind === "exact" && r.ip === n) return true;
    if (r.kind === "cidr4" && asInt !== null && ((asInt & r.mask) >>> 0) === r.base) return true;
  }
  return false;
}

export type Policy = { mode: Mode; rules: Rule[]; invalid: string[]; problem: string | null };

/** The policy from the environment. `problem` is set when the setting is wrong; the policy then falls back to the safe side (monitor, never enforce). */
export function policyFromEnv(env: Record<string, string | undefined> = process.env): Policy {
  const raw = String(env.LOGIN_IP_MODE ?? "").trim().toLowerCase();
  const { rules, invalid } = parseAllowList(env.LOGIN_ALLOWED_IPS);
  if (raw === "" || raw === "off") return { mode: "off", rules, invalid, problem: null };
  if (raw !== "monitor" && raw !== "enforce") return { mode: "monitor", rules, invalid, problem: `LOGIN_IP_MODE "${raw.slice(0, 20)}" is not off, monitor or enforce; monitoring only` };
  if (rules.length === 0) return { mode: "monitor", rules, invalid, problem: "LOGIN_ALLOWED_IPS has no valid address; not enforcing (that would lock everyone out), monitoring only" };
  return { mode: raw as Mode, rules, invalid, problem: invalid.length ? `ignored invalid LOGIN_ALLOWED_IPS entries: ${invalid.join(", ").slice(0, 80)}` : null };
}

export type Verdict = {
  mode: Mode;
  allowed: boolean;
  /** true when this caller is refused right now (enforce and not allowed) */
  blocked: boolean;
  /** true when a caller who is not allowed was let through only because the mode is monitor */
  wouldBlock: boolean;
  reason: string | null;
};

export const NOT_ON_LIST = "The caller's IP address is not on the authorised list";

export function evaluate(ip: string | null, policy: Policy): Verdict {
  if (policy.mode === "off") return { mode: "off", allowed: true, blocked: false, wouldBlock: false, reason: null };
  const allowed = ipAllowed(ip, policy.rules);
  if (allowed) return { mode: policy.mode, allowed: true, blocked: false, wouldBlock: false, reason: null };
  const reason = normalizeIp(ip) ? NOT_ON_LIST : "The caller's IP address could not be determined";
  return { mode: policy.mode, allowed: false, blocked: policy.mode === "enforce", wouldBlock: policy.mode === "monitor", reason };
}

/**
 * The address behind `hops` trusted proxies, worked out exactly as Express does for `trust proxy = hops`: the connection's own address first,
 * then the X-Forwarded-For list from the right. A client cannot choose its own address by sending a header, because the proxies it passes
 * through add theirs to the right of whatever it sent. Used for the live (websocket) connection, which has no Express request.
 */
export function ipBehindProxy(forwardedFor: string | undefined, remote: string | undefined, hops: number): string | null {
  const chain = [remote ?? "", ...String(forwardedFor ?? "").split(",").map((x) => x.trim()).filter(Boolean).reverse()].filter(Boolean);
  if (chain.length === 0) return null;
  return normalizeIp(chain[Math.min(Math.max(0, hops), chain.length - 1)]);
}
