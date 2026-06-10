"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Logo } from "./atoms";

export function TopBar({ right }: { right?: React.ReactNode }) {
  const [health, setHealth] = useState<{ ok: boolean; apiKey: boolean } | null>(null);
  const [reachable, setReachable] = useState(true);

  useEffect(() => {
    let alive = true;
    const ping = () =>
      api
        .health()
        .then((h) => alive && (setHealth(h), setReachable(true)))
        .catch(() => alive && setReachable(false));
    ping();
    const t = setInterval(ping, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  return (
    <header
      className="sticky top-0 z-40 flex items-center justify-between px-5 sm:px-8 h-14 border-b border-border-soft"
      style={{
        background: "color-mix(in oklab, var(--color-bg) 82%, transparent)",
        backdropFilter: "blur(14px)",
      }}
    >
      <Logo />
      <div className="flex items-center gap-3">
        {!reachable && <span className="chip chip-solid">hub offline</span>}
        {reachable && health && !health.apiKey && (
          <Link href="/settings" className="chip text-ink" style={{ borderColor: "rgba(255,255,255,0.4)" }}>
            no api key
          </Link>
        )}
        {right}
        <Link href="/settings" className="btn btn-ghost btn-sm">
          Settings
        </Link>
      </div>
    </header>
  );
}
