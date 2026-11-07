// What the "Report info" sheet says about a report: the filters in words (not ids), and who exported it.
import { apiGet } from "@/lib/api";
import type { Filters, Options } from "../../_filters/useHrFilters";

/** The selected filters as readable lines. Names come from the same options the filter bar uses (limited to what the person may see). */
export async function describeFilters(f: Filters | undefined): Promise<[string, string][]> {
  const out: [string, string][] = [];
  if (!f) return [["Filters", "None"]];
  let options: Options | null = null;
  if (f.company || f.project.length > 0 || f.manager) {
    try {
      options = await apiGet<Options>("/hr-filters/options");
    } catch {
      options = null; // the file is still produced; names fall back to "selected"
    }
  }
  const company = f.company ? options?.companies.find((c) => c.id === f.company)?.name ?? "1 selected" : "All authorised companies";
  const projects = f.project.length > 0 ? f.project.map((id) => options?.projects.find((p) => p.id === id)?.name ?? "selected").join(", ") : "All authorised projects";
  const manager = f.manager ? options?.managers.find((m) => m.id === f.manager)?.name ?? "1 selected" : "All reporting managers";
  out.push(["Company", company], ["Project", projects], ["Reporting manager", manager], ["Employee search", f.q ? f.q : "None"]);
  return out;
}

export const titleCase = (s: string) => s.toLowerCase().replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
