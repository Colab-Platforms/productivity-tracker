// Universal demo: a separate deployment answers GET /api/demo/info. A normal server has no such route (404), so every function here quietly answers "not a demo".
import { API_BASE, getToken, setToken } from "@/lib/api";
import { homeFor } from "@/lib/roleHome";

export type DemoInfo = { demo: true; label: string; usernameHint: string; roles: { role: string; label: string }[] };

let cached: Promise<DemoInfo | null> | null = null;
export function getDemoInfo(): Promise<DemoInfo | null> {
  if (!cached) {
    cached = fetch(`${API_BASE}/demo/info`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => (j && j.demo === true ? (j as DemoInfo) : null))
      .catch(() => null);
  }
  return cached;
}

async function demoCall<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}/demo${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${getToken() ?? ""}` }, body: JSON.stringify(body ?? {}) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j?.error || "The demo could not do that.");
  return j as T;
}

/** Switch to another of the four demo views. Takes the signed token the server returns and opens that view's own home with a clean reload. */
export async function switchDemoRole(role: string) {
  const r = await demoCall<{ token: string; user: { role: string } }>("/switch", { role });
  setToken(r.token);
  window.location.assign(homeFor(r.user.role, false));
}
export async function resetDemo() {
  await demoCall("/reset");
  window.location.reload();
}
