"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { API_BASE, apiGet, getToken } from "@/lib/api";

// Shared by the Policies & induction screens: types as the API sends them, and a few small helpers.

export type Kind = "docx" | "pdf" | "image" | "other";
export type MyStatus = "PENDING" | "ACKNOWLEDGED" | "OPTIONAL" | "NOT_APPLICABLE";

export type ListItem = {
  id: string; category: string; isInduction: boolean; title: string; description: string | null; isMandatory: boolean;
  version: number; versionLabel: string; fileName: string; kind: Kind; publishedAt: string | null; effectiveDate: string | null;
  allowDownload: boolean; status: MyStatus; opened: boolean; acknowledgedAt: string | null;
};
export type Mine = { documents: ListItem[]; pendingMandatory: number };
export type History = { records: { policyId: string; title: string; category: string; versionLabel: string; acknowledgedAt: string }[] };

export type VersionRow = {
  id: string; number: number; label: string; status: "DRAFT" | "PUBLISHED" | "SUPERSEDED"; fileName: string; changeNote: string | null;
  requiresAck: boolean; createdBy: string | null; createdAt: string; publishedAt: string | null; acknowledged: number;
};
export type Note = { id: string; title: string; detail: string; status: "OPEN" | "RESOLVED" | "DISMISSED"; resolutionNote: string | null; resolvedAt: string | null };
export type HrDetail = {
  audience: { teamIds: string[]; employmentTypes: string[]; roles: string[]; everyone: boolean; size: number };
  counts: { required: number; acknowledged: number; pending: number };
  versions: VersionRow[]; pendingDraftVersion: boolean; notes: Note[]; openNotes: number;
};
export type Detail = {
  id: string; title: string; description: string | null; category: string; status: "DRAFT" | "PUBLISHED" | "ARCHIVED"; isMandatory: boolean;
  version: number; versionLabel: string; fileName: string; kind: Kind; publishedAt: string | null; effectiveDate: string | null; allowDownload: boolean;
  my: { applies: boolean; status: MyStatus; opened: boolean; acknowledgedAt: string | null; history: { versionLabel: string; acknowledgedAt: string }[] };
  hr?: HrDetail;
};

export type ManagedRow = {
  id: string; title: string; description: string | null; category: string; status: "DRAFT" | "PUBLISHED" | "ARCHIVED"; isMandatory: boolean;
  version: number; versionLabel: string; fileName: string; createdBy: string | null; publishedAt: string | null; effectiveDate: string | null;
  audienceLabel: string; audience: number; accepted: number; openNotes: number; hasPendingVersion: boolean;
};
export type Manage = {
  teams: { id: string; name: string }[]; categories: string[]; employmentTypes: string[]; roles: string[]; schemaReady: boolean;
  summary: { total: number; published: number; draft: number; archived: number; requiredPairs: number; completedPairs: number; pendingPairs: number; peopleWithPending: number };
  documents: ManagedRow[];
};
export type TrackRow = {
  userId: string; name: string; employeeCode: string | null; team: string | null; policyId: string; policyTitle: string; versionLabel: string;
  required: boolean; status: "ACKNOWLEDGED" | "OPENED" | "PENDING"; openedAt: string | null; acknowledgedAt: string | null; inAudience?: boolean; company?: string | null; companyId?: string;
};
export type Tracking = {
  companies?: { id: string; name: string }[];
  teams: { id: string; name: string }[]; policies: { id: string; title: string }[]; people: { id: string; name: string; employeeCode: string | null }[];
  summary: { total: number; acknowledged: number; opened: number; pending: number; completionPercent: number | null }; truncated: boolean; rows: TrackRow[];
};

// The company an owner HR/Admin chose to manage (null = their own). Only the manage / acknowledgments screens and a policy opened from
// them provide it; "Policies to read" never does, so an owner reads and confirms policies as themselves.
export const CompanyContext = createContext<string | null>(null);
export const useCompany = () => useContext(CompanyContext);
export const withCompany = (path: string, company: string | null) =>
  company ? `${path}${path.includes("?") ? "&" : "?"}company=${encodeURIComponent(company)}` : path;
export const linkTo = (path: string, company: string | null) => withCompany(path, company);

export const card = "rounded-2xl bg-white shadow-[var(--shadow-card)]";
export const field = "w-full rounded-xl border border-indigo-100 bg-white px-3 py-2.5 text-sm text-slate-700";

export const fmtDate = (s: string | null | undefined) =>
  s ? new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: s.length === 10 ? "UTC" : undefined }).format(new Date(s)) : "—";
export const fmtDateTime = (s: string | null | undefined) =>
  s ? new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: true }).format(new Date(s)) : "—";

export const STATUS_LABEL: Record<string, string> = {
  DRAFT: "Draft", PUBLISHED: "Published", ARCHIVED: "Archived", ACKNOWLEDGED: "Acknowledged", PENDING: "Pending acknowledgment", OPTIONAL: "Optional",
  OPENED: "Opened, not confirmed", SUPERSEDED: "Superseded",
};
export const STATUS_CHIP: Record<string, string> = {
  DRAFT: "bg-amber-50 text-amber-700", PUBLISHED: "bg-emerald-50 text-emerald-700", ARCHIVED: "bg-slate-100 text-slate-600",
  ACKNOWLEDGED: "bg-emerald-50 text-emerald-700", PENDING: "bg-amber-50 text-amber-700", OPTIONAL: "bg-slate-100 text-slate-600",
  OPENED: "bg-sky-50 text-sky-700", SUPERSEDED: "bg-slate-100 text-slate-500",
};

export const readFile = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error("Could not read that file"));
    r.readAsDataURL(file);
  });

// The file is private, so it is fetched with the login token and shown from memory.
export async function fetchBlobUrl(path: string): Promise<string> {
  const res = await fetch(`${API_BASE}${path}`, { headers: { Authorization: `Bearer ${getToken()}` } });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Could not open the file");
  return URL.createObjectURL(await res.blob());
}
export async function downloadFile(path: string, fileName: string) {
  const url = await fetchBlobUrl(path);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

// GET with a reload counter; keeps the last good data while a refresh is running.
export function useApi<T>(path: string | null, reload: number) {
  const [res, setRes] = useState<{ path: string; data?: T; error?: string } | null>(null);
  useEffect(() => {
    if (!path) return;
    let live = true;
    apiGet<T>(path)
      .then((data) => live && setRes({ path, data }))
      .catch((e: Error) => live && setRes((prev) => ({ path, data: prev?.data, error: e.message })));
    return () => {
      live = false;
    };
  }, [path, reload]);
  return { data: res?.data ?? null, error: res && res.path === path ? (res.error ?? "") : "" };
}

// While the live connection is up the page only re-checks every 5 minutes; while it is down, every 30 seconds.
export function useFallbackPoll(connected: boolean, bump: () => void) {
  useEffect(() => {
    let last = Date.now();
    const t = setInterval(() => {
      if (!connected || Date.now() - last > 5 * 60_000) {
        last = Date.now();
        bump();
      }
    }, 30_000);
    return () => clearInterval(t);
  }, [connected, bump]);
}
