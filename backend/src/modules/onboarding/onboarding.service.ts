// ===========================================================================
// ONBOARDING â€” the path from "HR created an employee ID" to "tracker unlocked"
//
// THE STAGE MACHINE
// onboardingStatus is never assigned ad hoc. Every write that could move
// someone forward calls recomputeOnboarding(), which reads the whole picture
// and decides the stage. One function owns the transitions, so they cannot
// disagree with each other.
//
//   OFFER_SENT           account created, nothing uploaded
//   DOCUMENTS_PENDING    some mandatory documents still missing
//   DOCUMENTS_SUBMITTED  all uploaded, waiting on HR  â† 48h clock starts
//   AWAITING_RESUME      HR approved everything, resume not on file yet
//   ACTIVE               resume on file â†’ tracker unlocked
//
// DATA PROTECTION
// These rows point at identity documents, which makes this a personal-data
// store under India's DPDP Act. Files live behind storageKey, never a public
// URL; reads are permission-checked here, not in the UI.
// ===========================================================================

import bcrypt from "bcryptjs";
import { prisma } from "../../lib/prisma.js";
import { viewerIsOwner, ownerAdminIds } from "../../lib/owner.js";
import { saveUpload, readStored, deleteStored, contentTypeFor } from "../../lib/storage.js";
import { parseIsoDay } from "../../lib/dates.js";
import { auditNote, changedFields } from "../../lib/auditContext.js";

const BCRYPT_COST = 10;
const STAFF_ROLES = new Set(["HR", "ADMIN"]);

export const DOCUMENT_CATEGORIES = [
  "IDENTITY",
  "EDUCATION",
  "EMPLOYMENT",
  "BANKING",
  "PHOTO",
  "RESUME",
  "CONTRACT",
  "OTHER",
] as const;

type DocumentCategory = (typeof DOCUMENT_CATEGORIES)[number];

// What HR asks a new joiner for, if nobody has configured anything yet.
// Created once per platform on first use, then fully editable.
const DEFAULT_REQUIREMENTS: {
  category: DocumentCategory;
  label: string;
  helpText: string;
  isMandatory: boolean;
  uploadedByEmployee: boolean;
}[] = [
  { category: "IDENTITY", label: "Aadhaar card", helpText: "Front and back, in one file", isMandatory: true, uploadedByEmployee: true },
  { category: "IDENTITY", label: "PAN card", helpText: "A clear photo or scan", isMandatory: true, uploadedByEmployee: true },
  { category: "PHOTO", label: "Passport photograph", helpText: "Recent, plain background", isMandatory: true, uploadedByEmployee: true },
  { category: "EDUCATION", label: "Highest degree certificate", helpText: "Degree or provisional certificate", isMandatory: true, uploadedByEmployee: true },
  { category: "BANKING", label: "Cancelled cheque or bank passbook", helpText: "Name, account number and IFSC must be readable", isMandatory: true, uploadedByEmployee: true },
  { category: "EMPLOYMENT", label: "Relieving letter from previous employer", helpText: "Skip if this is your first job", isMandatory: false, uploadedByEmployee: true },
  { category: "RESUME", label: "Resume", helpText: "Uploaded by HR â€” unlocks tracker access", isMandatory: true, uploadedByEmployee: false },
  { category: "CONTRACT", label: "Employment contract", helpText: "Uploaded by HR", isMandatory: false, uploadedByEmployee: false },
];

// --- helpers ----------------------------------------------------------------

async function actor(viewerId: string) {
  const viewer = await prisma.user.findUnique({
    where: { id: viewerId },
    select: {
      id: true,
      role: true,
      platformId: true,
      platform: { select: { slug: true, employeeCodePrefix: true, name: true } },
    },
  });
  if (!viewer) throw new Error("NOT_FOUND");
  return viewer;
}

function assertStaff(role: string) {
  if (!STAFF_ROLES.has(String(role))) throw new Error("FORBIDDEN");
}

async function samePlatformUser(platformId: string, userId: string) {
  const target = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, platformId: true },
  });
  if (!target || target.platformId !== platformId) throw new Error("NOT_FOUND");
}

// Creates the standard requirement set the first time a platform needs it.
// A write inside a read is unusual â€” it is done here so a brand-new platform
// is never stuck with an empty checklist and no obvious way to fix it.
// A requirement applies to everyone unless HR scoped it to certain employment types.
// A person with no employment type set sees every requirement (the behaviour before types existed).
// The two tables behind this are read separately (not joined) and a missing table is treated as
// "no scopes / no types", so a database that has not been migrated yet keeps working exactly as before.
const missingTable = (e: unknown) => (e as { code?: string })?.code === "P2021" || /does not exist/i.test(String((e as Error)?.message));

export async function scopeMap(platformIds: string | string[]): Promise<Map<string, string[]>> {
  const ids = Array.isArray(platformIds) ? platformIds : [platformIds];
  try {
    const rows = await prisma.documentRequirementScope.findMany({ where: { requirement: { platformId: { in: ids } } }, select: { requirementId: true, employmentType: true } });
    const map = new Map<string, string[]>();
    for (const r of rows) map.set(r.requirementId, [...(map.get(r.requirementId) ?? []), String(r.employmentType)]);
    return map;
  } catch (e) {
    if (missingTable(e)) return new Map();
    throw e;
  }
}

export async function typesOf(userIds: string[]): Promise<Map<string, string>> {
  if (userIds.length === 0) return new Map();
  try {
    const rows = await prisma.employeeProfile.findMany({ where: { userId: { in: userIds } }, select: { userId: true, employmentType: true } });
    return new Map(rows.map((r) => [r.userId, String(r.employmentType)]));
  } catch (e) {
    if (missingTable(e)) return new Map();
    throw e;
  }
}

export function isApplicable(scopes: string[] | undefined, type: string | null | undefined): boolean {
  return !scopes || scopes.length === 0 || !type || scopes.includes(type);
}

async function ensureRequirements(platformId: string) {
  const count = await prisma.documentRequirement.count({ where: { platformId } });
  if (count > 0) return;

  await prisma.$transaction(
    DEFAULT_REQUIREMENTS.map((r, index) =>
      prisma.documentRequirement.create({
        data: {
          platformId,
          category: r.category,
          label: r.label,
          helpText: r.helpText,
          isMandatory: r.isMandatory,
          uploadedByEmployee: r.uploadedByEmployee,
          sortOrder: index,
        },
      })
    )
  );
}

async function nextEmployeeCode(platformId: string, prefix: string | null, slug: string) {
  const mark = (prefix ?? slug.slice(0, 3)).toUpperCase();
  const existing = await prisma.user.findMany({
    where: { platformId, employeeCode: { startsWith: `${mark}-` } },
    select: { employeeCode: true },
  });

  let highest = 0;
  for (const row of existing) {
    const n = Number(row.employeeCode?.split("-")[1]);
    if (Number.isFinite(n) && n > highest) highest = n;
  }
  return `${mark}-${String(highest + 1).padStart(4, "0")}`;
}

// ===========================================================================
// THE STAGE MACHINE
// ===========================================================================

export async function recomputeOnboarding(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      platformId: true,
      onboardingStatus: true,
      documentsSubmittedAt: true,
      trackerAccessEnabled: true,
    },
  });
  if (!user) throw new Error("NOT_FOUND");

  // Already finished â€” nothing here can un-finish someone.
  if (String(user.onboardingStatus) === "ACTIVE") return user.onboardingStatus;

  const [allRequirements, documents, types, scopeBy] = await Promise.all([
    prisma.documentRequirement.findMany({
      where: { platformId: user.platformId, isActive: true },
      select: { id: true, isMandatory: true, uploadedByEmployee: true, category: true },
    }),
    prisma.employeeDocument.findMany({
      where: { userId },
      select: { requirementId: true, status: true, category: true },
    }),
    typesOf([userId]),
    scopeMap(user.platformId),
  ]);
  const requirements = allRequirements.filter((r) => isApplicable(scopeBy.get(r.id), types.get(userId)));

  const byRequirement = new Map(documents.map((d) => [d.requirementId, d]));

  const employeeMandatory = requirements.filter((r) => r.isMandatory && r.uploadedByEmployee);
  const allSubmitted = employeeMandatory.every((r) => {
    const doc = byRequirement.get(r.id);
    return doc && ["SUBMITTED", "APPROVED"].includes(String(doc.status));
  });
  const allApproved = employeeMandatory.every(
    (r) => String(byRequirement.get(r.id)?.status) === "APPROVED"
  );

  // The resume is the gate. Its presence, approved, is what unlocks everything.
  const resumeOnFile = documents.some(
    (d) => String(d.category) === "RESUME" && String(d.status) === "APPROVED"
  );

  let status: string;
  if (allApproved && resumeOnFile) status = "ACTIVE";
  else if (allApproved) status = "AWAITING_RESUME";
  else if (allSubmitted) status = "DOCUMENTS_SUBMITTED";
  else if (documents.length > 0) status = "DOCUMENTS_PENDING";
  else status = String(user.onboardingStatus); // nothing uploaded yet â€” leave it

  const becameActive = status === "ACTIVE";

  // The 48-hour HR clock. Starts the moment the last mandatory document is
  // in, and is cleared when onboarding completes so a finished candidate
  // never shows as overdue.
  const documentsSubmittedAt =
    status === "DOCUMENTS_SUBMITTED"
      ? user.documentsSubmittedAt ?? new Date()
      : becameActive
        ? null
        : user.documentsSubmittedAt;

  await prisma.user.update({
    where: { id: userId },
    data: {
      onboardingStatus: status as never,
      documentsSubmittedAt,
      ...(becameActive
        ? {
            status: "ACTIVE" as const,
            trackerAccessEnabled: true,
            accessGrantedAt: new Date(),
            // Deliberately NOT forcing another password change here. By this
            // point the joiner has already replaced the password HR gave them,
            // on their very first login. Forcing a second change at activation
            // would bounce every new employee to a password screen on the day
            // they finally get access, for a password only they know.

          }
        : {}),
    },
  });

  return status;
}

// ===========================================================================
// HR â€” creating a new hire
// ===========================================================================

export async function createHire(
  viewerId: string,
  data: {
    firstName: string;
    lastName: string;
    email: string;
    phone?: string;
    designation?: string;
    employeeCode?: string;
    temporaryPassword: string;
    shiftId?: string;
    teamId?: string;
    dateOfJoining?: string;
  }
) {
  const viewer = await actor(viewerId);
  assertStaff(String(viewer.role));

  const email = data.email?.trim().toLowerCase();
  if (!email || !data.firstName?.trim() || !data.lastName?.trim()) {
    throw new Error("MISSING_FIELDS");
  }
  if (!data.temporaryPassword || data.temporaryPassword.length < 8) {
    throw new Error("WEAK_PASSWORD");
  }

  const clash = await prisma.user.findFirst({
    where: { platformId: viewer.platformId, email },
    select: { id: true },
  });
  if (clash) throw new Error("EMAIL_TAKEN");

  await ensureRequirements(viewer.platformId);

  const employeeCode =
    data.employeeCode?.trim() ||
    (await nextEmployeeCode(
      viewer.platformId,
      viewer.platform.employeeCodePrefix,
      viewer.platform.slug
    ));

  const passwordHash = await bcrypt.hash(data.temporaryPassword, BCRYPT_COST);

  const user = await prisma.$transaction(async (tx) => {
    const created = await tx.user.create({
      data: {
        platformId: viewer.platformId,
        email,
        passwordHash,
        firstName: data.firstName.trim(),
        lastName: data.lastName.trim(),
        phone: data.phone?.trim() || null,
        employeeCode,
        role: "EMPLOYEE",
        status: "CANDIDATE",
        designation: data.designation?.trim() || null,
        dateOfJoining: data.dateOfJoining ? parseIsoDay(data.dateOfJoining) : null,
        shiftId: data.shiftId || null,
        onboardingStatus: "OFFER_SENT",
        // The gate stays shut until the resume is on file.
        trackerAccessEnabled: false,
        mustChangePassword: true, // the joiner must replace the HR-chosen temporary password
      },
      select: { id: true, employeeCode: true, email: true, firstName: true, lastName: true },
    });

    if (data.teamId) {
      const team = await tx.team.findUnique({
        where: { id: data.teamId },
        select: { platformId: true },
      });
      if (!team || team.platformId !== viewer.platformId) throw new Error("TEAM_NOT_FOUND");
      await tx.teamMember.create({ data: { teamId: data.teamId, userId: created.id } });
    }

    return created;
  });

  // Returned so HR can copy them into whatever they send. Nothing is emailed
  // from here yet â€” see the email flag in the routes layer.
  return {
    user,
    credentials: {
      employeeCode: user.employeeCode,
      email: user.email,
      temporaryPassword: data.temporaryPassword,
      platform: viewer.platform.name,
    },
  };
}

// ===========================================================================
// HR â€” the candidate pipeline
// ===========================================================================

// An owner hires into every company, so they must be able to open a joiner
// outside their own. Everyone else stays locked to their platform exactly as
// before - this widens the door for one account, it does not remove it.
async function samePlatformOrOwner(
  viewerId: string,
  platformId: string,
  userId: string
) {
  if (await viewerIsOwner(viewerId)) {
    const exists = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });
    if (!exists) throw new Error("NOT_FOUND");
    return;
  }
  await samePlatformUser(platformId, userId);
}
export async function listCandidates(viewerId: string) {
  const viewer = await actor(viewerId);
  assertStaff(String(viewer.role));

  // An owner hires into every company, so their Joiners list must span them.
  const owner = await viewerIsOwner(viewerId);

  const owners = await ownerAdminIds(); // owners are not joiners and not part of document compliance
  const [candidates, requirements, config] = await Promise.all([
    prisma.user.findMany({
      where: {
        ...(owner ? {} : { platformId: viewer.platformId }),
        ...(owners.length ? { id: { notIn: owners } } : {}),
        onboardingStatus: { not: "ACTIVE" },
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        employeeCode: true,
        designation: true,
        status: true,
        onboardingStatus: true,
        documentsSubmittedAt: true,
        dateOfJoining: true,
        createdAt: true,
        platformId: true,
        platform: { select: { name: true } },
        documents: {
          select: {
            id: true,
            requirementId: true,
            category: true,
            status: true,
            fileName: true,
            uploadedAt: true,
            rejectionReason: true,
          },
        },
      },
      orderBy: [{ createdAt: "desc" }],
    }),
    prisma.documentRequirement.findMany({
      where: { ...(owner ? {} : { platformId: viewer.platformId }), isActive: true },
      select: {
        id: true,
        platformId: true,
        label: true,
        category: true,
        isMandatory: true,
        uploadedByEmployee: true,
      },
      orderBy: [{ isMandatory: "desc" }, { label: "asc" }],
    }),
    prisma.teamConfig.findFirst({
      where: { team: { platformId: viewer.platformId } },
      select: { onboardingSlaHours: true },
    }),
  ]);

  const slaHours = config?.onboardingSlaHours ?? 48;

  // The checklist covers only what the joiner owes us. Papers HR uploads
  // (contract, resume) are not their responsibility and must never drag
  // their percentage down.
  // Requirements belong to a company, so they are grouped by one rather than
  // assumed to be a single list. An owner sees candidates from several
  // companies side by side, and each must be measured against their own.
  const [scopeBy, typeBy] = await Promise.all([scopeMap([...new Set(requirements.map((r) => r.platformId))]), typesOf(candidates.map((c) => c.id))]);
  const requirementsByPlatform = new Map<string, typeof requirements>();
  for (const r of requirements) {
    const list = requirementsByPlatform.get(r.platformId) ?? [];
    list.push(r);
    requirementsByPlatform.set(r.platformId, list);
  }

  return candidates.map((c) => {
    const forThisCompany = (requirementsByPlatform.get(c.platformId) ?? []).filter((r) => isApplicable(scopeBy.get(r.id), typeBy.get(c.id)));
    const ownRequirements = forThisCompany.filter((r) => r.uploadedByEmployee);
    const mandatory = ownRequirements.filter((r) => r.isMandatory);
    const mandatoryCount = mandatory.length;
    const byRequirement = new Map(
      c.documents
        .filter((d) => d.requirementId)
        .map((d) => [String(d.requirementId), d])
    );

    const submitted = c.documents.filter((d) =>
      ["SUBMITTED", "APPROVED"].includes(String(d.status))
    ).length;
    const approved = c.documents.filter(
      (d) => String(d.status) === "APPROVED"
    ).length;
    const pendingReview = c.documents.filter(
      (d) => String(d.status) === "SUBMITTED"
    ).length;
    const rejected = c.documents.filter(
      (d) => String(d.status) === "REJECTED"
    ).length;

    // Approved-only, so the bar can never read 100% while HR still has
    // something sitting in review.
    const approvedMandatory = mandatory.filter(
      (r) => String(byRequirement.get(r.id)?.status ?? "") === "APPROVED"
    ).length;
    const submittedMandatory = mandatory.filter((r) =>
      ["SUBMITTED", "APPROVED"].includes(
        String(byRequirement.get(r.id)?.status ?? "")
      )
    ).length;

    const pct = (n: number) =>
      mandatoryCount === 0 ? 0 : Math.round((n / mandatoryCount) * 100);

    const checklist = ownRequirements.map((r) => {
      const doc = byRequirement.get(r.id);
      const state = String(doc?.status ?? "MISSING");
      return {
        requirementId: r.id,
        label: r.label,
        category: r.category,
        isMandatory: r.isMandatory,
        status: state,
        fileName: doc?.fileName ?? null,
        rejectionReason: doc?.rejectionReason ?? null,
        done: state === "APPROVED",
      };
    });

    const waitingHours = c.documentsSubmittedAt
      ? (Date.now() - c.documentsSubmittedAt.getTime()) / 3600_000
      : 0;

    return {
      id: c.id,
      name: `${c.firstName} ${c.lastName}`.trim(),
      email: c.email,
      employeeCode: c.employeeCode,
      company: c.platform?.name ?? null,
      designation: c.designation,
      status: c.status,
      onboardingStatus: c.onboardingStatus,
      dateOfJoining: c.dateOfJoining,
      createdAt: c.createdAt,
      submitted,
      approved,
      rejected,
      mandatoryCount,
      pendingReview,
      // progressPercent is the green fill; submittedPercent is the amber fill
      // behind it - uploaded, but HR has not approved it yet.
      progressPercent: pct(approvedMandatory),
      submittedPercent: pct(submittedMandatory),
      checklist,
      documentsSubmittedAt: c.documentsSubmittedAt,
      waitingHours: Math.round(waitingHours),
      slaHours,
      isOverdue: waitingHours > slaHours,
    };
  });
}

export async function getCandidate(viewerId: string, userId: string) {
  const viewer = await actor(viewerId);
  assertStaff(String(viewer.role));
  await samePlatformOrOwner(viewerId, viewer.platformId, userId);

  // The checklist belongs to the CANDIDATE's company, not the viewer's. An
  // owner opening a joiner in another company was being shown their own
  // company's requirements, which match none of the uploaded documents - so
  // every row read "not uploaded" while the files sat there.
  const subject = await prisma.user.findUnique({
    where: { id: userId },
    select: { platformId: true },
  });
  if (!subject) throw new Error("NOT_FOUND");

  await ensureRequirements(subject.platformId);

  const [user, allRequirements, documents, types, scopeBy] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
        employeeCode: true,
        designation: true,
        status: true,
        onboardingStatus: true,
        trackerAccessEnabled: true,
        documentsSubmittedAt: true,
        dateOfJoining: true,
      },
    }),
    prisma.documentRequirement.findMany({
      where: { platformId: subject.platformId, isActive: true },
      orderBy: { sortOrder: "asc" },
    }),
    prisma.employeeDocument.findMany({
      where: { userId },
      include: {
        reviewedBy: { select: { firstName: true, lastName: true } },
      },
    }),
    typesOf([userId]),
    scopeMap(subject.platformId),
  ]);
  const requirements = allRequirements.filter((r) => isApplicable(scopeBy.get(r.id), types.get(userId)));

  const byRequirement = new Map(documents.map((d) => [d.requirementId, d]));

  return {
    user,
    checklist: requirements.map((r) => {
      const doc = byRequirement.get(r.id);
      return {
        requirementId: r.id,
        label: r.label,
        helpText: r.helpText,
        category: r.category,
        isMandatory: r.isMandatory,
        uploadedByEmployee: r.uploadedByEmployee,
        // Flattened beside the nested object on purpose. The screen reads
        // these directly; anything already using `document` keeps working.
        // Two shapes for the same data is cheaper than a screen that silently
        // shows "requested" for documents that are sitting right there.
        id: doc?.id ?? null,
        documentId: doc?.id ?? null,
        status: doc ? String(doc.status) : "REQUESTED",
        fileName: doc?.fileName ?? null,
        fileSize: doc?.fileSize ?? null,
        uploadedAt: doc?.uploadedAt ?? null,
        reviewedAt: doc?.reviewedAt ?? null,
        rejectionReason: doc?.rejectionReason ?? null,
        document: doc
          ? {
              id: doc.id,
              status: doc.status,
              fileName: doc.fileName,
              fileSize: doc.fileSize,
              uploadedAt: doc.uploadedAt,
              reviewedAt: doc.reviewedAt,
              rejectionReason: doc.rejectionReason,
              reviewedBy: doc.reviewedBy
                ? `${doc.reviewedBy.firstName} ${doc.reviewedBy.lastName}`.trim()
                : null,
            }
          : null,
      };
    }),
  };
}

// ===========================================================================
// THE CANDIDATE'S OWN VIEW
// ===========================================================================

export async function getMyOnboarding(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      platformId: true,
      firstName: true,
      lastName: true,
      email: true,
      employeeCode: true,
      designation: true,
      dateOfJoining: true,
      onboardingStatus: true,
      trackerAccessEnabled: true,
      mustChangePassword: true,
      documentsSubmittedAt: true,
      platform: { select: { name: true } },
    },
  });
  if (!user) throw new Error("NOT_FOUND");

  await ensureRequirements(user.platformId);

  const [allRequirements, documents, types, scopeBy] = await Promise.all([
    prisma.documentRequirement.findMany({
      where: { platformId: user.platformId, isActive: true, uploadedByEmployee: true },
      orderBy: { sortOrder: "asc" },
    }),
    prisma.employeeDocument.findMany({ where: { userId } }),
    typesOf([userId]),
    scopeMap(user.platformId),
  ]);
  const requirements = allRequirements.filter((r) => isApplicable(scopeBy.get(r.id), types.get(userId)));

  const byRequirement = new Map(documents.map((d) => [d.requirementId, d]));

  const checklist = requirements.map((r) => {
    const doc = byRequirement.get(r.id);
    return {
      requirementId: r.id,
      label: r.label,
      helpText: r.helpText,
      category: r.category,
      isMandatory: r.isMandatory,
      status: doc ? String(doc.status) : "REQUESTED",
      fileName: doc?.fileName ?? null,
      uploadedAt: doc?.uploadedAt ?? null,
      // Visible on purpose. Most onboarding frustration is not knowing why
      // something was sent back.
      rejectionReason: doc?.rejectionReason ?? null,
      documentId: doc?.id ?? null,
    };
  });

  const mandatory = checklist.filter((c) => c.isMandatory);
  const done = mandatory.filter((c) => ["SUBMITTED", "APPROVED"].includes(c.status)).length;

  return {
    user: {
      name: `${user.firstName} ${user.lastName}`.trim(),
      email: user.email,
      employeeCode: user.employeeCode,
      designation: user.designation,
      dateOfJoining: user.dateOfJoining,
      platform: user.platform?.name ?? null,
    },
    onboardingStatus: user.onboardingStatus,
    trackerAccessEnabled: user.trackerAccessEnabled,
    mustChangePassword: user.mustChangePassword,
    progress: { done, total: mandatory.length },
    waitingOnHrSince: user.documentsSubmittedAt,
    checklist,
  };
}

export async function uploadMyDocument(
  userId: string,
  data: { requirementId: string; fileName: string; data: string; mimeType?: string }
) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, platformId: true, onboardingStatus: true },
  });
  if (!user) throw new Error("NOT_FOUND");

  const requirement = await prisma.documentRequirement.findUnique({
    where: { id: data.requirementId },
    select: { id: true, platformId: true, category: true, uploadedByEmployee: true, isActive: true },
  });
  if (!requirement || requirement.platformId !== user.platformId) throw new Error("NOT_FOUND");
  if (!requirement.uploadedByEmployee) throw new Error("HR_UPLOADS_THIS");
  if (!requirement.isActive) throw new Error("REQUIREMENT_INACTIVE");
  {
    const [types, scopeBy] = await Promise.all([typesOf([userId]), scopeMap(user.platformId)]);
    if (!isApplicable(scopeBy.get(requirement.id), types.get(userId))) throw new Error("NOT_APPLICABLE");
  }

  const stored = await saveUpload({
    platformId: user.platformId,
    folder: "documents",
    originalName: data.fileName,
    data: data.data,
    mimeType: data.mimeType,
  });

  const existing = await prisma.employeeDocument.findFirst({
    where: { userId, requirementId: requirement.id },
    select: { id: true, storageKey: true },
  });

  if (existing) {
    // Re-uploading after a rejection replaces the file and clears the review,
    // so it goes back into HR's queue as new.
    await prisma.employeeDocument.update({
      where: { id: existing.id },
      data: {
        ...stored,
        status: "SUBMITTED",
        uploadedAt: new Date(),
        uploadedById: userId,
        reviewedById: null,
        reviewedAt: null,
        rejectionReason: null,
        consentAcceptedAt: new Date(),
      },
    });
    if (existing.storageKey) await deleteStored(existing.storageKey);
  } else {
    await prisma.employeeDocument.create({
      data: {
        platformId: user.platformId,
        userId,
        requirementId: requirement.id,
        category: requirement.category,
        status: "SUBMITTED",
        ...stored,
        uploadedAt: new Date(),
        uploadedById: userId,
        // The DPDP consent record: captured at the moment of upload.
        consentAcceptedAt: new Date(),
      },
    });
  }

  const status = await recomputeOnboarding(userId);
  return { ok: true, onboardingStatus: status };
}

// ===========================================================================
// HR â€” review and resume upload
// ===========================================================================

export async function reviewDocument(
  viewerId: string,
  documentId: string,
  approve: boolean,
  rejectionReason?: string
) {
  const viewer = await actor(viewerId);
  assertStaff(String(viewer.role));

  const doc = await prisma.employeeDocument.findUnique({
    where: { id: documentId },
    select: { id: true, platformId: true, userId: true, status: true, category: true },
  });
  if (!doc) throw new Error("NOT_FOUND");
  // An owner reviews documents in every company; everyone else stays locked
  // to their own.
  if (doc.platformId !== viewer.platformId && !(await viewerIsOwner(viewerId))) {
    throw new Error("NOT_FOUND");
  }

  if (!approve && !rejectionReason?.trim()) throw new Error("REASON_REQUIRED");

  await prisma.employeeDocument.update({
    where: { id: documentId },
    data: {
      status: approve ? "APPROVED" : "REJECTED",
      reviewedById: viewer.id,
      reviewedAt: new Date(),
      rejectionReason: approve ? null : rejectionReason!.trim(),
    },
  });

  auditNote({
    recordType: "EmployeeDocument",
    recordId: doc.id,
    targetUserId: doc.userId,
    before: { status: String(doc.status) },
    after: { status: approve ? "APPROVED" : "REJECTED", rejectionReason: approve ? null : rejectionReason!.trim() },
    summary: `${approve ? "Verified" : "Rejected"} a ${String(doc.category).toLowerCase()} document`,
  });

  const status = await recomputeOnboarding(doc.userId);
  return { ok: true, onboardingStatus: status };
}

// HR uploading on the candidate's behalf â€” resume and contract. Uploading an
// approved resume is what opens the gate, via recomputeOnboarding.
export async function uploadForCandidate(
  viewerId: string,
  userId: string,
  data: { requirementId: string; fileName: string; data: string; mimeType?: string }
) {
  const viewer = await actor(viewerId);
  assertStaff(String(viewer.role));
  await samePlatformOrOwner(viewerId, viewer.platformId, userId);

  const requirement = await prisma.documentRequirement.findUnique({
    where: { id: data.requirementId },
    select: { id: true, platformId: true, category: true },
  });
  if (!requirement || requirement.platformId !== viewer.platformId) {
    throw new Error("NOT_FOUND");
  }

  const stored = await saveUpload({
    platformId: viewer.platformId,
    folder: "documents",
    originalName: data.fileName,
    data: data.data,
    mimeType: data.mimeType,
  });

  const existing = await prisma.employeeDocument.findFirst({
    where: { userId, requirementId: requirement.id },
    select: { id: true, storageKey: true },
  });

  if (existing) {
    await prisma.employeeDocument.update({
      where: { id: existing.id },
      data: {
        ...stored,
        // HR uploading it is itself the approval â€” there is nobody else to
        // review HR's own upload.
        status: "APPROVED",
        uploadedAt: new Date(),
        uploadedById: viewer.id,
        reviewedById: viewer.id,
        reviewedAt: new Date(),
        rejectionReason: null,
      },
    });
    if (existing.storageKey) await deleteStored(existing.storageKey);
  } else {
    await prisma.employeeDocument.create({
      data: {
        platformId: viewer.platformId,
        userId,
        requirementId: requirement.id,
        category: requirement.category,
        status: "APPROVED",
        ...stored,
        uploadedAt: new Date(),
        uploadedById: viewer.id,
        reviewedById: viewer.id,
        reviewedAt: new Date(),
      },
    });
  }

  const status = await recomputeOnboarding(userId);
  return { ok: true, onboardingStatus: status };
}

// ===========================================================================
// DOWNLOAD
// ===========================================================================

export async function downloadDocument(viewerId: string, documentId: string) {
  const viewer = await actor(viewerId);

  const doc = await prisma.employeeDocument.findUnique({
    where: { id: documentId },
    select: {
      platformId: true,
      userId: true,
      storageKey: true,
      fileName: true,
      mimeType: true,
    },
  });
  if (!doc) throw new Error("NOT_FOUND");
  // An owner reviews documents in every company; everyone else stays locked
  // to their own.
  if (doc.platformId !== viewer.platformId && !(await viewerIsOwner(viewerId))) {
    throw new Error("NOT_FOUND");
  }

  // The owner, HR and Admin. Nobody else, including the person's manager â€”
  // a manager has no business reading someone's Aadhaar.
  const allowed = doc.userId === viewer.id || STAFF_ROLES.has(String(viewer.role));
  if (!allowed) throw new Error("FORBIDDEN");
  if (!doc.storageKey) throw new Error("FILE_MISSING");

  const buffer = await readStored(doc.storageKey);
  return {
    buffer,
    fileName: doc.fileName ?? "document",
    mimeType: doc.mimeType ?? contentTypeFor(doc.storageKey),
  };
}

// ===========================================================================
// REQUIREMENTS CONFIG
// ===========================================================================

export async function listRequirements(viewerId: string) {
  const viewer = await actor(viewerId);
  assertStaff(String(viewer.role));
  await ensureRequirements(viewer.platformId);

  const [rows, scopeBy, grouped] = await Promise.all([
    prisma.documentRequirement.findMany({ where: { platformId: viewer.platformId }, orderBy: [{ sortOrder: "asc" }, { label: "asc" }] }),
    scopeMap(viewer.platformId),
    prisma.employeeDocument.groupBy({ by: ["requirementId", "status"], where: { platformId: viewer.platformId, requirementId: { not: null } }, _count: true }),
  ]);
  const counts = new Map<string, { submitted: number; verified: number; rejected: number }>();
  for (const g of grouped) {
    const c = counts.get(g.requirementId as string) ?? { submitted: 0, verified: 0, rejected: 0 };
    if (String(g.status) === "SUBMITTED") c.submitted += g._count;
    if (String(g.status) === "APPROVED") c.verified += g._count;
    if (String(g.status) === "REJECTED") c.rejected += g._count;
    counts.set(g.requirementId as string, c);
  }
  return rows.map((r) => ({ ...r, appliesTo: scopeBy.get(r.id) ?? [], ...(counts.get(r.id) ?? { submitted: 0, verified: 0, rejected: 0 }) }));
}

const EMPLOYMENT_TYPE_VALUES = ["PERMANENT", "PROBATION", "CONTRACT", "INTERN"];

async function scopesAvailable(): Promise<boolean> {
  const r = await prisma.$queryRaw<{ ok: boolean }[]>`SELECT to_regclass('public.document_requirement_scopes') IS NOT NULL AS ok`;
  return r[0]?.ok === true;
}

export async function upsertRequirement(
  viewerId: string,
  data: {
    id?: string;
    category: string;
    label: string;
    helpText?: string;
    isMandatory?: boolean;
    uploadedByEmployee?: boolean;
    isActive?: boolean;
    sortOrder?: number;
    appliesTo?: string[];
  }
) {
  const viewer = await actor(viewerId);
  assertStaff(String(viewer.role));

  const category = DOCUMENT_CATEGORIES.find((c) => c === data.category);
  if (!category) throw new Error("BAD_CATEGORY");
  const label = String(data.label ?? "").trim();
  if (label.length < 2) throw new Error("MISSING_FIELDS");
  if (label.length > 100) throw new Error("NAME_TOO_LONG");
  const helpText = data.helpText === undefined || data.helpText === null ? null : String(data.helpText).trim() || null;
  if (helpText && helpText.length > 300) throw new Error("HELP_TOO_LONG");
  const sortOrder = data.sortOrder !== undefined && Number.isInteger(Number(data.sortOrder)) ? Math.min(999, Math.max(0, Number(data.sortOrder))) : undefined;

  let appliesTo: string[] | undefined;
  if (data.appliesTo !== undefined) {
    if (!Array.isArray(data.appliesTo) || data.appliesTo.some((t) => !EMPLOYMENT_TYPE_VALUES.includes(String(t)))) throw new Error("BAD_EMPLOYMENT_TYPE");
    appliesTo = [...new Set(data.appliesTo.map(String))];
  }
  const canScope = await scopesAvailable();
  if (appliesTo && appliesTo.length > 0 && !canScope) throw new Error("SCOPE_UNAVAILABLE");

  const existing = data.id
    ? await prisma.documentRequirement.findUnique({ where: { id: data.id } })
    : null;
  if (data.id && (!existing || existing.platformId !== viewer.platformId)) throw new Error("NOT_FOUND");
  const beforeScopes = existing ? ((await scopeMap(viewer.platformId)).get(existing.id) ?? []) : [];

  let saved;
  try {
    saved = await prisma.$transaction(async (tx) => {
      const row = existing
        ? await tx.documentRequirement.update({
            where: { id: existing.id },
            data: {
              category,
              label,
              helpText,
              ...(data.isMandatory !== undefined ? { isMandatory: data.isMandatory === true } : {}),
              ...(data.uploadedByEmployee !== undefined ? { uploadedByEmployee: data.uploadedByEmployee === true } : {}),
              // Deactivating only hides the requirement. Submitted files are never deleted.
              ...(data.isActive !== undefined ? { isActive: data.isActive === true } : {}),
              ...(sortOrder !== undefined ? { sortOrder } : {}),
            },
          })
        : await tx.documentRequirement.create({
            data: {
              platformId: viewer.platformId,
              category,
              label,
              helpText,
              isMandatory: data.isMandatory !== false,
              uploadedByEmployee: data.uploadedByEmployee !== false,
              sortOrder: sortOrder ?? 99,
            },
          });
      if (appliesTo !== undefined && canScope) {
        await tx.documentRequirementScope.deleteMany({ where: { requirementId: row.id } });
        if (appliesTo.length > 0) await tx.documentRequirementScope.createMany({ data: appliesTo.map((t) => ({ requirementId: row.id, employmentType: t as never })) });
      }
      return row;
    });
  } catch (e) {
    if ((e as { code?: string }).code === "P2002") throw new Error("DUPLICATE_LABEL");
    throw e;
  }

  const KEYS = ["label", "helpText", "category", "isMandatory", "uploadedByEmployee", "isActive", "sortOrder", "appliesTo"];
  const afterScopes = appliesTo !== undefined ? appliesTo : beforeScopes;
  const diff = changedFields(
    existing ? ({ ...existing, appliesTo: [...beforeScopes].sort() } as never) : ({} as never),
    { ...saved, appliesTo: [...afterScopes].sort() } as never,
    KEYS
  );
  auditNote({
    module: "Documents",
    action: existing ? "UPDATE" : "CREATE",
    recordType: "DocumentRequirement",
    recordId: saved.id,
    before: existing ? diff.before : undefined,
    after: diff.after,
    summary: existing ? `Changed the document requirement "${saved.label}": ${Object.keys(diff.after as Record<string, unknown>).join(", ") || "no changes"}` : `Added the document requirement "${saved.label}"`,
  });
  return { ...saved, appliesTo: afterScopes };
}

// ===========================================================================
// FIRST-LOGIN PASSWORD CHANGE
// ===========================================================================

export async function changeOwnPassword(
  userId: string,
  currentPassword: string,
  newPassword: string
) {
  if (!newPassword || newPassword.length < 8) throw new Error("WEAK_PASSWORD");
  if (currentPassword === newPassword) throw new Error("SAME_PASSWORD");

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, passwordHash: true },
  });
  if (!user?.passwordHash) throw new Error("NOT_FOUND");

  const matches = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!matches) throw new Error("WRONG_PASSWORD");

  await prisma.user.update({
    where: { id: userId },
    data: {
      passwordHash: await bcrypt.hash(newPassword, BCRYPT_COST),
      mustChangePassword: false,
    },
  });

  return { ok: true };
}
