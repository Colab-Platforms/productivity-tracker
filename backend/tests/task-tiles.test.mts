// Every Tasks & Performance tile: its number must equal the tasks listed behind it. No DB.
import { countRows, tileMembers, type Row, type TileKey } from "../../frontend/app/dashboard/approvals/analytics.js";
let pass = 0, fail = 0;
const ok = (n: string, c: boolean, x?: unknown) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (!c && x !== undefined ? " -> " + JSON.stringify(x) : "")); };
const today = "2026-11-20";
const approvals = ["APPROVED", "PENDING", "REJECTED"], progresses = ["TODO", "IN_PROGRESS", "COMPLETED", "BLOCKED"], statuses = ["PENDING", "IN_PROGRESS", "COMPLETED", "CANCELLED"];
const rows: Row[] = [];
let i = 0;
for (const a of approvals) for (const p of progresses) for (const s of statuses) for (const d of ["2026-11-19", "2026-11-01"]) for (const r of [null, 4])
  rows.push({ id: String(i++), userId: "u" + (i % 5), who: "P" + (i % 5), employeeCode: "C" + (i % 5), approvalStatus: a, progress: p, status: s, date: d, rating: r, title: "t" + i });
for (const days of [2, 3, 7]) {
  const c = countRows(rows, today, days);
  const keys: [TileKey, number][] = [["submitted", c.submitted], ["approved", c.approved], ["pending", c.pending], ["rejected", c.rejected], ["todo", c.todo], ["inProgress", c.inProgress], ["completed", c.completed], ["blocked", c.blocked], ["open", c.open], ["overdue", c.overdue], ["rated", c.rated]];
  for (const [k, n] of keys) { const m = tileMembers(rows, k, today, days); ok(`overdue=${days}: ${k} number ${n} = list ${m.length}`, m.length === n, [n, m.length]); ok(`${k}: no duplicates`, new Set(m.map((r) => r.id)).size === m.length); }
}
ok("an empty list gives empty tiles", tileMembers([], "submitted", today, 3).length === 0);
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
