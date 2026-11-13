import { prisma } from "../../lib/prisma.js";
import { accessFor } from "../../lib/companyAccess.js";
import { inPinnedCompany } from "../../lib/deployment.js";
import { notifyUsers } from "../../lib/notify.js";
import { auditNote } from "../../lib/auditContext.js";
import { parseIsoDay, platformToday } from "../../lib/dates.js";
import { readStored, saveUpload, contentTypeFor } from "../../lib/storage.js";
import { buildLetterPdf } from "./warnings.pdf.js";
import { WL_MARKER, checkIssue, decodeMeta, encodeMeta, issueDateOk, looksLikePdf, mayOpenLetter, type LetterMeta } from "./warnings.logic.js";

// Warning letters live in `employee_documents` (no new table, no migration): category OTHER, status APPROVED, no requirement; see warnings.logic.ts.

const nameOf = (u: { firstName: string; lastName: string } | null | undefined) => (u ? `${u.firstName} ${u.lastName}`.trim() : "HR");
const ROLE_NAME: Record<string, string> = { HR: "HR", ADMIN: "Admin", MANAGER: "Manager", EMPLOYEE: "Employee" };

async function viewerOf(id: string) {
  const u = await prisma.user.findUnique({ where: { id }, select: { id: true, role: true, platformId: true } });
  if (!u) throw new Error("NOT_FOUND");
  const a = await accessFor(id);
  return { id: u.id, role: String(u.role), platformId: u.platformId, access: { all: a.all, ids: a.ids } };
}

type Row = { id: string; userId: string; platformId: string; fileName: string | null; mimeType: string | null; rejectionReason: string | null; uploadedAt: Date | null; uploadedById: string | null; reviewedAt: Date | null; createdAt: Date };

async function shape(rows: Row[]) {
  const issuerIds = [...new Set(rows.map((r) => r.uploadedById).filter((x): x is string => !!x))];
  const issuers = new Map(
    (issuerIds.length ? await prisma.user.findMany({ where: { id: { in: issuerIds } }, select: { id: true, firstName: true, lastName: true, designation: true, role: true } }) : []).map((u) => [u.id, u])
  );
  return rows
    .map((r) => {
      const m = decodeMeta(r.rejectionReason);
      if (!m) return null; // a damaged record is never shown half-filled
      const by = r.uploadedById ? issuers.get(r.uploadedById) : undefined;
      return {
        id: r.id,
        userId: r.userId,
        title: m.title,
        reason: m.reason,
        issueDate: m.issueDate,
        issuedBy: by ? { name: nameOf(by), designation: by.designation ?? null, role: ROLE_NAME[String(by.role)] ?? String(by.role) } : null,
        fileName: r.fileName,
        isPdf: r.mimeType === "application/pdf",
        mimeType: r.mimeType,
        acknowledgedAt: r.reviewedAt ? r.reviewedAt.toISOString() : null,
        createdAt: r.createdAt.toISOString(),
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => (a.issueDate === b.issueDate ? b.createdAt.localeCompare(a.createdAt) : b.issueDate.localeCompare(a.issueDate)));
}

const where = (userId: string) => ({ userId, rejectionReason: { startsWith: WL_MARKER } });
const select = { id: true, userId: true, platformId: true, fileName: true, mimeType: true, rejectionReason: true, uploadedAt: true, uploadedById: true, reviewedAt: true, createdAt: true } as const;

/** The signed-in person's own letters. The id comes from the sign-in, never from the request. */
export async function mine(userId: string) {
  const rows = await prisma.employeeDocument.findMany({ where: where(userId), select });
  return { letters: await shape(rows) };
}

/** HR/Admin: the letters of one employee of a company they may act on. Anyone else is told the person does not exist. */
export async function forPerson(viewerId: string, targetId: string) {
  const v = await viewerOf(viewerId);
  if (v.role !== "HR" && v.role !== "ADMIN") throw new Error("NOT_ALLOWED");
  const t = await prisma.user.findUnique({ where: { id: targetId }, select: { id: true, platformId: true } });
  if (!t || !(v.access.all || v.access.ids.includes(t.platformId)) || !(await inPinnedCompany(t.id))) throw new Error("NOT_FOUND");
  const rows = await prisma.employeeDocument.findMany({ where: where(targetId), select });
  return { letters: await shape(rows) };
}

export async function issue(
  viewerId: string,
  body: { userId?: unknown; title?: unknown; reason?: unknown; issueDate?: unknown; text?: unknown; file?: unknown }
) {
  const v = await viewerOf(viewerId);
  if (v.role !== "HR" && v.role !== "ADMIN") throw new Error("NOT_ALLOWED");
  const targetId = String(body.userId ?? "");
  const t = await prisma.user.findUnique({
    where: { id: targetId },
    select: { id: true, platformId: true, firstName: true, lastName: true, employeeCode: true, designation: true, status: true, platform: { select: { name: true, timezone: true } } },
  });
  // Someone who may not act on that company is told the person does not exist (ids cannot be probed).
  if (!t || !(v.access.all || v.access.ids.includes(t.platformId)) || !(await inPinnedCompany(t.id))) throw new Error("NOT_FOUND");
  if (t.id === viewerId) throw new Error("NOT_YOURSELF");

  const f = body.file && typeof body.file === "object" ? (body.file as { data?: unknown; fileName?: unknown; mimeType?: unknown }) : null;
  const checked = checkIssue(body, !!f);
  if ("error" in checked) throw new Error(checked.error);
  const { title, reason, text } = checked.value;

  const today = platformToday(t.platform.timezone).toISOString().slice(0, 10);
  let issueIso = today;
  if (body.issueDate !== undefined && body.issueDate !== null && body.issueDate !== "") {
    issueIso = parseIsoDay(body.issueDate).toISOString().slice(0, 10); // BAD_DATE if not a real YYYY-MM-DD day
    if (!issueDateOk(issueIso, today)) throw new Error("BAD_ISSUE_DATE");
  }

  const issuer = await prisma.user.findUnique({ where: { id: viewerId }, select: { firstName: true, lastName: true, designation: true, role: true } });
  let upload: { data: string; originalName: string; mimeType?: string };
  if (f) {
    const raw = String(f.data ?? "");
    const b64 = /^data:[^;]+;base64,(.*)$/s.exec(raw)?.[1] ?? raw;
    if (!b64) throw new Error("LETTER_REQUIRED");
    const mime = String(f.mimeType ?? /^data:([^;]+);/.exec(raw)?.[1] ?? "").toLowerCase();
    if (mime === "application/pdf" && !looksLikePdf(Buffer.from(b64, "base64"))) throw new Error("UNSUPPORTED_FILE_TYPE"); // the bytes decide, not the claimed type
    upload = { data: b64, originalName: String(f.fileName ?? "warning-letter"), mimeType: mime };
  } else {
    const pdf = await buildLetterPdf({
      company: t.platform.name, title, reason, text: text!, issueDate: issueIso,
      employeeName: nameOf(t), employeeCode: t.employeeCode, designation: t.designation,
      issuerName: nameOf(issuer), issuerRole: issuer?.designation || ROLE_NAME[String(issuer?.role)] || "HR",
    });
    upload = { data: pdf.toString("base64"), originalName: `Warning letter - ${title}.pdf`, mimeType: "application/pdf" };
  }
  const stored = await saveUpload({ platformId: t.platformId, folder: "warnings", ...upload });

  const meta: LetterMeta = { v: 1, title, reason, issueDate: issueIso, source: text ? "TYPED" : "UPLOAD" };
  const doc = await prisma.employeeDocument.create({
    data: {
      platformId: t.platformId,
      userId: t.id,
      category: "OTHER",
      status: "APPROVED", // never "missing" or "pending" in the document checklist
      storageKey: stored.storageKey,
      fileName: stored.fileName,
      fileSize: stored.fileSize,
      mimeType: stored.mimeType,
      uploadedAt: new Date(),
      uploadedById: viewerId,
      rejectionReason: encodeMeta(meta), // carries the letter's name, reason and issue date (see warnings.logic.ts)
    },
    select,
  });

  auditNote({
    platformId: t.platformId, module: "Employees", action: "CREATE", recordType: "WarningLetter", recordId: doc.id, targetUserId: t.id,
    summary: `Issued warning letter "${title}" to ${nameOf(t)}`, after: { title, reason, issueDate: issueIso, source: meta.source },
  });
  await notifyUsers({
    platformId: t.platformId, userIds: [t.id], type: "WARNING_LETTER_ISSUED", title: "A warning letter was issued to you",
    body: `${nameOf(issuer)} issued: ${title}. Open My Profile to read it and acknowledge receipt.`, link: "/dashboard/profile", dedupeKey: `warning:${doc.id}:issued`, data: { letterId: doc.id },
  });
  return (await shape([doc]))[0]!;
}

async function letterFor(viewerId: string, id: string) {
  const doc = await prisma.employeeDocument.findFirst({ where: { id, rejectionReason: { startsWith: WL_MARKER } }, select: { ...select, storageKey: true } });
  if (!doc) throw new Error("NOT_FOUND");
  const v = await viewerOf(viewerId);
  // A letter that is not yours (and not in a company you act on as HR/Admin) does not exist for you.
  if (!mayOpenLetter(v, doc) || !(await inPinnedCompany(doc.userId))) throw new Error("NOT_FOUND");
  return { doc, v };
}

export async function openFile(viewerId: string, id: string) {
  const { doc } = await letterFor(viewerId, id);
  if (!doc.storageKey) throw new Error("FILE_MISSING");
  const buffer = await readStored(doc.storageKey);
  return { buffer, mimeType: doc.mimeType ?? contentTypeFor(doc.storageKey), fileName: doc.fileName ?? "warning-letter" };
}

/** The employee confirms receipt. Only the person it was issued to; only once (the first time is kept). */
export async function acknowledge(viewerId: string, id: string) {
  const doc = await prisma.employeeDocument.findFirst({ where: { id, userId: viewerId, rejectionReason: { startsWith: WL_MARKER } }, select });
  if (!doc) throw new Error("NOT_FOUND"); // someone else's letter does not exist for you
  const at = new Date();
  const claimed = await prisma.employeeDocument.updateMany({ where: { id, userId: viewerId, reviewedAt: null }, data: { reviewedAt: at, reviewedById: viewerId } });
  if (claimed.count === 0) throw new Error("ALREADY_ACKNOWLEDGED");
  const m = decodeMeta(doc.rejectionReason);
  const me = await prisma.user.findUnique({ where: { id: viewerId }, select: { firstName: true, lastName: true } });
  auditNote({
    platformId: doc.platformId, module: "Employees", action: "APPROVE", recordType: "WarningLetter", recordId: id, targetUserId: viewerId,
    summary: `Acknowledged receipt of warning letter "${m?.title ?? ""}"`, after: { acknowledgedAt: at.toISOString() },
  });
  if (doc.uploadedById && doc.uploadedById !== viewerId) {
    const issuer = await prisma.user.findUnique({ where: { id: doc.uploadedById }, select: { platformId: true } });
    await notifyUsers({
      platformId: issuer?.platformId ?? doc.platformId,
      userIds: [doc.uploadedById], type: "WARNING_LETTER_ACKNOWLEDGED", title: "Warning letter acknowledged",
      body: `${nameOf(me)} acknowledged receipt of: ${m?.title ?? "a warning letter"}.`, link: "/dashboard/employees", dedupeKey: `warning:${id}:ack`, data: { letterId: id },
    });
  }
  return { id, acknowledgedAt: at.toISOString() };
}
