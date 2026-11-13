// Warning letters: the pure rules, no database.   DATABASE_URL=dummy npx tsx tests/warning-letters-logic.test.mts
import { WL_MARKER, checkIssue, decodeMeta, encodeMeta, isLetterRow, issueDateOk, looksLikePdf, mayOpenLetter, notWarningLetter } from "../src/modules/warning-letters/warnings.logic.js";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, x?: unknown) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  -> " + JSON.stringify(x))); };

// encode / decode
const meta = { v: 1 as const, title: "First warning", reason: "Late 5 times, \"quoted\" and [brackets]", issueDate: "2026-11-12", source: "TYPED" as const };
const enc = encodeMeta(meta);
ok("encoded text starts with the marker", enc.startsWith(WL_MARKER));
ok("decode returns exactly what was encoded (quotes, brackets, unicode)", JSON.stringify(decodeMeta(enc)) === JSON.stringify(meta));
const uni = encodeMeta({ ...meta, title: "चेतावनी पत्र 🐣" });
ok("unicode survives", decodeMeta(uni)?.title === "चेतावनी पत्र 🐣");
ok("a normal rejection reason is not a letter", !isLetterRow("The photo is blurry") && !isLetterRow(null) && !isLetterRow(undefined) && decodeMeta("The photo is blurry") === null);
ok("damaged marker text never throws, gives null", decodeMeta(WL_MARKER + "{not json") === null && decodeMeta(WL_MARKER + "{}") === null);
ok("a marker typed in the MIDDLE of a normal text is not a letter", !isLetterRow("rejected " + WL_MARKER));

// the query fragment keeps null rows (the SQL NULL trap) and drops letters
ok("the exclusion fragment keeps rows with no reason (null) explicitly", JSON.stringify(notWarningLetter.OR[0]) === JSON.stringify({ rejectionReason: null }));
ok("and excludes the marker", JSON.stringify(notWarningLetter.OR[1]).includes(WL_MARKER));

// input rules
const good = { title: "Warning one", reason: "Repeated lateness" };
ok("upload with a good title + reason passes", "value" in checkIssue(good, true));
ok("typed with a good text passes", "value" in checkIssue({ ...good, text: "x".repeat(40) }, false));
ok("title too short", (checkIssue({ ...good, title: "ab" }, true) as { error: string }).error === "TITLE_REQUIRED");
ok("title only spaces", (checkIssue({ ...good, title: "     " }, true) as { error: string }).error === "TITLE_REQUIRED");
ok("title too long", (checkIssue({ ...good, title: "x".repeat(121) }, true) as { error: string }).error === "TITLE_TOO_LONG");
ok("reason too short", (checkIssue({ ...good, reason: "a" }, true) as { error: string }).error === "REASON_REQUIRED");
ok("reason too long", (checkIssue({ ...good, reason: "x".repeat(1001) }, true) as { error: string }).error === "REASON_TOO_LONG");
ok("neither a file nor text", (checkIssue(good, false) as { error: string }).error === "LETTER_REQUIRED");
ok("both a file and text is refused (one way only)", (checkIssue({ ...good, text: "x".repeat(40) }, true) as { error: string }).error === "FILE_OR_TEXT");
ok("typed text too short", (checkIssue({ ...good, text: "short" }, false) as { error: string }).error === "TEXT_TOO_SHORT");
ok("typed text too long", (checkIssue({ ...good, text: "x".repeat(8001) }, false) as { error: string }).error === "TEXT_TOO_LONG");
ok("non-string values are refused, not coerced", (checkIssue({ title: 123, reason: {}, text: [] }, false) as { error: string }).error === "TITLE_REQUIRED");
ok("null bytes are stripped", "value" in checkIssue({ title: "Warn\u0000ing", reason: "Reason ok" }, true) && (checkIssue({ title: "Warn\u0000ing", reason: "Reason ok" }, true) as { value: { title: string } }).value.title === "Warning");

// pdf bytes
ok("real PDF bytes accepted", looksLikePdf(Buffer.from("%PDF-1.7 rest")));
ok("HTML claiming to be a PDF is refused", !looksLikePdf(Buffer.from("<html><script>alert(1)</script>")));
ok("empty / tiny buffers refused", !looksLikePdf(Buffer.alloc(0)) && !looksLikePdf(Buffer.from("%PD")));

// issue date
ok("today is fine", issueDateOk("2026-11-12", "2026-11-12"));
ok("a week ago is fine", issueDateOk("2026-11-05", "2026-11-12"));
ok("the future is refused", !issueDateOk("2026-11-13", "2026-11-12"));
ok("more than a year back is refused", !issueDateOk("2025-10-01", "2026-11-12"));
ok("a malformed date is refused", !issueDateOk("12/11/2026", "2026-11-12") && !issueDateOk("", "2026-11-12"));

// who may open
const E = { id: "e1", role: "EMPLOYEE", access: { all: false, ids: [] } };
const letter = { userId: "e1", platformId: "pA" };
ok("the employee it was issued to may open it", mayOpenLetter(E, letter));
ok("another employee may not", !mayOpenLetter({ ...E, id: "e2" }, letter));
ok("a manager may not (not their business)", !mayOpenLetter({ id: "m", role: "MANAGER", access: { all: false, ids: ["pA"] } }, letter));
ok("HR of the same company may", mayOpenLetter({ id: "h", role: "HR", access: { all: false, ids: ["pA"] } }, letter));
ok("HR of another company may not", !mayOpenLetter({ id: "h", role: "HR", access: { all: false, ids: ["pB"] } }, letter));
ok("Admin with all-company access may", mayOpenLetter({ id: "a", role: "ADMIN", access: { all: true, ids: [] } }, letter));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
