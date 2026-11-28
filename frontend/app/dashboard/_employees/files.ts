// Browser-side file helpers for the employee import: read an upload as base64,
// build CSV downloads, fetch the template with the signed-in token.

import { API_BASE, getToken } from "@/lib/api";
import type { Credential, RowResult } from "./types";

export function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read that file."));
    reader.onload = () => {
      // "data:<type>;base64,<payload>"
      const result = String(reader.result ?? "");
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.readAsDataURL(file);
  });
}

const esc = (v: unknown) => {
  const s = String(v ?? "");
  // A leading = + - @ makes a spreadsheet run the cell as a formula. Employee
  // data is typed by people, so it is neutralised before it goes into a file.
  const safe = /^[=+\-@]/.test(s) && !/^[+-]?\d[\d\s.-]*$/.test(s) ? `'${s}` : s;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export function toCsv(rows: unknown[][]) {
  return "﻿" + rows.map((r) => r.map(esc).join(",")).join("\r\n") + "\r\n";
}

export function download(filename: string, text: string, type = "text/csv;charset=utf-8") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function downloadTemplate() {
  const res = await fetch(`${API_BASE}/admin/employees/template`, {
    headers: { Authorization: `Bearer ${getToken() ?? ""}` },
  });
  if (!res.ok) throw new Error("Could not download the template.");
  download("employee-import-template.csv", await res.text());
}

/** The same template as a real Excel file (built from the server's CSV, so the headings always match). */
export async function downloadTemplateXlsx() {
  const res = await fetch(`${API_BASE}/admin/employees/template`, { headers: { Authorization: `Bearer ${getToken() ?? ""}` } });
  if (!res.ok) throw new Error("Could not download the template.");
  const { buildTemplateWorkbook, readCsv } = await import("./templateXlsx");
  const [headers, example] = readCsv(await res.text());
  const buffer = await buildTemplateWorkbook(headers, example ?? []);
  const url = URL.createObjectURL(new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = "employee-import-template.xlsx";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Everything HR needs to fix and re-upload: the original values plus why each
// row was refused.
export function errorReportCsv(rows: RowResult[]) {
  const bad = rows.filter((r) => r.status === "INVALID");
  return toCsv([
    [
      "Row", "Company", "Full name", "Employee ID", "Work email", "Mobile number", "Designation",
      "Team or department", "Projects", "System role", "Reports to", "Date of joining", "Shift", "Problems",
    ],
    ...bad.map((r) => [
      r.rowNumber, r.values.company, r.values.fullName, r.values.employeeId, r.values.email, r.values.mobile,
      r.values.designation, r.values.team, r.values.projects, r.values.role, r.values.reportsTo,
      r.values.dateOfJoining, r.values.shift,
      r.issues.filter((i) => i.severity === "error").map((i) => i.message).join(" | "),
    ]),
  ]);
}

export function credentialsCsv(list: Credential[]) {
  return toCsv([
    ["Employee ID", "Name", "Company", "Sign in with", "Temporary password (change at first sign-in)"],
    ...list.map((c) => [c.employeeId, c.name, c.company, c.signInWith, c.temporaryPassword]),
  ]);
}

export function updateErrorReportCsv(rows: { rowNumber: number; status: string; employeeId: string; name: string; issues: { severity: string; message: string }[] }[]) {
  return toCsv([
    ["Row", "Employee ID", "Name", "Problems"],
    ...rows
      .filter((r) => r.status === "INVALID")
      .map((r) => [r.rowNumber, r.employeeId, r.name, r.issues.filter((i) => i.severity === "error").map((i) => i.message).join(" | ")]),
  ]);
}
