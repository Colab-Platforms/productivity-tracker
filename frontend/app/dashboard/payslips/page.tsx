// ===========================================================================
// MY PAYSLIPS
//
// One row per month, newest first. A month HR hasn't released simply isn't
// here — there is no "pending" state to explain, because an unreleased
// payslip is not yet a fact.
//
// The file is fetched with the auth header and opened from a blob, never
// linked to directly. A payslip URL that works without a token is a payslip
// anyone can read.
// ===========================================================================

"use client";

import { useCallback, useEffect, useState } from "react";
import { API_BASE } from "@/lib/api";
import { useRoleGate } from "../_routing/useRoleGate";

const API = API_BASE;

function token() {
  return typeof window === "undefined" ? "" : localStorage.getItem("token") ?? "";
}

async function call<T>(path: string): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${token()}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? "That didn't work");
  return data as T;
}

type Slip = {
  id: string;
  month: number;
  year: number;
  label: string;
  grossAmount: string | null;
  deductions: string | null;
  netAmount: string | null;
  fileName: string | null;
  fileSize: number | null;
  publishedAt: string | null;
};

type Payload = { years: number[]; slips: Slip[] };

function rupees(value: string | null) {
  if (!value) return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  return `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

function Payslips() {
  const [data, setData] = useState<Payload | null>(null);
  const [year, setYear] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [opening, setOpening] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const query = year ? `?year=${year}` : "";
      const payload = await call<Payload>(`/payroll/me${query}`);
      setData(payload);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load your payslips");
    }
  }, [year]);

  useEffect(() => {
    void load();
  }, [load]);

  async function open(slip: Slip) {
    setOpening(slip.id);
    setError("");
    try {
      const res = await fetch(`${API}/payroll/${slip.id}/download`, {
        headers: { Authorization: `Bearer ${token()}` },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? "Could not open it");
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank", "noopener");
      // Give the new tab a moment to take the URL before releasing it.
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not open it");
    } finally {
      setOpening(null);
    }
  }

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
            My payslips
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            Only you and HR can see these.
          </p>
        </div>

        {data && data.years.length > 1 && (
          <div className="inline-flex rounded-xl border border-indigo-100 bg-[#F3F7F6] p-0.5">
            {data.years.map((y) => (
              <button
                key={y}
                onClick={() => setYear(y)}
                className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
                  (year ?? data.years[0]) === y
                    ? "bg-white text-slate-900 shadow-sm"
                    : "text-slate-500 hover:text-slate-800"
                }`}
              >
                {y}
              </button>
            ))}
          </div>
        )}
      </header>

      {error && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
          {error}
        </div>
      )}

      <section className="overflow-hidden rounded-2xl bg-white shadow-[var(--shadow-card)]">
        <ul className="divide-y divide-indigo-50">
          {data?.slips.map((slip) => (
            <li
              key={slip.id}
              className="flex flex-wrap items-center gap-4 px-5 py-4 transition hover:bg-indigo-50/60/70"
            >
              <div className="min-w-32">
                <p className="text-sm font-medium text-slate-900">{slip.label}</p>
                <p className="mt-0.5 text-xs text-slate-400">
                  released{" "}
                  {slip.publishedAt
                    ? new Date(slip.publishedAt).toLocaleDateString("en-IN", {
                        day: "numeric",
                        month: "short",
                      })
                    : "—"}
                </p>
              </div>

              <div className="flex flex-1 flex-wrap gap-6 text-sm">
                <Amount label="Gross" value={slip.grossAmount} />
                <Amount label="Deductions" value={slip.deductions} />
                <Amount label="Net" value={slip.netAmount} strong />
              </div>

              <button
                onClick={() => open(slip)}
                disabled={opening === slip.id}
                className="shrink-0 rounded-xl border border-indigo-200 px-4 py-2 text-sm font-medium text-slate-700 transition hover:border-indigo-600 hover:text-slate-900 disabled:opacity-40"
              >
                {opening === slip.id ? "Opening…" : "Open PDF"}
              </button>
            </li>
          ))}

          {data?.slips.length === 0 && (
            <li className="px-5 py-14 text-center">
              <p className="text-sm text-slate-500">No payslips yet.</p>
              <p className="mt-1 text-xs text-slate-400">
                They appear here once HR releases the month.
              </p>
            </li>
          )}
        </ul>
      </section>
    </div>
  );
}

function Amount({
  label,
  value,
  strong,
}: {
  label: string;
  value: string | null;
  strong?: boolean;
}) {
  return (
    <div>
      <p className="text-xs text-slate-400">{label}</p>
      <p
        className={`tabular-nums ${
          strong ? "font-semibold text-slate-900" : "text-slate-600"
        }`}
      >
        {rupees(value)}
      </p>
    </div>
  );
}

// Admins are senior management and have no payslips of their own: anyone who opens this address as an Admin is sent to their own home.
export default function PayslipsPage() {
  const { allowed } = useRoleGate(["EMPLOYEE", "MANAGER", "HR"]);
  return allowed ? <Payslips /> : null;
}
