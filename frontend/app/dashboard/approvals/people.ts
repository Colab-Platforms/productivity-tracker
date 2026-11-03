// The rules behind the Team Tasks employee dropdown. Pure (no React), so they can be tested on their own.
//
// The list is the WHOLE reporting team (the server's roster), not only people who have tasks in the chosen dates, each with the number of
// tasks they have in the dates being viewed (0 when none). "Everyone" is always first and counts every task in view.

export type PickerPerson = { id: string; name: string; code: string | null; count: number };

export function buildPeople(
  members: { id: string; name: string; employeeCode: string | null }[],
  rows: { userId: string; who: string; employeeCode: string | null }[],
  selectedId: string
): PickerPerson[] {
  const map = new Map<string, PickerPerson>();
  for (const m of members) map.set(m.id, { id: m.id, name: m.name, code: m.employeeCode, count: 0 });
  // someone with tasks who is not in the roster (should not happen, but a task must never vanish from the picker)
  for (const t of rows) {
    const p = map.get(t.userId) ?? { id: t.userId, name: t.who, code: t.employeeCode, count: 0 };
    p.count += 1;
    map.set(t.userId, p);
  }
  // the person already chosen stays selectable even if the roster no longer lists them
  if (selectedId && !map.has(selectedId)) map.set(selectedId, { id: selectedId, name: "Unknown", code: null, count: 0 });
  // alphabetical is what a searchable list needs; the employee code separates two people with the same name
  return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name) || String(a.code ?? "").localeCompare(String(b.code ?? "")));
}

/** Everyone first, then the people. */
export function withEveryone(people: PickerPerson[], total: number): PickerPerson[] {
  return [{ id: "", name: "Everyone", code: null, count: total }, ...people];
}

/** Search by name or employee code, ignoring case and extra spaces. "Everyone" stays while the search is empty only. */
export function matchPeople(options: PickerPerson[], query: string): PickerPerson[] {
  const q = query.trim().toLowerCase();
  if (!q) return options;
  return options.filter((o) => o.id !== "" && `${o.name} ${o.code ?? ""}`.toLowerCase().includes(q));
}

export const taskWord = (n: number) => `${n} ${n === 1 ? "task" : "tasks"}`;

export const initialsOf = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

/** Arrow-key movement through `length` options, stopping at the ends. */
export function moveActive(current: number, key: "ArrowDown" | "ArrowUp" | "Home" | "End", length: number): number {
  if (length <= 0) return 0;
  if (key === "Home") return 0;
  if (key === "End") return length - 1;
  const next = key === "ArrowDown" ? current + 1 : current - 1;
  return Math.max(0, Math.min(length - 1, next));
}
