// The browser side of sessions: the REAL frontend/lib/api.ts and lib/session.ts run against a stubbed browser (storage, location, fetch).
//   npx tsx tests/session-client.test.mts
let pass = 0, fail = 0;
const ok = (n: string, c: boolean, x?: unknown) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  -> " + JSON.stringify(x)?.slice(0, 200))); };

const store = new Map<string, string>();
const session = new Map<string, string>();
const listeners: Record<string, ((e: unknown) => void)[]> = {};
const nav = { path: "/dashboard", assigned: [] as string[] };
(globalThis as any).window = {
  location: { get pathname() { return nav.path; }, hostname: "localhost", assign: (u: string) => nav.assigned.push(u) },
  addEventListener: (t: string, f: (e: unknown) => void) => (listeners[t] ||= []).push(f),
};
(globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
(globalThis as any).sessionStorage = { getItem: (k: string) => session.get(k) ?? null, setItem: (k: string, v: string) => void session.set(k, v), removeItem: (k: string) => void session.delete(k) };

type Reply = { status: number; body: unknown } | "network";
let script: (url: string, auth: string | null) => Reply | Promise<Reply> = () => ({ status: 200, body: {} });
const calls: { url: string; auth: string | null }[] = [];
(globalThis as any).fetch = async (url: string, init?: RequestInit) => {
  const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? null;
  calls.push({ url: url.replace("http://localhost:5001/api", ""), auth });
  const r = await script(url.replace("http://localhost:5001/api", ""), auth);
  if (r === "network") throw new TypeError("Failed to fetch");
  return { ok: r.status < 400, status: r.status, json: async () => r.body } as Response;
};

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const tokenWith = (iat: number, exp: number, tag = "x") => `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ userId: "u", iat, exp, tag })}.sig${tag}`;
const nowS = () => Math.floor(Date.now() / 1000);
const fresh = (tag = "f") => tokenWith(nowS() - 60, nowS() + 7 * 86400, tag);
const half = (tag = "h") => tokenWith(nowS() - 5 * 86400, nowS() + 2 * 86400, tag); // 2 of 7 days left
const realNow = Date.now; let skew = 0; Date.now = () => realNow() + skew; // each scenario starts 10 minutes later, so the 5-minute refresh throttle never carries over
const reset = () => { skew += 600_000; store.clear(); session.clear(); calls.length = 0; nav.path = "/dashboard"; nav.assigned = []; };

const api = await import("../../frontend/lib/api.ts");
const S = await import("../../frontend/lib/session.ts");

console.log("\n## pure rules");
ok("a normal token shape is accepted", S.tokenShapeOk(fresh()));
for (const j of ["undefined", "null", "", "a.b", "x y.z.w"]) ok(`"${j}" is not a token shape`, !S.tokenShapeOk(j));
const tt = S.tokenTimes(fresh());
ok("expiry is read from the token", !!tt && tt.exp - tt.iat > 6 * 86400);
ok("refresh once less than half is left", S.shouldRefresh(S.tokenTimes(half()), nowS(), 0, Date.now()));
ok("no refresh while more than half is left", !S.shouldRefresh(S.tokenTimes(fresh()), nowS(), 0, Date.now()));
ok("no refresh for an already expired token", !S.shouldRefresh(S.tokenTimes(tokenWith(nowS() - 9 * 86400, nowS() - 60)), nowS(), 0, Date.now()));
ok("no refresh storm: not again within 5 minutes", !S.shouldRefresh(S.tokenTimes(half()), nowS(), Date.now() - 60_000, Date.now()));
ok("nothing sent = never end the session", S.decideAuth({ sent: null, current: null, code: undefined, path: "/x", probeOk: null }) === "KEEP");
ok("probe cannot reach the server = keep (network trouble never signs anyone out)", S.decideAuth({ sent: "a", current: "a", code: "TOKEN_SIGNATURE", path: "/x", probeOk: null }) === "KEEP");
ok("login wrong-password style error is not an auth failure", !S.isAuthFailure(401, "Email or password is incorrect"));

console.log("\n## garbage in storage");
reset(); store.set("token", "undefined");
ok("'undefined' in storage reads as no token and is removed", api.getToken() === null && !store.has("token"));

console.log("\n## one failed request does not sign anyone out");
reset(); store.set("token", fresh());
script = (url) => (url === "/auth/me" ? { status: 200, body: { id: 1 } } : { status: 401, body: { error: "INVALID_TOKEN", code: "TOKEN_MALFORMED" } });
let err: any = null;
await api.apiGet("/tasks").catch((e) => (err = e));
ok("the call fails with a readable message (not the raw code)", err && !/INVALID_TOKEN/.test(err.message) && /session/i.test(err.message), err?.message);
ok("the session is still there (no redirect, token kept) because /auth/me still works", nav.assigned.length === 0 && store.has("token"), nav.assigned);

console.log("\n## a genuinely ended session");
reset(); store.set("token", fresh());
script = (url) => ({ status: 401, body: { error: "INVALID_TOKEN", code: "TOKEN_SIGNATURE" } });
err = null; await api.apiGet("/tasks").catch((e) => (err = e));
ok("token cleared, sent to /login once, notice stored", !store.has("token") && nav.assigned.length === 1 && nav.assigned[0] === "/login" && /no longer valid/.test(session.get("hrms-login-notice") ?? ""), { a: nav.assigned, n: session.get("hrms-login-notice") });
reset(); store.set("token", fresh());
script = () => ({ status: 401, body: { error: "INVALID_TOKEN", code: "TOKEN_EXPIRED" } });
await api.apiGet("/tasks").catch(() => {});
ok("an expired token ends the session without asking again, with a plain 'session expired' notice", !store.has("token") && calls.length === 1 && /expired/.test(session.get("hrms-login-notice") ?? ""), { calls: calls.length, n: session.get("hrms-login-notice") });
reset(); store.set("token", fresh());
script = () => ({ status: 401, body: { error: "ACCOUNT_INACTIVE", code: "ACCOUNT_INACTIVE" } });
await api.apiPost("/tasks", {}).catch(() => {});
ok("a switched-off account ends the session with its own message", !store.has("token") && /no longer active/.test(session.get("hrms-login-notice") ?? ""));
reset(); nav.path = "/login"; store.set("token", fresh());
script = () => ({ status: 401, body: { error: "INVALID_TOKEN", code: "TOKEN_EXPIRED" } });
await api.apiGet("/auth/me").catch(() => {});
ok("already on the sign-in page: no redirect loop", nav.assigned.length === 0);

console.log("\n## many failing calls at once");
reset(); store.set("token", fresh());
script = async (url) => { await new Promise((r) => setTimeout(r, 15)); return url === "/auth/me" ? { status: 200, body: {} } : { status: 401, body: { error: "INVALID_TOKEN", code: "TOKEN_MALFORMED" } }; };
await Promise.all(Array.from({ length: 20 }, () => api.apiGet("/tasks").catch(() => {})));
ok("20 simultaneous failures ask the server ONCE whether the session is alive", calls.filter((c) => c.url === "/auth/me").length === 1, calls.filter((c) => c.url === "/auth/me").length);
ok("and nobody is signed out", store.has("token") && nav.assigned.length === 0);

console.log("\n## refresh");
reset(); const h1 = half(); store.set("token", h1);
const newTok = fresh("new");
script = (url) => (url === "/auth/refresh" ? { status: 200, body: { token: newTok } } : { status: 200, body: { ok: 1 } });
await Promise.all(Array.from({ length: 10 }, () => api.apiGet("/tasks")));
ok("10 simultaneous calls on a half-used token cause exactly ONE refresh", calls.filter((c) => c.url === "/auth/refresh").length === 1, calls.map((c) => c.url));
ok("the fresh token is stored", store.get("token") === newTok);
ok("calls after the refresh use the new token", calls[calls.length - 1].auth === `Bearer ${newTok}`);
reset(); store.set("token", fresh());
script = () => ({ status: 200, body: {} });
await api.apiGet("/tasks");
ok("a token with plenty of life left is never refreshed", calls.every((c) => c.url !== "/auth/refresh"));
reset(); store.set("token", half());
script = (url) => (url === "/auth/refresh" ? { status: 500, body: {} } : { status: 200, body: { ok: 1 } });
let r: any = await api.apiGet("/tasks");
ok("a failed refresh does not break the call or sign anyone out", r.ok === 1 && store.has("token") && nav.assigned.length === 0);
reset(); store.set("token", half());
script = (url) => (url === "/auth/refresh" ? "network" : { status: 200, body: { ok: 1 } });
r = await api.apiGet("/tasks");
ok("offline during refresh: the call still goes ahead, token kept", r.ok === 1 && store.has("token"));
reset(); const h2 = half("a"); store.set("token", h2);
script = async (url) => { if (url === "/auth/refresh") { store.set("token", fresh("other-tab")); return { status: 200, body: { token: fresh("mine") } }; } return { status: 200, body: {} }; };
await api.apiGet("/tasks");
const tagOf = (tk: string | undefined) => JSON.parse(Buffer.from((tk ?? "..").split(".")[1], "base64url").toString() || "{}").tag;
ok("if another tab replaced the token meanwhile, this tab does not overwrite it", tagOf(store.get("token")) === "other-tab", tagOf(store.get("token")));

console.log("\n## another tab");
reset(); const stale = fresh("stale"); store.set("token", stale);
const newer = fresh("newer");
script = (url, auth) => {
  if (url === "/tasks" && auth === `Bearer ${stale}`) { store.set("token", newer); return { status: 401, body: { error: "INVALID_TOKEN", code: "TOKEN_SIGNATURE" } }; }
  return { status: 200, body: { ok: "retried" } };
};
r = await api.apiGet("/tasks");
ok("a call refused because another tab just replaced the token is repeated with the new one", r.ok === "retried" && nav.assigned.length === 0, { r, a: nav.assigned });
reset(); store.set("token", fresh());
for (const f of listeners.storage ?? []) f({ key: "token", newValue: null, oldValue: "x" });
ok("signing out in another tab sends this tab to /login too", nav.assigned.length === 1 && /another window/.test(session.get("hrms-login-notice") ?? ""));
reset(); for (const f of listeners.storage ?? []) f({ key: "token", newValue: "newtoken", oldValue: "x" });
ok("a token replaced elsewhere (a refresh) does not sign this tab out", nav.assigned.length === 0);
reset(); for (const f of listeners.storage ?? []) f({ key: "hrms-theme", newValue: null, oldValue: "DARK" });
ok("unrelated storage changes are ignored", nav.assigned.length === 0);

console.log("\n## things that must keep working");
reset(); store.set("token", fresh());
script = () => ({ status: 401, body: { error: "Email or password is incorrect" } });
err = null; await api.apiPost("/auth/login", { email: "a", password: "b" }).catch((e) => (err = e));
ok("a wrong password is just an error message (no session logic, no redirect)", err?.message === "Email or password is incorrect" && nav.assigned.length === 0 && store.has("token"));
reset();
script = () => ({ status: 401, body: { error: "NOT_AUTHENTICATED", code: "NO_TOKEN" } });
err = null; await api.apiGet("/public").catch((e) => (err = e));
ok("a call made with no token at all never triggers a redirect from the API layer", nav.assigned.length === 0 && !!err);
reset(); store.set("token", fresh());
script = () => ({ status: 403, body: { error: "Access Denied.", code: "IP_NOT_ALLOWED" } });
await api.apiGet("/tasks").catch(() => {});
ok("the network-rule sign-out still works", nav.assigned.length === 1 && session.get("hrms-login-notice") === "Access Denied.");
reset(); store.set("token", fresh());
script = () => ({ status: 400, body: { error: "LATE_REMARK_REQUIRED", code: "LATE_REMARK_REQUIRED", lateByMinutes: 12 } });
err = null; await api.apiPost("/tracker/clock-in", {}).catch((e) => (err = e));
ok("code and data still ride on POST errors", err?.code === "LATE_REMARK_REQUIRED" && err?.data?.lateByMinutes === 12);

reset();
script = () => ({ status: 429, body: { error: "TOO_MANY_ATTEMPTS", message: "Too many sign-in attempts. Try again in 7 minutes." } });
err = null; await api.apiPost("/auth/login", { email: "a", password: "b" }).catch((e) => (err = e));
ok("a sign-in lockout shows its own sentence, never the bare code", err?.message === "Too many sign-in attempts. Try again in 7 minutes.", err?.message);
script = () => ({ status: 429, body: { error: "TOO_MANY_ATTEMPTS" } });
err = null; await api.apiPost("/auth/login", { email: "a", password: "b" }).catch((e) => (err = e));
ok("a lockout without a sentence still reads as words", /Too many sign-in attempts/.test(err?.message) && !/TOO_MANY_ATTEMPTS/.test(err?.message), err?.message);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
