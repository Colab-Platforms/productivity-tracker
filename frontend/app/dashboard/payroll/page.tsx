// ===========================================================================
// PAYROLL — HR's monthly upload grid
//
// One month at a time, everyone listed, so a missing payslip is visible as a
// gap rather than something you have to go looking for.
//
// Nothing is visible to staff until it's released. Upload the whole month,
// check it, then release in one action.
// ===========================================================================

"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { API_BASE } from "@/lib/api";
import { useMe } from "../layout";

const API = API_BASE;

function token() {
  return typeof window === "undefined" ? "" : localStorage.getItem("token") ?? "";
}

async function call<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token()}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? "That didn't work");
  return data as T;
}

type Row = {
  userId: string;
  name: string;
  employeeCode: string | null;
  designation: string | null;
  slip: {
    id: string;
    fileName: string | null;
    fileSize: number | null;
    grossAmount: string | null;
    deductions: string | null;
    netAmount: string | null;
    publishedAt: string | null;
    uploadedBy: string;
  } | null;
};

type Payload = {
  month: number;
  year: number;
  label: string;
  rows: Row[];
  uploaded: number;
  published: number;
};

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function rupees(value: string | null) {
  if (!value) return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  return `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

export default function PayrollPage() {
  const me = useMe();
  const now = new Date();
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [year, setYear] = useState(now.getFullYear());
  const [data, setData] = useState<Payload | null>(null);
  const [net, setNet] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");

  const load = useCallback(async () => {
    try {
      setData(await call<Payload>(`/payroll/month?month=${month}&year=${year}`));
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the month");
    }
  }, [month, year]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  async function upload(row: Row, file: File) {
    if (file.size > 10 * 1024 * 1024) {
      setError("That file is over the 10 MB limit.");
      return;
    }
    setBusyId(row.userId);
    setError("");
    try {
      const dataUrl: string = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error("Could not read that file"));
        reader.readAsDataURL(file);
      });

      const res = await call<{ replaced: boolean }>("/payroll/upload", "POST", {
        userId: row.userId,
        month,
        year,
        netAmount: net[row.userId] || undefined,
        fileName: file.name,
        data: dataUrl,
        mimeType: file.type,
      });

      setToast(
        res.replaced
          ? `${row.name}'s payslip replaced — it's back to unreleased.`
          : `${row.name}'s payslip uploaded.`
      );
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not upload that");
    } finally {
      setBusyId(null);
    }
  }

  async function releaseMonth() {
    setBusyId("month");
    try {
      const res = await call<{ updated: number }>("/payroll/publish-month", "POST", {
        month,
        year,
      });
      setToast(`${res.updated} payslip${res.updated === 1 ? "" : "s"} released.`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not release the month");
    } finally {
      setBusyId(null);
    }
  }

  async function toggle(row: Row) {
    if (!row.slip) return;
    setBusyId(row.userId);
    try {
      await call("/payroll/publish", "POST", {
        slipIds: [row.slip.id],
        publish: !row.slip.publishedAt,
      });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not change that");
    } finally {
      setBusyId(null);
    }
  }

  async function remove(row: Row) {
    if (!row.slip) return;
    setBusyId(row.userId);
    try {
      await call(`/payroll/${row.slip.id}`, "DELETE");
      setToast(`${row.name}'s payslip removed.`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not remove it");
    } finally {
      setBusyId(null);
    }
  }

  const allowed = ["HR", "ADMIN"].includes(me?.role ?? "");

  if (me && !allowed) {
    return (
      <div>
        <div className="rounded-2xl bg-white shadow-[var(--shadow-card)] p-8 text-center text-sm text-slate-600">
          Payroll is limited to HR and administrators.
        </div>
      </div>
    );
  }

  const pending = data ? data.uploaded - data.published : 0;

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Payroll</h1>
          <p className="mt-1 text-sm text-slate-500">
            Upload the month, check it, then release. Nobody sees a payslip before you
            release it.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Link
            href="/dashboard/payroll/approve"
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:border-slate-900"
          >
            Generate &amp; approve
          </Link>
          <select
            value={month}
            onChange={(e) => setMonth(Number(e.target.value))}
            className="rounded-xl border border-indigo-200 px-3 py-2 text-sm"
          >
            {MONTHS.map((m, i) => (
              <option key={m} value={i + 1}>
                {m}
              </option>
            ))}
          </select>
          <select
            value={year}
            onChange={(e) => setYear(Number(e.target.value))}
            className="rounded-xl border border-indigo-200 px-3 py-2 text-sm"
          >
            {[0, 1, 2].map((offset) => {
              const y = now.getFullYear() - offset;
              return (
                <option key={y} value={y}>
                  {y}
                </option>
              );
            })}
          </select>
        </div>
      </header>

      {data && (
        <div className="flex flex-wrap items-center gap-4 rounded-2xl bg-white shadow-[var(--shadow-card)] px-5 py-4">
          <p className="text-sm text-slate-700">
            <span className="font-medium">{data.label}</span>
            <span className="ml-3 text-slate-500">
              {data.uploaded} of {data.rows.length} uploaded · {data.published} released
            </span>
          </p>

          {pending > 0 && (
            <button
              onClick={releaseMonth}
              disabled={busyId === "month"}
              className="ml-auto rounded-xl bg-indigo-600 px-5 py-2 text-sm font-medium text-white transition hover:bg-indigo-700 disabled:opacity-40"
            >
              {busyId === "month" ? "Releasing…" : `Release ${pending} payslip${pending === 1 ? "" : "s"}`}
            </button>
          )}
        </div>
      )}

      {error && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
          {error}
        </div>
      )}
      {toast && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          {toast}
        </div>
      )}

      <section className="overflow-hidden rounded-2xl bg-white shadow-[var(--shadow-card)]">
        <ul className="divide-y divide-indigo-50">
          {data?.rows.map((row) => (
            <PayrollRow
              key={row.userId}
              row={row}
              busy={busyId === row.userId}
              net={net[row.userId] ?? ""}
              onNet={(v) => setNet((s) => ({ ...s, [row.userId]: v }))}
              onFile={(file) => upload(row, file)}
              onToggle={() => toggle(row)}
              onRemove={() => remove(row)}
            />
          ))}
        </ul>
      </section>
    </div>
  );
}

function PayrollRow({
  row,
  busy,
  net,
  onNet,
  onFile,
  onToggle,
  onRemove,
}: {
  row: Row;
  busy: boolean;
  net: string;
  onNet: (v: string) => void;
  onFile: (file: File) => void;
  onToggle: () => void;
  onRemove: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const slip = row.slip;

  return (
    <li className="flex flex-wrap items-center gap-3 px-5 py-3.5">
      <div
        className={`h-2 w-2 shrink-0 rounded-full ${
          slip?.publishedAt ? "bg-emerald-500" : slip ? "bg-amber-400" : "bg-indigo-100"
        }`}
      />

      <div className="min-w-48 flex-1">
        <p className="text-sm font-medium text-slate-900">{row.name}</p>
        <p className="mt-0.5 text-xs text-slate-400">
          {row.employeeCode}
          {row.designation ? ` · ${row.designation}` : ""}
        </p>
      </div>

      {slip ? (
        <>
          <div className="min-w-24">
            <p className="text-xs text-slate-400">Net</p>
            <p className="tabular-nums text-sm text-slate-900">{rupees(slip.netAmount)}</p>
          </div>

          <span
            className={`shrink-0 rounded-md px-2 py-0.5 text-xs font-medium ${
              slip.publishedAt
                ? "bg-emerald-50 text-emerald-700"
                : "bg-amber-50 text-amber-700"
            }`}
          >
            {slip.publishedAt ? "released" : "not released"}
          </span>

          <button
            onClick={onToggle}
            disabled={busy}
            className="shrink-0 rounded-xl border border-indigo-200 px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:border-indigo-600 disabled:opacity-40"
          >
            {slip.publishedAt ? "Unrelease" : "Release"}
          </button>

          <button
            onClick={() => inputRef.current?.click()}
            disabled={busy}
            className="shrink-0 text-xs text-slate-400 transition hover:text-slate-900 disabled:opacity-40"
          >
            Replace
          </button>

          <button
            onClick={onRemove}
            disabled={busy}
            className="shrink-0 text-xs text-slate-300 transition hover:text-rose-600 disabled:opacity-40"
          >
            Remove
          </button>
        </>
      ) : (
        <>
          <input
            value={net}
            onChange={(e) => onNet(e.target.value)}
            placeholder="Net ₹ (optional)"
            className="w-36 shrink-0 rounded-xl border border-indigo-200 px-3 py-1.5 text-sm outline-none placeholder:text-slate-400 focus:border-indigo-500"
          />
          <button
            onClick={() => inputRef.current?.click()}
            disabled={busy}
            className="shrink-0 rounded-xl bg-indigo-600 px-4 py-1.5 text-xs font-medium text-white transition hover:bg-indigo-700 disabled:opacity-40"
          >
            {busy ? "Uploading…" : "Upload PDF"}
          </button>
        </>
      )}

      <input
        ref={inputRef}
        type="file"
        accept=".pdf"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onFile(file);
          e.target.value = "";
        }}
      />
    </li>
  );
}