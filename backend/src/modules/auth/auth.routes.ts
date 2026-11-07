import { Router } from "express";
import * as authService from "./auth.service.js";
import { requireAuth } from "../../middlewares/auth.js";
import { prisma } from "../../lib/prisma.js";
import { photoStamps } from "../photos/photos.service.js";
import { isOwnerAdmin } from "../../lib/owner.js";
import { loginLimiter, clearLoginAttempts } from "../../middlewares/rateLimit.js";

const router = Router();

// Brute-force guard on the credential check only (it ignores other paths).
router.use(loginLimiter);

router.post("/login", async (req, res) => {
  const { email, password } = req.body ?? {};

  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required" });
  }

  try {
    const result = await authService.login(email, password);
    clearLoginAttempts(req);
    return res.json(result);
  } catch (error) {
    const code = error instanceof Error ? error.message : "UNKNOWN";

    if (code === "INVALID_CREDENTIALS") {
      return res.status(401).json({ error: "Email or password is incorrect" });
    }
    if (code === "ACCOUNT_INACTIVE") {
      return res.status(403).json({ error: "This account is no longer active" });
    }

    console.error("Login failed:", error);
    return res.status(500).json({ error: "Something went wrong signing in" });
  }
});

router.get("/me", requireAuth, async (req, res) => {
  const me = await authService.getMe(req.user!.userId);

  if (!me) {
    return res.status(404).json({ error: "User not found" });
  }

  return res.json(me);
});

// My Profile: the signed-in person's OWN details (read-only; the id always comes from the token, never from the request).
// Only fields the system actually holds are returned. Address and emergency contact are not stored anywhere yet, so they are not invented.
router.get("/me/profile", requireAuth, async (req, res) => {
  try {
    const u = await prisma.user.findUnique({
      where: { id: req.user!.userId },
      select: {
        id: true, firstName: true, lastName: true, email: true, phone: true, employeeCode: true, designation: true, role: true, status: true,
        dateOfJoining: true, probationEndDate: true,
        platform: { select: { name: true } },
        reportsTo: { select: { firstName: true, lastName: true, designation: true } },
        shift: { select: { name: true, startTime: true, endTime: true } },
        teamMemberships: { where: { isActive: true }, select: { team: { select: { name: true } } } },
      },
    });
    if (!u) return res.status(404).json({ error: "User not found" });
    let employmentType: string | null = null;
    try {
      employmentType = (await prisma.employeeProfile.findUnique({ where: { userId: u.id }, select: { employmentType: true } }))?.employmentType ?? null;
    } catch {
      /* table not there: not set */
    }
    const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
    return res.json({
      firstName: u.firstName, lastName: u.lastName, email: u.email, phone: u.phone, employeeCode: u.employeeCode, designation: u.designation,
      role: String(u.role), status: String(u.status), company: u.platform.name,
      dateOfJoining: day(u.dateOfJoining), probationEndDate: day(u.probationEndDate), employmentType,
      reportsTo: u.reportsTo ? { name: `${u.reportsTo.firstName} ${u.reportsTo.lastName}`.trim(), designation: u.reportsTo.designation } : null,
      shift: u.shift ? { name: u.shift.name, startTime: u.shift.startTime, endTime: u.shift.endTime } : null,
      departments: u.teamMemberships.map((m) => m.team.name),
      photoAt: (await photoStamps([u.id])).get(u.id) ?? null,
      documentsExempt: await isOwnerAdmin(u.id).catch(() => false),
    });
  } catch (e) {
    console.error("Profile error:", e);
    return res.status(500).json({ error: "Something went wrong" });
  }
});

export default router;