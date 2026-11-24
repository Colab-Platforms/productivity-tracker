"use client";

// The "Assign Tasks" tab of Daily Tasks, for an Employee who holds the TASK_ASSIGN_COMPANY capability (the Productivity Supervisors). Two parts:
//   Assign New Task      the same form managers use (reused), as a card, with every active employee of the person's own company to choose from
//   Tasks Assigned by Me the same list (reused) to follow progress, without the manager-only buttons
// The server decides who may do this (backend tasks.assigned.ts); this screen only shows what it allows.
import { useEffect, useState } from "react";
import { apiGet } from "@/lib/api";
import { ViewTabs } from "./ViewTabs";
import AssignedByMe, { TaskForm, type Person } from "./AssignedByMe";

export default function AssignTasks() {
  const [sub, setSub] = useState<"new" | "mine">("new");
  const [people, setPeople] = useState<Person[] | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [formKey, setFormKey] = useState(0);

  useEffect(() => {
    let live = true;
    apiGet<{ people: Person[] }>("/tasks/assigned/people").then((r) => live && setPeople(r.people)).catch((e: Error) => live && setError(e.message));
    return () => { live = false; };
  }, []);

  return (
    <div className="space-y-4" data-testid="assign-tasks">
      <ViewTabs
        label="Assign tasks"
        value={sub}
        onChange={(k) => { setSub(k as "new" | "mine"); setNotice(""); }}
        tabs={[{ key: "new", label: "Assign New Task" }, { key: "mine", label: "Tasks Assigned by Me" }]}
      />
      {error && <p role="alert" className="rounded-xl bg-rose-50 px-4 py-2 text-sm text-rose-800">{error}</p>}
      {sub === "new" && (
        <>
          {notice && (
            <div role="status" className="flex items-start justify-between gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900" data-testid="assign-notice">
              <span>{notice} <button type="button" onClick={() => { setSub("mine"); setNotice(""); }} className="font-medium underline">See it in Tasks Assigned by Me</button></span>
              <button type="button" onClick={() => setNotice("")} className="shrink-0 text-emerald-700 hover:underline">Dismiss</button>
            </div>
          )}
          {!people && !error ? <div className="skeleton h-40" aria-busy="true" /> : (
            <TaskForm
              key={formKey}
              inline
              company
              people={people ?? []}
              task={null}
              onClose={() => setFormKey((n) => n + 1)}
              onSaved={() => { setNotice("Task assigned. The employee has been notified."); setFormKey((n) => n + 1); }}
            />
          )}
        </>
      )}
      {sub === "mine" && <AssignedByMe assigner />}
    </div>
  );
}
