"use client";

import Link from "next/link";
import { useState } from "react";
import { statusColor } from "@/lib/format";

/** The swarm mark (halftone bee, white on transparent). */
export function LogoMark({ size = 30 }: { size?: number }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="/swarm-mark.png"
      alt=""
      aria-hidden
      className="shrink-0 select-none"
      style={{ height: size, width: "auto" }}
      draggable={false}
    />
  );
}

export function Logo({ small }: { small?: boolean }) {
  return (
    <Link href="/" className="flex items-center gap-2.5">
      <LogoMark size={small ? 24 : 28} />
      <span className="font-bold tracking-tight" style={{ fontSize: small ? 14 : 15 }}>
        agentswarm
      </span>
    </Link>
  );
}

export function StatusDot({ status, size = 8, pulse }: { status: string; size?: number; pulse?: boolean }) {
  const color = statusColor(status);
  const live = pulse ?? ["running", "planning", "synthesizing", "verifying"].includes(status);
  return (
    <span className="relative inline-flex" style={{ width: size, height: size }}>
      {live && (
        <span
          className="absolute inset-0 rounded-full animate-ping"
          style={{ background: color, opacity: 0.4 }}
        />
      )}
      <span className="relative rounded-full" style={{ width: size, height: size, background: color }} />
    </span>
  );
}

export function StatusBadge({ status }: { status: string }) {
  // Monochrome alarm: failure inverts to filled white.
  if (status === "failed") {
    return <span className="chip chip-solid">✕ failed</span>;
  }
  const color = statusColor(status);
  return (
    <span
      className="chip"
      style={{ color, borderColor: `color-mix(in oklab, ${color} 35%, var(--color-border))`, background: `color-mix(in oklab, ${color} 7%, transparent)` }}
    >
      <StatusDot status={status} size={6} />
      {status}
    </span>
  );
}

export function BudgetBar({ spent, cap, height = 5 }: { spent: number; cap: number; height?: number }) {
  const pct = cap > 0 ? Math.min(100, (spent / cap) * 100) : 0;
  const hot = pct > 85;
  return (
    <div className="w-full rounded-full overflow-hidden" style={{ height, background: "rgba(255,255,255,0.07)" }}>
      <div
        className="h-full rounded-full bg-ink transition-all duration-500"
        style={{ width: `${pct}%`, animation: hot ? "var(--animate-pulse-soft)" : undefined }}
      />
    </div>
  );
}

export function Spinner({ size = 14, dark }: { size?: number; dark?: boolean }) {
  return (
    <span
      className="inline-block rounded-full animate-spin"
      style={{
        width: size,
        height: size,
        border: dark ? "1.5px solid rgba(0,0,0,0.25)" : "1.5px solid rgba(255,255,255,0.18)",
        borderTopColor: dark ? "#0a0a0a" : "#ffffff",
      }}
    />
  );
}

export function CopyButton({ text, label = "Copy" }: { text: string | (() => string); label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="btn btn-sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(typeof text === "function" ? text() : text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          /* clipboard unavailable */
        }
      }}
    >
      {copied ? "Copied ✓" : label}
    </button>
  );
}

export function EmptyState({ glyph, title, sub }: { glyph: string; title: string; sub?: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-14 px-6 text-center">
      <div className="glyph mb-4" style={{ width: 44, height: 44, fontSize: 17 }}>
        {glyph}
      </div>
      <div className="font-semibold text-sm text-ink-dim">{title}</div>
      {sub && <div className="text-xs mt-1.5 max-w-[340px] leading-relaxed text-ink-faint">{sub}</div>}
    </div>
  );
}

export function ToolIcon({ name }: { name?: string }) {
  const map: Record<string, string> = {
    shell: "❯", read_file: "▤", write_file: "✎", replace_in_file: "✎", list_dir: "▸",
    web_search: "⌕", fetch_url: "↓", note: "✦", save_artifact: "↧", report: "✓",
    spawn_tasks: "⊕", verdict: "◈", submit_final: "■", wait: "∥", finish: "▣",
  };
  return <span className="mono text-ink-faint">{map[name ?? ""] ?? "·"}</span>;
}
