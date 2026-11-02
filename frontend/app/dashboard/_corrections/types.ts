export type CorrectionRequest = {
  id: string;
  date: string;
  correctionType: string;
  typeLabel: string;
  originalLoginAt: string | null;
  originalLogoutAt: string | null;
  requestedLoginAt: string | null;
  requestedLogoutAt: string | null;
  reason: string;
  attachmentName: string | null;
  status: "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED";
  reviewedAt: string | null;
  reviewComment: string | null;
  reviewedBy: string | null;
  applied: boolean;
  createdAt: string;
  employee?: { id: string; name: string; employeeCode: string | null; designation: string | null };
  managerStep?: { status: string; approvers: string[]; decidedBy: string | null; decidedAt: string | null; note: string | null } | null;
};

export type SessionSnapshot = {
  loginAt: string;
  logoutAt: string | null;
  status: string;
  productiveSeconds: number;
  breakSeconds: number;
  wasLateLogin: boolean;
  lateByMinutes: number;
} | null;

export type CorrectionDetails = CorrectionRequest & {
  timezone: string;
  current: SessionSnapshot;
  audits: { id: string; action: string; before: Partial<SessionSnapshot> & { note?: string }; after: SessionSnapshot; by: string; at: string }[];
  canDecide: boolean;
};

export const CORRECTION_TYPES: [string, string][] = [
  ["MISSING_CHECKIN", "Missing check-in"],
  ["MISSING_CHECKOUT", "Missing check-out"],
  ["INCORRECT_TIME", "Incorrect time"],
  ["BIOMETRIC_FAILURE", "Biometric failure"],
  ["FORGOT_CLOCK_IN", "Forgot to clock in"],
  ["OTHER", "Other"],
];

export const STATUS_STYLE: Record<string, string> = {
  PENDING: "bg-amber-50 text-amber-700",
  APPROVED: "bg-emerald-50 text-emerald-700",
  REJECTED: "bg-red-50 text-red-600",
  CANCELLED: "bg-slate-100 text-slate-500",
};
export const STATUS_LABEL: Record<string, string> = {
  PENDING: "Pending HR approval",
  APPROVED: "Approved",
  REJECTED: "Rejected",
  CANCELLED: "Cancelled",
};
