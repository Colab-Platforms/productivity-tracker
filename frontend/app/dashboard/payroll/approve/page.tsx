// ===========================================================================
// PAYROLL APPROVAL — generate, check, approve, release
//
// The four steps in the order HR does them:
//   1. Generate  - drafts are worked out from attendance. Safe to re-run.
//   2. Review    - each draft beside the attendance it came from. A manual
//                  deduction needs a reason.
//   3. Approve   - HR vouches for the figures.
//   4. Release   - only then does an employee see it.
//
// A generated payslip cannot be released before it is approved - the server
// enforces that, this screen just makes the order obvious.
// ===========================================================================

"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { API_BASE } from "@/lib/api";
import { todayIso } from "@/lib/time";
import { useMe } from "../../layout";

const API = API_BASE;

function token() {
  return typeof window === "undefined" ? "" : localStorage.getItem("token") ?? "";
}

async function call<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token()}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(friendly((data as { error?: string }).error));
  return data as T;
}

// The API answers with codes. People get sentences.
function friendly(code?: string) {
  const map: Record<string, string> = {
    NOT_DRAFT: "That payslip is already approved, so it can no longer be changed.",
    NOTE_REQUIRED: "A deduction needs a reason.",
    BAD_AMOUNT: "Enter a valid amount.",
    NOTHING_TO_APPROVE: "There is nothing left to approve.",
    NOT_YOUR_COMPANY: "That payslip or department belongs to another company.",
    BAD_TEAMS: "The department selection is not valid.",
  };
  return (code && map[code]) || "That didn't work. Please try again.";
}

type Row = {
  userId: string;
  name: string;
  employeeCode: string | null;
  designation: string | null;
  slip: {
    id: string;
    status: string;
    payableDays: number | null;
    otherDeduction: number | null;
    hasFile: boolean;
    netAmount: string | null;
    publishedAt: string | null;
  } | null;
};

type Month = { label: string; rows: Row[] };

type Generated = {
  warning: string | null;
  created: number;
  updated: number;
  skipped: { userId: string; name: string; employeeCode: string | null; reason: string }[];
};

type Review = {
  slip: {
    status: string;
    grossAmount: number | null;
    lossOfPay: number | null;
    otherDeduction: number;
    otherDeductionNote: string | null;
    netAmount: number | null;
    payableDays: number | null;
    daysInMonth: number | null;
  };
  attendance: {
    totals: {
      presentDays: number;
      halfDays: number;
      leaveDays: number;
      holidays: number;
      weekOffs: number;
      lossOfPayDays: number;
      notEmployedDays: number;
      notTrackedDays: number;
      payableDays: number;
    };
  };
  stale: boolean;
  staleMessage: string | null;
};

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const rupees = (v: string | number | null) => {
  if (v === null || v === "") return "—";
  const n = Number(v);
  return Number.isFinite(n)
    ? `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`
    : String(v);
};

// One word for where a slip stands. An uploaded PDF is HR's own file and has
// no approval step, so it is shown as "uploaded".
function stage(slip: NonNullable<Row["slip"]>) {
  if (slip.publishedAt) return { label: "Released", tone: "bg-emerald-50 text-emerald-700" };
  if (slip.hasFile) return { label: "Uploaded", tone: "bg-slate-100 text-slate-600" };
  if (slip.status === "APPROVED") return { label: "Approved", tone: "bg-sky-50 text-sky-700" };
  return { label: "Draft", tone: "bg-amber-50 text-amber-700" };
}

export default function PayrollApprovePage() {
  const me = useMe();
  const today = todayIso();
  const [month, setMonth] = useState(Number(today.slice(5, 7)));
  const [year, setYear] = useState(Number(today.slice(0, 4)));
  const [data, setData] = useState<Month | null>(null);
  const [gen, setGen] = useState<Generated | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [teams, setTeams] = useState<{ id: string; name: string }[]>([]);
  const [teamIds, setTeamIds] = useState<string[]>([]); // empty = all departments

  useEffect(() => {
    call<{ id: string; name: string }[]>("/payroll/teams")
      .then(setTeams)
      .catch(() => setTeams([]));
  }, []);

  const load = useCallback(async () => {
    try {
      setData(await call<Month>(`/payroll/month?month=${month}&year=${year}`));
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the month");
    }
  }, [month, year]);

  useEffect(() => {
    setOpen(null);
    setGen(null);
    void load();
  }, [load]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  async function run<T>(key: string, fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(key);
    setError("");
    try {
      return await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't work");
    } finally {
      setBusy(null);
    }
  }

  async function generate() {
    const r = await run("generate", () =>
      call<Generated>("/payroll/generate", "POST", { month, year, teamIds }),
    );
    if (!r) return;
    setGen(r);
    setToast(`${r.created} created, ${r.updated} refreshed.`);
    await load();
  }

  async function unrelease() {
    const scope = teamIds.length
      ? `the ${teamIds.length} selected department${teamIds.length === 1 ? "" : "s"}`
      : "all departments";
    if (
      !window.confirm(
        `Take back the released salary slips for ${MONTHS[month - 1]} ${year} (${scope})? ` +
          "Employees will no longer see them and their notification is removed. You can send them again afterwards.",
      )
    )
      return;
    const r = await run("unrelease", () =>
      call<{ unreleased: number }>("/payroll/unrelease", "POST", { month, year, teamIds }),
    );
    if (!r) return;
    setToast(`${r.unreleased} slip${r.unreleased === 1 ? "" : "s"} taken back.`);
    await load();
  }

  // One confirm: approve every draft in scope, release, tell each employee.
  async function approveAndSend() {
    const scope = teamIds.length
      ? `the ${teamIds.length} selected department${teamIds.length === 1 ? "" : "s"}`
      : "all departments";
    const n = gen ? gen.created + gen.updated : 0;
    if (
      !window.confirm(
        `Approve and send salary slips for ${MONTHS[month - 1]} ${year} to ${scope}?` +
          (n ? ` ${n} slip${n === 1 ? "" : "s"} were just generated.` : "") +
          " Employees will be notified and can see their slip immediately.",
      )
    )
      return;
    const r = await run("send", () =>
      call<{ approved: number; published: number }>("/payroll/release", "POST", {
        month,
        year,
        teamIds,
      }),
    );
    if (!r) return;
    setToast(`${r.approved} approved, ${r.published} sent to employees.`);
    await load();
  }

  async function approve(ids: string[]) {
    const r = await run("approve", () =>
      call<{ approved: number }>("/payroll/approve", "POST", { slipIds: ids }),
    );
    if (!r) return;
    setToast(`${r.approved} payslip${r.approved === 1 ? "" : "s"} approved.`);
    await load();
  }

  async function release() {
    const r = await run("release", () =>
      call<{ updated: number; waitingForApproval: number }>("/payroll/publish-month", "POST", {
        month,
        year,
      }),
    );
    if (!r) return;
    setToast(
      `${r.updated} released.` +
        (r.waitingForApproval ? ` ${r.waitingForApproval} still waiting for approval.` : ""),
    );
    await load();
  }

  // The PDF needs the login token, so a plain link cannot open it. A blank tab
  // is opened first, in the click, so the browser does not block it.
  async function preview(id: string) {
    const tab = window.open("", "_blank");
    try {
      const res = await fetch(`${API}/payroll/${id}/payslip.pdf`, {
        headers: { Authorization: `Bearer ${token()}` },
      });
      if (!res.ok) throw new Error();
      const url = URL.createObjectURL(await res.blob());
      if (tab) tab.location.href = url;
    } catch {
      tab?.close();
      setError("Could not open the payslip.");
    }
  }

  if (me && !["HR", "ADMIN"].includes(me.role)) {
    return (
      <div>
        <div className="rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-600">
          Payroll is limited to HR and administrators.
        </div>
      </div>
    );
  }

  const slips = (data?.rows ?? []).filter((r) => r.slip);
  const generated = slips.filter((r) => !r.slip!.hasFile);
  const drafts = generated.filter((r) => r.slip!.status !== "APPROVED");
  const approvedWaiting = generated.filter(
    (r) => r.slip!.status === "APPROVED" && !r.slip!.publishedAt,
  );
  const released = slips.filter((r) => r.slip!.publishedAt).length;

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Link href="/dashboard/payroll" className="text-xs text-slate-400 hover:text-slate-900">
            ← Payroll
          </Link>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-slate-900">
            Approve payroll
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            Generate from attendance, check each payslip, approve, then release.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={month}
            onChange={(e) => setMonth(Number(e.target.value))}
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
          >
            {MONTHS.map((m, i) => (
              <option key={m} value={i + 1}>{m}</option>
            ))}
          </select>
          <select
            value={year}
            onChange={(e) => setYear(Number(e.target.value))}
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
          >
            {[0, 1, 2].map((o) => {
              const y = Number(today.slice(0, 4)) - o;
              return <option key={y} value={y}>{y}</option>;
            })}
          </select>
        </div>
      </header>

      <section className="rounded-2xl bg-white p-5 shadow-[var(--shadow-card)]">
        <p className="text-sm font-medium text-slate-900">Departments</p>
        <p className="mt-0.5 text-xs text-slate-500">
          Pick departments, or leave all unticked for everyone. Generate, check the list, then send.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {teams.map((t) => {
            const on = teamIds.includes(t.id);
            return (
              <button
                key={t.id}
                onClick={() =>
                  setTeamIds((cur) => (on ? cur.filter((x) => x !== t.id) : [...cur, t.id]))
                }
                className={`rounded-xl border px-3 py-1.5 text-xs font-medium ${
                  on
                    ? "border-indigo-600 bg-indigo-600 text-white"
                    : "border-indigo-100 text-slate-700 hover:border-indigo-600"
                }`}
              >
                {t.name}
              </button>
            );
          })}
          {teams.length === 0 && <span className="text-xs text-slate-400">No departments found.</span>}
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            onClick={generate}
            disabled={busy !== null}
            className="rounded-xl bg-indigo-600 px-4 py-2 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-40"
          >
            {busy === "generate" ? "Generating…" : "Generate slips"}
          </button>
          <button
            onClick={approveAndSend}
            disabled={busy !== null || !gen}
            className="rounded-xl bg-indigo-600 px-4 py-2 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-40"
          >
            {busy === "send" ? "Sending…" : "Approve & send"}
          </button>
          <button
            onClick={unrelease}
            disabled={busy !== null || released === 0}
            className="rounded-xl border border-indigo-100 px-4 py-2 text-xs font-medium text-slate-700 hover:border-indigo-600 disabled:opacity-40"
          >
            {busy === "unrelease" ? "Taking back…" : "Unrelease"}
          </button>
        </div>
      </section>

      <div className="grid gap-3 sm:grid-cols-3">
        <Step
          n={1}
          title="Generate"
          note="Works out every draft from attendance. Safe to run again."
          action={
            <button
              onClick={generate}
              disabled={busy !== null}
              className="rounded-lg bg-slate-900 px-4 py-2 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-40"
            >
              {busy === "generate" ? "Generating…" : generated.length ? "Refresh drafts" : "Generate drafts"}
            </button>
          }
        />
        <Step
          n={2}
          title="Approve"
          note={`${drafts.length} draft${drafts.length === 1 ? "" : "s"} waiting. Open a row to check it first.`}
          action={
            <button
              onClick={() => {
                if (window.confirm(`Approve ${drafts.length} draft(s) without opening each one?`))
                  void approve(drafts.map((r) => r.slip!.id));
              }}
              disabled={busy !== null || drafts.length === 0}
              className="rounded-lg bg-slate-900 px-4 py-2 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-40"
            >
              Approve all drafts
            </button>
          }
        />
        <Step
          n={3}
          title="Release"
          note={`${approvedWaiting.length} approved, ${released} already released.`}
          action={
            <button
              onClick={release}
              disabled={busy !== null || approvedWaiting.length === 0}
              className="rounded-lg bg-slate-900 px-4 py-2 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-40"
            >
              {busy === "release" ? "Releasing…" : "Release approved"}
            </button>
          }
        />
      </div>

      {gen?.warning && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          {gen.warning}
        </div>
      )}
      {gen && gen.skipped.length > 0 && (
        <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600">
          <p className="font-medium text-slate-800">Not generated</p>
          <ul className="mt-1 space-y-0.5">
            {gen.skipped.map((s) => (
              <li key={s.userId}>
                {s.name}
                {s.employeeCode ? ` (${s.employeeCode})` : ""} — {s.reason}
              </li>
            ))}
          </ul>
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

      <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
        {slips.length === 0 ? (
          <p className="px-5 py-10 text-center text-sm text-slate-500">
            No payslips for {data?.label ?? "this month"} yet. Press Generate drafts.
          </p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {slips.map((r) => {
              const slip = r.slip!;
              const st = stage(slip);
              const isOpen = open === slip.id;
              return (
                <li key={r.userId}>
                  <div className="flex flex-wrap items-center gap-3 px-5 py-3.5">
                    <div className="min-w-48 flex-1">
                      <p className="text-sm font-medium text-slate-900">{r.name}</p>
                      <p className="mt-0.5 text-xs text-slate-400">
                        {r.employeeCode}
                        {r.designation ? ` · ${r.designation}` : ""}
                      </p>
                    </div>
                    <div className="min-w-20">
                      <p className="text-xs text-slate-400">Payable days</p>
                      <p className="tabular-nums text-sm text-slate-900">{slip.payableDays ?? "—"}</p>
                    </div>
                    <div className="min-w-24">
                      <p className="text-xs text-slate-400">Net</p>
                      <p className="tabular-nums text-sm text-slate-900">{rupees(slip.netAmount)}</p>
                    </div>
                    <span className={`shrink-0 rounded-md px-2 py-0.5 text-xs font-medium ${st.tone}`}>
                      {st.label}
                    </span>
                    <button
                      onClick={() => preview(slip.id)}
                      className="shrink-0 text-xs text-slate-500 hover:text-slate-900"
                    >
                      PDF
                    </button>
                    {!slip.hasFile && (
                      <button
                        onClick={() => setOpen(isOpen ? null : slip.id)}
                        className="shrink-0 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:border-slate-900"
                      >
                        {isOpen ? "Close" : slip.status === "APPROVED" ? "View" : "Review"}
                      </button>
                    )}
                  </div>
                  {isOpen && (
                    <ReviewPanel
                      slipId={slip.id}
                      onChanged={load}
                      onApprove={() => approve([slip.id])}
                      busy={busy !== null}
                    />
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

function Step({
  n,
  title,
  note,
  action,
}: {
  n: number;
  title: string;
  note: string;
  action: React.ReactNode;
}) {
  return (
    <div className="flex flex-col justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-4">
      <div>
        <p className="text-xs font-medium text-slate-400">Step {n}</p>
        <p className="mt-0.5 text-sm font-semibold text-slate-900">{title}</p>
        <p className="mt-1 text-xs text-slate-500">{note}</p>
      </div>
      <div>{action}</div>
    </div>
  );
}

function ReviewPanel({
  slipId,
  onChanged,
  onApprove,
  busy,
}: {
  slipId: string;
  onChanged: () => Promise<void>;
  onApprove: () => void;
  busy: boolean;
}) {
  const [r, setR] = useState<Review | null>(null);
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await call<Review>(`/payroll/${slipId}/review`);
      setR(res);
      setAmount(res.slip.otherDeduction ? String(res.slip.otherDeduction) : "");
      setNote(res.slip.otherDeductionNote ?? "");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the review");
    }
  }, [slipId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function saveDeduction() {
    setSaving(true);
    setError("");
    try {
      await call(`/payroll/${slipId}/deduction`, "POST", {
        amount: amount === "" ? 0 : Number(amount),
        note,
      });
      await load();
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save that");
    } finally {
      setSaving(false);
    }
  }

  if (!r) {
    return (
      <div className="bg-slate-50 px-5 py-4 text-sm text-slate-500">
        {error || "Loading…"}
      </div>
    );
  }

  const t = r.attendance.totals;
  const isDraft = r.slip.status === "DRAFT";
  const lines: [string, number][] = [
    ["Present", t.presentDays],
    ["Half days", t.halfDays],
    ["Leave", t.leaveDays],
    ["Holidays and week-offs", t.holidays + t.weekOffs],
    ["Absent / half-day loss", t.lossOfPayDays],
    ["Before joining", t.notEmployedDays],
    ["Not tracked (paid)", t.notTrackedDays],
  ];

  return (
    <div className="space-y-4 bg-slate-50 px-5 py-4">
      {r.stale && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          {r.staleMessage} Use “Refresh drafts” above, then review again.
        </div>
      )}

      <div className="grid gap-6 sm:grid-cols-2">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
            Attendance this month
          </p>
          <dl className="mt-2 space-y-1 text-sm">
            {lines.map(([label, v]) => (
              <div key={label} className="flex justify-between">
                <dt className="text-slate-500">{label}</dt>
                <dd className="tabular-nums text-slate-900">{v}</dd>
              </div>
            ))}
            <div className="flex justify-between border-t border-slate-200 pt-1 font-medium">
              <dt className="text-slate-700">Payable days</dt>
              <dd className="tabular-nums text-slate-900">
                {r.slip.payableDays ?? "—"} of {r.slip.daysInMonth ?? "—"}
              </dd>
            </div>
          </dl>
        </div>

        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Pay</p>
          <dl className="mt-2 space-y-1 text-sm">
            <div className="flex justify-between">
              <dt className="text-slate-500">Monthly salary</dt>
              <dd className="tabular-nums">{rupees(r.slip.grossAmount)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-500">Loss of pay</dt>
              <dd className="tabular-nums">− {rupees(r.slip.lossOfPay)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-500">Other deduction</dt>
              <dd className="tabular-nums">− {rupees(r.slip.otherDeduction)}</dd>
            </div>
            <div className="flex justify-between border-t border-slate-200 pt-1 font-medium">
              <dt className="text-slate-700">Net payable</dt>
              <dd className="tabular-nums text-slate-900">{rupees(r.slip.netAmount)}</dd>
            </div>
          </dl>

          {isDraft && (
            <div className="mt-4 space-y-2">
              <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
                Manual deduction
              </p>
              <div className="flex flex-wrap gap-2">
                <input
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  inputMode="decimal"
                  placeholder="₹ amount"
                  className="w-28 rounded-lg border border-slate-300 px-3 py-1.5 text-sm outline-none focus:border-slate-900"
                />
                <input
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Reason (required)"
                  className="min-w-40 flex-1 rounded-lg border border-slate-300 px-3 py-1.5 text-sm outline-none focus:border-slate-900"
                />
                <button
                  onClick={saveDeduction}
                  disabled={saving}
                  className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:border-slate-900 disabled:opacity-40"
                >
                  {saving ? "Saving…" : "Save"}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {error && <p className="text-sm text-rose-700">{error}</p>}

      {isDraft && (
        <div className="flex justify-end">
          <button
            onClick={onApprove}
            disabled={busy || r.stale}
            title={r.stale ? "Refresh the drafts first" : undefined}
            className="rounded-lg bg-slate-900 px-5 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-40"
          >
            Approve this payslip
          </button>
        </div>
      )}
    </div>
  );
}
