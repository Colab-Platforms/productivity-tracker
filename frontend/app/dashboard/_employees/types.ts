// Shapes of the employee add / import API (backend: admin/employeeImport.service.ts).

export type Cell = string | number | boolean | null;

export const FIELDS = [
  "company",
  "fullName",
  "employeeId",
  "email",
  "mobile",
  "designation",
  "team",
  "projects",
  "role",
  "reportsToName",
  "reportsToId",
  "dateOfJoining",
  "shiftStart",
  "shiftEnd",
  "workingDays",
] as const;
export type Field = (typeof FIELDS)[number];

// Labels and "required" follow the HR workbook: yellow columns are required.
export const FIELD_INFO: Record<Field, { label: string; required: boolean; hint?: string }> = {
  company: { label: "Company", required: true },
  fullName: { label: "Full name", required: true },
  employeeId: { label: "Employee ID", required: true },
  email: { label: "Work email", required: true, hint: "May be blank if you confirm sign-in by employee ID" },
  mobile: { label: "Mobile number", required: false },
  designation: { label: "Designation", required: true },
  team: { label: "Team or department", required: true, hint: "Must already exist in Admin → Teams" },
  projects: { label: "Projects", required: false, hint: "Extra teams, separated by commas" },
  role: { label: "System role", required: true },
  reportsToName: { label: "Reports to - full name", required: true },
  reportsToId: { label: "Reports to - employee ID", required: true },
  dateOfJoining: { label: "Date of joining", required: false, hint: "DD-MM-YYYY" },
  shiftStart: { label: "Shift start", required: false },
  shiftEnd: { label: "Shift end", required: false },
  workingDays: { label: "Working days", required: false },
};

// The three that make a row identifiable at all. Everything else can be blank
// (and is then flagged row by row in the preview).
export const MUST_MAP: Field[] = ["company", "fullName", "employeeId"];

export type Mapping = Partial<Record<Field, number | null>>;
export type ParsedRow = { rowNumber: number; cells: Cell[]; skip?: "example" | "blank" | "note" };

export type ParseResponse = {
  sheets: string[];
  sheet: string;
  headerRow: number;
  ignoredAboveHeader: number;
  headers: string[];
  suggestedMapping: Mapping;
  rows: ParsedRow[];
};

export type ImportOptions = {
  decimalTimes?: boolean;
  pmEndTimes?: boolean;
  blankRoleIsEmployee?: boolean;
  blankEmailUsesPlaceholder?: boolean;
  blankIdIsGenerated?: boolean;
  blankReportsToIsNone?: boolean;
  blankTeamIsNone?: boolean;
  createMissingShifts?: boolean;
  onboarding?: "EXISTING" | "NEW_JOINER";
};

export type Issue = {
  field: Field | "row";
  severity: "error" | "warning";
  code: string;
  message: string;
};

export type RowStatus = "VALID" | "ALREADY_EXISTS" | "INVALID" | "SKIPPED";

export type RowResult = {
  rowNumber: number;
  status: RowStatus;
  skipReason?: string;
  values: {
    company: string;
    fullName: string;
    employeeId: string;
    email: string;
    mobile: string;
    designation: string;
    team: string;
    projects: string;
    role: string;
    reportsTo: string;
    dateOfJoining: string;
    shift: string;
  };
  issues: Issue[];
  notes: string[];
};

export type Preview = {
  summary: { total: number; valid: number; alreadyExists: number; invalid: number; skipped: number };
  needsConfirmation: Partial<Record<keyof ImportOptions, number>>;
  shiftsToCreate: { platformId: string; platformName: string; start: string; end: string; days: number[]; rows: number }[];
  rows: RowResult[];
};

export type Credential = {
  rowNumber: number;
  employeeId: string;
  name: string;
  company: string;
  signInWith: string;
  temporaryPassword: string;
};

export type CommitResult = {
  summary: { imported: number; skippedExisting: number; failed: number; skippedRows: number };
  shiftsCreated: { company: string; name: string }[];
  mail: { sent: number; failed: number; noEmail: number; notApplicable: number };
  credentials: Credential[];
  rows: { rowNumber: number; status: RowStatus; issues: Issue[] }[];
};

export type Lookups = {
  year: number;
  roles: string[];
  defaultCompanyId: string;
  designations?: { platformId: string; name: string }[];
  companies: { id: string; name: string; slug: string; holidaysThisYear: number }[];
  teams: { id: string; name: string; platformId: string }[];
  shifts: { id: string; name: string; platformId: string; startTime: string; endTime: string; workingDays: number[] }[];
  managers: { id: string; name: string; employeeCode: string | null; role: string; platformId: string; designation: string | null }[];
};

// Plain-words wording of every interpretation HR may confirm.
export const OPTION_COPY: Record<
  Exclude<keyof ImportOptions, "onboarding">,
  { title: string; detail: string }
> = {
  decimalTimes: {
    title: "Read times typed as numbers (like 9.30) as hours.minutes",
    detail: "9.30 becomes 09:30. Without this, those rows are rejected rather than guessed.",
  },
  pmEndTimes: {
    title: "Read an end time earlier than the start (like 6.30) as PM",
    detail: "6.30 after a 09:30 start becomes 18:30. Each change is shown on its row.",
  },
  blankRoleIsEmployee: {
    title: "Treat a blank System role as Employee",
    detail: "People get no extra permissions. Managers, HR and Admins must be named in the file.",
  },
  blankEmailUsesPlaceholder: {
    title: "No work email: sign in with the employee ID",
    detail: "A placeholder address (id@company.local) is stored. They sign in with their employee ID and no email is sent.",
  },
  blankIdIsGenerated: {
    title: "Generate the Employee ID for rows that have none",
    detail: "Each blank row gets its company's next ID (prefix and number) when saved. Existing IDs are never changed or reused.",
  },
  blankReportsToIsNone: {
    title: "Treat a blank “Reports to” as no reporting manager",
    detail: "These people will have nobody approving their tasks until you set a manager.",
  },
  blankTeamIsNone: {
    title: "Leave people with a blank team unassigned",
    detail: "They won't show in a team's live view until they are added to one.",
  },
  createMissingShifts: {
    title: "Create shifts that don't exist yet",
    detail: "A new shift is added to the company for each new pattern listed below, then linked to the people who use it.",
  },
};

export const DAYS = [
  { n: 1, short: "Mon" },
  { n: 2, short: "Tue" },
  { n: 3, short: "Wed" },
  { n: 4, short: "Thu" },
  { n: 5, short: "Fri" },
  { n: 6, short: "Sat" },
  { n: 7, short: "Sun" },
];

// ---- Update existing employees -------------------------------------------------------
export type UpdateChange = {
  field: string; // the key used to tick an overwrite, e.g. "reportsTo"
  label: string;
  current: string;
  proposed: string;
  kind: "fill" | "conflict";
  applied: boolean;
};
export type UpdateStatus = "UPDATE" | "NO_CHANGE" | "INVALID" | "SKIPPED";
export type UpdateRowResult = {
  rowNumber: number;
  status: UpdateStatus;
  skipReason?: string;
  employeeId: string;
  name: string;
  company: string;
  changes: UpdateChange[];
  issues: Issue[];
  notes: string[];
};
export type UpdatePreview = {
  summary: {
    total: number;
    toUpdate: number;
    fieldsToFill: number;
    conflicts: number;
    conflictsChosen: number;
    noChange: number;
    invalid: number;
    skipped: number;
  };
  needsConfirmation: Partial<Record<keyof ImportOptions, number>>;
  shiftsToCreate: { platformId: string; platformName: string; start: string; end: string; days: number[]; people: number }[];
  rows: UpdateRowResult[];
};
export type UpdateCommitResult = {
  summary: { updated: number; fieldsChanged: number; unchanged: number; conflictsLeftAlone: number; invalid: number; skipped: number };
  shiftsCreated: { company: string; name: string }[];
  rows: { rowNumber: number; employeeId: string; name: string; applied: { field: string; from: string; to: string }[] }[];
};
