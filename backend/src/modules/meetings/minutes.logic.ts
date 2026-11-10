// Pure rules for meeting minutes (MOM). No database, no network: easy to test.

export type ActionItem = { task: string; owner: string | null; due: string | null };
export type Topic = { topic: string; points: string[] };
export type MinutesBody = { summary: string; agenda: string[]; discussion: Topic[]; decisions: string[]; actionItems: ActionItem[]; nextMeeting: string | null };

export const LIMITS = { summary: 4000, decision: 500, decisions: 30, task: 300, owner: 100, due: 40, items: 30, agenda: 20, agendaItem: 200, topics: 20, topic: 200, points: 15, point: 600, next: 300 } as const;
/** Free speech-to-text tiers refuse bigger files; the recorder uses a low bitrate so this is roughly 2 hours. */
export const MAX_AUDIO_BYTES = 24 * 1024 * 1024;
/** Less than this many characters of speech means there is nothing to write minutes from. */
export const MIN_TRANSCRIPT_CHARS = 30;
/** Keeps the transcript inside the summary model's input limit. */
export const MAX_TRANSCRIPT_CHARS = 90_000;

const clean = (v: unknown, max: number): string => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const orNull = (v: unknown, max: number): string | null => {
  const s = clean(v, max);
  return s && !/^(null|none|n\/a|unknown|not (stated|specified|mentioned))$/i.test(s) ? s : null;
};

/** Turns whatever the model returned into the fixed shape. Anything missing becomes empty; nothing is invented. */
export function normalizeMinutes(raw: unknown): MinutesBody {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const decisions = (Array.isArray(o.decisions) ? o.decisions : [])
    .map((d) => clean(typeof d === "object" && d ? (d as Record<string, unknown>).decision ?? (d as Record<string, unknown>).text : d, LIMITS.decision))
    .filter(Boolean)
    .slice(0, LIMITS.decisions);
  const actionItems = (Array.isArray(o.actionItems) ? o.actionItems : Array.isArray(o.action_items) ? (o.action_items as unknown[]) : [])
    .map((a) => {
      if (typeof a === "string") return { task: clean(a, LIMITS.task), owner: null, due: null };
      const r = (a ?? {}) as Record<string, unknown>;
      return { task: clean(r.task ?? r.action ?? r.item, LIMITS.task), owner: orNull(r.owner ?? r.assignee ?? r.assignedTo, LIMITS.owner), due: orNull(r.due ?? r.dueDate ?? r.deadline, LIMITS.due) };
    })
    .filter((a) => a.task)
    .slice(0, LIMITS.items);
  const agenda = (Array.isArray(o.agenda) ? o.agenda : []).map((a) => clean(a, LIMITS.agendaItem)).filter(Boolean).slice(0, LIMITS.agenda);
  const discussion = (Array.isArray(o.discussion) ? o.discussion : [])
    .map((t) => {
      const r = (t && typeof t === "object" ? t : { topic: t }) as Record<string, unknown>;
      const points = (Array.isArray(r.points) ? r.points : typeof r.points === "string" ? [r.points] : []).map((x) => clean(x, LIMITS.point)).filter(Boolean).slice(0, LIMITS.points);
      return { topic: clean(r.topic ?? r.title, LIMITS.topic), points };
    })
    .filter((t) => t.topic || t.points.length)
    .slice(0, LIMITS.topics);
  return { summary: clean(o.summary, LIMITS.summary), agenda, discussion, decisions, actionItems, nextMeeting: orNull(o.nextMeeting ?? o.next_meeting, LIMITS.next) };
}

/** Strict check of what a person typed when editing. Same shape, same limits, but errors instead of trimming away. */
export function validateEdit(body: Record<string, unknown>): MinutesBody {
  const summary = String(body.summary ?? "").trim();
  if (summary.length > LIMITS.summary) throw new Error("MINUTES_TOO_LONG");
  const decisionsIn = Array.isArray(body.decisions) ? body.decisions : [];
  const itemsIn = Array.isArray(body.actionItems) ? body.actionItems : [];
  if (decisionsIn.length > LIMITS.decisions || itemsIn.length > LIMITS.items) throw new Error("MINUTES_TOO_LONG");
  const decisions = decisionsIn.map((d) => String(d ?? "").trim()).filter(Boolean);
  if (decisions.some((d) => d.length > LIMITS.decision)) throw new Error("MINUTES_TOO_LONG");
  const actionItems: ActionItem[] = [];
  for (const a of itemsIn) {
    const r = (a ?? {}) as Record<string, unknown>;
    const task = String(r.task ?? "").trim();
    if (!task) continue;
    const owner = String(r.owner ?? "").trim() || null;
    const due = String(r.due ?? "").trim() || null;
    if (task.length > LIMITS.task || (owner?.length ?? 0) > LIMITS.owner || (due?.length ?? 0) > LIMITS.due) throw new Error("MINUTES_TOO_LONG");
    actionItems.push({ task, owner, due });
  }
  const agendaIn = Array.isArray(body.agenda) ? body.agenda : [];
  if (agendaIn.length > LIMITS.agenda) throw new Error("MINUTES_TOO_LONG");
  const agenda = agendaIn.map((a) => String(a ?? "").trim()).filter(Boolean);
  if (agenda.some((a) => a.length > LIMITS.agendaItem)) throw new Error("MINUTES_TOO_LONG");
  const topicsIn = Array.isArray(body.discussion) ? body.discussion : [];
  if (topicsIn.length > LIMITS.topics) throw new Error("MINUTES_TOO_LONG");
  const discussion: Topic[] = [];
  for (const t of topicsIn) {
    const r = (t ?? {}) as Record<string, unknown>;
    const topic = String(r.topic ?? "").trim();
    const pointsIn = Array.isArray(r.points) ? r.points : [];
    if (pointsIn.length > LIMITS.points) throw new Error("MINUTES_TOO_LONG");
    const points = pointsIn.map((x) => String(x ?? "").trim()).filter(Boolean);
    if (topic.length > LIMITS.topic || points.some((x) => x.length > LIMITS.point)) throw new Error("MINUTES_TOO_LONG");
    if (topic || points.length) discussion.push({ topic, points });
  }
  const nextMeeting = String(body.nextMeeting ?? "").trim() || null;
  if ((nextMeeting?.length ?? 0) > LIMITS.next) throw new Error("MINUTES_TOO_LONG");
  if (!summary && agenda.length === 0 && discussion.length === 0 && decisions.length === 0 && actionItems.length === 0) throw new Error("MINUTES_EMPTY");
  return { summary, agenda, discussion, decisions, actionItems, nextMeeting };
}

/** The instructions for the summary model. It may only reformat what was said. */
export function buildPrompt(opts: { title: string; attendees: string[]; outputLanguage: "english" | "original" }): { system: string } {
  const lang = opts.outputLanguage === "original" ? "Write the summary, decisions and action items in the same language the speakers mostly used (keep names and technical terms as spoken)." : "Write the summary, decisions and action items in clear English, even if the speakers used Marathi, Hindi or a mix. Keep people's names as spoken.";
  return {
    system: [
      "You write minutes of meeting (MOM) from a speech-to-text transcript of an in-person meeting.",
      "Use ONLY what is in the transcript. Where a name looks like a speech-recognition slip of one of the listed people (for example 'Zero' for 'Zira'), use the listed spelling; otherwise keep the name as written. Never add facts, names, numbers, dates or decisions that were not said.",
      "The transcript may contain recognition mistakes, mixed languages and no speaker labels. If something is unclear, leave it out instead of guessing.",
      "Keep concrete details exactly as said: amounts, numbers, dates, times, names and places must appear in the summary or decisions where they were discussed.",
      "An action item needs a clear task. Put an owner only if a person was named for it, and a due date only if one was said; otherwise use null.",
      lang,
      `Meeting title: ${opts.title}.${opts.attendees.length ? ` People in the meeting: ${opts.attendees.join(", ")}.` : ""}`,
      "Write like a company's formal minutes: neutral, past tense, third person, short complete sentences, no filler.",
      "agenda = the topics the meeting set out to cover (as they were raised, in order). discussion = for each topic, the points actually discussed (who raised what, figures, concerns, outcomes). decisions = only what was clearly decided or approved (a task given to someone belongs in actionItems, not in decisions, unless a real decision was also made). nextMeeting = only if a next meeting date, time or place was stated, else null. summary = an overview of 2 to 4 sentences.",
      'Reply with ONE JSON object and nothing else, exactly: {"summary": string, "agenda": string[], "discussion": [{"topic": string, "points": string[]}], "decisions": string[], "actionItems": [{"task": string, "owner": string|null, "due": string|null}], "nextMeeting": string|null}. Use empty arrays when there is nothing for a list.',
    ].join("\n"),
  };
}

export const hasSpeech = (transcript: string) => transcript.replace(/\s+/g, "").length >= MIN_TRANSCRIPT_CHARS;

/** Who may see the minutes: the organizer always (draft too); invitees only once they are published. */
export function canSee(opts: { isOrganizer: boolean; isInvitee: boolean; status: string }): boolean {
  if (opts.isOrganizer) return true;
  return opts.isInvitee && opts.status === "PUBLISHED";
}
