// ---------------------------------------------------------------------------
// DESIGNATIONS: ONE fixed list for every company (an enum).
//
// - Not per company: every company picks from the same list.
// - Fixed: a new designation is added HERE (one line) and deployed. Nobody can type a free-text one in the app.
// - Built from the titles people already had on 2026-11-03 (live): obvious typos and capitalisation variants were merged
//   into one spelling ("Accountaant" -> Accountant, "Hr Generalist" -> HR Generalist). "Test" and "Time pass" were left out.
// - The people table keeps the title as plain text (`users.designation`), holding exactly one of these spellings. Changing
//   that column to a database enum is a separate, deliberate deployment step (it cannot be done safely while the live
//   server reloads code on save). Until then this file is the only authority and every save path goes through it.
// - Someone who still has an old spelling that is not in the list keeps it untouched ("legacy") until it is edited.
// ---------------------------------------------------------------------------

export const DESIGNATIONS = [
  "Accountant",
  "Administrator",
  "AI Trainer",
  "AI/ML Developer",
  "Associate",
  "BDE",
  "BDM & Project Lead",
  "Business Head",
  "Business Operations & Legal",
  "Creative Head",
  "Customer After Service Executive",
  "Digital Marketing",
  "Digital Marketing Intern",
  "DME",
  "Finance Analyst",
  "Formulation Expert",
  "Graphic Designer",
  "HR Generalist",
  "HR Intern",
  "Jr. Creative Producer",
  "Jr. SME",
  "Logistics Manager",
  "Mobile Application Developer",
  "Motion Graphics",
  "NDR Calling",
  "Operations Manager",
  "Packaging",
  "PME",
  "Product Manager",
  "Project Manager",
  "Sales Team Lead",
  "Senior Graphic Designer",
  "Shopify Developer",
  "SME",
  "Social Media Manager",
  "Software Developer",
  "Telecaller",
  "Trainer",
  "UI/UX Designer",
  "Video Editor",
] as const;

export type Designation = (typeof DESIGNATIONS)[number];

// Spellings found in live data that mean one of the entries above.
const ALIASES: Record<string, Designation> = {
  accountaant: "Accountant",
  "senior graphice designer": "Senior Graphic Designer",
};

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/\s*\/\s*/g, "/") // "AI/ ML" = "AI/ML"
    .replace(/\s+/g, " ")
    .trim();

const BY_NORM = new Map<string, Designation>(DESIGNATIONS.map((d) => [norm(d), d]));

/** The list's own spelling for whatever was typed or imported, or null when it is not a designation. */
export function canonicalDesignation(input: unknown): Designation | null {
  const n = norm(String(input ?? ""));
  if (!n) return null;
  return BY_NORM.get(n) ?? ALIASES[n] ?? null;
}

/** For dropdowns: the whole list, same for every company. */
export const designationNames = (): string[] => [...DESIGNATIONS];

// Kept so older call sites keep compiling; the list is fixed, so "adding" does nothing.
export async function sharedDesignations(): Promise<string[]> {
  return designationNames();
}
export async function ensureDesignations(_rows: { platformId: string; name: string }[], _byUserId?: string): Promise<void> {
  /* the list is a fixed enum: nothing is ever added at run time */
}
