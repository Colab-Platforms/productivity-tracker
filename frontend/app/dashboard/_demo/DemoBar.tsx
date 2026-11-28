"use client";

// A permanent, unmistakable DEMO MODE strip with the instant role switcher. Rendered only when the server says it is the demo (lib/demo.ts); on a normal server
// this component renders nothing, so production screens are untouched.
import { useEffect, useRef, useState } from "react";
import { getDemoInfo, resetDemo, switchDemoRole, type DemoInfo } from "@/lib/demo";


export default function DemoBar({ role }: { role?: string }) {
  
  const [info, setInfo] = useState<DemoInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => { void getDemoInfo().then(setInfo); }, []);
  // Leave room under the page for the bar (it wraps to two rows on a phone) so it never hides the last lines of content.
  const barRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const apply = () => { document.body.style.paddingBottom = `${el.offsetHeight + 16}px`; };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => { ro.disconnect(); document.body.style.paddingBottom = ""; };
  }, [info]);
  if (!info) return null;
  const run = async (fn: () => Promise<unknown>) => { setBusy(true); setErr(""); try { await fn(); } catch (e) { setErr(e instanceof Error ? e.message : "Failed"); setBusy(false); } };
  return (
    <div ref={barRef} data-testid="demo-bar" role="region" aria-label="Demo controls" className="fixed inset-x-2 bottom-2 z-[60] mx-auto flex max-w-fit flex-wrap items-center justify-center gap-2 rounded-2xl border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 shadow-lg">
      <span data-testid="demo-label" className="rounded-md bg-amber-500 px-2 py-0.5 font-bold tracking-wide text-white">DEMO MODE</span>
      <span className="hidden sm:inline">Fictional data only</span>
      <span className="font-medium">View as:</span>
      {info.roles.map((r) => (
        <button key={r.role} type="button" disabled={busy || role === r.role} aria-pressed={role === r.role} onClick={() => run(() => switchDemoRole(r.role))} data-testid={`demo-role-${r.role}`}
          className={`rounded-lg px-2.5 py-1 font-medium ${role === r.role ? "bg-amber-600 text-white" : "bg-white text-amber-900 ring-1 ring-amber-300 hover:bg-amber-100"} disabled:opacity-70`}>{r.label}</button>
      ))}
      <button type="button" disabled={busy} onClick={() => { if (window.confirm("Reset all demo data to its starting state?")) void run(resetDemo); }} data-testid="demo-reset" className="rounded-lg px-2 py-1 text-amber-800 underline hover:bg-amber-100">Reset demo data</button>
      {err && <span role="alert" className="text-rose-700">{err}</span>}
    </div>
  );
}
