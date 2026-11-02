// Employee profile photos: the pure rules (no database), so they can be tested on their own.

export const MAX_PHOTO_BYTES = 2 * 1024 * 1024; // 2 MB

export type PhotoType = { mime: "image/jpeg" | "image/png" | "image/webp" };

/** What the file REALLY is, from its first bytes (never from its name or the type the browser claimed). Only JPG, PNG and WebP are accepted. */
export function sniffImage(buf: Uint8Array): PhotoType["mime"] | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) return "image/png";
  if (buf.length >= 12 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return "image/webp";
  return null;
}

export type Access = { all: boolean; ids: string[] };
const inScope = (a: Access, platformId: string) => a.all || a.ids.includes(platformId);

/** Who may set, replace or remove a photo: HR or Admin, for people of the companies they may act on. Nobody else, not even for themselves. */
export const canChangePhoto = (viewer: { role: string; access: Access }, targetPlatformId: string) => (viewer.role === "HR" || viewer.role === "ADMIN") && inScope(viewer.access, targetPlatformId);

/** Who may see a photo: the person, anyone in the same company (a directory), and HR/Admin of the companies they may act on. */
export function canViewPhoto(viewer: { id: string; platformId: string; role: string; access: Access }, target: { id: string; platformId: string }): boolean {
  if (viewer.id === target.id) return true;
  if (viewer.platformId === target.platformId) return true;
  return (viewer.role === "HR" || viewer.role === "ADMIN") && inScope(viewer.access, target.platformId);
}
