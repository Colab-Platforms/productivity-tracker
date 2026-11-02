// ===========================================================================
// OWNER ACCESS (top management)
//
// "Owner" now means: HR/Admin whose employee code is in OWNER_CODES, or who holds an all-companies grant in company_access
// (see companyAccess.ts, the one place that decides which companies a person may act on). Per-company grants (HR assigned to
// specific companies) are read from companyAccess.ts directly by the modules that support them.
// A deployment pinned to one company switches owner reach off.
// ===========================================================================

import { accessFor } from "./companyAccess.js";

export { ownerCodes } from "./companyAccess.logic.js";

export async function viewerIsOwner(viewerId: string): Promise<boolean> {
  return (await accessFor(viewerId)).all;
}
