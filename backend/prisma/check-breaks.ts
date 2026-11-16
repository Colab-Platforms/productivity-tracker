// READ-ONLY. Prints every break row for one person's sessions so the recorded break total can be checked against the raw timestamps.
//   EMP=AI-02 FROM=2026-11-01 TO=2026-11-16 npx tsx prisma/check-breaks.ts
// Writes nothing.
import { prisma } from "../src/lib/prisma.js";
import { splitAwayTime, classOfRow } from "../src/modules/tracker/activityClass.js";

const EMP = process.env.EMP ?? "AI-02";
const FROM = process.env.FROM ?? "2026-11-01";
const TO = process.env.TO ?? "2026-11-16";

const hm = (s: number) => `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;

async function main() {
  const user = await prisma.user.findFirst({
    where: { employeeCode: EMP },
    include: { platform: true, teamMemberships: { where: { isActive: true }, include: { team: { include: { config: true } } } } },
  });
  if (!user) return console.log("No user with employee code", EMP);

  const tz = user.platform.timezone;
  const budgetMin = user.teamMemberships[0]?.team.config?.breakBudgetMinutes ?? 60;
  const at = (d: Date | null) =>
    d ? new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(d) : "OPEN";
  console.log(`${user.firstName} ${user.lastName} (${EMP})  tz ${tz}  break allowance ${budgetMin}m`);

  const sessions = await prisma.workSession.findMany({
    where: { userId: user.id, date: { gte: new Date(`${FROM}T00:00:00Z`), lte: new Date(`${TO}T00:00:00Z`) } },
    include: { breaks: { orderBy: { startedAt: "asc" } } },
    orderBy: { date: "asc" },
  });

  for (const s of sessions) {
    const now = new Date();
    const split = splitAwayTime(s.breaks, now);
    const flags = [s.autoClosed ? "SESSION AUTO-CLOSED" : "", split.breakSeconds !== s.breakSeconds ? "STORED != ROWS" : ""].filter(Boolean).join(", ");
    console.log(`\n${s.date.toISOString().slice(0, 10)}  in ${at(s.loginAt)}  out ${at(s.logoutAt)}  stored break ${hm(s.breakSeconds)}  rows break ${hm(split.breakSeconds)}  washroom ${hm(split.washroomSeconds)}  ${flags}`);
    for (const b of s.breaks) {
      const secs = Math.max(0, Math.floor(((b.endedAt ?? now).getTime() - b.startedAt.getTime()) / 1000));
      const stored = b.durationSeconds;
      console.log(
        `   ${String(b.breakType).padEnd(9)} ${at(b.startedAt)} -> ${at(b.endedAt)}  ${hm(secs).padStart(7)}  ${classOfRow(b).padEnd(10)}` +
          `${b.autoClosed ? "  AUTO-CLOSED" : ""}${stored !== null && stored !== secs ? `  durationSeconds column says ${hm(stored)}` : ""}${b.reason ? `  "${b.reason}"` : ""}`
      );
    }
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
