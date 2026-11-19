// The live (websocket) connection obeys the same network policy. Needs the throwaway backend on 5012 in ENFORCE mode with 206.84.235.169 allowed
// (see tests/ip-access.test.cjs). socket.io-client is loaded from the frontend's node_modules (it is not a backend dependency).
import { createRequire } from "node:module";
import path from "node:path";
const reqFront = createRequire(path.resolve(import.meta.dirname, "../../frontend/package.json"));
const reqBack = createRequire(path.resolve(import.meta.dirname, "x.cjs"));
const { io } = reqFront("socket.io-client");
const { Client } = reqBack("pg");
const bcrypt = reqBack("bcryptjs");

const HOST = "http://localhost:5012", API = HOST + "/api";
const OFFICE = "206.84.235.169", OTHER = "103.212.140.53", PW = "Ips@12345678";
let pass = 0, fail = 0;
const ok = (n: string, c: boolean, x?: unknown) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (!c && x !== undefined ? "  -> " + JSON.stringify(x).slice(0, 200) : "")); };

const db = new Client({ connectionString: "postgresql://postgres:localtest@127.0.0.1:54329/dq_test" });
await db.connect();
const A = (await db.query(`select id from platforms where slug='avatar'`)).rows[0].id;
await db.query(`delete from users where "employeeCode"='IPS-EMP'`);
await db.query(`insert into users (id,"platformId",email,"passwordHash","firstName","lastName","employeeCode",role,status,"mustChangePassword","trackerAccessEnabled","onboardingStatus","createdAt","updatedAt") values (gen_random_uuid(),$1,'ips-emp@ips.test',$2,'Ips','Sock','IPS-EMP','EMPLOYEE','ACTIVE',false,true,'ACTIVE',now(),now())`, [A, await bcrypt.hash(PW, 10)]);
const login = await fetch(API + "/auth/login", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": OFFICE }, body: JSON.stringify({ email: "IPS-EMP", password: PW }) });
const token = (await login.json()).token as string;
ok("signed in from the office", !!token);

const connect = (ip: string | null) =>
  new Promise<"connected" | "refused">((resolve) => {
    const s = io(HOST, { auth: { token }, transports: ["websocket"], reconnection: false, extraHeaders: ip ? { "x-forwarded-for": ip } : undefined });
    const done = (v: "connected" | "refused") => { s.close(); resolve(v); };
    s.on("connect", () => setTimeout(() => done("connected"), 300));
    s.on("connect_error", () => done("refused"));
    setTimeout(() => done("refused"), 8000);
  });

ok("a live connection from the authorised address is accepted", (await connect(OFFICE)) === "connected");
ok("a live connection from another address is refused", (await connect(OTHER)) === "refused");
ok("a forged header (allowed address written first) is refused", (await connect(`${OFFICE}, ${OTHER}`)) === "refused");
ok("and accepted again from the office afterwards", (await connect(OFFICE)) === "connected");

await db.query(`update audit_logs set "actorId"=null where "actorId" in (select id from users where "employeeCode"='IPS-EMP')`).catch(() => {});
await db.query(`delete from users where "employeeCode"='IPS-EMP'`).catch(() => {});
await db.end();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
