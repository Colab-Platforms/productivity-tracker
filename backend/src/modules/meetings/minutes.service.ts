import { prisma } from "../../lib/prisma.js";
import { auditNote } from "../../lib/auditContext.js";
import { notifyUsers } from "../../lib/notify.js";
import { participationReady, signalMeeting } from "./participation.service.js";
import { aiConfigured, LLM_MODEL, STT_MODEL, summarize, transcribe } from "./minutes.ai.js";
import { canSee, hasSpeech, MAX_AUDIO_BYTES, validateEdit, type MinutesBody } from "./minutes.logic.js";

// ---------------------------------------------------------------------------
// MEETING MINUTES (MOM)
//
// The organizer records the meeting (or uploads a recording); the speech is turned into text and an AI drafts the minutes. The organizer
// only reviews and publishes. Rules:
//   - Only the ORGANIZER makes, edits and publishes minutes. Invitees read them once PUBLISHED. Nobody else (HR/Admin included) can open them,
//     the same privacy as the meeting's own details.
//   - The recording is never stored. The transcript is kept only on the draft, to be checked, and is cleared when the minutes are published.
//   - Publishing keeps every version (meeting_minutes_versions: 1, 2, ...). A later edit of published minutes adds the next version; earlier ones stay.
//   - Nothing is auto-published. The AI may only reformat what was said; action items are text (no tasks are created).
// Before the migration is applied every function answers FEATURES_NOT_READY (reads answer "not ready") and nothing else changes.
// ---------------------------------------------------------------------------

const isMissingTable = (e: unknown) => {
  const code = (e as { code?: unknown })?.code;
  const msg = e instanceof Error ? e.message : "";
  return code === "P2021" || (/meeting_minutes/.test(msg) && /does not exist|relation/.test(msg));
};
let readyValue = false;
let checkedAt = 0;
export async function minutesReady(): Promise<boolean> {
  if (readyValue) return true;
  if (Date.now() - checkedAt < 15_000) return false;
  checkedAt = Date.now();
  try {
    await Promise.all([prisma.meetingMinutes.findFirst({ select: { id: true } }), prisma.meetingMinutesVersion.findFirst({ select: { id: true } })]);
    readyValue = true;
  } catch (e) {
    if (!isMissingTable(e)) throw e;
    readyValue = false;
  }
  return readyValue;
}
async function requireReady() {
  if (!(await minutesReady())) throw new Error("FEATURES_NOT_READY");
}

async function meetingFor(userId: string, meetingId: string) {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, platformId: true, firstName: true, lastName: true } });
  if (!u) throw new Error("USER_NOT_FOUND");
  const m = await prisma.meeting.findFirst({
    where: { id: meetingId, platformId: u.platformId, OR: [{ organizerId: userId }, { attendees: { some: { userId } } }] },
    include: { attendees: { select: { userId: true, user: { select: { firstName: true, lastName: true } } } }, organizer: { select: { firstName: true, lastName: true } } },
  });
  if (!m) throw new Error("NOT_FOUND"); // not invited and not the organizer: it does not exist for this person
  return { me: u, m, isOrganizer: m.organizerId === userId };
}
const nameOf = (p: { firstName: string; lastName: string }) => `${p.firstName} ${p.lastName}`.trim();

async function organizerMeeting(userId: string, meetingId: string) {
  const r = await meetingFor(userId, meetingId);
  if (!r.isOrganizer) throw new Error("NOT_FOUND"); // an invitee cannot tell it can be done at all
  if (String(r.m.status) === "CANCELLED") throw new Error("MEETING_CANCELLED");
  return r;
}

const invitees = (m: { attendees: { userId: string }[] }, exceptId: string) => m.attendees.map((a) => a.userId).filter((id) => id !== exceptId);

// Who was there: the people who pressed Join on a tracked Team Huddle, otherwise everyone invited (said so on the minutes).
async function attendeesOf(m: { id: string; organizer: { firstName: string; lastName: string }; attendees: { userId: string; user: { firstName: string; lastName: string } }[] }) {
  if (await participationReady()) {
    const joined = await prisma.meetingParticipation.findMany({ where: { meetingId: m.id }, select: { userId: true } });
    if (joined.length > 0) {
      const ids = new Set(joined.map((j) => j.userId));
      const names = m.attendees.filter((a) => ids.has(a.userId)).map((a) => nameOf(a.user));
      return { names: [nameOf(m.organizer), ...names], basis: "JOINED" as const };
    }
  }
  return { names: [nameOf(m.organizer), ...m.attendees.map((a) => nameOf(a.user))], basis: "INVITED" as const };
}

type Row = Awaited<ReturnType<typeof prisma.meetingMinutes.findUnique>>;
const view = (r: NonNullable<Row>, organizer: boolean) => ({
  id: r.id,
  status: r.status,
  version: r.version,
  summary: r.summary,
  agenda: (r.agenda ?? []) as string[],
  discussion: (r.discussion ?? []) as { topic: string; points: string[] }[],
  nextMeeting: r.nextMeeting,
  decisions: r.decisions as string[],
  actionItems: r.actionItems as { task: string; owner: string | null; due: string | null }[],
  attendees: r.attendees as string[],
  attendeeBasis: r.attendeeBasis,
  language: r.language,
  recordedAt: r.recordedAt,
  publishedAt: r.publishedAt,
  // the transcript is for the organizer's review of a draft only
  ...(organizer ? { transcript: r.transcript, aiModel: r.aiModel } : {}),
});

/** The organizer presses Record: invitees are told it is being recorded before anything is captured. */
export async function announceRecording(userId: string, meetingId: string) {
  await requireReady();
  const { me, m } = await organizerMeeting(userId, meetingId);
  const to = invitees(m, userId);
  await notifyUsers({
    platformId: m.platformId,
    userIds: to,
    type: "MEETING_RECORDING",
    title: "This meeting is being recorded",
    body: `${nameOf(me)} is recording "${m.title}" to write the minutes. The recording is not kept; only the minutes are.`,
    link: `/dashboard/meetings?id=${m.id}`,
    data: { meetingId: m.id },
    dedupeKey: `minutes-rec:${m.id}:${new Date().toISOString().slice(0, 13)}`,
  }).catch((e) => console.error("[minutes] could not announce recording:", e));
  auditNote({ recordType: "Meeting", recordId: m.id, summary: `Started recording "${m.title}" for minutes (${to.length} people told)` });
  return { ok: true, told: to.length, configured: aiConfigured() };
}

/** A recording goes in, a DRAFT comes out. The audio is not stored. */
export async function generateFromAudio(userId: string, meetingId: string, audio: Buffer, mime: string, opts: { language?: unknown; output?: unknown }) {
  await requireReady();
  if (!aiConfigured()) throw new Error("MINUTES_NOT_CONFIGURED");
  const { me, m } = await organizerMeeting(userId, meetingId);
  if (m.startsAt.getTime() > Date.now()) throw new Error("NOT_STARTED");
  if (!audio || audio.length < 1000) throw new Error("AUDIO_EMPTY");
  if (audio.length > MAX_AUDIO_BYTES) throw new Error("AUDIO_TOO_LARGE");
  const existing = await prisma.meetingMinutes.findUnique({ where: { meetingId } });
  if (existing?.status === "PUBLISHED") throw new Error("MINUTES_PUBLISHED");

  const hint = ["en", "hi", "mr"].includes(String(opts.language ?? "")) ? String(opts.language) : undefined;
  const outputLanguage = opts.output === "original" ? "original" : "english";

  const who = await attendeesOf(m);
  // names the speech engine should spell correctly: the meeting, the company and everyone in it
  const company = (await prisma.platform.findUnique({ where: { id: m.platformId }, select: { name: true } }))?.name;
  const vocabulary = `Meeting: ${m.title}.${company ? ` Company: ${company}.` : ""} People: ${[...new Set(who.names)].join(", ")}.`;
  const spoken = await transcribe(audio, mime, hint, vocabulary);
  if (!hasSpeech(spoken.text)) throw new Error("NO_SPEECH");
  const body = await summarize(spoken.text, { title: m.title, attendees: who.names, outputLanguage });

  const data = {
    platformId: m.platformId,
    status: "DRAFT",
    summary: body.summary,
    agenda: body.agenda,
    discussion: body.discussion,
    nextMeeting: body.nextMeeting,
    decisions: body.decisions,
    actionItems: body.actionItems,
    attendees: who.names,
    attendeeBasis: who.basis,
    transcript: spoken.text,
    language: spoken.language,
    aiModel: `${STT_MODEL} + ${LLM_MODEL}`,
    recordedAt: new Date(),
  };
  const row = await prisma.meetingMinutes.upsert({ where: { meetingId }, update: data, create: { meetingId, createdById: me.id, ...data } });
  auditNote({ recordType: "Meeting", recordId: m.id, summary: `Drafted minutes for "${m.title}" from a recording (draft, not published)` });
  return { minutes: view(row, true) };
}

/** Organizer reads, corrects or writes the draft by hand (a typed fallback when no recording exists). */
export async function saveMinutes(userId: string, meetingId: string, input: Record<string, unknown>) {
  await requireReady();
  const { me, m } = await organizerMeeting(userId, meetingId);
  const body: MinutesBody = validateEdit(input);
  const existing = await prisma.meetingMinutes.findUnique({ where: { meetingId } });
  if (!existing) {
    const who = await attendeesOf(m);
    const row = await prisma.meetingMinutes.create({
      data: { meetingId, platformId: m.platformId, createdById: me.id, status: "DRAFT", summary: body.summary, agenda: body.agenda, discussion: body.discussion, nextMeeting: body.nextMeeting, decisions: body.decisions, actionItems: body.actionItems, attendees: who.names, attendeeBasis: who.basis },
    });
    return { minutes: view(row, true) };
  }
  if (existing.status === "PUBLISHED") {
    // every published version is kept (the table holds version 1, 2, ...); the live row always shows the newest; invitees are told
    const version = existing.version + 1;
    const now = new Date();
    const row = await prisma.$transaction(async (tx) => {
      const updated = await tx.meetingMinutes.update({ where: { id: existing.id }, data: { summary: body.summary, agenda: body.agenda, discussion: body.discussion, nextMeeting: body.nextMeeting, decisions: body.decisions, actionItems: body.actionItems, version, publishedAt: now, publishedById: me.id } });
      await tx.meetingMinutesVersion.create({ data: { minutesId: existing.id, meetingId, version, summary: body.summary, agenda: body.agenda, discussion: body.discussion, nextMeeting: body.nextMeeting, decisions: body.decisions, actionItems: body.actionItems, attendees: existing.attendees ?? [], attendeeBasis: existing.attendeeBasis, publishedAt: now, publishedById: me.id } });
      return updated;
    });
    await tell(m, me, `The minutes of "${m.title}" were updated.`, `minutes-upd:${m.id}:${version}`);
    auditNote({ recordType: "Meeting", recordId: m.id, summary: `Edited published minutes of "${m.title}" (now version ${version})` });
    return { minutes: view(row, true) };
  }
  const row = await prisma.meetingMinutes.update({ where: { id: existing.id }, data: { summary: body.summary, agenda: body.agenda, discussion: body.discussion, nextMeeting: body.nextMeeting, decisions: body.decisions, actionItems: body.actionItems } });
  return { minutes: view(row, true) };
}

async function tell(m: { id: string; title: string; platformId: string; attendees: { userId: string }[] }, me: { id: string; firstName: string; lastName: string }, text: string, dedupeKey: string) {
  const to = invitees(m, me.id);
  await notifyUsers({ platformId: m.platformId, userIds: to, type: "MEETING_MINUTES", title: "Meeting minutes", body: text, link: `/dashboard/meetings?id=${m.id}`, data: { meetingId: m.id }, dedupeKey }).catch((e) => console.error("[minutes] could not notify:", e));
  signalMeeting([me.id, ...to], m.id);
}

/** Publish the draft: every invitee can read it, the transcript is deleted, version 1 is kept. */
export async function publishMinutes(userId: string, meetingId: string) {
  await requireReady();
  const { me, m } = await organizerMeeting(userId, meetingId);
  const row = await prisma.meetingMinutes.findUnique({ where: { meetingId } });
  if (!row) throw new Error("MINUTES_NOT_FOUND");
  if (row.status === "PUBLISHED") throw new Error("ALREADY_PUBLISHED");
  const n = (v: unknown) => (Array.isArray(v) ? v.length : 0);
  if (!row.summary.trim() && n(row.agenda) === 0 && n(row.discussion) === 0 && n(row.decisions) === 0 && n(row.actionItems) === 0) throw new Error("MINUTES_EMPTY");
  const now = new Date();
  const out = await prisma.$transaction(async (tx) => {
    const res = await tx.meetingMinutes.updateMany({ where: { id: row.id, status: "DRAFT" }, data: { status: "PUBLISHED", version: 1, publishedAt: now, publishedById: me.id, transcript: null } });
    if (res.count === 0) throw new Error("ALREADY_PUBLISHED");
    await tx.meetingMinutesVersion.create({ data: { minutesId: row.id, meetingId, version: 1, summary: row.summary, agenda: row.agenda ?? [], discussion: row.discussion ?? [], nextMeeting: row.nextMeeting, decisions: row.decisions ?? [], actionItems: row.actionItems ?? [], attendees: row.attendees ?? [], attendeeBasis: row.attendeeBasis, publishedAt: now, publishedById: me.id } });
    return tx.meetingMinutes.findUniqueOrThrow({ where: { id: row.id } });
  });
  await tell(m, me, `${nameOf(me)} published the minutes of "${m.title}".`, `minutes-pub:${m.id}:1`);
  auditNote({ recordType: "Meeting", recordId: m.id, summary: `Published minutes of "${m.title}"` });
  return { minutes: view(out, true) };
}

// The facts at the top of the minutes. They come from the system (the meeting record and the join records), never from the AI.
async function headerOf(m: Awaited<ReturnType<typeof meetingFor>>["m"], tz: string, minutesAttendees: { names: string[]; basis: string } | null) {
  const company = await prisma.platform.findUnique({ where: { id: m.platformId }, select: { name: true } });
  const joined = new Set(minutesAttendees?.basis === "JOINED" ? minutesAttendees.names : []);
  const invited = m.attendees.map((a) => nameOf(a.user));
  return {
    title: m.title,
    company: company?.name ?? null,
    startsAt: m.startsAt,
    endsAt: m.endsAt,
    timezone: tz,
    mode: m.meetingUrl ? "Online" : "In person",
    provider: m.provider ?? null,
    preparedBy: nameOf(m.organizer),
    agendaNote: m.description ?? null,
    // who was invited and did not join, only when the join records exist (otherwise it is not known and is not claimed)
    notJoined: minutesAttendees?.basis === "JOINED" ? invited.filter((n) => !joined.has(n)) : [],
  };
}

/** The organizer sees draft or published; an invitee sees only published; anyone else gets NOT_FOUND. */
export async function getMinutes(userId: string, meetingId: string) {
  if (!(await minutesReady())) return { ready: false, configured: aiConfigured(), canEdit: false, minutes: null };
  const { m, isOrganizer, me } = await meetingFor(userId, meetingId);
  const row = await prisma.meetingMinutes.findUnique({ where: { meetingId } });
  const visible = row && canSee({ isOrganizer, isInvitee: !isOrganizer, status: row.status });
  const tz = (await prisma.user.findUnique({ where: { id: me.id }, select: { platform: { select: { timezone: true } } } }))?.platform.timezone ?? "Asia/Kolkata";
  return {
    ready: true,
    header: visible && row ? await headerOf(m, tz, { names: row.attendees as string[], basis: row.attendeeBasis }) : null,
    configured: aiConfigured(),
    canEdit: isOrganizer && String(m.status) !== "CANCELLED",
    minutes: visible && row ? view(row, isOrganizer) : null,
  };
}
