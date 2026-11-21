// CRM Reports: who may use it, how the CRM is called, how errors are mapped, how a report is shown. No database, no real CRM (a mock CRM on a local port).
import http from "node:http";
import express from "express";
import { crmReportsUserId, isCrmReportsUser, requireCrmReportsUser } from "../src/modules/crm-reports/crmReports.access.js";
import { crmBase, crmGet, CrmError } from "../src/modules/crm-reports/crmClient.js";
import { buildSections, chartFor, employeeChoices, filterByEmployee, formatValue, isStale, paginate } from "../../frontend/app/dashboard/crm-reports/view.js";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n); };
const SANJAY = "00000000-aaaa-4bbb-8ccc-000000000001";
const KEY = "test-secret-key-0123456789";

console.log("\n## access: exactly one user id");
ok("the configured id is allowed", isCrmReportsUser(SANJAY, { CRM_REPORTS_USER_ID: SANJAY }));
ok("case and spaces do not matter", isCrmReportsUser(SANJAY.toUpperCase(), { CRM_REPORTS_USER_ID: ` ${SANJAY} ` }));
ok("another user is refused", !isCrmReportsUser("11111111-1111-1111-1111-111111111111", { CRM_REPORTS_USER_ID: SANJAY }));
ok("variable missing = nobody", !isCrmReportsUser(SANJAY, {}) && crmReportsUserId({}) === null);
ok("variable empty or blank = nobody", !isCrmReportsUser(SANJAY, { CRM_REPORTS_USER_ID: "" }) && !isCrmReportsUser("", { CRM_REPORTS_USER_ID: "  " }));
ok("no id / non-string id is refused", !isCrmReportsUser(undefined, { CRM_REPORTS_USER_ID: SANJAY }) && !isCrmReportsUser(null, { CRM_REPORTS_USER_ID: SANJAY }));

// The real middleware behind a fake sign-in, over HTTP. The id comes from the sign-in, never from the request.
async function withApp(userId: string | undefined, f: (url: string) => Promise<void>) {
  process.env.CRM_REPORTS_USER_ID = SANJAY;
  const app = express();
  app.use((req, _res, next) => { (req as any).user = userId ? { userId } : undefined; next(); });
  app.use(requireCrmReportsUser);
  app.get("/x", (_q, r) => r.json({ secret: "data" }));
  const srv = app.listen(0);
  await new Promise((r) => srv.once("listening", r));
  try { await f(`http://127.0.0.1:${(srv.address() as any).port}`); } finally { srv.close(); }
}
await withApp(SANJAY, async (u) => { const r = await fetch(u + "/x"); ok("Sanjay gets through (200)", r.status === 200); });
await withApp("22222222-2222-2222-2222-222222222222", async (u) => {
  const r = await fetch(u + "/x?userId=" + SANJAY, { headers: { "x-user-id": SANJAY } });
  const b = await r.json();
  ok("another Admin/HR/employee gets 403, and no data", r.status === 403 && b.code === "CRM_REPORTS_FORBIDDEN" && !("secret" in b));
  ok("a forged query/header with Sanjay's id does not help", r.status === 403);
});
await withApp(undefined, async (u) => { const r = await fetch(u + "/x"); ok("no sign-in at all is refused", r.status === 403); });
delete process.env.CRM_REPORTS_USER_ID;
{
  const app = express();
  app.use((req, _res, next) => { (req as any).user = { userId: SANJAY }; next(); });
  app.use(requireCrmReportsUser);
  app.get("/x", (_q, r) => r.json({}));
  const srv = app.listen(0); await new Promise((r) => srv.once("listening", r));
  const r = await fetch(`http://127.0.0.1:${(srv.address() as any).port}/x`);
  ok("variable not set: even Sanjay is refused (nobody)", r.status === 403);
  srv.close();
}

console.log("\n## proxy: base URL, key header, no secret leaks");
ok("base = configured /api URL + /hrms/v1", crmBase({ CRM_API_BASE_URL: "https://crm.example.com/api/" }) === "https://crm.example.com/api/hrms/v1");
ok("not configured when the URL is missing or not http(s)", crmBase({}) === null && crmBase({ CRM_API_BASE_URL: "crm.example.com" }) === null);

const seen: { url: string; key: string | undefined; method: string | undefined }[] = [];
let mode = "ok";
const crm = http.createServer((req, res) => {
  seen.push({ url: req.url ?? "", key: req.headers["x-hrms-key"] as string | undefined, method: req.method });
  if (req.headers["x-hrms-key"] !== KEY) { res.writeHead(401, { "content-type": "application/json" }); res.end(JSON.stringify({ success: false, error: { code: "INVALID_KEY", message: "bad" } })); return; }
  if (mode === "hang") return;
  if (mode === "503") { res.writeHead(503, { "content-type": "application/json" }); res.end(JSON.stringify({ success: false, availability: { crm: { available: false, error: "db down" } } })); return; }
  if (mode === "400") { res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ success: false, error: { code: "INVALID_REQUEST", message: "from must be before to" } })); return; }
  if (mode === "html") { res.writeHead(200, { "content-type": "text/html" }); res.end("<html>"); return; }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ success: true, from: "2026-11-01", to: "2026-11-07", timezone: "Asia/Kolkata", generatedAt: "2026-11-07T10:00:00Z", data: { ok: 1 }, availability: {}, basis: {} }));
});
await new Promise<void>((r) => crm.listen(0, r));
const env = { CRM_API_BASE_URL: `http://127.0.0.1:${(crm.address() as any).port}/api`, CRM_INTEGRATION_API_KEY: KEY };
const code = async (p: () => Promise<unknown>) => { try { await p(); return null; } catch (e) { return e as CrmError; } };

const good = await crmGet("sales", { range: "custom", from: "2026-11-01", to: "2026-11-07" }, { env });
ok("a good call returns the CRM's answer untouched", (good as any).data.ok === 1 && (good as any).timezone === "Asia/Kolkata");
ok("it calls /api/hrms/v1/<report> with GET and the date query", seen[0]!.url === "/api/hrms/v1/sales?range=custom&from=2026-11-01&to=2026-11-07" && seen[0]!.method === "GET");
ok("it sends the shared secret in X-HRMS-Key", seen[0]!.key === KEY);

console.log("\n## API errors");
let e = await code(() => crmGet("sales", {}, { env: { ...env, CRM_INTEGRATION_API_KEY: "wrong-wrong-wrong-wrong" } }));
ok("CRM rejects the key -> 502 CRM_AUTH_FAILED (never 401: that would sign the user out)", e?.status === 502 && e.code === "CRM_AUTH_FAILED");
ok("the error text never contains the secret", !JSON.stringify(e?.message).includes(KEY) && !e?.message.includes("wrong-wrong"));
e = await code(() => crmGet("sales", {}, { env: { CRM_API_BASE_URL: env.CRM_API_BASE_URL } }));
ok("no key configured -> 503 CRM_NOT_CONFIGURED, nothing sent", e?.status === 503 && e.code === "CRM_NOT_CONFIGURED" && seen.length === 2);
mode = "503"; e = await code(() => crmGet("sales", {}, { env }));
ok("CRM 503 -> 503 CRM_UNAVAILABLE with its availability reasons", e?.status === 503 && e.code === "CRM_UNAVAILABLE" && JSON.stringify(e.extra).includes("db down"));
mode = "400"; e = await code(() => crmGet("sales", {}, { env }));
ok("CRM 400 -> 400 with the CRM's reason", e?.status === 400 && e.message.includes("from must be before to"));
mode = "html"; e = await code(() => crmGet("sales", {}, { env }));
ok("a 200 that is not JSON -> an error, not an empty report", e instanceof CrmError && e.status >= 500);
mode = "hang"; e = await code(() => crmGet("sales", {}, { env, timeoutMs: 150 }));
ok("a CRM that never answers -> 504 CRM_TIMEOUT", e?.status === 504 && e.code === "CRM_TIMEOUT");
e = await code(() => crmGet("sales", {}, { env: { ...env, CRM_API_BASE_URL: "http://127.0.0.1:1/api" } }));
ok("CRM down -> 502 CRM_UNREACHABLE", e?.status === 502 && e.code === "CRM_UNREACHABLE");
crm.closeAllConnections(); crm.close();

console.log("\n## report rendering");
const telecallers = {
  from: "2026-11-01", to: "2026-11-07", timezone: "Asia/Kolkata",
  data: {
    summary: { calls: 120, revenueCents: 1250000, talkTimeSec: 3720, conversionRate: null },
    rows: [{ id: "t1", name: "Asha", calls: 70, revenueCents: 800000 }, { id: "t2", name: "Ravi", calls: 50, revenueCents: null }, { id: "t3", name: "Meena", calls: 0, revenueCents: 450000 }],
    ads: null,
  },
  availability: { summary: { available: true, error: null }, rows: { available: true, error: null }, ads: { available: false, error: "No ad data in the CRM" } },
};
ok("null is shown as 'Not available', never 0", formatValue("conversionRate", null) === "Not available" && formatValue("x", undefined) === "Not available");
ok("a real zero stays 0", formatValue("calls", 0) === "0");
ok("Cents are shown as rupees, seconds as time", formatValue("revenueCents", 1250000) === "₹12,500.00" && formatValue("talkTimeSec", 3720) === "1h 2m");
const secs = buildSections(telecallers);
ok("a section the CRM could not calculate says why (no zero cards)", secs.find((s) => s.key === "ads")?.unavailable === "No ad data in the CRM" && secs.find((s) => s.key === "ads")!.cards.length === 0);
ok("scalars become cards, including a null one", secs[0]!.cards.length === 4 && secs[0]!.cards.find((c) => c.key === "conversionRate")?.value === null);
ok("rows become a table with their columns", secs[1]!.tables[0]!.rows.length === 3 && secs[1]!.tables[0]!.columns.join() === "id,name,calls,revenueCents");
const ch = chartFor(secs[1]!.tables[0]!);
ok("chart uses revenue, labelled by name, and leaves the missing value out (not 0)", ch?.metricKey === "revenueCents" && ch.points.length === 2 && !ch.points.some((p) => p.label === "Ravi"));
ok("employee choices come from rows with an id and name", employeeChoices(secs).map((p) => p.name).join() === "Asha,Meena,Ravi");
ok("employee filter narrows the rows", filterByEmployee(secs[1]!.tables[0]!.rows, "t2").length === 1 && filterByEmployee(secs[1]!.tables[0]!.rows, "").length === 3);
const pg = paginate(Array.from({ length: 40 }, (_, i) => i), 3, 15);
ok("pagination: page 3 of 3 holds the last 10", pg.pages === 3 && pg.rows.length === 10 && paginate([1], 9, 15).page === 1);
ok("empty data gives no sections", buildSections({ data: {} }).length === 0 && buildSections({ data: null }).length === 0);
const t0 = 1_000_000;
ok("stale: never loaded = not stale; failed refresh = stale; >10 min old = stale; fresh = not", !isStale(null, true, t0) && isStale(t0, true, t0 + 1) && isStale(t0, false, t0 + 11 * 60_000) && !isStale(t0, false, t0 + 60_000));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
