"use client";

import LoginActivity from "../_security/LoginActivity";

// My Login Activity: every person's OWN sign-in history, for every role. The server decides who is asking and returns only that person's rows, so
// nobody can see anyone else's. It is here so a person can check whether somebody else has used their ID: a sign-in they do not recognise (a device,
// a browser or an address that is not theirs), or wrong-password attempts on their account.
export default function MyLoginActivityPage() {
  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-500">
        Every time someone signed in to your account, or tried to. Check that each sign-in is you. Records cannot be edited and are kept for 6 months.
      </p>
      <LoginActivity mode="mine" />
    </div>
  );
}
