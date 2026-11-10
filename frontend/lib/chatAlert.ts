// Chat alerts: a short ping and an optional desktop notification when a message arrives.
// The ping is generated in the browser (no sound file). Both are off-switchable and the choice is remembered on this device.
// The desktop notification never contains message text: only "New message".

const SOUND_KEY = "chat.sound";
const DESKTOP_KEY = "chat.desktop";

export const soundOn = () => typeof window !== "undefined" && window.localStorage.getItem(SOUND_KEY) !== "off";
export const setSound = (on: boolean) => window.localStorage.setItem(SOUND_KEY, on ? "on" : "off");

export const desktopSupported = () => typeof window !== "undefined" && "Notification" in window;
export const desktopOn = () => desktopSupported() && window.localStorage.getItem(DESKTOP_KEY) === "on" && Notification.permission === "granted";

/** Must be called from a click: browsers only show the permission prompt after a user action. */
export async function enableDesktop(): Promise<boolean> {
  if (!desktopSupported()) return false;
  const result = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
  const ok = result === "granted";
  window.localStorage.setItem(DESKTOP_KEY, ok ? "on" : "off");
  return ok;
}
export const disableDesktop = () => window.localStorage.setItem(DESKTOP_KEY, "off");

let ctx: AudioContext | null = null;
/** Two soft notes. Silent (no error) if the browser has not allowed audio yet: it allows it after the person has clicked anywhere on the page. */
export function ping() {
  if (!soundOn()) return;
  try {
    ctx ??= new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    void ctx.resume();
    const t = ctx.currentTime;
    [[880, 0], [1175, 0.12]].forEach(([freq, at]) => {
      const osc = ctx!.createOscillator();
      const gain = ctx!.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t + at);
      gain.gain.exponentialRampToValueAtTime(0.18, t + at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + at + 0.3);
      osc.connect(gain).connect(ctx!.destination);
      osc.start(t + at);
      osc.stop(t + at + 0.32);
    });
  } catch {
    /* no audio available: stay quiet */
  }
}

/** Clicking the popup brings the chat forward. */
export function desktopAlert(onClick: () => void) {
  // Shown when the person is not looking at this tab: it is hidden, or its window does not have the focus.
  if (!desktopOn() || (document.visibilityState === "visible" && document.hasFocus())) return;
  try {
    const n = new Notification("New message", { body: "Open Chat to read it.", tag: "avatar-chat", icon: "/favicon.ico" });
    n.onclick = () => {
      window.focus();
      onClick();
      n.close();
    };
  } catch {
    /* not allowed here */
  }
}

/** What the browser currently says about notification permission, in words a person can act on. */
export function desktopStatus(): "unsupported" | "granted" | "denied" | "default" {
  if (!desktopSupported()) return "unsupported";
  return Notification.permission;
}

/** Shows a popup right now, whatever the window state, so the person can see whether popups work on this computer. */
export function testPopup(): string {
  if (!desktopSupported()) return "This browser does not support desktop popups.";
  if (Notification.permission === "denied") return "Blocked. Click the lock icon beside the address, set Notifications to Allow, then reload.";
  if (Notification.permission !== "granted") return "Not allowed yet. Tick the box and press Allow when the browser asks.";
  try {
    new Notification("Test popup", { body: "If you can see this, chat popups work.", tag: "avatar-chat-test" });
    return "Test sent. If nothing appeared, Windows is hiding it: turn off Do Not Disturb / Focus and check Settings, System, Notifications for your browser.";
  } catch (e) {
    return `The browser refused: ${e instanceof Error ? e.message : "unknown reason"}.`;
  }
}
