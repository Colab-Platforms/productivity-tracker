// Company access and employee-ID rules. No database.
import { canAccess, cleanPrefix, formatCode, highestNumber, resolveAccess, visibleCompanies } from "../src/lib/companyAccess.logic.js";
let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n); };
const base = { ownPlatformId: "A", grants: [] as { platformId: string | null }[], isOwnerCode: false, pinnedPlatformId: null as string | null };

ok("an employee reaches only their own company, even with grants", resolveAccess({ ...base, role: "EMPLOYEE", grants: [{ platformId: "B" }] }).ids.join() === "A");
ok("a manager reaches only their own company, even with an all-companies grant", resolveAccess({ ...base, role: "MANAGER", grants: [{ platformId: null }] }).all === false);
ok("HR with no grants: own company only", resolveAccess({ ...base, role: "HR" }).ids.join() === "A");
ok("HR with two assigned companies: own + those two", resolveAccess({ ...base, role: "HR", grants: [{ platformId: "B" }, { platformId: "C" }] }).ids.join() === "A,B,C");
ok("HR does not reach an unassigned company", canAccess(resolveAccess({ ...base, role: "HR", grants: [{ platformId: "B" }] }), "D") === false);
ok("HR reaches an assigned company", canAccess(resolveAccess({ ...base, role: "HR", grants: [{ platformId: "B" }] }), "B") === true);
ok("duplicate grants are merged", resolveAccess({ ...base, role: "HR", grants: [{ platformId: "A" }, { platformId: "B" }, { platformId: "B" }] }).ids.join() === "A,B");
ok("an all-companies grant means all", resolveAccess({ ...base, role: "ADMIN", grants: [{ platformId: null }] }).all === true);
ok("an owner code means all (HR/Admin)", resolveAccess({ ...base, role: "HR", isOwnerCode: true }).all === true);
ok("an owner code does nothing for an employee", resolveAccess({ ...base, role: "EMPLOYEE", isOwnerCode: true }).all === false);
ok("a pinned deployment allows that company only, even for an owner", resolveAccess({ ...base, role: "ADMIN", isOwnerCode: true, pinnedPlatformId: "P" }).ids.join() === "P" && resolveAccess({ ...base, role: "ADMIN", isOwnerCode: true, pinnedPlatformId: "P" }).all === false);
ok("the picker lists only allowed companies", visibleCompanies({ all: false, ids: ["A", "B"] }, [{ id: "A" }, { id: "B" }, { id: "C" }]).length === 2);
ok("the picker lists everything for all-companies", visibleCompanies({ all: true, ids: [] }, [{ id: "A" }, { id: "C" }]).length === 2);

ok("a prefix is upper-cased and trimmed", cleanPrefix(" jay ") === "JAY");
ok("a one-letter prefix is refused", cleanPrefix("J") === null);
ok("a prefix with a dash or space is refused", cleanPrefix("JA-Y") === null && cleanPrefix("J Y") === null);
ok("a prefix starting with a digit is refused", cleanPrefix("1AB") === null);
ok("a nine-character prefix is refused", cleanPrefix("ABCDEFGHI") === null);
ok("codes are padded to the width", formatCode("AI", 5, 4) === "AI-0005" && formatCode("AI", 12345, 4) === "AI-12345");
ok("the highest number ignores other prefixes and non-numbers", highestNumber(["AI-04", "AI-0009", "TCS-30", "AI-x", null, "AIR-77"], "AI") === 9);
ok("the highest number is 0 when nothing matches", highestNumber(["TCS-1"], "AI") === 0);
ok("matching the prefix is case-insensitive (Vak-0003)", highestNumber(["Vak-0003", "VAK-0001"], "VAK") === 3);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
