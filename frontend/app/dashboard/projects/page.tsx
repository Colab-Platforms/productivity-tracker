"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiGet, apiPost } from "@/lib/api";
import { plural } from "@/lib/plural";
import { useMe } from "../layout";
import { useRoleGate } from "../_routing/useRoleGate";

// ---------------------------------------------------------------------------
// PROJECTS
// HR puts people on projects; the manager comes along automatically because
// the project already has one. Moving someone moves who approves their work.
// ---------------------------------------------------------------------------

type Member = {
  id: string;
  name: string;
  employeeCode: string | null;
  designation: string | null;
  status: string;
  isPrimary: boolean;
};

type Project = {
  id: string;
  name: string;
  isActive: boolean;
  companyId: string;
  company: string | null;
  managerId: string | null;
  manager: string | null;
  coManagers: { id: string; name: string; employeeCode: string | null }[];
  directReports: { id: string; name: string; employeeCode: string | null; designation: string | null; status: string; company: string | null }[];
  members: Member[];
};

type Person = {
  id: string;
  name: string;
  employeeCode: string | null;
  designation: string | null;
  role: string;
  company: string | null;
};

type ManagerPick = { id: string; name: string; employeeCode: string | null; role: string; company: string | null };

type Data = {
  managers: ManagerPick[];
  canManage: boolean;
  companies: { id: string; name: string }[];
  assignable: Person[];
  projects: Project[];
};

const MESSAGES: Record<string, string> = {
  NAME_REQUIRED: "Give the project a name.",
  PROJECT_EXISTS: "That company already has a project with this name.",
  NOT_YOUR_COMPANY: "You can't manage that company.",
  NOT_ALLOWED: "Only HR and Admin can change projects.",
  NOT_A_MEMBER: "They're not on that project.",
  USER_REQUIRED: "Pick somebody first.",
  ALREADY_PRIMARY_MANAGER: "That person is already this project's main manager.",
  FEATURES_NOT_READY: "Co-managers are not switched on in this database yet.",
  MANAGER_NOT_FOUND: "That person can't be a manager.",
  NOT_A_MANAGER: "Only a Manager or an Admin can be a manager. Change their role in Admin first.",
};

const say = (err: unknown) => {
  const code = err instanceof Error ? err.message : "UNKNOWN";
  return MESSAGES[code] ?? "Something went wrong.";
};

export default function ProjectsPage() {
  const { me, allowed } = useRoleGate(["ADMIN"]); // Project management is Admin-only; anyone else is sent to their own home
  if (!me || !allowed) return <div className="p-8"><p className="rounded-2xl bg-white p-6 text-sm text-slate-600 shadow-[var(--shadow-card)]">Project management is only available to Admin.</p></div>;
  return <ProjectsInner />;
}

function ProjectsInner() {
  const me = useMe();

  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [adding, setAdding] = useState("");
  const [coAdding, setCoAdding] = useState("");

  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: "", companyId: "", managerId: "" });

  const load = useCallback(async () => {
    try {
      const res = await apiGet<Data>("/projects");
      setData(res);
      setError("");
    } catch (err) {
      setError(say(err));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function run(fn: () => Promise<Data>, message: string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      setData(await fn());
      setNotice(message);
    } catch (err) {
      setError(say(err));
    } finally {
      setBusy(false);
    }
  }

  const byCompany = useMemo(() => {
    const map = new Map<string, Project[]>();
    for (const p of data?.projects ?? []) {
      const key = p.company ?? "No company";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(p);
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [data]);

  if (!me) return null;

  const canManage = data?.canManage ?? false;
  const totalPeople = new Set(
    (data?.projects ?? []).flatMap((p) => p.members.map((m) => m.id))
  ).size;

  return (
    <div className="p-8 page-5xl">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm text-slate-400">Setup</p>
          <h1 className="mt-0.5 text-2xl font-semibold text-slate-900">
            Projects
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-slate-500">
            Each project has one manager. Put someone on a project and that
            manager approves their work — no second step.
          </p>
        </div>
        {canManage && (
          <button
            onClick={() => {
              setCreating((v) => !v);
              setForm({
                name: "",
                companyId: data?.companies[0]?.id ?? "",
                managerId: "",
              });
            }}
            className="rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-indigo-700"
          >
            {creating ? "Cancel" : "New project"}
          </button>
        )}
      </header>

      <div className="mb-6 flex flex-wrap gap-2">
        <span className="rounded-full border border-indigo-100 bg-white px-3 py-1 text-xs text-slate-600">
          {data?.projects.length ?? 0} projects
        </span>
        <span className="rounded-full border border-indigo-100 bg-white px-3 py-1 text-xs text-slate-600">
          {byCompany.length} companies
        </span>
        <span className="rounded-full border border-indigo-100 bg-white px-3 py-1 text-xs text-slate-600">
          {plural(totalPeople, "person", "people")} assigned
        </span>
      </div>

      {error && (
        <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-700">
          {error}
        </div>
      )}
      {notice && (
        <div className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm text-emerald-800">
          {notice}
        </div>
      )}

      {creating && canManage && (
        <section className="mb-6 rounded-2xl bg-white shadow-[var(--shadow-card)] p-5">
          <h2 className="mb-4 text-sm font-medium text-slate-900">
            New project
          </h2>
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-48 flex-1">
              <label className="mb-1.5 block text-xs text-slate-500">
                Project name
              </label>
              <input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="Sales CRM, AI Tools, e-Sports…"
                className="w-full rounded-xl border border-indigo-100 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-xs text-slate-500">
                Company
              </label>
              <select
                value={form.companyId}
                onChange={(e) => setForm({ ...form, companyId: e.target.value })}
                className="rounded-xl border border-indigo-100 px-3 py-2 text-sm text-slate-900"
              >
                {(data?.companies ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1.5 block text-xs text-slate-500">
                Manager
              </label>
              <select
                value={form.managerId}
                onChange={(e) => setForm({ ...form, managerId: e.target.value })}
                className="rounded-xl border border-indigo-100 px-3 py-2 text-sm text-slate-900"
              >
                <option value="">Decide later</option>
                {(data?.managers ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} {p.employeeCode ? `(${p.employeeCode})` : ""}
                  </option>
                ))}
              </select>
            </div>
            <button
              disabled={busy || form.name.trim() === ""}
              onClick={() =>
                run(
                  () =>
                    apiPost<Data>("/projects", {
                      name: form.name.trim(),
                      companyId: form.companyId,
                      managerId: form.managerId || null,
                    }),
                  `Created ${form.name.trim()}.`
                ).then(() => {
                  setCreating(false);
                  setForm({ name: "", companyId: "", managerId: "" });
                })
              }
              className="rounded-xl bg-indigo-600 px-5 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-40"
            >
              Create
            </button>
          </div>
          <p className="mt-3 text-xs text-slate-400">
            Naming someone as manager gives them the Manager role if they
            don&apos;t already have it — otherwise they&apos;d run a project
            with no Approvals screen.
          </p>
        </section>
      )}

      {byCompany.length === 0 ? (
        <div className="rounded-2xl bg-white shadow-[var(--shadow-card)] px-6 py-14 text-center">
          <p className="text-sm text-slate-500">No projects yet.</p>
        </div>
      ) : (
        <div className="space-y-6">
          {byCompany.map(([company, list]) => (
            <div key={company}>
              <h2 className="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
                {company}
              </h2>

              <div className="space-y-3">
                {list.map((p) => {
                  const open = openId === p.id;
                  const already = new Set(p.members.map((m) => m.id));
                  const options = (data?.assignable ?? []).filter(
                    (a) => !already.has(a.id)
                  );

                  return (
                    <section
                      key={p.id}
                      className={`overflow-hidden rounded-2xl border bg-white ${
                        p.isActive ? "border-indigo-100" : "border-indigo-100 opacity-60"
                      }`}
                    >
                      <button
                        onClick={() => setOpenId(open ? null : p.id)}
                        className="flex w-full items-center gap-4 px-5 py-4 text-left hover:bg-indigo-50/60/60"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="font-medium text-slate-900">{p.name}</p>
                          <p className="mt-0.5 text-xs text-slate-400">
                            {p.manager
                              ? `Managed by ${p.manager}${
                                  p.coManagers.length
                                    ? ` + ${p.coManagers.map((c) => c.name).join(", ")}`
                                    : ""
                                }`
                              : "No manager — nobody approves this work"}
                          </p>
                        </div>
                        <span className="shrink-0 rounded-full bg-[#E7F6F1] px-2.5 py-1 text-xs font-medium text-slate-600">
                          {p.members.length}{" "}
                          {p.members.length === 1 ? "person" : "people"}
                          {p.directReports.length > 0 ? ` + ${p.directReports.length} report directly` : ""}
                        </span>
                        <svg
                          viewBox="0 0 20 20"
                          className={`h-4 w-4 shrink-0 text-slate-400 ${
                            open ? "rotate-180" : ""
                          }`}
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.8"
                        >
                          <path d="m5 8 5 5 5-5" strokeLinecap="round" />
                        </svg>
                      </button>

                      {open && (
                        <div className="border-t border-indigo-50 bg-slate-50/50 px-5 py-4">
                          {!p.manager && canManage && (
                            <div className="mb-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                              Set a manager below — until then, tasks on this
                              project have nobody to approve them.
                            </div>
                          )}

                          {canManage && (
                            <div className="mb-4 flex flex-wrap items-end gap-2">
                              <div className="min-w-56 flex-1">
                                <label className="mb-1.5 block text-xs text-slate-500">
                                  Add someone
                                </label>
                                <select
                                  value={openId === p.id ? adding : ""}
                                  onChange={(e) => setAdding(e.target.value)}
                                  className="w-full rounded-xl border border-indigo-100 bg-white px-3 py-2 text-sm text-slate-900"
                                >
                                  <option value="">Choose a person…</option>
                                  {options.map((o) => (
                                    <option key={o.id} value={o.id}>
                                      {o.name}
                                      {o.employeeCode ? ` · ${o.employeeCode}` : ""}
                                      {o.company ? ` · ${o.company}` : ""}
                                    </option>
                                  ))}
                                </select>
                              </div>
                              <button
                                disabled={busy || !adding}
                                onClick={() =>
                                  run(
                                    () =>
                                      apiPost<Data>(
                                        `/projects/${p.id}/members`,
                                        { userId: adding }
                                      ),
                                    "Added to the project."
                                  ).then(() => setAdding(""))
                                }
                                className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-40"
                              >
                                Add
                              </button>
                              <select
                                value={p.managerId ?? ""}
                                onChange={(e) =>
                                  run(
                                    () =>
                                      apiPost<Data>("/projects", {
                                        id: p.id,
                                        name: p.name,
                                        managerId: e.target.value || null,
                                      }),
                                    "Manager changed — their team follows."
                                  )
                                }
                                className="rounded-xl border border-indigo-100 bg-white px-3 py-2 text-sm text-slate-900"
                              >
                                <option value="">No manager</option>
                                {/* the current manager stays listed even if they are not a Manager/Admin by role */}
                                {p.managerId && p.manager && !(data?.managers ?? []).some((a) => a.id === p.managerId) && (
                                  <option value={p.managerId}>Manager: {p.manager} (current)</option>
                                )}
                                {(data?.managers ?? [])
                                  .map((a) => (
                                  <option key={a.id} value={a.id}>
                                    Manager: {a.name}
                                  </option>
                                ))}
                              </select>
                            </div>
                          )}

                          {(canManage || p.coManagers.length > 0) && (
                            <div className="mb-4 rounded-xl bg-white p-3 shadow-[var(--shadow-card)]">
                              <p className="text-xs font-medium text-slate-600">
                                Co-managers{" "}
                                <span className="font-normal text-slate-400">
                                  — same authority as the main manager
                                </span>
                              </p>
                              <div className="mt-2 flex flex-wrap items-center gap-2">
                                {p.coManagers.length === 0 && (
                                  <span className="text-xs text-slate-400">None</span>
                                )}
                                {p.coManagers.map((c) => (
                                  <span
                                    key={c.id}
                                    className="inline-flex items-center gap-1.5 rounded-full bg-[#E7F6F1] px-2.5 py-1 text-xs text-slate-700"
                                  >
                                    {c.name}
                                    {canManage && (
                                      <button
                                        disabled={busy}
                                        onClick={() =>
                                          run(
                                            () =>
                                              apiPost<Data>(
                                                `/projects/${p.id}/co-managers/${c.id}/remove`,
                                                {}
                                              ),
                                            "Co-manager removed."
                                          )
                                        }
                                        className="text-slate-400 hover:text-red-600"
                                        aria-label={`Remove ${c.name}`}
                                      >
                                        ×
                                      </button>
                                    )}
                                  </span>
                                ))}
                              </div>
                              {canManage && (
                                <div className="mt-3 flex flex-wrap items-center gap-2">
                                  <select
                                    value={openId === p.id ? coAdding : ""}
                                    onChange={(e) => setCoAdding(e.target.value)}
                                    className="min-w-56 flex-1 rounded-xl border border-indigo-100 bg-white px-3 py-2 text-sm text-slate-900"
                                  >
                                    <option value="">Choose a co-manager…</option>
                                    {(data?.managers ?? [])
                                      .filter(
                                        (a) =>
                                          a.id !== p.managerId &&
                                          !p.coManagers.some((c) => c.id === a.id)
                                      )
                                      .map((a) => (
                                        <option key={a.id} value={a.id}>
                                          {a.name}
                                          {a.employeeCode ? ` · ${a.employeeCode}` : ""}
                                        </option>
                                      ))}
                                  </select>
                                  <button
                                    disabled={busy || !coAdding}
                                    onClick={() =>
                                      run(
                                        () =>
                                          apiPost<Data>(`/projects/${p.id}/co-managers`, {
                                            userId: coAdding,
                                          }),
                                        "Co-manager added."
                                      ).then(() => setCoAdding(""))
                                    }
                                    className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-40"
                                  >
                                    Add co-manager
                                  </button>
                                </div>
                              )}
                            </div>
                          )}

                          {p.members.length === 0 ? (
                            <p className="py-3 text-sm text-slate-500">
                              Nobody on this project yet.
                            </p>
                          ) : (
                            <ul className="divide-y divide-indigo-50 overflow-hidden rounded-2xl bg-white shadow-[var(--shadow-card)]">
                              {p.members.map((m) => (
                                <li
                                  key={m.id}
                                  className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5"
                                >
                                  <div className="min-w-0">
                                    <div className="flex items-center gap-2">
                                      <p className="text-sm font-medium text-slate-900">
                                        {m.name}
                                      </p>
                                      {m.isPrimary && (
                                        <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] font-medium text-indigo-700">
                                          main project
                                        </span>
                                      )}
                                    </div>
                                    <p className="text-xs text-slate-400">
                                      {m.employeeCode ?? "—"}
                                      {m.designation ? ` · ${m.designation}` : ""}
                                    </p>
                                  </div>

                                  {canManage && (
                                    <div className="flex shrink-0 gap-2">
                                      {!m.isPrimary && (
                                        <button
                                          disabled={busy}
                                          onClick={() =>
                                            run(
                                              () =>
                                                apiPost<Data>(
                                                  `/projects/${p.id}/members/${m.id}/primary`
                                                ),
                                              `${p.name} is now their main project.`
                                            )
                                          }
                                          className="rounded-xl border border-indigo-100 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-indigo-50/60 disabled:opacity-40"
                                        >
                                          Make main
                                        </button>
                                      )}
                                      <button
                                        disabled={busy}
                                        onClick={() =>
                                          run(
                                            () =>
                                              apiPost<Data>(
                                                `/projects/${p.id}/members/${m.id}/remove`
                                              ),
                                            "Removed from the project."
                                          )
                                        }
                                        className="rounded-xl border border-indigo-100 px-3 py-1.5 text-xs font-medium text-slate-500 hover:border-red-200 hover:text-red-600 disabled:opacity-40"
                                      >
                                        Remove
                                      </button>
                                    </div>
                                  )}
                                </li>
                              ))}
                            </ul>
                          )}

                          {p.directReports.length > 0 && (
                            <div className="mt-4">
                              <p className="mb-2 text-xs font-medium text-slate-600">
                                Report directly to {p.manager ?? "the manager"}
                                {p.coManagers.length > 0 ? " or a co-manager" : ""}{" "}
                                <span className="font-normal text-slate-400">
                                  — not members of this project, but this manager sees and approves their work
                                </span>
                              </p>
                              <ul className="divide-y divide-indigo-50 overflow-hidden rounded-2xl bg-white shadow-[var(--shadow-card)]">
                                {p.directReports.map((r) => (
                                  <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5">
                                    <div className="min-w-0">
                                      <p className="text-sm font-medium text-slate-900">{r.name}</p>
                                      <p className="mt-0.5 text-xs text-slate-400">
                                        {r.employeeCode}
                                        {r.designation ? ` · ${r.designation}` : ""}
                                        {r.company ? ` · ${r.company}` : ""}
                                      </p>
                                    </div>
                                    {canManage && (
                                      <button
                                        disabled={busy}
                                        onClick={() =>
                                          run(
                                            () => apiPost<Data>(`/projects/${p.id}/members`, { userId: r.id }),
                                            `${r.name} added to the project.`
                                          )
                                        }
                                        className="rounded-xl border border-indigo-100 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-indigo-50/60 disabled:opacity-40"
                                      >
                                        Add to project
                                      </button>
                                    )}
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )}
                        </div>
                      )}
                    </section>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}