"use client";

import { useEffect, useState } from "react";
import { API_BASE, apiPost, getToken } from "@/lib/api";

// ---------------------------------------------------------------------------
// AVATAR + PHOTO EDITOR
// Shows a person's profile photo when they have one and their initials otherwise. Photos are private: they are fetched with the sign-in
// token and shown from memory (never from a public address). `photoAt` (when the photo was last set) comes with the person from the
// server; no photoAt means no photo, so no request is made and the initials show straight away.
// ---------------------------------------------------------------------------

export function initialsOf(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("");
}

// One download per photo per page load, shared by every place the same person appears.
const cache = new Map<string, Promise<string | null>>();
function load(userId: string, photoAt: string): Promise<string | null> {
  const key = `${userId}|${photoAt}`;
  let p = cache.get(key);
  if (!p) {
    p = fetch(`${API_BASE}/photos/${userId}`, { headers: { Authorization: `Bearer ${getToken()}` } })
      .then(async (r) => (r.ok ? URL.createObjectURL(await r.blob()) : null))
      .catch(() => null);
    cache.set(key, p);
  }
  return p;
}
export function forgetPhoto(userId: string) {
  for (const k of [...cache.keys()]) if (k.startsWith(`${userId}|`)) cache.delete(k);
}

export default function Avatar({ userId, name, photoAt, size = 36, shape = "circle", className = "", fallbackClass = "bg-indigo-100 text-indigo-700" }: {
  userId: string; name: string; photoAt?: string | null; size?: number; shape?: "circle" | "rounded"; className?: string; fallbackClass?: string;
}) {
  const [shown, setShown] = useState<{ key: string; url: string | null } | null>(null);
  const key = photoAt ? `${userId}|${photoAt}` : "";
  useEffect(() => {
    if (!photoAt) return;
    let live = true;
    void load(userId, photoAt).then((url) => live && setShown({ key: `${userId}|${photoAt}`, url }));
    return () => {
      live = false;
    };
  }, [userId, photoAt]);

  const url = key && shown?.key === key ? shown.url : null;
  const radius = shape === "circle" ? "rounded-full" : "rounded-2xl";
  const box = { width: size, height: size, fontSize: Math.max(10, Math.round(size * 0.34)) };
  if (url) {
    // A blob: address from memory, which the Next image optimiser cannot fetch.
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={url} alt={name} style={box} className={`shrink-0 object-cover ${radius} ${className}`} />;
  }
  return (
    <span style={box} className={`flex shrink-0 items-center justify-center font-semibold ${radius} ${fallbackClass} ${className}`} aria-label={name}>
      {initialsOf(name)}
    </span>
  );
}

// --- choosing a photo: shrink it in the browser first (a phone photo is several MB), then the server checks it again --------------------

export async function prepareImage(file: File): Promise<string> {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) throw new Error("Use a JPG, PNG or WebP photo.");
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) throw new Error("That image could not be read.");
  const MAX = 512;
  const scale = Math.min(1, MAX / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("That image could not be read.");
  ctx.drawImage(bitmap, 0, 0, w, h);
  const out = canvas.toDataURL("image/jpeg", 0.9);
  if (out.length > 2.6 * 1024 * 1024) throw new Error("That photo is too large (2 MB maximum).");
  return out;
}

async function send(method: "POST" | "DELETE", userId: string, data?: string) {
  if (method === "POST") return apiPost(`/photos/${userId}`, { data });
  const res = await fetch(`${API_BASE}/photos/${userId}`, { method: "DELETE", headers: { Authorization: `Bearer ${getToken()}` } });
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? "Could not remove the photo.");
}

/** Upload / replace / remove, for a person who already exists. */
export function PhotoEditor({ userId, name, photoAt, onChanged, size = 72 }: { userId: string; name: string; photoAt?: string | null; onChanged: (photoAt: string | null) => void; size?: number }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function pick(file: File | undefined) {
    if (!file || busy) return;
    setBusy(true);
    setError("");
    try {
      await send("POST", userId, await prepareImage(file));
      forgetPhoto(userId);
      onChanged(new Date().toISOString());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await send("DELETE", userId);
      forgetPhoto(userId);
      onChanged(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div>
      <div className="flex items-center gap-4">
        <Avatar userId={userId} name={name} photoAt={photoAt} size={size} />
        <div className="flex flex-wrap gap-2">
          <label className={`cursor-pointer rounded-xl border border-indigo-200 px-3.5 py-1.5 text-sm font-medium text-indigo-700 hover:bg-indigo-50 ${busy ? "pointer-events-none opacity-60" : ""}`}>
            {busy ? "Saving…" : photoAt ? "Change photo" : "Upload photo"}
            <input type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ""; }} />
          </label>
          {photoAt && <button type="button" onClick={remove} disabled={busy} className="rounded-xl px-3 py-1.5 text-sm font-medium text-rose-600 hover:bg-rose-50 disabled:opacity-60">Remove</button>}
        </div>
      </div>
      <p className="mt-1.5 text-xs text-slate-400">JPG, PNG or WebP. It is shrunk automatically.</p>
      {error && <p className="mt-2 rounded-lg bg-red-50 px-3 py-1.5 text-sm text-red-700">{error}</p>}
    </div>
  );
}

/** For the Add Employee form: pick a photo now, save it after the person has been created. */
export function PendingPhotoPicker({ file, onFile }: { file: File | null; onFile: (f: File | null) => void }) {
  const [preview, setPreview] = useState<string | null>(null);
  useEffect(() => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  return (
    <div className="flex items-center gap-4">
      {file && preview ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={preview} alt="Chosen photo" className="h-[72px] w-[72px] rounded-full object-cover" />
      ) : (
        <span className="flex h-[72px] w-[72px] items-center justify-center rounded-full bg-indigo-100 text-xs text-indigo-700">No photo</span>
      )}
      <div className="flex flex-wrap gap-2">
        <label className="cursor-pointer rounded-xl border border-indigo-200 px-3.5 py-1.5 text-sm font-medium text-indigo-700 hover:bg-indigo-50">
          {file ? "Change photo" : "Upload photo"}
          <input type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={(e) => { onFile(e.target.files?.[0] ?? null); e.target.value = ""; }} />
        </label>
        {file && <button type="button" onClick={() => onFile(null)} className="rounded-xl px-3 py-1.5 text-sm font-medium text-rose-600 hover:bg-rose-50">Remove</button>}
      </div>
    </div>
  );
}

/** Save a photo chosen in the Add form once the person exists. Never throws: the person is already created. */
export async function savePendingPhoto(userId: string | null | undefined, file: File | null): Promise<string | null> {
  if (!userId || !file) return null;
  try {
    await send("POST", userId, await prepareImage(file));
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}
