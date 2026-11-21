// ---------------------------------------------------------------------------
// EMPLOYMENT STATUS. The statuses a person can be given are ACTIVE, EXITED, TERMINATED and ABSCONDED (owner decision 2026-11-21).
// CANDIDATE, INVITED and SUSPENDED are LEGACY values: nobody can be given them any more, but any record that still holds one keeps it and keeps
// working (a legacy value is shown, filtered and, for SUSPENDED, blocked exactly as before). Nothing is deleted or rewritten.
//
// LIVE-SAFETY: Postgres refuses an enum value it does not know, even in a read filter. TERMINATED / ABSCONDED only exist in the database after
// migration 20261122100000_user_status_terminated_absconded. Every query that lists them therefore asks `statusReady()` first (same pattern as
// holdReady() in leave). Plain string comparisons on a value already read from a row (isBlockedStatus) never touch the database and are always safe.
// ---------------------------------------------------------------------------
import { prisma } from "./prisma.js";

/** Statuses an Admin / HR may choose from. */
export const ASSIGNABLE_STATUSES = ["ACTIVE", "EXITED", "TERMINATED", "ABSCONDED"] as const;
/** Everything that may still be stored (the legacy three stay valid on records that hold them). */
export const ALL_STATUSES = ["CANDIDATE", "INVITED", "ACTIVE", "SUSPENDED", "EXITED", "TERMINATED", "ABSCONDED"] as const;
/** The three "has left" statuses. */
export const LEFT_STATUSES = ["EXITED", "TERMINATED", "ABSCONDED"] as const;
/** No access at all: signing in, the API and the live connection are refused. */
export const BLOCKED_STATUSES = ["SUSPENDED", "EXITED", "TERMINATED", "ABSCONDED"] as const;

export const isLeftStatus = (s: string | null | undefined): boolean => !!s && (LEFT_STATUSES as readonly string[]).includes(s);
export const isBlockedStatus = (s: string | null | undefined): boolean => !!s && (BLOCKED_STATUSES as readonly string[]).includes(s);

let ready: boolean | null = null;
let checking: Promise<boolean> | null = null;
let checkedAt = 0;

/** True once the database knows TERMINATED and ABSCONDED. A "yes" is remembered; a "no" is re-checked every 15 seconds. Never throws. */
export async function statusReady(): Promise<boolean> {
  if (ready === true) return true;
  if (checking) return checking;
  if (ready === false && Date.now() - checkedAt < 15_000) return false;
  checking = (async () => {
    try {
      const rows = await prisma.$queryRaw<{ n: number }[]>`
        select count(*)::int as n from pg_enum e join pg_type t on t.oid = e.enumtypid
        where t.typname = 'UserStatus' and e.enumlabel in ('TERMINATED', 'ABSCONDED')`;
      ready = (rows[0]?.n ?? 0) === 2;
    } catch {
      ready = false;
    }
    checkedAt = Date.now();
    return ready;
  })().finally(() => { checking = null; });
  return checking;
}

type Legacy = ("SUSPENDED" | "EXITED")[];
/** For `status: { notIn: await inactiveStatuses() }`: everyone who may not use the system (the new values only once the database has them). */
export async function inactiveStatuses(): Promise<Legacy> {
  return ((await statusReady()) ? ["SUSPENDED", "EXITED", "TERMINATED", "ABSCONDED"] : ["SUSPENDED", "EXITED"]) as unknown as Legacy;
}
/** For `status: { notIn: await leftStatuses() }`: everyone who has left (headcount "not left"). */
export async function leftStatuses(): Promise<Legacy> {
  return ((await statusReady()) ? ["EXITED", "TERMINATED", "ABSCONDED"] : ["EXITED"]) as unknown as Legacy;
}

/** The last known answer of statusReady(), for synchronous code that built a filter. Call `await statusReady()` earlier in the same request. */
export const statusKnownSync = (): boolean => ready === true;
