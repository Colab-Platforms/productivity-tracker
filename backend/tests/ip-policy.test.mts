// The network access policy as pure rules: modes, the allow list, normalising addresses, the hop rule. No database.
import { clientFromChain, trustedProxyCheck, evaluate, ipAllowed, ipBehindProxy, normalizeIp, parseAllowList, policyFromEnv, ACCESS_DENIED_MESSAGE } from "../src/lib/ipPolicy.ts";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, x?: unknown) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (!c && x !== undefined ? "  -> " + JSON.stringify(x).slice(0, 300) : "")); };
const OFFICE = "206.84.235.169";
const pol = (mode: string | undefined, ips: string | undefined) => policyFromEnv({ LOGIN_IP_MODE: mode, LOGIN_ALLOWED_IPS: ips });

console.log("\n## the owner's address");
const enforce = pol("enforce", OFFICE);
ok("the office address is allowed", evaluate(OFFICE, enforce).allowed && !evaluate(OFFICE, enforce).blocked);
ok("any other address is blocked in enforce mode", evaluate("103.212.140.53", enforce).blocked && !evaluate("103.212.140.53", enforce).allowed);
ok("a neighbouring address is NOT allowed (206.84.235.168 and .170)", evaluate("206.84.235.168", enforce).blocked && evaluate("206.84.235.170", enforce).blocked);
ok("an address that only starts the same is NOT allowed (206.84.235.16)", evaluate("206.84.235.16", enforce).blocked && evaluate("206.84.235.1690", enforce).blocked);
ok("local and unknown addresses are blocked (nothing is allowed by default)", evaluate("::1", enforce).blocked && evaluate("127.0.0.1", enforce).blocked && evaluate(null, enforce).blocked && evaluate("", enforce).blocked);
ok("a reason is given, and it names no address", evaluate("9.9.9.9", enforce).reason === "The caller's IP address is not on the authorised list" && !/9\.9\.9\.9/.test(evaluate("9.9.9.9", enforce).reason ?? ""));
ok("the denial message is exactly the owner's text", ACCESS_DENIED_MESSAGE === "Access Denied. You are not authorized to access Avatar HRMS from this network. Please connect using the authorized office network or contact the HR/Admin team.");

console.log("\n## spellings of the same address");
ok("IPv4 carried inside IPv6 is the same address", evaluate("::ffff:206.84.235.169", enforce).allowed && normalizeIp("::FFFF:206.84.235.169") === OFFICE);
ok("spaces, brackets and a port do not matter", evaluate("  206.84.235.169 ", enforce).allowed && normalizeIp("[::ffff:206.84.235.169]") === OFFICE && normalizeIp("206.84.235.169:51234") === OFFICE);
ok("garbage is never allowed", ["abc", "999.1.1.1", "206.84.235", "206.84.235.169.5", "<script>", "'; drop table users;--"].every((x) => !ipAllowed(x, enforce.rules)), enforce.rules);

console.log("\n## the modes");
ok("unset or off: nothing is checked", [pol(undefined, OFFICE), pol("off", OFFICE), pol("", OFFICE), pol("OFF", OFFICE)].every((p) => { const v = evaluate("9.9.9.9", p); return v.mode === "off" && v.allowed && !v.blocked && !v.wouldBlock; }));
const mon = pol("monitor", OFFICE);
ok("monitor: nobody is blocked, an outsider is flagged 'would block'", evaluate("9.9.9.9", mon).wouldBlock && !evaluate("9.9.9.9", mon).blocked && evaluate(OFFICE, mon).allowed && !evaluate(OFFICE, mon).wouldBlock);
ok("the mode is not case-sensitive", pol("ENFORCE", OFFICE).mode === "enforce" && pol(" Monitor ", OFFICE).mode === "monitor");
const typo = pol("enforced", OFFICE);
ok("a typo FAILS CLOSED: it enforces and is reported", typo.mode === "enforce" && !!typo.problem && evaluate("9.9.9.9", typo).blocked && evaluate(OFFICE, typo).allowed, typo);
const empty = pol("enforce", "");
ok("enforce with no allowed address FAILS CLOSED: everyone is refused, and it says so", empty.mode === "enforce" && /no valid address/.test(empty.problem ?? "") && evaluate(OFFICE, empty).blocked && evaluate("1.2.3.4", empty).blocked);
const junk = pol("enforce", "not-an-ip, 999.9.9.9");
ok("enforce with only invalid entries behaves the same (everyone refused)", junk.mode === "enforce" && junk.invalid.length === 2 && evaluate(OFFICE, junk).blocked);
const some = pol("enforce", `bad, ${OFFICE}`);
ok("one valid entry among invalid ones still enforces, and reports the invalid one", some.mode === "enforce" && some.invalid.join() === "bad" && !!some.problem && evaluate("9.9.9.9", some).blocked && evaluate(OFFICE, some).allowed);

console.log("\n## the list");
const many = pol("enforce", `${OFFICE}, 203.0.113.0/24 ,2001:db8::1`);
ok("several addresses, a range and an IPv6 address", [OFFICE, "203.0.113.7", "203.0.113.255", "2001:db8::1"].every((x) => evaluate(x, many).allowed) && evaluate("203.0.114.1", many).blocked && evaluate("2001:db8::2", many).blocked);
ok("a /0 or a range wider than /8 is refused (it would allow the internet)", parseAllowList("0.0.0.0/0").invalid.length === 1 && parseAllowList("10.0.0.0/7").invalid.length === 1 && parseAllowList("10.0.0.0/8").rules.length === 1);
ok("/32 is one address", evaluate(OFFICE, pol("enforce", `${OFFICE}/32`)).allowed && evaluate("206.84.235.168", pol("enforce", `${OFFICE}/32`)).blocked);

console.log("\n## the address behind a proxy (the hop rule, as Express counts it)");
ok("one trusted proxy: the address the proxy saw is the client", ipBehindProxy(OFFICE, "10.0.0.5", 1) === OFFICE);
ok("a client that sends its own header cannot choose its address: the proxy's entry is on the right", ipBehindProxy(`${OFFICE}, 9.9.9.9`, "10.0.0.5", 1) === "9.9.9.9");
ok("no proxy header: the connection itself", ipBehindProxy(undefined, "9.9.9.9", 1) === "9.9.9.9" && ipBehindProxy("", "9.9.9.9", 1) === "9.9.9.9");
ok("no trusted proxy configured: the header is ignored", ipBehindProxy(OFFICE, "9.9.9.9", 0) === "9.9.9.9");
ok("two trusted proxies", ipBehindProxy(`1.1.1.1, ${OFFICE}`, "10.0.0.5", 2) === "1.1.1.1" && ipBehindProxy(`${OFFICE}`, "10.0.0.5", 2) === OFFICE);
ok("nothing known at all", ipBehindProxy(undefined, undefined, 1) === null);

console.log("\n## the trusted-proxy rule (who the client really is)");
{
  const trust = trustedProxyCheck({});
  const ENF = policyFromEnv({ LOGIN_IP_MODE: "enforce", LOGIN_ALLOWED_IPS: OFFICE });
  ok("a phone that connects DIRECTLY and forges the office address is seen as its own address", clientFromChain("49.36.10.20", "206.84.235.169", trust) === "49.36.10.20");
  ok("...and is refused in enforce mode", evaluate(clientFromChain("49.36.10.20", "206.84.235.169", trust), ENF).blocked);
  ok("through the hosting load balancer (private 10.x): the address it appended is the client", clientFromChain("10.2.3.4", "206.84.235.169", trust) === "206.84.235.169");
  ok("a forged office address on the LEFT of what the proxy appended does not help", clientFromChain("10.2.3.4", "206.84.235.169, 49.36.10.20", trust) === "49.36.10.20");
  ok("two private proxies in a row are both skipped", clientFromChain("10.0.0.5", "49.36.10.20, 172.16.0.9", trust) === "49.36.10.20");
  ok("an unknown PUBLIC proxy is not trusted: it is treated as the client (everyone refused = fail closed)", clientFromChain("104.16.1.1", "206.84.235.169", trust) === "104.16.1.1");
  ok("TRUSTED_PROXIES lets a known public proxy (e.g. a CDN range) pass the real client through", clientFromChain("104.16.1.1", "206.84.235.169", trustedProxyCheck({ TRUSTED_PROXIES: "104.16.0.0/13" })) === "206.84.235.169");
  ok("no address at all = null, refused in enforce", clientFromChain(undefined, "", trust) === null && evaluate(null, ENF).blocked);
  ok("IPv6 from a phone network is refused", evaluate(clientFromChain("2401:4900:1c3a::1", "", trust), ENF).blocked);
  ok("the office address carried as IPv6-mapped is allowed", evaluate(clientFromChain("10.0.0.1", "::ffff:206.84.235.169", trust), ENF).allowed);
  ok("private IPv6 (fd00::/8) and loopback are proxies; a public IPv6 is not", trust("fd12::1") && trust("::1") && trust("127.0.0.1") && !trust("2401:4900::1"));
  ok("home Wi-Fi / another office (other public IPv4) is refused", evaluate(clientFromChain("10.0.0.1", "122.170.5.6", trust), ENF).blocked && evaluate(clientFromChain("10.0.0.1", "206.84.235.170", trust), ENF).blocked);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
