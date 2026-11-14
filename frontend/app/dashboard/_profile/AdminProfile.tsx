"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { roleLabel } from "@/lib/roles";
import { apiGet } from "@/lib/api";
import Avatar, { PhotoEditor } from "../_photos/Avatar";
import type { Me } from "../layout";

// ---------------------------------------------------------------------------
// ADMIN PROFILE
// The four Admins are senior management, not employees: they have no reporting manager, no offer letter, no warning letters, no payslips on this
// page, no performance rating and no document checklist. Their profile holds only who they are, how to reach them, their account, what they may
// act on, and their sign-in security. Everything shown is read from the account itself (/auth/me/profile); nothing is invented. Other roles keep
// the staff profile (profile/page.tsx), which is untouched.
// ---------------------------------------------------------------------------

type AdminDetails = {
  firstName: string; lastName: string; email: string; phone: string | null; employeeCode: string | null; designation: string | null; role: string; status: string;
  company: string;
  admin: { companies: "ALL" | string[]; lastLoginAt: string | null; createdAt: string } | null;
};

const TABS = ["Personal", "Contact", "Account details", "Role & access", "Security"] as const;
type Tab = (typeof TABS)[number];

const STATUS_LABEL: Record<string, string> = { ACTIVE: "Active", INVITED: "Invited", SUSPENDED: "Suspended", EXITED: "Exited", CANDIDATE: "Candidate" };
const stamp = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" }) : null;
const dayOnly = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : null);

function Fields({ rows }: { rows: [string, React.ReactNode][] }) {
  return (
    <dl className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
      {rows.map(([k, v]) => (
        <div key={k} className="min-w-0">
          <dt className="text-xs text-slate-400">{k}</dt>
          <dd className="mt-0.5 break-words text-sm font-medium text-slate-900 [overflow-wrap:anywhere]">
            {v === null || v === undefined || v === "" ? <span className="font-normal text-slate-400">Not provided</span> : v}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export default function AdminProfile({ me }: { me: Me }) {
  const [tab, setTab] = useState<Tab>(() => {
    if (typeof window === "undefined") return "Personal";
    const wanted = new URLSearchParams(window.location.search).get("tab");
    return TABS.find((t) => t === wanted) ?? "Personal";
  });
  const [details, setDetails] = useState<AdminDetails | null>(null);
  const [photoAtLocal, setPhotoAtLocal] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState(false);
  useEffect(() => {
    apiGet<AdminDetails>("/auth/me/profile").then(setDetails).catch(() => setError(true));
  }, []);

  const fullName = `${me.firstName} ${me.lastName}`.trim();
  const photoAt = photoAtLocal !== undefined ? photoAtLocal : me.photoAt;
  const status = details ? STATUS_LABEL[details.status] ?? details.status : null;
  const companies = details?.admin?.companies;
  const companyAccess = companies === "ALL" ? "All companies" : Array.isArray(companies) ? (companies.length ? companies.join(", ") : null) : null;
  const companyCount = companies === "ALL" ? "All companies" : Array.isArray(companies) ? `${companies.length} ${companies.length === 1 ? "company" : "companies"}` : "—";

  return (
    <div>
      {/* ---- identity ---- */}
      <section className="mb-6 overflow-hidden rounded-2xl bg-indigo-600">
        <div className="flex flex-col gap-5 p-7 sm:flex-row sm:items-center">
          <Avatar userId={me.id} name={fullName} photoAt={photoAt} size={80} shape="rounded" fallbackClass="bg-gradient-to-br from-indigo-500 to-violet-600 text-white" />
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl font-semibold text-white">{fullName}</h1>
            <p className="mt-0.5 text-sm text-indigo-100">{me.designation ?? "Senior management"}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <span className="rounded-full bg-white/15 px-2.5 py-1 text-xs font-medium text-white">{roleLabel(me.role)}</span>
              <span className="rounded-full bg-white/10 px-2.5 py-1 text-xs font-medium text-white">{me.platform.name}</span>
              {me.employeeCode && <span className="rounded-full bg-white/10 px-2.5 py-1 text-xs font-medium text-white">ID {me.employeeCode}</span>}
            </div>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-px bg-white/5 sm:grid-cols-4">
          {[
            { label: "Sign in with", value: me.employeeCode ?? me.email },
            { label: "Account status", value: status ?? "—" },
            { label: "Company access", value: companyCount },
            { label: "Last sign-in", value: stamp(details?.admin?.lastLoginAt) ?? "—" },
          ].map((cell) => (
            <div key={cell.label} className="bg-indigo-600 px-5 py-3.5">
              <p className="text-[11px] text-indigo-200">{cell.label}</p>
              <p className="mt-0.5 truncate text-sm font-medium text-white">{cell.value}</p>
            </div>
          ))}
        </div>
      </section>

      {error && <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-800">Could not load all of your account details. Refresh to try again.</div>}

      {/* ---- sections ---- */}
      <div role="tablist" aria-label="Profile sections" className="mb-4 flex flex-wrap gap-1 rounded-xl bg-white p-1 shadow-[var(--shadow-card)] no-print">
        {TABS.map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={`rounded-lg px-3.5 py-2 text-sm font-medium ${tab === t ? "bg-indigo-600 text-white" : "text-slate-600 hover:bg-slate-50"}`}>
            {t}
          </button>
        ))}
      </div>

      <section className="mb-6 rounded-2xl bg-white p-6 shadow-[var(--shadow-card)]">
        <h2 className="mb-4 text-sm font-semibold text-slate-900">{tab}</h2>

        {tab === "Personal" && (
          <>
            <div className="mb-5 border-b border-indigo-50 pb-5">
              <PhotoEditor userId={me.id} name={fullName} photoAt={photoAt} onChanged={setPhotoAtLocal} />
            </div>
            <Fields rows={[["First name", me.firstName], ["Last name", me.lastName], ["Designation", me.designation]]} />
          </>
        )}

        {tab === "Contact" && <Fields rows={[["Work email", me.email], ["Phone", details?.phone ?? null]]} />}

        {tab === "Account details" && (
          <Fields
            rows={[
              ["Admin ID (sign-in ID)", me.employeeCode],
              ["Work email", me.email],
              ["Home company", details?.company ?? me.platform.name],
              ["Organization level", "Senior management (top level)"],
              ["Account status", status],
              ["Account created", dayOnly(details?.admin?.createdAt)],
              ["Last sign-in", stamp(details?.admin?.lastLoginAt)],
            ]}
          />
        )}

        {tab === "Role & access" && (
          <>
            <Fields
              rows={[
                ["System role", roleLabel(me.role)],
                ["Access level", "Full Admin access"],
                ["Companies you act on", companyAccess],
                ["Account status", status],
              ]}
            />
            <p className="mt-5 rounded-xl bg-[#F3F7F6] px-4 py-3 text-xs leading-relaxed text-slate-500">
              The four Admins share the top level of the organization and do not report to anyone. Access to companies is managed from Company Management.
            </p>
          </>
        )}

        {tab === "Security" && (
          <div className="space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-indigo-100 px-4 py-3.5">
              <div className="min-w-0">
                <p className="text-sm font-medium text-slate-900">Password</p>
                <p className="mt-0.5 text-xs text-slate-500">Your password is yours alone. Change it at any time; you will need your current one.</p>
              </div>
              <Link href="/change-password" className="inline-flex h-10 shrink-0 items-center rounded-xl bg-indigo-600 px-4 text-sm font-medium text-white hover:bg-indigo-700">
                Change password
              </Link>
            </div>
            <Fields rows={[["Sign in with", me.employeeCode ?? me.email], ["Last sign-in", stamp(details?.admin?.lastLoginAt)]]} />
            <p className="rounded-xl bg-[#F3F7F6] px-4 py-3 text-xs leading-relaxed text-slate-500">
              Every Admin has an individual sign-in. What you do is recorded in the audit log under your own name, so please do not share your password.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
