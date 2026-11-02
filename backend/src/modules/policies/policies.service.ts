import { prisma } from "../../lib/prisma.js";
import { saveUpload, readStored, contentTypeFor } from "../../lib/storage.js";
import { notifyUsers } from "../../lib/notify.js";
import { emitPolicyChange } from "../../lib/realtime.js";
import { auditNote } from "../../lib/auditContext.js";
import { parseIsoDay, platformToday } from "../../lib/dates.js";
import { docxToHtml, viewKind } from "./policies.docs.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { accessFor } from "../../lib/companyAccess.js";
import { canAccess, visibleCompanies } from "../../lib/companyAccess.logic.js";

// ---------------------------------------------------------------------------
// POLICIES & INDUCTION
//
// A policy is an `induction_documents` row (as it always was). Beside it, `policy_details` holds its status
// (DRAFT / PUBLISHED / ARCHIVED), category, effective date and download rule; `policy_versions` keeps EVERY version
// (the old file is never deleted); `policy_audience` says who it is for; `policy_review_notes` are things HR must
// look at before publishing. Acknowledgements are still `induction_acknowledgements`, recorded per version number.
//
// On a database that does not have the new tables yet, everything that existed before keeps working: a document
// with no `policy_details` row is simply an already-published policy.
// ---------------------------------------------------------------------------

const STAFF = ["HR", "ADMIN"];
const ROLES = ["EMPLOYEE", "MANAGER", "HR", "ADMIN"];
const EMPLOYMENT_TYPES = ["PERMANENT", "PROBATION", "CONTRACT", "INTERN"];

export const BUILT_IN_CATEGORIES = [
  "Human Resource Policy", "Attendance Policy", "Leave Policy", "Code of Conduct", "IT & Data Security", "POSH Policy",
  "Grievance Policy", "Performance & Appraisal", "Exit & Separation", "Employee Handbook", "Induction Documents", "Other",
] as const;
export const INDUCTION_CATEGORY = "Induction Documents";

// The old fixed list (a required column on induction_documents) <-> the display names above.
const ENUM_FOR: Record<string, string> = { "Leave Policy": "LEAVE_POLICY", "Code of Conduct": "CODE_OF_CONDUCT", "IT & Data Security": "IT_POLICY", "Induction Documents": "COMPANY_OVERVIEW" };
const NAME_FOR: Record<string, string> = {
  COMPANY_OVERVIEW: "Induction Documents", PROBATION_POLICY: "Human Resource Policy", LEAVE_POLICY: "Leave Policy",
  CODE_OF_CONDUCT: "Code of Conduct", IT_POLICY: "IT & Data Security", ROLE_TRAINING: "Induction Documents", OTHER: "Other",
};
const LEGACY_CATEGORIES = Object.keys(NAME_FOR); // the old API accepted these keys; keep accepting them

// --- is the new schema there? -------------------------------------------------------------------------------------
const isMissingTable = (e: unknown) => {
  const code = (e as { code?: unknown })?.code;
  const msg = e instanceof Error ? e.message : "";
  return code === "P2021" || (/policy_(details|versions|audience|categories|review_notes)/.test(msg) && /does not exist|relation/.test(msg));
};
let readyValue = false;
let readyCheckedAt = 0;
async function ready(): Promise<boolean> {
  if (readyValue) return true;
  if (Date.now() - readyCheckedAt < 15_000) return false;
  readyCheckedAt = Date.now();
  try {
    await prisma.policyDetail.findFirst({ select: { policyId: true } });
    readyValue = true;
  } catch (e) {
    if (!isMissingTable(e)) throw e;
    readyValue = false;
  }
  return readyValue;
}
async function requireReady() {
  if (!(await ready())) throw new Error("FEATURES_NOT_READY");
}

// --- who is asking ------------------------------------------------------------------------------------------------
// `actAs`: an OWNER (OWNER_CODES) who is HR/Admin may act inside another company, so one person can run the policies of the companies
// they look after. Anyone else asking for it is refused; a deployment pinned to one company switches it off.
// The company an owner chose to manage for THIS request only (the routes set it from the `company` query value).
const actingCompany = new AsyncLocalStorage<string>();
export const withActingCompany = (companyId: string, next: () => void) => actingCompany.run(companyId, next);

async function who(userId: string, actAsArg?: string) {
  const actAs = actAsArg ?? actingCompany.getStore();
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, role: true, platformId: true, firstName: true, lastName: true, teamMemberships: { where: { isActive: true }, select: { teamId: true } }, platform: { select: { timezone: true } } },
  });
  if (!u) throw new Error("USER_NOT_FOUND");
  let platformId = u.platformId;
  let timezone = u.platform.timezone;
  if (actAs && actAs !== u.platformId) {
    // Only HR/Admin, and only for a company assigned to them (or any company, for top management).
    if (!["HR", "ADMIN"].includes(String(u.role)) || !canAccess(await accessFor(userId), actAs)) throw new Error("NOT_ALLOWED");
    const target = await prisma.platform.findFirst({ where: { id: actAs, isActive: true }, select: { id: true, timezone: true } });
    if (!target) throw new Error("NOT_FOUND");
    platformId = target.id;
    timezone = target.timezone;
  }
  let employmentType: string | null = null;
  try {
    employmentType = (await prisma.employeeProfile.findUnique({ where: { userId }, select: { employmentType: true } }))?.employmentType ?? null;
  } catch {
    /* table may not exist on an old database: no type = matches only audiences that don't ask for one */
  }
  return { id: u.id, acting: platformId !== u.platformId, role: String(u.role), platformId, name: `${u.firstName} ${u.lastName}`.trim(), teamIds: u.teamMemberships.map((m) => m.teamId), timezone, employmentType };
}
type Viewer = Awaited<ReturnType<typeof who>>;

async function staff(userId: string, actAs?: string) {
  const v = await who(userId, actAs);
  if (!STAFF.includes(v.role)) throw new Error("NOT_ALLOWED");
  return v;
}

// --- shared reading of policy data (tolerant of a missing new schema) ---------------------------------------
type Doc = NonNullable<Awaited<ReturnType<typeof prisma.inductionDocument.findFirst>>>;
type AudRow = { kind: string; value: string };
type Ver = { id: string; number: number; label: string; status: string; fileName: string; storageKey: string; mimeType: string | null; fileSize: number | null; changeNote: string | null; requiresAck: boolean; createdById: string | null; createdAt: Date; publishedAt: Date | null };
type Detail = { policyId: string; status: string; category: string; effectiveDate: Date | null; publishedAt: Date | null; allowDownload: boolean; createdById: string | null };

async function loadMeta(docIds: string[]) {
  const details = new Map<string, Detail>();
  const audience = new Map<string, AudRow[]>();
  const versions = new Map<string, Ver[]>();
  if (docIds.length === 0 || !(await ready())) return { details, audience, versions };
  const [d, a, v] = await Promise.all([
    prisma.policyDetail.findMany({ where: { policyId: { in: docIds } } }),
    prisma.policyAudience.findMany({ where: { policyId: { in: docIds } } }),
    prisma.policyVersion.findMany({ where: { policyId: { in: docIds } }, orderBy: { number: "asc" } }),
  ]);
  for (const x of d) details.set(x.policyId, x);
  for (const x of a) audience.set(x.policyId, [...(audience.get(x.policyId) ?? []), { kind: x.kind, value: x.value }]);
  for (const x of v) versions.set(x.policyId, [...(versions.get(x.policyId) ?? []), x]);
  return { details, audience, versions };
}
type Meta = Awaited<ReturnType<typeof loadMeta>>;

const statusOf = (doc: Doc, meta: Meta) => meta.details.get(doc.id)?.status ?? (doc.isActive ? "PUBLISHED" : "ARCHIVED");
const categoryOf = (doc: Doc, meta: Meta) => meta.details.get(doc.id)?.category ?? NAME_FOR[String(doc.category)] ?? "Other";
const liveVersion = (doc: Doc, meta: Meta) => (meta.versions.get(doc.id) ?? []).find((x) => x.status === "PUBLISHED");
const labelOf = (doc: Doc, meta: Meta) => liveVersion(doc, meta)?.label ?? `${doc.version}.0`;
// People must have confirmed at least this version number: the latest version that was published AND needed
// confirmation. A version published with "no re-confirmation needed" does not move this.
const requiredNumber = (doc: Doc, meta: Meta) => {
  const needing = (meta.versions.get(doc.id) ?? []).filter((x) => (x.status === "PUBLISHED" || x.status === "SUPERSEDED") && x.requiresAck).map((x) => x.number);
  return needing.length ? Math.max(...needing) : doc.version;
};

// Is this person one of the people the policy is for?
type Person = { id: string; name: string; employeeCode: string | null; designation: string | null; role: string; teamIds: string[]; teamNames: string[]; employmentType: string | null };
function appliesTo(p: { role: string; teamIds: string[]; employmentType: string | null }, doc: Doc, rows: AudRow[]) {
  if (rows.length === 0) return doc.teamId === null || p.teamIds.includes(doc.teamId); // everyone (or the one team an old document was limited to)
  return rows.some((r) => (r.kind === "TEAM" && p.teamIds.includes(r.value)) || (r.kind === "EMPLOYMENT_TYPE" && p.employmentType === r.value) || (r.kind === "ROLE" && p.role === r.value));
}

async function people(platformId: string): Promise<Person[]> {
  const rows = await prisma.user.findMany({
    where: { platformId, status: { notIn: ["EXITED", "SUSPENDED"] } },
    select: { id: true, firstName: true, lastName: true, employeeCode: true, designation: true, role: true, teamMemberships: { where: { isActive: true }, select: { team: { select: { id: true, name: true } } } } },
    orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
  });
  let types = new Map<string, string>();
  try {
    types = new Map((await prisma.employeeProfile.findMany({ where: { userId: { in: rows.map((r) => r.id) } }, select: { userId: true, employmentType: true } })).map((t) => [t.userId, t.employmentType]));
  } catch {
    /* old database */
  }
  return rows.map((r) => ({
    id: r.id, name: `${r.firstName} ${r.lastName}`.trim(), employeeCode: r.employeeCode, designation: r.designation, role: String(r.role),
    teamIds: r.teamMemberships.map((m) => m.team.id), teamNames: r.teamMemberships.map((m) => m.team.name), employmentType: types.get(r.id) ?? null,
  }));
}

// --- OPENING (recorded per version) -----------------------------------------------------------------------------
async function markOpened(userId: string, doc: Doc) {
  await prisma.inductionAcknowledgement.upsert({
    where: { inductionDocumentId_userId_documentVersion: { inductionDocumentId: doc.id, userId, documentVersion: doc.version } },
    update: {},
    create: { inductionDocumentId: doc.id, userId, documentVersion: doc.version, openedAt: new Date() },
  });
  await prisma.inductionAcknowledgement.updateMany({
    where: { inductionDocumentId: doc.id, userId, documentVersion: doc.version, openedAt: null },
    data: { openedAt: new Date() },
  });
}

// What an employee may see: published, active, and meant for them. HR/Admin: any policy of their own company.
async function findVisible(v: Viewer, id: string) {
  const doc = await prisma.inductionDocument.findFirst({ where: { id, platformId: v.platformId } });
  if (!doc) throw new Error("NOT_FOUND");
  const meta = await loadMeta([doc.id]);
  const isStaff = STAFF.includes(v.role);
  const status = statusOf(doc, meta);
  const live = status === "PUBLISHED" && doc.isActive;
  // An owner managing another company is not one of its readers: nothing is recorded as read or confirmed by them there.
  const mine = !v.acting && live && appliesTo(v, doc, meta.audience.get(doc.id) ?? []);
  if (!isStaff && !mine) throw new Error("NOT_FOUND");
  return { doc, meta, live, mine, status };
}

// ===========================================================================================================
// EVERYONE
// ===========================================================================================================

export async function listMine(userId: string) {
  const v = await who(userId);
  const docs = await prisma.inductionDocument.findMany({ where: { platformId: v.platformId, isActive: true }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] });
  const meta = await loadMeta(docs.map((d) => d.id));
  const mineDocs = docs.filter((d) => statusOf(d, meta) === "PUBLISHED" && appliesTo(v, d, meta.audience.get(d.id) ?? []));
  const acks = await prisma.inductionAcknowledgement.findMany({ where: { userId, inductionDocumentId: { in: mineDocs.map((d) => d.id) } } });

  const documents = mineDocs.map((d) => {
    const required = requiredNumber(d, meta);
    const mine = acks.filter((a) => a.inductionDocumentId === d.id);
    const satisfied = mine.find((a) => a.acknowledgedAt && a.documentVersion >= required);
    const current = mine.find((a) => a.documentVersion === d.version);
    const detail = meta.details.get(d.id);
    const live = liveVersion(d, meta);
    const category = categoryOf(d, meta);
    return {
      id: d.id,
      category,
      isInduction: category === INDUCTION_CATEGORY,
      title: d.title,
      description: d.description,
      isMandatory: d.isMandatory,
      version: d.version,
      versionLabel: labelOf(d, meta),
      fileName: d.fileName,
      kind: viewKind(d.mimeType, d.fileName),
      publishedAt: live?.publishedAt ?? detail?.publishedAt ?? d.createdAt,
      effectiveDate: detail?.effectiveDate ? detail.effectiveDate.toISOString().slice(0, 10) : null,
      allowDownload: detail?.allowDownload ?? true,
      status: satisfied ? "ACKNOWLEDGED" : d.isMandatory ? "PENDING" : "OPTIONAL",
      opened: Boolean(current?.openedAt),
      acknowledgedAt: satisfied?.acknowledgedAt ?? null,
    };
  });
  return { documents, pendingMandatory: documents.filter((d) => d.status === "PENDING").length };
}

// My own confirmations, newest first: what I accepted, which version, when. Only mine.
export async function history(userId: string) {
  const v = await who(userId);
  const acks = await prisma.inductionAcknowledgement.findMany({
    where: { userId, acknowledgedAt: { not: null }, inductionDocument: { platformId: v.platformId } },
    include: { inductionDocument: { select: { id: true, title: true, category: true } } },
    orderBy: { acknowledgedAt: "desc" },
  });
  const meta = await loadMeta([...new Set(acks.map((a) => a.inductionDocumentId))]);
  return {
    records: acks.map((a) => {
      const ver = (meta.versions.get(a.inductionDocumentId) ?? []).find((x) => x.number === a.documentVersion);
      return { policyId: a.inductionDocumentId, title: a.inductionDocument.title, category: meta.details.get(a.inductionDocumentId)?.category ?? NAME_FOR[String(a.inductionDocument.category)] ?? "Other", versionLabel: ver?.label ?? `${a.documentVersion}.0`, acknowledgedAt: a.acknowledgedAt };
    }),
  };
}

// One policy: its details, my own status, and (HR/Admin only) versions, review notes, audience and counts.
export async function getPolicy(userId: string, id: string) {
  const v = await who(userId);
  const { doc, meta, status, mine } = await findVisible(v, id);
  const detail = meta.details.get(doc.id);
  const required = requiredNumber(doc, meta);
  const myAcks = await prisma.inductionAcknowledgement.findMany({ where: { userId, inductionDocumentId: doc.id }, orderBy: { documentVersion: "desc" } });
  const satisfied = myAcks.find((a) => a.acknowledgedAt && a.documentVersion >= required);
  const current = myAcks.find((a) => a.documentVersion === doc.version);
  const live = liveVersion(doc, meta);

  const base = {
    id: doc.id,
    title: doc.title,
    description: doc.description,
    category: categoryOf(doc, meta),
    status,
    isMandatory: doc.isMandatory,
    version: doc.version,
    versionLabel: labelOf(doc, meta),
    fileName: doc.fileName,
    kind: viewKind(doc.mimeType, doc.fileName),
    publishedAt: live?.publishedAt ?? detail?.publishedAt ?? null,
    effectiveDate: detail?.effectiveDate ? detail.effectiveDate.toISOString().slice(0, 10) : null,
    allowDownload: detail?.allowDownload ?? true,
    my: mine
      ? {
          applies: true,
          status: satisfied ? "ACKNOWLEDGED" : doc.isMandatory ? "PENDING" : "OPTIONAL",
          opened: Boolean(current?.openedAt),
          acknowledgedAt: satisfied?.acknowledgedAt ?? null,
          history: myAcks.filter((a) => a.acknowledgedAt).map((a) => ({ versionLabel: (meta.versions.get(doc.id) ?? []).find((x) => x.number === a.documentVersion)?.label ?? `${a.documentVersion}.0`, acknowledgedAt: a.acknowledgedAt })),
        }
      : { applies: false, status: "NOT_APPLICABLE", opened: false, acknowledgedAt: null, history: [] },
  };
  if (!STAFF.includes(v.role)) return base;
  return { ...base, hr: await hrDetail(v, doc, meta) };
}

// Everything HR needs on one policy's page.
async function hrDetail(v: Viewer, doc: Doc, meta: Meta) {
  const versions = meta.versions.get(doc.id) ?? [];
  const aud = meta.audience.get(doc.id) ?? [];
  const [notes, ppl, acks, authors] = await Promise.all([
    (await ready()) ? prisma.policyReviewNote.findMany({ where: { policyId: doc.id }, orderBy: { createdAt: "asc" } }) : Promise.resolve([]),
    people(v.platformId),
    prisma.inductionAcknowledgement.findMany({ where: { inductionDocumentId: doc.id }, select: { userId: true, documentVersion: true, acknowledgedAt: true } }),
    prisma.user.findMany({ where: { id: { in: [...new Set(versions.map((x) => x.createdById).filter((x): x is string => !!x))] } }, select: { id: true, firstName: true, lastName: true } }),
  ]);
  const authorName = new Map(authors.map((a) => [a.id, `${a.firstName} ${a.lastName}`.trim()]));
  const audience = ppl.filter((p) => appliesTo(p, doc, aud));
  const required = requiredNumber(doc, meta);
  const done = audience.filter((p) => acks.some((a) => a.userId === p.id && a.acknowledgedAt && a.documentVersion >= required)).length;
  return {
    audience: {
      teamIds: aud.filter((r) => r.kind === "TEAM").map((r) => r.value),
      employmentTypes: aud.filter((r) => r.kind === "EMPLOYMENT_TYPE").map((r) => r.value),
      roles: aud.filter((r) => r.kind === "ROLE").map((r) => r.value),
      everyone: aud.length === 0 && doc.teamId === null,
      size: audience.length,
    },
    counts: { required: audience.length, acknowledged: done, pending: audience.length - done },
    versions: versions.map((x) => ({
      id: x.id, number: x.number, label: x.label, status: x.status, fileName: x.fileName, changeNote: x.changeNote, requiresAck: x.requiresAck,
      createdBy: x.createdById ? authorName.get(x.createdById) ?? null : null, createdAt: x.createdAt, publishedAt: x.publishedAt,
      acknowledged: acks.filter((a) => a.documentVersion === x.number && a.acknowledgedAt).length,
    })),
    pendingDraftVersion: versions.find((x) => x.status === "DRAFT") ? true : false,
    notes: notes.map((n) => ({ id: n.id, title: n.title, detail: n.detail, status: n.status, resolutionNote: n.resolutionNote, resolvedAt: n.resolvedAt })),
    openNotes: notes.filter((n) => n.status === "OPEN").length,
  };
}

// Which stored file does a request mean? Employees: always the live one. HR/Admin: any version (drafts too).
async function fileFor(v: Viewer, id: string, versionNumber?: number) {
  const { doc, meta, live, mine } = await findVisible(v, id);
  if (versionNumber !== undefined && STAFF.includes(v.role)) {
    const ver = (meta.versions.get(doc.id) ?? []).find((x) => x.number === versionNumber);
    if (!ver) throw new Error("NOT_FOUND");
    return { doc, meta, storageKey: ver.storageKey, fileName: ver.fileName, mimeType: ver.mimeType, label: ver.label, countsAsOpened: false };
  }
  return { doc, meta, storageKey: doc.storageKey, fileName: doc.fileName, mimeType: doc.mimeType, label: labelOf(doc, meta), countsAsOpened: live && mine };
}

// The file itself (PDF or image shown inline; a download if asked and allowed).
export async function openFile(userId: string, id: string, opts: { version?: number; download?: boolean } = {}) {
  const v = await who(userId);
  const f = await fileFor(v, id, opts.version);
  if (opts.download && !STAFF.includes(v.role) && meta_allowDownload(f.doc, f.meta) === false) throw new Error("DOWNLOAD_NOT_ALLOWED");
  if (f.countsAsOpened) await markOpened(userId, f.doc);
  const buffer = await readStored(f.storageKey);
  return { buffer, fileName: f.fileName, mimeType: f.mimeType ?? contentTypeFor(f.storageKey), download: Boolean(opts.download) };
}
const meta_allowDownload = (doc: Doc, meta: Meta) => meta.details.get(doc.id)?.allowDownload ?? true;

// The readable version for the reading page. Word files are converted for display; PDFs and images are shown by the
// browser from the file endpoint. Opening a live policy that is meant for you records "opened".
export async function viewContent(userId: string, id: string, opts: { version?: number } = {}) {
  const v = await who(userId);
  const f = await fileFor(v, id, opts.version);
  const kind = viewKind(f.mimeType, f.fileName);
  if (f.countsAsOpened) await markOpened(userId, f.doc);
  if (kind === "docx") {
    const { html } = await docxToHtml(await readStored(f.storageKey), f.storageKey);
    return { kind, html, fileName: f.fileName, versionLabel: f.label };
  }
  return { kind, html: null as string | null, fileName: f.fileName, versionLabel: f.label };
}

// You can only confirm a policy you have opened, for the version that is live now, and only by ticking the box.
export async function acknowledge(userId: string, id: string, body: { confirmed?: unknown } = {}) {
  if (body.confirmed !== true) throw new Error("CONFIRM_REQUIRED");
  const v = await who(userId);
  const { doc, meta, live, mine } = await findVisible(v, id);
  if (!live || !mine) throw new Error("NOT_FOUND");
  const res = await prisma.inductionAcknowledgement.updateMany({
    where: { inductionDocumentId: doc.id, userId, documentVersion: doc.version, openedAt: { not: null }, acknowledgedAt: null },
    data: { acknowledgedAt: new Date() },
  });
  if (res.count === 0) {
    const existing = await prisma.inductionAcknowledgement.findUnique({ where: { inductionDocumentId_userId_documentVersion: { inductionDocumentId: doc.id, userId, documentVersion: doc.version } } });
    if (existing?.acknowledgedAt) return { ok: true, already: true, acknowledgedAt: existing.acknowledgedAt };
    throw new Error("OPEN_FIRST");
  }
  const label = labelOf(doc, meta);
  auditNote({ module: "Policies", action: "APPROVE", recordType: "InductionDocument", recordId: doc.id, targetUserId: userId, summary: `Confirmed they read "${doc.title}" (version ${label})`, after: { policy: doc.title, version: label } });
  emitPolicyChange({ userIds: [userId], policyId: doc.id, action: "acknowledged" });
  return { ok: true, already: false, acknowledgedAt: new Date() };
}

// ===========================================================================================================
// HR / ADMIN
// ===========================================================================================================

type Upload = { fileName?: string; data?: string; mimeType?: string };
async function store(platformId: string, f: Upload) {
  if (!f.data || !f.fileName) throw new Error("FILE_REQUIRED");
  return saveUpload({ platformId, folder: "induction", originalName: f.fileName, data: f.data, mimeType: f.mimeType });
}

async function categoryNames(platformId: string): Promise<string[]> {
  if (!(await ready())) return [...BUILT_IN_CATEGORIES];
  const custom = await prisma.policyCategory.findMany({ where: { platformId }, orderBy: { name: "asc" } });
  return [...BUILT_IN_CATEGORIES, ...custom.map((c) => c.name)];
}

// The companies an owner HR/Admin can manage policies for (everyone else: no switcher).
export async function listCompanies(userId: string) {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { role: true, platformId: true } });
  if (!u || !["HR", "ADMIN"].includes(String(u.role))) return { canSwitch: false, ownCompanyId: u?.platformId ?? null, companies: [] as { id: string; name: string }[] };
  const access = await accessFor(userId);
  const rows = visibleCompanies(access, await prisma.platform.findMany({ where: { isActive: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }));
  // Someone who can act on only their own company has nothing to switch to.
  return { canSwitch: rows.length > 1, ownCompanyId: u.platformId, companies: rows.length > 1 ? rows : [] };
}

export async function listCategories(viewerId: string) {
  const v = await staff(viewerId);
  return { categories: await categoryNames(v.platformId), builtIn: [...BUILT_IN_CATEGORIES] };
}

export async function addCategory(viewerId: string, body: { name?: unknown }) {
  const v = await staff(viewerId);
  await requireReady();
  const name = String(body.name ?? "").trim().replace(/\s+/g, " ");
  if (name.length < 2 || name.length > 60) throw new Error("BAD_CATEGORY_NAME");
  const existing = await categoryNames(v.platformId);
  if (existing.some((c) => c.toLowerCase() === name.toLowerCase())) throw new Error("CATEGORY_EXISTS");
  await prisma.policyCategory.create({ data: { platformId: v.platformId, name, createdById: v.id } });
  auditNote({ module: "Policies", action: "CREATE", recordType: "PolicyCategory", summary: `Added the policy category "${name}"`, after: { name } });
  return listCategories(viewerId);
}

// Validate and normalise what the HR form sent.
async function readAudience(v: Viewer, body: { audience?: { teamIds?: unknown; employmentTypes?: unknown; roles?: unknown } | null }): Promise<AudRow[]> {
  const a = body.audience ?? {};
  const list = (x: unknown) => (Array.isArray(x) ? [...new Set(x.map((y) => String(y)))] : []);
  const teamIds = list(a.teamIds);
  const types = list(a.employmentTypes);
  const roles = list(a.roles);
  if (teamIds.length) {
    const found = await prisma.team.findMany({ where: { id: { in: teamIds }, platformId: v.platformId }, select: { id: true } });
    if (found.length !== teamIds.length) throw new Error("TEAM_NOT_FOUND");
  }
  if (types.some((t) => !EMPLOYMENT_TYPES.includes(t))) throw new Error("BAD_AUDIENCE");
  if (roles.some((r) => !ROLES.includes(r))) throw new Error("BAD_AUDIENCE");
  return [...teamIds.map((value) => ({ kind: "TEAM", value })), ...types.map((value) => ({ kind: "EMPLOYMENT_TYPE", value })), ...roles.map((value) => ({ kind: "ROLE", value }))];
}

const LABEL = /^[0-9A-Za-z][0-9A-Za-z._-]{0,19}$/;
const readLabel = (x: unknown, fallback: string) => {
  const s = String(x ?? "").trim() || fallback;
  if (!LABEL.test(s)) throw new Error("BAD_VERSION");
  return s;
};
const readDay = (x: unknown): Date | null => (x === undefined || x === null || x === "" ? null : parseIsoDay(x));

async function readCategory(v: Viewer, x: unknown): Promise<string> {
  const raw = String(x ?? "").trim();
  if (LEGACY_CATEGORIES.includes(raw)) return NAME_FOR[raw]!; // an old-style key still works
  const names = await categoryNames(v.platformId);
  const found = names.find((n) => n.toLowerCase() === raw.toLowerCase());
  if (!found) throw new Error("BAD_CATEGORY");
  return found;
}

export async function createDocument(
  viewerId: string,
  body: Upload & { category?: string; title?: string; description?: string; isMandatory?: boolean; teamId?: string | null; versionLabel?: string; effectiveDate?: string | null; allowDownload?: boolean; audience?: { teamIds?: unknown; employmentTypes?: unknown; roles?: unknown } | null },
  actAs?: string
) {
  const v = await staff(viewerId, actAs);
  const category = await readCategory(v, body.category);
  const title = String(body.title ?? "").trim();
  if (title.length < 2) throw new Error("TITLE_REQUIRED");
  if (title.length > 120) throw new Error("TITLE_TOO_LONG");
  const description = String(body.description ?? "").trim().slice(0, 500) || null;
  const isNew = await ready();

  let teamId: string | null = null; // the old single-team field, still honoured when the new audience is not used
  if (body.teamId) {
    const team = await prisma.team.findFirst({ where: { id: String(body.teamId), platformId: v.platformId }, select: { id: true } });
    if (!team) throw new Error("TEAM_NOT_FOUND");
    teamId = team.id;
  }
  const audience = isNew ? await readAudience(v, body) : [];
  const label = readLabel(body.versionLabel, "1.0");
  const effectiveDate = isNew ? readDay(body.effectiveDate) : null;
  const file = await store(v.platformId, body);
  const enumCategory = (ENUM_FOR[category] ?? "OTHER") as never;

  // Not on the new schema yet: the old behaviour (published straight away), so nothing regresses.
  if (!isNew) {
    const doc = await prisma.inductionDocument.create({ data: { platformId: v.platformId, category: enumCategory, title, description, storageKey: file.storageKey, fileName: file.fileName, fileSize: file.fileSize, mimeType: file.mimeType, isMandatory: body.isMandatory !== false, teamId } });
    return { id: doc.id, status: "PUBLISHED" };
  }

  const doc = await prisma.$transaction(async (tx) => {
    const d = await tx.inductionDocument.create({
      data: { platformId: v.platformId, category: enumCategory, title, description, storageKey: file.storageKey, fileName: file.fileName, fileSize: file.fileSize, mimeType: file.mimeType, isMandatory: body.isMandatory !== false, teamId: null, isActive: false },
    });
    await tx.policyDetail.create({ data: { policyId: d.id, platformId: v.platformId, status: "DRAFT", category, effectiveDate, allowDownload: body.allowDownload !== false, createdById: v.id } });
    await tx.policyVersion.create({ data: { policyId: d.id, platformId: v.platformId, number: 1, label, status: "DRAFT", storageKey: file.storageKey, fileName: file.fileName, fileSize: file.fileSize, mimeType: file.mimeType, requiresAck: true, createdById: v.id } });
    if (audience.length) await tx.policyAudience.createMany({ data: audience.map((a) => ({ policyId: d.id, kind: a.kind, value: a.value })) });
    return d;
  });
  auditNote({ module: "Policies", action: "CREATE", recordType: "InductionDocument", recordId: doc.id, summary: `Saved the policy "${title}" as a draft (version ${label})`, after: { title, category, version: label, status: "DRAFT" } });
  return { id: doc.id, status: "DRAFT" };
}

async function loadForStaff(v: Viewer, id: string) {
  const doc = await prisma.inductionDocument.findFirst({ where: { id, platformId: v.platformId } });
  if (!doc) throw new Error("NOT_FOUND");
  const meta = await loadMeta([doc.id]);
  return { doc, meta };
}

// Edit a DRAFT: its details and, optionally, its file. A published policy changes only through a new version.
export async function updateDraft(
  viewerId: string,
  id: string,
  body: Upload & { title?: string; description?: string; category?: string; isMandatory?: boolean; versionLabel?: string; effectiveDate?: string | null; allowDownload?: boolean; audience?: { teamIds?: unknown; employmentTypes?: unknown; roles?: unknown } | null }
) {
  const v = await staff(viewerId);
  await requireReady();
  const { doc, meta } = await loadForStaff(v, id);
  const detail = meta.details.get(doc.id);
  if (detail?.status !== "DRAFT") throw new Error("NOT_A_DRAFT");
  const draft = (meta.versions.get(doc.id) ?? []).find((x) => x.status === "DRAFT");
  if (!draft) throw new Error("NOT_A_DRAFT");

  const data: Record<string, unknown> = {};
  if (body.title !== undefined) {
    const t = String(body.title).trim();
    if (t.length < 2) throw new Error("TITLE_REQUIRED");
    if (t.length > 120) throw new Error("TITLE_TOO_LONG");
    data.title = t;
  }
  if (body.description !== undefined) data.description = String(body.description ?? "").trim().slice(0, 500) || null;
  if (body.isMandatory !== undefined) data.isMandatory = body.isMandatory !== false;
  const detailData: Record<string, unknown> = {};
  if (body.category !== undefined) {
    const c = await readCategory(v, body.category);
    detailData.category = c;
    data.category = (ENUM_FOR[c] ?? "OTHER") as never;
  }
  if (body.effectiveDate !== undefined) detailData.effectiveDate = readDay(body.effectiveDate);
  if (body.allowDownload !== undefined) detailData.allowDownload = body.allowDownload !== false;
  const audience = body.audience !== undefined ? await readAudience(v, body) : null;
  const label = body.versionLabel !== undefined ? readLabel(body.versionLabel, draft.label) : null;
  const file = body.data ? await store(v.platformId, body) : null;

  await prisma.$transaction(async (tx) => {
    if (file) Object.assign(data, { storageKey: file.storageKey, fileName: file.fileName, fileSize: file.fileSize, mimeType: file.mimeType });
    if (Object.keys(data).length) await tx.inductionDocument.update({ where: { id }, data: data as never });
    if (Object.keys(detailData).length) await tx.policyDetail.update({ where: { policyId: id }, data: detailData as never });
    if (file || label) await tx.policyVersion.update({ where: { id: draft.id }, data: { ...(label ? { label } : {}), ...(file ? { storageKey: file.storageKey, fileName: file.fileName, fileSize: file.fileSize, mimeType: file.mimeType } : {}) } });
    if (audience) {
      await tx.policyAudience.deleteMany({ where: { policyId: id } });
      if (audience.length) await tx.policyAudience.createMany({ data: audience.map((a) => ({ policyId: id, kind: a.kind, value: a.value })) });
    }
  });
  if (file) await prisma.storedBlob.delete({ where: { storageKey: draft.storageKey } }).catch(() => undefined); // only the unpublished draft's old file
  auditNote({ module: "Policies", action: "UPDATE", recordType: "InductionDocument", recordId: id, summary: `Edited the draft "${doc.title}"` });
  return { ok: true };
}

// A new version of a PUBLISHED policy. Stored as a draft version beside the live one; nothing changes for employees
// until HR publishes it. The previous version and everybody's confirmations of it stay on record.
export async function uploadNewVersion(viewerId: string, id: string, body: Upload & { versionLabel?: string; changeNote?: string; requiresAck?: boolean }) {
  const v = await staff(viewerId);
  await requireReady();
  const { doc, meta } = await loadForStaff(v, id);
  if (meta.details.get(doc.id)?.status !== "PUBLISHED") throw new Error("NOT_PUBLISHED");
  const versions = meta.versions.get(doc.id) ?? [];
  if (versions.some((x) => x.status === "DRAFT")) throw new Error("DRAFT_VERSION_EXISTS");
  const number = Math.max(...versions.map((x) => x.number), doc.version) + 1;
  const label = readLabel(body.versionLabel, `${number}.0`);
  if (versions.some((x) => x.label === label)) throw new Error("VERSION_LABEL_EXISTS");
  const file = await store(v.platformId, body);
  await prisma.policyVersion.create({
    data: { policyId: doc.id, platformId: v.platformId, number, label, status: "DRAFT", storageKey: file.storageKey, fileName: file.fileName, fileSize: file.fileSize, mimeType: file.mimeType, changeNote: String(body.changeNote ?? "").trim().slice(0, 500) || null, requiresAck: body.requiresAck !== false, createdById: v.id },
  });
  auditNote({ module: "Policies", action: "CREATE", recordType: "InductionDocument", recordId: doc.id, summary: `Prepared version ${label} of "${doc.title}" (not published yet)`, after: { version: label, requiresAck: body.requiresAck !== false } });
  return { ok: true, number, label };
}

// Replace the file of the UNPUBLISHED version (a draft policy, or a version still being prepared). Nothing live is touched.
export async function replaceFile(viewerId: string, id: string, body: Upload) {
  const v = await staff(viewerId);
  if (!(await ready())) throw new Error("FEATURES_NOT_READY");
  const { doc, meta } = await loadForStaff(v, id);
  const draft = (meta.versions.get(doc.id) ?? []).find((x) => x.status === "DRAFT");
  if (!draft) throw new Error("NO_DRAFT_VERSION");
  const file = await store(v.platformId, body);
  await prisma.$transaction(async (tx) => {
    await tx.policyVersion.update({ where: { id: draft.id }, data: { storageKey: file.storageKey, fileName: file.fileName, fileSize: file.fileSize, mimeType: file.mimeType } });
    if (meta.details.get(doc.id)?.status === "DRAFT") await tx.inductionDocument.update({ where: { id }, data: { storageKey: file.storageKey, fileName: file.fileName, fileSize: file.fileSize, mimeType: file.mimeType } });
  });
  await prisma.storedBlob.delete({ where: { storageKey: draft.storageKey } }).catch(() => undefined);
  auditNote({ module: "Policies", action: "UPDATE", recordType: "InductionDocument", recordId: id, summary: `Replaced the file of the unpublished version of "${doc.title}"` });
  return { ok: true };
}

// Publish the unpublished version (the draft policy itself, or a prepared new version). HR must confirm, and must
// have acknowledged any review notes that are still open. Employees in the audience are notified.
export async function publish(viewerId: string, id: string, body: { confirm?: unknown; acknowledgeNotes?: unknown; effectiveDate?: string | null; requiresAck?: boolean }, actAs?: string) {
  if (body.confirm !== true) throw new Error("CONFIRM_REQUIRED");
  const v = await staff(viewerId, actAs);
  await requireReady();
  const { doc, meta } = await loadForStaff(v, id);
  const detail = meta.details.get(doc.id);
  if (!detail || (detail.status !== "DRAFT" && detail.status !== "PUBLISHED")) throw new Error("NOTHING_TO_PUBLISH");
  const versions = meta.versions.get(doc.id) ?? [];
  const draft = versions.find((x) => x.status === "DRAFT");
  if (!draft) throw new Error("NOTHING_TO_PUBLISH");

  const open = await prisma.policyReviewNote.count({ where: { policyId: id, status: "OPEN" } });
  if (open > 0 && body.acknowledgeNotes !== true) throw new Error("OPEN_NOTES");

  const firstPublish = detail.status === "DRAFT";
  const eff = body.effectiveDate !== undefined ? readDay(body.effectiveDate) : detail.effectiveDate;
  const effectiveDate = eff ?? platformToday(v.timezone);
  const now = new Date();
  const requiresAck = firstPublish ? true : body.requiresAck !== undefined ? body.requiresAck !== false : draft.requiresAck;

  await prisma.$transaction(async (tx) => {
    await tx.policyVersion.updateMany({ where: { policyId: id, status: "PUBLISHED" }, data: { status: "SUPERSEDED" } });
    await tx.policyVersion.update({ where: { id: draft.id }, data: { status: "PUBLISHED", publishedAt: now, publishedById: v.id, requiresAck } });
    await tx.policyDetail.update({ where: { policyId: id }, data: { status: "PUBLISHED", effectiveDate, publishedAt: detail.publishedAt ?? now } });
    // The row everything else reads now points at the live version; the old file stays safe in its version row.
    await tx.inductionDocument.update({ where: { id }, data: { isActive: true, storageKey: draft.storageKey, fileName: draft.fileName, fileSize: draft.fileSize, mimeType: draft.mimeType, version: draft.number } });
  });

  // After the commit: tell the people it is for, and the pages that are open.
  const ppl = await people(v.platformId);
  const fresh = (await prisma.inductionDocument.findFirst({ where: { id } }))!;
  const audience = ppl.filter((p) => appliesTo(p, fresh, meta.audience.get(id) ?? []));
  const verb = firstPublish ? "A new policy was published" : requiresAck ? "A policy was updated: please read and confirm it again" : "A policy was updated";
  await notifyUsers({
    platformId: v.platformId,
    userIds: audience.map((p) => p.id).filter((x) => x !== v.id),
    type: firstPublish ? "POLICY_PUBLISHED" : "POLICY_UPDATED",
    title: `${doc.title} (version ${draft.label})`,
    body: `${verb}.${doc.isMandatory && requiresAck ? " Your confirmation is required." : ""}`,
    link: `/dashboard/policies/${id}`,
    data: { policyId: id, version: draft.label },
  });
  emitPolicyChange({ userIds: [...audience.map((p) => p.id), v.id], policyId: id, action: "published" });
  auditNote({ module: "Policies", action: "APPROVE", recordType: "InductionDocument", recordId: id, summary: `Published "${doc.title}" version ${draft.label}${open ? ` (${open} review note${open === 1 ? "" : "s"} still open)` : ""}`, before: { status: detail.status }, after: { status: "PUBLISHED", version: draft.label, requiresAck, audience: audience.length } });
  return { ok: true, version: draft.label, notified: audience.length };
}

export async function setActive(viewerId: string, id: string, active: boolean) {
  const v = await staff(viewerId);
  const { doc, meta } = await loadForStaff(v, id);
  const detail = meta.details.get(doc.id);
  if (!detail) {
    // An old document (no policy_details row): archive/restore exactly as before.
    await prisma.inductionDocument.update({ where: { id }, data: { isActive: active } });
    return { ok: true };
  }
  const everPublished = (meta.versions.get(doc.id) ?? []).some((x) => x.status === "PUBLISHED" || x.status === "SUPERSEDED");
  const next = active ? (everPublished ? "PUBLISHED" : "DRAFT") : "ARCHIVED";
  await prisma.$transaction(async (tx) => {
    await tx.policyDetail.update({ where: { policyId: id }, data: { status: next } });
    await tx.inductionDocument.update({ where: { id }, data: { isActive: next === "PUBLISHED" } });
  });
  auditNote({ module: "Policies", action: "UPDATE", recordType: "InductionDocument", recordId: id, summary: `${active ? "Restored" : "Archived"} "${doc.title}"`, before: { status: detail.status }, after: { status: next } });
  const ppl = await people(v.platformId);
  emitPolicyChange({ userIds: ppl.filter((p) => appliesTo(p, doc, meta.audience.get(id) ?? [])).map((p) => p.id), policyId: id, action: active ? "restored" : "archived" });
  return { ok: true, status: next };
}

// Review notes: HR marks each one resolved (or dismissed with a reason). They never change the document.
export async function resolveNote(viewerId: string, policyId: string, noteId: string, body: { status?: unknown; note?: unknown }) {
  const v = await staff(viewerId);
  await requireReady();
  const status = String(body.status ?? "");
  if (!["RESOLVED", "DISMISSED", "OPEN"].includes(status)) throw new Error("BAD_STATUS");
  const note = await prisma.policyReviewNote.findFirst({ where: { id: noteId, policyId, platformId: v.platformId } });
  if (!note) throw new Error("NOT_FOUND");
  const reason = String(body.note ?? "").trim().slice(0, 500) || null;
  if (status === "DISMISSED" && !reason) throw new Error("REASON_REQUIRED");
  await prisma.policyReviewNote.update({ where: { id: noteId }, data: { status, resolvedById: status === "OPEN" ? null : v.id, resolvedAt: status === "OPEN" ? null : new Date(), resolutionNote: status === "OPEN" ? null : reason } });
  auditNote({ module: "Policies", action: "UPDATE", recordType: "PolicyReviewNote", recordId: noteId, summary: `${status === "OPEN" ? "Re-opened" : status === "RESOLVED" ? "Resolved" : "Dismissed"} a policy review note: ${note.title}`, before: { status: note.status }, after: { status, reason } });
  return { ok: true };
}

// --- dashboards and tracking -----------------------------------------------------------------------------------

const audienceLabel = (rows: AudRow[], teamName: Map<string, string>, legacyTeam: string | null) => {
  if (rows.length === 0) return legacyTeam ? `Team: ${teamName.get(legacyTeam) ?? "Team"}` : "All employees";
  const parts: string[] = [];
  const teams = rows.filter((r) => r.kind === "TEAM").map((r) => teamName.get(r.value) ?? "Team");
  if (teams.length) parts.push(`Teams: ${teams.join(", ")}`);
  const types = rows.filter((r) => r.kind === "EMPLOYMENT_TYPE").map((r) => r.value.toLowerCase());
  if (types.length) parts.push(types.join(", "));
  const roles = rows.filter((r) => r.kind === "ROLE").map((r) => r.value.toLowerCase());
  if (roles.length) parts.push(`roles: ${roles.join(", ")}`);
  return parts.join(" · ");
};

export async function manageList(viewerId: string) {
  const v = await staff(viewerId);
  const [docs, teams, ppl] = await Promise.all([
    prisma.inductionDocument.findMany({ where: { platformId: v.platformId }, orderBy: [{ createdAt: "desc" }] }),
    prisma.team.findMany({ where: { platformId: v.platformId, isActive: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    people(v.platformId),
  ]);
  const meta = await loadMeta(docs.map((d) => d.id));
  const acks = await prisma.inductionAcknowledgement.findMany({ where: { inductionDocumentId: { in: docs.map((d) => d.id) }, acknowledgedAt: { not: null } }, select: { inductionDocumentId: true, documentVersion: true, userId: true } });
  const noteCounts = (await ready()) ? await prisma.policyReviewNote.groupBy({ by: ["policyId"], where: { platformId: v.platformId, status: "OPEN" }, _count: { _all: true } }) : [];
  const openNotes = new Map(noteCounts.map((n) => [n.policyId, n._count._all]));
  const authorIds = [...new Set([...meta.details.values()].map((d) => d.createdById).filter((x): x is string => !!x))];
  const authors = new Map((await prisma.user.findMany({ where: { id: { in: authorIds } }, select: { id: true, firstName: true, lastName: true } })).map((a) => [a.id, `${a.firstName} ${a.lastName}`.trim()]));
  const teamName = new Map(teams.map((t) => [t.id, t.name]));

  let requiredPairs = 0, completedPairs = 0;
  const peoplePending = new Set<string>();
  const documents = docs.map((d) => {
    const status = statusOf(d, meta);
    const aud = meta.audience.get(d.id) ?? [];
    const audience = ppl.filter((p) => appliesTo(p, d, aud));
    const required = requiredNumber(d, meta);
    const done = audience.filter((p) => acks.some((a) => a.inductionDocumentId === d.id && a.userId === p.id && a.documentVersion >= required)).length;
    if (status === "PUBLISHED" && d.isMandatory) {
      requiredPairs += audience.length;
      completedPairs += done;
      for (const p of audience) if (!acks.some((a) => a.inductionDocumentId === d.id && a.userId === p.id && a.documentVersion >= required)) peoplePending.add(p.id);
    }
    const detail = meta.details.get(d.id);
    const live = liveVersion(d, meta);
    return {
      id: d.id, title: d.title, description: d.description, category: categoryOf(d, meta), status, isMandatory: d.isMandatory,
      version: d.version, versionLabel: labelOf(d, meta), fileName: d.fileName,
      createdBy: detail?.createdById ? authors.get(detail.createdById) ?? null : null,
      publishedAt: live?.publishedAt ?? detail?.publishedAt ?? null,
      effectiveDate: detail?.effectiveDate ? detail.effectiveDate.toISOString().slice(0, 10) : null,
      audienceLabel: audienceLabel(aud, teamName, d.teamId), audience: audience.length, accepted: done,
      openNotes: openNotes.get(d.id) ?? 0,
      hasPendingVersion: (meta.versions.get(d.id) ?? []).some((x) => x.status === "DRAFT") && status === "PUBLISHED",
      // Kept for the older page layout:
      isActive: d.isActive, team: d.teamId ? { id: d.teamId, name: teamName.get(d.teamId) ?? "Team" } : null,
    };
  });
  const count = (s: string) => documents.filter((d) => d.status === s).length;
  return {
    teams,
    categories: await categoryNames(v.platformId),
    employmentTypes: EMPLOYMENT_TYPES,
    roles: ROLES,
    schemaReady: await ready(),
    summary: { total: documents.length, published: count("PUBLISHED"), draft: count("DRAFT"), archived: count("ARCHIVED"), requiredPairs, completedPairs, pendingPairs: requiredPairs - completedPairs, peopleWithPending: peoplePending.size },
    documents,
  };
}

// Who has and has not confirmed, across policies (or one). One row per person per published policy.
export async function tracking(viewerId: string, q: { policyId?: string; teamId?: string; userId?: string; status?: string; search?: string }) {
  const v = await staff(viewerId);
  const docs = await prisma.inductionDocument.findMany({ where: { platformId: v.platformId, isActive: true, ...(q.policyId ? { id: q.policyId } : {}) }, orderBy: { title: "asc" } });
  const meta = await loadMeta(docs.map((d) => d.id));
  const live = docs.filter((d) => statusOf(d, meta) === "PUBLISHED");
  const [ppl, acks, teams] = await Promise.all([
    people(v.platformId),
    prisma.inductionAcknowledgement.findMany({ where: { inductionDocumentId: { in: live.map((d) => d.id) } }, select: { inductionDocumentId: true, userId: true, documentVersion: true, openedAt: true, acknowledgedAt: true } }),
    prisma.team.findMany({ where: { platformId: v.platformId, isActive: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);
  const needle = String(q.search ?? "").trim().toLowerCase();
  const rows: { userId: string; name: string; employeeCode: string | null; team: string | null; policyId: string; policyTitle: string; versionLabel: string; required: boolean; status: string; openedAt: Date | null; acknowledgedAt: Date | null }[] = [];
  for (const d of live) {
    const required = requiredNumber(d, meta);
    const aud = meta.audience.get(d.id) ?? [];
    for (const p of ppl) {
      if (!appliesTo(p, d, aud)) continue;
      if (q.userId && p.id !== q.userId) continue;
      if (q.teamId && !p.teamIds.includes(q.teamId)) continue;
      if (needle && !p.name.toLowerCase().includes(needle) && !(p.employeeCode ?? "").toLowerCase().includes(needle)) continue;
      const mine = acks.filter((a) => a.inductionDocumentId === d.id && a.userId === p.id);
      const done = mine.find((a) => a.acknowledgedAt && a.documentVersion >= required);
      const opened = mine.find((a) => a.documentVersion === d.version && a.openedAt);
      const status = done ? "ACKNOWLEDGED" : opened ? "OPENED" : "PENDING";
      if (q.status && status !== q.status) continue;
      rows.push({ userId: p.id, name: p.name, employeeCode: p.employeeCode, team: p.teamNames[0] ?? null, policyId: d.id, policyTitle: d.title, versionLabel: labelOf(d, meta), required: d.isMandatory, status, openedAt: opened?.openedAt ?? null, acknowledgedAt: done?.acknowledgedAt ?? null });
    }
  }
  const limited = rows.slice(0, 10_000);
  const count = (s: string) => limited.filter((r) => r.status === s).length;
  return {
    teams, policies: live.map((d) => ({ id: d.id, title: d.title })), people: ppl.map((p) => ({ id: p.id, name: p.name, employeeCode: p.employeeCode })),
    summary: { total: limited.length, acknowledged: count("ACKNOWLEDGED"), opened: count("OPENED"), pending: count("PENDING"), completionPercent: limited.length ? Math.round((count("ACKNOWLEDGED") / limited.length) * 1000) / 10 : null },
    truncated: rows.length > limited.length,
    rows: limited,
  };
}

export async function versions(viewerId: string, id: string) {
  const v = await staff(viewerId);
  const { doc, meta } = await loadForStaff(v, id);
  return { versions: (await hrDetail(v, doc, meta)).versions };
}

// The older per-policy report, kept for the existing page: who accepted the current version and who has not.
export async function report(viewerId: string, id: string) {
  const v = await staff(viewerId);
  const doc = await prisma.inductionDocument.findFirst({ where: { id, platformId: v.platformId } });
  if (!doc) throw new Error("NOT_FOUND");
  const t = await tracking(viewerId, { policyId: id });
  return {
    document: { id: doc.id, title: doc.title, version: doc.version },
    people: t.rows.map((r) => ({ id: r.userId, name: r.name, employeeCode: r.employeeCode, designation: null as string | null, openedAt: r.openedAt, acknowledgedAt: r.acknowledgedAt })),
  };
}
