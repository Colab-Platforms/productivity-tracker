"use client";

import { useState } from "react";
import AddEmployeeModal from "./AddEmployeeModal";
import ImportEmployeesModal from "./ImportEmployeesModal";

// The two entry points, used by the HR dashboard and the Employees page so
// both always offer the same thing. Rendered only for people the backend lets
// in (HR and Admin); the backend enforces that regardless of what is shown.
export default function EmployeeActions({
  onDone,
  className = "",
}: {
  onDone?: (message: string) => void;
  className?: string;
}) {
  const [open, setOpen] = useState<"add" | "import" | "update" | null>(null);
  const close = () => setOpen(null);
  const done = (m: string) => onDone?.(m);

  return (
    <>
      <div className={`flex flex-wrap items-center gap-2 ${className}`}>
        <button
          onClick={() => setOpen("add")}
          className="flex h-10 items-center gap-1.5 whitespace-nowrap rounded-xl bg-indigo-600 px-3 text-sm font-medium text-white shadow-md shadow-indigo-600/25 transition hover:bg-indigo-700"
        >
          <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M10 4v12M4 10h12" strokeLinecap="round" />
          </svg>
          Add Employee
        </button>
        <button
          onClick={() => setOpen("import")}
          className="flex h-10 items-center gap-1.5 whitespace-nowrap rounded-xl border border-indigo-200 bg-white px-3 text-sm font-medium text-indigo-700 transition hover:bg-indigo-50"
        >
          <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M10 13V3m0 0L6.5 6.5M10 3l3.5 3.5M4 13v3a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Import Employees
        </button>
        <button
          onClick={() => setOpen("update")}
          title="Fill in missing details (manager, team, role, shift...) for people already in the system"
          className="flex h-10 items-center gap-1.5 whitespace-nowrap rounded-xl border border-indigo-200 bg-white px-3 text-sm font-medium text-indigo-700 transition hover:bg-indigo-50"
        >
          <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M4 10a6 6 0 0 1 10.2-4.3L16 7.5M16 4v3.5h-3.5M16 10a6 6 0 0 1-10.2 4.3L4 12.5M4 16v-3.5h3.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Update Employees
        </button>
      </div>

      {open === "add" && <AddEmployeeModal onClose={close} onDone={done} />}
      {open === "import" && <ImportEmployeesModal onClose={close} onDone={done} />}
      {open === "update" && <ImportEmployeesModal mode="update" onClose={close} onDone={done} />}
    </>
  );
}
