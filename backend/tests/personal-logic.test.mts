// Pure rules for personal details. npx tsx tests/personal-logic.test.mts
import { checkPersonal, compare, readDay, shown } from "../src/modules/personal/personal.logic.ts";
let pass = 0, fail = 0;
const ok = (n: string, c: boolean, x?: unknown) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  -> " + JSON.stringify(x))); };
const TODAY = "2026-11-28";
const c = (o: Record<string, unknown>) => checkPersonal(o, TODAY);

ok("dates: ISO, Excel ISO-with-time and day-month-year all read", readDay("2000-01-29") === "2000-01-29" && readDay("2000-01-29T00:00:00.000Z") === "2000-01-29" && readDay("29-01-2000") === "2000-01-29" && readDay("29/01/2000") === "2000-01-29" && readDay(new Date("1999-05-30T00:00:00Z")) === "1999-05-30");
ok("dates: 30 Feb, month 13 and an unknown month word are refused; a month WORD is read as written", readDay("2001-02-30") === null && readDay("2001-13-01") === null && readDay("31st February 2001") === null && readDay("5 Octobre 2001") === null && readDay("") === null && readDay("1st July 2024") === "2024-07-01" && readDay("05th October 2026") === "2026-10-05");
ok("gender words (any case) are understood; anything else is refused", c({ gender: "male" }).values.gender === "MALE" && c({ gender: " FEMALE " }).values.gender === "FEMALE" && c({ gender: "Other" }).values.gender === "OTHER" && c({ gender: "boy" }).errors[0]?.code === "BAD_GENDER");
ok("marital status: Unmarried means Single, Married, Divorced, Widowed; unknown refused", c({ maritalStatus: "Unmarried" }).values.maritalStatus === "SINGLE" && c({ maritalStatus: "married" }).values.maritalStatus === "MARRIED" && c({ maritalStatus: "complicated" }).errors[0]?.code === "BAD_MARITAL");
ok("employee status: Full time and Part Time (any spacing) read; Contractor refused", c({ employeeStatusType: "Full time" }).values.employeeStatusType === "FULL_TIME" && c({ employeeStatusType: "part-time" }).values.employeeStatusType === "PART_TIME" && c({ employeeStatusType: "Contractor" }).errors.length === 1);
ok("date of birth: valid ok; future, under 14 and over 100 refused", c({ dateOfBirth: "2000-01-29T00:00:00.000Z" }).values.dateOfBirth === "2000-01-29" && c({ dateOfBirth: "2027-01-01" }).errors[0]?.code === "FUTURE_DOB" && c({ dateOfBirth: "2018-01-01" }).errors[0]?.code === "TOO_YOUNG" && c({ dateOfBirth: "1900-01-01" }).errors[0]?.code === "TOO_OLD" && c({ dateOfBirth: "2000-02-31" }).errors[0]?.code === "BAD_DATE");
ok("phone code: 91 and +91 read; letters and too long refused", c({ secondaryPhoneCode: "91" }).values.secondaryPhoneCode === "91" && c({ secondaryPhoneCode: "+91" }).values.secondaryPhoneCode === "91" && c({ secondaryPhoneCode: "IN" }).errors.length === 1 && c({ secondaryPhoneCode: "00911" }).errors.length === 1);
ok("secondary number: digits (spaces, dashes, a number cell) read; short, long and letters refused", c({ secondaryPhone: 9876500001 }).values.secondaryPhone === "9876500001" && c({ secondaryPhone: "+91 98765-00001" }).values.secondaryPhone === "919876500001" && c({ secondaryPhone: "12345" }).errors.length === 1 && c({ secondaryPhone: "abc" }).errors.length === 1 && c({ secondaryPhone: "1".repeat(16) }).errors.length === 1);
ok("a long address line (200 chars) is kept whole, 201 is refused", c({ addressLine1: "A".repeat(200) }).values.addressLine1?.length === 200 && c({ addressLine1: "A".repeat(201) }).errors[0]?.code === "TOO_LONG");
ok("address text keeps commas, slashes, dots and numbers exactly (spaces squeezed only)", c({ addressLine1: "B/12,  Test Society, Sample Road, Opp. School" }).values.addressLine1 === "B/12, Test Society, Sample Road, Opp. School");
ok("markup and control characters are refused in text fields", c({ city: "<script>" }).errors[0]?.code === "BAD_CHARS" && c({ city: "Mum\u0001bai" }).errors[0]?.code === "BAD_CHARS");
ok("BLANK means leave as it is: empty, spaces and undefined are never written", Object.keys(c({ gender: "", city: "   ", state: undefined }).values).length === 0 && c({ gender: "" }).errors.length === 0);
ok("only an explicit null clears a value", c({ city: null }).values.city === null && "city" in c({ city: null }).values);
ok("a non-text value (object, array) is refused", c({ city: { a: 1 } }).errors[0]?.code === "BAD_TYPE" && c({ city: ["a"] }).errors[0]?.code === "BAD_TYPE");
ok("unknown fields are ignored, never stored", Object.keys(c({ salary: "5", userId: "x", city: "Mumbai" }).values).join() === "city");
const cmp = compare({ gender: "MALE", city: "Pune", state: null, grade: "G2" }, { gender: "MALE", city: "Mumbai", state: "Maharashtra", grade: null });
const kind = (f: string) => cmp.find((x) => x.field === f)?.kind;
ok("compare: same, conflict, fill and clear are told apart", kind("gender") === "same" && kind("city") === "conflict" && kind("state") === "fill" && kind("grade") === "clear");
ok("compare: shows readable words, not codes", compare({ gender: "MALE" }, { gender: "FEMALE" })[0].current === "Male" && shown("maritalStatus", "SINGLE") === "Single / unmarried");
ok("compare: only the fields offered are compared", compare({ city: "Pune" }, { city: "Pune" }).length === 1);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
