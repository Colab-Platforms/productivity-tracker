// Where the backend lives.
//
// NEXT_PUBLIC_API_URL still wins if it is set, so a different deployment can
// point somewhere else. But the fallback is no longer localhost for everyone:
// a browser that is not on localhost gets the live server. A missing or
// mistyped setting used to produce "Route not found" with nothing to explain
// it, which is a bad way to find out a variable did not reach the build.
import { decideAuth, endMessage, isAuthFailure, shouldRefresh, tokenShapeOk, tokenTimes } from "./session";

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

const KEY = "token";

export function getToken() {
  if (typeof window === "undefined") return null;
  const t = localStorage.getItem(KEY);
  if (t === null) return null;
  // A value that is not even shaped like a token ("undefined", "null", empty) can only be refused by the server as "jwt malformed": drop it.
  if (!tokenShapeOk(t)) {
    localStorage.removeItem(KEY);
    return null;
  }
  return t;
}

export function setToken(token: string) {
  localStorage.setItem(KEY, token);
}

export function clearToken() {
  localStorage.removeItem(KEY);
}

function headers(token: string | null = getToken()) {
  const base: Record<string, string> = { "Content-Type": "application/json" };
  if (token) base.Authorization = `Bearer ${token}`;
  return base;
}

// Plain-English text for the codes the server sends when an account cannot be used.
const CODE_TEXT: Record<string, string> = {
  NOT_PART_OF_THIS_HRMS: "This account does not belong to this Avatar HRMS.",
  COMPANY_INACTIVE: "Your company is currently switched off. Please contact your administrator.",
  INVALID_TOKEN: "Your session is no longer valid. Please sign in again.",
  NOT_AUTHENTICATED: "Please sign in to continue.",
  ACCOUNT_INACTIVE: "This account is no longer active. Please contact HR.",
  TOO_MANY_ATTEMPTS: "Too many sign-in attempts. Please wait a few minutes and try again, or ask HR to reset your password.",
};
const said = (code: unknown) => CODE_TEXT[String(code)] ?? (typeof code === "string" ? code : "Something went wrong");

// The sign-in page shows this once after the person was sent back to it (network rule, expired session, signed out elsewhere).
export const LOGIN_NOTICE_KEY = "hrms-login-notice";
function leave(message: string) {
  if (typeof window === "undefined" || window.location.pathname.startsWith("/login")) return;
  try {
    clearToken();
    sessionStorage.setItem(LOGIN_NOTICE_KEY, message);
  } catch { /* the redirect below still happens */ }
  window.location.assign("/login");
}
// The server refuses a signed-in session that is used from a network that is not authorised (code IP_NOT_ALLOWED).
function leaveIfBlocked(data: { code?: unknown; error?: unknown }) {
  if (data?.code !== "IP_NOT_ALLOWED") return;
  leave(typeof data.error === "string" ? data.error : "Access Denied.");
}

// fetch, but a dropped connection (or an unreachable server) says so in plain words instead of the browser's
// "Failed to fetch".
async function send(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch {
    throw new Error("Can't reach the server. Check your internet connection and try again.");
  }
}

// ---- keeping a working session alive, and ending it only when it is really over --------------------------------------------------------
//  * While the token is valid but past half of its life, ONE shared request swaps it for a fresh one (POST /auth/refresh). Several calls or tabs at
//    once make no difference: the old token stays valid until its own expiry, so nothing invalidates anything else.
//  * One refused call never signs anyone out by itself. The session is only ended when the server confirms it is gone (expired, account switched
//    off) or another tab already signed out; if another tab just replaced the token, the call is simply repeated with the new one.
let refreshing: Promise<void> | null = null;
let lastRefreshTry = 0;
function maybeRefresh(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (refreshing) return refreshing;
  const sent = getToken();
  if (!sent || !shouldRefresh(tokenTimes(sent), Date.now() / 1000, lastRefreshTry, Date.now())) return Promise.resolve();
  lastRefreshTry = Date.now();
  refreshing = (async () => {
    try {
      const res = await fetch(`${API_URL}/auth/refresh`, { method: "POST", headers: headers(sent), body: "{}" });
      const data = await res.json().catch(() => ({}));
      // only store it if nobody (another tab) replaced or removed the token meanwhile
      if (res.ok && typeof data.token === "string" && tokenShapeOk(data.token) && getToken() === sent) setToken(data.token);
    } catch { /* offline or server busy: the current token is still good, try again later */ }
  })().finally(() => { refreshing = null; });
  return refreshing;
}

let probing: Promise<boolean | null> | null = null;
function probeSession(): Promise<boolean | null> {
  if (probing) return probing;
  probing = (async () => {
    try {
      const res = await fetch(`${API_URL}/auth/me`, { headers: headers() });
      if (res.ok) return true;
      const data = await res.json().catch(() => ({}));
      return isAuthFailure(res.status, data.error) ? false : null;
    } catch { return null; }
  })().finally(() => { probing = null; });
  return probing;
}

async function exec(path: string, build: (token: string | null) => RequestInit): Promise<{ res: Response; data: any }> {
  await maybeRefresh();
  let sent = getToken();
  let res = await send(`${API_URL}${path}`, build(sent));
  let data = await res.json().catch(() => ({}));
  if (isAuthFailure(res.status, data.error)) {
    const code = typeof data.code === "string" ? data.code : undefined;
    const probeOk = sent && getToken() === sent && code !== "TOKEN_EXPIRED" && path !== "/auth/me" ? await probeSession() : null;
    const verdict = decideAuth({ sent, current: getToken(), code, path, probeOk });
    if (verdict === "RETRY") {
      sent = getToken();
      res = await send(`${API_URL}${path}`, build(sent));
      data = await res.json().catch(() => ({}));
    } else if (verdict === "END") {
      const message = endMessage(code, data.error);
      leave(message);
      throw Object.assign(new Error(message), { code, data });
    }
  }
  return { res, data };
}

async function json<T>(method: string, path: string, body?: unknown): Promise<T> {
  const { res, data } = await exec(path, (t) => ({
    method,
    headers: headers(t),
    ...(method === "GET" || method === "DELETE" ? {} : { body: JSON.stringify(body ?? {}) }),
  }));
  // `code` and `data` ride along so a screen can react to a specific refusal (for example "late, give a reason").
  if (!res.ok) {
    leaveIfBlocked(data);
    // a refusal that carries its own readable sentence (the sign-in lockout says how many minutes) shows that sentence, never a bare code
    const own = res.status === 429 && typeof data.message === "string" ? data.message : null;
    throw Object.assign(new Error(own ?? said(data.error)), { code: typeof data.code === "string" ? data.code : undefined, data });
  }
  return data as T;
}

export const apiPost = <T>(path: string, body?: unknown) => json<T>("POST", path, body);
export const apiPatch = <T>(path: string, body?: unknown) => json<T>("PATCH", path, body);
export const apiGet = <T>(path: string) => json<T>("GET", path);
export const apiPut = <T>(path: string, body?: unknown) => json<T>("PUT", path, body);
export const apiDelete = <T>(path: string) => json<T>("DELETE", path);

/** Sends a file (for example a meeting recording) as the raw request body, with its own content type. */
export async function apiPostFile<T>(path: string, file: Blob, contentType: string): Promise<T> {
  const { res, data } = await exec(path, (t) => ({ method: "POST", headers: { ...headers(t), "Content-Type": contentType }, body: file }));
  if (!res.ok) { leaveIfBlocked(data); throw new Error(said(data.error)); }
  return data as T;
}

// Signing out in one tab signs out the others (the token key disappears from the shared storage). A refresh or sign-in elsewhere just replaces it.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === KEY && e.newValue === null && e.oldValue !== null) leave("You were signed out in another window. Please sign in again.");
  });
}
