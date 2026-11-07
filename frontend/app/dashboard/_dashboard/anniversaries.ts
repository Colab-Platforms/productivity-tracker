// Pure date logic for the work-anniversary card (no React, no requests), so it can be tested on its own.

export type Anniversary = { id: string; name: string; code: string | null; photoAt?: string | null; designation: string | null; date: string; years: number; inDays: number };

/** People whose work anniversary (from their date of joining) falls within `withinDays` of `today` (yyyy-mm-dd, the company's today).
 *  A joining date in the future, an anniversary of zero years and people with no joining date are left out; nothing is guessed. */
export function upcomingAnniversaries(people: { id: string; name: string; employeeCode: string | null; designation: string | null; dateOfJoining?: string | null; photoAt?: string | null; status?: string }[], today: string, withinDays = 30): Anniversary[] {
  const t = Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1, Number(today.slice(8, 10)));
  const out: Anniversary[] = [];
  for (const p of people) {
    if (p.status === "EXITED" || p.status === "SUSPENDED") continue;
    const doj = (p.dateOfJoining ?? "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(doj)) continue;
    const y = Number(doj.slice(0, 4)), m = Number(doj.slice(5, 7)), d = Number(doj.slice(8, 10));
    if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) continue;
    let year = Number(today.slice(0, 4));
    let at = Date.UTC(year, m - 1, d);
    if (at < t) { year += 1; at = Date.UTC(year, m - 1, d); }
    // 29 Feb in a non-leap year rolls into March: skip that one rather than show a wrong day
    if (new Date(at).getUTCMonth() !== m - 1) continue;
    const inDays = Math.round((at - t) / 86_400_000);
    const years = year - y;
    if (years < 1 || inDays > withinDays) continue;
    out.push({ id: p.id, name: p.name, code: p.employeeCode, photoAt: p.photoAt, designation: p.designation, date: new Date(at).toISOString().slice(0, 10), years, inDays });
  }
  return out.sort((a, b) => a.inDays - b.inDays || a.name.localeCompare(b.name));
}
