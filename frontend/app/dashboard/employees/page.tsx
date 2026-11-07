// ===========================================================================
// ADMIN — People, Teams, Shifts, Thresholds, Leave
//
// Five tabs, one page. Add and edit happen in a slide-over panel rather than
// a separate route, so the list stays visible behind it and you don't lose
// your place in a long table.
//
// Options for every dropdown come from a single /admin/options call made
// once when the page mounts, instead of each form fetching its own lists.
// ===========================================================================

"use client";

import { useCallback, useEffect, useState } from "react";
import { roleLabel } from "@/lib/roles";
import { tabFor, tabsFor, type Tab as AdminTab } from "./tabs";
import FilterBar from "../_filters/FilterBar";
import { filterQuery, useFilterOptions, useHrFilters } from "../_filters/useHrFilters";
import { createPortal } from "react-dom";
import { API_BASE } from "@/lib/api";
import { todayIso } from "@/lib/time";
import { plural } from "@/lib/plural";
import { SearchSelect } from "../_employees/SearchSelect";
import EmployeeActions from "../_employees/EmployeeActions";
import Avatar, { PhotoEditor } from "../_photos/Avatar";
import { useMe } from "../layout";

const API = API_BASE;

async function call<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${
        typeof window === "undefined" ? "" : localStorage.getItem("token") ?? ""
      }`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? "That didn't work");
  return data as T;
}

// --- types -----------------------------------------------------------------

type Options = {
  designations?: string[];
  teams: { id: string; name: string }[];
    people: {
    id: string;
    name: string;
    employeeCode: string | null;
    company: string | null;
  }[];

  shifts: {
    id: string;
    name: string;
    startTime: string;
    endTime: string;
    isDefault: boolean;
  }[];
  managers: { id: string; name: string; role: string }[];
  roles: string[];
  statuses: string[];
  onboardingStatuses: string[];
  teamTypes: string[];
  leaveTypes: string[];
};

type Person = {
  id: string;
  name: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string | null;
  employeeCode: string | null;
  role: string;
  status: string;
  designation: string | null;
  dateOfJoining: string | null;
  onboardingStatus: string;
  trackerAccessEnabled: boolean;
  lastLoginAt: string | null;
  shift: { id: string; name: string } | null;
  reportsTo: { id: string; name: string } | null;
  teams: { id: string; name: string }[];
  company?: string | null;
  companyId?: string;
  photoAt?: string | null;
};

type CompaniesInfo = { all: boolean; ownCompanyId: string; canSwitch: boolean; companies: { id: string; name: string; employeeCodePrefix: string | null }[] };

type TeamRow = {
  id: string;
  name: string;
  teamType: string;
  isActive: boolean;
  manager: { id: string; name: string } | null;
  coManagers: { id: string; name: string; employeeCode: string | null }[];
  shift: { id: string; name: string; startTime: string; endTime: string } | null;
  config: Record<string, number | string | boolean> | null;
  memberCount: number;
  members: { userId: string; name: string; employeeCode: string | null; role: string }[];
};

type ShiftRow = {
  id: string;
  name: string;
  startTime: string;
  endTime: string;
  workingDays: number[];
  isDefault: boolean;
  isActive: boolean;
  spansMidnight: boolean;
};

type LeaveRow = {
  id: string;
  date: string;
  leaveType: string;
  isHalfDay: boolean;
  isFirstHalf: boolean;
  note: string | null;
  userId: string;
  name: string;
  employeeCode: string | null;
  markedBy: string;
};


type Tab = AdminTab;

const DAY_LABELS = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const STATUS_CHIP: Record<string, string> = {
  ACTIVE: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  INVITED: "bg-sky-50 text-sky-700 ring-sky-200",
  CANDIDATE: "bg-[#F3F7F6] text-slate-600 ring-slate-200",
  SUSPENDED: "bg-amber-50 text-amber-700 ring-amber-200",
  EXITED: "bg-rose-50 text-rose-700 ring-rose-200",
};

// ===========================================================================

export default function AdminPage() {
  const me = useMe();
  // /dashboard/employees?tab=Teams opens that tab, so the menu can link straight
  // to it. Read once when the page first renders, rather than with
  // useSearchParams, which would force this page behind a Suspense boundary.
  // (The layout only renders pages after sign-in resolves, so window exists.)
  const [wantedTab, setTab] = useState<string>(() => {
    if (typeof window === "undefined") return "People";
    return new URLSearchParams(window.location.search).get("tab") ?? "People";
  });
  // The tabs depend on the role: Admin gets the whole page; HR gets People, Teams and Leave (no organization-wide shifts and thresholds).
  const tabs = tabsFor(me?.role);
  const tab = tabFor(me?.role, wantedTab);
  const [options, setOptions] = useState<Options | null>(null);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");

  const loadOptions = useCallback(async () => {
    try {
      setOptions(await call<Options>("/admin/options"));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load options");
    }
  }, []);

  useEffect(() => {
    void loadOptions();
  }, [loadOptions]);

  // Clear the confirmation message after a few seconds so it doesn't linger.
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const allowed = me?.role === "ADMIN" || me?.role === "HR";

  if (me && !allowed) {
    return (
      <div className="p-8">
        <div className="rounded-2xl bg-white shadow-[var(--shadow-card)] p-8 text-center">
          <p className="text-sm text-slate-600">
            Admin is limited to HR and administrators.
          </p>
        </div>
      </div>
    );
  }

  const shared = {
    options,
    onError: (m: string) => setError(m),
    onDone: (m: string) => {
      setToast(m);
      setError("");
      void loadOptions();
    },
  };

  return (
    <div className="page-fluid p-8 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">{me?.role === "ADMIN" ? "Admin" : "Employees"}</h1>
        <p className="mt-1 text-sm text-slate-500">
          {me?.role === "ADMIN" ? "People, teams, shifts and the thresholds every alert is measured against." : "Employee records, teams and leave for the companies you look after."}
        </p>
      </div>

      <div className="inline-flex rounded-xl border border-indigo-100 bg-[#F3F7F6] p-0.5">
        {tabs.map((t) => (
          <button
            key={t}
            onClick={() => {
              setTab(t);
              setError("");
            }}
            className={`rounded-md px-4 py-1.5 text-sm font-medium transition ${
              tab === t
                ? "bg-white text-slate-900 shadow-sm"
                : "text-slate-500 hover:text-slate-800"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

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

      {tab === "People" && <PeopleTab {...shared} />}
      {tab === "Teams" && <TeamsTab {...shared} />}
      {tab === "Shifts" && <ShiftsTab {...shared} />}
      {tab === "Thresholds" && <ThresholdsTab {...shared} />}
      {tab === "Leave" && <LeaveTab {...shared} />}
    </div>
  );
}

type TabProps = {
  options: Options | null;
  onError: (m: string) => void;
  onDone: (m: string) => void;
};

// ===========================================================================
// PEOPLE
// ===========================================================================

function PeopleTab({ options, onError, onDone }: TabProps) {
  const [people, setPeople] = useState<Person[]>([]);
  const [role, setRole] = useState("");
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Person | "new" | null>(null);
  // Which companies the person may act on (the Company column shows when there are several and none is chosen).
  const [companies, setCompanies] = useState<CompaniesInfo | null>(null);
  // Company, project (several), reporting manager, designation, employment status and name/ID search: the shared HR filters, applied by the server.
  const { filters, update, clear, ready } = useHrFilters();
  const { options: filterOptions } = useFilterOptions(filters, update, ready);
  const [scope, setScope] = useState<{ orgTotal: number; filteredTotal: number } | null>(null);

  // A link from the Admin dashboard can open this list already filtered by role (?role=MANAGER). Read once, on arrival.
  useEffect(() => {
    const r = new URLSearchParams(window.location.search).get("role");
    if (r && ["ADMIN", "HR", "MANAGER", "EMPLOYEE"].includes(r)) setRole(r);
  }, []);

  useEffect(() => {
    call<CompaniesInfo>("/admin/employees/companies").then(setCompanies).catch(() => setCompanies(null));
  }, []);

  const filterString = filterQuery(filters, { q: "search", company: "companyId" });
  const load = useCallback(async () => {
    if (!ready) return;
    setLoading(true);
    try {
      const query = new URLSearchParams(filterString);
      if (role) query.set("role", role);
      const data = await call<{ users: Person[]; scope?: { orgTotal: number; filteredTotal: number } }>(`/admin/users?${query}`);
      setPeople(data.users);
      setScope(data.scope ?? null);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Could not load people");
    } finally {
      setLoading(false);
    }
    // onError is stable enough for this page; re-running on it would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterString, role, ready]);

  // Debounced so typing in the search box doesn't fire a request per keypress.
  useEffect(() => {
    const t = setTimeout(() => void load(), 250);
    return () => clearTimeout(t);
  }, [load]);

  return (
    <div className="space-y-4">
      {/* The actions (add one person, import many, update details) stay where they were: top right. The filters sit below them in the shared bar. */}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <EmployeeActions
          className="shrink-0"
          onDone={(message) => {
            onDone(message);
            void load();
          }}
        />
      </div>

      <FilterBar
        filters={filters}
        update={update}
        clear={() => {
          clear();
          setRole("");
        }}
        options={filterOptions}
        show={{ search: true, company: true, project: true, manager: true, designation: true, status: true }}
        counts={scope ? { filtered: scope.filteredTotal, total: scope.orgTotal } : null}
        searchPlaceholder="Search name, email or employee ID"
        extraActive={role ? 1 : 0}
        extra={
          <div className="w-36">
            <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-slate-400" htmlFor="hf-role">Role</label>
            <select id="hf-role" value={role} onChange={(e) => setRole(e.target.value)} className="h-9 w-full rounded-xl border border-indigo-100 bg-white px-3 text-sm text-slate-800 outline-none focus:border-indigo-400">
              <option value="">All roles</option>
              {options?.roles.map((r) => (
                <option key={r} value={r}>{roleLabel(r)}</option>
              ))}
            </select>
          </div>
        }
      />

      <div className="overflow-hidden rounded-2xl bg-white shadow-[var(--shadow-card)]">
        <table className="min-w-full text-sm">
          <thead className="bg-[#F3F7F6] text-left text-xs font-medium uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Code</th>
              {companies?.canSwitch && !filters.company && <th className="px-4 py-3">Company</th>}
              <th className="px-4 py-3">Role / Designation</th>
              <th className="px-4 py-3">Projects</th>
              <th className="px-4 py-3">Reports to</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3 text-right">Edit</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-indigo-50">
            {people.map((p) => (
              <tr key={p.id} className="hover:bg-indigo-50/60/70">
                <td className="px-4 py-3">
                  <div className="flex items-center gap-3">
                    <Avatar userId={p.id} name={p.name} photoAt={p.photoAt} size={32} />
                    <div className="min-w-0">
                      <div className="font-medium text-slate-900">{p.name}</div>
                      <div className="text-xs text-slate-500">{p.email}</div>
                    </div>
                  </div>
                </td>
                <td className="px-4 py-3 text-slate-600">{p.employeeCode ?? "—"}</td>
                {companies?.canSwitch && !filters.company && <td className="px-4 py-3 text-slate-600">{p.company ?? "—"}</td>}
                <td className="px-4 py-3 text-slate-600" title={`System role (permissions): ${roleLabel(p.role)}`}>
                  {p.designation?.trim() ? p.designation : <span className="text-slate-400">Not Assigned</span>}
                </td>
                <td className="px-4 py-3 text-slate-600">
                  {p.teams.map((t) => t.name).join(", ") || "—"}
                </td>
                <td className="px-4 py-3 text-slate-600">{p.reportsTo?.name ?? "—"}</td>
                <td className="px-4 py-3">
                  <span
                    className={`rounded-md px-2 py-0.5 text-xs font-medium ring-1 ${
                      STATUS_CHIP[p.status] ?? "bg-[#F3F7F6] text-slate-600 ring-slate-200"
                    }`}
                  >
                    {p.status.toLowerCase()}
                  </span>
                </td>
                <td className="px-4 py-3 text-right">
                  <button
                    onClick={() => setEditing(p)}
                    className="text-xs font-medium text-slate-500 hover:text-slate-900"
                  >
                    Edit
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {loading && (
          <p className="px-4 py-10 text-center text-sm text-slate-400">Loading…</p>
        )}
        {!loading && people.length === 0 && (
          <p className="px-4 py-10 text-center text-sm text-slate-400">
            Nobody matches that.
          </p>
        )}
      </div>

      {editing && editing !== "new" && (
        <EditPersonDrawer
          person={editing}
          onClose={() => setEditing(null)}
          onSaved={(msg) => {
            setEditing(null);
            onDone(msg);
            void load();
          }}
          onError={onError}
        />
      )}
      {editing === "new" && (
        <PersonDrawer
          person={null}
          options={options}
          onClose={() => setEditing(null)}
          onSaved={(msg) => {
            setEditing(null);
            onDone(msg);
            void load();
          }}
          onError={onError}
        />
      )}
    </div>
  );
}

function PersonDrawer({
  person,
  options,
  onClose,
  onSaved,
  onError,
}: {
  person: Person | null;
  options: Options | null;
  onClose: () => void;
  onSaved: (msg: string) => void;
  onError: (m: string) => void;
}) {
  const isNew = person === null;
  const [form, setForm] = useState({
    firstName: person?.firstName ?? "",
    lastName: person?.lastName ?? "",
    email: person?.email ?? "",
    phone: person?.phone ?? "",
    password: "",
    role: person?.role ?? "EMPLOYEE",
    status: person?.status ?? "INVITED",
    designation: person?.designation ?? "",
    employeeCode: person?.employeeCode ?? "",
    shiftId: person?.shift?.id ?? "",
    reportsToId: person?.reportsTo?.id ?? "",
    teamId: "",
    dateOfJoining: person?.dateOfJoining?.slice(0, 10) ?? "",
    skipOnboarding: false,
    trackerAccessEnabled: person?.trackerAccessEnabled ?? false,
  });
  const [busy, setBusy] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  // Team membership of an existing person: starts as it is today and changes ONLY when the admin edits it and
  // presses Save. Nothing is assigned automatically.
  const originalTeamIds = person?.teams.map((t) => t.id) ?? [];
  const [teamIds, setTeamIds] = useState<string[]>(originalTeamIds);
  const teamName = (id: string) => options?.teams.find((t) => t.id === id)?.name ?? person?.teams.find((t) => t.id === id)?.name ?? "Unknown team";
  const teamAdds = teamIds.filter((id) => !originalTeamIds.includes(id));
  const teamRemoves = originalTeamIds.filter((id) => !teamIds.includes(id));

  const set = (k: keyof typeof form, v: unknown) =>
    setForm((f) => ({ ...f, [k]: v as never }));

  async function save() {
    setBusy(true);
    try {
      if (isNew) {
                const result = (await call("/admin/users", "POST", {
          firstName: form.firstName,
          lastName: form.lastName,
          email: form.email,
          phone: form.phone || undefined,
          password: form.password,
          role: form.role,
          designation: form.designation || undefined,
          employeeCode: form.employeeCode || undefined,
          shiftId: form.shiftId || undefined,
          reportsToId: form.reportsToId || undefined,
          teamId: form.teamId || undefined,
          dateOfJoining: form.dateOfJoining || undefined,
          skipOnboarding: form.skipOnboarding,
          })) as unknown as {
          user?: {
            mail?: { sent?: boolean; reason?: string | null; to?: string | null } | null;
          } | null;
          mail?: { sent?: boolean; reason?: string | null; to?: string | null } | null;
        };

        // The backend already reports whether the welcome email went out.
        // Throwing that away left HR assuming a password had been delivered
        // when it never left the building.
                // The route wraps the created person as { user }, so the mail result
        // sits one level deeper than it looks. Both shapes are accepted, so a
        // change at either end cannot silently blank this message again.
        const mail = result?.user?.mail ?? result?.mail ?? null;
        const mailNote = form.skipOnboarding
          ? " No welcome email — marked as an existing employee."
          : mail?.sent
          ? ` Welcome email sent to ${mail.to ?? form.email}.`
          : ` Welcome email NOT sent (${mail?.reason ?? "unknown"}) — give them the password yourself.`;

        onSaved(`${form.firstName} ${form.lastName} added.${mailNote}`);
      } else {
        await call(`/admin/users/${person!.id}`, "PATCH", {
          firstName: form.firstName,
          lastName: form.lastName,
          phone: form.phone,
          role: form.role,
          status: form.status,
          designation: form.designation,
          employeeCode: form.employeeCode,
          shiftId: form.shiftId || null,
          reportsToId: form.reportsToId || null,
          dateOfJoining: form.dateOfJoining || null,
          trackerAccessEnabled: form.trackerAccessEnabled,
        });
        // Team changes the admin made in this form (adds first, then removals; removal is a soft "left the team").
        try {
          for (const id of teamAdds) await call(`/admin/teams/${id}/members`, "POST", { userId: person!.id });
          for (const id of teamRemoves) await call(`/admin/teams/${id}/members/${person!.id}`, "DELETE");
        } catch (e) {
          throw new Error(`Details saved, but the team change failed: ${e instanceof Error ? e.message : "unknown error"}`);
        }
        onSaved(`${form.firstName} ${form.lastName} updated.`);
      }
    } catch (e) {
      onError(e instanceof Error ? e.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  async function resetPassword() {
    if (newPassword.length < 8) {
      onError("The new password must be at least 8 characters.");
      return;
    }
    setBusy(true);
    try {
      await call(`/admin/users/${person!.id}/password`, "POST", { password: newPassword });
      setNewPassword("");
      onSaved("Password reset.");
    } catch (e) {
      onError(e instanceof Error ? e.message : "Could not reset the password");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer title={isNew ? "Add person" : person!.name} onClose={onClose}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="First name">
          <Input value={form.firstName} onChange={(v) => set("firstName", v)} />
        </Field>
        <Field label="Last name">
          <Input value={form.lastName} onChange={(v) => set("lastName", v)} />
        </Field>
      </div>

      <Field label="Email">
        <Input
          value={form.email}
          onChange={(v) => set("email", v)}
          disabled={!isNew}
          type="email"
        />
      </Field>

      {isNew && (
        <Field label="Temporary password" hint="At least 8 characters. They can change it later.">
          <Input value={form.password} onChange={(v) => set("password", v)} type="text" />
        </Field>
      )}

      <div className="grid grid-cols-2 gap-3">
        <Field label="System role" hint="Decides what they can do in the app">
          <Select value={form.role} onChange={(v) => set("role", v)}>
            {options?.roles.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Role / Designation" hint="Their job title, from the list that is the same for every company.">
          <SearchSelect
            options={(options?.designations ?? []).map((d) => ({ value: d, label: d }))}
            value={form.designation}
            onChange={(v) => set("designation", v)}
            clearLabel="Not Assigned"
            placeholder="Search designations…"
            emptyText="No designation matches"
          />
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Employee code" hint={isNew ? "Leave blank to generate" : undefined}>
          <Input value={form.employeeCode} onChange={(v) => set("employeeCode", v)} />
        </Field>
        <Field label="Phone">
          <Input value={form.phone} onChange={(v) => set("phone", v)} />
        </Field>
      </div>

           <Field
        label="Reports to"
        hint="Approves their tasks and sees their attendance. Leave blank for the company head."
      >
        <Select value={form.reportsToId} onChange={(v) => set("reportsToId", v)}>
          <option value="">Nobody — top of the chain</option>
          {options?.people
            .filter((p) => p.id !== person?.id)
            .map((p) => (
                            <option key={p.id} value={p.id}>
                {p.name}
                {p.company ? ` — ${p.company}` : p.employeeCode ? ` (${p.employeeCode})` : ""}
              </option>
            ))}
        </Select>
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Shift" hint="Late login is measured against this">
          <Select value={form.shiftId} onChange={(v) => set("shiftId", v)}>
            <option value="">No shift</option>
            {options?.shifts.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.startTime}–{s.endTime})
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Date of joining">
          <Input
            value={form.dateOfJoining}
            onChange={(v) => set("dateOfJoining", v)}
            type="date"
          />
        </Field>
      </div>

      {isNew && (
        <>
          <Field label="Add to team">
            <Select value={form.teamId} onChange={(v) => set("teamId", v)}>
              <option value="">No team</option>
              {options?.teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </Field>

          <Toggle
            checked={form.skipOnboarding}
            onChange={(v) => set("skipOnboarding", v)}
            label="Existing employee — skip onboarding"
            hint="Opens the tracker immediately instead of waiting for documents and a resume."
          />
        </>
      )}

      {!isNew && (
        <>
          <Field label="Team / department" hint="Chosen by you. Nothing is assigned automatically; changes apply when you press Save changes.">
            <div className="mb-2 flex flex-wrap gap-1.5">
              {teamIds.length === 0 && <span className="text-sm text-slate-400">No team</span>}
              {teamIds.map((id) => (
                <span key={id} className="inline-flex items-center gap-1 rounded-full bg-indigo-50 py-1 pl-2.5 pr-1 text-xs text-indigo-700">
                  {teamName(id)}
                  <button type="button" onClick={() => setTeamIds((cur) => cur.filter((x) => x !== id))} aria-label={`Remove from ${teamName(id)}`} className="rounded-full p-0.5 hover:bg-indigo-100">
                    <svg viewBox="0 0 20 20" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="m5 5 10 10M15 5 5 15" /></svg>
                  </button>
                </span>
              ))}
            </div>
            <Select value="" onChange={(v) => v && setTeamIds((cur) => (cur.includes(v) ? cur : [...cur, v]))}>
              <option value="">Add a team…</option>
              {options?.teams.filter((t) => !teamIds.includes(t.id)).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
            {(teamAdds.length > 0 || teamRemoves.length > 0) && (
              <p className="mt-2 text-xs text-amber-700">
                Not saved yet:{teamAdds.length > 0 ? ` add to ${teamAdds.map(teamName).join(", ")}.` : ""}
                {teamRemoves.length > 0 ? ` Remove from ${teamRemoves.map(teamName).join(", ")}.` : ""}
              </p>
            )}
          </Field>

          <Field label="Status">
            <Select value={form.status} onChange={(v) => set("status", v)}>
              {options?.statuses.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          </Field>

          <Toggle
            checked={form.trackerAccessEnabled}
            onChange={(v) => set("trackerAccessEnabled", v)}
            label="Tracker access"
            hint="When off, this person can sign in but cannot clock in."
          />
        </>
      )}

      <div className="flex gap-2 pt-2">
        <button
          onClick={save}
          disabled={busy}
          className="flex-1 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-indigo-700 disabled:opacity-40"
        >
          {busy ? "Saving…" : isNew ? "Create person" : "Save changes"}
        </button>
        <button
          onClick={onClose}
          className="rounded-xl border border-indigo-200 px-4 py-2.5 text-sm font-medium text-slate-600 hover:border-slate-400"
        >
          Cancel
        </button>
      </div>

      {!isNew && (
        <div className="mt-6 border-t border-indigo-100 pt-5">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500 mb-2">
            Reset password
          </p>
          <div className="flex gap-2">
            <Input
              value={newPassword}
              onChange={setNewPassword}
              placeholder="New password"
            />
            <button
              onClick={resetPassword}
              disabled={busy || newPassword.length < 8}
              className="whitespace-nowrap rounded-xl border border-indigo-200 px-3 py-2 text-sm font-medium text-slate-700 hover:border-slate-400 disabled:opacity-40"
            >
              Reset
            </button>
          </div>
        </div>
      )}
    </Drawer>
  );
}

// ===========================================================================
// EDIT EMPLOYEE
// Everything comes from the server: the person's details, what the person editing may change (salary, roles) and the dropdown
// choices of THEIR company (departments, designations, reporting managers). The employee ID and the company are shown but never
// editable. Only what was actually changed is sent; replacing an existing designation or salary needs a ticked confirmation.
// ===========================================================================

type EditModel = {
  person: {
    id: string; firstName: string; lastName: string; email: string; phone: string | null; employeeCode: string | null; role: string; status: string;
    designation: string | null; dateOfJoining: string | null; reportsToId: string | null; shiftId: string | null; trackerAccessEnabled: boolean;
    employmentType: string | null; companyId: string; company: string; departments: { id: string; name: string }[]; monthlySalary?: number | null; photoAt?: string | null;
  };
  permissions: { canEditSalary: boolean; canChangeRoles: boolean; canEditHierarchy?: boolean };
  dropdowns: {
    departments: { id: string; name: string }[]; designations: string[]; managers: { id: string; name: string; employeeCode: string | null; role: string }[];
    shifts: { id: string; name: string; startTime: string; endTime: string }[]; statuses: string[]; employeeTypes: string[];
  };
};

const TYPE_NAME: Record<string, string> = { PERMANENT: "Permanent", PROBATION: "Probation", CONTRACT: "Contract", INTERN: "Intern" };

function EditPersonDrawer({ person, onClose, onSaved, onError }: { person: Person; onClose: () => void; onSaved: (msg: string) => void; onError: (m: string) => void }) {
  const [model, setModel] = useState<EditModel | null>(null);
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [f, setF] = useState({ firstName: "", lastName: "", email: "", phone: "", role: "", status: "", designation: "", reportsToId: "", shiftId: "", dateOfJoining: "", employmentType: "", salary: "", trackerAccessEnabled: false });
  const [teamIds, setTeamIds] = useState<string[]>([]);
  const [confirmDesignation, setConfirmDesignation] = useState(false);
  const [confirmSalary, setConfirmSalary] = useState(false);
  const [photoAtEdit, setPhotoAtEdit] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    let live = true;
    call<EditModel>(`/admin/employees/${person.id}/edit`)
      .then((m) => {
        if (!live) return;
        const p = m.person;
        setModel(m);
        setF({
          firstName: p.firstName, lastName: p.lastName, email: p.email, phone: p.phone ?? "", role: p.role, status: p.status, designation: p.designation ?? "",
          reportsToId: p.reportsToId ?? "", shiftId: p.shiftId ?? "", dateOfJoining: p.dateOfJoining ?? "", employmentType: p.employmentType ?? "",
          salary: p.monthlySalary === null || p.monthlySalary === undefined ? "" : String(p.monthlySalary), trackerAccessEnabled: p.trackerAccessEnabled,
        });
        setTeamIds(p.departments.map((d) => d.id));
      })
      .catch((e: Error) => live && setLoadError(e.message));
    return () => {
      live = false;
    };
  }, [person.id]);

  const set = (k: keyof typeof f, v: unknown) => setF((cur) => ({ ...cur, [k]: v as never }));

  if (!model) {
    return (
      <Drawer title={person.name} onClose={onClose}>
        {loadError ? <p className="text-sm text-rose-700">{loadError}</p> : <p className="text-sm text-slate-400">Loading…</p>}
      </Drawer>
    );
  }

  const p = model.person;
  const dd = model.dropdowns;
  const origTeamIds = p.departments.map((d) => d.id);
  const teamAdds = teamIds.filter((id) => !origTeamIds.includes(id));
  const teamRemoves = origTeamIds.filter((id) => !teamIds.includes(id));
  const deptName = (id: string) => dd.departments.find((d) => d.id === id)?.name ?? p.departments.find((d) => d.id === id)?.name ?? "Unknown";
  const designationChanged = f.designation.trim() !== (p.designation ?? "");
  const hadSalary = p.monthlySalary !== null && p.monthlySalary !== undefined;
  const salaryChanged = model.permissions.canEditSalary && f.salary.trim() !== (hadSalary ? String(p.monthlySalary) : "");

  async function save() {
    const body: Record<string, unknown> = {};
    if (f.firstName.trim() !== p.firstName) body.firstName = f.firstName;
    if (f.lastName.trim() !== p.lastName) body.lastName = f.lastName;
    if (f.email.trim().toLowerCase() !== p.email.toLowerCase()) body.email = f.email;
    if (f.phone.trim() !== (p.phone ?? "")) body.phone = f.phone;
    if (designationChanged) body.designation = f.designation.trim() || null;
    if (model!.permissions.canEditHierarchy && (f.reportsToId || null) !== (p.reportsToId ?? null)) body.reportsToId = f.reportsToId || null;
    if ((f.shiftId || null) !== (p.shiftId ?? null)) body.shiftId = f.shiftId || null;
    if ((f.dateOfJoining || null) !== (p.dateOfJoining ?? null)) body.dateOfJoining = f.dateOfJoining || null;
    if (f.status !== p.status) body.status = f.status;
    if (model!.permissions.canChangeRoles && f.role !== p.role) body.role = f.role;
    if (f.trackerAccessEnabled !== p.trackerAccessEnabled) body.trackerAccessEnabled = f.trackerAccessEnabled;
    if ((f.employmentType || null) !== (p.employmentType ?? null)) body.employmentType = f.employmentType || null;
    if (salaryChanged) body.monthlySalary = f.salary.trim() === "" ? null : Number(f.salary.replace(/,/g, ""));
    if (designationChanged || salaryChanged) body.confirmOverwrite = { designation: confirmDesignation, salary: confirmSalary };
    const bodyHasChange = Object.keys(body).filter((k) => k !== "confirmOverwrite").length > 0;
    if (!bodyHasChange && teamAdds.length === 0 && teamRemoves.length === 0) {
      onError("Nothing was changed.");
      return;
    }
    setBusy(true);
    try {
      if (bodyHasChange) await call(`/admin/users/${p.id}`, "PATCH", body);
      try {
        for (const id of teamAdds) await call(`/admin/teams/${id}/members`, "POST", { userId: p.id });
        for (const id of teamRemoves) await call(`/admin/teams/${id}/members/${p.id}`, "DELETE");
      } catch (e) {
        throw new Error(`Details saved, but the department change failed: ${e instanceof Error ? e.message : "unknown error"}`);
      }
      onSaved(`${f.firstName} ${f.lastName} updated.`);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  async function resetPassword() {
    if (newPassword.length < 8) return onError("The new password must be at least 8 characters.");
    setBusy(true);
    try {
      await call(`/admin/users/${p.id}/password`, "POST", { password: newPassword });
      setNewPassword("");
      onSaved("Password reset.");
    } catch (e) {
      onError(e instanceof Error ? e.message : "Could not reset the password");
    } finally {
      setBusy(false);
    }
  }

  const managerOptions = dd.managers.filter((m) => m.id !== p.id);
  const currentManagerMissing = f.reportsToId && !managerOptions.some((m) => m.id === f.reportsToId);

  return (
    <Drawer title={person.name} onClose={onClose}>
      <Field label="Profile photo" hint="Shown instead of initials across the app. Saved straight away.">
        <PhotoEditor userId={p.id} name={`${f.firstName} ${f.lastName}`.trim()} photoAt={photoAtEdit !== undefined ? photoAtEdit : p.photoAt} onChanged={setPhotoAtEdit} />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Company" hint="Cannot be changed here: attendance, tasks and leave belong to it.">
          <Input value={p.company} onChange={() => undefined} disabled />
        </Field>
        <Field label="Employee ID" hint="Never changes.">
          <Input value={p.employeeCode ?? ""} onChange={() => undefined} disabled />
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label="First name">
          <Input value={f.firstName} onChange={(v) => set("firstName", v)} />
        </Field>
        <Field label="Last name">
          <Input value={f.lastName} onChange={(v) => set("lastName", v)} />
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Email" hint="Also their sign-in name.">
          <Input value={f.email} onChange={(v) => set("email", v)} type="email" />
        </Field>
        <Field label="Phone">
          <Input value={f.phone} onChange={(v) => set("phone", v)} />
        </Field>
      </div>

      <Field label="Department" hint="Changes apply when you press Save changes.">
        <div className="mb-2 flex flex-wrap gap-1.5">
          {teamIds.length === 0 && <span className="text-sm text-slate-400">No department</span>}
          {teamIds.map((id) => (
            <span key={id} className="inline-flex items-center gap-1 rounded-full bg-indigo-50 py-1 pl-2.5 pr-1 text-xs text-indigo-700">
              {deptName(id)}
              <button type="button" hidden={!model.permissions.canEditHierarchy} onClick={() => setTeamIds((cur) => cur.filter((x) => x !== id))} aria-label={`Remove from ${deptName(id)}`} className="rounded-full p-0.5 hover:bg-indigo-100">
                <svg viewBox="0 0 20 20" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="m5 5 10 10M15 5 5 15" /></svg>
              </button>
            </span>
          ))}
        </div>
        {model.permissions.canEditHierarchy ? (
        <Select value="" onChange={(v) => v && setTeamIds((cur) => (cur.includes(v) ? cur : [...cur, v]))}>
          <option value="">Add a department…</option>
          {dd.departments.filter((d) => !teamIds.includes(d.id)).map((d) => (
            <option key={d.id} value={d.id}>{d.name}</option>
          ))}
        </Select>
        ) : (
          <p className="text-xs text-slate-500">Only an Admin can change department / project assignments.</p>
        )}
        {(teamAdds.length > 0 || teamRemoves.length > 0) && (
          <p className="mt-2 text-xs text-amber-700">
            Not saved yet:{teamAdds.length > 0 ? ` add to ${teamAdds.map(deptName).join(", ")}.` : ""}
            {teamRemoves.length > 0 ? ` Remove from ${teamRemoves.map(deptName).join(", ")}.` : ""}
          </p>
        )}
      </Field>

      <Field label="Designation" hint="From the list that is the same for every company. Type to search.">
        <SearchSelect
          options={[
            // someone who still has an old spelling keeps it until it is changed
            ...(p.designation && !dd.designations.some((d) => d.toLowerCase() === p.designation!.toLowerCase()) ? [{ value: p.designation, label: p.designation, sub: "current (not in the list)" }] : []),
            ...dd.designations.map((d) => ({ value: d, label: d })),
          ]}
          value={f.designation}
          onChange={(v) => { set("designation", v); setConfirmDesignation(false); }}
          clearLabel="Not assigned"
          placeholder="Search designations…"
          emptyText="No designation matches"
        />
        {designationChanged && p.designation && (
          <div className="mt-2">
            <Toggle checked={confirmDesignation} onChange={setConfirmDesignation} label={`Replace the current designation (${p.designation})`} hint="Required to change a designation that is already set." />
          </div>
        )}
      </Field>

      <Field label="Reporting manager" hint={model.permissions.canEditHierarchy ? "Active managers and admins of this company." : "Only an Admin can change who a person reports to."}>
        <Select value={f.reportsToId} onChange={(v) => set("reportsToId", v)} disabled={!model.permissions.canEditHierarchy}>
          <option value="">Nobody: top of the chain</option>
          {currentManagerMissing && <option value={f.reportsToId}>{person.reportsTo?.name ?? "Current manager"} (current)</option>}
          {managerOptions.map((m) => (
            <option key={m.id} value={m.id}>{m.name}{m.employeeCode ? ` (${m.employeeCode})` : ""}</option>
          ))}
        </Select>
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Joining date">
          <Input value={f.dateOfJoining} onChange={(v) => set("dateOfJoining", v)} type="date" />
        </Field>
        <Field label="Shift" hint="Late login is measured against this">
          <Select value={f.shiftId} onChange={(v) => set("shiftId", v)}>
            <option value="">No shift</option>
            {dd.shifts.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.startTime}–{s.endTime})</option>)}
          </Select>
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Employment status">
          <Select value={f.status} onChange={(v) => set("status", v)}>
            {dd.statuses.map((s) => <option key={s} value={s}>{s.charAt(0) + s.slice(1).toLowerCase()}</option>)}
          </Select>
        </Field>
        <Field label="Employee type">
          <Select value={f.employmentType} onChange={(v) => set("employmentType", v)}>
            <option value="">Not set</option>
            {dd.employeeTypes.map((t) => <option key={t} value={t}>{TYPE_NAME[t] ?? t}</option>)}
          </Select>
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label="System role" hint={model.permissions.canChangeRoles ? "Decides what they can do in the app" : "Only an Admin can change this"}>
          <Select value={f.role} onChange={(v) => set("role", v)}>
            {(options_roles(person.role, model.permissions.canChangeRoles)).map((r) => <option key={r} value={r}>{r}</option>)}
          </Select>
        </Field>
        {model.permissions.canEditSalary ? (
          <Field label="Monthly salary" hint="Visible to Admin and top management only.">
            <Input value={f.salary} onChange={(v) => { set("salary", v); setConfirmSalary(false); }} placeholder="Not set" />
          </Field>
        ) : (
          <div />
        )}
      </div>
      {salaryChanged && hadSalary && (
        <Toggle checked={confirmSalary} onChange={setConfirmSalary} label="Replace the current salary" hint="Required to change a salary that is already set. The change is written to the audit log." />
      )}

      <Toggle checked={f.trackerAccessEnabled} onChange={(v) => set("trackerAccessEnabled", v)} label="Tracker access" hint="When off, this person can sign in but cannot clock in." />

      <div className="flex gap-2 pt-2">
        <button onClick={save} disabled={busy} className="flex-1 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-indigo-700 disabled:opacity-40">
          {busy ? "Saving…" : "Save changes"}
        </button>
        <button onClick={onClose} className="rounded-xl border border-indigo-200 px-4 py-2.5 text-sm font-medium text-slate-600 hover:border-slate-400">Cancel</button>
      </div>

      <div className="mt-6 border-t border-indigo-100 pt-5">
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500">Reset password</p>
        <div className="flex gap-2">
          <Input value={newPassword} onChange={setNewPassword} placeholder="New password" />
          <button onClick={resetPassword} disabled={busy || newPassword.length < 8} className="whitespace-nowrap rounded-xl border border-indigo-200 px-3 py-2 text-sm font-medium text-slate-700 hover:border-slate-400 disabled:opacity-40">Reset</button>
        </div>
      </div>
    </Drawer>
  );
}

// Everyone sees their own role; only an Admin can pick another one.
const options_roles = (current: string, canChange: boolean) => (canChange ? ["EMPLOYEE", "MANAGER", "HR", "ADMIN"] : [current]);

// ===========================================================================
// TEAMS
// ===========================================================================

// The projects service answers with short codes; turn them into sentences.
function coManagerMessage(e: unknown) {
  const code = e instanceof Error ? e.message : "";
  const map: Record<string, string> = {
    NOT_A_MANAGER: "Only a Manager or an Admin can be a manager. Change their role first.",
    ALREADY_PRIMARY_MANAGER: "That person is already this team's main manager.",
    NOT_YOUR_COMPANY: "You can only pick managers from companies you handle.",
    FEATURES_NOT_READY: "Co-managers are not switched on in this database yet.",
    MANAGER_NOT_FOUND: "That person can't be a manager.",
    NOT_ALLOWED: "Only HR and Admin can change managers.",
  };
  return map[code] ?? (code || "Could not change co-managers");
}

function TeamsTab({ options, onError, onDone }: TabProps) {
  const [teams, setTeams] = useState<TeamRow[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [teamType, setTeamType] = useState("OTHER");
  const [managerId, setManagerId] = useState("");
  const [shiftId, setShiftId] = useState("");
  const [addTo, setAddTo] = useState<Record<string, string>>({});
  const [coAdd, setCoAdd] = useState<Record<string, string>>({});

  async function addCoManager(teamId: string) {
    const userId = coAdd[teamId];
    if (!userId) return;
    try {
      await call(`/projects/${teamId}/co-managers`, "POST", { userId });
      setCoAdd((s) => ({ ...s, [teamId]: "" }));
      onDone("Co-manager added.");
      void load();
    } catch (e) {
      onError(coManagerMessage(e));
    }
  }

  async function removeCoManager(teamId: string, userId: string) {
    try {
      await call(`/projects/${teamId}/co-managers/${userId}/remove`, "POST", {});
      onDone("Co-manager removed.");
      void load();
    } catch (e) {
      onError(coManagerMessage(e));
    }
  }

  const load = useCallback(async () => {
    try {
      const [t, u] = await Promise.all([
        call<{ teams: TeamRow[] }>("/admin/teams"),
        call<{ users: Person[] }>("/admin/users"),
      ]);
      setTeams(t.teams);
      setPeople(u.users);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Could not load teams");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function create() {
    try {
      await call("/admin/teams", "POST", { name, teamType, managerId, shiftId });
      setCreating(false);
      setName("");
      onDone(`Team "${name}" created, with thresholds from the platform defaults.`);
      void load();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Could not create the team");
    }
  }

  async function addMember(teamId: string) {
    const userId = addTo[teamId];
    if (!userId) return;
    try {
      await call(`/admin/teams/${teamId}/members`, "POST", { userId });
      setAddTo((s) => ({ ...s, [teamId]: "" }));
      onDone("Member added.");
      void load();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Could not add that person");
    }
  }

  async function removeMember(teamId: string, userId: string) {
    try {
      await call(`/admin/teams/${teamId}/members/${userId}`, "DELETE");
      onDone("Member removed.");
      void load();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Could not remove that person");
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <button
          onClick={() => setCreating(true)}
          className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
        >
          + New team
        </button>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {teams.map((t) => (
          <div key={t.id} className="rounded-2xl bg-white shadow-[var(--shadow-card)] p-5">
            <div className="flex items-start justify-between">
              <div>
                <h3 className="font-medium text-slate-900">{t.name}</h3>
                <p className="mt-0.5 text-xs text-slate-500">
                  {t.teamType.toLowerCase()} · {t.memberCount} member
                  {t.memberCount === 1 ? "" : "s"}
                  {t.shift ? ` · ${t.shift.name}` : ""}
                </p>
              </div>
              {t.manager && (
                <span className="rounded-md bg-[#E7F6F1] px-2 py-0.5 text-xs text-slate-600">
                  {t.manager.name}
                </span>
              )}
            </div>

            <div className="mt-3 rounded-xl border border-indigo-100 p-3">
              <p className="text-xs font-medium text-slate-600">
                Co-managers <span className="font-normal text-slate-400">— same authority as the main manager</span>
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {t.coManagers.length === 0 && <span className="text-xs text-slate-400">None</span>}
                {t.coManagers.map((c) => (
                  <span key={c.id} className="inline-flex items-center gap-1 rounded-full bg-[#E7F6F1] py-1 pl-2.5 pr-1.5 text-xs text-slate-700">
                    {c.name}
                    <button type="button" onClick={() => removeCoManager(t.id, c.id)} aria-label={`Remove ${c.name}`} className="text-slate-400 hover:text-rose-600">×</button>
                  </span>
                ))}
              </div>
              <div className="mt-2 flex gap-2">
                <select
                  value={coAdd[t.id] ?? ""}
                  onChange={(e) => setCoAdd((s) => ({ ...s, [t.id]: e.target.value }))}
                  className="flex-1 rounded-xl border border-indigo-200 px-3 py-1.5 text-sm"
                >
                  <option value="">Add a co-manager…</option>
                  {(options?.managers ?? [])
                    .filter((m) => m.id !== t.manager?.id && !t.coManagers.some((c) => c.id === m.id))
                    .map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name} ({roleLabel(m.role)})
                      </option>
                    ))}
                </select>
                <button
                  onClick={() => addCoManager(t.id)}
                  disabled={!coAdd[t.id]}
                  className="rounded-xl border border-indigo-200 px-3 py-1.5 text-sm text-slate-700 hover:border-slate-400 disabled:opacity-40"
                >
                  Add
                </button>
              </div>
            </div>

            <ul className="mt-4 divide-y divide-indigo-50 border-t border-indigo-50">
              {t.members.map((m) => (
                <li key={m.userId} className="flex items-center justify-between py-2">
                  <span className="text-sm text-slate-700">
                    {m.name}
                    <span className="ml-2 text-xs text-slate-400">{m.employeeCode}</span>
                  </span>
                  <button
                    onClick={() => removeMember(t.id, m.userId)}
                    className="text-xs text-slate-300 transition hover:text-rose-600"
                  >
                    Remove
                  </button>
                </li>
              ))}
              {t.members.length === 0 && (
                <li className="py-3 text-sm text-slate-400">No members yet.</li>
              )}
            </ul>

            <div className="mt-3 flex gap-2">
              <select
                value={addTo[t.id] ?? ""}
                onChange={(e) => setAddTo((s) => ({ ...s, [t.id]: e.target.value }))}
                className="flex-1 rounded-xl border border-indigo-200 px-3 py-1.5 text-sm"
              >
                <option value="">Add someone…</option>
                {people
                  .filter((p) => !t.members.some((m) => m.userId === p.id))
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
              </select>
              <button
                onClick={() => addMember(t.id)}
                disabled={!addTo[t.id]}
                className="rounded-xl border border-indigo-200 px-3 py-1.5 text-sm text-slate-700 hover:border-slate-400 disabled:opacity-40"
              >
                Add
              </button>
            </div>
          </div>
        ))}
      </div>

      {creating && (
        <Drawer title="New team" onClose={() => setCreating(false)}>
          <Field label="Name">
            <Input value={name} onChange={setName} />
          </Field>
          <Field label="Type">
            <Select value={teamType} onChange={setTeamType}>
              {options?.teamTypes.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Manager">
            <Select value={managerId} onChange={setManagerId}>
              <option value="">None</option>
              {options?.managers.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} ({roleLabel(m.role)})
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Shift">
            <Select value={shiftId} onChange={setShiftId}>
              <option value="">None</option>
              {options?.shifts.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
          <button
            onClick={create}
            disabled={!name.trim()}
            className="w-full rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-40"
          >
            Create team
          </button>
        </Drawer>
      )}
    </div>
  );
}

// ===========================================================================
// SHIFTS
// ===========================================================================

function ShiftsTab({ onError, onDone }: TabProps) {
  const [shifts, setShifts] = useState<ShiftRow[]>([]);
  const [editing, setEditing] = useState<ShiftRow | "new" | null>(null);

  const load = useCallback(async () => {
    try {
      setShifts((await call<{ shifts: ShiftRow[] }>("/admin/shifts")).shifts);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Could not load shifts");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-slate-500">
          Late login is measured against each person&apos;s shift, never one global time.
        </p>
        <button
          onClick={() => setEditing("new")}
          className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
        >
          + New shift
        </button>
      </div>

      <div className="overflow-hidden rounded-2xl bg-white shadow-[var(--shadow-card)]">
        <table className="min-w-full text-sm">
          <thead className="bg-[#F3F7F6] text-left text-xs font-medium uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Hours</th>
              <th className="px-4 py-3">Working days</th>
              <th className="px-4 py-3">Default</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-indigo-50">
            {shifts.map((s) => (
              <tr key={s.id} className="hover:bg-indigo-50/60/70">
                <td className="px-4 py-3 font-medium text-slate-900">{s.name}</td>
                <td className="px-4 py-3 tabular-nums text-slate-600">
                  {s.startTime}–{s.endTime}
                  {s.spansMidnight && (
                    <span className="ml-2 text-xs text-slate-400">overnight</span>
                  )}
                </td>
                <td className="px-4 py-3 text-slate-600">
                  {s.workingDays.map((d) => DAY_LABELS[d]).join(" ")}
                </td>
                <td className="px-4 py-3">
                  {s.isDefault && (
                    <span className="rounded-md bg-indigo-600 px-2 py-0.5 text-xs text-white">
                      default
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 text-right">
                  <button
                    onClick={() => setEditing(s)}
                    className="text-xs font-medium text-slate-500 hover:text-slate-900"
                  >
                    Edit
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {shifts.length === 0 && (
          <p className="px-4 py-10 text-center text-sm text-slate-400">No shifts yet.</p>
        )}
      </div>

      {editing && (
        <ShiftDrawer
          shift={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(m) => {
            setEditing(null);
            onDone(m);
            void load();
          }}
          onError={onError}
        />
      )}
    </div>
  );
}

function ShiftDrawer({
  shift,
  onClose,
  onSaved,
  onError,
}: {
  shift: ShiftRow | null;
  onClose: () => void;
  onSaved: (m: string) => void;
  onError: (m: string) => void;
}) {
  const isNew = shift === null;
  const [name, setName] = useState(shift?.name ?? "");
  const [startTime, setStartTime] = useState(shift?.startTime ?? "10:00");
  const [endTime, setEndTime] = useState(shift?.endTime ?? "19:00");
  const [days, setDays] = useState<number[]>(shift?.workingDays ?? [1, 2, 3, 4, 5, 6]);
  const [isDefault, setIsDefault] = useState(shift?.isDefault ?? false);
  const [spansMidnight, setSpansMidnight] = useState(shift?.spansMidnight ?? false);
  const [busy, setBusy] = useState(false);

  function toggleDay(d: number) {
    setDays((prev) =>
      prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d].sort((a, b) => a - b)
    );
  }

  async function save() {
    setBusy(true);
    try {
      const body = { name, startTime, endTime, workingDays: days, isDefault, spansMidnight };
      if (isNew) await call("/admin/shifts", "POST", body);
      else await call(`/admin/shifts/${shift!.id}`, "PATCH", body);
      onSaved(isNew ? `Shift "${name}" created.` : `Shift "${name}" updated.`);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Could not save the shift");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer title={isNew ? "New shift" : shift!.name} onClose={onClose}>
      <Field label="Name">
        <Input value={name} onChange={setName} placeholder="General 10-7" />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Starts">
          <Input value={startTime} onChange={setStartTime} type="time" />
        </Field>
        <Field label="Ends">
          <Input value={endTime} onChange={setEndTime} type="time" />
        </Field>
      </div>

      <Field label="Working days" hint="Days not selected count as weekly offs.">
        <div className="flex gap-1">
          {[1, 2, 3, 4, 5, 6, 7].map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => toggleDay(d)}
              className={`flex-1 rounded-xl border px-2 py-2 text-xs font-medium transition ${
                days.includes(d)
                  ? "border-indigo-600 bg-indigo-600 text-white"
                  : "border-indigo-200 text-slate-500 hover:border-slate-400"
              }`}
            >
              {DAY_LABELS[d]}
            </button>
          ))}
        </div>
      </Field>

      <Toggle
        checked={spansMidnight}
        onChange={setSpansMidnight}
        label="Overnight shift"
        hint="For shifts that end on the following calendar day."
      />
      <Toggle
        checked={isDefault}
        onChange={setIsDefault}
        label="Platform default"
        hint="Setting this removes the default flag from any other shift."
      />

      <button
        onClick={save}
        disabled={busy || !name.trim() || days.length === 0}
        className="w-full rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-40"
      >
        {busy ? "Saving…" : isNew ? "Create shift" : "Save changes"}
      </button>
    </Drawer>
  );
}

// ===========================================================================
// THRESHOLDS
// ===========================================================================

const THRESHOLD_FIELDS: { key: string; label: string; hint: string; step?: string }[] = [
  { key: "dailyWorkHours", label: "Daily work hours", hint: "Length of the working day", step: "0.5" },
  { key: "productiveHours", label: "Productive target", hint: "Attainment is measured against this", step: "0.5" },
  { key: "breakBudgetMinutes", label: "Break budget (min)", hint: "Total break time allowed per day" },
  { key: "lateLoginGraceMinutes", label: "Late grace (min)", hint: "Minutes after shift start before it counts as late" },
  { key: "breakOverageAlertMinutes", label: "Break overage (min)", hint: "0 alerts the moment the budget is exceeded" },
  { key: "overtimeAlertMinutes", label: "Overtime alert (min)", hint: "Minutes past the working day before alerting" },
  { key: "lowProductivityThreshold", label: "Low productivity", hint: "Fraction of the target, e.g. 0.75", step: "0.05" },
  { key: "biometricToleranceMinutes", label: "Biometric tolerance (min)", hint: "Allowed gap between door and tracker" },
];

function ThresholdsTab({ onError, onDone }: TabProps) {
  const [teams, setTeams] = useState<TeamRow[]>([]);
  const [teamId, setTeamId] = useState("");
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await call<{ teams: TeamRow[] }>("/admin/teams");
      setTeams(data.teams);
      if (!teamId && data.teams[0]) selectTeam(data.teams[0]);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Could not load thresholds");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function selectTeam(team: TeamRow) {
    setTeamId(team.id);
    const next: Record<string, string> = {};
    for (const f of THRESHOLD_FIELDS) next[f.key] = String(team.config?.[f.key] ?? "");
    next.eodReportTime = String(team.config?.eodReportTime ?? "19:30");
    setDraft(next);
  }

  async function save() {
    setBusy(true);
    try {
      await call(`/admin/config/${teamId}`, "PATCH", draft);
      onDone("Thresholds saved. The alert engine picks them up on its next run, within 15 minutes.");
      void load();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  const team = teams.find((t) => t.id === teamId);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <select
          value={teamId}
          onChange={(e) => {
            const t = teams.find((x) => x.id === e.target.value);
            if (t) selectTeam(t);
          }}
          className="rounded-xl border border-indigo-200 px-3 py-2 text-sm"
        >
          {teams.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        <p className="text-sm text-slate-500">
          Every alert reads these numbers. Nothing is hardcoded.
        </p>
      </div>

      {team && (
        <div className="rounded-2xl bg-white shadow-[var(--shadow-card)] p-6">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {THRESHOLD_FIELDS.map((f) => (
              <Field key={f.key} label={f.label} hint={f.hint}>
                <Input
                  type="number"
                  step={f.step}
                  value={draft[f.key] ?? ""}
                  onChange={(v) => setDraft((d) => ({ ...d, [f.key]: v }))}
                />
              </Field>
            ))}
            <Field label="EOD report time" hint="24-hour, platform timezone">
              <Input
                type="time"
                value={draft.eodReportTime ?? ""}
                onChange={(v) => setDraft((d) => ({ ...d, eodReportTime: v }))}
              />
            </Field>
          </div>

          <button
            onClick={save}
            disabled={busy}
            className="mt-6 rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-40"
          >
            {busy ? "Saving…" : "Save thresholds"}
          </button>
        </div>
      )}
    </div>
  );
}

// ===========================================================================
// LEAVE
// ===========================================================================

function LeaveTab({ options, onError, onDone }: TabProps) {
  const [rows, setRows] = useState<LeaveRow[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [userId, setUserId] = useState("");
  const [from, setFrom] = useState(todayIso());
  const [to, setTo] = useState(todayIso());
  const [leaveType, setLeaveType] = useState("PLANNED");
  const [isHalfDay, setIsHalfDay] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const month = todayIso().slice(0, 7);
      const [l, u] = await Promise.all([
        call<{ leave: LeaveRow[] }>(`/admin/leave?from=${month}-01&to=${todayIso()}`),
        call<{ users: Person[] }>("/admin/users"),
      ]);
      setRows(l.leave);
      setPeople(u.users);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Could not load leave");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function mark() {
    setBusy(true);
    try {
      const res = await call<{ marked: number }>("/admin/leave", "POST", {
        userId,
        from,
        to,
        leaveType,
        isHalfDay,
        note,
      });
      setNote("");
      onDone(`${res.marked} day${res.marked === 1 ? "" : "s"} marked as leave.`);
      void load();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Could not mark leave");
    } finally {
      setBusy(false);
    }
  }

  async function unmark(row: LeaveRow) {
    try {
      const date = String(row.date).slice(0, 10);
      await call(`/admin/leave?userId=${row.userId}&date=${date}`, "DELETE");
      onDone("Leave removed.");
      void load();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Could not remove that leave day");
    }
  }

  return (
    <div className="space-y-4">
      <div className="rounded-2xl bg-white shadow-[var(--shadow-card)] p-5">
        <p className="mb-4 text-sm text-slate-500">
          A leave day removes that day&apos;s target, so approved leave never drags
          attainment down. Absence without leave does.
        </p>

        <div className="grid gap-3 md:grid-cols-5">
          <Field label="Person">
            <Select value={userId} onChange={setUserId}>
              <option value="">Choose…</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="From">
            <Input type="date" value={from} onChange={setFrom} />
          </Field>
          <Field label="To">
            <Input type="date" value={to} onChange={setTo} />
          </Field>
          <Field label="Type">
            <Select value={leaveType} onChange={setLeaveType}>
              {options?.leaveTypes.map((t) => (
                <option key={t} value={t}>
                  {t.toLowerCase().replace(/_/g, " ")}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Note">
            <Input value={note} onChange={setNote} placeholder="Optional" />
          </Field>
        </div>

        <div className="mt-3 flex items-center gap-4">
          <Toggle checked={isHalfDay} onChange={setIsHalfDay} label="Half day" />
          <button
            onClick={mark}
            disabled={busy || !userId}
            className="ml-auto rounded-xl bg-indigo-600 px-5 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-40"
          >
            {busy ? "Marking…" : "Mark leave"}
          </button>
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl bg-white shadow-[var(--shadow-card)]">
        <table className="min-w-full text-sm">
          <thead className="bg-[#F3F7F6] text-left text-xs font-medium uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-3">Date</th>
              <th className="px-4 py-3">Person</th>
              <th className="px-4 py-3">Type</th>
              <th className="px-4 py-3">Note</th>
              <th className="px-4 py-3">Marked by</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-indigo-50">
            {rows.map((r) => (
              <tr key={r.id} className="hover:bg-indigo-50/60/70">
                <td className="px-4 py-3 tabular-nums text-slate-900">
                  {String(r.date).slice(0, 10)}
                </td>
                <td className="px-4 py-3 text-slate-700">{r.name}</td>
                <td className="px-4 py-3 text-slate-600">
                  {r.leaveType.toLowerCase().replace(/_/g, " ")}
                  {r.isHalfDay && <span className="ml-1 text-xs text-slate-400">half</span>}
                </td>
                <td className="px-4 py-3 text-slate-500">{r.note ?? "—"}</td>
                <td className="px-4 py-3 text-slate-500">{r.markedBy}</td>
                <td className="px-4 py-3 text-right">
                  <button
                    onClick={() => unmark(r)}
                    className="text-xs text-slate-300 hover:text-rose-600"
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && (
          <p className="px-4 py-10 text-center text-sm text-slate-400">
            No leave marked this month.
          </p>
        )}
      </div>
    </div>
  );
}

// ===========================================================================
// Small shared pieces
// ===========================================================================

function Drawer({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  // Rendered into <body> so no parent can clip or offset the full-screen overlay.
  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end">
      <div
        className="absolute inset-0 bg-slate-900/20 backdrop-blur-[1px]"
        onClick={onClose}
      />
      <div className="relative h-full w-full max-w-md overflow-y-auto border-l border-indigo-100 bg-white shadow-xl">
        <div className="sticky top-0 flex items-center justify-between border-b border-indigo-100 bg-white px-6 py-4">
          <h2 className="font-medium text-slate-900">{title}</h2>
          <button
            onClick={onClose}
            className="text-slate-400 transition hover:text-slate-900"
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        <div className="space-y-4 p-6">{children}</div>
      </div>
    </div>,
    document.body
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-xs font-medium uppercase tracking-wide text-slate-500 mb-1.5">
        {label}
      </label>
      {children}
      {hint && <p className="mt-1 text-xs text-slate-400">{hint}</p>}
    </div>
  );
}

function Input({
  value,
  onChange,
  type = "text",
  placeholder,
  disabled,
  step,
  list,
}: {
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
  disabled?: boolean;
  step?: string;
  list?: string; // id of a <datalist> of suggestions (free typing is still allowed)
}) {
  return (
    <input
      type={type}
      list={list}
      step={step}
      value={value}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className="w-full rounded-xl border border-indigo-200 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 outline-none transition focus:border-indigo-500 disabled:bg-[#F3F7F6] disabled:text-slate-400"
    />
  );
}

function Select({
  value,
  onChange,
  children,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  children: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <select
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className="w-full rounded-xl border border-indigo-200 px-3 py-2 text-sm text-slate-900 outline-none focus:border-indigo-500 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-500"
    >
      {children}
    </select>
  );
}

function Toggle({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 rounded border-indigo-200"
      />
      <span>
        <span className="block text-sm text-slate-800">{label}</span>
        {hint && <span className="block text-xs text-slate-400">{hint}</span>}
      </span>
    </label>
  );
}
