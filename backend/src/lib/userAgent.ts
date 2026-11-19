// ---------------------------------------------------------------------------
// DEVICE INFORMATION from the browser's User-Agent text. A small reader written here on purpose (no extra package).
//
// WHAT THIS IS: the browser, the operating system and the kind of device the browser SAYS it is. WHAT IT IS NOT: a way to identify one particular
// computer. The text is sent by the browser, can be changed by the user, and is the same on thousands of machines. So it is shown as "device
// information", never as proof of which PC it was. Anything it cannot read is left empty, never guessed.
// ---------------------------------------------------------------------------

export type DeviceInfo = {
  browserName: string | null;
  browserVersion: string | null;
  osName: string | null;
  osVersion: string | null;
  deviceType: "Desktop" | "Mobile" | "Tablet" | "Bot" | "Unknown";
};

const major = (v: string | undefined) => (v ? v.split(/[._]/)[0] : null);

export function parseUserAgent(raw: unknown): DeviceInfo {
  const ua = typeof raw === "string" ? raw.slice(0, 400) : "";
  const none: DeviceInfo = { browserName: null, browserVersion: null, osName: null, osVersion: null, deviceType: "Unknown" };
  if (!ua.trim()) return none;

  // ---- browser (order matters: most browsers also say "Chrome" and "Safari") ----
  let browserName: string | null = null;
  let browserVersion: string | null = null;
  const pick = (name: string, re: RegExp) => {
    const m = re.exec(ua);
    if (m) { browserName = name; browserVersion = major(m[1]); return true; }
    return false;
  };
  pick("Edge", /\bEdg(?:e|A|iOS)?\/(\d+[\d.]*)/) ||
    pick("Opera", /\b(?:OPR|Opera)\/(\d+[\d.]*)/) ||
    pick("Samsung Internet", /\bSamsungBrowser\/(\d+[\d.]*)/) ||
    pick("Firefox", /\b(?:Firefox|FxiOS)\/(\d+[\d.]*)/) ||
    pick("Chrome", /\b(?:Chrome|CriOS)\/(\d+[\d.]*)/) ||
    (/\bSafari\//.test(ua) && pick("Safari", /\bVersion\/(\d+[\d.]*)/)) ||
    pick("Internet Explorer", /\b(?:MSIE |rv:)(\d+[\d.]*)\b.*Trident|Trident.*rv:(\d+[\d.]*)/);

  // ---- operating system ----
  let osName: string | null = null;
  let osVersion: string | null = null;
  let m: RegExpExecArray | null;
  if ((m = /Windows NT (\d+\.\d+)/.exec(ua))) {
    osName = "Windows";
    osVersion = ({ "10.0": "10 or 11", "6.3": "8.1", "6.2": "8", "6.1": "7" } as Record<string, string>)[m[1]] ?? m[1];
  } else if ((m = /Android (\d+[\d.]*)/.exec(ua))) { osName = "Android"; osVersion = major(m[1]); }
  else if ((m = /(?:iPhone|iPad|iPod).*? OS (\d+[_\d]*)/.exec(ua))) { osName = "iOS"; osVersion = major(m[1]); }
  else if ((m = /Mac OS X (\d+[_\d.]*)/.exec(ua))) { osName = "macOS"; osVersion = major(m[1]); }
  else if (/CrOS/.test(ua)) osName = "ChromeOS";
  else if (/Linux/.test(ua)) osName = "Linux";

  // ---- kind of device ----
  let deviceType: DeviceInfo["deviceType"] = "Desktop";
  if (/bot|crawler|spider|curl\/|wget\/|python-requests|node-fetch|axios\/|postman|insomnia|go-http-client|java\//i.test(ua)) deviceType = "Bot";
  else if (/iPad|Tablet|PlayBook|Silk\/|(Android(?!.*Mobile))/i.test(ua)) deviceType = "Tablet";
  else if (/Mobi|iPhone|iPod|Android.*Mobile|Windows Phone/i.test(ua)) deviceType = "Mobile";
  else if (!osName && !browserName) deviceType = "Unknown";

  return { browserName, browserVersion, osName, osVersion, deviceType };
}

export const cleanUserAgent = (raw: unknown) => (typeof raw === "string" ? raw.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 300) || null : null);
