// Where the backend lives.
//
// NEXT_PUBLIC_API_URL still wins if it is set, so a different deployment can
// point somewhere else. But the fallback is no longer localhost for everyone:
// a browser that is not on localhost gets the live server. A missing or
// mistyped setting used to produce "Route not found" with nothing to explain
// it, which is a bad way to find out a variable did not reach the build.
const LIVE_API = "https://productivity-tracker-ps8u.onrender.com/api";
const LOCAL_API = "http://localhost:5001/api";

// Whatever the setting says, the backend only answers under /api. Rather than
// trusting every future deployment to remember that suffix - and failing with
// an unexplained "Route not found" when one does not - the suffix is enforced
// here, along with stripping any trailing slash.
function withApiSuffix(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  return trimmed.endsWith("/api") ? trimmed : `${trimmed}/api`;
}

const configured =
  process.env.NEXT_PUBLIC_API_URL ||
  (typeof window !== "undefined" &&
  !["localhost", "127.0.0.1"].includes(window.location.hostname)
    ? LIVE_API
    : LOCAL_API);

const API_URL = withApiSuffix(configured);

// Shared so no page builds this address for itself. Pages that did were
// bypassing the /api handling entirely and calling a path the server does
// not serve.
export const API_BASE = API_URL;

export function getToken() {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("token");
}

export function setToken(token: string) {
  localStorage.setItem("token", token);
}

export function clearToken() {
  localStorage.removeItem("token");
}

function headers() {
  const token = getToken();
  const base: Record<string, string> = { "Content-Type": "application/json" };
  if (token) base.Authorization = `Bearer ${token}`;
  return base;
}

// Plain-English text for the codes the server sends when an account cannot be used.
const CODE_TEXT: Record<string, string> = {
  NOT_PART_OF_THIS_HRMS: "This account does not belong to this Avatar HRMS.",
  COMPANY_INACTIVE: "Your company is currently switched off. Please contact your administrator.",
};
const said = (code: unknown) => CODE_TEXT[String(code)] ?? (typeof code === "string" ? code : "Something went wrong");

// fetch, but a dropped connection (or an unreachable server) says so in plain words instead of the browser's
// "Failed to fetch".
async function send(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch {
    throw new Error("Can't reach the server. Check your internet connection and try again.");
  }
}

export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  const res = await send(`${API_URL}${path}`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body ?? {}),
  });

  const data = await res.json().catch(() => ({}));
  // `code` and `data` ride along so a screen can react to a specific refusal (for example "late, give a reason").
  if (!res.ok) throw Object.assign(new Error(said(data.error)), { code: typeof data.code === "string" ? data.code : undefined, data });
  return data as T;
}

export async function apiPatch<T>(path: string, body?: unknown): Promise<T> {
  const res = await send(`${API_URL}${path}`, {
    method: "PATCH",
    headers: headers(),
    body: JSON.stringify(body ?? {}),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(said(data.error));
  return data as T;
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await send(`${API_URL}${path}`, { headers: headers() });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(said(data.error));
  return data as T;
}
export async function apiPut<T>(path: string, body?: unknown): Promise<T> {
  const res = await send(`${API_URL}${path}`, {
    method: "PUT",
    headers: headers(),
    body: JSON.stringify(body ?? {}),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(said(data.error));
  return data as T;
}

export async function apiDelete<T>(path: string): Promise<T> {
  const res = await send(`${API_URL}${path}`, { method: "DELETE", headers: headers() });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(said(data.error));
  return data as T;
}

/** Sends a file (for example a meeting recording) as the raw request body, with its own content type. */
export async function apiPostFile<T>(path: string, file: Blob, contentType: string): Promise<T> {
  const h = headers();
  h["Content-Type"] = contentType;
  const res = await send(`${API_URL}${path}`, { method: "POST", headers: h, body: file });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(said(data.error));
  return data as T;
}
