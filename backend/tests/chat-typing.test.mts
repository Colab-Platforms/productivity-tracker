// Typing hint over a real Socket.IO server. Needs no database. Run: DATABASE_URL=postgresql://u:p@127.0.0.1:1/x npx tsx tests/chat-typing.test.mts
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { startRealtime, stopRealtime } from "../src/lib/realtime.ts";

const requireFromFrontend = createRequire(new URL("../../frontend/package.json", import.meta.url));
const { io: connect } = requireFromFrontend("socket.io-client") as { io: (url: string, opts: object) => any };

const MEMBERS = ["a", "b", "c"]; // conversation "conv1" has a, b, c. "d" is outside.
let fail = 0;
const check = (name: string, ok: boolean) => { console.log(ok ? "PASS" : "FAIL", name); if (!ok) fail++; };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const http = createServer();
startRealtime(http, {
  origins: ["*"],
  authenticate: async (t) => (["a", "b", "c", "d"].includes(t) ? { userId: t, role: "EMPLOYEE", platformId: "p" } : null),
  personsFor: async () => [],
  typingAudience: async (u, conv) => (conv === "conv1" && MEMBERS.includes(u) ? MEMBERS.filter((x) => x !== u) : []),
});
await new Promise<void>((r) => http.listen(0, r));
const url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;

const heard: Record<string, any[]> = { a: [], b: [], c: [], d: [] };
const sockets: Record<string, any> = {};
for (const id of ["a", "b", "c", "d"]) {
  sockets[id] = connect(url, { auth: { token: id }, transports: ["websocket"] });
  sockets[id].on("chat:typing", (e: unknown) => heard[id].push(e));
  await new Promise<void>((r) => sockets[id].on("ready", () => r()));
}

sockets.a.emit("chat:typing", { conversationId: "conv1" });
await wait(300);
check("the other members hear it", heard.b.length === 1 && heard.c.length === 1);
check("the typist does not hear their own", heard.a.length === 0);
check("a non-member hears nothing", heard.d.length === 0);
check("the hint names only the conversation and the person", JSON.stringify(heard.b[0]) === JSON.stringify({ conversationId: "conv1", userId: "a" }));

sockets.a.emit("chat:typing", { conversationId: "conv1" });
sockets.a.emit("chat:typing", { conversationId: "conv1" });
await wait(300);
check("repeats inside 2 seconds are dropped", heard.b.length === 1);

sockets.d.emit("chat:typing", { conversationId: "conv1" });
await wait(300);
check("a non-member typing into someone else's chat reaches nobody", heard.a.length === 0 && heard.b.length === 1);

sockets.a.emit("chat:typing", { conversationId: 5 });
sockets.a.emit("chat:typing", null);
sockets.a.emit("chat:typing", { conversationId: "x".repeat(100) });
await wait(300);
check("malformed hints are ignored", heard.b.length === 1);

await wait(2100);
sockets.a.emit("chat:typing", { conversationId: "conv1" });
await wait(300);
check("typing works again after 2 seconds", heard.b.length === 2);

for (const s of Object.values(sockets)) s.disconnect();
await stopRealtime();
http.close();
console.log(fail ? `${fail} FAILED` : "all passed");
process.exit(fail ? 1 : 0);
