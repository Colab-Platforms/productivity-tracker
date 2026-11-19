// Reading the browser / OS / device from real User-Agent strings. No database.
import { parseUserAgent, cleanUserAgent } from "../src/lib/userAgent.ts";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, x?: unknown) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (!c && x !== undefined ? "  -> " + JSON.stringify(x).slice(0, 300) : "")); };
const t = (name: string, ua: string, want: Partial<ReturnType<typeof parseUserAgent>>) => { const g = parseUserAgent(ua); ok(name, Object.entries(want).every(([k, v]) => (g as Record<string, unknown>)[k] === v), g); };

t("Chrome on Windows 10/11", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36", { browserName: "Chrome", browserVersion: "130", osName: "Windows", osVersion: "10 or 11", deviceType: "Desktop" });
t("Edge is not called Chrome", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.2849.56", { browserName: "Edge", browserVersion: "130" });
t("Firefox on Linux", "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0", { browserName: "Firefox", browserVersion: "132", osName: "Linux", deviceType: "Desktop" });
t("Safari on a Mac", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15", { browserName: "Safari", browserVersion: "17", osName: "macOS", osVersion: "10", deviceType: "Desktop" });
t("Chrome on an Android phone", "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36", { browserName: "Chrome", osName: "Android", osVersion: "14", deviceType: "Mobile" });
t("Chrome on an Android tablet (no 'Mobile')", "Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36", { osName: "Android", deviceType: "Tablet" });
t("Safari on an iPhone", "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1", { browserName: "Safari", osName: "iOS", osVersion: "17", deviceType: "Mobile" });
t("Chrome on an iPhone", "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.6723.37 Mobile/15E148 Safari/604.1", { browserName: "Chrome", osName: "iOS", deviceType: "Mobile" });
t("Safari on an iPad", "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1", { osName: "iOS", deviceType: "Tablet" });
t("Opera", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 OPR/115.0.0.0", { browserName: "Opera", browserVersion: "115" });
t("Samsung Internet", "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36", { browserName: "Samsung Internet", deviceType: "Mobile" });
t("a script is a Bot, not a person's browser", "python-requests/2.31.0", { deviceType: "Bot" });
t("curl is a Bot", "curl/8.4.0", { deviceType: "Bot" });
t("Node's own fetch", "node-fetch/1.0", { deviceType: "Bot" });
t("an empty or missing text is Unknown, nothing guessed", "", { browserName: null, osName: null, deviceType: "Unknown" });
ok("a missing header is Unknown", parseUserAgent(undefined).deviceType === "Unknown" && parseUserAgent(null).browserName === null && parseUserAgent(42).osName === null);
t("nonsense is Unknown with nothing invented", "hello world", { browserName: null, osName: null, deviceType: "Unknown" });
const long = parseUserAgent("Mozilla/5.0 " + "x".repeat(5000) + " Chrome/120.0");
ok("a huge text is handled safely", long.deviceType !== undefined);
ok("the stored text has no control characters and is capped", cleanUserAgent("a\u0000b\n" + "z".repeat(900))!.length === 300 && !/[\u0000-\u001f]/.test(cleanUserAgent("a\u0000b\nc")!));
ok("nothing is claimed about WHICH computer it was", !("deviceId" in parseUserAgent("Mozilla/5.0 (Windows NT 10.0) Chrome/130.0")) && !("machine" in parseUserAgent("x")));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
