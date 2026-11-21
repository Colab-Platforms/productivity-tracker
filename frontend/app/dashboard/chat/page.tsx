"use client";

import { Suspense, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useChatDrawer } from "../_chat/ChatDrawer";

// Chat is a drawer now (header Chat icon). This address is kept for old links, notifications and bookmarks: it opens the drawer (on the
// conversation in ?c= when there is one) and returns to the person's home, so there is no separate full-page chat any more.
export default function ChatRoute() {
  return (
    <Suspense fallback={null}>
      <Opener />
    </Suspense>
  );
}

function Opener() {
  const router = useRouter();
  const c = useSearchParams().get("c");
  const { openChat } = useChatDrawer();
  useEffect(() => {
    openChat(c);
    router.replace("/dashboard");
  }, [c, openChat, router]);
  return null;
}
