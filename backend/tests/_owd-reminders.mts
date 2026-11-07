// helper for owner-admin-documents.test.cjs: runs the reminder sweep once (forced) and prints how many people were reminded
import { sendOnboardingReminders } from "../src/modules/onboarding/onboarding.reminders.js";
const n = await sendOnboardingReminders({ force: true });
console.log("REMINDERS=" + n);
process.exit(0);
