// The five titles from the HR sheet are on the list, and punctuation/capital variants read as the list's own spelling.
import { canonicalDesignation, DESIGNATIONS } from "../src/lib/designations.js";
let pass = 0, fail = 0;
const ok = (n: string, c: boolean, x?: unknown) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  -> " + JSON.stringify(x))); };
for (const [typed, want] of [
  ["Performance Marketing Executive", "Performance Marketing Executive"],
  ["Fullstack Developer intern", "Fullstack Developer Intern"],
  ["AI- Team Lead", "AI Team Lead"],
  ["AI-Team Lead", "AI Team Lead"],
  ["AI Senior Developer", "AI Senior Developer"],
  ["Ai Developer", "AI Developer"],
  ["ai/ ml developer", "AI/ML Developer"],
] as const) ok(`"${typed}" -> ${want}`, canonicalDesignation(typed) === want, canonicalDesignation(typed));
ok("a title that is not on the list is still refused", canonicalDesignation("Chief Wizard") === null);
ok("a near spelling is still refused (nothing is guessed)", canonicalDesignation("AI Team Leader") === null);
ok("the list is in alphabetical order", [...DESIGNATIONS].every((d, i, a) => i === 0 || a[i - 1].toLowerCase() <= d.toLowerCase()), DESIGNATIONS);
ok("no duplicates", new Set(DESIGNATIONS.map((d) => d.toLowerCase())).size === DESIGNATIONS.length);
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
