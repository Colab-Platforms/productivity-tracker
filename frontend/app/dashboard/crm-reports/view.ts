// Pure rules for showing a CRM report. No React, no network, so it can be tested on its own.
// The CRM answers { from, to, timezone, generatedAt, range, data, availability, basis }. `data` is made of independent sections: a section that
// could not be calculated is null with an availability entry. NULL IS NEVER SHOWN AS ZERO.

export type Availability = { available: boolean; error: string | null };
export type Envelope = {
  from?: string;
  to?: string;
  timezone?: string;
  generatedAt?: string;
  range?: { kind?: string; from?: string; to?: string; days?: number; timezone?: string } | string;
  data?: Record<string, unknown> | null;
  availability?: Record<string, Availability>;
  basis?: Record<string, string>;
  notes?: string[];
};

export type Card = { key: string; label: string; value: number | string | boolean | null };
export type Table = { key: string; title: string; columns: string[]; rows: Record<string, unknown>[] };
export type Section = { key: string; title: string; cards: Card[]; tables: Table[]; unavailable: string | null };

export const NOT_AVAILABLE = "Not available";

const leaf = (key: string) => key.slice(key.lastIndexOf(".") + 1);

export function labelOf(key: string): string {
  if (key.includes(".")) return key.split(".").slice(-2).map(labelOf).join(" · ");
  const spaced = key.replace(/Cents$/, "").replace(/Sec$/, " (time)").replace(/Ms$/, " (time)").replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isScalar = (v: unknown) => v === null || ["string", "number", "boolean"].includes(typeof v);

/** One value as text. null / undefined = "Not available" (never 0). Money fields end in "Cents" and are shown in rupees; times in "Sec"/"Ms" as h m s. */
export function formatValue(key: string, v: unknown): string {
  if (v === null || v === undefined) return NOT_AVAILABLE;
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return NOT_AVAILABLE;
    if (/Cents$/.test(leaf(key))) return "₹" + (v / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (/Sec$/.test(leaf(key)) || /Ms$/.test(leaf(key))) return duration(/Ms$/.test(leaf(key)) ? v / 1000 : v);
    return Number.isInteger(v) ? v.toLocaleString("en-IN") : v.toLocaleString("en-IN", { maximumFractionDigits: 2 });
  }
  if (typeof v === "string") return v === "" ? "—" : v;
  return JSON.stringify(v);
}

export function duration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

/** The plain number behind a cell, for charts, sorting and Excel; null when it is not a number. */
export function numericOf(key: string, v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return /Cents$/.test(leaf(key)) ? v / 100 : v;
}

/** One level of nested objects becomes dotted columns (attendance.present). A null object stays one blank cell; arrays are left out. A nested field that repeats a top-level one (performance.name) is dropped. */
export function flattenRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) if (isScalar(v)) out[k] = v;
  for (const [k, v] of Object.entries(row)) {
    if (isObj(v)) {
      for (const [k2, v2] of Object.entries(v)) {
        if (isScalar(v2) && !(k2 in row)) out[`${k}.${k2}`] = v2;
        else if (isObj(v2)) for (const [k3, v3] of Object.entries(v2)) if (isScalar(v3)) out[`${k}.${k2}.${k3}`] = v3;
      }
    } else if (v === null && !(k in out)) out[k] = null;
  }
  return out;
}

function columnsOf(rows: Record<string, unknown>[]): string[] {
  const seen: string[] = [];
  for (const r of rows.slice(0, 200)) for (const k of Object.keys(r)) if (!seen.includes(k)) seen.push(k);
  return seen;
}

/** Turns one report's `data` into sections of summary cards and tables. A null section keeps its availability reason. */
export function buildSections(env: Envelope): Section[] {
  const data = env.data ?? {};
  const avail = env.availability ?? {};
  const out: Section[] = [];
  for (const [key, value] of Object.entries(data)) {
    const sec: Section = { key, title: labelOf(key), cards: [], tables: [], unavailable: null };
    const a = avail[key];
    if (value === null || value === undefined || (a && a.available === false)) {
      sec.unavailable = a?.error ? String(a.error) : "This part of the report could not be calculated.";
      out.push(sec);
      continue;
    }
    const walk = (node: unknown, path: string[]) => {
      if (Array.isArray(node)) {
        const rows = node.filter(isObj).map(flattenRow);
        if (rows.length > 0) sec.tables.push({ key: path.join("."), title: path.length > 1 ? path.slice(1).map(labelOf).join(" · ") : sec.title, columns: columnsOf(rows), rows });
        return;
      }
      if (isObj(node)) {
        for (const [k, v] of Object.entries(node)) {
          if (isScalar(v)) sec.cards.push({ key: [...path.slice(1), k].join("."), label: path.length > 1 ? `${labelOf(path[path.length - 1]!)} · ${labelOf(k)}` : labelOf(k), value: v as Card["value"] });
          else walk(v, [...path, k]);
        }
        return;
      }
      if (isScalar(node)) sec.cards.push({ key: path[path.length - 1]!, label: sec.title, value: node as Card["value"] });
    };
    walk(value, [key]);
    out.push(sec);
  }
  return out;
}

const PREFERRED_METRICS = ["revenueCents", "netCents", "totalCents", "revenue", "orders", "units", "leads", "converted", "calls", "count", "amountCents"];
const LABEL_COLUMNS = ["name", "label", "status", "method", "source", "product", "day", "date", "key"];

/** A chart for a table: a text column for the labels and the most meaningful numeric column for the bars. Null when the table has nothing to chart. */
export function chartFor(t: Table): { labelKey: string; metricKey: string; points: { label: string; value: number }[] } | null {
  const labelKey = LABEL_COLUMNS.find((k) => t.columns.includes(k)) ?? t.columns.find((c) => t.rows.some((r) => typeof r[c] === "string"));
  if (!labelKey) return null;
  const numeric = t.columns.filter((c) => c !== labelKey && t.rows.some((r) => numericOf(c, r[c]) !== null));
  const metricKey = PREFERRED_METRICS.find((m) => numeric.includes(m)) ?? numeric[0];
  if (!metricKey) return null;
  const points = t.rows
    .map((r) => ({ label: String(r[labelKey] ?? "—"), value: numericOf(metricKey, r[metricKey]) }))
    .filter((p): p is { label: string; value: number } => p.value !== null) // a missing value is left out, never drawn as 0
    .sort((a, b) => b.value - a.value)
    .slice(0, 10);
  return points.length > 1 ? { labelKey, metricKey, points } : null;
}

/** Rows whose name matches the chosen employee (the CRM id or name). Empty choice = everyone. */
export function filterByEmployee(rows: Record<string, unknown>[], employee: string): Record<string, unknown>[] {
  if (!employee) return rows;
  return rows.filter((r) => String(r.id ?? r.employeeId ?? "") === employee || String(r.name ?? "") === employee);
}

/** The people that can be chosen in the employee filter: rows that carry both an id and a name. */
export function employeeChoices(sections: Section[]): { id: string; name: string }[] {
  const map = new Map<string, string>();
  for (const s of sections) for (const t of s.tables) for (const r of t.rows) { const id = r.id ?? r.employeeId; if (typeof id === "string" && typeof r.name === "string") map.set(id, r.name); }
  return [...map].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
}

export function paginate<T>(rows: T[], page: number, size: number): { rows: T[]; pages: number; page: number } {
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const p = Math.min(Math.max(1, page), pages);
  return { rows: rows.slice((p - 1) * size, p * size), pages, page: p };
}

/** Data shown is "stale" when the last refresh failed, or the last good one is older than two refresh periods. */
export function isStale(lastOkAt: number | null, lastFailed: boolean, now: number, refreshMs = 5 * 60_000): boolean {
  return lastOkAt !== null && (lastFailed || now - lastOkAt > refreshMs * 2);
}

export const PRESETS = [
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "last_7_days", label: "Last 7 Days" },
  { key: "last_30_days", label: "Last 30 Days" },
  { key: "this_month", label: "This Month" },
  { key: "last_month", label: "Last Month" },
  { key: "all_time", label: "All Time" },
  { key: "custom", label: "Custom" },
] as const;

export const TABS = [
  { key: "sales", label: "Sales" },
  { key: "orders", label: "Orders" },
  { key: "leads", label: "Leads" },
  { key: "telecallers", label: "Telecaller Performance" },
  { key: "employees", label: "Employee Performance" },
  { key: "products", label: "Products" },
  { key: "payments", label: "Payments" },
  { key: "marketing", label: "Marketing" },
] as const;
export type TabKey = (typeof TABS)[number]["key"];
