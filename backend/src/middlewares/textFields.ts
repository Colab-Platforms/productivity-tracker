import type { Request, Response, NextFunction } from "express";

// Fields the services treat as text (they call .trim() or compare them as strings). If a client sends a
// number, list or object there, the service would crash with a TypeError and answer 500. Refuse it up
// front with a clear 400. null / missing is still allowed (it means "not provided" or "clear it").
const TEXT_FIELDS = new Set([
  "firstName", "lastName", "name", "email", "phone", "designation", "employeeCode", "password", "newPassword",
  "currentPassword", "temporaryPassword", "title", "subject", "description", "reason", "note", "decisionNote",
  "rejectionReason", "fileName", "mimeType", "legalName", "timezone", "employeeCodePrefix", "startTime", "endTime",
  "roleTitle", "message", "body", "assigneeId", "emailIntro", "bodyHtml", "category", "priority", "leaveType", "breakType", "meetingType",
  "teamType", "decision", "label", "helpText", "employmentType", "meetingUrl", "startTime", "endTime", "date", "correctionType", "requestedLogin", "requestedLogout", "comment", "reviewComment", "dateOfJoining", "joiningDate", "expiresAt", "correctionDate",
]);

export function textFields(req: Request, res: Response, next: NextFunction) {
  const body = req.body;
  if (body && typeof body === "object" && !Array.isArray(body)) {
    for (const [key, value] of Object.entries(body)) {
      if (TEXT_FIELDS.has(key) && value !== null && value !== undefined && typeof value !== "string") {
        res.status(400).json({ error: `“${key}” must be text.` });
        return;
      }
    }
  }
  next();
}
