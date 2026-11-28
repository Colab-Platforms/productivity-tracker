import nodemailer, { type Transporter } from "nodemailer";

// ---------------------------------------------------------------------------
// MAIL
//
// Two ways out, tried in this order:
//
//   1. Brevo's HTTPS API (BREVO_API_KEY). Goes out over port 443, the same
//      port a browser uses, so a host can never block it. Render blocks
//      outbound SMTP ports on free instances, which is why this exists.
//   2. Generic SMTP (SMTP_HOST etc). Works on a laptop and on any host that
//      allows it, and keeps Google Workspace and Microsoft 365 usable by
//      changing .env rather than changing code.
//
// With neither configured it does NOT throw - it logs the message to the
// backend terminal and reports why. The onboarding flow stays fully testable
// before any mailbox exists, and a mail outage can never block HR from
// creating a joiner.
// ---------------------------------------------------------------------------

type Mail = {
  to: string;
  subject: string;
  html: string;
  text?: string;
};

const API_KEY = process.env.BREVO_API_KEY ?? "";

const HOST = process.env.SMTP_HOST ?? "";
const PORT = Number(process.env.SMTP_PORT ?? 587);
const USER = process.env.SMTP_USER ?? "";
const PASS = process.env.SMTP_PASS ?? "";
const FROM =
  process.env.SMTP_FROM ?? (USER ? `Avatar HRMS <${USER}>` : "");

const smtpConfigured = Boolean(HOST && USER && PASS);
const apiConfigured = Boolean(API_KEY && FROM);

export const mailConfigured = apiConfigured || smtpConfigured;

// Which route is in use, for the startup log and for diagnosing a live site
// without guessing.
export const mailMode: "api" | "smtp" | "none" = apiConfigured
  ? "api"
  : smtpConfigured
  ? "smtp"
  : "none";

  // Printed once at startup. Four test users were created before anyone could
// tell whether the key had even reached the server - a missing variable
// should announce itself, not wait to be deduced from a failed send.
console.log(
  `[mail] mode=${mailMode}` +
    ` brevoKey=${API_KEY ? `present(${API_KEY.length})` : "MISSING"}` +
    ` from="${FROM}"` +
    ` smtpHost=${HOST || "MISSING"}` +
    ` smtpUser=${USER ? "present" : "MISSING"}` +
    ` smtpPass=${PASS ? "present" : "MISSING"}` +
    ` appUrl=${process.env.APP_URL || "MISSING"}`
);

// Brevo's API wants the sender as a name and an address separately, while
// SMTP_FROM may be either "Name <addr>" or a bare address. Parsed once.
function parseFrom(raw: string): { name: string; email: string } {
  const m = /^\s*(.*?)\s*<\s*([^>]+?)\s*>\s*$/.exec(raw);
  if (m) return { name: m[1] || "Productivity Tracker", email: m[2] };
  return { name: "Productivity Tracker", email: raw.trim() };
}

let transport: Transporter | null = null;

function getTransport() {
  if (!smtpConfigured) return null;
  if (transport) return transport;

  transport = nodemailer.createTransport({
    host: HOST,
    port: PORT,
    // 465 is implicit TLS; 587 and 2525 upgrade with STARTTLS.
    secure: PORT === 465,
    auth: { user: USER, pass: PASS },
  });

  return transport;
}

// Strips tags for the plain-text part. Some corporate mail clients show only
// text, and a mail with no text part scores worse with spam filters.
function toText(html: string) {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, "\n")
    .replace(/<li>/gi, "  - ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function sendViaApi(
  mail: Mail,
  text: string,
): Promise<{ sent: boolean; reason?: string }> {
  const sender = parseFrom(FROM);

  try {
    // A hung request must not hold a web request open. 15s is generous for an
    // API call that normally answers in under a second.
    const res = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "api-key": API_KEY,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        sender,
        to: [{ email: mail.to }],
        subject: mail.subject,
        htmlContent: mail.html,
        textContent: text,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (res.ok) return { sent: true };

    // Brevo explains refusals properly - an unverified sender, a bad key, a
    // spent quota. Worth printing verbatim rather than a status code alone.
    const body = await res.text().catch(() => "");
    console.error(`[mail] Brevo API ${res.status}: ${body.slice(0, 500)}`);
    return { sent: false, reason: `BREVO_${res.status}` };
  } catch (err) {
    console.error("[mail] Brevo API request failed:", err);
    return {
      sent: false,
      reason: err instanceof Error ? err.message : "API_FAILED",
    };
  }
}

async function sendViaSmtp(
  mail: Mail,
  text: string,
): Promise<{ sent: boolean; reason?: string }> {
  const t = getTransport();
  if (!t) return { sent: false, reason: "SMTP_NOT_CONFIGURED" };

  try {
    await t.sendMail({
      from: FROM,
      to: mail.to,
      subject: mail.subject,
      html: mail.html,
      text,
    });
    return { sent: true };
  } catch (err) {
    console.error("[mail] SMTP send failed:", err);
    return {
      sent: false,
      reason: err instanceof Error ? err.message : "SEND_FAILED",
    };
  }
}

export async function sendMail(mail: Mail): Promise<{
  sent: boolean;
  reason?: string;
}> {
  const text = mail.text ?? toText(mail.html);

  // DEMO MODE: nothing ever leaves the demo server. The message is dropped and reported as not sent.
  if (process.env.DEMO_MODE === "true") {
    console.log(`[mail] demo mode: email switched off, not sent (${mail.subject})`);
    return { sent: false, reason: "Demo mode: email is switched off." };
  }

  if (apiConfigured) {
    const viaApi = await sendViaApi(mail, text);
    if (viaApi.sent) {
      console.log(`[mail] sent via API to ${mail.to} - ${mail.subject}`);
      return viaApi;
    }
    // The API is configured but refused. If SMTP is also set up it is worth
    // one attempt; on a host that blocks the ports it fails fast and the
    // original API reason is what gets reported.
    if (smtpConfigured) {
      const viaSmtp = await sendViaSmtp(mail, text);
      if (viaSmtp.sent) {
        console.log(`[mail] sent via SMTP to ${mail.to} - ${mail.subject}`);
        return viaSmtp;
      }
    }
    return viaApi;
  }

  if (smtpConfigured) {
    const viaSmtp = await sendViaSmtp(mail, text);
    if (viaSmtp.sent) {
      console.log(`[mail] sent via SMTP to ${mail.to} - ${mail.subject}`);
    }
    return viaSmtp;
  }

  console.log("");
  console.log("-".repeat(66));
  console.log("EMAIL NOT SENT - no mail route configured. It would have said:");
  console.log("-".repeat(66));
  console.log(`To      : ${mail.to}`);
  console.log(`Subject : ${mail.subject}`);
  console.log("");
  console.log(text);
  console.log("-".repeat(66));
  console.log("");
  return { sent: false, reason: "MAIL_NOT_CONFIGURED" };
}