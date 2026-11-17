"use client";

import { useEffect } from "react";
import { useSearchParams } from "next/navigation";

// Reports the page's own address (?tab=...) to the shell so the sidebar can light the right item. It sits inside a <Suspense> boundary, which Next requires
// for useSearchParams, and it never reads window.location (during a click inside the app that is still the previous page's address).
export default function SearchBridge({ onChange }: { onChange: (search: string) => void }) {
  const params = useSearchParams();
  const text = params.toString();
  useEffect(() => {
    onChange(text);
  }, [text, onChange]);
  return null;
}
