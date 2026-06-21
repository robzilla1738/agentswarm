"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Logo } from "./atoms";

/** Cycles dark/light; persists to localStorage, defaults to the OS scheme. */
function ThemeToggle() {
  const [mounted, setMounted] = useState(false);
  const [, force] = useState(0);
  useEffect(() => setMounted(true), []);
  const current = (): "light" | "dark" => {
    if (typeof document === "undefined") return "dark";
    const set = document.documentElement.dataset.theme;
    if (set === "light" || set === "dark") return set;
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  };
  // Until mounted, render the SSR-stable default ("dark") so hydration matches;
  // the real mode (which may read matchMedia) is only resolved after mount.
  const mode = mounted ? current() : "dark";
  const target = mode === "light" ? "dark" : "light";
  return (
    <button
      className="btn btn-ghost btn-sm"
      title={`Switch to ${target} mode`}
      aria-label={`Switch to ${target} mode`}
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
      {/* Glyph reflects the current theme: filled-right = dark, filled-left = light. */}
      {mode === "light" ? "◐" : "◑"}
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
      className="sticky top-0 z-40 flex items-center justify-between px-5 sm:px-8 h-14 border-b border-border-soft"
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
        <Link href="/forecasts" className="btn btn-ghost btn-sm">
          Forecasts
        </Link>
        <ThemeToggle />
        <Link href="/settings" className="btn btn-ghost btn-sm">
          Settings
        </Link>
      </div>
    </header>
  );
}
