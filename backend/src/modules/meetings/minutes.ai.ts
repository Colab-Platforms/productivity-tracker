import "dotenv/config";
import { buildPrompt, MAX_TRANSCRIPT_CHARS, normalizeMinutes, type MinutesBody } from "./minutes.logic.js";

// ---------------------------------------------------------------------------
// The ONLY place that talks to the speech-to-text and summary models. Today both come from one free hosted tier (Groq: Whisper large-v3
// for speech, an open model for the summary). To change provider, change this file only; the rest of the app never sees the provider.
// Keys and model names come from backend/.env (GROQ_API_KEY, optional MINUTES_STT_MODEL / MINUTES_LLM_MODEL).
// The audio is sent, transcribed and dropped: nothing here writes it anywhere.
// ---------------------------------------------------------------------------

const BASE = process.env.MINUTES_API_BASE || "https://api.groq.com/openai/v1";
export const STT_MODEL = process.env.MINUTES_STT_MODEL || "whisper-large-v3";
export const LLM_MODEL = process.env.MINUTES_LLM_MODEL || "openai/gpt-oss-120b";

export const aiConfigured = () => !!process.env.GROQ_API_KEY;

const EXT: Record<string, string> = { "audio/webm": "webm", "audio/ogg": "ogg", "audio/mp4": "m4a", "audio/mpeg": "mp3", "audio/wav": "wav", "audio/x-wav": "wav", "audio/x-m4a": "m4a", "audio/m4a": "m4a", "audio/flac": "flac" };
export const extFor = (mime: string) => EXT[mime.split(";")[0].trim().toLowerCase()] ?? null;

async function call(path: string, init: RequestInit, timeoutMs: number): Promise<Record<string, unknown>> {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error("MINUTES_NOT_CONFIGURED");
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    console.error("[minutes] request failed:", e instanceof Error ? e.message : e);
    throw new Error("AI_UNREACHABLE");
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    console.error(`[minutes] ${path} -> HTTP ${res.status}: ${detail}`);
    if (res.status === 401 || res.status === 403) throw new Error("AI_KEY_INVALID");
    if (res.status === 429) throw new Error("AI_RATE_LIMITED");
    if (res.status === 413) throw new Error("AUDIO_TOO_LARGE");
    throw new Error("AI_FAILED");
  }
  return (await res.json()) as Record<string, unknown>;
}

/** Speech to text. `language` is an optional ISO code hint (en, hi, mr); empty = detect. */
/** `vocabulary` (meeting title, people, company) is passed as a spelling hint so names and place names come out right. */
export async function transcribe(audio: Buffer, mime: string, language?: string, vocabulary?: string): Promise<{ text: string; language: string | null }> {
  const ext = extFor(mime);
  if (!ext) throw new Error("BAD_AUDIO_TYPE");
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(audio)], { type: mime.split(";")[0] }), `meeting.${ext}`);
  form.append("model", STT_MODEL);
  form.append("response_format", "verbose_json");
  form.append("temperature", "0");
  if (language) form.append("language", language);
  if (vocabulary) form.append("prompt", vocabulary.slice(0, 600));
  const out = await call("/audio/transcriptions", { method: "POST", body: form }, 8 * 60_000);
  return { text: String(out.text ?? "").trim(), language: typeof out.language === "string" ? out.language : null };
}

/** Transcript to minutes. The model may only reformat what was said; the answer is forced into the fixed shape. */
export async function summarize(transcript: string, ctx: { title: string; attendees: string[]; outputLanguage: "english" | "original" }): Promise<MinutesBody> {
  const { system } = buildPrompt(ctx);
  const out = await call(
    "/chat/completions",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: LLM_MODEL,
        temperature: 0.1,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: `Transcript:\n"""\n${transcript.slice(0, MAX_TRANSCRIPT_CHARS)}\n"""` },
        ],
      }),
    },
    3 * 60_000
  );
  const content = ((out.choices as { message?: { content?: string } }[] | undefined)?.[0]?.message?.content ?? "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    console.error("[minutes] summary was not JSON");
    throw new Error("AI_FAILED");
  }
  return normalizeMinutes(parsed);
}
