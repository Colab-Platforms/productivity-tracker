// Repetitive task detection: the pure rules (no database). Everything runs on our own server, with no external service.
//
// HOW IT WORKS, in plain words
//  1. Each task title/description is CLEANED: lower case, punctuation gone, filler and progress words dropped ("working on", "continued", "the"...),
//     simple word endings trimmed, and a few families of words treated as the same word (develop / build / implement; fix / debug; test / QA ...).
//  2. Two tasks are SIMILAR when their cleaned titles overlap enough (word overlap blended with letter-group overlap). If BOTH have details, the details
//     must also overlap, otherwise they are different activities under the same heading and are NOT similar ("similar wording alone is not duplicate work").
//  3. Similar tasks of ONE person on ONE project are chained together. If at least `minCount` of them fall inside `windowDays` days, it is a candidate.
//  4. CONTEXT: if most of those tasks were actually COMPLETED, it is a legitimate routine (a daily report, a weekly check), so it is not flagged.
// A flag asks a human to look. It never changes anyone's rating, pay, attendance or productivity.

export type Settings = { enabled: boolean; minCount: number; windowDays: number; similarityPct: number };
export const DEFAULT_SETTINGS: Settings = { enabled: true, minCount: 3, windowDays: 7, similarityPct: 60 };

export type TaskLite = {
  id: string; userId: string; teamId: string | null; date: string; // YYYY-MM-DD
  title: string; description: string | null; status: string; approvalStatus: string;
};

// Words that carry no meaning about WHAT the work is (progress talk and grammar).
const FILLER = new Set(("a an the of for to and or in on at with by from into onto over under about as is are was were be been being this that these those it its my our your " +
  "working work worked works continue continued continuing continues continuation ongoing further more still some task tasks daily today todays morning afternoon " +
  "update updates updated updating progress status part phase step steps new again also then now doing did do done make making made get getting got " +
  "same related regarding re etc misc various other stuff things thing item items activity activities").split(/\s+/));

// Families of words that mean the same kind of work. The first word is the shared label.
const FAMILIES: string[][] = [
  ["build", "develop", "development", "developing", "developed", "implement", "implementation", "implementing", "implemented", "code", "coding", "coded", "create", "creating", "created", "creation", "program", "programming"],
  ["fix", "fixing", "fixed", "bugfix", "bugfixes", "debug", "debugging", "debugged", "resolve", "resolving", "resolved", "patch", "patching"],
  ["test", "testing", "tested", "qa", "verify", "verification", "verifying", "validate", "validation", "validating"],
  ["design", "designing", "designed", "mockup", "wireframe", "wireframing", "prototype", "prototyping"],
  ["review", "reviewing", "reviewed", "check", "checking", "checked", "audit", "auditing"],
  ["meeting", "meetings", "call", "calls", "discussion", "discussions", "discuss", "discussing", "sync", "standup", "huddle"],
  ["document", "documenting", "documentation", "docs", "writing", "write", "wrote", "written", "draft", "drafting"],
  ["research", "researching", "analysis", "analyse", "analyze", "analysing", "analyzing", "investigate", "investigating", "investigation", "study", "studying"],
  ["report", "reports", "reporting"],
  ["deploy", "deploying", "deployed", "deployment", "release", "releasing", "released"],
];
const FAMILY_OF = new Map<string, string>();
for (const f of FAMILIES) for (const w of f) FAMILY_OF.set(w, f[0]);

/** Trim a few common endings so "dashboards" and "dashboard" read the same. Short words are left alone. */
function stem(w: string): string {
  if (w.length <= 3) return w;
  if (w.endsWith("ies") && w.length > 4) return w.slice(0, -3) + "y";
  if (w.endsWith("sses")) return w.slice(0, -2);
  if (w.endsWith("ing") && w.length > 5) return w.slice(0, -3);
  if (w.endsWith("ed") && w.length > 4) return w.slice(0, -2);
  if (w.endsWith("es") && w.length > 4 && /(x|ch|sh|s)es$/.test(w)) return w.slice(0, -2);
  if (w.endsWith("s") && !w.endsWith("ss") && w.length > 3) return w.slice(0, -1);
  return w;
}

/** The meaningful words of a text, in order, cleaned. */
export function words(text: string | null | undefined): string[] {
  const raw = String(text ?? "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (const w of raw) {
    if (FILLER.has(w)) continue;
    const fam = FAMILY_OF.get(w);
    const s = fam ?? stem(w);
    if (s.length < 2 && !/^\d+$/.test(s)) continue;
    if (FILLER.has(s)) continue;
    out.push(s);
  }
  return out;
}

const uniq = (a: string[]) => [...new Set(a)];

function jaccard(a: string[], b: string[]): number {
  const A = new Set(a), B = new Set(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}
/** Overlap measured against the SHORTER side: "HRMS dashboard" inside "HRMS dashboard development for admin" still counts. */
function containment(a: string[], b: string[]): number {
  const A = new Set(a), B = new Set(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / Math.min(A.size, B.size);
}
function trigrams(s: string): Map<string, number> {
  const t = `  ${s} `;
  const m = new Map<string, number>();
  for (let i = 0; i < t.length - 2; i++) m.set(t.slice(i, i + 3), (m.get(t.slice(i, i + 3)) ?? 0) + 1);
  return m;
}
function dice(a: string, b: string): number {
  if (!a || !b) return 0;
  const A = trigrams(a), B = trigrams(b);
  let inter = 0, sa = 0, sb = 0;
  for (const [k, v] of A) { sa += v; const o = B.get(k); if (o) inter += Math.min(v, o); }
  for (const v of B.values()) sb += v;
  return sa + sb === 0 ? 0 : (2 * inter) / (sa + sb);
}

/** 0-100: how alike two TITLES read. */
export function titleSimilarity(a: string, b: string): number {
  const wa = uniq(words(a)), wb = uniq(words(b));
  if (wa.length === 0 || wb.length === 0) return 0;
  // Needs at least one shared meaningful word, and for longer titles at least two, or it is only coincidence.
  const shared = wa.filter((x) => wb.includes(x)).length;
  if (shared === 0) return 0;
  if (shared < 2 && Math.min(wa.length, wb.length) > 1) return Math.round(Math.min(60, 100 * jaccard(wa, wb)));
  const score = 0.5 * jaccard(wa, wb) + 0.3 * containment(wa, wb) + 0.2 * dice([...wa].sort().join(" "), [...wb].sort().join(" "));
  return Math.round(100 * Math.min(1, score));
}

/** 0-100 for the details, or null when either side has too little detail to compare. */
export function detailSimilarity(a: string | null | undefined, b: string | null | undefined): number | null {
  const wa = uniq(words(a)), wb = uniq(words(b));
  if (wa.length < 3 || wb.length < 3) return null;
  return Math.round(100 * (0.6 * jaccard(wa, wb) + 0.4 * containment(wa, wb)));
}

export type Pair = { score: number; title: number; detail: number | null; sameWork: boolean };
/**
 * Are these two tasks the same piece of work? Titles decide; details can only HOLD BACK a match (two entries under the same heading whose details
 * are clearly about different things are different activities) and slightly lift an uncertain one.
 */
export function compare(a: { title: string; description: string | null }, b: { title: string; description: string | null }, thresholdPct: number): Pair {
  const title = titleSimilarity(a.title, b.title);
  const detail = detailSimilarity(a.description, b.description);
  let score = title;
  if (detail !== null) score = Math.round(detail < 25 ? Math.min(title, thresholdPct - 1) : 0.75 * title + 0.25 * detail);
  return { score, title, detail, sameWork: score >= thresholdPct };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------

const dayNumber = (iso: string) => Math.floor(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86400000);

/** Tasks that may be compared at all: not rejected. (Deleted, cancelled, manager-assigned and self-managed ones are removed by the caller's query.) */
export const comparable = (t: Pick<TaskLite, "approvalStatus" | "status">) => t.approvalStatus !== "REJECTED" && t.status !== "CANCELLED";

export type Candidate = {
  userId: string; teamId: string | null; taskIds: string[]; count: number; firstDate: string; lastDate: string; spanDays: number;
  similarity: number; sampleTitle: string; patternKey: string; completed: number; reason: string;
};

/** Core words shared by most of the tasks: the stable fingerprint of a pattern. */
export function signature(tasks: TaskLite[]): string[] {
  const freq = new Map<string, number>();
  for (const t of tasks) for (const w of uniq([...words(t.title)])) freq.set(w, (freq.get(w) ?? 0) + 1);
  return [...freq.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])).slice(0, 3).map((e) => e[0]).sort();
}

/**
 * Find repetition among ONE person's tasks. Tasks of different people never meet; tasks of different projects never meet (the same wording on two projects
 * is two pieces of work). Returns one candidate per cluster that reaches the threshold inside the window and is not an ordinary completed routine.
 */
export function detect(all: TaskLite[], s: Settings): Candidate[] {
  const out: Candidate[] = [];
  const byKey = new Map<string, TaskLite[]>();
  for (const t of all.filter(comparable)) {
    const k = `${t.userId}|${t.teamId ?? "none"}`;
    byKey.set(k, [...(byKey.get(k) ?? []), t]);
  }
  for (const group of byKey.values()) {
    if (group.length < s.minCount) continue;
    const tasks = [...group].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
    // chain similar tasks (union-find)
    const parent = tasks.map((_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    const edge = new Map<string, number>();
    for (let i = 0; i < tasks.length; i++) for (let j = i + 1; j < tasks.length; j++) {
      const p = compare(tasks[i], tasks[j], s.similarityPct);
      if (p.sameWork) { parent[find(i)] = find(j); edge.set(`${i}|${j}`, p.score); }
    }
    const clusters = new Map<number, number[]>();
    tasks.forEach((_, i) => clusters.set(find(i), [...(clusters.get(find(i)) ?? []), i]));
    for (const idx of clusters.values()) {
      if (idx.length < s.minCount) continue;
      const members = idx.map((i) => tasks[i]); // already in date order
      // the busiest window of `windowDays` days
      let best: TaskLite[] = [];
      for (let a = 0; a < members.length; a++) {
        const start = dayNumber(members[a].date);
        const inWin = members.filter((m) => dayNumber(m.date) >= start && dayNumber(m.date) <= start + s.windowDays - 1);
        if (inWin.length > best.length) best = inWin;
      }
      if (best.length < s.minCount) continue;
      const completed = best.filter((m) => m.status === "COMPLETED").length;
      // legitimate routine: most of the entries were really finished, so the work moved on each time
      if (completed >= Math.ceil(best.length / 2)) continue;
      const ids = new Set(best.map((m) => m.id));
      const scores: number[] = [];
      for (const [k, v] of edge) { const [i, j] = k.split("|").map(Number); if (ids.has(tasks[i].id) && ids.has(tasks[j].id)) scores.push(v); }
      const similarity = scores.length ? Math.round(scores.reduce((x, y) => x + y, 0) / scores.length) : s.similarityPct;
      const sig = signature(best);
      const first = best[0].date, last = best[best.length - 1].date;
      const span = dayNumber(last) - dayNumber(first) + 1;
      const first3 = best.filter((m) => m.status !== "COMPLETED").length;
      out.push({
        userId: best[0].userId, teamId: best[0].teamId, taskIds: best.map((m) => m.id), count: best.length, firstDate: first, lastDate: last, spanDays: span,
        similarity, sampleTitle: best[0].title, patternKey: `${best[0].userId}|${best[0].teamId ?? "none"}|${sig.join("+")}`, completed,
        reason: `${best.length} entries that read as the same work (${similarity}% alike) over ${span} day${span === 1 ? "" : "s"}; ` +
          `${completed === 0 ? "none of them was completed" : `only ${completed} of them was completed`} (${first3} still open), so there is little sign of progress. Common words: ${sig.join(", ") || "none"}.`,
      });
    }
  }
  return out;
}

/** The earliest day that needs to be read for a person (enough for any window ending today, plus slack). */
export const lookbackDays = (s: Settings) => s.windowDays * 2 + 2;

// --- flag life cycle ---------------------------------------------------------------------------------------------------------------------------

export type FlagStatus = "NEW" | "UNDER_REVIEW" | "VALID" | "FALSE_POSITIVE" | "RESOLVED";
export const STATUS_LABEL: Record<FlagStatus, string> = { NEW: "New", UNDER_REVIEW: "Under Review", VALID: "Valid Repetition", FALSE_POSITIVE: "False Positive", RESOLVED: "Resolved" };
export const STATUSES = Object.keys(STATUS_LABEL) as FlagStatus[];
const MOVES: Record<FlagStatus, FlagStatus[]> = {
  NEW: ["UNDER_REVIEW", "VALID", "FALSE_POSITIVE", "RESOLVED"],
  UNDER_REVIEW: ["VALID", "FALSE_POSITIVE", "RESOLVED"],
  VALID: ["UNDER_REVIEW", "RESOLVED"],
  FALSE_POSITIVE: ["UNDER_REVIEW"],
  RESOLVED: ["UNDER_REVIEW"],
};
export const canMove = (from: FlagStatus, to: FlagStatus) => MOVES[from]?.includes(to) ?? false;
export const isOpen = (s: string) => s === "NEW" || s === "UNDER_REVIEW";

/**
 * Is this candidate already covered by an existing flag? Mostly the same tasks (half or more) means the same pattern. A Resolved flag only covers it
 * until a newer task joins the pattern.
 */
export function coveredBy(c: { taskIds: string[]; lastDate: string }, flags: { id: string; status: string; taskIds: string[]; lastDate: string }[]): { id: string; status: string } | null {
  const mine = new Set(c.taskIds);
  for (const f of flags) {
    const overlap = f.taskIds.filter((t) => mine.has(t)).length;
    if (overlap === 0 || overlap / c.taskIds.length < 0.5) continue;
    // A Resolved flag only covers the SAME entries: once a task that was not part of it joins the pattern, a fresh flag may be raised.
    if (f.status === "RESOLVED" && c.taskIds.some((t) => !f.taskIds.includes(t))) continue;
    return { id: f.id, status: f.status };
  }
  return null;
}

export function checkSettings(i: Record<string, unknown>): Settings {
  const num = (v: unknown, lo: number, hi: number, code: string) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < lo || n > hi) throw new Error(code);
    return n;
  };
  return {
    enabled: i.enabled === undefined ? true : i.enabled === true,
    minCount: num(i.minCount, 2, 20, "BAD_MIN_COUNT"),
    windowDays: num(i.windowDays, 1, 60, "BAD_WINDOW_DAYS"),
    similarityPct: num(i.similarityPct, 30, 100, "BAD_SIMILARITY"),
  };
}

export function checkNote(v: unknown, min: number, max: number, required: string): string {
  const s = String(v ?? "").trim();
  if (s.length < min) throw new Error(required);
  if (s.length > max) throw new Error("NOTE_TOO_LONG");
  return s;
}
