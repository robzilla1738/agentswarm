"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Logo } from "./atoms";

/** Cycles dark/light; persists to localStorage, defaults to the OS scheme. */
function ThemeToggle() {
  const [, force] = useState(0);
  const current = (): "light" | "dark" => {
    if (typeof document === "undefined") return "dark";
    const set = document.documentElement.dataset.theme;
    if (set === "light" || set === "dark") return set;
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  };
  return (
    <button
      className="btn btn-ghost btn-sm"
      title="Toggle light / dark"
      aria-label="Toggle color theme"
      onClick={() => {
        const next = current() === "light" ? "dark" : "light";
        document.documentElement.dataset.theme = next;
        try {
          localStorage.setItem("theme", next);
        } catch {
          /* private mode */
        }
        force((n) => n + 1);
      }}
    >
      ◐
    </button>
  );
}

export function TopBar({ right, hideLogo }: { right?: React.ReactNode; hideLogo?: boolean }) {
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
      className="sticky top-0 z-40 flex items-center justify-between px-5 sm:px-8 h-14"
      style={{
        background: "color-mix(in oklab, var(--color-bg) 82%, transparent)",
        backdropFilter: "blur(14px)",
      }}
    >
      {hideLogo ? <span /> : <Logo />}
      <div className="flex items-center gap-3">
        {!reachable && <span className="chip chip-solid">hub offline</span>}
        {reachable && health && !health.apiKey && (
          <Link href="/settings" className="chip text-ink" style={{ borderColor: "rgb(var(--hi) / 0.4)" }}>
            no api key
          </Link>
        )}
        {right}
        <ThemeToggle />
        <Link href="/settings" className="btn btn-ghost btn-sm">
          Settings
        </Link>
      </div>
    </header>
  );
}
