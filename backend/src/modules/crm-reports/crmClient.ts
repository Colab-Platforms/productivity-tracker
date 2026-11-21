// SERVER-SIDE CLIENT FOR THE CRM REPORTING API. The shared secret (CRM_INTEGRATION_API_KEY) is read here and sent only to the CRM as the
// X-HRMS-Key header. It is never returned to the browser, never logged, and never put in an error message.

export const CRM_REPORTS = ["sales", "orders", "leads", "telecallers", "employees", "products", "payments", "marketing"] as const;
export type CrmReport = (typeof CRM_REPORTS)[number];
export const CRM_RANGES = ["today", "yesterday", "last_7_days", "last_30_days", "this_month", "last_month", "all_time", "custom"] as const;

export class CrmError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly extra?: Record<string, unknown>) {
    super(message);
  }
}

type Env = Record<string, string | undefined>;
const clean = (v: string | undefined) => (v ?? "").trim().replace(/^["']|["']$/g, "").trim();

/** Base URL (already ending in /api) + /hrms/v1, or null when not configured. */
export function crmBase(env: Env = process.env): string | null {
  const base = clean(env.CRM_API_BASE_URL).replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(base)) return null;
  return `${base}/hrms/v1`;
}
export function crmKey(env: Env = process.env): string | null {
  const k = clean(env.CRM_INTEGRATION_API_KEY);
  return k.length >= 16 ? k : null;
}

export type CrmDeps = { fetchImpl?: typeof fetch; env?: Env; timeoutMs?: number };

/** GET one CRM endpoint. Returns the CRM's JSON envelope untouched; throws CrmError with an HRMS-safe status for every failure. */
export async function crmGet(path: "health" | CrmReport, query: Record<string, string | undefined>, deps: CrmDeps = {}): Promise<Record<string, unknown>> {
  const env = deps.env ?? process.env;
  const base = crmBase(env);
  const key = crmKey(env);
  if (!base || !key) throw new CrmError(503, "CRM_NOT_CONFIGURED", "The CRM connection is not configured on this server.");

  const url = new URL(`${base}/${path}`);
  for (const [k, v] of Object.entries(query)) if (v) url.searchParams.set(k, v);

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), deps.timeoutMs ?? 90_000);
  let res: Response;
  try {
    res = await (deps.fetchImpl ?? fetch)(url, { method: "GET", headers: { "X-HRMS-Key": key, Accept: "application/json" }, signal: ctl.signal });
  } catch (e) {
    const timedOut = e instanceof Error && e.name === "AbortError";
    throw new CrmError(timedOut ? 504 : 502, timedOut ? "CRM_TIMEOUT" : "CRM_UNREACHABLE", timedOut ? "The CRM took too long to answer." : "The CRM could not be reached.");
  } finally {
    clearTimeout(timer);
  }

  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (res.ok && body && typeof body === "object") return body;

  // A rejected key must NOT come back as 401: the browser treats 401 as "your session ended" and signs the person out.
  if (res.status === 401 || res.status === 403) throw new CrmError(502, "CRM_AUTH_FAILED", "The CRM refused the HRMS connection key. Ask the CRM administrator to check it.");
  if (res.status === 400) {
    const m = (body?.error as { message?: string } | undefined)?.message;
    throw new CrmError(400, "CRM_BAD_REQUEST", m ? String(m) : "The CRM did not accept that date range.");
  }
  if (res.status === 429) throw new CrmError(429, "CRM_RATE_LIMITED", "The CRM is limiting requests. Try again in a minute.");
  const availability = body && typeof body.availability === "object" ? (body.availability as Record<string, unknown>) : undefined;
  throw new CrmError(res.status === 503 ? 503 : 502, "CRM_UNAVAILABLE", "The CRM could not calculate this report right now.", availability ? { availability } : undefined);
}
