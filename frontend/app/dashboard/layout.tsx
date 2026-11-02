"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import Bell from "./_notifications/Bell";
import { NotificationsProvider } from "./_notifications/NotificationsContext";
import { ThemeProvider } from "./_theme/ThemeContext";
import { ThemeIconButton, ThemeRow } from "./_theme/ThemeToggle";
import { resetTheme } from "@/lib/theme";
import Link from "next/link";
import Avatar from "./_photos/Avatar";
import { apiGet, clearToken, getToken } from "@/lib/api";
import { setPlatformTimezone } from "@/lib/time";

export type Me = {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  role: string;
  employeeCode: string | null;
  designation: string | null;
  photoAt?: string | null;
  trackerAccessEnabled: boolean;
    mustChangePassword?: boolean;
  platform: { id: string; name: string; slug: string; timezone?: string };
};

const MeContext = createContext<Me | null>(null);
export const useMe = () => useContext(MeContext);

// ---------------------------------------------------------------------------
// ICONS
// Inline SVG rather than an icon package: no dependency to install, no
// version to break, and they inherit colour from the link they sit in.
// ---------------------------------------------------------------------------
type IconProps = { className?: string };
const I = {
  bell: (p: IconProps) => (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M10 2.8a4.7 4.7 0 0 0-4.7 4.7c0 4.4-1.8 5.6-1.8 5.6h13s-1.8-1.2-1.8-5.6A4.7 4.7 0 0 0 10 2.8Z" />
      <path d="M8.3 15.8a1.8 1.8 0 0 0 3.4 0" />
    </svg>
  ),
  grid: (p: IconProps) => (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" {...p}>
      <rect x="3" y="3" width="6" height="6" rx="1.4" />
      <rect x="11" y="3" width="6" height="6" rx="1.4" />
      <rect x="3" y="11" width="6" height="6" rx="1.4" />
      <rect x="11" y="11" width="6" height="6" rx="1.4" />
    </svg>
  ),
  today: (p: IconProps) => (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" {...p}>
      <circle cx="10" cy="10" r="7" />
      <path d="M10 6.5V10l2.5 1.8" strokeLinecap="round" />
    </svg>
  ),
  tasks: (p: IconProps) => (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" {...p}>
      <path d="M3 5.5 4.6 7 7.5 4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3 12.5 4.6 14l2.9-3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M10.5 5.5H17M10.5 12.5H17" strokeLinecap="round" />
    </svg>
  ),
  history: (p: IconProps) => (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" {...p}>
      <path d="M3.2 8a7 7 0 1 1 1.3 5.4" strokeLinecap="round" />
      <path d="M3 4v4h4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M10 7v3.2l2.3 1.5" strokeLinecap="round" />
    </svg>
  ),
  ticket: (p: IconProps) => (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" {...p}>
      <path d="M3 7.5a1.5 1.5 0 0 0 0 5V15a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-2.5a1.5 1.5 0 0 1 0-5V5a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1z" />
      <path d="M10 7v6" strokeDasharray="1.5 2" strokeLinecap="round" />
    </svg>
  ),
  payslip: (p: IconProps) => (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" {...p}>
      <path d="M5 2.5h10a1 1 0 0 1 1 1v13l-2.3-1.4-1.9 1.4-1.8-1.4-1.9 1.4L6 15.1 4 16.5v-13a1 1 0 0 1 1-1z" />
      <path d="M7.5 7h5M7.5 10h3" strokeLinecap="round" />
    </svg>
  ),
  approvals: (p: IconProps) => (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" {...p}>
      <path d="M4 10.5 8 14.5 16 5.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  team: (p: IconProps) => (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" {...p}>
      <circle cx="7.5" cy="7" r="2.6" />
      <path d="M2.6 16c0-2.6 2.2-4.3 4.9-4.3s4.9 1.7 4.9 4.3" strokeLinecap="round" />
      <path d="M13.4 5.1a2.4 2.4 0 0 1 0 4.4M14.6 11.9c1.6.5 2.8 1.9 2.8 4.1" strokeLinecap="round" />
    </svg>
  ),
  reports: (p: IconProps) => (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" {...p}>
      <path d="M3 17h14" strokeLinecap="round" />
      <path d="M5.5 17V9M10 17V4.5M14.5 17v-5.5" strokeLinecap="round" />
    </svg>
  ),
  holidays: (p: IconProps) => (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" {...p}>
      <rect x="3" y="4.5" width="14" height="12" rx="1.6" />
      <path d="M3 8.5h14M7 3v3M13 3v3" strokeLinecap="round" />
      <circle cx="10" cy="12.5" r="1.3" fill="currentColor" stroke="none" />
    </svg>
  ),
  payroll: (p: IconProps) => (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" {...p}>
      <rect x="2.5" y="5.5" width="15" height="10" rx="1.6" />
      <circle cx="10" cy="10.5" r="2.2" />
      <path d="M5 10.5h.01M15 10.5h.01" strokeLinecap="round" />
    </svg>
  ),
  edit: (p: IconProps) => (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M3.5 16.5h3l9-9a2.1 2.1 0 0 0-3-3l-9 9v3Z" />
      <path d="M11 6l3 3" />
    </svg>
  ),
  shield: (p: IconProps) => (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M10 2.8 4 5v4.6c0 3.6 2.4 6 6 7.6 3.6-1.6 6-4 6-7.6V5l-6-2.2Z" />
      <path d="m7.4 10 1.8 1.8 3.4-3.6" />
    </svg>
  ),
  folder: (p: IconProps) => (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M2.8 6.2a1.6 1.6 0 0 1 1.6-1.6h3.2l1.6 1.8h5.6a1.6 1.6 0 0 1 1.6 1.6v6.2a1.6 1.6 0 0 1-1.6 1.6H4.4a1.6 1.6 0 0 1-1.6-1.6V6.2Z" />
    </svg>
  ),
  user: (p: IconProps) => (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <circle cx="10" cy="7" r="3" />
      <path d="M4 16.5c.4-2.9 2.8-4.5 6-4.5s5.6 1.6 6 4.5" />
    </svg>
  ),
  mail: (p: IconProps) => (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <rect x="2.8" y="4.5" width="14.4" height="11" rx="1.8" />
      <path d="m3.4 6 6.6 5 6.6-5" />
    </svg>
  ),
  video: (p: IconProps) => (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <rect x="2.5" y="5.5" width="10" height="9" rx="1.8" />
      <path d="m12.5 9 5-2.6v7.2L12.5 11" />
    </svg>
  ),
  huddle: (p: IconProps) => (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <circle cx="10" cy="5.5" r="2" />
      <circle cx="4.6" cy="13.4" r="1.9" />
      <circle cx="15.4" cy="13.4" r="1.9" />
      <path d="M8.3 7.2 5.6 11.6M11.7 7.2l2.7 4.4M6.6 15.4h6.8" />
    </svg>
  ),
  building: (p: IconProps) => (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <rect x="4.2" y="2.8" width="11.6" height="14.4" rx="1.4" />
      <path d="M7.5 6.5h.01M10 6.5h.01M12.5 6.5h.01M7.5 9.5h.01M10 9.5h.01M12.5 9.5h.01M8.5 17.2v-3.2h3v3.2" />
    </svg>
  ),
  list: (p: IconProps) => (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M6.5 5.5h10M6.5 10h10M6.5 14.5h10" />
      <path d="M3.4 5.5h.01M3.4 10h.01M3.4 14.5h.01" />
    </svg>
  ),
  receipt: (p: IconProps) => (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M5 2.8h10v14.4l-2.5-1.5-2.5 1.5-2.5-1.5L5 17.2V2.8Z" />
      <path d="M7.8 7h4.4M7.8 10.2h4.4" />
    </svg>
  ),
  trend: (p: IconProps) => (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="m2.8 14 4.4-4.6 3 3L17 5.4" />
      <path d="M12.6 5.4H17V9.8" />
    </svg>
  ),
  userplus: (p: IconProps) => (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <circle cx="8" cy="7" r="2.8" />
      <path d="M2.8 16.5c.4-2.9 2.4-4.4 5.2-4.4" />
      <path d="M15 8v5M12.5 10.5h5" />
    </svg>
  ),
  pulse: (p: IconProps) => (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M2.5 10h3.2l2-5.2 3.4 10.4 2.2-5.2h4.2" />
    </svg>
  ),
  lock: (p: IconProps) => (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <rect x="3.8" y="8.6" width="12.4" height="8.6" rx="2" />
      <path d="M6.6 8.6V6.4a3.4 3.4 0 0 1 6.8 0v2.2" />
      <circle cx="10" cy="12.2" r="1.15" />
      <path d="M10 13.3v1.7" />
    </svg>
  ),
  admin: (p: IconProps) => (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" {...p}>
      <circle cx="10" cy="10" r="2.4" />
      <path d="M10 2.6v2M10 15.4v2M4.8 4.8l1.4 1.4M13.8 13.8l1.4 1.4M2.6 10h2M15.4 10h2M4.8 15.2l1.4-1.4M13.8 6.2l1.4-1.4" strokeLinecap="round" />
    </svg>
  ),
};

type NavItem = {
  href: string;
  label: string;
  ready: boolean;
  roles?: string[];
  // Hidden for these roles. HR and Admin get the HR dashboard at /dashboard,
  // so the "Today" entry that other roles see is replaced for them.
  notRoles?: string[];
  // A live count shown beside the label (HR: requests waiting for a decision).
  badge?: "queries";
  icon: (p: IconProps) => React.ReactElement;
};

// Grouped, because eleven flat links is a list to read rather than a menu to
// scan. "Me" is my own day, "My team" is other people, "Setup" is config
// that HR touches once a month.
const GROUPS: { title: string; items: NavItem[] }[] = [
  {
    title: "Main",
    items: [
      { href: "/dashboard", label: "Dashboard", ready: true, roles: ["HR", "ADMIN"], icon: I.grid },
      { href: "/dashboard", label: "Today", ready: true, notRoles: ["HR", "ADMIN"], icon: I.today },
      { href: "/dashboard/admin", label: "Employees", ready: true, roles: ["HR", "ADMIN"], icon: I.team },
      { href: "/dashboard/documents", label: "Employee Documents", ready: true, roles: ["HR", "ADMIN"], icon: I.folder },
      { href: "/dashboard/team-attendance", label: "Attendance", ready: true, roles: ["MANAGER", "HR", "ADMIN"], icon: I.pulse },
      { href: "/dashboard/queries", label: "Query Desk", ready: true, roles: ["MANAGER", "HR", "ADMIN"], badge: "queries", icon: I.ticket },
      { href: "/dashboard/today", label: "Productivity Tracker", ready: true, roles: ["HR", "ADMIN"], icon: I.today },
      { href: "/dashboard/approvals", label: "Tasks & Performance", ready: true, roles: ["MANAGER", "HR", "ADMIN"], icon: I.approvals },
      { href: "/dashboard/reports", label: "Reports & Analytics", ready: true, roles: ["MANAGER", "HR", "ADMIN"], icon: I.reports },
    ],
  },
  {
    title: "Me",
    items: [
      { href: "/dashboard/tasks", label: "Daily Tasks", ready: true, icon: I.tasks },
      { href: "/dashboard/history", label: "My History", ready: true, icon: I.history },
      { href: "/dashboard/attendance-calendar", label: "My attendance", ready: true, notRoles: ["MANAGER", "HR", "ADMIN"], icon: I.pulse },
      { href: "/dashboard/my-performance", label: "My performance", ready: true, roles: ["MANAGER"], icon: I.trend },
      { href: "/dashboard/huddles", label: "Team Huddle", ready: true, roles: ["MANAGER"], icon: I.huddle },
      { href: "/dashboard/notifications", label: "Notifications", ready: true, icon: I.bell },
      { href: "/dashboard/leave", label: "Leave", ready: true, icon: I.holidays },
      { href: "/dashboard/meetings", label: "Meetings", ready: true, icon: I.video },
      { href: "/dashboard/policies", label: "Policies", ready: true, icon: I.shield },
      { href: "/dashboard/payslips", label: "My Payslips", ready: true, icon: I.receipt },
      { href: "/dashboard/queries", label: "Complaint Centre", ready: true, notRoles: ["MANAGER", "HR", "ADMIN"], badge: "queries", icon: I.ticket },
      { href: "/change-password", label: "Change password", ready: true, icon: I.lock },
    ],
  },
  {
    // Hiring is its own section, not part of Settings and not part of
    // Approvals. Approvals means a manager clearing someone's daily tasks;
    // this is HR clearing documents. Same word, different job.
    title: "Hiring",
    items: [
      { href: "/dashboard/candidates", label: "Joiners", ready: true, roles: ["HR", "ADMIN"], icon: I.userplus },
      { href: "/dashboard/offers", label: "Offer letters", ready: true, roles: ["HR", "ADMIN"], icon: I.mail },
    ],
  },
  {
    title: "Settings",
    items: [
      { href: "/dashboard/projects", label: "Projects", ready: true, roles: ["HR", "ADMIN"], icon: I.tasks },
      { href: "/dashboard/companies", label: "Companies", ready: true, roles: ["HR", "ADMIN"], icon: I.building },
      { href: "/dashboard/audit-logs", label: "Audit log", ready: true, roles: ["HR", "ADMIN"], icon: I.list },
      { href: "/dashboard/holidays", label: "Holidays", ready: true, roles: ["HR", "ADMIN"], icon: I.holidays },
      { href: "/dashboard/payroll", label: "Payroll", ready: true, roles: ["HR", "ADMIN"], icon: I.payroll },
      { href: "/dashboard/admin?tab=Teams", label: "Teams, shifts & rules", ready: true, roles: ["ADMIN", "HR"], icon: I.admin },
    ],
  },
];

const ROLE_CHIP: Record<string, string> = {
  ADMIN: "bg-violet-100 text-violet-700",
  HR: "bg-sky-100 text-sky-700",
  MANAGER: "bg-emerald-100 text-emerald-700",
  EMPLOYEE: "bg-slate-100 text-slate-600",
};

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
}

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const [pendingQueries, setPendingQueries] = useState(0);

  useEffect(() => {
    if (!getToken()) {
      router.replace("/login");
      return;
    }
        apiGet<Me>("/auth/me")
      .then((m) => {
        // Nobody gets into the app on a password HR chose for them.
        if (m.mustChangePassword) {
          router.replace("/change-password");
          return;
        }
        // Until HR has approved their papers there is no tracker to show. A
        // locked clock reading 00:00:00 tells a new joiner nothing; the list
        // of documents they owe tells them exactly what to do next.
        if (!m.trackerAccessEnabled) {
          router.replace("/onboarding");
          return;
        }
        setPlatformTimezone(m.platform.timezone);
        setMe(m);
      })
      .catch((err) => setError(err.message));

  }, [router]);

  // The tab shows the page you are on, under the product name.
  useEffect(() => {
    const role = me?.role ?? "";
    const item = GROUPS.flatMap((g) => g.items).find(
      (i) => i.href.split("?")[0] === pathname && (!i.roles || i.roles.includes(role)) && !(i.notRoles ?? []).includes(role)
    );
    document.title = pathname === "/dashboard/profile" ? "My Profile | Avatar HRMS" : pathname === "/dashboard/attendance-calendar" ? "Attendance Calendar | Avatar HRMS" : item ? `${item.label} | Avatar HRMS` : "Avatar HRMS";
  }, [pathname, me?.role]);

  // Query Desk / Complaint Centre: how many items are waiting for this person (queries to answer, corrections to decide, information asked of them).
  // Refreshed every minute and when the tab is focused.
  const hasMe = !!me;
  useEffect(() => {
    if (!hasMe) return;
    const load = () => {
      apiGet<{ badge: number }>("/queries/counts")
        .then((r) => setPendingQueries(r.badge))
        .catch(() => undefined);
    };
    load();
    const timer = setInterval(load, 60_000);
    window.addEventListener("focus", load);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", load);
    };
  }, [hasMe, pathname]);

  // Close the mobile drawer on navigation, otherwise it covers the page you
  // just asked for.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  function signOut() {
    clearToken();
    resetTheme(); // the next person on this computer starts in light until their own choice loads
    router.replace("/login");
  }

  if (error) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-[var(--background)] p-6">
        <div className="w-full max-w-sm rounded-2xl bg-white p-8 text-center shadow-[var(--shadow-lift)]">
          <div className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-full bg-red-50">
            <svg viewBox="0 0 20 20" className="h-5 w-5 text-red-500" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M10 6.5v5M10 14h.01" strokeLinecap="round" />
              <circle cx="10" cy="10" r="7.5" />
            </svg>
          </div>
          <p className="text-sm text-slate-700">{error}</p>
          <button
            onClick={signOut}
            className="mt-5 w-full rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-slate-800"
          >
            Sign in again
          </button>
        </div>
      </main>
    );
  }

  // A skeleton rather than the word "Loading" — the shell appears instantly
  // so the app feels like it started, not like it stalled.
  if (!me) {
    return (
      <div className="min-h-screen flex bg-[var(--background)]">
        <div className="m-4 mr-0 hidden w-64 shrink-0 rounded-3xl bg-white shadow-[var(--shadow-lift)] lg:block" />
        <div className="flex-1 p-8">
          <div className="skeleton h-4 w-24" />
          <div className="skeleton mt-3 h-8 w-64" />
          <div className="mt-8 grid gap-4 sm:grid-cols-3">
            <div className="skeleton h-24" />
            <div className="skeleton h-24" />
            <div className="skeleton h-24" />
          </div>
          <div className="skeleton mt-6 h-64" />
        </div>
      </div>
    );
  }

  const fullName = `${me.firstName} ${me.lastName}`.trim();
  const groups = GROUPS.map((g) => ({
    ...g,
    items: g.items.filter(
      (i) =>
        (!i.roles || i.roles.includes(me.role)) &&
        !(i.notRoles && i.notRoles.includes(me.role))
    ),
  })).filter((g) => g.items.length > 0);

  const sidebar = (
    <aside className="flex h-full w-64 shrink-0 flex-col rounded-3xl bg-[var(--nav-bg)] shadow-[var(--shadow-lift)]">
      {/* Brand. The product is HRMS; the company you are signed into sits
          underneath, because with ten companies in the group, knowing which
          one matters. */}
      <div className="flex items-center gap-2.5 px-5 pb-4 pt-6">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-indigo-600 shadow-md shadow-indigo-600/30">
          <svg viewBox="0 0 24 24" className="h-[22px] w-[22px]" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M7 5v14M17 5v14M7 12h10" />
          </svg>
        </div>
        <div className="min-w-0">
          <p className="truncate text-[15px] font-bold leading-tight tracking-tight text-slate-900" title={fullName}>{fullName}</p>
          <Link
            href="/dashboard/profile"
            aria-current={pathname === "/dashboard/profile" ? "page" : undefined}
            className={`block truncate text-[12px] font-medium hover:underline ${pathname === "/dashboard/profile" ? "text-[var(--nav-active)]" : "text-indigo-600"}`}
          >
            My Profile
          </Link>
        </div>
        <div className="ml-auto shrink-0"><Bell /></div>
      </div>

      <nav className="flex-1 overflow-y-auto pb-4">
        {groups.map((group) => (
          <div key={group.title} className="mb-4">
            <p className="px-6 pb-1.5 pt-2 text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-400">
              {group.title}
            </p>
            <div className="space-y-0.5">
              {group.items.map((item) => {
                // Items that deep-link with ?tab= are never "active"; the
                // plain page entry owns the highlight.
                const active = !item.href.includes("?") && (pathname === item.href || (item.href === "/dashboard/team-attendance" && pathname === "/dashboard/attendance-calendar"));
                const Icon = item.icon;

                if (!item.ready) {
                  return (
                    <div
                      key={item.label}
                      className="mx-3 flex items-center gap-3 rounded-xl px-3 py-2.5 text-[13px] text-slate-400"
                    >
                      <Icon className="h-[18px] w-[18px] shrink-0" />
                      <span className="flex-1">{item.label}</span>
                      <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-slate-500">
                        soon
                      </span>
                    </div>
                  );
                }

                return (
                  <Link
                    key={item.label}
                    href={item.href}
                    className={`group relative mx-3 flex items-center gap-3 rounded-xl px-3 py-2.5 text-[13px] ${
                      active
                        ? "bg-[var(--nav-active-bg)] font-semibold text-[var(--nav-active)]"
                        : "text-[var(--nav-text)] hover:bg-[var(--nav-hover)] hover:text-slate-900"
                    }`}
                  >
                    <Icon
                      className={`h-[18px] w-[18px] shrink-0 ${
                        active ? "text-[var(--nav-active)]" : "text-slate-400 group-hover:text-indigo-500"
                      }`}
                    />
                    <span className="truncate">{item.label}</span>
                    {item.badge === "queries" && pendingQueries > 0 && (
                      <span data-testid="queries-badge" className="ml-auto rounded-full bg-rose-500 px-1.5 py-0.5 text-[10px] font-bold leading-none text-white">{Math.min(99, pendingQueries)}</span>
                    )}
                    {/* The reference marks the current page with a bar on the
                        card's outer edge, readable from across a desk. */}
                    {active && (
                      <span className="absolute -right-3 top-1/2 h-8 w-1 -translate-y-1/2 rounded-l bg-[var(--nav-active)]" />
                    )}
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      <div className="border-t border-slate-100 p-3">
        <div className="flex items-center gap-2.5 px-2 py-2">
          <Avatar userId={me.id} name={fullName} photoAt={me.photoAt} size={36} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-semibold text-slate-900">
              {fullName}
            </p>
            <div className="mt-0.5 flex items-center gap-1.5">
              <span
                className={`rounded px-1.5 py-[1px] text-[10px] font-medium ${
                  ROLE_CHIP[me.role] ?? ROLE_CHIP.EMPLOYEE
                }`}
              >
                {me.role.charAt(0) + me.role.slice(1).toLowerCase()}
              </span>
              {me.employeeCode && (
                <span className="truncate text-[10px] text-slate-400">
                  {me.employeeCode}
                </span>
              )}
            </div>
          </div>
        </div>
        <ThemeRow />
        <button
          onClick={signOut}
          className="mt-1 flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-[13px] text-[var(--nav-text)] hover:bg-[var(--nav-hover)] hover:text-slate-900"
        >
          <svg viewBox="0 0 20 20" className="h-[18px] w-[18px] text-slate-400" fill="none" stroke="currentColor" strokeWidth="1.6">
            <path d="M8 16H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3" strokeLinecap="round" />
            <path d="M12.5 7 15.5 10l-3 3M15.5 10H8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Logout
        </button>
      </div>
    </aside>
  );

  return (
    <MeContext.Provider value={me}>
      <ThemeProvider>
      <NotificationsProvider>
      <div className="flex min-h-screen bg-[var(--background)]">
        {/* Desktop */}
        <div className="sticky top-0 hidden h-screen p-4 pr-0 lg:block">{sidebar}</div>

        {/* Mobile drawer — people will open this on a phone to clock in */}
        {open && (
          <div className="fixed inset-0 z-40 lg:hidden">
            <div
              className="absolute inset-0 bg-slate-900/50"
              onClick={() => setOpen(false)}
            />
            <div className="absolute left-0 top-0 h-full animate-in p-3">{sidebar}</div>
          </div>
        )}

        <div className="min-w-0 flex-1">
          {/* Mobile top bar */}
          <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-indigo-100 bg-white/90 px-4 py-3 backdrop-blur lg:hidden">
            <button
              onClick={() => setOpen(true)}
              aria-label="Open menu"
              className="rounded-lg p-1.5 text-slate-600 hover:bg-slate-100"
            >
              <svg viewBox="0 0 20 20" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="M3 6h14M3 10h14M3 14h14" strokeLinecap="round" />
              </svg>
            </button>
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-600 text-[12px] font-bold text-white">
              H
            </div>
            <p className="truncate text-sm font-semibold text-slate-900">
              Avatar HRMS
            </p>
            <div className="ml-auto flex shrink-0 items-center gap-0.5"><ThemeIconButton /><Bell /></div>
          </header>

          <div className="animate-in">{children}</div>
        </div>
      </div>
      </NotificationsProvider>
      </ThemeProvider>
    </MeContext.Provider>
  );
}