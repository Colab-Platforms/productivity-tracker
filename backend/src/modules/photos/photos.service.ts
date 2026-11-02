import { prisma } from "../../lib/prisma.js";
import { accessFor } from "../../lib/companyAccess.js";
import { saveUpload, readStored, deleteStored } from "../../lib/storage.js";
import { auditNote } from "../../lib/auditContext.js";
import * as L from "./photos.logic.js";

// ---------------------------------------------------------------------------
// EMPLOYEE PROFILE PHOTOS
// The image is kept in the existing private file store (folder "photos"); user_photos only says which file is the current one. Photos are
// never served from a public address: the browser asks this module, which checks who is asking. Before the migration (no user_photos
// table) nobody has a photo and everything shows initials.
// ---------------------------------------------------------------------------

const isMissingTable = (e: unknown) => {
  const code = (e as { code?: unknown })?.code;
  const msg = e instanceof Error ? e.message : "";
  return code === "P2021" || (/user_photos/.test(msg) && /does not exist|relation/.test(msg));
};
let readyValue = false;
let readyCheckedAt = 0;
export async function photosReady(): Promise<boolean> {
  if (readyValue) return true;
  if (Date.now() - readyCheckedAt < 15_000) return false;
  readyCheckedAt = Date.now();
  try {
    await prisma.userPhoto.findFirst({ select: { userId: true } });
    readyValue = true;
  } catch (e) {
    if (!isMissingTable(e)) throw e;
    readyValue = false;
  }
  return readyValue;
}

/** userId -> when their photo was last set (ISO). People without a photo are not in the map. One batched read; empty before the migration. */
export async function photoStamps(userIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (userIds.length === 0 || !(await photosReady())) return out;
  const rows = await prisma.userPhoto.findMany({ where: { userId: { in: userIds } }, select: { userId: true, updatedAt: true } });
  for (const r of rows) out.set(r.userId, r.updatedAt.toISOString());
  return out;
}

async function viewerOf(id: string) {
  const u = await prisma.user.findUnique({ where: { id }, select: { id: true, role: true, platformId: true } });
  if (!u) throw new Error("NOT_FOUND");
  const a = await accessFor(id);
  return { id: u.id, role: String(u.role), platformId: u.platformId, access: { all: a.all, ids: a.ids } };
}

async function targetOf(id: string) {
  const t = await prisma.user.findUnique({ where: { id }, select: { id: true, platformId: true, firstName: true, lastName: true } });
  if (!t) throw new Error("NOT_FOUND");
  return t;
}

export async function setPhoto(viewerId: string, targetId: string, body: { data?: unknown; fileName?: unknown }) {
  if (!(await photosReady())) throw new Error("FEATURES_NOT_READY");
  const v = await viewerOf(viewerId);
  const t = await targetOf(targetId);
  // Someone who may not change it is told the person does not exist (so ids cannot be probed).
  if (!L.canChangePhoto(v, t.platformId)) throw new Error("NOT_FOUND");

  const raw = String(body.data ?? "");
  const b64 = /^data:[^;]+;base64,(.*)$/s.exec(raw)?.[1] ?? raw;
  if (!b64) throw new Error("PHOTO_REQUIRED");
  const buffer = Buffer.from(b64, "base64");
  if (buffer.length === 0) throw new Error("PHOTO_REQUIRED");
  if (buffer.length > L.MAX_PHOTO_BYTES) throw new Error("PHOTO_TOO_LARGE");
  const mime = L.sniffImage(buffer);
  if (!mime) throw new Error("PHOTO_BAD_TYPE"); // the real bytes decide, not the file name or the type the browser claimed

  const stored = await saveUpload({ platformId: t.platformId, folder: "photos", originalName: "profile-photo", data: buffer.toString("base64"), mimeType: mime });
  const before = await prisma.userPhoto.findUnique({ where: { userId: targetId }, select: { storageKey: true } });
  await prisma.userPhoto.upsert({
    where: { userId: targetId },
    update: { storageKey: stored.storageKey, mimeType: stored.mimeType, fileSize: stored.fileSize, updatedById: viewerId, updatedAt: new Date() },
    create: { userId: targetId, platformId: t.platformId, storageKey: stored.storageKey, mimeType: stored.mimeType, fileSize: stored.fileSize, updatedById: viewerId },
  });
  // The replaced image is deleted so nothing is left behind.
  if (before?.storageKey) await deleteStored(before.storageKey).catch(() => undefined);
  auditNote({ module: "Employees", action: "UPDATE", recordType: "User", recordId: targetId, targetUserId: targetId, summary: `${before ? "Replaced" : "Added"} the profile photo of ${t.firstName} ${t.lastName}`.trim() });
  return { ok: true, photoAt: new Date().toISOString() };
}

export async function removePhoto(viewerId: string, targetId: string) {
  if (!(await photosReady())) throw new Error("FEATURES_NOT_READY");
  const v = await viewerOf(viewerId);
  const t = await targetOf(targetId);
  if (!L.canChangePhoto(v, t.platformId)) throw new Error("NOT_FOUND");
  const row = await prisma.userPhoto.findUnique({ where: { userId: targetId }, select: { storageKey: true } });
  if (!row) return { ok: true };
  await prisma.userPhoto.delete({ where: { userId: targetId } });
  await deleteStored(row.storageKey).catch(() => undefined);
  auditNote({ module: "Employees", action: "UPDATE", recordType: "User", recordId: targetId, targetUserId: targetId, summary: `Removed the profile photo of ${t.firstName} ${t.lastName}`.trim() });
  return { ok: true };
}

export async function getPhoto(viewerId: string, targetId: string) {
  if (!(await photosReady())) throw new Error("NOT_FOUND");
  const v = await viewerOf(viewerId);
  const t = await targetOf(targetId);
  if (!L.canViewPhoto(v, t)) throw new Error("NOT_FOUND");
  const row = await prisma.userPhoto.findUnique({ where: { userId: targetId }, select: { storageKey: true, mimeType: true } });
  if (!row) throw new Error("NOT_FOUND");
  return { buffer: await readStored(row.storageKey), mimeType: row.mimeType };
}
